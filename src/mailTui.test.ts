import { expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMailHistory, SessionMailMessage } from "./mailHistory.ts";
import { MailTimeline, formatMailHistory } from "./mailTui.ts";
import { projectSlug } from "./paths.ts";
import { watchDirectories, workTuiOptions } from "./workTui.ts";

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

test("the interactive TUI shows new mail on a directory event, not on the reconciliation timer", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-loom-tui-")));
  const home = join(root, "home");
  const project = join(root, "project");
  const state = join(home, ".claude", "agent-loom");
  for (const dir of [project, join(state, "inbox"), join(state, "receipts")])
    mkdirSync(dir, { recursive: true });
  const spool = join(state, "inbox", `${projectSlug(project)}.jsonl`);
  const line = (id: string) =>
    `${JSON.stringify({ id, ts: new Date().toISOString(), from: "sender", project, message: `body-${id}`, meta: { toSession: "owner" } })}\n`;
  writeFileSync(spool, line("first"));
  // A pseudo-terminal, so the child takes the interactive path.
  let screen = "";
  const decoder = new TextDecoder();
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "cli.ts"),
      "mail",
      "tui",
      "--session",
      "owner",
      "--project",
      project,
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      },
      terminal: {
        cols: 120,
        rows: 40,
        data(_terminal, bytes) {
          screen += decoder.decode(bytes);
        },
      },
    },
  );
  const until = async (text: string, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (!screen.includes(text) && Date.now() < deadline) await Bun.sleep(25);
    return screen.includes(text);
  };
  try {
    expect(await until("body-first", 10_000)).toBe(true);
    appendFileSync(spool, line("second"));
    // Reactive delivery on macOS is sub-second; its reconciliation pass is
    // 30 s. Elsewhere the 2 s poll also lands inside this bound.
    expect(await until("body-second", 8_000)).toBe(true);
  } finally {
    child.kill(9);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a directory that cannot be watched leaves no watches, so the TUI polls", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-loom-watch-")));
  const readable = join(root, "readable");
  mkdirSync(readable);
  try {
    // The watch on `readable` starts first; the missing one must close it.
    expect(
      watchDirectories(
        [readable, join(root, "missing")],
        () => {},
        () => {},
      ),
    ).toBeUndefined();
    const one = watchDirectories(
      [readable],
      () => {},
      () => {},
    );
    expect(one?.length).toBe(1);
    for (const watcher of one ?? []) watcher.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
