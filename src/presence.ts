/** Low-latency presence reads.
 *
 * The only expensive part of `listLive()` is the process scan that verifies
 * each registration's pid still belongs to the process that registered it.
 * Everything downstream — parsing the registry, reading Claude's session meta,
 * deriving names — is sub-millisecond. So this caches the scan, not the render:
 * the daemon periodically writes the pid-verified live set, and readers on a
 * latency budget use that instead of scanning processes themselves.
 *
 * Two invariants keep the cache honest:
 *
 * - **It is a presentation cache, never a routing input.** A snapshot freezes a
 *   liveness verdict for its TTL, so a session that just exited can still
 *   appear. `send_mail`, `list_sessions`, and both dashboards keep calling
 *   `listLive()` directly; only decorative surfaces read from here.
 * - **It stores raw registrations, never derived text.** Nothing in the file
 *   depends on config, which is why the daemon tick needs no SIGHUP coupling.
 *   If it ever starts carrying names or aliases, that changes.
 *
 * Readers degrade rather than fail: a missing, malformed, or stale snapshot
 * falls back to a project-scoped scan, so this works with the daemon stopped.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PRESENCE_SNAPSHOT_PATH, canonicalProject } from "./paths.ts";
import {
  type Registration,
  coalesceRegistrations,
  listLive,
  listLiveInProject,
  scanParentPids,
} from "./registry.ts";
import {
  type ClaudeSessionMeta,
  isStaleSession,
  lastActivityMs,
  sessionDisplayName,
} from "./sessions.ts";

export interface PresenceSnapshot {
  version: 1;
  /** Epoch ms the scan ran. In-band rather than the file's mtime: mtime is
   * destroyed by backup restores and `cp -p`, and a torn write carries a fresh
   * one, so it is exactly wrong as a freshness signal. */
  generatedAt: number;
  /** Writing daemon's pid — provenance when a stale file needs explaining. */
  generatedBy: number;
  sessions: Registration[];
}

/** Non-mutating view exposed by `agent-loom listeners --no-sync --json`.
 *
 * `fresh: false` deliberately carries no sessions. Consumers that use this
 * for advisory routing must fail closed rather than treating an old process
 * verdict as proof that a recipient can still receive a message. */
export interface ListenerSnapshot {
  version: 1;
  source: "presence-snapshot";
  fresh: boolean;
  generatedAt: number | null;
  sessions: Registration[];
}

const SNAPSHOT_VERSION = 1;

/** Three times the daemon's 10s tick: tolerates a missed beat without letting
 * a dead session linger long enough to matter on a decorative surface. */
export const PRESENCE_SNAPSHOT_TTL_MS = 30_000;

/** Recompute the live set and publish it. Daemon-only writer.
 *
 * Published via temp file + rename so a reader never sees a half-written file.
 * (The registry itself deliberately does not do this — `listLive` prunes
 * whatever fails to parse — but a pruning reader and a caching reader want
 * opposite failure modes.) */
export function writePresenceSnapshot(
  nowMs = Date.now(),
  path = PRESENCE_SNAPSHOT_PATH,
  sessions?: Registration[],
): PresenceSnapshot {
  const snapshot: PresenceSnapshot = {
    version: SNAPSHOT_VERSION,
    generatedAt: nowMs,
    generatedBy: process.pid,
    sessions: sessions ?? listLive(),
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 1));
  renameSync(tmp, path);
  return snapshot;
}

/** The snapshot if it exists, parses, matches the current version, and is
 * younger than `maxAgeMs`; otherwise undefined. Never throws — a status line
 * that crashes is worse than one that falls back. */
export function readPresenceSnapshot(
  nowMs = Date.now(),
  maxAgeMs = PRESENCE_SNAPSHOT_TTL_MS,
  path = PRESENCE_SNAPSHOT_PATH,
): PresenceSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined; // missing or unparseable
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const snapshot = parsed as Partial<PresenceSnapshot>;
  if (snapshot.version !== SNAPSHOT_VERSION) return undefined;
  if (!Array.isArray(snapshot.sessions)) return undefined;
  if (typeof snapshot.generatedAt !== "number") return undefined;
  if (!Number.isFinite(snapshot.generatedAt)) return undefined;
  if (nowMs - snapshot.generatedAt > maxAgeMs) return undefined;
  return snapshot as PresenceSnapshot;
}

/** Read the daemon's fresh presence snapshot without scanning processes,
 * pruning registry files, or falling back to another source. */
export function readListenerSnapshot(
  project?: string,
  nowMs = Date.now(),
  path = PRESENCE_SNAPSHOT_PATH,
): ListenerSnapshot {
  const snapshot = readPresenceSnapshot(nowMs, PRESENCE_SNAPSHOT_TTL_MS, path);
  const canon = project ? canonicalProject(project) : undefined;
  return {
    version: 1,
    source: "presence-snapshot",
    fresh: snapshot !== undefined,
    generatedAt: snapshot?.generatedAt ?? null,
    sessions:
      snapshot?.sessions.filter(
        (registration) =>
          registration !== null &&
          typeof registration === "object" &&
          typeof registration.cwd === "string" &&
          isAbsolute(registration.cwd) &&
          !registration.cwd.includes("\0") &&
          (canon === undefined || canonicalProject(registration.cwd) === canon),
      ) ?? [],
  };
}

/** Live registrations sharing `project`, from a fresh snapshot when there is
 * one and a project-scoped scan otherwise.
 *
 * The fallback must stay project-scoped. A global `listLive()` here would run
 * inside the status-line script, and Claude Code cancels a status-line command
 * when the next update arrives — a cancelled script drops the whole line, not
 * just this field. */
export function liveInProject(
  project: string,
  nowMs = Date.now(),
): Registration[] {
  const canon = canonicalProject(project);
  const snapshot = readPresenceSnapshot(nowMs);
  if (!snapshot) return listLiveInProject(canon);
  // Snapshot entries are raw registrations, so they carry the same pre-move cwd
  // spellings the registry does; canonicalize here too.
  return snapshot.sessions.filter((r) => canonicalProject(r.cwd) === canon);
}

export interface SelfResolution {
  /** Live, non-stale sessions in the project. */
  present: Registration[];
  /** This session's own registration, when it could be identified. */
  self: Registration | undefined;
}

/** Which of `sessions` is the caller — the one question the status line and the
 * peer count both have to answer, and used to answer separately.
 *
 * The subtlety is that a session has two identities that can drift apart.
 * Claude Code injects `CLAUDE_CODE_SESSION_ID` into an MCP server's spawn
 * environment and never updates it, but mints a *new* session id on `/clear`
 * without respawning MCP servers. From then on the channel server is registered
 * under the old id while the status-line payload carries the new one, and they
 * never reconcile on their own.
 *
 * That matters beyond cosmetics: a session's full name IS its address, derived
 * from whichever id you feed it. Naming the payload id invents an identity that
 * exists in the name store and in no routing table — peers asked to deliver to
 * it correctly report that no such session exists. So identity is resolved
 * once, here, and both surfaces consume the result.
 *
 * `hostPids` are the caller's process ancestors (see `hostAncestorPids`). The
 * status-line process and the channel server are both children of the same host
 * agent process, so a registration whose `parentPid` is among them is ours even
 * when the session ids disagree. Pure: no filesystem, no clock. */
export function resolveSelf(
  sessions: Registration[],
  sessionId: string | undefined,
  meta: Map<string, ClaudeSessionMeta>,
  nowMs: number,
  hostPids: readonly number[] = [],
): SelfResolution {
  const present = sessions.filter((r) => {
    const m = r.sessionId ? meta.get(r.sessionId) : undefined;
    return !isStaleSession(m?.status, lastActivityMs(r, m), nowMs);
  });
  const byId = sessionId
    ? present.find((r) => r.sessionId === sessionId)
    : undefined;
  if (byId) return { present, self: byId };
  if (hostPids.length > 0) {
    const hosts = new Set(hostPids);
    const shared = present.filter(
      (r) => r.parentPid !== undefined && hosts.has(r.parentPid),
    );
    // Exactly one, or this is not an identification. Two registrations under one
    // host pid would mean guessing, and guessing an address is the bug.
    if (shared.length === 1) return { present, self: shared[0] };
  }
  return { present, self: undefined };
}

/** Live, non-stale sessions other than the caller, from a set already scoped to
 * one project. Pure: no filesystem, no clock. */
export function peersInProject(
  sessions: Registration[],
  sessionId: string | undefined,
  meta: Map<string, ClaudeSessionMeta>,
  nowMs: number,
  hostPids: readonly number[] = [],
): Registration[] {
  const { present, self } = resolveSelf(
    sessions,
    sessionId,
    meta,
    nowMs,
    hostPids,
  );
  if (self) {
    return coalesceRegistrations(
      present.filter((r) =>
        self.sessionId ? r.sessionId !== self.sessionId : r !== self,
      ),
    );
  }
  // Unidentified: assume one of these entries is us and discount it, so the
  // count stays right even when the name cannot be recovered.
  const logical = coalesceRegistrations(present);
  return logical.slice(0, Math.max(0, logical.length - 1));
}

/** The session's display name, whether or not anyone shares the project.
 *
 * This used to be gated on having a peer, on the theory that a name earns its
 * width only when it disambiguates. That was wrong about what the name is for:
 * agents in *other* projects address this session by this name, so it is the
 * session's identity even when it is alone in its own directory, and a name
 * that appears and disappears as peers come and go is worse than one that is
 * simply always there. Peer count is a separate, independently useful fact —
 * see `peersInProject`. Pure: no filesystem, no clock. */
export function statusLineName(
  project: string,
  sessionId: string | undefined,
  meta: Map<string, ClaudeSessionMeta>,
  sessions: Registration[] = [],
  hostPids: readonly number[] = [],
  nowMs = Date.now(),
): string {
  const address = sessionAddress(sessions, sessionId, meta, nowMs, hostPids);
  if (!address) return "";
  return sessionDisplayName(address, meta.get(address), project);
}

/** The session id other agents can actually route to, which is the one its
 * channel server registered under — not necessarily the one the host reports
 * now. Everything the status line shows about "this session" (its name, its
 * unread count, its pending jobs) keys off this, so a rotated id cannot make a
 * surface describe a session nobody can reach.
 *
 * Undefined whenever no registration can be identified as the caller's,
 * including when the project has no registrations at all. The host's own id is
 * never a fallback: an id with no channel server behind it is exactly the
 * address peers reject with "no live recipient", and a status line that
 * renders it tells the user the session is reachable when it is not. Pure: no
 * filesystem. */
/** Why `resolveSelf` found no registration for this caller:
 * - `unregistered` — nothing matches by session id or host pid.
 * - `stale`        — something matches, but every match is past the staleness
 *                    threshold, so it is not counted as present.
 * - `ambiguous`    — several present registrations share the host pid. */
export type UnaddressedCause = "unregistered" | "stale" | "ambiguous";

/** Classify a failed `resolveSelf` with the same `present` filter it applied,
 * so a diagnosis cannot name a cause the resolver did not act on. Meaningful
 * only when `resolveSelf(...).self` is undefined. */
export function unaddressedCause(
  sessions: Registration[],
  sessionId: string | undefined,
  meta: Map<string, ClaudeSessionMeta>,
  nowMs: number,
  hostPids: readonly number[] = [],
): UnaddressedCause {
  const { present } = resolveSelf(sessions, sessionId, meta, nowMs, hostPids);
  const hosts = new Set(hostPids);
  const mine = (r: Registration) =>
    (sessionId !== undefined && r.sessionId === sessionId) ||
    (r.parentPid !== undefined && hosts.has(r.parentPid));
  if (present.filter(mine).length > 1) return "ambiguous";
  if (sessions.some(mine)) return "stale";
  return "unregistered";
}

export function sessionAddress(
  sessions: Registration[],
  sessionId: string | undefined,
  meta: Map<string, ClaudeSessionMeta>,
  nowMs: number,
  hostPids: readonly number[] = [],
): string | undefined {
  return resolveSelf(sessions, sessionId, meta, nowMs, hostPids).self
    ?.sessionId;
}

/** How far up the process tree to look for the host agent. The status-line
 * command runs as `claude -> sh -> agent-loom` today; the slack allows for a
 * wrapper or two without inviting a walk to pid 1. */
const HOST_ANCESTOR_DEPTH = 4;

/** This process's ancestor pids, nearest first.
 *
 * Impure and the only process inspection on the status-line path, so it stays
 * bounded: at most `HOST_ANCESTOR_DEPTH` single-pid `ps` queries (~4ms each on
 * Darwin). Returns what it has if the walk is cut short — a partial chain still
 * identifies the host in the common case, and `resolveSelf` treats an empty one
 * as simply having no ancestry evidence. */
export function hostAncestorPids(
  startPid: number = process.ppid,
  depth = HOST_ANCESTOR_DEPTH,
): number[] {
  const chain: number[] = [];
  let pid = startPid;
  for (let i = 0; i < depth; i++) {
    if (!Number.isInteger(pid) || pid <= 1) break;
    chain.push(pid);
    const parent = scanParentPids([pid]).get(pid);
    if (parent === undefined) break;
    pid = parent;
  }
  return chain;
}
