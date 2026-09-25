import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendChannelLifecycle,
  channelLifecycleRecord,
  recordChannelAttached,
  recordChannelShutdown,
} from "./channelLifecycle.ts";

function readRecords(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("lifecycle records omit fields that were not supplied", () => {
  const record = channelLifecycleRecord({
    event: "pruned",
    pid: 42,
    cwd: "/proj",
    cause: "no-process",
    now: new Date("2026-09-25T00:00:00.000Z"),
  });
  expect(JSON.parse(JSON.stringify(record))).toEqual({
    version: 1,
    timestamp: "2026-09-25T00:00:00.000Z",
    event: "pruned",
    pid: 42,
    cwd: "/proj",
    cause: "no-process",
  });
});

test("an unwritable log path does not throw on the exit path", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-lifecycle-"));
  try {
    const record = channelLifecycleRecord({
      event: "exit",
      pid: 1,
      cwd: "/",
    });
    // A directory where the file should be makes the append fail.
    expect(appendChannelLifecycle(record, root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attach then shutdown records one line each, and a repeat is ignored", () => {
  // The pair is what tells a clean exit from a kill: a server that logged
  // `attached` and later only `pruned` never ran its shutdown path.
  const root = mkdtempSync(join(tmpdir(), "agent-mail-lifecycle-"));
  const path = join(root, "nested", "lifecycle.jsonl");
  try {
    const identity = { sessionId: "s1", cwd: "/proj", client: "claude-code" };
    recordChannelAttached(identity, path);
    recordChannelAttached(identity, path);
    recordChannelShutdown("SIGTERM", path);
    recordChannelShutdown("stdin-close", path);
    const records = readRecords(path);
    expect(records.map((r) => r.event)).toEqual(["attached", "shutdown"]);
    expect(records[0]).toMatchObject({
      sessionId: "s1",
      cwd: "/proj",
      client: "claude-code",
      pid: process.pid,
    });
    expect(records[1]).toMatchObject({ sessionId: "s1", reason: "SIGTERM" });
    expect(JSON.stringify(records)).not.toContain("AGENT_SESSION_ID");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
