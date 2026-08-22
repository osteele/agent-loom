import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalProject } from "./paths.ts";
import { type Message, appendMessage, appendReceipt } from "./spool.ts";
import { unreadVisibleForSession } from "./unread.ts";

function makeProject(): { project: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-unread-"));
  return {
    project: canonicalProject(root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

let counter = 0;
function send(
  project: string,
  meta?: Record<string, string>,
  extra?: Partial<Message>,
): string {
  const id = `msg-${++counter}`;
  appendMessage({
    id,
    ts: new Date().toISOString(),
    from: "peer-project",
    project,
    message: "hello",
    meta,
    ...extra,
  });
  return id;
}

test("ordinary unread mail from another session is visible", () => {
  const { project, cleanup } = makeProject();
  try {
    const id = send(project, { sessionId: "sender" });
    expect(unreadVisibleForSession(project, "me").map((m) => m.id)).toEqual([
      id,
    ]);
  } finally {
    cleanup();
  }
});

test("a session's own sends are not its unread mail", () => {
  const { project, cleanup } = makeProject();
  try {
    send(project, { sessionId: "me" });
    expect(unreadVisibleForSession(project, "me")).toEqual([]);
    // ...but the same message is unread for every other session.
    expect(unreadVisibleForSession(project, "peer")).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("mail directed at another session is not visible", () => {
  const { project, cleanup } = makeProject();
  try {
    send(project, { sessionId: "sender", toSession: "other" });
    expect(unreadVisibleForSession(project, "me")).toEqual([]);
    expect(unreadVisibleForSession(project, "other")).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("refused and expired receipts exclude the message for that session only", () => {
  const { project, cleanup } = makeProject();
  try {
    const refused = send(project);
    const expired = send(project);
    const ts = new Date().toISOString();
    appendReceipt(project, {
      messageId: refused,
      ts,
      status: "refused",
      sessionId: "me",
    });
    appendReceipt(project, {
      messageId: expired,
      ts,
      status: "expired",
      sessionId: "me",
    });
    // The session that ended those deliveries does not see them re-counted;
    // a session with no such receipts still does.
    expect(unreadVisibleForSession(project, "me")).toEqual([]);
    expect(unreadVisibleForSession(project, "peer")).toHaveLength(2);
  } finally {
    cleanup();
  }
});

test("a read message is not unread, and an expired message is not visible", () => {
  const { project, cleanup } = makeProject();
  try {
    send(project, undefined, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(unreadVisibleForSession(project, "me")).toEqual([]);
  } finally {
    cleanup();
  }
});
