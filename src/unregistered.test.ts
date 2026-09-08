import { expect, test } from "bun:test";
import type { DeliveryReceipt } from "./spool.ts";
import { unregisteredActiveSessions } from "./unregistered.ts";

const NOW = Date.parse("2026-09-08T03:00:00.000Z");
const HOUR = 3_600_000;

function receipt(over: Partial<DeliveryReceipt>): DeliveryReceipt {
  return {
    messageId: "m",
    project: "/p",
    ts: "2026-09-08T02:59:00.000Z",
    status: "pushed",
    ...over,
  };
}

test("a session consuming mail with no registration is reported", () => {
  // The exact shape of the incident: the session pushed and stamped a receipt
  // while every sender-side reader said it was not listening.
  const found = unregisteredActiveSessions(
    [
      receipt({ sessionId: "lost", messageId: "a" }),
      receipt({
        sessionId: "lost",
        messageId: "b",
        ts: "2026-09-08T02:58:00.000Z",
      }),
      receipt({ sessionId: "registered", messageId: "c" }),
    ],
    new Set(["registered"]),
    NOW,
    HOUR,
  );
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({
    sessionId: "lost",
    project: "/p",
    receipts: 2,
    lastActivity: "2026-09-08T02:59:00.000Z",
  });
});

test("activity outside the window is not a live fault", () => {
  // Receipt logs are append-only and never pruned, so every session that ever
  // exited is in there. Without the window the detector would report the whole
  // history as broken and be ignored.
  expect(
    unregisteredActiveSessions(
      [receipt({ sessionId: "long-gone", ts: "2026-09-01T00:00:00.000Z" })],
      new Set(),
      NOW,
      HOUR,
    ),
  ).toEqual([]);
});

test("a session live in another project is not reported", () => {
  // Registration is per process, so one session may hold entries in several
  // projects; being live anywhere means the registry has not lost it.
  expect(
    unregisteredActiveSessions(
      [receipt({ sessionId: "elsewhere", project: "/other" })],
      new Set(["elsewhere"]),
      NOW,
      HOUR,
    ),
  ).toEqual([]);
});

test("receipts naming no session are skipped, not grouped together", () => {
  expect(
    unregisteredActiveSessions(
      [receipt({}), receipt({ messageId: "b" })],
      new Set(),
      NOW,
      HOUR,
    ),
  ).toEqual([]);
});

test("every session-stamped receipt proves recent activity", () => {
  const found = unregisteredActiveSessions(
    [
      receipt({ sessionId: "refused", status: "refused" }),
      receipt({ sessionId: "held", status: "held" }),
      receipt({ sessionId: "spooled", status: "spooled" }),
      receipt({ sessionId: "expired", status: "expired" }),
      receipt({ sessionId: "pushed", status: "pushed" }),
      receipt({ sessionId: "read", status: "read" }),
    ],
    new Set(),
    NOW,
    HOUR,
  );
  expect(found.map((session) => session.sessionId).sort()).toEqual([
    "expired",
    "held",
    "pushed",
    "read",
    "refused",
    "spooled",
  ]);
});

test("project and session components cannot collide", () => {
  const found = unregisteredActiveSessions(
    [
      receipt({ project: "/a", sessionId: "bc" }),
      receipt({ project: "/ab", sessionId: "c" }),
    ],
    new Set(),
    NOW,
    HOUR,
  );
  expect(found).toHaveLength(2);
});

test("an unparseable or future timestamp is not treated as recent", () => {
  expect(
    unregisteredActiveSessions(
      [
        receipt({ sessionId: "bad", ts: "not a date" }),
        receipt({ sessionId: "ahead", ts: "2027-01-01T00:00:00.000Z" }),
      ],
      new Set(),
      NOW,
      HOUR,
    ),
  ).toEqual([]);
});
