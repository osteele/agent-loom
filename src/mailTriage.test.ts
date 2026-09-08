import { expect, test } from "bun:test";
import { selectTriageCandidates } from "./mailTriage.ts";
import type { StoredMessage } from "./spool.ts";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");

function message(
  id: string,
  options: {
    read?: boolean;
    toSession?: string;
    delivery?: "mail" | "audit";
    expiresAt?: string;
  } = {},
): StoredMessage {
  return {
    id,
    ts: "2026-09-08T11:00:00.000Z",
    from: "sender",
    project: "/tmp/project",
    message: id,
    read: options.read ?? false,
    ...(options.toSession ? { meta: { toSession: options.toSession } } : {}),
    ...(options.delivery ? { delivery: options.delivery } : {}),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
  };
}

test("triage candidates include broadcasts and mail without a live recipient", () => {
  const selection = selectTriageCandidates(
    [
      message("broadcast"),
      message("dead", { toSession: "dead-session" }),
      message("live", { toSession: "live-session" }),
      message("read", { read: true }),
      message("audit", { delivery: "audit" }),
      message("expired", {
        expiresAt: "2026-09-08T11:30:00.000Z",
      }),
    ],
    [],
    ["live-session"],
    NOW,
  );

  expect(
    selection.messages.map(({ id, triageReason }) => ({ id, triageReason })),
  ).toEqual([
    { id: "broadcast", triageReason: "broadcast" },
    { id: "dead", triageReason: "recipient-not-live" },
  ]);
  expect(selection.counts).toEqual({
    unread: 5,
    candidates: 2,
    broadcast: 1,
    recipientNotLive: 1,
    recipientRefused: 0,
    liveRecipient: 1,
    nonDeliverable: 2,
  });
});

test("a resumed recipient keeps its direct mail out of the triage set", () => {
  const direct = message("direct", { toSession: "resumed-session" });

  expect(selectTriageCandidates([direct], [], [], NOW).messages).toHaveLength(
    1,
  );
  expect(
    selectTriageCandidates([direct], [], ["resumed-session"], NOW).messages,
  ).toEqual([]);
});

test("direct mail refused by its live recipient returns to project triage", () => {
  const direct = message("direct", { toSession: "live-session" });
  const receipts = [
    {
      messageId: direct.id,
      project: direct.project,
      ts: "2026-09-08T11:01:00.000Z",
      status: "refused" as const,
      sessionId: "live-session",
    },
  ];

  const selection = selectTriageCandidates(
    [direct],
    receipts,
    ["live-session"],
    NOW,
  );

  expect(selection.messages).toEqual([
    { ...direct, triageReason: "recipient-refused" },
  ]);
  expect(selection.counts.recipientRefused).toBe(1);
  expect(selection.counts.liveRecipient).toBe(0);
});
