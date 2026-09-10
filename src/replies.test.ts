import { expect, test } from "bun:test";
import { replyRecipient } from "./replies.ts";
import type { Message } from "./spool.ts";

const parent: Message = {
  id: "question",
  ts: "2026-09-11T00:00:00Z",
  from: "display label",
  project: "/question-mailbox",
  message: "question",
  meta: { sessionId: "sender" },
};

test("replies refuse missing, unstamped, dead, and ambiguous senders", () => {
  const registrations = [{ sessionId: "sender", cwd: "/sender-mailbox" }];
  expect(replyRecipient(undefined, registrations).ok).toBe(false);
  expect(
    replyRecipient(
      { ...parent, meta: undefined, from: "sender" },
      registrations,
    ).ok,
  ).toBe(false);
  expect(replyRecipient(parent, []).ok).toBe(false);
  expect(
    replyRecipient(parent, [
      ...registrations,
      { sessionId: "sender", cwd: "/other-mailbox" },
    ]).ok,
  ).toBe(false);
});

test("multiple transports in the same mailbox still identify one reply recipient", () => {
  expect(
    replyRecipient(parent, [
      { sessionId: "sender", cwd: "/sender-mailbox" },
      { sessionId: "sender", cwd: "/sender-mailbox" },
      { sessionId: "bystander", cwd: "/other-mailbox" },
    ]),
  ).toEqual({ ok: true, project: "/sender-mailbox", sessionId: "sender" });
});
