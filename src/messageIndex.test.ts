import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReadOnlyState } from "./dashboardData.ts";
import { indexedMessages } from "./messageIndex.ts";
import { readStatePath, spoolPath } from "./paths.ts";
import { appendMessage, markMessagesRead } from "./spool.ts";

const at = new Date("2026-09-29T12:30:00.000Z");

function projectFixture(fn: (project: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-index-"));
  try {
    fn(join(root, "mailbox"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runInIsolatedHome(code: string): unknown {
  const home = mkdtempSync(join(tmpdir(), "agent-mail-index-home-"));
  try {
    const result = spawnSync("bun", ["-e", code], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, HOME: home, AGENT_MAIL_PORT: "0" },
      encoding: "utf8",
      timeout: 20_000,
    });
    if (result.status !== 0)
      throw new Error(result.stderr || String(result.error));
    return JSON.parse(result.stdout.trim()) as unknown;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("state reflects appended messages, late read marks, and project-scoped aggregates", () => {
  projectFixture((project) => {
    appendMessage({
      id: "root",
      ts: "2026-09-29T12:01:00.000Z",
      from: "sender",
      project,
      message: "first",
    });
    expect(indexedMessages(project, 2, at).totals).toEqual({
      messages: 1,
      projects: 1,
      threads: 1,
    });

    appendMessage({
      id: "reply",
      threadId: "root",
      replyTo: "root",
      ts: "2026-09-29T12:03:00.000Z",
      from: "sender",
      project,
      message: "second",
    });
    appendMessage({
      id: "audit",
      ts: "2026-09-29T12:02:00.000Z",
      from: "native",
      project,
      message: "recorded",
      delivery: "audit",
      meta: { nativeRecipient: "Claude" },
    });
    const state = indexedMessages(project, 2, at);
    expect(state.totals).toEqual({ messages: 3, projects: 1, threads: 2 });
    expect(state.messages.map((m) => m.id)).toEqual(["reply", "audit"]);
    expect(state.routes).toEqual([
      { from: "sender", to: "mailbox", count: 2 },
      { from: "native", to: "Claude", count: 1 },
    ]);
    expect(
      state.volume.find((bucket) => bucket.hour === "2026-09-29T12:00:00.000Z")
        ?.count,
    ).toBe(3);

    markMessagesRead(project, ["root"]);
    expect(
      indexedMessages(project, 3, at).messages.find((m) => m.id === "root")
        ?.read,
    ).toBe(true);
    writeFileSync(readStatePath(project), "");
    expect(
      indexedMessages(project, 3, at).messages.find((m) => m.id === "root")
        ?.read,
    ).toBe(false);
    writeFileSync(readStatePath(project), "reply\n");
    expect(
      indexedMessages(project, 3, at).messages.find((m) => m.id === "reply")
        ?.read,
    ).toBe(true);
    const surface = buildReadOnlyState({ project });
    expect(surface.totals.messages).toBe(3);
    expect(surface.messages.map((m) => m.id)).toEqual([
      "reply",
      "audit",
      "root",
    ]);
  });
});

test("unfinished lines wait for newline and source replacement rebuilds counts", () => {
  projectFixture((project) => {
    appendMessage({
      id: "first",
      ts: "2026-09-29T12:00:00.000Z",
      from: "sender",
      project,
      message: "long first message",
    });
    expect(indexedMessages(project, 60, at).totals.messages).toBe(1);
    const second = {
      id: "second",
      ts: "2026-09-29T12:02:00.000Z",
      from: "sender",
      project,
      message: "follow-up",
    };
    const path = spoolPath(project);
    appendFileSync(path, JSON.stringify(second));
    expect(indexedMessages(project, 60, at).messages.map((m) => m.id)).toEqual([
      "first",
    ]);
    appendFileSync(path, "\n");
    expect(indexedMessages(project, 60, at).messages.map((m) => m.id)).toEqual([
      "second",
      "first",
    ]);

    const replacement = `${path}.replacement`;
    writeFileSync(
      replacement,
      `${JSON.stringify({ ...second, id: "replacement" })}\n`,
    );
    renameSync(replacement, path);
    const replaced = indexedMessages(project, 60, at);
    expect(replaced.totals).toEqual({ messages: 1, projects: 1, threads: 1 });
    expect(replaced.messages.map((m) => m.id)).toEqual(["replacement"]);
  });
});

test("index cursors skip invalid message shapes and track raw bytes", () => {
  projectFixture((project) => {
    appendMessage({
      id: "first",
      ts: "2026-09-29T12:00:00.000Z",
      from: "sender",
      project,
      message: "valid",
    });
    appendFileSync(
      spoolPath(project),
      Buffer.concat([
        Buffer.from(
          `{"id":"bad","ts":"2026-09-29T12:01:00.000Z","from":"sender","project":${JSON.stringify(project)},"message":"`,
        ),
        Buffer.from([0xff]),
        Buffer.from('"}\n'),
      ]),
    );
    appendFileSync(
      spoolPath(project),
      `null\n[]\n{}\n{"project":${JSON.stringify(project)},"ts":"2026-09-29T12:01:30.000Z"}\n`,
    );
    appendMessage({
      id: "last",
      ts: "2026-09-29T12:02:00.000Z",
      from: "sender",
      project,
      message: "after bad byte",
    });
    expect(indexedMessages(project, 60, at).messages.map((m) => m.id)).toEqual([
      "last",
      "bad",
      "first",
    ]);
    expect(indexedMessages(project, 60, at).totals.messages).toBe(3);

    appendFileSync(
      readStatePath(project),
      Buffer.concat([
        Buffer.from("bad"),
        Buffer.from([0xff]),
        Buffer.from("\nlast\n"),
      ]),
    );
    expect(
      indexedMessages(project, 60, at).messages.find((m) => m.id === "last")
        ?.read,
    ).toBe(true);
    appendFileSync(readStatePath(project), "first\n");
    expect(
      indexedMessages(project, 60, at).messages.find((m) => m.id === "first")
        ?.read,
    ).toBe(true);
  });
});

test("a missing derived database rebuilds without losing read state", () => {
  const result = runInIsolatedHome(`
    import { mkdirSync, rmSync } from "node:fs";
    import { join } from "node:path";
    import { appendMessage, markMessagesRead } from "./src/spool.ts";
    import { indexedMessages } from "./src/messageIndex.ts";
    import { MESSAGE_INDEX_PATH } from "./src/paths.ts";
    const project = join(process.env.HOME, "mailbox");
    mkdirSync(project);
    appendMessage({ id: "root", ts: "2026-09-29T12:01:00.000Z", from: "sender", project, message: "persisted" });
    markMessagesRead(project, ["root"]);
    const before = indexedMessages(project, 60, new Date("2026-09-29T12:30:00.000Z"));
    for (const suffix of ["", "-wal", "-shm"]) rmSync(MESSAGE_INDEX_PATH + suffix, { force: true });
    const after = indexedMessages(project, 60, new Date("2026-09-29T12:30:00.000Z"));
    console.log(JSON.stringify({ before: before.messages[0].read, after: after.messages[0], total: after.totals.messages }));
  `);
  expect(result).toMatchObject({
    before: true,
    after: { id: "root", read: true },
    total: 1,
  });
});

test("global counts deduplicate thread IDs across projects", () => {
  const result = runInIsolatedHome(`
    import { mkdirSync } from "node:fs";
    import { join } from "node:path";
    import { appendMessage } from "./src/spool.ts";
    import { indexedMessages } from "./src/messageIndex.ts";
    const now = new Date("2026-09-29T12:30:00.000Z");
    for (const name of ["alpha", "beta"]) {
      const project = join(process.env.HOME, name);
      mkdirSync(project);
      appendMessage({ id: name, threadId: "shared", ts: now.toISOString(), from: "sender", project, message: name });
    }
    const state = indexedMessages(undefined, 60, now);
    console.log(JSON.stringify({ totals: state.totals, ids: state.messages.map((m) => m.id).sort() }));
  `);
  expect(result).toEqual({
    totals: { messages: 2, projects: 2, threads: 1 },
    ids: ["alpha", "beta"],
  });
});
