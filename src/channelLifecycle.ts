/** Durable record of how channel servers leave the registry.
 *
 * A session with no channel server is unreachable, and nothing else records how
 * it got that way: the host discards the server's stderr, the registry entry is
 * deleted on exit, and a server killed outright runs no code at all. This log
 * keeps one line per lifecycle edge so the absence can be read back:
 *
 * - `attached`  — the host completed the MCP handshake with this server.
 * - `shutdown`  — the server left on its own path (a signal, or stdin closing).
 * - `exit`      — the process exited without taking that path.
 * - `pruned`    — a registry sweep removed an entry whose process was gone.
 *
 * An `attached` line followed by `pruned` with no `shutdown` or `exit` between
 * them is a server that was killed (SIGKILL, or a crash in the runtime itself);
 * a session with no `attached` line was never given a server by its host.
 *
 * Records carry identity and cause only — never environment variables, message
 * bodies, or MCP request contents.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { diagnosticError } from "./mcpDiagnostics.ts";
import { CHANNEL_LIFECYCLE_LOG_PATH } from "./paths.ts";

export type ChannelLifecycleEvent = "attached" | "shutdown" | "exit" | "pruned";

/** Why a sweep judged a registered process gone: no process has the pid, the
 * pid now belongs to a different process, or the process is a zombie. */
export type PruneCause = "no-process" | "pid-reused" | "defunct";

export interface ChannelLifecycleRecord {
  version: 1;
  timestamp: string;
  event: ChannelLifecycleEvent;
  pid: number;
  parentPid?: number;
  sessionId?: string;
  cwd: string;
  client?: string;
  /** `shutdown`: the signal name, `stdin-close`, or `stdin-end`. */
  reason?: string;
  exitCode?: number;
  /** `exit`: the uncaught exception that preceded it, if any. */
  error?: ReturnType<typeof diagnosticError>;
  /** `pruned`: what the sweep saw at the registered pid. */
  cause?: PruneCause;
  /** `pruned`: the registration's own start stamp, bounding its lifetime. */
  registered?: string;
  /** `pruned`: the pid of the process that swept it. */
  sweptBy?: number;
}

export function channelLifecycleRecord(
  input: Omit<ChannelLifecycleRecord, "version" | "timestamp"> & {
    now?: Date;
  },
): ChannelLifecycleRecord {
  const { now, ...fields } = input;
  // Undefined fields vanish in JSON.stringify, so optional inputs need no
  // filtering here.
  return {
    version: 1,
    timestamp: (now ?? new Date()).toISOString(),
    ...fields,
  };
}

/** Append one record. Runs on exit and signal paths, so a failure to write is
 * swallowed rather than allowed to replace the exit it was recording. */
export function appendChannelLifecycle(
  record: ChannelLifecycleRecord,
  path = CHANNEL_LIFECYCLE_LOG_PATH,
): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export interface ChannelIdentity {
  sessionId: string;
  cwd: string;
  client?: string;
}

let identity: ChannelIdentity | undefined;
let ended = false;
let lastError: unknown;
let tracking = false;

/** Record the handshake and start watching for an exit that bypasses
 * `recordChannelShutdown`. Called once the host has initialized; exits before
 * that are `mcp-startup-failures.jsonl`'s concern. Idempotent: a repeated
 * initialize refreshes the identity without a second `attached` line. */
export function recordChannelAttached(
  current: ChannelIdentity,
  path = CHANNEL_LIFECYCLE_LOG_PATH,
): void {
  const first = identity === undefined;
  identity = current;
  if (!first) return;
  appendChannelLifecycle(
    channelLifecycleRecord({
      event: "attached",
      pid: process.pid,
      parentPid: process.ppid,
      ...current,
    }),
    path,
  );
  if (tracking) return;
  tracking = true;
  process.on("uncaughtExceptionMonitor", (error) => {
    lastError = error;
  });
  process.on("exit", (code) => {
    if (ended || !identity) return;
    ended = true;
    appendChannelLifecycle(
      channelLifecycleRecord({
        event: "exit",
        pid: process.pid,
        parentPid: process.ppid,
        ...identity,
        exitCode: code,
        ...(lastError !== undefined
          ? { error: diagnosticError(lastError) }
          : {}),
      }),
      path,
    );
  });
}

/** Record a deliberate shutdown. Before the handshake there is no identity to
 * record against, and the startup log covers that window. */
export function recordChannelShutdown(
  reason: string,
  path = CHANNEL_LIFECYCLE_LOG_PATH,
): void {
  if (ended || !identity) return;
  ended = true;
  appendChannelLifecycle(
    channelLifecycleRecord({
      event: "shutdown",
      pid: process.pid,
      parentPid: process.ppid,
      ...identity,
      reason,
    }),
    path,
  );
}
