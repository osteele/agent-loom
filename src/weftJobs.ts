/** Unprocessed weft job counts, cached for the status line.
 *
 * Claude Code cancels a status-line script that exceeds roughly 300ms, and a
 * cancelled script drops the whole line rather than one field, so a subprocess
 * can never happen on the read path. The daemon runs the query on a slow
 * cadence and publishes counts; the status line reads the file.
 *
 * The margin is no longer the reason it started out being. The original query,
 * `weft list jobs --unprocessed`, was a full table scan measured at a 3.6s
 * median under 1-minute load 11. The grouped surface that replaced it
 * aggregates in SQL and runs in 40-60ms idle — roughly seventy times cheaper,
 * and comfortably inside the budget on a quiet machine. What keeps the cache is
 * that this machine is routinely not quiet: it reaches load 100 with sixty-odd
 * sessions, and spawning a Go binary there is unpredictable in a way a file
 * read is not. Do not remove the cache on the strength of the idle number.
 *
 * The same two invariants as `presence.ts`, for the same reasons:
 *
 * - **A presentation cache, never a routing input.** These counts are stale by
 *   construction. Nothing that decides delivery or coordination may read them.
 * - **Raw counts, never derived text.** The file holds a count per submitter
 *   session id and nothing that depends on config, so the refresh needs no
 *   SIGHUP coupling.
 *
 * Readers degrade to showing nothing. A missing, malformed, or stale snapshot
 * never falls back to running weft inline, which would reintroduce the very
 * latency this exists to avoid.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  STATE_DIR,
  WEFT_JOBS_SNAPSHOT_PATH,
  canonicalProject,
} from "./paths.ts";

/** Action-uniform disposition, cut on observables rather than on weft's attempt
 * status. The attempt marking drifts — the same runner recorded the same
 * situation as `completed` and `failed` over the same period — so only the exit
 * code and the presence of an exact forensic reason are load-bearing. */
export const WEFT_DISPOSITIONS = [
  "completed_ok",
  "completed_error",
  "infra_suspected",
  "dead",
] as const;

/** One (project, submitter session) bucket from weft's grouped inbox.
 *
 * Both nullable fields carry meaning and neither may be dropped. A null
 * `projectRoot` is a job whose owning project weft could not derive truthfully;
 * `unattributedSession` marks a bucket weft has no submitter for. They are
 * handled in OPPOSITE directions — see `orphansForProject`. */
export interface WeftJobGroup {
  projectRoot: string | null;
  project: string;
  submitterSession: string | null;
  unattributedSession: boolean;
  dispositions: Record<string, number>;
  total: number;
}

export interface WeftJobsSnapshot {
  version: 2;
  /** Epoch ms the query ran. In-band rather than the file's mtime, which a
   * backup restore or `cp -p` destroys and a torn write refreshes. */
  generatedAt: number;
  /** Writing process's pid, for explaining a stale file. */
  generatedBy: number;
  /** Unprocessed jobs per submitter session id. The empty-string key holds
   * jobs weft could not attribute to a session, which is a normal value and
   * not an error. */
  bySession: Record<string, number>;
  total: number;
  /** Per (project, session) buckets. Raw, exactly as weft grouped them: the
   * liveness join is a read-time decision and must not be baked in here, or
   * the cache becomes a routing input that freezes a liveness verdict. */
  groups: WeftJobGroup[];
}

const SNAPSHOT_VERSION = 2;

/** How often the daemon refreshes. Deliberately far slower than the daemon's
 * 10s tick: a multi-second subprocess every 10 seconds is a background job
 * that occupies a core on a machine that already reaches load 100. */
export const WEFT_JOBS_REFRESH_MS = 60_000;

/** Three refresh intervals, matching how `presence.ts` sizes its own TTL
 * against its tick: one missed refresh is tolerated, a stopped daemon is not. */
export const WEFT_JOBS_SNAPSHOT_TTL_MS = 3 * WEFT_JOBS_REFRESH_MS;

/** Publish a snapshot. Temp file plus rename, so a reader on a latency budget
 * never parses a half-written file. */
export function writeWeftJobsSnapshot(
  counts: {
    bySession: Record<string, number>;
    total: number;
    groups?: WeftJobGroup[];
  },
  nowMs = Date.now(),
  path = WEFT_JOBS_SNAPSHOT_PATH,
): WeftJobsSnapshot {
  const snapshot: WeftJobsSnapshot = {
    version: SNAPSHOT_VERSION,
    generatedAt: nowMs,
    generatedBy: process.pid,
    bySession: counts.bySession,
    total: counts.total,
    groups: counts.groups ?? [],
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 1));
  renameSync(tmp, path);
  return snapshot;
}

/** The snapshot if it exists, parses, matches the version, and is younger than
 * `maxAgeMs`. Never throws: a status line that crashes is worse than one that
 * shows one fewer field. */
export function readWeftJobsSnapshot(
  nowMs = Date.now(),
  maxAgeMs = WEFT_JOBS_SNAPSHOT_TTL_MS,
  path = WEFT_JOBS_SNAPSHOT_PATH,
): WeftJobsSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined; // missing or unparseable
  }
  const snapshot = parsed as Partial<WeftJobsSnapshot>;
  if (snapshot.version !== SNAPSHOT_VERSION) return undefined;
  if (typeof snapshot.generatedAt !== "number") return undefined;
  if (!Number.isFinite(snapshot.generatedAt)) return undefined;
  if (typeof snapshot.total !== "number") return undefined;
  if (!Number.isSafeInteger(snapshot.total) || snapshot.total < 0)
    return undefined;
  if (typeof snapshot.bySession !== "object" || snapshot.bySession === null) {
    return undefined;
  }
  if (!Array.isArray(snapshot.groups)) return undefined;
  if (
    Object.values(snapshot.bySession).some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    ) ||
    snapshot.groups.some(
      (group) =>
        !group ||
        !(
          group.projectRoot === null ||
          (typeof group.projectRoot === "string" &&
            isAbsolute(group.projectRoot))
        ) ||
        !(
          group.submitterSession === null ||
          typeof group.submitterSession === "string"
        ) ||
        typeof group.unattributedSession !== "boolean" ||
        !Number.isSafeInteger(group.total) ||
        group.total < 0,
    )
  )
    return undefined;
  if (nowMs - snapshot.generatedAt > maxAgeMs) return undefined;
  return snapshot as WeftJobsSnapshot;
}

/** Unprocessed jobs submitted by one session, or undefined when there is no
 * usable snapshot.
 *
 * Undefined and 0 are different answers and the status line renders them
 * differently: 0 means weft was asked and this session has nothing pending,
 * undefined means nobody knows. Collapsing them would let a stopped daemon
 * report an all-clear. */
export function weftJobsForSession(
  sessionId: string | undefined,
  nowMs = Date.now(),
  path = WEFT_JOBS_SNAPSHOT_PATH,
): number | undefined {
  if (!sessionId) return undefined;
  const snapshot = readWeftJobsSnapshot(nowMs, WEFT_JOBS_SNAPSHOT_TTL_MS, path);
  if (!snapshot) return undefined;
  return snapshot.bySession[sessionId] ?? 0;
}

/** Project attribution comes from Weft's stored root, never its display label. */
export function unprocessedForProjectSession(
  snapshot: WeftJobsSnapshot | undefined,
  project: string,
  sessionId: string,
): number | null {
  if (!snapshot) return null;
  let count = 0;
  for (const group of snapshot.groups) {
    if (group.submitterSession !== sessionId || group.unattributedSession)
      continue;
    if (group.projectRoot === null) return null;
    if (canonicalProject(group.projectRoot) === project) count += group.total;
  }
  return count;
}

export interface RunningJobGroup {
  projectRoot: string | null;
  submitterSession: string;
  count: number;
}

export interface RunningJobsSnapshot {
  version: 1;
  generatedAt: number;
  groups: RunningJobGroup[];
}

export const WEFT_RUNNING_SNAPSHOT_PATH = join(STATE_DIR, "weft-running.json");
export const WEFT_RUNNING_ARGS = [
  "list",
  "jobs",
  "--running",
  "--all",
  "--all-hosts",
  "--limit",
  "0",
  "--no-sync",
  "--format",
  "json",
  "--columns",
  "id,status_code,submitter_session,project_root",
];

/** A complete, versioned query is necessary to distinguish no jobs from no data. */
export function parseRunningJobs(raw: unknown): RunningJobGroup[] | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const doc = raw as Record<string, unknown>;
  const selection = doc.selection as Record<string, unknown> | undefined;
  if (
    doc.kind !== "job_list" ||
    doc.version !== 1 ||
    selection?.complete !== true ||
    !Array.isArray(selection.constraints) ||
    selection.constraints.length !== 0 ||
    !Array.isArray(doc.jobs)
  )
    return undefined;
  const groups = new Map<string, RunningJobGroup>();
  const ids = new Set<number>();
  for (const row of doc.jobs) {
    if (
      typeof row !== "object" ||
      row === null ||
      !Number.isSafeInteger(row.id) ||
      row.id <= 0 ||
      ids.has(row.id) ||
      row.status_code !== "running" ||
      typeof row.submitter_session !== "string" ||
      !(
        row.project_root === null ||
        (typeof row.project_root === "string" && isAbsolute(row.project_root))
      )
    )
      return undefined;
    ids.add(row.id);
    const key = JSON.stringify([row.project_root, row.submitter_session]);
    const group = groups.get(key) ?? {
      projectRoot: row.project_root,
      submitterSession: row.submitter_session,
      count: 0,
    };
    group.count++;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function writeRunningJobsSnapshot(
  groups: RunningJobGroup[],
  nowMs = Date.now(),
  path = WEFT_RUNNING_SNAPSHOT_PATH,
): void {
  const snapshot: RunningJobsSnapshot = {
    version: 1,
    generatedAt: nowMs,
    groups,
  };
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(snapshot));
  renameSync(temporary, path);
}

export function readRunningJobsSnapshot(
  nowMs = Date.now(),
  path = WEFT_RUNNING_SNAPSHOT_PATH,
): RunningJobsSnapshot | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as RunningJobsSnapshot;
    if (
      value.version !== 1 ||
      !Number.isFinite(value.generatedAt) ||
      nowMs < value.generatedAt ||
      nowMs - value.generatedAt > WEFT_JOBS_SNAPSHOT_TTL_MS ||
      !Array.isArray(value.groups) ||
      value.groups.some(
        (group) =>
          !group ||
          !(
            group.projectRoot === null ||
            (typeof group.projectRoot === "string" &&
              isAbsolute(group.projectRoot))
          ) ||
          typeof group.submitterSession !== "string" ||
          !Number.isSafeInteger(group.count) ||
          group.count < 0,
      )
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function runningForProjectSession(
  snapshot: RunningJobsSnapshot | undefined,
  project: string,
  sessionId: string,
): number | null {
  if (!snapshot) return null;
  let count = 0;
  for (const group of snapshot.groups) {
    if (group.submitterSession !== sessionId) continue;
    // A job with an unknown root may belong to this project: zero would be a guess.
    if (group.projectRoot === null) return null;
    if (canonicalProject(group.projectRoot) === project) count += group.count;
  }
  return count;
}

/** Parse weft's grouped inbox document (`kind: unprocessed_groups`).
 *
 * Refuses anything unrecognized rather than parsing optimistically. A renamed
 * field or a new shape must fail here, where the daemon logs it, instead of
 * yielding a smaller count — an undercount in this feature reads as good news
 * and is the one error nobody would investigate.
 *
 * The `all_sessions` scope check is load-bearing, not defensive. The ungrouped
 * form of this command scopes to the CALLING session implicitly, so a document
 * that ever arrived caller-scoped would describe one session's jobs as though
 * they were every session's, and the orphan count would be silently wrong. */
export function parseUnprocessedGroups(
  raw: unknown,
): WeftJobGroup[] | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const doc = raw as Record<string, unknown>;
  if (doc.kind !== "unprocessed_groups") return undefined;
  if (doc.version !== 1) return undefined;
  const scope = doc.scope as Record<string, unknown> | null | undefined;
  if (!scope || scope.state !== "all_sessions") return undefined;
  if (!Array.isArray(doc.groups)) return undefined;
  const out: WeftJobGroup[] = [];
  for (const entry of doc.groups) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const group = entry as Record<string, unknown>;
    if (
      !(
        group.project_root === null ||
        (typeof group.project_root === "string" &&
          isAbsolute(group.project_root))
      ) ||
      !(
        group.submitter_session === null ||
        typeof group.submitter_session === "string"
      ) ||
      typeof group.unattributed_session !== "boolean" ||
      typeof group.project !== "string" ||
      typeof group.total !== "number" ||
      !Number.isSafeInteger(group.total) ||
      group.total < 0
    )
      return undefined;
    const raw_dispositions = group.dispositions;
    if (typeof raw_dispositions !== "object" || raw_dispositions === null) {
      return undefined;
    }
    const dispositions: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw_dispositions)) {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
      )
        return undefined;
      dispositions[key] = value;
    }
    out.push({
      projectRoot:
        typeof group.project_root === "string" ? group.project_root : null,
      project: typeof group.project === "string" ? group.project : "",
      submitterSession:
        typeof group.submitter_session === "string"
          ? group.submitter_session
          : null,
      unattributedSession: group.unattributed_session === true,
      dispositions,
      total: group.total,
    });
  }
  return out;
}

export interface OrphanCounts {
  dispositions: Record<string, number>;
  total: number;
}

/** Unprocessed jobs owned by `project` whose submitter is not live anywhere.
 *
 * The two nullable fields invert, and this is the part that must not later be
 * "unified" into consistent null handling:
 *
 * - `unattributedSession` → **orphaned**. A missing owner is the evidence of
 *   having no owner; unattributable and unowned are the same state.
 * - `projectRoot === null` → **excluded from every project**. A missing project
 *   is absence of evidence about membership, and counting it under P would
 *   invent the one fact the announcement asserts.
 *
 * Liveness is "live anywhere", not "live in this project": a submitter alive
 * elsewhere still receives its own notice, so counting it again here would
 * double-report it.
 *
 * `knownSession` is required rather than optional on purpose: defaulting it to
 * "everything is known" silently restores the over-report it exists to stop.
 *
 * `projectRoot` is canonicalized at read time. weft canonicalizes at submit,
 * which does not survive the project being moved or reached through a different
 * symlink afterwards — this repo has carried live entries under two spellings
 * of its own path. */
export function orphansForProject(
  project: string,
  liveSessionIds: ReadonlySet<string>,
  groups: readonly WeftJobGroup[],
  knownSession: (sessionId: string) => boolean,
): OrphanCounts {
  const target = canonicalProject(project);
  const dispositions: Record<string, number> = {};
  let total = 0;
  for (const group of groups) {
    if (group.projectRoot === null) continue;
    if (canonicalProject(group.projectRoot) !== target) continue;
    const submitter = group.submitterSession;
    if (!group.unattributedSession && submitter !== null) {
      if (liveSessionIds.has(submitter)) continue; // owned
      // A submitter agent-loom has never registered is unknown ownership, not
      // an absent owner — the third form of the same asymmetry. Codex spawns
      // its MCP child without a session env var, so that child mints an id no
      // sibling can learn while weft records the shell's own id; the two never
      // meet. Counting those as orphans would mark every such job unowned.
      if (!knownSession(submitter)) continue;
    }
    for (const [key, value] of Object.entries(group.dispositions)) {
      if (value <= 0) continue;
      dispositions[key] = (dispositions[key] ?? 0) + value;
      total += value;
    }
  }
  return { dispositions, total };
}

const DISPOSITION_ACTIONS: Record<string, string> = {
  completed_ok: "process the results",
  completed_error: "read the program's output",
  infra_suspected: "check weft or the host",
  dead: "weft concluded the job is gone",
};

/** One sentence for the startup announcement, or "" when there is nothing to
 * say. Every line names its own next action: a single merged integer is what
 * made the advisory this replaces unreadable, since a count spanning "process
 * results" and "investigate a failure" cannot tell anyone what to do.
 *
 * An unrecognized disposition is shown rather than dropped — weft may add one,
 * and silently omitting it would undercount. */
export function startupOrphanText(orphans: OrphanCounts): string {
  if (orphans.total <= 0) return "";
  const known: readonly string[] = WEFT_DISPOSITIONS;
  const rank = (key: string) => {
    const index = known.indexOf(key);
    return index < 0 ? known.length : index;
  };
  const parts = Object.keys(orphans.dispositions)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((key) => {
      const action =
        DISPOSITION_ACTIONS[key] ?? "unrecognized disposition, inspect in weft";
      return `${orphans.dispositions[key]} ${key} (${action})`;
    });
  const plural = orphans.total === 1 ? "job" : "jobs";
  return `Weft orphans: ${orphans.total} unprocessed ${plural} in this project have no live submitter — ${parts.join("; ")}.`;
}
