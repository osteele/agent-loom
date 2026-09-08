/** Bounded reminders for live sessions that retain coordination claims. */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { type CoordinationEntry, ownerRegistration } from "./coordination.ts";
import { CLAIM_REMINDER_STATE_PATH } from "./paths.ts";
import type { Registration } from "./registry.ts";

export const CLAIM_REMINDER_SWEEP_MS = 5 * 60_000;
export const MATERIALIZED_REMINDER_MS = 15 * 60_000;
export const TARGET_ABSENT_REMINDER_MS = 30 * 60_000;
export const FIRST_AGE_REMINDER_MS = 2 * 60 * 60_000;
export const SECOND_AGE_REMINDER_MS = 8 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const STATE_VERSION = 1;

export interface ClaimReminderProgress {
  ownerKey: string;
  ageStage: number;
  targetAbsent: boolean;
  materialized: boolean;
}

export interface ClaimReminderState {
  version: 1;
  claims: Record<string, ClaimReminderProgress>;
}

interface ClaimReminderUpdate {
  claimId: string;
  progress: ClaimReminderProgress;
}

export interface ClaimReminderBatch {
  project: string;
  sessionId: string;
  message: string;
  idempotencyKey: string;
  claimIds: string[];
  updates: ClaimReminderUpdate[];
}

function emptyState(): ClaimReminderState {
  return { version: STATE_VERSION, claims: {} };
}

/** Invalid reminder bookkeeping costs at most one repeated reminder. */
export function readClaimReminderState(
  path = CLAIM_REMINDER_STATE_PATH,
): ClaimReminderState {
  if (!existsSync(path)) return emptyState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return emptyState();
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return emptyState();
  }
  const document = parsed as { version?: unknown; claims?: unknown };
  if (
    document.version !== STATE_VERSION ||
    typeof document.claims !== "object" ||
    document.claims === null ||
    Array.isArray(document.claims)
  ) {
    return emptyState();
  }

  const claims: Record<string, ClaimReminderProgress> = {};
  for (const [claimId, value] of Object.entries(document.claims)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const progress = value as Record<string, unknown>;
    if (
      typeof progress.ownerKey !== "string" ||
      typeof progress.ageStage !== "number" ||
      !Number.isInteger(progress.ageStage) ||
      progress.ageStage < 0 ||
      typeof progress.targetAbsent !== "boolean" ||
      typeof progress.materialized !== "boolean"
    ) {
      continue;
    }
    claims[claimId] = {
      ownerKey: progress.ownerKey,
      ageStage: progress.ageStage,
      targetAbsent: progress.targetAbsent,
      materialized: progress.materialized,
    };
  }
  return { version: STATE_VERSION, claims };
}

export function writeClaimReminderState(
  state: ClaimReminderState,
  path = CLAIM_REMINDER_STATE_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, path);
}

export function claimReminderStatesEqual(
  left: ClaimReminderState,
  right: ClaimReminderState,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ownerKey(entry: CoordinationEntry): string {
  const owner = entry.owner;
  return [
    owner.id,
    owner.sessionId ?? "",
    owner.pid?.toString() ?? "",
    owner.instanceId ?? "",
    owner.procStart ?? "",
  ].join("\u0000");
}

function ageMs(entry: CoordinationEntry, nowMs: number): number {
  const createdAt = Date.parse(entry.createdAt);
  return Number.isFinite(createdAt) ? Math.max(0, nowMs - createdAt) : 0;
}

function ageStage(age: number): number {
  if (age < FIRST_AGE_REMINDER_MS) return 0;
  if (age < SECOND_AGE_REMINDER_MS) return 1;
  if (age < DAY_MS) return 2;
  return 2 + Math.floor(age / DAY_MS);
}

function desiredProgress(
  entry: CoordinationEntry,
  key: string,
  nowMs: number,
): ClaimReminderProgress {
  const age = ageMs(entry, nowMs);
  return {
    ownerKey: key,
    ageStage: ageStage(age),
    targetAbsent:
      entry.kind === "path-claim" &&
      entry.condition === "target-absent" &&
      age >= TARGET_ABSENT_REMINDER_MS,
    materialized:
      entry.kind === "experiment-claim" &&
      entry.condition === "materialized" &&
      age >= MATERIALIZED_REMINDER_MS,
  };
}

function formatAge(age: number): string {
  if (age < 60 * 60_000) return `${Math.floor(age / 60_000)}m`;
  if (age < DAY_MS) return `${Math.floor(age / (60 * 60_000))}h`;
  return `${Math.floor(age / DAY_MS)}d`;
}

function reminderMessage(entries: CoordinationEntry[], nowMs: number): string {
  const oldest = Math.max(...entries.map((entry) => ageMs(entry, nowMs)));
  const absent = entries.filter(
    (entry) =>
      entry.kind === "path-claim" && entry.condition === "target-absent",
  ).length;
  const materialized = entries.filter(
    (entry) =>
      entry.kind === "experiment-claim" && entry.condition === "materialized",
  ).length;
  const count = entries.length;
  const sentences = [
    `Agent-mail coordination reminder: you still hold ${count} ${count === 1 ? "claim" : "claims"}; oldest ${formatAge(oldest)}.`,
  ];
  if (absent > 0) {
    sentences.push(
      `${absent} claimed ${absent === 1 ? "target is" : "targets are"} absent.`,
    );
  }
  if (materialized > 0) {
    sentences.push(
      `${materialized} experiment ${materialized === 1 ? "reservation is" : "reservations are"} materialized and redundant.`,
    );
  }
  sentences.push(
    `Claim IDs: ${entries
      .map((entry) => entry.id)
      .sort()
      .join(", ")}.`,
  );
  sentences.push(
    "Call list_coordination with all_projects=true, then release completed claims with release_claim.",
  );
  return sentences.join(" ");
}

function idempotencyKey(
  sessionId: string,
  updates: ClaimReminderUpdate[],
): string {
  const signature = updates
    .map(
      ({ claimId, progress }) =>
        `${claimId}:${progress.ageStage}:${Number(progress.targetAbsent)}:${Number(progress.materialized)}`,
    )
    .sort()
    .join("|");
  const digest = createHash("sha256").update(signature).digest("hex");
  return `claim-reminder:v1:${sessionId}:${digest}`;
}

/**
 * Build one reminder per owning live session. Work leases are deliberately
 * excluded: they represent longer-lived responsibility and carry explicit
 * activity, while claims are bounded reservations around an edit or number.
 */
export function prepareClaimReminderSweep(
  entries: CoordinationEntry[],
  registrations: Registration[],
  state: ClaimReminderState,
  nowMs = Date.now(),
): { state: ClaimReminderState; reminders: ClaimReminderBatch[] } {
  const claimEntries = entries.filter((entry) => entry.kind !== "work");
  const activeIds = new Set(claimEntries.map((entry) => entry.id));
  const retainedClaims = Object.fromEntries(
    Object.entries(state.claims)
      .filter(([claimId]) => activeIds.has(claimId))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const prunedState: ClaimReminderState = {
    version: STATE_VERSION,
    claims: retainedClaims,
  };

  const groups = new Map<
    string,
    {
      registration: Registration;
      claims: {
        entry: CoordinationEntry;
        desired: ClaimReminderProgress;
      }[];
    }
  >();
  for (const entry of claimEntries) {
    if (entry.ownerStatus !== "live") continue;
    const registration = ownerRegistration(entry.owner, registrations);
    if (!registration?.sessionId) continue;
    const key = ownerKey(entry);
    const desired = desiredProgress(entry, key, nowMs);
    const groupKey = `${registration.cwd}\u0000${registration.sessionId}`;
    const group = groups.get(groupKey) ?? {
      registration,
      claims: [],
    };
    group.claims.push({ entry, desired });
    groups.set(groupKey, group);
  }

  const reminders: ClaimReminderBatch[] = [];
  for (const group of groups.values()) {
    const previousAgeStage = Math.max(
      0,
      ...group.claims.map(({ entry, desired }) => {
        const previous = state.claims[entry.id];
        return previous?.ownerKey === desired.ownerKey ? previous.ageStage : 0;
      }),
    );
    const desiredAgeStage = Math.max(
      ...group.claims.map(({ desired }) => desired.ageStage),
    );
    const due =
      desiredAgeStage > previousAgeStage ||
      group.claims.some(({ entry, desired }) => {
        const previous = state.claims[entry.id];
        if (!previous || previous.ownerKey !== desired.ownerKey) {
          return desired.targetAbsent || desired.materialized;
        }
        return (
          (desired.targetAbsent && !previous.targetAbsent) ||
          (desired.materialized && !previous.materialized)
        );
      });

    for (const { entry, desired } of group.claims) {
      const previous = state.claims[entry.id];
      const sameOwner = previous?.ownerKey === desired.ownerKey;
      prunedState.claims[entry.id] = {
        ownerKey: desired.ownerKey,
        ageStage: sameOwner ? previous.ageStage : 0,
        targetAbsent:
          Boolean(sameOwner && previous.targetAbsent) && desired.targetAbsent,
        materialized:
          Boolean(sameOwner && previous.materialized) && desired.materialized,
      };
    }
    if (!due) continue;

    const updates = group.claims.map(({ entry, desired }) => ({
      claimId: entry.id,
      progress: { ...desired, ageStage: desiredAgeStage },
    }));
    const claimIds = group.claims
      .map(({ entry }) => entry.id)
      .sort((left, right) => left.localeCompare(right));
    reminders.push({
      project: group.registration.cwd,
      sessionId: group.registration.sessionId as string,
      message: reminderMessage(
        group.claims.map(({ entry }) => entry),
        nowMs,
      ),
      idempotencyKey: idempotencyKey(
        group.registration.sessionId as string,
        updates,
      ),
      claimIds,
      updates,
    });
  }
  return {
    state: {
      version: STATE_VERSION,
      claims: Object.fromEntries(
        Object.entries(prunedState.claims).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    },
    reminders,
  };
}

/** Whether a prepared reminder still describes the owner's exact live claim
 * set immediately before admission. */
export function claimReminderStillCurrent(
  reminder: ClaimReminderBatch,
  entries: CoordinationEntry[],
  registrations: Registration[],
): boolean {
  const currentClaimIds = entries
    .filter((entry) => {
      if (entry.kind === "work" || entry.ownerStatus !== "live") return false;
      const registration = ownerRegistration(entry.owner, registrations);
      return (
        registration?.cwd === reminder.project &&
        registration.sessionId === reminder.sessionId
      );
    })
    .map((entry) => entry.id)
    .sort((left, right) => left.localeCompare(right));
  return (
    currentClaimIds.length === reminder.claimIds.length &&
    currentClaimIds.every(
      (claimId, index) => claimId === reminder.claimIds[index],
    )
  );
}

/** Record only reminders that were successfully spooled or deduplicated. */
export function recordClaimReminder(
  state: ClaimReminderState,
  reminder: ClaimReminderBatch,
): ClaimReminderState {
  const claims = { ...state.claims };
  for (const update of reminder.updates) {
    claims[update.claimId] = update.progress;
  }
  return {
    version: STATE_VERSION,
    claims: Object.fromEntries(
      Object.entries(claims).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}
