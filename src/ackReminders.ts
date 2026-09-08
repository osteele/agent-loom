/** Bounded reminders for mail a session was pushed and never acknowledged.
 *
 * A channel push cannot mark read: it is fire-and-forget, so the server cannot
 * tell a delivered message from a dropped one (0013, narrowed by 0016 to spare
 * transports that acknowledge). The acknowledgement is therefore a separate
 * act, `mark_read`, which the startup instruction asks for and which two
 * sessions in one night each read and did not perform — neither noticing until
 * a human read a status line.
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
  delivered: number;
  undelivered: number;
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

/** A reminder is itself mail: it is pushed to the session it names and, on a
 * transport that cannot acknowledge, goes unacknowledged like everything else.
 * Counting it would make the condition self-sustaining — the reminder would
 * become the backlog it reports and fire forever. */
export function isAgentMailAutomation(message: StoredMessage): boolean {
  return (
    message.meta?.coordinationReminder === "true" ||
    message.meta?.ackReminder === "true"
  );
}

/** Mail outstanding for a session, split by whether it ever reached them.
 *
 * Both halves are unread and both want action, but not the same action: a
 * delivered message was surfaced and is probably handled, needing only
 * `mark_read`; an undelivered one has never been seen and needs pulling. A
 * reminder that merged them would tell a session to acknowledge mail it has
 * not read, and to go read mail it already answered. */
export interface OutstandingMail {
  /** Pushed to this session, still unread — very likely handled. */
  delivered: number;
  /** Never pushed to this session and still unread — never seen. */
  undelivered: number;
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
  let delivered = 0;
  let undelivered = 0;
  let oldest = 0;
  // Count only what this session may actually see. Without it the reminder
  // reports the whole project spool — other sessions' mail, and this session's
  // own sends — as the reader's outstanding work, and names a remedy that
  // cannot reach it: `check_inbox` applies this filter and would return none
  // of it.
  for (const message of visibleToSession(messages, receipts, sessionId)) {
    if (message.read || isAgentMailAutomation(message)) continue;
    // Age from the push for a delivered message, from the message itself for
    // one that never arrived: an undelivered message has no delivery to date
    // from, and dating it from now would make it permanently too young.
    const from = pushedAt.get(message.id) ?? Date.parse(message.ts);
    if (!Number.isFinite(from)) continue;
    const age = nowMs - from;
    if (age < graceMs) continue;
    if (pushedAt.has(message.id)) {
      delivered += 1;
    } else {
      // A project inbox outlives its sessions. Everything spooled before this
      // session began was never delivered to it and never could have been, so
      // counting it reports a shared archive as one session's outstanding
      // work: on first run this read 48 undelivered, oldest 22 days, for a
      // session hours old. That is the per-session-receipt flaw 0013 named,
      // surfaced as an alarm. A push is its own proof of arrival, so the
      // delivered half needs no such bound.
      if (from < sinceMs) continue;
      undelivered += 1;
    }
    if (age > oldest) oldest = age;
  }
  return { delivered, undelivered, oldestMs: oldest };
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
  const { delivered, undelivered, oldestMs } = outstandingMail(
    messages,
    receipts,
    sessionId,
    nowMs,
    ACK_GRACE_MS,
    sinceMs,
  );
  const count = delivered + undelivered;
  if (count === 0) return undefined;
  const mailboxKey = ackReminderMailboxKey(project, sessionId);
  const last = state.sessions[mailboxKey];
  if (last !== undefined && nowMs - last < ACK_REMINDER_INTERVAL_MS) {
    return undefined;
  }
  const parts: string[] = [];
  if (delivered > 0) parts.push(`${delivered} delivered but unacknowledged`);
  if (undelivered > 0) parts.push(`${undelivered} never delivered`);
  const noun = count === 1 ? "message" : "messages";
  return {
    sessionId,
    project,
    delivered,
    undelivered,
    oldestMs,
    message: `Agent-mail delivery reminder: ${count} ${noun} outstanding for you (${parts.join(", ")}); oldest ${formatAge(oldestMs)}. A channel push cannot mark mail read on its own: call mark_read for any you have already handled, and check_inbox to pull anything you have not seen.`,
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
