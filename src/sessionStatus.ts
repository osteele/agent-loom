/** Daemon-owned presentation data. Delivery and coordination never read this cache. */
import {
  type LedgerObligation,
  currentLedgerObligations,
} from "./ledgerIssues.ts";
import { type Obligation, type Role, obligations } from "./obligations.ts";
import { canonicalProject } from "./paths.ts";
import { peersInProject } from "./presence.ts";
import { type Registration, coalesceRegistrations } from "./registry.ts";
import {
  type ClaudeSessionMeta,
  claudeSessions,
  sessionNames,
} from "./sessions.ts";
import {
  type UnreadSummaryEntry,
  computeUnreadSummary,
} from "./unreadSummary.ts";
import {
  type RunningJobsSnapshot,
  type WeftJobsSnapshot,
  readRunningJobsSnapshot,
  readWeftJobsSnapshot,
  runningForProjectSession,
  unprocessedForProjectSession,
} from "./weftJobs.ts";
import {
  type WorkLease,
  type WorkProgress,
  type WorkState,
  work,
} from "./work.ts";

export type StatusDelivery = "" | "push" | "pull" | "unknown";

export interface StatusWorkItem {
  id: string;
  resourceType: string;
  resourceKey: string;
  label?: string;
  sourcePath?: string;
  state: WorkState;
  activity?: string;
  progress?: WorkProgress;
  updatedAt: string;
}

export interface StatusWork {
  version: 1;
  items: StatusWorkItem[];
}

/** What one session waits for and what waits on it. Obligations are
 * machine-global, so `humanOwed` is the same number in every session's
 * summary: it is the operator's owed view, not this session's. `roleOwed`
 * counts open records owed by a role party — including projected ledger
 * obligations, whose obligor is the issue component's owner;
 * `unresolvedOwed` counts the role-obligor records whose role resolves to
 * nobody right now (the same number in every summary — an unresolvable role
 * belongs to no session). A role resolving to this session counts toward its
 * `owed` (ResolvedOwedIsComplete), and a session watching an issue counts it
 * toward its `waiting`. */
export interface ObligationsSummary {
  waiting: number;
  owed: number;
  humanOwed: number;
  roleOwed: number;
  unresolvedOwed: number;
}

/** Count open obligations for one session, or for the machine when no
 * session is named. Globally, every open record waits on someone and is
 * owed by a session, a role, or the operator, so
 * `waiting = owed + humanOwed + roleOwed`. Roles resolve at read time via
 * `resolveRole`; without one, every role counts as unresolved — a summary
 * never guesses a resolution it cannot see. */
export function summarizeObligations(
  open: Obligation[],
  sessionId?: string,
  resolveRole?: (role: Role) => string | undefined,
  ledger: LedgerObligation[] = [],
): ObligationsSummary {
  let waiting = 0;
  let owed = 0;
  let humanOwed = 0;
  let roleOwed = 0;
  let unresolvedOwed = 0;
  for (const obligation of open) {
    if (sessionId !== undefined) {
      if (
        obligation.obligee.kind === "session" &&
        obligation.obligee.sessionId === sessionId
      ) {
        waiting++;
      }
      if (
        obligation.obligor.kind === "session" &&
        obligation.obligor.sessionId === sessionId
      ) {
        owed++;
      }
    } else {
      waiting++;
      if (obligation.obligor.kind === "session") owed++;
    }
    if (obligation.obligor.kind === "human") humanOwed++;
    if (obligation.obligor.kind === "role") {
      roleOwed++;
      const resolvedTo = resolveRole?.(obligation.obligor.role);
      if (!resolvedTo) unresolvedOwed++;
      else if (resolvedTo === sessionId) owed++;
    }
  }
  // Projected ledger obligations arrive with the component-owner role already
  // resolved by the caller, so they need no resolver here. Owed by a role in
  // every count; the resolved owner session owes it, each watcher session
  // waits on it.
  for (const obligation of ledger) {
    roleOwed++;
    if (!obligation.ownerSessionId) unresolvedOwed++;
    if (sessionId === undefined) {
      waiting++;
    } else {
      if (obligation.obligees.includes(sessionId)) waiting++;
      if (obligation.ownerSessionId === sessionId) owed++;
    }
  }
  return { waiting, owed, humanOwed, roleOwed, unresolvedOwed };
}

export interface SessionStatus {
  version: 1;
  project: string;
  sessionId: string;
  generatedAt: number;
  name: string;
  nameNoun: string | null;
  peers: number;
  unread: number;
  delivery: StatusDelivery;
  unprocessed: number | null;
  running: number | null;
  work: StatusWork | null;
  /** Present only when the caller supplied open obligations; a failed store
   * read degrades to absence, matching `work: null` in spirit. Additive, so
   * no version bump. */
  obligations?: ObligationsSummary;
}

export const SESSION_STATUS_TTL_MS = 30_000;

/** Missing registration and unknown push authorization are distinct states. */
export function pushDeliveryFor(
  sessions: Registration[],
  sessionId: string | undefined,
): StatusDelivery {
  if (!sessionId) return "";
  const capabilities = sessions.find(
    (r) => r.sessionId === sessionId,
  )?.capabilities;
  if (!capabilities) return "";
  if (!capabilities.channelPush) return "pull";
  const status = capabilities.channelPushStatus;
  if (status === "authorized") return "push";
  if (status === "host-not-loaded" || status === "identity-unauthorized") {
    return "pull";
  }
  return "unknown";
}

/** A logical session owns its work across quit-and-resume: the join is on
 * the session id, not on the process instance that acquired the lease. A
 * resume keeps the session id and changes the instance, so an instance
 * match would orphan the plan line on every restart. The lease must still
 * name a session, and that session must be live; instance fields on the
 * owner remain for displacement and force-release decisions. */
export function statusWorkForSession(
  leases: WorkLease[],
  sessionId: string,
  sessions: Registration[],
): StatusWork {
  const registered = sessions.some((r) => r.sessionId === sessionId);
  const items = registered
    ? leases
        .filter((lease) => lease.owner.sessionId === sessionId)
        .map((lease) => ({
          id: lease.id,
          resourceType: lease.resource.type,
          resourceKey: lease.resource.key,
          ...(lease.resource.label ? { label: lease.resource.label } : {}),
          ...(lease.resource.sourcePath
            ? { sourcePath: lease.resource.sourcePath }
            : {}),
          state: lease.state,
          ...(lease.activity ? { activity: lease.activity } : {}),
          ...(lease.progress ? { progress: lease.progress } : {}),
          updatedAt: lease.updatedAt,
        }))
    : [];
  return { version: 1, items };
}

/** CLI and daemon share the same status contract and exact project/session joins. */
export function makeSessionStatus(input: {
  project: string;
  sessionId: string;
  sessions: Registration[];
  meta: Map<string, ClaudeSessionMeta>;
  unread: number;
  leases: WorkLease[] | undefined;
  jobs: WeftJobsSnapshot | undefined;
  running: RunningJobsSnapshot | undefined;
  /** Open obligation records, machine-global, collected once per refresh by
   * the caller. Optional so existing callers keep compiling; omitting it
   * omits the summary rather than reporting zeros. */
  openObligations?: Obligation[];
  /** Ledger obligations projected from the daemon's issues snapshot, already
   * role-resolved. Collected with the same once-per-refresh read. */
  ledgerObligations?: LedgerObligation[];
  /** Role resolver used while summarizing. Refresh supplies a degrading
   * wrapper: a throw for one foreign record becomes a collected error and
   * an unresolved role, not a lost session status. */
  roleSessionId?: (role: Role) => string | undefined;
  nowMs: number;
}): SessionStatus {
  const {
    project,
    sessionId,
    sessions,
    meta,
    unread,
    leases,
    jobs,
    running,
    openObligations,
    ledgerObligations,
    roleSessionId = (role: Role) => obligations.sessionResponsibleFor(role),
    nowMs,
  } = input;
  const identity = sessionNames(sessionId, meta.get(sessionId), project);
  return {
    version: 1,
    project,
    sessionId,
    generatedAt: nowMs,
    name: identity.displayName,
    nameNoun: identity.nameNoun,
    peers: peersInProject(sessions, sessionId, meta, nowMs).length,
    unread,
    delivery: pushDeliveryFor(sessions, sessionId),
    unprocessed: unprocessedForProjectSession(jobs, project, sessionId),
    running: runningForProjectSession(running, project, sessionId),
    work: leases ? statusWorkForSession(leases, sessionId, sessions) : null,
    ...(openObligations
      ? {
          obligations: summarizeObligations(
            openObligations,
            sessionId,
            (role: Role) => roleSessionId(role),
            ledgerObligations,
          ),
        }
      : {}),
  };
}

/** One collection per presence tick, one spool/work read per project.
 * HTTP readers perform only a lookup; they never launch processes or scan mail.
 * Muting disables reminder publication, not a session's ability to see its counts. */
export class SessionStatusCache {
  #projects = new Map<string, Map<string, SessionStatus>>();
  #failedProjects = new Set<string>();
  #initialized = false;

  refresh(
    sessions: Registration[],
    nowMs = Date.now(),
  ): {
    unreadSummary: Record<string, UnreadSummaryEntry>;
    errors: string[];
  } {
    const meta = claudeSessions();
    const jobs = readWeftJobsSnapshot(nowMs);
    const running = readRunningJobsSnapshot(nowMs);
    const grouped = new Map<string, Registration[]>();
    for (const registration of sessions) {
      if (!registration.sessionId) continue;
      const project = canonicalProject(registration.cwd);
      const registrations = grouped.get(project) ?? [];
      registrations.push(registration);
      grouped.set(project, registrations);
    }
    const next = new Map<string, Map<string, SessionStatus>>();
    const failed = new Set<string>();
    const unreadSummary: Record<string, UnreadSummaryEntry> = {};
    const errors: string[] = [];
    // One machine-global read per refresh, shared by every session status;
    // failures degrade to an absent summary like a failed work read does.
    let openObligations: Obligation[] | undefined;
    try {
      openObligations = obligations.listOpen();
    } catch (error) {
      errors.push(`session status obligations failed: ${String(error)}`);
    }
    // A foreign record citing a since-deleted component or plan must degrade
    // to a collected error and an unresolved role — not take the project's
    // unread, work, and peer summary down with it.
    const safeRoleSessionId = (role: Role): string | undefined => {
      try {
        return obligations.sessionResponsibleFor(role);
      } catch (error) {
        errors.push(
          `session status obligation resolution failed: ${String(error)}`,
        );
        return undefined;
      }
    };
    // The ledger projection reads the daemon's snapshot file, never spawns
    // `issues`; a missing snapshot simply contributes no rows.
    const ledgerObligations = openObligations
      ? currentLedgerObligations(safeRoleSessionId, nowMs).obligations
      : undefined;
    for (const [project, registrations] of grouped) {
      try {
        const logical = coalesceRegistrations(registrations);
        const unread = computeUnreadSummary(
          logical.map(({ sessionId }) => ({ cwd: project, sessionId })),
        );
        // Reminder eligibility belongs to each raw component, not the merged
        // display registration. A naming/work failure must not suppress mail.
        for (const registration of registrations) {
          if (registration.sessionId && !registration.muted) {
            unreadSummary[registration.sessionId] =
              unread[registration.sessionId];
          }
        }
        let leases: WorkLease[] | undefined;
        try {
          leases = work.list(project);
        } catch (error) {
          errors.push(
            `session status work failed for ${project}: ${String(error)}`,
          );
        }
        const statuses = new Map<string, SessionStatus>();
        for (const registration of logical) {
          const sessionId = registration.sessionId;
          if (!sessionId) continue;
          const summary = unread[sessionId];
          statuses.set(
            sessionId,
            makeSessionStatus({
              project,
              sessionId,
              sessions: logical,
              meta,
              unread: summary.unread,
              leases,
              jobs,
              running,
              openObligations,
              ledgerObligations,
              roleSessionId: safeRoleSessionId,
              nowMs,
            }),
          );
        }
        next.set(project, statuses);
      } catch (error) {
        errors.push(
          `session status collection failed for ${project}: ${String(error)}`,
        );
        failed.add(project);
        const previous = this.#projects.get(project);
        if (previous) next.set(project, previous);
      }
    }
    this.#projects = next;
    this.#failedProjects = failed;
    this.#initialized = true;
    return { unreadSummary, errors };
  }

  /** The query identity is exact; an absent session is never joined by host or name. */
  response(project: string, sessionId: string, nowMs = Date.now()): Response {
    const canonical = canonicalProject(project);
    const status = this.#projects.get(canonical)?.get(sessionId);
    const unavailable =
      !this.#initialized ||
      this.#failedProjects.has(canonical) ||
      (status !== undefined &&
        nowMs - status.generatedAt > SESSION_STATUS_TTL_MS);
    if (unavailable) {
      return Response.json(
        { error: "session status unavailable" },
        { status: 503 },
      );
    }
    if (!status) {
      return Response.json(
        { error: "unknown project/session" },
        { status: 404 },
      );
    }
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  }
}
