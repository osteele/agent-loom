/** Shared aggregation for the web and Slack dashboards.
 *
 * Reads the spools and the live registry directly — no daemon dependency, so a
 * dashboard works even when the daemon is down. */

import {
  type CoordinationEntry,
  isDisplaceable,
  listCoordination,
} from "./coordination.ts";
import {
  type PartyView,
  type PartyViewDeps,
  partyView,
} from "./obligationResolution.ts";
import { obligations } from "./obligations.ts";
import type {
  Obligation,
  ObligationComment,
  ObligationMarker,
  RefState,
} from "./obligations.ts";
import { canonicalProject, displayName } from "./paths.ts";
import { readListenerSnapshot } from "./presence.ts";
import { readProcessSnapshot } from "./processSnapshot.ts";
import {
  type ProcessScan,
  type Registration,
  capabilityLabels,
  coalesceRegistrations,
  listLive,
} from "./registry.ts";
import {
  type ObligationsSummary,
  summarizeObligations,
} from "./sessionStatus.ts";
import {
  activityTag,
  claudeSessions,
  lastActivityMs,
  sessionNames,
} from "./sessions.ts";
import { type StoredMessage, readAllMessages } from "./spool.ts";
import { type WorkTransferRequest, transfers } from "./transfers.ts";

export interface FlowRoute {
  from: string;
  to: string;
  count: number;
}

export interface LogEntry {
  ts: string;
  from: string;
  to: string;
  thread: boolean; // true when this message is a reply
  preview: string;
}

export interface PresenceEntry {
  project: string;
  sessionId?: string;
  fullName: string;
  displayName: string;
  status?: string;
  activity: string; // recency tag: "busy" / "active" / "idle 26h — stale?"
  lastActive: string; // ISO 8601 of the most recent sign of life
  client?: string; // host client: "claude-code", "codex", ...
  capabilities: string[];
  inboundPolicy: string;
  muted?: boolean; // channel push paused
  pid: number;
  procStart?: string;
  instanceId?: string;
  started: string;
  lastSeen?: string;
  lastInboxPoll?: string;
}

export interface VolumeBucket {
  hour: string; // ISO hour bucket start
  count: number;
}

export interface WorkEntry {
  id: string;
  project: string;
  resourceType: string;
  resourceKey: string;
  resourceLabel?: string;
  sourcePath?: string;
  owner: string;
  ownerSessionId?: string;
  ownerLive: boolean;
  state: string;
  activity?: string;
  updatedAt: string;
}

export interface DashboardState {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    mode: "live-filesystem" | "filesystem-snapshot";
    presence: "live-registry" | "presence-snapshot";
    coordination: "filesystem";
    messages: "spool";
  };
  freshness: {
    presence: boolean;
    presenceGeneratedAt: number | null;
    processEvidence: boolean;
    processEvidenceGeneratedAt: number | null;
  };
  now: string;
  totals: {
    messages: number;
    projects: number;
    threads: number;
    live: number;
    work: number;
    claims: number;
    coordination: number;
  };
  presence: PresenceEntry[];
  work: WorkEntry[];
  coordination: CoordinationEntry[];
  /** Machine-global obligations aggregate (specs/obligations.allium): open
   * records waiting on someone, owed by sessions, and owed by the operator.
   * Additive within schemaVersion 1. */
  obligations: ObligationsSummary;
  /** The same open records, one flat entry each with both ends resolved to
   * sessions where possible — grouping by project is the consumer's job.
   * Additive within schemaVersion 1. */
  obligationRecords: ObligationRecordView[];
  routes: FlowRoute[];
  log: LogEntry[];
  volume: VolumeBucket[];
  messages: StoredMessage[];
  transfers: WorkTransferRequest[];
}

export interface ObligationRecordView {
  id: string;
  kind: Obligation["kind"];
  subject: string;
  createdAt: string;
  contested: boolean;
  contestReason?: string;
  adoptedFrom?: string;
  adoptedAt?: string;
  /** Declared choices for a decision the obligor may pick from; plain
   * free-text entries, no ids — the chosen text survives renumbering. */
  options?: string[];
  /** Typed background markers: path markers are absolute paths, label
   * markers are reference text resolved against the obligee's lab
   * notebook. */
  markers?: ObligationMarker[];
  /** Append-only commentary from either end or the operator. */
  comments?: ObligationComment[];
  /** Latest reference observation, for records that cite an external record
   * (open external_fix waits). Absent when nothing has been observed. */
  ref?: { state: RefState };
  obligee: PartyView;
  obligor: PartyView;
}

function obligationRecords(
  open: Obligation[],
  deps: PartyViewDeps,
  latestRef: (id: string) => { state: RefState } | undefined,
): ObligationRecordView[] {
  return open.map((record) => {
    const observation = latestRef(record.id);
    return {
      id: record.id,
      kind: record.kind,
      subject: record.subject,
      createdAt: record.createdAt,
      contested: record.contested,
      ...(record.options ? { options: record.options } : {}),
      ...(record.markers ? { markers: record.markers } : {}),
      ...(record.comments?.length ? { comments: record.comments } : {}),
      ...(record.contestReason ? { contestReason: record.contestReason } : {}),
      ...(record.adoptedFrom ? { adoptedFrom: record.adoptedFrom } : {}),
      ...(record.adoptedAt ? { adoptedAt: record.adoptedAt } : {}),
      ...(observation ? { ref: { state: observation.state } } : {}),
      obligee: partyView(record.obligee, deps),
      obligor: partyView(record.obligor, deps),
    };
  });
}

function activeWork(entries: CoordinationEntry[]): WorkEntry[] {
  return entries
    .filter((entry) => entry.kind === "work")
    .map((entry) => ({
      id: entry.id,
      project: entry.projectLabel,
      resourceType: entry.resourceType,
      resourceKey: entry.resourceKey,
      resourceLabel: entry.resourceLabel,
      sourcePath: entry.sourcePaths[0],
      owner: entry.owner.label,
      ownerSessionId: entry.owner.sessionId,
      ownerLive: !isDisplaceable(entry.ownerStatus),
      state: entry.state ?? "working",
      activity: entry.activity,
      updatedAt: entry.updatedAt,
    }));
}

/** One-line snippet of a message body. */
function preview(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function presence(registrations: Registration[]): PresenceEntry[] {
  const meta = claudeSessions();
  return coalesceRegistrations(registrations)
    .map((r) => {
      // Derive the label from live Claude meta + cwd; the registry `name`
      // snapshot may be stale (a rename) or a legacy synthetic id.
      const sessionMeta = r.sessionId ? meta.get(r.sessionId) : undefined;
      const lastActive = lastActivityMs(r, sessionMeta);
      const names = r.sessionId
        ? sessionNames(r.sessionId, sessionMeta, r.cwd)
        : {
            fullName: r.client ?? "unnamed",
            displayName: r.client ?? "unnamed",
          };
      return {
        project: displayName(r.cwd),
        sessionId: r.sessionId,
        fullName: names.fullName,
        displayName: names.displayName,
        status: sessionMeta?.status,
        activity: activityTag(sessionMeta?.status, lastActive),
        lastActive: new Date(lastActive).toISOString(),
        client: r.client,
        capabilities: r.capabilities ? capabilityLabels(r.capabilities) : [],
        inboundPolicy: r.inboundPolicy ?? "accept",
        muted: r.muted,
        pid: r.pid,
        procStart: r.procStart,
        instanceId: r.instanceId,
        started: r.started,
        lastSeen: r.lastSeen,
        lastInboxPoll: r.lastInboxPoll,
      };
    })
    .sort((a, b) => a.project.localeCompare(b.project));
}

function recipient(msg: StoredMessage): string {
  return msg.delivery === "audit" && msg.meta?.nativeRecipient
    ? msg.meta.nativeRecipient
    : displayName(msg.project);
}

/** Map-key separator for from/to pairs. A control character cannot occur in a
 * project label, so it cannot collide with one; it is written as an escape
 * because a literal NUL in the source makes git treat this file as binary and
 * makes grep skip it entirely. */
const ROUTE_KEY_SEP = "\u0000";

function routes(msgs: StoredMessage[]): FlowRoute[] {
  const counts = new Map<string, number>();
  for (const m of msgs) {
    const key = `${displayName(m.from)}${ROUTE_KEY_SEP}${recipient(m)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split(ROUTE_KEY_SEP);
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);
}

/** Hourly message counts for the trailing `hours` window, oldest bucket first. */
function volume(msgs: StoredMessage[], now: Date, hours = 24): VolumeBucket[] {
  const buckets: VolumeBucket[] = [];
  const top = new Date(now);
  top.setMinutes(0, 0, 0);
  const startMs = top.getTime() - (hours - 1) * 3600_000;
  for (let i = 0; i < hours; i++) {
    buckets.push({
      hour: new Date(startMs + i * 3600_000).toISOString(),
      count: 0,
    });
  }
  for (const m of msgs) {
    const t = Date.parse(m.ts);
    if (!Number.isFinite(t)) continue;
    const idx = Math.floor((t - startMs) / 3600_000);
    if (idx >= 0 && idx < hours) buckets[idx].count++;
  }
  return buckets;
}

export function buildState(
  opts: {
    logLimit?: number;
    project?: string;
    registrations?: Registration[];
    processes?: ProcessScan;
    registrationsReliable?: boolean;
    sourceMode?: "live-filesystem" | "filesystem-snapshot";
    presenceFresh?: boolean;
    presenceGeneratedAt?: number | null;
    processEvidenceFresh?: boolean;
    processEvidenceGeneratedAt?: number | null;
  } = {},
): DashboardState {
  const logLimit = opts.logLimit ?? 60;
  const msgs = readAllMessages().filter(
    (message) => !opts.project || message.project === opts.project,
  );
  const now = new Date();
  // Obligation party resolution is machine-global — records span projects, so
  // a project-scoped query must not report cross-project parties as offline.
  // The project filter below scopes presence and coordination only.
  const liveAll = opts.registrations ?? listLive();
  const live = liveAll.filter(
    (registration) => !opts.project || registration.cwd === opts.project,
  );
  const coordination = listCoordination({
    ...(opts.project ? { project: opts.project } : { allProjects: true }),
    registrations: live,
    registrationsReliable: opts.registrationsReliable,
    ...(opts.processes ? { processes: opts.processes } : {}),
  });
  const leases = activeWork(coordination);
  // Machine-global and small: open obligation records live in one directory,
  // bounded by the thirty-day terminal retention.
  const openObligations = obligations.listOpen();
  const liveSessionIds = new Set(
    liveAll
      .map((registration) => registration.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );
  const partyDeps: PartyViewDeps = {
    isLive: (sessionId) => liveSessionIds.has(sessionId),
    roleSessionId: (role) => obligations.sessionResponsibleFor(role),
  };
  const log: LogEntry[] = msgs
    .slice(-logLimit)
    .reverse()
    .map((m) => ({
      ts: m.ts,
      from: displayName(m.from),
      to: recipient(m),
      thread: Boolean(m.replyTo),
      preview: preview(m.message),
    }));
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    source: {
      mode: opts.sourceMode ?? "live-filesystem",
      presence:
        opts.sourceMode === "filesystem-snapshot"
          ? "presence-snapshot"
          : "live-registry",
      coordination: "filesystem",
      messages: "spool",
    },
    freshness: {
      presence: opts.presenceFresh ?? true,
      presenceGeneratedAt: opts.presenceGeneratedAt ?? null,
      processEvidence: opts.processEvidenceFresh ?? true,
      processEvidenceGeneratedAt: opts.processEvidenceGeneratedAt ?? null,
    },
    now: now.toISOString(),
    totals: {
      messages: msgs.length,
      projects: new Set(msgs.map((m) => m.project)).size,
      threads: new Set(msgs.map((m) => m.threadId ?? m.id)).size,
      live: live.length,
      work: leases.length,
      claims: coordination.filter(
        (entry) => entry.kind !== "work" && entry.kind !== "obligation",
      ).length,
      coordination: coordination.length,
    },
    presence: presence(live),
    work: leases,
    coordination,
    obligations: summarizeObligations(openObligations, undefined, (role) =>
      obligations.sessionResponsibleFor(role),
    ),
    obligationRecords: obligationRecords(openObligations, partyDeps, (id) => {
      const observation = obligations.latestRef(id);
      return observation ? { state: observation.state } : undefined;
    }),
    routes: routes(msgs),
    log,
    volume: volume(msgs, now),
    messages: msgs.slice(-logLimit).reverse(),
    transfers: transfers.list(opts.project),
  };
}

/** Stable, non-mutating state aggregation for automation and the HTTP API. */
export function buildReadOnlyState(
  opts: { logLimit?: number; project?: string; nowMs?: number } = {},
): DashboardState {
  const nowMs = opts.nowMs ?? Date.now();
  const project = opts.project ? canonicalProject(opts.project) : undefined;
  // Unfiltered: buildState re-applies the project filter to presence and
  // coordination, while obligation party resolution stays machine-global.
  const listener = readListenerSnapshot(undefined, nowMs);
  const records = listCoordination({
    ...(project ? { project } : { allProjects: true }),
    registrations: listener.sessions,
    registrationsReliable: listener.fresh,
    processes: { processes: new Map(), reliable: false },
  });
  const ownerPids = records
    .map((record) => record.owner)
    .filter((owner) => !owner.sessionId && owner.pid !== undefined)
    .map((owner) => owner.pid as number);
  const processReport = readProcessSnapshot(ownerPids, nowMs);
  return buildState({
    logLimit: opts.logLimit,
    project,
    registrations: listener.sessions,
    registrationsReliable: listener.fresh,
    processes: processReport.evidence,
    sourceMode: "filesystem-snapshot",
    presenceFresh: listener.fresh,
    presenceGeneratedAt: listener.generatedAt,
    processEvidenceFresh: processReport.fresh,
    processEvidenceGeneratedAt: processReport.generatedAt,
  });
}
