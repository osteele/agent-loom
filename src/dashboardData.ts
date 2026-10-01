/** Shared aggregation for the web and Slack dashboards.
 *
 * Message summaries come from a spool-derived index; coordination and presence
 * remain readable without the daemon. */

import {
  type CoordinationEntry,
  isDisplaceable,
  listCoordination,
} from "./coordination.ts";
import {
  type LedgerObligation,
  ledgerObligationsDiagnostic,
  projectLedgerObligations,
  readLedgerIssuesSnapshot,
} from "./ledgerIssues.ts";
import { indexedMessages, messageRecipient } from "./messageIndex.ts";
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
import type { StoredMessage } from "./spool.ts";
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
    /** False when another process held the message index's write lock, so
     * totals, routes, volume and the log come from its last committed state
     * and may omit the newest messages or read marks. Additive within
     * schemaVersion 1. */
    messages: boolean;
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
  /** Open issue-ledger issues projected as obligations (never stored), with
   * the diagnostic that explains their absence or degraded freshness.
   * Additive within schemaVersion 1. */
  ledgerObligations: LedgerObligationView[];
  ledgerDiagnostic?: string;
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
  description?: string;
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
  obligee: PartyView;
  obligor: PartyView;
}

/** A projected ledger obligation (src/ledgerIssues.ts): never stored, so it
 * carries its snapshot provenance rather than a lifecycle. Additive within
 * schemaVersion 1. */
export interface LedgerObligationView {
  id: string;
  kind: "external_fix";
  subject: string;
  component: string;
  obligor: PartyView;
  /** Sessions watching the issue through `agent-loom:` tokens. */
  obligees: string[];
  source: "issue-ledger";
  observedAt: string;
  stale: boolean;
}

function ledgerObligationRecords(
  ledger: LedgerObligation[],
  deps: PartyViewDeps,
): LedgerObligationView[] {
  return ledger.map((obligation) => ({
    id: obligation.id,
    kind: obligation.kind,
    subject: obligation.subject,
    component: obligation.component,
    obligor: partyView(
      {
        kind: "role",
        role: obligation.obligorRole,
        label: `owner of ${obligation.component}`,
      },
      deps,
    ),
    obligees: obligation.obligees,
    source: obligation.source,
    observedAt: new Date(obligation.observedAt).toISOString(),
    stale: obligation.stale,
  }));
}

function obligationRecords(
  open: Obligation[],
  deps: PartyViewDeps,
): ObligationRecordView[] {
  return open.map((record) => {
    return {
      id: record.id,
      kind: record.kind,
      subject: record.subject,
      ...(record.description ? { description: record.description } : {}),
      createdAt: record.createdAt,
      contested: record.contested,
      ...(record.options ? { options: record.options } : {}),
      ...(record.markers ? { markers: record.markers } : {}),
      ...(record.comments?.length ? { comments: record.comments } : {}),
      ...(record.contestReason ? { contestReason: record.contestReason } : {}),
      ...(record.adoptedFrom ? { adoptedFrom: record.adoptedFrom } : {}),
      ...(record.adoptedAt ? { adoptedAt: record.adoptedAt } : {}),
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
  const now = new Date();
  const indexed = indexedMessages(opts.project, logLimit, now);
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
  // Ledger obligations project from the daemon's issues snapshot (a file
  // read, never a spawn) with the same machine-global role resolution.
  const ledgerSnapshot = readLedgerIssuesSnapshot();
  const ledgerProjection = ledgerSnapshot
    ? projectLedgerObligations(ledgerSnapshot, now.getTime(), (role) =>
        obligations.sessionResponsibleFor(role),
      )
    : [];
  const liveSessionIds = new Set(
    liveAll
      .map((registration) => registration.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );
  const partyDeps: PartyViewDeps = {
    isLive: (sessionId) => liveSessionIds.has(sessionId),
    roleSessionId: (role) => obligations.sessionResponsibleFor(role),
  };
  const log: LogEntry[] = indexed.messages.map((m) => ({
    ts: m.ts,
    from: displayName(m.from),
    to: messageRecipient(m),
    thread: Boolean(m.replyTo),
    preview: preview(m.message),
  }));
  const ledgerDiagnostic = ledgerObligationsDiagnostic(
    ledgerSnapshot,
    now.getTime(),
  );
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
      messages: indexed.current,
    },
    now: now.toISOString(),
    totals: {
      messages: indexed.totals.messages,
      projects: indexed.totals.projects,
      threads: indexed.totals.threads,
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
    obligations: summarizeObligations(
      openObligations,
      undefined,
      (role) => obligations.sessionResponsibleFor(role),
      ledgerProjection,
    ),
    obligationRecords: obligationRecords(openObligations, partyDeps),
    ledgerObligations: ledgerObligationRecords(ledgerProjection, partyDeps),
    ...(ledgerDiagnostic ? { ledgerDiagnostic } : {}),
    routes: indexed.routes,
    log,
    volume: indexed.volume,
    messages: indexed.messages,
    transfers: transfers.list(opts.project),
  };
}

/** Snapshot-based state aggregation for automation and the HTTP API. */
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
