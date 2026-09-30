/** Open issue-ledger issues, snapshotted by the daemon and projected into
 * obligations at read time.
 *
 * Every open issue in the ledger IS an obligation — the owner of the issue's
 * component owes the fix — so agent-mail stores nothing for it: the ledger is
 * the record, and this module holds only the daemon's raw read of it. The
 * daemon's periodic `issues list --json` refresh lands here, as does an early
 * refresh an event hook requests; views, the status line, and `state --json`
 * read this file and never spawn `issues` (the status line's budget is
 * 300ms — see docs/status-line.md).
 *
 * The same two invariants as `weftJobs.ts`, for the same reasons:
 *
 * - **A presentation cache, never a routing input.** The projection is stale
 *   by construction (up to a refresh interval). Nothing that decides delivery
 *   or coordination may read it.
 * - **Raw rows, never derived text.** The file holds the ledger's own fields
 *   so the projection needs no daemon coupling.
 *
 * Readers degrade visibly rather than falling back to spawning `issues`: a
 * missing snapshot renders one diagnostic line, a stale one renders its rows
 * marked with their age, and a failed refresh keeps the previous rows and
 * records the error alongside them.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ObligationRoleResolver, Role } from "./obligations.ts";
import { LEDGER_ISSUES_SNAPSHOT_PATH } from "./paths.ts";
import { formatAge } from "./sessions.ts";

/** Watcher tokens agent-mail mints on an issue name the waiting session as
 * `agent-mail:<session-id>`. Tokens with any other prefix belong to other
 * tools and are ignored here. */
export const AGENT_MAIL_WATCHER_PREFIX = "agent-mail:";

/** One open issue from `issues list --json`. `watchers` and `componentPath`
 * postdate the first consumers of this file, so a row that omits them parses
 * with `[]` and unknown respectively. */
export interface LedgerIssueRow {
  id: string;
  title: string;
  component: string;
  componentPath?: string;
  watchers: string[];
}

export interface LedgerIssuesSnapshot {
  version: 1;
  /** Epoch ms of the last successful `issues list --json` read. In-band
   * rather than the file's mtime, which a backup restore destroys. */
  observedAt: number;
  /** Writing process's pid, for explaining a stale file. */
  observedBy: number;
  issues: LedgerIssueRow[];
  /** The most recent failed refresh. The rows stay from the last good read. */
  lastError?: string;
  lastErrorAt?: number;
}

/** How often the daemon refreshes. Deliberately far slower than the daemon's
 * 10s tick: a subprocess every 10 seconds is a background job on a machine
 * that already reaches load 100. */
export const LEDGER_ISSUES_REFRESH_MS = 60_000;

/** Three refresh intervals, matching how `weftJobs.ts` sizes its own TTL
 * against its refresh: one missed refresh is tolerated, a stopped daemon
 * reads as stale. */
export const LEDGER_ISSUES_SNAPSHOT_TTL_MS = 3 * LEDGER_ISSUES_REFRESH_MS;

/** Parse the bare array `issues list --json` prints, keeping open rows. A
 * document this build does not recognise is refused whole rather than
 * partially parsed: a silently dropped open issue reads as settled, which is
 * the one direction this feature must never err in. Rows carry more fields
 * than these (the ledger's contract keeps them stable); only the projection's
 * inputs are read. */
export function parseLedgerIssueRows(
  raw: unknown,
): LedgerIssueRow[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rows: LedgerIssueRow[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const row = entry as {
      id?: unknown;
      title?: unknown;
      component?: unknown;
      status?: unknown;
      watchers?: unknown;
      component_path?: unknown;
    };
    if (
      typeof row.id !== "string" ||
      !row.id ||
      typeof row.title !== "string" ||
      typeof row.component !== "string" ||
      !row.component
    )
      return undefined;
    // The listing is open issues only; a status field that says otherwise
    // excludes the row rather than projecting a closed issue as owed.
    if (row.status !== undefined && row.status !== "open") continue;
    const watchers: unknown = row.watchers ?? [];
    if (
      !Array.isArray(watchers) ||
      watchers.some((watcher) => typeof watcher !== "string")
    )
      return undefined;
    if (
      row.component_path !== undefined &&
      typeof row.component_path !== "string"
    )
      return undefined;
    rows.push({
      id: row.id,
      title: row.title,
      component: row.component,
      ...(typeof row.component_path === "string"
        ? { componentPath: row.component_path }
        : {}),
      watchers: [...watchers],
    });
  }
  return rows;
}

/** Publish a snapshot. Temp file plus rename, so a reader on a latency
 * budget never parses a half-written file. A failed refresh keeps the
 * previous rows and records the error: the last good read is worth more than
 * a blank one. */
export function writeLedgerIssuesSnapshot(
  result: { issues: LedgerIssueRow[] } | { error: string },
  nowMs = Date.now(),
  path = LEDGER_ISSUES_SNAPSHOT_PATH,
): LedgerIssuesSnapshot {
  const previous =
    "error" in result ? readLedgerIssuesSnapshot(path) : undefined;
  const snapshot: LedgerIssuesSnapshot = {
    version: 1,
    observedAt: previous?.observedAt ?? nowMs,
    observedBy: process.pid,
    issues: "error" in result ? (previous?.issues ?? []) : result.issues,
    ...("error" in result
      ? { lastError: result.error, lastErrorAt: nowMs }
      : {}),
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 1));
  renameSync(tmp, path);
  return snapshot;
}

/** The snapshot if it exists, parses, and matches the version. Age is not
 * filtered here: staleness is a rendering decision (rows still show, marked
 * with their age), unlike the weft counts which expire to absence. Never
 * throws: a view that crashes is worse than one that shows no ledger rows. */
export function readLedgerIssuesSnapshot(
  path = LEDGER_ISSUES_SNAPSHOT_PATH,
): LedgerIssuesSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined; // missing or unparseable
  }
  const snapshot = parsed as Partial<LedgerIssuesSnapshot>;
  if (snapshot.version !== 1) return undefined;
  if (typeof snapshot.observedAt !== "number") return undefined;
  if (!Number.isFinite(snapshot.observedAt)) return undefined;
  if (!Array.isArray(snapshot.issues)) return undefined;
  if (
    snapshot.issues.some(
      (row) =>
        !row ||
        typeof row.id !== "string" ||
        typeof row.title !== "string" ||
        typeof row.component !== "string" ||
        !Array.isArray(row.watchers) ||
        row.watchers.some((watcher) => typeof watcher !== "string") ||
        (row.componentPath !== undefined &&
          typeof row.componentPath !== "string"),
    )
  )
    return undefined;
  if (
    snapshot.lastError !== undefined &&
    typeof snapshot.lastError !== "string"
  )
    return undefined;
  if (
    snapshot.lastErrorAt !== undefined &&
    (typeof snapshot.lastErrorAt !== "number" ||
      !Number.isFinite(snapshot.lastErrorAt))
  )
    return undefined;
  return snapshot as LedgerIssuesSnapshot;
}

/** A read-only obligation projected from one open ledger issue. Distinct
 * from the stored `Obligation` on purpose: it has no lifecycle here (the
 * ledger owns it), its id namespace can never collide with a stored `ob-…`
 * id, and views must be able to tell the two apart. */
export interface LedgerObligation {
  /** `issue:<citable id>` — e.g. `issue:am17`. */
  id: string;
  kind: "external_fix";
  /** `<id>: <title>`. */
  subject: string;
  /** The component whose owner owes the fix. */
  component: string;
  /** The obligor role: the component's owner. `component_path` is passed
   * when the ledger carries one (an existing directory resolves directly);
   * otherwise the component name, which the resolver's basename match may
   * leave unresolved. */
  obligorRole: { kind: "component_owner"; component: string };
  /** The session the obligor role resolves to right now, or undefined —
   * rendered unresolvable, never guessed. */
  ownerSessionId?: string;
  /** Sessions watching the issue through `agent-mail:` tokens. Empty when no
   * session watches; the fix is still owed. */
  obligees: string[];
  source: "issue-ledger";
  /** Epoch ms of the snapshot read this was projected from. */
  observedAt: number;
  /** The snapshot is older than its TTL. */
  stale: boolean;
}

/** The component-owner role used by both the read-only projection and the
 * ledger event hook. A path takes precedence over a component name. */
export function ledgerIssueOwnerRole(issue: {
  component: string;
  componentPath?: string;
}): Extract<Role, { kind: "component_owner" }> {
  return {
    kind: "component_owner",
    component: issue.componentPath ?? issue.component,
  };
}

/** The projection, a pure function of (snapshot, now, role resolver) so it
 * is unit-testable from fixtures. */
export function projectLedgerObligations(
  snapshot: LedgerIssuesSnapshot,
  nowMs: number,
  resolveRole: ObligationRoleResolver,
): LedgerObligation[] {
  const stale = nowMs - snapshot.observedAt > LEDGER_ISSUES_SNAPSHOT_TTL_MS;
  return snapshot.issues
    .map((issue) => {
      const role = ledgerIssueOwnerRole(issue);
      const obligees = [
        ...new Set(
          issue.watchers
            .filter((token) => token.startsWith(AGENT_MAIL_WATCHER_PREFIX))
            .map((token) => token.slice(AGENT_MAIL_WATCHER_PREFIX.length))
            .filter((sessionId) => sessionId.length > 0),
        ),
      ];
      return {
        id: `issue:${issue.id}`,
        kind: "external_fix" as const,
        subject: `${issue.id}: ${issue.title}`,
        component: issue.component,
        obligorRole: role,
        ownerSessionId: resolveRole(role),
        obligees,
        source: "issue-ledger" as const,
        observedAt: snapshot.observedAt,
        stale,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface LedgerObligationsView {
  obligations: LedgerObligation[];
  /** Why ledger obligations are absent or degraded. Listings print this
   * rather than omitting ledger rows silently. */
  diagnostic?: string;
}

/** Why the ledger projection is absent or degraded, in one line. Absence of
 * a snapshot means the daemon has not refreshed one (not running, or
 * `issues` not installed); a failed refresh names the error and its age. */
export function ledgerObligationsDiagnostic(
  snapshot: LedgerIssuesSnapshot | undefined,
  nowMs: number,
): string | undefined {
  if (!snapshot) {
    return "ledger obligations unavailable: no issue snapshot; the daemon writes one from `issues list --json` each minute it runs";
  }
  if (snapshot.lastError && snapshot.lastErrorAt !== undefined) {
    return `ledger refresh failed ${formatAge(nowMs - snapshot.lastErrorAt)} ago: ${snapshot.lastError}; showing issues as of ${new Date(snapshot.observedAt).toISOString()}`;
  }
  return undefined;
}

/** The projection over the current snapshot, with its diagnostic. The one
 * read path every view shares. */
export function currentLedgerObligations(
  resolveRole: ObligationRoleResolver,
  nowMs = Date.now(),
  path = LEDGER_ISSUES_SNAPSHOT_PATH,
): LedgerObligationsView {
  const snapshot = readLedgerIssuesSnapshot(path);
  return {
    obligations: snapshot
      ? projectLedgerObligations(snapshot, nowMs, resolveRole)
      : [],
    diagnostic: ledgerObligationsDiagnostic(snapshot, nowMs),
  };
}

/** One listing line for a projected ledger obligation, tagged with its
 * source and — past the snapshot TTL — its age. Shared by the CLI and MCP
 * renderings so the two cannot drift. */
export function describeLedgerObligation(
  obligation: LedgerObligation,
  nowMs: number,
): string {
  const owner = obligation.ownerSessionId
    ? `owner of ${obligation.component} → ${obligation.ownerSessionId}`
    : `owner of ${obligation.component} (unresolvable: no single responsible session)`;
  const obligees = obligation.obligees.length
    ? obligation.obligees.join(", ")
    : "no watcher";
  const stale = obligation.stale
    ? ` [stale: snapshot ${formatAge(nowMs - obligation.observedAt)} old]`
    : "";
  return `${obligation.id} external_fix ${obligation.subject} — owed to ${obligees} by ${owner} [open] [issue-ledger]${stale} [observed ${new Date(obligation.observedAt).toISOString()}]`;
}

/** A mutating verb aimed at a projected ledger obligation is refused: the
 * record lives in the issue ledger, so the ledger's own command is the
 * answer. Returns undefined for a stored `ob-…` id. */
export function ledgerObligationRefusal(
  id: string,
  verb: "close" | "withdraw" | "contest" | "update" | "comment" | "clear",
): string | undefined {
  if (!id.startsWith("issue:")) return undefined;
  const issue = id.slice("issue:".length);
  const command =
    verb === "close" || verb === "clear"
      ? `issues close ${issue}`
      : verb === "withdraw"
        ? `issues unwatch ${issue}`
        : `issues note ${issue}`;
  return `${id} is a ledger obligation, projected read-only from the issue ledger; use \`${command}\` instead`;
}
