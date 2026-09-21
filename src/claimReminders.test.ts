import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAIM_REMINDER_SWEEP_MS,
  type ClaimReminderState,
  FIRST_AGE_REMINDER_MS,
  MATERIALIZED_REMINDER_MS,
  SECOND_AGE_REMINDER_MS,
  claimReminderStillCurrent,
  prepareClaimReminderSweep,
  readClaimReminderState,
  recordClaimReminder,
  writeClaimReminderState,
} from "./claimReminders.ts";
import type {
  CoordinationCondition,
  CoordinationEntry,
  CoordinationKind,
  OwnerStatus,
} from "./coordination.ts";
import type { Registration } from "./registry.ts";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;
const owner = {
  id: "session-a",
  label: "Quiet Lantern",
  sessionId: "session-a",
  pid: 101,
  instanceId: "instance-a",
  procStart: "Wed Sep  2 10:00:00 2026",
};
const registration: Registration = {
  cwd: "/listener-project",
  pid: 101,
  sessionId: "session-a",
  instanceId: "instance-a",
  procStart: "Wed Sep  2 10:00:00 2026",
  started: "2026-09-02T10:00:00.000Z",
};

function emptyState(): ClaimReminderState {
  return { version: 2, claims: {} };
}

function entry(options: {
  id?: string;
  age: number;
  kind?: CoordinationKind;
  condition?: CoordinationCondition;
  ownerStatus?: OwnerStatus;
  project?: string;
}): CoordinationEntry {
  const kind = options.kind ?? "path-claim";
  return {
    id: options.id ?? "claim-a",
    kind,
    project: options.project ?? "/claimed-project",
    projectLabel: "claimed-project",
    resourceType:
      kind === "experiment-claim" ? "experiment-number" : "edit-set",
    resourceKey: options.id ?? "claim-a",
    resourceLabel:
      kind === "experiment-claim" ? "EXP-001" : "/claimed-project/file.ts",
    sourcePaths: ["/claimed-project/file.ts"],
    owner,
    ownerStatus: options.ownerStatus ?? "live",
    condition: options.condition ?? "healthy",
    recoverable: false,
    createdAt: new Date(NOW - options.age).toISOString(),
    updatedAt: new Date(NOW - options.age).toISOString(),
  };
}

function remindersFor(
  entries: CoordinationEntry[],
  state = emptyState(),
  registrations: Registration[] = [registration],
) {
  return prepareClaimReminderSweep(entries, registrations, state, NOW);
}

test("claim reminders start at condition and age milestones", () => {
  expect(
    remindersFor([
      entry({
        age: MATERIALIZED_REMINDER_MS - 1,
        kind: "experiment-claim",
        condition: "materialized",
      }),
    ]).reminders,
  ).toHaveLength(0);
  expect(
    remindersFor([
      entry({
        age: MATERIALIZED_REMINDER_MS,
        kind: "experiment-claim",
        condition: "materialized",
      }),
    ]).reminders,
  ).toHaveLength(1);

  expect(
    remindersFor([entry({ age: FIRST_AGE_REMINDER_MS - 1 })]).reminders,
  ).toHaveLength(0);
  expect(
    remindersFor([entry({ age: FIRST_AGE_REMINDER_MS })]).reminders,
  ).toHaveLength(1);
});

test("age reminders advance at 2h, 8h, 24h, then daily", () => {
  const first = remindersFor([entry({ age: FIRST_AGE_REMINDER_MS })]);
  expect(first.reminders).toHaveLength(1);
  let state = recordClaimReminder(first.state, first.reminders[0]);

  expect(
    remindersFor([entry({ age: SECOND_AGE_REMINDER_MS - 1 })], state).reminders,
  ).toHaveLength(0);
  const second = remindersFor([entry({ age: SECOND_AGE_REMINDER_MS })], state);
  expect(second.reminders).toHaveLength(1);
  state = recordClaimReminder(second.state, second.reminders[0]);

  expect(
    remindersFor([entry({ age: DAY_MS - 1 })], state).reminders,
  ).toHaveLength(0);
  const firstDay = remindersFor([entry({ age: DAY_MS })], state);
  expect(firstDay.reminders).toHaveLength(1);
  state = recordClaimReminder(firstDay.state, firstDay.reminders[0]);

  expect(
    remindersFor([entry({ age: 2 * DAY_MS - 1 })], state).reminders,
  ).toHaveLength(0);
  expect(
    remindersFor([entry({ age: 2 * DAY_MS })], state).reminders,
  ).toHaveLength(1);
});

test("one fixed-text reminder aggregates a live owner's claims", () => {
  const prepared = remindersFor([
    entry({
      id: "path-a",
      age: 60 * 60_000,
      project: "/other-project",
    }),
    entry({
      id: "experiment-a",
      age: 60 * 60_000,
      kind: "experiment-claim",
      condition: "materialized",
    }),
  ]);

  expect(prepared.reminders).toHaveLength(1);
  const reminder = prepared.reminders[0];
  expect(reminder.project).toBe(registration.cwd);
  expect(reminder.sessionId).toBe("session-a");
  expect(reminder.message).toContain("you still hold 2 claims; oldest 1h");
  expect(reminder.message).toContain(
    "1 experiment reservation is materialized and redundant",
  );
  expect(reminder.claimIds).toEqual(["experiment-a", "path-a"]);
  expect(reminder.message).toContain("Claim IDs: experiment-a, path-a.");
  expect(reminder.message).toContain("all_projects=true");
  expect(reminder.message).not.toContain("/other-project");
  expect(reminder.message).not.toContain(owner.label);
});

test("reminders require the exact live owner registration and exclude work", () => {
  const claim = entry({ age: DAY_MS });
  const replacement: Registration = {
    ...registration,
    instanceId: "replacement-instance",
  };
  expect(remindersFor([claim], emptyState(), [replacement]).reminders).toEqual(
    [],
  );
  expect(
    remindersFor([
      entry({ age: DAY_MS, ownerStatus: "offline" }),
      entry({ age: DAY_MS, ownerStatus: "manual", id: "manual" }),
      entry({ age: DAY_MS, kind: "work", id: "work" }),
    ]).reminders,
  ).toEqual([]);
});

test("released claims are pruned from reminder bookkeeping", () => {
  const prepared = remindersFor([entry({ age: FIRST_AGE_REMINDER_MS })]);
  const announced = recordClaimReminder(prepared.state, prepared.reminders[0]);
  expect(Object.keys(announced.claims)).toEqual(["claim-a"]);

  const afterRelease = remindersFor([], announced);
  expect(afterRelease.reminders).toEqual([]);
  expect(afterRelease.state).toEqual(emptyState());
});

test("a retry before bookkeeping uses the same idempotency key", () => {
  const claim = entry({ age: FIRST_AGE_REMINDER_MS });
  const first = remindersFor([claim]);
  const retry = remindersFor([claim]);
  expect(retry.reminders[0].idempotencyKey).toBe(
    first.reminders[0].idempotencyKey,
  );

  const announced = recordClaimReminder(first.state, first.reminders[0]);
  expect(remindersFor([claim], announced).reminders).toEqual([]);
});

test("one owner age milestone does not repeat as sibling claims age into it", () => {
  const claims = [
    entry({ id: "older", age: FIRST_AGE_REMINDER_MS }),
    entry({
      id: "younger",
      age: FIRST_AGE_REMINDER_MS - CLAIM_REMINDER_SWEEP_MS,
    }),
  ];
  const first = prepareClaimReminderSweep(
    claims,
    [registration],
    emptyState(),
    NOW,
  );
  expect(first.reminders).toHaveLength(1);
  const announced = recordClaimReminder(first.state, first.reminders[0]);

  const next = prepareClaimReminderSweep(
    claims,
    [registration],
    announced,
    NOW + CLAIM_REMINDER_SWEEP_MS,
  );
  expect(next.reminders).toEqual([]);
});

test("a claim acquired after a reminder retains its own age milestone", () => {
  const older = entry({ id: "older", age: FIRST_AGE_REMINDER_MS });
  const first = remindersFor([older]);
  const announced = recordClaimReminder(first.state, first.reminders[0]);
  const younger = entry({ id: "younger", age: 0 });

  const joined = prepareClaimReminderSweep(
    [older, younger],
    [registration],
    announced,
    NOW,
  );
  expect(joined.reminders).toEqual([]);

  const afterOlderReleased = prepareClaimReminderSweep(
    [younger],
    [registration],
    joined.state,
    NOW + FIRST_AGE_REMINDER_MS,
  );
  expect(afterOlderReleased.reminders).toHaveLength(1);
  expect(afterOlderReleased.reminders[0].claimIds).toEqual(["younger"]);
});

test("a reminder is stale when its owner's live claim set changes", () => {
  const claim = entry({ age: FIRST_AGE_REMINDER_MS });
  const prepared = remindersFor([claim]);
  const reminder = prepared.reminders[0];

  expect(claimReminderStillCurrent(reminder, [claim], [registration])).toBe(
    true,
  );
  expect(claimReminderStillCurrent(reminder, [], [registration])).toBe(false);
  expect(
    claimReminderStillCurrent(
      reminder,
      [claim, entry({ id: "new-claim", age: 0 })],
      [registration],
    ),
  ).toBe(false);
});

test("claim reminder state round-trips and ignores malformed entries", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-claim-reminders-"));
  const path = join(root, "state", "claim-reminders.json");
  try {
    const prepared = remindersFor([entry({ age: FIRST_AGE_REMINDER_MS })]);
    const state = recordClaimReminder(prepared.state, prepared.reminders[0]);
    writeClaimReminderState(state, path);
    expect(readClaimReminderState(path)).toEqual(state);

    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        claims: {
          valid: state.claims["claim-a"],
          invalid: { ownerKey: 4 },
        },
      }),
    );
    expect(readClaimReminderState(path).claims).toEqual({
      valid: state.claims["claim-a"],
    });

    writeFileSync(path, "not json");
    expect(readClaimReminderState(path)).toEqual(emptyState());
    expect(readFileSync(path, "utf8")).toBe("not json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
