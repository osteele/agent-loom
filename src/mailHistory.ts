/** Historical attribution uses persisted sender, target and receipt evidence only. */
import { isAbsolute } from "node:path";
import { canonicalProject } from "./paths.ts";
import {
  type DeliveryReceipt,
  type StoredMessage,
  readAllMessages,
  readReceipts,
} from "./spool.ts";

export interface SessionMailMessage {
  key: string;
  id: string;
  direction: "incoming" | "outgoing";
  timestamp: string;
  project: string;
  sender: string;
  senderSessionId: string | null;
  recipients: string[];
  broadcast: boolean;
  body: string;
  replyTo: string | null;
  threadId: string | null;
}

export interface SessionMailHistory {
  kind: "session_mail_history";
  version: 1;
  project: string;
  sessionId: string;
  generatedAt: number;
  messages: SessionMailMessage[];
}

function sameProject(value: string | undefined, project: string): boolean {
  return !!value && isAbsolute(value) && canonicalProject(value) === project;
}

/** Directed intent is enough. Broadcasts require exact per-session receipt evidence,
 * including historical refusals/expiry; merely sharing the mailbox is not evidence. */
export function projectSessionMail(
  project: string,
  sessionId: string,
  messages: readonly StoredMessage[],
  receiptsByProject: ReadonlyMap<string, readonly DeliveryReceipt[]>,
  generatedAt = Date.now(),
): SessionMailHistory {
  if (!sessionId.trim() || !isAbsolute(project))
    throw new Error(
      "Mail history requires an exact session and absolute project",
    );
  const canonical = canonicalProject(project);
  const recipientsByMessage = new Map<string, Set<string>>();
  for (const [mailbox, receipts] of receiptsByProject) {
    for (const receipt of receipts) {
      if (
        !receipt ||
        typeof receipt.messageId !== "string" ||
        typeof receipt.project !== "string" ||
        typeof receipt.status !== "string" ||
        (receipt.sessionId !== undefined &&
          typeof receipt.sessionId !== "string")
      )
        throw new Error(`Invalid receipt in ${mailbox}`);
      if (receipt.sessionId && sameProject(receipt.project, mailbox)) {
        const key = JSON.stringify([mailbox, receipt.messageId]);
        const recipients = recipientsByMessage.get(key) ?? new Set<string>();
        recipients.add(receipt.sessionId);
        recipientsByMessage.set(key, recipients);
      }
    }
  }
  const entries: SessionMailMessage[] = [];
  for (const message of messages) {
    if (
      !message ||
      typeof message.id !== "string" ||
      typeof message.project !== "string" ||
      !isAbsolute(message.project) ||
      typeof message.from !== "string" ||
      typeof message.message !== "string" ||
      typeof message.ts !== "string" ||
      !Number.isFinite(Date.parse(message.ts)) ||
      (message.meta !== undefined &&
        (message.meta === null ||
          typeof message.meta !== "object" ||
          Object.values(message.meta).some(
            (value) => typeof value !== "string",
          ))) ||
      (message.replyTo !== undefined && typeof message.replyTo !== "string") ||
      (message.threadId !== undefined && typeof message.threadId !== "string")
    )
      throw new Error("Invalid message in mail history");
    if (message.delivery === "audit") continue;
    const mailbox = canonicalProject(message.project);
    const senderSessionId =
      message.origin?.sessionId ?? message.meta?.sessionId ?? null;
    if (senderSessionId !== null && typeof senderSessionId !== "string")
      throw new Error(`Invalid sender identity for message ${message.id}`);
    const directed = message.meta?.toSession;
    const recipients = new Set(
      recipientsByMessage.get(JSON.stringify([mailbox, message.id])),
    );
    if (directed) recipients.add(directed);
    const outgoing =
      senderSessionId === sessionId &&
      sameProject(message.meta?.fromProject ?? message.from, canonical);
    const incoming =
      mailbox === canonical &&
      (directed
        ? directed === sessionId
        : senderSessionId !== sessionId && recipients.has(sessionId));
    const base = {
      id: message.id,
      timestamp: message.ts,
      project: mailbox,
      sender: message.meta?.fromName ?? message.from,
      senderSessionId,
      recipients: [...recipients].sort(),
      broadcast: !directed,
      body: message.message,
      replyTo: message.replyTo ?? null,
      threadId: message.threadId ?? null,
    };
    for (const direction of ["incoming", "outgoing"] as const) {
      if (direction === "incoming" ? incoming : outgoing)
        entries.push({
          ...base,
          direction,
          key: JSON.stringify([mailbox, message.id, direction]),
        });
    }
  }
  entries.sort(
    (a, b) =>
      Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
      a.key.localeCompare(b.key),
  );
  return {
    kind: "session_mail_history",
    version: 1,
    project: canonical,
    sessionId,
    generatedAt,
    messages: entries,
  };
}

/** Owns the cross-mailbox scan so consumers never reconstruct spool attribution.
 * These readers do not create directories, prune registrations or stamp receipts. */
export function readSessionMailHistory(
  project: string,
  sessionId: string,
  generatedAt = Date.now(),
): SessionMailHistory {
  const messages = readAllMessages(true);
  const receipts = new Map<string, DeliveryReceipt[]>();
  for (const message of messages) {
    if (typeof message.project !== "string" || !isAbsolute(message.project))
      throw new Error("Invalid project in mail history");
    const mailbox = canonicalProject(message.project);
    if (!receipts.has(mailbox))
      receipts.set(mailbox, readReceipts(mailbox, undefined, true));
  }
  return projectSessionMail(
    project,
    sessionId,
    messages,
    receipts,
    generatedAt,
  );
}
