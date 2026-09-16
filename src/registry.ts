/** Registry of live channel servers: which sessions are listening, where. */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ChannelPushStatus } from "./channelIdentity.ts";
import {
  REGISTRY_DIR,
  canonicalProject,
  ensureDirs,
  projectSlug,
} from "./paths.ts";
import { sleepSync } from "./runtime.ts";
import {
  type GeneratedSessionName,
  assignedGeneratedSessionName,
  hasSeenSession,
} from "./sessions.ts";

export interface Registration {
  cwd: string;
  pid: number; // channel-server process; dies with the host session
  procStart?: string; // `ps lstart` of that process at register time — a pid
  // alone is not an identity (pids are recycled; a dead session once read as
  // live for 10 days because a system daemon had inherited its pid)
  instanceId?: string; // random identity of this channel process; distinguishes
  // restarts even when process inspection is temporarily unavailable
  parentPid?: number; // host agent process that spawned this channel server
  // (Claude Code, Codex, ...). Recorded because `sessionId` is frozen at spawn
  // while Claude's live session id rotates on `/clear` — the host pid is then
  // the only thing tying this registration to the terminal the user is looking
  // at. See `resolveSelf` in presence.ts.

  sessionId?: string; // host session id (Claude Code's; a random uuid under Codex)
  name?: string; // session name snapshot at register time; NOT used for display
  // (may be stale on rename, or a legacy synthetic id) — display re-derives from
  // the live Claude name or a pronounceable alias off the session id

  client?: string; // host client from MCP clientInfo: "claude-code", "codex", ...
  capabilities?: SessionCapabilities;
  muted?: boolean; // channel push paused; messages still spool and flush on unmute
  inboundPolicy?: InboundPolicy;
  lastSeen?: string; // ISO 8601; stamped on each tool call the session makes
  lastInboxPoll?: string; // ISO 8601; check_inbox specifically, not generic activity
  started: string; // ISO 8601
}

export type InboundPolicy = "accept" | "hold" | "refuse";

export interface SessionCapabilities {
  tools: boolean;
  inboxPoll: boolean;
  channelPush: boolean;
  claims: boolean;
  workLeases: boolean;
  receipts: boolean;
  nativePeerMessaging: boolean;
  /** Whether this session's pushes can reach the host, from
   * `diagnoseChannelPush` at startup.
   *
   * `channelPush` says this server will emit a notification; this says whether
   * anything can receive it. They diverged silently for days: mail spooled, a
   * `pushed` receipt was written, and nothing reached the session, because the
   * host had loaded no agent-mail channel. `"unknown"` means process inspection
   * was unavailable — never read it as a failure. */
  channelPushStatus?: ChannelPushStatus;
}

function mergedCapabilities(
  registrations: Registration[],
): SessionCapabilities | undefined {
  const capabilities = registrations
    .map((registration) => registration.capabilities)
    .filter((value): value is SessionCapabilities => value !== undefined);
  if (capabilities.length === 0) return undefined;
  const channelStatus = capabilities
    .filter((value) => value.channelPush)
    .map((value) => value.channelPushStatus)
    .find((value) => value !== undefined);
  return {
    tools: capabilities.some((value) => value.tools),
    inboxPoll: capabilities.some((value) => value.inboxPoll),
    channelPush: capabilities.some((value) => value.channelPush),
    claims: capabilities.some((value) => value.claims),
    workLeases: capabilities.some((value) => value.workLeases),
    receipts: capabilities.some((value) => value.receipts),
    nativePeerMessaging: capabilities.some(
      (value) => value.nativePeerMessaging,
    ),
    ...(channelStatus ? { channelPushStatus: channelStatus } : {}),
  };
}

function latestTimestamp(values: (string | undefined)[]): string | undefined {
  return values
    .filter((value): value is string => value !== undefined)
    .sort()
    .at(-1);
}

/** Collapse exact (project, session-id) matches into one logical session.
 *
 * A harness can expose separate MCP and push components under the same routing
 * id. Their registry entries retain separate process identities for liveness
 * and cleanup, while routing and presentation must count one agent and combine
 * its capabilities. Entries without a session id remain process-scoped. */
export function coalesceRegistrations(
  registrations: Registration[],
): Registration[] {
  const groups = new Map<string, Registration[]>();
  for (const registration of registrations) {
    const key = registration.sessionId
      ? `${canonicalProject(registration.cwd)}\u0000${registration.sessionId}`
      : `${canonicalProject(registration.cwd)}\u0000pid:${registration.pid}`;
    const group = groups.get(key) ?? [];
    group.push(registration);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const primary =
      group.find((entry) => entry.capabilities?.channelPush) ??
      group.find((entry) => entry.capabilities?.tools) ??
      group[0];
    const inboundPolicy = group.some(
      (entry) => entry.inboundPolicy === "refuse",
    )
      ? "refuse"
      : group.some((entry) => entry.inboundPolicy === "hold")
        ? "hold"
        : "accept";
    const lastSeen = latestTimestamp(group.map((entry) => entry.lastSeen));
    const lastInboxPoll = latestTimestamp(
      group.map((entry) => entry.lastInboxPoll),
    );
    const parentPid =
      primary.parentPid ?? group.find((entry) => entry.parentPid)?.parentPid;
    const capabilities = mergedCapabilities(group);
    return {
      ...primary,
      cwd: canonicalProject(primary.cwd),
      ...(parentPid !== undefined ? { parentPid } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(group.some((entry) => entry.muted) ? { muted: true } : {}),
      inboundPolicy,
      ...(lastSeen ? { lastSeen } : {}),
      ...(lastInboxPoll ? { lastInboxPoll } : {}),
      started: group.map((entry) => entry.started).sort()[0],
    };
  });
}

/** Capability labels for one session, shared by every surface that renders
 * them. The predecessor of this function was copied into four renderers; only
 * one of them ever grew the degraded-channel branch, and it read a field
 * nothing wrote — so a session whose pushes went nowhere advertised a healthy
 * `{channel}` everywhere. One writer, one reader, no drift. */
export function capabilityLabels(capabilities: SessionCapabilities): string[] {
  return [
    capabilities.channelPush
      ? channelLabel(capabilities.channelPushStatus)
      : "poll",
    capabilities.nativePeerMessaging ? "native-peer" : undefined,
    capabilities.claims ? "claims" : undefined,
    capabilities.workLeases ? "work" : undefined,
    capabilities.receipts ? "receipts" : undefined,
  ].filter((label): label is string => label !== undefined);
}

/** `channel` when pushes are expected to land, `channel:<reason>` when they are
 * not. An unverifiable diagnosis renders as plain `channel`: it is the absence
 * of evidence, not evidence of breakage. */
function channelLabel(status?: ChannelPushStatus): string {
  return status === undefined || status === "authorized" || status === "unknown"
    ? "channel"
    : `channel:${status}`;
}

/** Whether this session is known to be unable to receive a channel push.
 *
 * Only an explicit degraded diagnosis counts. An absent or `"unknown"` status
 * is the absence of evidence — a session registered by a build that predates
 * the diagnosis carries no status at all — and a poll-only session was never
 * pushed to in the first place, so neither is a fault to report. Getting this
 * backwards would tell a sender that every long-running peer is unreachable,
 * which is the same overstatement as `pushed` in the other direction. */
export function pushIsKnownUnreachable(
  capabilities?: SessionCapabilities,
): boolean {
  if (!capabilities?.channelPush) return false;
  const status = capabilities.channelPushStatus;
  return status === "host-not-loaded" || status === "identity-unauthorized";
}

export interface ProcessInfo {
  start: string; // lstart tokens joined with single spaces
  command: string;
}

export interface ProcessScan {
  processes: Map<number, ProcessInfo>;
  reliable: boolean;
}

/** Parse one `ps -o pid=,lstart=,command=` output line. lstart is five tokens
 * ("Sat Aug  1 10:48:00 2026"); everything after is the command line. Exported
 * for tests. */
export function parsePsLine(
  line: string,
): { pid: number; info: ProcessInfo } | undefined {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 7) return undefined;
  const pid = Number(tokens[0]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return {
    pid,
    info: {
      start: tokens.slice(1, 6).join(" "),
      command: tokens.slice(6).join(" "),
    },
  };
}

/** How many pids are worth querying one at a time before one whole-table scan
 * is cheaper. 12 × ~4 ms ≈ the ~24 ms flat cost of `ps -ww -A`. */
const PS_LOOP_MAX = 12;
const PS_EXECUTABLE = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";

/** Inspect processes: start time + command per pid; a pid absent from the
 * result is not running.
 *
 * Never issue a multi-row `-p` query. macOS `ps` takes a slow path the moment
 * a `-p` query matches two or more processes — one matched row is ~4 ms, two
 * are ~260 ms, and that cost is flat in the number of pids asked for and
 * independent of the `-o` fields, while a whole-table `ps -A` is only ~24 ms
 * (measured on Darwin 24.6). So loop single-pid queries for small sets and take
 * one table scan for large ones. On Linux the batched form is fine and the loop
 * costs a few ms per pid, so this stays unconditional rather than platform-gated.
 *
 * `-ww` is load-bearing, not cosmetic: without it `ps` truncates the command
 * column, and `isCurrentProcess` falls back to matching that column for legacy
 * entries with no recorded `procStart` — truncation would silently prune a live
 * session.
 *
 * A single-pid query exits 1 when that pid is gone; other nonzero statuses,
 * spawn errors, and signals make the scan unreliable. Whole-table queries
 * require status 0 and at least one parseable process row. An unavailable or
 * nonconforming process inspector is not proof that every process is dead.
 *
 * Absence from a whole-table scan is likewise not proof. A truncated table, a
 * row this parser cannot read, or a process `ps` skipped all look identical to
 * an exited process, and the caller's response to "dead" is to delete a
 * registration — so each pid the table fails to account for is confirmed with
 * its own query before the verdict stands. In steady state every wanted pid
 * appears in the table and this costs nothing; it is paid only for pids that
 * really are gone, once, on the sweep that prunes them. */
export function scanProcesses(
  pids: number[],
  executable = PS_EXECUTABLE,
): ProcessScan {
  const map = new Map<number, ProcessInfo>();
  const wanted = new Set(pids);
  if (wanted.size === 0) return { processes: map, reliable: true };
  let reliable = true;

  const run = (
    query: string[],
  ): { ok: boolean; status: number | null; parsedAnyProcess: boolean } => {
    const res = spawnSync(
      executable,
      [...query, "-o", "pid=,lstart=,command="],
      { encoding: "utf8" },
    );
    const singlePid = query[1] === "-p";
    const ok =
      !res.error &&
      !res.signal &&
      (singlePid ? res.status === 0 || res.status === 1 : res.status === 0);
    let parsedAnyProcess = false;
    for (const line of (res.stdout ?? "").split("\n")) {
      const parsed = parsePsLine(line);
      if (!parsed) continue;
      parsedAnyProcess = true;
      if (wanted.has(parsed.pid)) map.set(parsed.pid, parsed.info);
    }
    return { ok, status: res.status, parsedAnyProcess };
  };

  /** Ask about one pid and record whether the answer can be trusted. `ps`
   * exits 0 only when it matched the process, so a status of 0 with no row we
   * could read means the parse failed rather than that the process exited. */
  const confirm = (pid: number): void => {
    const { ok, status } = run(["-ww", "-p", String(pid)]);
    if (!ok || (status === 0 && !map.has(pid))) reliable = false;
  };

  if (wanted.size <= PS_LOOP_MAX) {
    for (const pid of wanted) confirm(pid);
    return { processes: map, reliable };
  }

  const table = run(["-ww", "-A"]);
  if (!table.ok || !table.parsedAnyProcess) {
    return { processes: map, reliable: false };
  }
  for (const pid of wanted) if (!map.has(pid)) confirm(pid);
  return { processes: map, reliable };
}

/** Process map compatibility helper for presentation and tests. Liveness
 * decisions use `scanProcesses` so they retain the reliability verdict. */
/** One process's environment, as `ps` renders it, or "" when unreadable.
 *
 * Single-pid query, so it takes the fast `ps` path (see the note on
 * `scanProcesses` about multi-row `-p`). The result contains every variable the
 * process holds, including secrets — callers must extract what they need and
 * discard the rest rather than logging or storing it. */
export function processEnviron(pid: number): string {
  const res = spawnSync(
    "/bin/ps",
    ["eww", "-p", String(pid), "-o", "command="],
    { encoding: "utf8" },
  );
  if (res.error || res.signal || res.status !== 0) return "";
  return res.stdout ?? "";
}

/** One process's command line WITHOUT its environment, or "" when unreadable.
 *
 * Deliberately not `ps eww`: that appends the environment to the same column,
 * and a scan looking for an argument would then also be scanning API keys and
 * whatever else the environment holds. Two narrow reads beat one wide one. */
export function processCommand(pid: number): string {
  const res = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (res.error || res.signal || res.status !== 0) return "";
  return res.stdout ?? "";
}

/** One process's controlling terminal as a bare device name ("ttys047"), or
 * undefined when it has none — `ps` renders that as "??". An MCP server
 * inherits its host agent's terminal, so this identifies the terminal the
 * agent is running in. */
export function processTty(pid: number): string | undefined {
  const res = spawnSync("/bin/ps", ["-p", String(pid), "-o", "tty="], {
    encoding: "utf8",
  });
  if (res.error || res.signal || res.status !== 0) return undefined;
  const tty = (res.stdout ?? "").trim();
  if (!tty || tty === "??" || tty === "?") return undefined;
  return tty;
}

export function processInfo(pids: number[]): Map<number, ProcessInfo> {
  return scanProcesses(pids).processes;
}

function entryPath(cwd: string, pid: number): string {
  return join(REGISTRY_DIR, `${projectSlug(cwd)}-${pid}.json`);
}

/** Whether this channel process still has a registry entry. A listener checks
 * this cheaply on its existing one-second poll so a transient false prune does
 * not leave a live session invisible until the host restarts. */
export function registrationExists(cwd: string, pid: number): boolean {
  return existsSync(entryPath(cwd, pid));
}

/** Whether the stored entry still describes this process the way it would be
 * written today. False when it is missing, unreadable, or stale.
 *
 * Capabilities are derived from the host client, and a registration is only
 * written at startup — so an entry written by an older build keeps advertising
 * whatever that build believed forever. One did: an `oh-my-pi` session carried
 * `channelPush: true` long after the rule became "channel push exists only
 * under claude-code", so peers, the listener display, and every push receipt
 * treated a host with no channel as reachable. Staleness is not a missing
 * file, so an existence check cannot see it. */
export function registrationMatches(
  cwd: string,
  pid: number,
  client: string | undefined,
  capabilities: SessionCapabilities,
): boolean {
  const path = entryPath(cwd, pid);
  if (!existsSync(path)) return false;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as Registration;
    return (
      entry.client === client &&
      JSON.stringify(entry.capabilities) === JSON.stringify(capabilities)
    );
  } catch {
    return false;
  }
}

function withEntryLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let mtime: number;
      try {
        mtime = statSync(lock).mtimeMs;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - mtime > 30_000) {
        try {
          rmdirSync(lock);
        } catch (removeError) {
          if ((removeError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw removeError;
          }
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for registry lock ${path}`);
      }
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}

function writeEntry(path: string, entry: Registration): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(entry, null, 1), { flag: "wx" });
  try {
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function mutateEntry(
  path: string,
  mutate: (entry: Registration) => void,
): boolean {
  if (!existsSync(path)) return false;
  return withEntryLock(path, () => {
    if (!existsSync(path)) return false;
    let entry: Registration;
    try {
      entry = JSON.parse(readFileSync(path, "utf8")) as Registration;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
    mutate(entry);
    writeEntry(path, entry);
    return true;
  });
}

/** Apply session-level controls to every component registered under the exact
 * same project and routing id. This keeps an MCP component's policy in step
 * with a separate push component without weakening their process-level
 * liveness and cleanup records. */
function mutateLogicalSession(
  cwd: string,
  pid: number,
  mutate: (entry: Registration) => void,
): boolean {
  const project = canonicalProject(cwd);
  const entries = readEntries(
    (entry) => canonicalProject(entry.cwd) === project,
  );
  const own = entries.find((candidate) => candidate.entry.pid === pid);
  if (!own) return false;
  const paths = own.entry.sessionId
    ? entries
        .filter(
          (candidate) => candidate.entry.sessionId === own.entry.sessionId,
        )
        .map((candidate) => candidate.path)
    : [own.path];
  let changed = false;
  for (const path of paths) {
    changed = mutateEntry(path, mutate) || changed;
  }
  return changed;
}

/** Before assigning the new naming scheme, bank the syllable names of every
 * session already in the registry. Assignments are per session id and survive
 * unregister/restart; stale entries are included so an old session resumed
 * after the upgrade keeps the name its user already saw. */
function preserveRegisteredSessionNames(): void {
  for (const file of readdirSync(REGISTRY_DIR)) {
    if (!file.endsWith(".json")) continue;
    let entry: Registration;
    try {
      entry = JSON.parse(
        readFileSync(join(REGISTRY_DIR, file), "utf8"),
      ) as Registration;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // Corrupt registry entries are pruned by listLive; a concurrently
        // removed entry needs no migration.
        continue;
      }
      throw error;
    }
    if (entry.sessionId) assignedGeneratedSessionName(entry.sessionId, true);
  }
}

/** Mint a name while reserving every noun already represented in the registry.
 * Called before the channel can register itself, so naming and registration do
 * not have a race window in which an old current noun looks available. */
export function assignedGeneratedSessionNameForRegistration(
  sessionId: string,
): GeneratedSessionName {
  ensureDirs();
  if (hasSeenSession(sessionId)) return assignedGeneratedSessionName(sessionId);
  preserveRegisteredSessionNames();
  return assignedGeneratedSessionName(sessionId);
}

export function register(
  cwd: string,
  pid: number,
  sessionId?: string,
  name?: string,
  client?: string,
  capabilities?: SessionCapabilities,
  defaultInboundPolicy: InboundPolicy = "accept",
  knownProcStart?: string,
  knownInstanceId?: string,
  parentPid?: number,
): string {
  ensureDirs();
  if (sessionId) assignedGeneratedSessionNameForRegistration(sessionId);
  const path = entryPath(cwd, pid);
  const scan =
    knownProcStart || knownInstanceId ? undefined : scanProcesses([pid]);
  const procStart =
    knownProcStart ??
    (scan?.reliable ? scan.processes.get(pid)?.start : undefined);
  const sessionSibling = sessionId
    ? verifyLive(
        readEntries(
          (entry) =>
            entry.pid !== pid &&
            entry.sessionId === sessionId &&
            canonicalProject(entry.cwd) === canonicalProject(cwd),
        ),
        false,
      )[0]
    : undefined;
  withEntryLock(path, () => {
    let previous: Registration | undefined;
    if (existsSync(path)) {
      try {
        previous = JSON.parse(readFileSync(path, "utf8")) as Registration;
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
    const preserved =
      (knownInstanceId !== undefined &&
        previous?.instanceId === knownInstanceId) ||
      (procStart !== undefined && previous?.procStart === procStart)
        ? previous
        : undefined;
    const sessionState = preserved ?? sessionSibling;
    const inboundPolicy =
      sessionState &&
      (sessionState.inboundPolicy === "hold" ||
        sessionState.inboundPolicy === "refuse")
        ? sessionState.inboundPolicy
        : defaultInboundPolicy;
    const entry: Registration = {
      cwd,
      pid,
      ...(procStart ? { procStart } : {}),
      ...(knownInstanceId ? { instanceId: knownInstanceId } : {}),
      ...(parentPid !== undefined
        ? { parentPid }
        : preserved?.parentPid !== undefined
          ? { parentPid: preserved.parentPid }
          : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(name ? { name } : {}),
      ...(client ? { client } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(sessionState && typeof sessionState.muted === "boolean"
        ? { muted: sessionState.muted }
        : {}),
      inboundPolicy,
      ...(sessionState?.lastSeen ? { lastSeen: sessionState.lastSeen } : {}),
      ...(sessionState?.lastInboxPoll
        ? { lastInboxPoll: sessionState.lastInboxPoll }
        : {}),
      started:
        sessionState && typeof sessionState.started === "string"
          ? sessionState.started
          : new Date().toISOString(),
    };
    writeEntry(path, entry);
  });
  return path;
}

/** Set how one session handles new deliveries. Held messages remain in the
 * receipt log and are released when the policy returns to accept. */
export function setInboundPolicy(
  cwd: string,
  pid: number,
  policy: InboundPolicy,
): boolean {
  return mutateLogicalSession(cwd, pid, (entry) => {
    entry.inboundPolicy = policy;
  });
}

export function inboundPolicy(cwd: string, pid: number): InboundPolicy {
  const path = entryPath(cwd, pid);
  if (!existsSync(path)) return "accept";
  try {
    const policy = (JSON.parse(readFileSync(path, "utf8")) as Registration)
      .inboundPolicy;
    return policy === "hold" || policy === "refuse" ? policy : "accept";
  } catch {
    return "accept";
  }
}

/** Toggle a session's channel-push mute. Returns false if no entry exists (the
 * session isn't/no longer listening). */
export function setMuted(cwd: string, pid: number, muted: boolean): boolean {
  return mutateLogicalSession(cwd, pid, (entry) => {
    entry.muted = muted;
  });
}

/** Whether a session's channel push is muted. Fail-open (deliver) on a missing
 * or corrupt entry. */
export function isMuted(cwd: string, pid: number): boolean {
  const path = entryPath(cwd, pid);
  if (!existsSync(path)) return false;
  try {
    return (
      (JSON.parse(readFileSync(path, "utf8")) as Registration).muted === true
    );
  } catch {
    return false;
  }
}

/** Stamp a session's last-seen time (called on each tool call it serves).
 * No-op if the entry is missing or corrupt. */
export function touch(cwd: string, pid: number): void {
  mutateEntry(entryPath(cwd, pid), (entry) => {
    entry.lastSeen = new Date().toISOString();
  });
}

/** Stamp an explicit inbox check separately from generic MCP activity.
 * Poll-only clients cannot receive an alert, so recent `lastSeen` is not
 * evidence that they will discover newly spooled mail. */
export function touchInboxPoll(cwd: string, pid: number): void {
  mutateEntry(entryPath(cwd, pid), (entry) => {
    const now = new Date().toISOString();
    entry.lastSeen = now;
    entry.lastInboxPoll = now;
  });
}

/** Remove only the process instance the caller registered. */
export function unregister(cwd: string, pid: number, instanceId: string): void {
  const path = entryPath(cwd, pid);
  if (!existsSync(path)) return;
  withEntryLock(path, () => {
    if (!existsSync(path)) return;
    const entry = JSON.parse(readFileSync(path, "utf8")) as Registration;
    if (entry.instanceId === instanceId) rmSync(path);
  });
}

/** Whether the pid still belongs to the process that registered: same start
 * time when the entry recorded one, else (legacy entries) a command line that
 * looks like a channel server. A bare pid-exists check is not enough — recycled
 * pids otherwise keep dead entries alive indefinitely. */
/** A zombie is reported by `ps` with its original pid, its original start time
 * and a `<defunct>` command: the process has exited and its parent has not
 * reaped it. `procStart` matching is therefore not evidence that anything is
 * running, which is the same trap as bare `alive(pid)` one level down.
 *
 * Left as live, the registration outlives its session indefinitely — a parent
 * that is itself stopped never reaps, so the entry survives until the parent
 * dies. Peers are told to deliver to a process that can never poll, and each
 * reconnect adds another entry under the same parent, which is where
 * "duplicate listeners" came from. */
export function isDefunct(command: string): boolean {
  return command.includes("<defunct>");
}

export function isCurrentProcess(
  entry: Registration,
  info: ProcessInfo | undefined,
): boolean {
  if (!info) return false;
  if (isDefunct(info.command)) return false;
  if (entry.procStart) return entry.procStart === info.start;
  return /agent-mail|channel\.ts/.test(info.command);
}

/** Read and parse registry files, pruning any that no longer parse. `keep`
 * narrows the set before the process scan, which is the expensive step. */
function readEntries(
  keep?: (entry: Registration) => boolean,
): { path: string; entry: Registration }[] {
  ensureDirs();
  const entries: { path: string; entry: Registration }[] = [];
  for (const name of readdirSync(REGISTRY_DIR)) {
    if (!name.endsWith(".json")) continue;
    const path = join(REGISTRY_DIR, name);
    let entry: Registration;
    try {
      entry = JSON.parse(readFileSync(path, "utf8")) as Registration;
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      if (!existsSync(path)) continue;
      withEntryLock(path, () => {
        if (!existsSync(path)) return;
        try {
          JSON.parse(readFileSync(path, "utf8"));
        } catch (currentError) {
          if (currentError instanceof SyntaxError) rmSync(path);
          else if ((currentError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw currentError;
          }
        }
      });
      continue;
    }
    if (!keep || keep(entry)) entries.push({ path, entry });
  }
  return entries;
}

/** Keep the entries whose process is still the one that registered; prune the
 * rest. `bankLegacyNames` is upgrade bookkeeping and belongs only to the global
 * sweep — a scoped read stays a pure read. */
function verifyLive(
  entries: { path: string; entry: Registration }[],
  bankLegacyNames: boolean,
): Registration[] {
  const scan = scanProcesses(entries.map((e) => e.entry.pid));
  if (!scan.reliable) {
    for (const { entry } of entries) {
      if (bankLegacyNames && entry.sessionId) {
        assignedGeneratedSessionName(entry.sessionId, true);
      }
    }
    return entries.map(({ entry }) => entry);
  }
  const out: Registration[] = [];
  for (const { path, entry } of entries) {
    if (isCurrentProcess(entry, scan.processes.get(entry.pid))) {
      if (bankLegacyNames && entry.sessionId)
        assignedGeneratedSessionName(entry.sessionId, true);
      out.push(entry);
    } else {
      withEntryLock(path, () => {
        if (!existsSync(path)) return;
        const current = JSON.parse(readFileSync(path, "utf8")) as Registration;
        if (
          current.pid === entry.pid &&
          current.sessionId === entry.sessionId &&
          current.procStart === entry.procStart &&
          current.instanceId === entry.instanceId &&
          current.started === entry.started
        ) {
          rmSync(path);
        }
      });
    }
  }
  return out;
}

/** List live registrations, pruning entries whose process has exited or whose
 * pid has been recycled by an unrelated process. */
export function listLive(): Registration[] {
  return verifyLive(readEntries(), true);
}

/** Live registrations for one project. Same pruning semantics as `listLive`,
 * but only this project's entries are inspected — the difference between
 * scanning every registered process and scanning the handful that share a
 * directory, which matters to callers on a latency budget.
 *
 * Canonicalize at read time rather than trusting the stored `cwd`: entries
 * written before a directory move still carry the old spelling (this repo has
 * live entries under both `code/utils/agent-mail` and
 * `code/agent-tools/agent-mail`, one a symlink to the other), and comparing raw
 * strings silently splits one project in two. */
export function listLiveInProject(project: string): Registration[] {
  const canon = canonicalProject(project);
  return verifyLive(
    readEntries((entry) => canonicalProject(entry.cwd) === canon),
    false,
  );
}

/** Parent pid per requested pid. Separate from `scanProcesses` on purpose: that
 * one's `-o pid=,lstart=,command=` parse is position-sensitive (lstart is five
 * tokens), and threading a sixth field through it would put a well-tested
 * parser at risk for one caller. Two integers need no such care.
 *
 * Same single-pid-loop discipline as `scanProcesses` — see the note there on
 * why a multi-row `-p` query is never issued. A pid absent from the result has
 * no discoverable parent (gone, or the inspector failed). */
export function scanParentPids(
  pids: number[],
  executable = PS_EXECUTABLE,
): Map<number, number> {
  const parents = new Map<number, number>();
  const wanted = new Set(pids);
  if (wanted.size === 0) return parents;
  const queries =
    wanted.size <= PS_LOOP_MAX
      ? [...wanted].map((pid) => ["-ww", "-p", String(pid)])
      : [["-ww", "-A"]];
  for (const query of queries) {
    const res = spawnSync(executable, [...query, "-o", "pid=,ppid="], {
      encoding: "utf8",
    });
    if (res.error || res.signal) continue;
    for (const line of (res.stdout ?? "").split("\n")) {
      const tokens = line.trim().split(/\s+/);
      if (tokens.length < 2) continue;
      const pid = Number(tokens[0]);
      const ppid = Number(tokens[1]);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      if (wanted.has(pid)) parents.set(pid, ppid);
    }
  }
  return parents;
}

/** Send a signal to a pid, tolerating a process that is already gone.
 *
 * Every daemon kill races: liveness is confirmed, then the process can exit
 * before the signal lands -- `launchctl bootout` during `install` makes that
 * the common case rather than the rare one. ESRCH means the caller's goal
 * (that pid not running) already holds, so it is reported as "was not
 * running", not raised as a crash that abandons the rest of an install.
 * Any other errno is a real fault and still throws. */
export function signalPid(pid: number, signal: "SIGTERM" | "SIGHUP"): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
