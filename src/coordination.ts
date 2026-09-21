/** Normalized inspection and safe recovery across claims and work leases. */

import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AnyPathClaim,
  type Claim,
  type ClaimOwner,
  type ClaimStore,
  PATH_CLAIM_MANUAL_TTL_MS,
  claimOwnerKind,
  claims,
  pathClaimIsOverdue,
  pathClaimTargets,
} from "./claims.ts";
import { FORCED_RECOVERY_LOG_PATH, displayName } from "./paths.ts";
import { coordinationProcessEvidence } from "./processSnapshot.ts";
import {
  type ProcessInfo,
  type ProcessScan,
  type Registration,
  listLive,
} from "./registry.ts";
import {
  type WorkLease,
  type WorkOwner,
  type WorkProgress,
  type WorkStore,
  work,
} from "./work.ts";

export type CoordinationKind = "work" | "path-claim" | "experiment-claim";
export type OwnerStatus =
  | "live"
  | "offline"
  | "manual"
  | "plan"
  | "expired"
  | "unverifiable";

/** How long a manual owner holds a resource without renewing it.
 *
 * A manual owner is one with no recorded process — a `--owner <label>` CLI
 * acquisition from outside a registered session. There is nothing to test for
 * liveness, so such a record can never be proven dead and, before this, was
 * held until an operator broke it by hand. Real ones outlived their creator
 * routinely: a containerized agent claiming this way leaves the claim behind
 * when the container exits, and the label it left is not an identity anything
 * can check.
 *
 * A time bound is the only mechanism available, since identity is not. It is a
 * weaker guarantee than the process check the session-owned path gets, and it
 * is deliberately long: 24h is far past any interactive edit set, so expiry
 * means abandoned rather than slow. An owner that is genuinely still working
 * renews by updating the record. */
export const MANUAL_OWNER_TTL_MS = PATH_CLAIM_MANUAL_TTL_MS;

/** Whether an acquisition may take this resource from its current owner
 * without operator authority.
 *
 * The one predicate every acquisition, recovery, and display path consults, so
 * that "can this be taken" cannot drift between them. */
export function isDisplaceable(status: OwnerStatus): boolean {
  return status === "offline" || status === "expired";
}
export type CoordinationCondition =
  | "healthy"
  | "restart-grace"
  | "owner-offline"
  | "owner-expired"
  | "owner-unverifiable"
  | "source-missing"
  | "awaiting-materialization"
  | "materialized";

export interface CoordinationEntry {
  id: string;
  kind: CoordinationKind;
  project: string;
  projectLabel: string;
  resourceType: string;
  resourceKey: string;
  resourceLabel: string;
  sourcePaths: string[];
  owner: ClaimOwner | WorkOwner;
  ownerStatus: OwnerStatus;
  ownerLastSeen?: string;
  ownerStartedAt?: string;
  condition: CoordinationCondition;
  recoverable: boolean;
  state?: string;
  progress?: WorkProgress;
  activity?: string;
  createdAt: string;
  updatedAt: string;
}

export function ownerStatus(
  owner: ClaimOwner | WorkOwner,
  registrations: Registration[],
  createdAt?: string,
  processEvidence?: Map<number, ProcessInfo> | ProcessScan,
  registrationsReliable = true,
  lastActivityAt?: string,
  nowMs = Date.now(),
): OwnerStatus {
  if (owner.sessionId && owner.pid !== undefined) {
    const registration = registrations.find(
      (registration) =>
        registration.sessionId === owner.sessionId &&
        registration.pid === owner.pid,
    );
    if (!registration)
      return registrationsReliable ? "offline" : "unverifiable";
    if (owner.instanceId) {
      return registration.instanceId === owner.instanceId ? "live" : "offline";
    }
    if (owner.procStart) {
      return registration.procStart === owner.procStart ? "live" : "offline";
    }
    if (createdAt) {
      const registeredAt = Date.parse(registration.started);
      const recordCreatedAt = Date.parse(createdAt);
      if (!Number.isFinite(registeredAt) || !Number.isFinite(recordCreatedAt)) {
        return "unverifiable";
      }
      if (registeredAt > recordCreatedAt) return "offline";
    }
    return "live";
  }
  if (owner.pid === undefined) {
    // No process was ever recorded, so liveness is unknowable and only elapsed
    // time can distinguish a working owner from an abandoned record.
    const since = Date.parse(lastActivityAt ?? createdAt ?? "");
    if (Number.isFinite(since) && nowMs - since >= MANUAL_OWNER_TTL_MS) {
      return "expired";
    }
    return "manual";
  }

  const scan =
    processEvidence instanceof Map
      ? { processes: processEvidence, reliable: true }
      : (processEvidence ?? coordinationProcessEvidence([owner.pid]));
  if (!scan.reliable) return "unverifiable";
  const info = scan.processes.get(owner.pid);
  if (!info) return "offline";
  if (owner.procStart) {
    return owner.procStart === info.start ? "live" : "offline";
  }

  // Legacy CLI records stored a pid but not its process start. A replacement
  // process with the same pid must have started after the record was created,
  // so the timestamps still prove that the original owner is dead. If either
  // timestamp cannot be parsed, preserve the record as unverifiable.
  const processStartedAt = Date.parse(info.start);
  const recordCreatedAt = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(processStartedAt) || !Number.isFinite(recordCreatedAt)) {
    return "unverifiable";
  }
  return processStartedAt <= recordCreatedAt ? "live" : "offline";
}

export function ownerRegistration(
  owner: ClaimOwner | WorkOwner,
  registrations: Registration[],
): Registration | undefined {
  if (!owner.sessionId || owner.pid === undefined) return undefined;
  return registrations.find(
    (registration) =>
      registration.sessionId === owner.sessionId &&
      registration.pid === owner.pid &&
      (!owner.instanceId || registration.instanceId === owner.instanceId) &&
      (!owner.procStart || registration.procStart === owner.procStart),
  );
}

function experimentFiles(
  claim: Extract<Claim, { type: "experiment" }>,
): string[] {
  const experiments = join(claim.notebook, "experiments");
  if (!existsSync(experiments)) return [];
  return readdirSync(experiments, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name === `${claim.experimentId}.md` ||
          (entry.name.startsWith(`${claim.experimentId}-`) &&
            entry.name.endsWith(".md"))),
    )
    .map((entry) => join(experiments, entry.name));
}

function claimEntry(
  claim: Claim,
  registrations: Registration[],
  processes: ProcessScan,
  registrationsReliable: boolean,
  workLeases: WorkLease[],
): CoordinationEntry {
  let status = ownerStatus(
    claim.owner,
    registrations,
    claim.createdAt,
    processes,
    registrationsReliable,
    claim.type === "path" && "lastActivityAt" in claim
      ? claim.lastActivityAt
      : undefined,
  );
  if (claim.type === "path") {
    const kind = claimOwnerKind(claim.owner);
    if (kind === "manual" && pathClaimIsOverdue(claim)) status = "expired";
    if (kind === "session" && claim.state === "restart-grace") {
      status = "offline";
    }
    if (kind === "plan") {
      const held = workLeases.some(
        (lease) =>
          lease.project === claim.owner.plan?.project &&
          lease.resource.type === "research-plan" &&
          lease.resource.key === claim.owner.plan.stem,
      );
      status = held ? "plan" : "offline";
    }
  }
  const registration = isDisplaceable(status)
    ? undefined
    : ownerRegistration(claim.owner, registrations);
  const ownerActivity = {
    ...(registration?.lastSeen ? { ownerLastSeen: registration.lastSeen } : {}),
    ...(registration?.started ? { ownerStartedAt: registration.started } : {}),
  };
  if (claim.type === "experiment") {
    const files = experimentFiles(claim);
    return {
      id: claim.id,
      kind: "experiment-claim",
      project: claim.project,
      projectLabel: displayName(claim.project),
      resourceType: "experiment-number",
      resourceKey: claim.experimentId,
      resourceLabel: claim.experimentId,
      sourcePaths: files.length ? files : [join(claim.notebook, "experiments")],
      owner: claim.owner,
      ownerStatus: status,
      ...ownerActivity,
      condition: isDisplaceable(status)
        ? status === "expired"
          ? "owner-expired"
          : "owner-offline"
        : status === "unverifiable"
          ? "owner-unverifiable"
          : files.length
            ? "materialized"
            : "awaiting-materialization",
      recoverable: isDisplaceable(status),
      createdAt: claim.createdAt,
      updatedAt: claim.createdAt,
    };
  }

  const pathClaim = claim as AnyPathClaim;
  const paths = pathClaimTargets(pathClaim).map((target) => target.path);
  const overdue = pathClaimIsOverdue(pathClaim);
  const inGrace =
    "state" in pathClaim &&
    pathClaim.state === "restart-grace" &&
    !overdue;
  return {
    id: pathClaim.id,
    kind: "path-claim",
    project: pathClaim.project,
    projectLabel: displayName(pathClaim.project),
    resourceType: "edit-set",
    resourceKey: paths.join(","),
    resourceLabel:
      paths.length === 1 ? paths[0] : `${paths.length} claimed paths`,
    sourcePaths: paths,
    owner: pathClaim.owner,
    ownerStatus: status,
    ...ownerActivity,
    condition: inGrace
      ? "restart-grace"
      : isDisplaceable(status) || overdue
        ? status === "expired"
          ? "owner-expired"
          : "owner-offline"
        : status === "unverifiable"
          ? "owner-unverifiable"
          : "healthy",
    recoverable:
      overdue ||
      (status === "offline" && claimOwnerKind(pathClaim.owner) !== "session"),
    state: "state" in pathClaim ? pathClaim.state : "active",
    createdAt: pathClaim.createdAt,
    updatedAt:
      "lastActivityAt" in pathClaim && pathClaim.lastActivityAt
        ? pathClaim.lastActivityAt
        : pathClaim.createdAt,
  };
}

function workEntry(
  lease: WorkLease,
  registrations: Registration[],
  processes: ProcessScan,
  registrationsReliable: boolean,
): CoordinationEntry {
  const status = ownerStatus(
    lease.owner,
    registrations,
    lease.createdAt,
    processes,
    registrationsReliable,
    // A manual owner renews by updating its lease, so the TTL runs from the
    // last update rather than from creation.
    lease.updatedAt,
  );
  const registration = isDisplaceable(status)
    ? undefined
    : ownerRegistration(lease.owner, registrations);
  const sources = lease.resource.sourcePath ? [lease.resource.sourcePath] : [];
  return {
    id: lease.id,
    kind: "work",
    project: lease.project,
    projectLabel: displayName(lease.project),
    resourceType: lease.resource.type,
    resourceKey: lease.resource.key,
    resourceLabel: lease.resource.label ?? lease.resource.key,
    sourcePaths: sources,
    owner: lease.owner,
    ownerStatus: status,
    ...(registration?.lastSeen ? { ownerLastSeen: registration.lastSeen } : {}),
    ...(registration?.started ? { ownerStartedAt: registration.started } : {}),
    condition: isDisplaceable(status)
      ? status === "expired"
        ? "owner-expired"
        : "owner-offline"
      : status === "unverifiable"
        ? "owner-unverifiable"
        : sources.some((path) => !existsSync(path))
          ? "source-missing"
          : "healthy",
    recoverable: isDisplaceable(status),
    state: lease.state,
    activity: lease.activity,
    ...(lease.progress ? { progress: lease.progress } : {}),
    createdAt: lease.createdAt,
    updatedAt: lease.updatedAt,
  };
}

export function listCoordination(
  options: {
    project?: string;
    allProjects?: boolean;
    registrations?: Registration[];
    registrationsReliable?: boolean;
    processes?: Map<number, ProcessInfo> | ProcessScan;
    claimStore?: ClaimStore;
    workStore?: WorkStore;
  } = {},
): CoordinationEntry[] {
  const registrations = options.registrations ?? listLive();
  const claimStore = options.claimStore ?? claims;
  const workStore = options.workStore ?? work;
  const claimRecords = options.allProjects
    ? claimStore.listAll()
    : options.project
      ? claimStore.list(options.project)
      : [];
  const workRecords = options.allProjects
    ? workStore.listAll()
    : options.project
      ? workStore.list(options.project)
      : [];
  const ownerPids = [...workRecords, ...claimRecords]
    .map((record) => record.owner)
    .filter((owner) => !owner.sessionId && owner.pid !== undefined)
    .map((owner) => owner.pid as number);
  const processes =
    options.processes instanceof Map
      ? { processes: options.processes, reliable: true }
      : (options.processes ?? coordinationProcessEvidence(ownerPids));
  return [
    ...workRecords.map((lease) =>
      workEntry(
        lease,
        registrations,
        processes,
        options.registrationsReliable ?? true,
      ),
    ),
    ...claimRecords.map((claim) =>
      claimEntry(
        claim,
        registrations,
        processes,
        options.registrationsReliable ?? true,
        workRecords,
      ),
    ),
  ].sort(
    (a, b) =>
      a.project.localeCompare(b.project) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

export function describeCoordination(entry: CoordinationEntry): string {
  const state = entry.state ? ` [${entry.state}]` : "";
  const activity = entry.activity ? ` — ${entry.activity}` : "";
  const identity = [
    entry.owner.id,
    entry.owner.sessionId && entry.owner.sessionId !== entry.owner.id
      ? `session ${entry.owner.sessionId}`
      : undefined,
    entry.owner.pid !== undefined ? `pid ${entry.owner.pid}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
  const lastSeen = entry.ownerLastSeen
    ? `; last seen ${entry.ownerLastSeen}`
    : "";
  return `${entry.id} ${entry.projectLabel}/${entry.resourceType}:${entry.resourceLabel} — ${entry.owner.label} (${identity})${state}${activity} [${entry.condition}] [owner ${entry.ownerStatus}${lastSeen}] [updated ${entry.updatedAt}]`;
}

/** Actionable conflict guidance without weakening ownership safeguards. */
export function coordinationConflictAdvice(entry: CoordinationEntry): string {
  if (entry.condition === "restart-grace") {
    return "owner session is in restart grace; wait for the grace deadline or ask the operator to authorize forced recovery";
  }
  if (entry.ownerStatus === "offline") {
    return `owner is offline; retry acquisition or run agent-mail coordination recover --id ${entry.id}`;
  }
  if (entry.ownerStatus === "expired") {
    return `owner is manual and has not renewed in ${Math.round(MANUAL_OWNER_TTL_MS / 3_600_000)}h; retry acquisition or run agent-mail coordination recover --id ${entry.id}`;
  }
  if (entry.ownerStatus === "unverifiable") {
    return `owner liveness is unverifiable in this sandbox; inspect from a normal terminal, then run agent-mail coordination recover --id ${entry.id} if it reports owner-offline`;
  }
  if (entry.ownerStatus === "manual") {
    return "owner is deliberately manual; ask the operator to release it";
  }
  if (entry.kind === "work") {
    return "owner is live; use request_coordination_transfer for an auditable handoff";
  }
  return `owner is live; ${entry.kind === "path-claim" ? "path claims" : "experiment reservations"} are not transferable; ask ${entry.owner.label} to release ${entry.id}, or ask the operator to authorize agent-mail coordination recover --id ${entry.id} --authority <who> --reason <why>`;
}

/** Durable trace of a recovery that bypassed the liveness proof. */
export interface ForcedRecoveryRecord {
  at: string;
  authority: string;
  reason: string;
  coordinationId: string;
  kind: CoordinationKind;
  project: string;
  resourceType: string;
  resourceLabel: string;
  ownerLabel: string;
  ownerStatus: OwnerStatus;
  recoveredBy?: string;
}

/** Append a forced-recovery record. Recovery is refused when the audit record
 * cannot be written. */
export function recordForcedRecovery(
  record: ForcedRecoveryRecord,
  logPath = FORCED_RECOVERY_LOG_PATH,
): { logged: boolean; error?: string } {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`);
    return { logged: true };
  } catch (error) {
    return { logged: false, error: (error as Error).message };
  }
}

export interface RecoverOptions {
  /** User-supplied authority for bypassing the lifecycle check. */
  authority?: string;
  /** Required user-supplied justification when authority forces recovery. */
  reason?: string;
  /** Optional label for who performed the recovery, recorded in the audit log. */
  recoveredBy?: string;
}

export function recoverCoordination(
  coordinationId: string,
  registrations = listLive(),
  options: RecoverOptions = {},
): CoordinationEntry {
  const matches = listCoordination({ allProjects: true, registrations }).filter(
    (entry) => entry.id === coordinationId,
  );
  if (matches.length === 0) {
    throw new Error(`coordination record not found: ${coordinationId}`);
  }
  if (matches.length > 1) {
    throw new Error(`coordination id is ambiguous: ${coordinationId}`);
  }
  const entry = matches[0];
  const authority = options.authority?.trim();
  const forced = authority !== undefined && authority.length > 0;
  const reason = options.reason?.trim();
  if (forced && !reason) {
    throw new Error("forced recovery requires a reason");
  }
  const sessionPathObservation =
    entry.kind === "path-claim" &&
    claimOwnerKind(entry.owner as ClaimOwner) === "session" &&
    entry.ownerStatus === "offline";
  if (!forced && !entry.recoverable && !sessionPathObservation) {
    throw new Error(
      `${coordinationId} belongs to ${entry.owner.label}; its lifecycle does not permit recovery. Forced recovery requires user-supplied authority and reason.`,
    );
  }

  // A forced recovery deletes the record regardless of owner liveness, so the
  // store's own liveness gate must be told to stand down explicitly.
  const isLive = (
    owner: ClaimOwner | WorkOwner,
    record: Claim | WorkLease,
  ): boolean =>
    forced
      ? false
      : !isDisplaceable(
          ownerStatus(
            owner,
            listLive(),
            record.createdAt,
            undefined,
            true,
            "updatedAt" in record ? record.updatedAt : undefined,
          ),
        );

  if (forced) {
    // Write the audit record BEFORE the destructive delete: if the process dies
    // between the two, an unexplained lock is recoverable, but a vanished lock
    // with no trace of who took it is not.
    const audit = recordForcedRecovery({
      at: new Date().toISOString(),
      authority: authority as string,
      reason: reason as string,
      coordinationId: entry.id,
      kind: entry.kind,
      project: entry.project,
      resourceType: entry.resourceType,
      resourceLabel: entry.resourceLabel,
      ownerLabel: entry.owner.label,
      ownerStatus: entry.ownerStatus,
      recoveredBy: options.recoveredBy,
    });
    if (!audit.logged) {
      throw new Error(
        `refusing to force recovery of ${coordinationId}: forced-recovery audit log could not be written (${audit.error})`,
      );
    }
  }

  if (entry.kind === "work") {
    work.recover(entry.project, entry.id, isLive);
  } else {
    const releaseReason =
      forced
        ? "forced-recovery"
        : entry.ownerStatus === "expired"
          ? "manual-expiry"
          : claimOwnerKind(entry.owner as ClaimOwner) === "plan"
            ? "plan-lease-lost"
            : "session-absence";
    claims.recover(entry.project, entry.id, isLive, {
      reason: releaseReason,
    });
  }
  return entry;
}
