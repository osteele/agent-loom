import { expect, test } from "bun:test";
import {
  classifyFallback,
  decideHeldSettlements,
  decideNewMessageDelivery,
  pendingHeldIds,
  withAttemptKey,
} from "./delivery.ts";
import type { DeliveryReceipt, Message } from "./spool.ts";

const BASE: Message = {
  ts: "2026-08-17T04:54:46.000Z",
  from: "agent-mail",
  project: "/Users/x/code/weft",
  message: "job done",
};

test("every attempt is stamped, leaving any caller key untouched", () => {
  // The two keys answer different questions, so the attempt token is minted
  // whether or not the caller asked for idempotency. Stamping only when the
  // caller supplied nothing would leave idempotent senders misreported.
  expect(withAttemptKey(BASE, "attempt-1").attemptKey).toBe("attempt-1");
  const withCallerKey = withAttemptKey(
    { ...BASE, idempotencyKey: "caller-key" },
    "attempt-1",
  );
  expect(withCallerKey.attemptKey).toBe("attempt-1");
  expect(withCallerKey.idempotencyKey).toBe("caller-key");
});

test("colliding with our own generated key means the message was delivered", () => {
  // The regression this guards: the daemon appended the message and then failed
  // to return its response, so the fallback re-read the shared spool and found
  // that very message. Reporting "duplicate suppressed" told the caller their
  // message had been dropped when it had in fact been sent.
  expect(
    classifyFallback({
      status: "duplicate",
      id: "msg-1",
      reason: "attempt-key",
    }),
  ).toEqual({ kind: "already-delivered", id: "msg-1" });
});

test("collisions that are not our own attempt stay duplicates", () => {
  // Same text from a separate call, or a caller's reused idempotency key.
  // Neither means this attempt's message landed, so neither may read as sent.
  for (const reason of ["signature", "idempotency-key"] as const) {
    expect(
      classifyFallback({ status: "duplicate", id: "msg-1", reason }),
    ).toEqual({ kind: "duplicate", id: "msg-1" });
  }
});

test("ordinary and rate-limited fallbacks pass through unchanged", () => {
  expect(
    classifyFallback({
      status: "spooled",
      id: "msg-2",
      path: "/tmp/spool.jsonl",
    }),
  ).toEqual({ kind: "spooled", id: "msg-2" });
  expect(
    classifyFallback({ status: "rate_limited", retryAfterSeconds: 7 }),
  ).toEqual({ kind: "rate_limited", retryAfterSeconds: 7 });
});

const receipt = (
  status: DeliveryReceipt["status"],
  sessionId = "session-1",
): DeliveryReceipt => ({
  messageId: "msg-1",
  project: BASE.project,
  ts: BASE.ts,
  status,
  sessionId,
});

const NOW = Date.parse(BASE.ts);
const ARCHIVE = new Map<string, Message>([["msg-1", BASE]]);

test("nothing pending held means no settlement actions, whatever the archive holds", () => {
  // channel.ts's settleHeld returns before reading the project archive when
  // pendingHeldIds is empty. That read ran on every 1s poll tick and scaled with
  // the project's entire message history, which is what made an idle listener
  // burn ~3% of a core. The skip is only safe while this equivalence holds: if
  // decideHeldSettlements ever yields actions with nothing pending, that early
  // return would drop them silently rather than merely saving work.
  for (const receipts of [
    [receipt("pushed")],
    [receipt("held"), receipt("pushed")],
  ]) {
    expect(pendingHeldIds(receipts, "session-1")).toEqual([]);
    expect(
      decideHeldSettlements(
        "session-1",
        "accept",
        false,
        true,
        ARCHIVE,
        receipts,
        NOW,
      ),
    ).toEqual([]);
  }
});

test("a held message still settles once the session can receive it", () => {
  // Positive control for the skip above. Without it, a pendingHeldIds that
  // always returned empty would satisfy the previous test while silently
  // disabling held delivery altogether.
  const receipts = [receipt("held")];
  expect(pendingHeldIds(receipts, "session-1")).toEqual(["msg-1"]);
  expect(
    decideHeldSettlements(
      "session-1",
      "accept",
      false,
      true,
      ARCHIVE,
      receipts,
      NOW,
    ),
  ).toEqual([{ type: "push", messageId: "msg-1" }]);
});

test("known channel failure terminates a new push attempt honestly", () => {
  expect(
    decideNewMessageDelivery(
      { ...BASE, id: "msg-1" },
      "session-1",
      "accept",
      false,
      true,
      10,
      [],
      NOW,
      "channel:identity-unauthorized",
    ),
  ).toEqual({
    action: {
      type: "push-unreachable",
      detail: "channel:identity-unauthorized",
    },
  });
});

test("known channel failure terminates release of held mail honestly", () => {
  expect(
    decideHeldSettlements(
      "session-1",
      "accept",
      false,
      true,
      ARCHIVE,
      [receipt("held")],
      NOW,
      "channel:host-not-loaded",
    ),
  ).toEqual([
    {
      type: "push-unreachable",
      messageId: "msg-1",
      detail: "channel:host-not-loaded",
    },
  ]);
});
