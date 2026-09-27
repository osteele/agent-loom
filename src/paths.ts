/** Shared filesystem layout for agent-mail.
 *
 * State root: ~/.claude/agent-mail/
 *   inbox/<slug>.jsonl     per-project message spools (source of truth)
 *   read/<slug>.json        per-project read message ids
 *   receipts/<slug>.jsonl  append-only delivery state changes
 *   registry/<id>.json     live channel-server registrations
 *   session-names/<id>.json persistent generated session names
 *   claims/<slug>/          experiment-number and path claims
 *   work/<slug>/            exclusive logical-work leases
 *   transfers/              auditable work-lease transfer requests
 *   obligations/            machine-global obligation records + ref observations
 *   presence.json          daemon snapshot of the live registry
 *   processes.json         daemon snapshot of coordination-owner processes
 *   unread-summary.json    daemon snapshot of per-session unread counts
 *   announced/<slug>-<id>.json per-session announcement bookkeeping (NOT receipts)
 *   claim-reminders.json daemon bookkeeping for bounded claim reminders
 *   ack-reminders.json   daemon bookkeeping for unacknowledged-delivery reminders
 *   remind-diagnostics.log rate-limited stale-summary diagnostics from remind
 *   mcp-startup-failures.jsonl sanitized pre-handshake MCP failure records
 *   channel-lifecycle.jsonl channel-server attach, shutdown, exit, and prune records
 *   daemon.pid, daemon.log daemon state
 * Config:     ~/.config/agent-mail/config.toml
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const STATE_DIR = join(homedir(), ".claude", "agent-mail");
export const INBOX_DIR = join(STATE_DIR, "inbox");
export const READ_DIR = join(STATE_DIR, "read");
export const RECEIPTS_DIR = join(STATE_DIR, "receipts");
export const REGISTRY_DIR = join(STATE_DIR, "registry");
export const SESSION_NAMES_DIR = join(STATE_DIR, "session-names");
/** Session names keyed by the host agent's pid, for readers that know which
 * process ran but not which id this server resolved for it. A launcher knows
 * the id it minted, which the precedence chain may have passed over -- a Codex
 * thread id outranks it -- so a hash of the launcher's id can miss a name that
 * exists. This is written from inside, after the resolution. */
export const SESSION_NAMES_BY_HOST_PID_DIR = join(
  SESSION_NAMES_DIR,
  "by-host-pid",
);
export const CLAIMS_DIR = join(STATE_DIR, "claims");
export const WORK_DIR = join(STATE_DIR, "work");
export const TRANSFERS_DIR = join(STATE_DIR, "transfers");
/** Machine-global obligation records (specs/obligations.allium): unlike
 * claims and work these are not project-scoped — a wait spans projects. */
export const OBLIGATIONS_DIR = join(STATE_DIR, "obligations");
export const CONFIG_DIR = join(homedir(), ".config", "agent-mail");
export const CONFIG_PATH = join(CONFIG_DIR, "config.toml");
export const PID_PATH = join(STATE_DIR, "daemon.pid");
export const LOG_PATH = join(STATE_DIR, "daemon.log");
/** Persisted {channel, ts} of the editable Slack dashboard message. */
export const SLACK_DASHBOARD_PATH = join(STATE_DIR, "slack-dashboard.json");
/** Periodic daemon snapshot of the pid-verified live registry, so readers on a
 * latency budget can skip the process scan. */
export const PRESENCE_SNAPSHOT_PATH = join(STATE_DIR, "presence.json");
export const PROCESS_SNAPSHOT_PATH = join(STATE_DIR, "processes.json");
export const WEFT_JOBS_SNAPSHOT_PATH = join(STATE_DIR, "weft-jobs.json");
/** Per-session unread counts the daemon publishes for hook reminders. Same
 * presentation-cache rules as presence.json: never a delivery input. */
export const UNREAD_SUMMARY_PATH = join(STATE_DIR, "unread-summary.json");
/** Per-session startup/reminder bookkeeping. Deliberately separate from
 * receipts/: an announcement delivers no message body. */
export const ANNOUNCED_DIR = join(STATE_DIR, "announced");
/** Daemon bookkeeping for bounded claim-age and condition reminders. */
export const CLAIM_REMINDER_STATE_PATH = join(
  STATE_DIR,
  "claim-reminders.json",
);
/** Daemon bookkeeping for bounded unacknowledged-delivery reminders. */
export const ACK_REMINDER_STATE_PATH = join(STATE_DIR, "ack-reminders.json");
/** Rate-limited diagnostics from `agent-mail remind` (stale/missing summary).
 * Appended to, never read by code; stdout of the hook stays machine-clean. */
export const REMIND_DIAGNOSTICS_PATH = join(
  STATE_DIR,
  "remind-diagnostics.log",
);
/** Sanitized failures before an MCP server completes initialization. This is
 * agent-mail's durable copy of evidence that hosts commonly discard with the
 * subprocess stderr stream. */
export const MCP_STARTUP_FAILURES_PATH = join(
  STATE_DIR,
  "mcp-startup-failures.jsonl",
);
/** Append-only JSONL record of each channel server's handshake, exit, and
 * removal from the registry. The registry forgets a server the moment it goes;
 * this is what is left to explain why a session became unreachable. */
export const CHANNEL_LIFECYCLE_LOG_PATH = join(
  STATE_DIR,
  "channel-lifecycle.jsonl",
);
/** Append-only JSONL record of authority-forced coordination recoveries. A
 * forced recovery bypasses the liveness proof, so the declared authority is the
 * only trace of why an owner's record was taken; keep it durable and outside
 * the per-project stores that a recovery deletes from. */
export const FORCED_RECOVERY_LOG_PATH = join(
  STATE_DIR,
  "forced-recoveries.jsonl",
);

export const DEFAULT_PORT = 8377;
export const LAUNCHD_LABEL = "com.osteele.agent-mail";

export function ensureDirs(): void {
  for (const dir of [
    STATE_DIR,
    INBOX_DIR,
    READ_DIR,
    RECEIPTS_DIR,
    REGISTRY_DIR,
    SESSION_NAMES_DIR,
    SESSION_NAMES_BY_HOST_PID_DIR,
    CLAIMS_DIR,
    WORK_DIR,
    TRANSFERS_DIR,
    ANNOUNCED_DIR,
    CONFIG_DIR,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Canonicalize a project path: absolute, symlinks resolved when possible. */
export function canonicalProject(project: string): string {
  const abs = resolve(project.replace(/^~(?=\/|$)/, homedir()));
  return existsSync(abs) ? realpathSync(abs) : abs;
}

/** Display name for a sender/recipient: basename of a path, else the label
 * verbatim (so "weft", "cli", or a friendly slug pass through unchanged). */
export function displayName(pathOrLabel: string): string {
  if (!pathOrLabel.includes("/")) return pathOrLabel;
  return pathOrLabel.split("/").filter(Boolean).pop() ?? pathOrLabel;
}

/** Stable spool slug for a project directory: basename + path hash. */
export function projectSlug(project: string): string {
  const canon = canonicalProject(project);
  const base = canon.split("/").filter(Boolean).pop() ?? "root";
  const hash = createHash("sha256").update(canon).digest("hex").slice(0, 10);
  return `${base}-${hash}`;
}

export function spoolPath(project: string): string {
  return join(INBOX_DIR, `${projectSlug(project)}.jsonl`);
}

/** Append-only log of read message ids (one id per line). Append-only so
 * concurrent markers union rather than clobber each other's marks. */
export function readStatePath(project: string): string {
  return join(READ_DIR, `${projectSlug(project)}.read`);
}

export function receiptPath(project: string): string {
  return join(RECEIPTS_DIR, `${projectSlug(project)}.jsonl`);
}

/** Pre-append-only read-state file (`{read:[...]}` JSON). Read for migration so
 * existing marks survive the format change; never written anymore. */
export function legacyReadStatePath(project: string): string {
  return join(READ_DIR, `${projectSlug(project)}.json`);
}
