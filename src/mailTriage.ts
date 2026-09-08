/** Select unread mail that no currently live session owns exclusively. */

import {
  type DeliveryReceipt,
  type StoredMessage,
  hasReceipt,
  isExpired,
} from "./spool.ts";

export type TriageReason =
  | "broadcast"
  | "recipient-not-live"
  | "recipient-refused";

export interface TriageCandidate extends StoredMessage {
  triageReason: TriageReason;
}

export interface TriageSelection {
  messages: TriageCandidate[];
  counts: {
    unread: number;
    candidates: number;
    broadcast: number;
    recipientNotLive: number;
    recipientRefused: number;
    liveRecipient: number;
    nonDeliverable: number;
  };
}

/**
 * Select a stable triage set from one project spool and one live-session scan.
 *
 * Broadcasts belong to the project and are always candidates. Direct mail is a
 * candidate when its exact recipient is absent from the project's live
 * registrations or when that recipient refused it. Audit records and
 * TTL-expired mail never enter an inbox, so they are reported in the counts but
 * do not create triage work.
 */
export function selectTriageCandidates(
  messages: StoredMessage[],
  receipts: DeliveryReceipt[],
  liveSessionIds: Iterable<string>,
  nowMs = Date.now(),
): TriageSelection {
  const live = new Set(liveSessionIds);
  const candidates: TriageCandidate[] = [];
  let unread = 0;
  let broadcast = 0;
  let recipientNotLive = 0;
  let recipientRefused = 0;
  let liveRecipient = 0;
  let nonDeliverable = 0;

  for (const message of messages) {
    if (message.read) continue;
    unread++;
    if (message.delivery === "audit" || isExpired(message, nowMs)) {
      nonDeliverable++;
      continue;
    }

    const recipient = message.meta?.toSession;
    if (!recipient) {
      broadcast++;
      candidates.push({ ...message, triageReason: "broadcast" });
    } else if (!live.has(recipient)) {
      recipientNotLive++;
      candidates.push({ ...message, triageReason: "recipient-not-live" });
    } else if (hasReceipt(receipts, message.id, recipient, ["refused"])) {
      recipientRefused++;
      candidates.push({ ...message, triageReason: "recipient-refused" });
    } else {
      liveRecipient++;
    }
  }

  return {
    messages: candidates,
    counts: {
      unread,
      candidates: candidates.length,
      broadcast,
      recipientNotLive,
      recipientRefused,
      liveRecipient,
      nonDeliverable,
    },
  };
}
