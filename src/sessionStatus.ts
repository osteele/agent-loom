/** Daemon-owned presentation data. Delivery and coordination never read this cache. */
import { canonicalProject } from "./paths.ts";
import { peersInProject } from "./presence.ts";
import { type Registration, coalesceRegistrations } from "./registry.ts";
import { claudeSessions, sessionDisplayName } from "./sessions.ts";
import {
  type UnreadSummaryEntry,
  computeUnreadSummary,
} from "./unreadSummary.ts";
import { readWeftJobsSnapshot } from "./weftJobs.ts";
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

export interface SessionStatus {
  version: 1;
  project: string;
  sessionId: string;
  generatedAt: number;
  name: string;
  peers: number;
  unread: number;
  delivery: StatusDelivery;
  unprocessed: number | null;
  work: StatusWork | null;
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
          statuses.set(sessionId, {
            version: 1,
            project,
            sessionId,
            generatedAt: nowMs,
            name: sessionDisplayName(sessionId, meta.get(sessionId), project),
            peers: peersInProject(logical, sessionId, meta, nowMs).length,
            unread: summary.unread,
            delivery: pushDeliveryFor(logical, sessionId),
            unprocessed: jobs ? (jobs.bySession[sessionId] ?? 0) : null,
            work: leases
              ? statusWorkForSession(leases, sessionId, registrations)
              : null,
          });
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
