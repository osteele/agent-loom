import { expect, test } from "bun:test";
import type { SessionMailHistory, SessionMailMessage } from "./mailHistory.ts";
import { MailTimeline, formatMailHistory } from "./mailTui.ts";
import { workTuiOptions } from "./workTui.ts";

function entry(id: string): SessionMailMessage {
  return {
    key: id,
    id,
    direction: "incoming",
    timestamp: "2026-09-01T00:00:00Z",
    project: "/projects/a",
    sender: "sender",
    senderSessionId: "sender-id",
    recipients: ["owner"],
    broadcast: false,
    body: `first ${id}\nsecond ${id}\nthird ${id}`,
    replyTo: null,
    threadId: id,
  };
}

function history(ids: string[]): SessionMailHistory {
  return {
    kind: "session_mail_history",
    version: 1,
    project: "/projects/a",
    sessionId: "owner",
    generatedAt: 1000,
    messages: ids.map(entry),
  };
}

test("arrivals preserve the exact visible message and line offset while browsing", () => {
  const timeline = new MailTimeline(history(["newer", "middle", "oldest"]));
  timeline.render(100, 3);
  timeline.key({ name: "n" }, 3);
  timeline.render(100, 3);
  timeline.key({ name: "return" }, 3);
  timeline.render(100, 3);
  timeline.key({ name: "j" }, 3);
  const before = timeline.render(100, 3);
  const anchor = timeline.rows[timeline.offset];
  expect(anchor.key).toBe("middle");
  expect(anchor.offset).toBe(1);
  timeline.replace(history(["arrival", "newer", "middle", "oldest"]));
  const after = timeline.render(100, 3);
  expect(after.lines).toEqual(before.lines);
  expect(timeline.rows[timeline.offset]).toEqual(anchor);
  expect(timeline.expanded.has("middle")).toBe(true);
});

test("at the top arrivals follow immediately and returning to top resumes following", () => {
  const timeline = new MailTimeline(history(["first", "last"]));
  timeline.render(100, 3);
  timeline.replace(history(["arrival", "first", "last"]));
  expect(timeline.render(100, 3).lines[1]).toContain("arrival");
  timeline.key({ name: "n" }, 3);
  timeline.render(100, 3);
  timeline.key({ name: "g" }, 3);
  timeline.render(100, 3);
  timeline.replace(history(["latest", "arrival", "first", "last"]));
  expect(timeline.render(100, 3).lines[1]).toContain("latest");
  expect(timeline.offset).toBe(0);
  expect(() =>
    timeline.replace({ ...history([]), sessionId: "other" }),
  ).toThrow("binding changed");
});

test("expansion shows full bodies and reply information without terminal controls", () => {
  const snapshot = history(["message", "older"]);
  snapshot.messages[0] = {
    ...snapshot.messages[0],
    body: "first\n\u001b]52;secret\u0007\nthird",
    sender: "sender\nforged",
    replyTo: "parent",
    threadId: "thread",
  };
  const timeline = new MailTimeline(snapshot);
  expect(timeline.render(100, 10).lines.join("\n")).not.toContain("secret");
  timeline.key({ name: "return" }, 10);
  const expanded = timeline.render(100, 10).lines.join("\n");
  expect(expanded).toContain("\\u{1b}]52;secret\\u{7}");
  expect(expanded).toContain("Reply to: parent");
  expect(expanded).toContain("Thread: thread");
  expect(expanded).not.toContain("\u001b");
  expect(formatMailHistory(snapshot)).toContain("third");
});

test("mail selectors reuse the exact-session parser and identify their command in failures", () => {
  expect(() => workTuiOptions(["--project", "/"], "mail tui")).toThrow(
    "mail tui requires explicit",
  );
  expect(() =>
    workTuiOptions(
      ["--session", "owner", "--project", "/", "--once", "--once"],
      "mail tui",
    ),
  ).toThrow("each once");
});
