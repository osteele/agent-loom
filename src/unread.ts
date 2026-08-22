/** The one unread-for-a-session predicate, shared by every surface that
 * counts or lists a session's unread mail.
 *
 * A project spool and its read state are shared by every session in the
 * directory, so "unread for this session" is a filtered view, not a spool
 * query: the session's own sends and mail directed at another session are
 * hidden (`messageVisibleToSession`), and a message carrying a refused or
 * expired receipt for this session stays out. The receipt clause matches the
 * MCP inbox (`sessionMessages` in channel.ts): a session that refused a
 * message or let it expire ended that delivery, and re-counting it as unread
 * would re-litigate a delivery that is over.
 *
 * Reminder bookkeeping (`announced.ts`) deliberately lives elsewhere and
 * never feeds this predicate: a reminder is not a delivery and changes
 * nothing about what is unread. */
import {
  type DeliveryReceipt,
  type StoredMessage,
  hasReceipt,
  messageVisibleToSession,
  readMessages,
  readReceipts,
} from "./spool.ts";

/** The predicate over an already-read spool scan and receipt list, so a
 * caller aggregating several sessions in one project (the daemon's unread
 * summary) pays for one scan per project instead of one per session. */
export function filterUnreadForSession(
  unread: StoredMessage[],
  receipts: DeliveryReceipt[],
  sessionId: string,
): StoredMessage[] {
  return unread.filter(
    (msg) =>
      messageVisibleToSession(msg, sessionId) &&
      !hasReceipt(receipts, msg.id, sessionId, ["refused", "expired"]),
  );
}

/** Unread messages one session can see in a shared project spool. */
export function unreadVisibleForSession(
  project: string,
  sessionId: string,
): StoredMessage[] {
  return filterUnreadForSession(
    readMessages(project, { limit: 0, unreadOnly: true }),
    readReceipts(project),
    sessionId,
  );
}
