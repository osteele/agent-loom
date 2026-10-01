/** Bounded reminders for unread mail addressed to one session.
 *
 * A bare `pushed` receipt proves that the receiving transport accepted the
 * message, not that it entered agent context. OMP protocol v3 adds a separate
 * `read` receipt only after its `message_start` event confirms insertion.
 * `check_inbox` marks what it returns; `mark_read` records explicit disposition
 * of mail handled from a transport-only push.
 *
 * A reminder fires when the condition is true rather than once at startup,
 * which is the difference between the coordination reminders agents act on and
 * the startup sentence they do not.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { ACK_REMINDER_STATE_PATH, canonicalProject } from "./paths.ts";
import {
  type DeliveryReceipt,
  type StoredMessage,
  visibleToSession,
} from "./spool.ts";

/** How long a pushed message may sit unacknowledged before it counts. Short
 * enough to reach the session that handled it, long enough that mail being
 * read right now is not nagged about. */
export const ACK_GRACE_MS = 30 * 60_000;
/** Minimum spacing between reminders to one project mailbox. */
export const ACK_REMINDER_INTERVAL_MS = 2 * 60 * 60_000;
const STATE_VERSION = 2;

export interface AckReminderState {
  version: 2;
  /** Canonical project + session key to the time that mailbox was last reminded. */
  sessions: Record<string, number>;
}

export interface AckReminder {
  sessionId: string;
  project: string;
  pushed: number;
  neverPushed: number;
  oldestMs: number;
  message: string;
  idempotencyKey: string;
}

export function ackReminderMailboxKey(
  project: string,
  sessionId: string,
): string {
  return `${canonicalProject(project)}\u0000${sessionId}`;
}

function emptyState(): AckReminderState {
  return { version: STATE_VERSION, sessions: {} };
}

export function readAckReminderState(
  path = ACK_REMINDER_STATE_PATH,
): AckReminderState {
  if (!existsSync(path)) return emptyState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return emptyState();
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return emptyState();
  }
  const document = parsed as { version?: unknown; sessions?: unknown };
  // Legacy cooldowns lack a project and cannot be assigned to one mailbox.
  if (
    document.version !== STATE_VERSION ||
    typeof document.sessions !== "object" ||
    document.sessions === null ||
    Array.isArray(document.sessions)
  ) {
    return emptyState();
  }
  const sessions: Record<string, number> = {};
  for (const [key, at] of Object.entries(document.sessions)) {
    if (typeof at === "number" && Number.isFinite(at) && at >= 0)
      sessions[key] = at;
  }
  return { version: STATE_VERSION, sessions };
}

export function writeAckReminderState(
  state: AckReminderState,
  path = ACK_REMINDER_STATE_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, path);
}

export function ackReminderStatesEqual(
  left: AckReminderState,
  right: AckReminderState,
): boolean {
  const a = Object.entries(left.sessions).sort();
  const b = Object.entries(right.sessions).sort();
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A reminder is itself mail and remains unread after push. Counting it would
 * make the condition self-sustaining: the reminder would become the backlog it
 * reports and fire forever. */
export function isAgentLoomAutomation(message: StoredMessage): boolean {
  return (
    message.meta?.coordinationReminder === "true" ||
    message.meta?.ackReminder === "true"
  );
}

/** Mail outstanding for a session, split by transport evidence.
 *
 * Both halves are unread and retrievable through `check_inbox`. A pushed
 * message may have entered context, remained queued by the host, or already
 * been handled without an explicit `mark_read`. A message with no push receipt
 * has not reached the session's push transport. */
export interface OutstandingMail {
  /** Accepted by this session's push transport, still unread. */
  pushed: number;
  /** No push receipt for this session, still unread. */
  neverPushed: number;
  /** Age of the oldest message in either half. */
  oldestMs: number;
}

export function outstandingMail(
  messages: StoredMessage[],
  receipts: DeliveryReceipt[],
  sessionId: string,
  nowMs: number,
  graceMs = ACK_GRACE_MS,
  /** When this session began. Mail older than this was never its to see. */
  sinceMs = 0,
): OutstandingMail {
  const pushedAt = new Map<string, number>();
  for (const receipt of receipts) {
    if (receipt.sessionId !== sessionId || receipt.status !== "pushed")
      continue;
    const at = Date.parse(receipt.ts);
    if (!Number.isFinite(at)) continue;
    const seen = pushedAt.get(receipt.messageId);
    if (seen === undefined || at < seen) pushedAt.set(receipt.messageId, at);
  }
  let pushed = 0;
  let neverPushed = 0;
  let oldest = 0;
  // Count only what this session may actually see. Without it the reminder
  // reports the whole project spool — other sessions' mail, and this session's
  // own sends — as the reader's outstanding work, and names a remedy that
  // cannot reach it: `check_inbox` applies this filter and would return none
  // of it.
  for (const message of visibleToSession(messages, receipts, sessionId)) {
    if (message.read || isAgentLoomAutomation(message)) continue;
    // Age from the push when the transport accepted a message, and from the
    // message timestamp when no push occurred.
    const from = pushedAt.get(message.id) ?? Date.parse(message.ts);
    if (!Number.isFinite(from)) continue;
    const age = nowMs - from;
    if (age < graceMs) continue;
    if (pushedAt.has(message.id)) {
      pushed += 1;
    } else {
      // A project inbox outlives its sessions. Everything spooled before this
      // session began was never available to it, so counting that history
      // reports a shared archive as one session's outstanding work. A push is
      // evidence that the transport accepted the message, so the pushed half
      // needs no such bound.
      if (from < sinceMs) continue;
      neverPushed += 1;
    }
    if (age > oldest) oldest = age;
  }
  return { pushed, neverPushed, oldestMs: oldest };
}

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Decide whether one session is due a reminder, and what it should say. */
export function prepareAckReminder(
  sessionId: string,
  project: string,
  messages: StoredMessage[],
  receipts: DeliveryReceipt[],
  state: AckReminderState,
  nowMs: number,
  sinceMs = 0,
): AckReminder | undefined {
  const { pushed, neverPushed, oldestMs } = outstandingMail(
    messages,
    receipts,
    sessionId,
    nowMs,
    ACK_GRACE_MS,
    sinceMs,
  );
  const count = pushed + neverPushed;
  if (count === 0) return undefined;
  const mailboxKey = ackReminderMailboxKey(project, sessionId);
  const last = state.sessions[mailboxKey];
  if (last !== undefined && nowMs - last < ACK_REMINDER_INTERVAL_MS) {
    return undefined;
  }
  const parts: string[] = [];
  if (pushed > 0) parts.push(`${pushed} pushed but unread`);
  if (neverPushed > 0) parts.push(`${neverPushed} never pushed`);
  const noun = count === 1 ? "message" : "messages";
  return {
    sessionId,
    project,
    pushed,
    neverPushed,
    oldestMs,
    message: `Agent-loom delivery reminder: ${count} ${noun} outstanding for you (${parts.join(", ")}); oldest ${formatAge(oldestMs)}. Call check_inbox to retrieve unread mail, or mark_read only messages you have already handled from a push.`,
    // One reminder per mailbox per interval, including retries after rate limits.
    idempotencyKey: `ack-reminder:${mailboxKey}:${Math.floor(nowMs / ACK_REMINDER_INTERVAL_MS)}`,
  };
}

export function recordAckReminder(
  state: AckReminderState,
  reminder: AckReminder,
  nowMs: number,
): AckReminderState {
  return {
    version: STATE_VERSION,
    sessions: {
      ...state.sessions,
      [ackReminderMailboxKey(reminder.project, reminder.sessionId)]: nowMs,
    },
  };
}

/** Mailboxes that have gone quiet should not keep state forever. */
export function pruneAckReminderState(
  state: AckReminderState,
  liveMailboxKeys: ReadonlySet<string>,
): AckReminderState {
  const sessions: Record<string, number> = {};
  for (const [id, at] of Object.entries(state.sessions)) {
    if (liveMailboxKeys.has(id)) sessions[id] = at;
  }
  return { version: STATE_VERSION, sessions };
}
