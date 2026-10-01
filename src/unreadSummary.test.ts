import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalProject } from "./paths.ts";
import { appendMessage } from "./spool.ts";
import {
  UNREAD_SUMMARY_SNAPSHOT_TTL_MS,
  computeUnreadSummary,
  readUnreadSummarySnapshot,
  writeUnreadSummarySnapshot,
} from "./unreadSummary.ts";

function makeProject(): string {
  return canonicalProject(mkdtempSync(join(tmpdir(), "agent-loom-summary-")));
}

let counter = 0;
function send(
  project: string,
  meta?: Record<string, string>,
  ts = new Date().toISOString(),
): string {
  const id = `sum-${++counter}`;
  appendMessage({ id, ts, from: "peer-project", project, message: "hi", meta });
  return id;
}

test("computeUnreadSummary groups sessions by project and filters per session", () => {
  const projectA = makeProject();
  const projectB = makeProject();
  const broadcast = send(projectA, undefined, "2026-08-01T10:00:00.000Z");
  send(projectA, { sessionId: "s1" }, "2026-08-01T10:01:00.000Z");
  const directed = send(
    projectA,
    { sessionId: "s3", toSession: "s2" },
    "2026-08-01T10:02:00.000Z",
  );
  const summary = computeUnreadSummary([
    { sessionId: "s1", cwd: projectA },
    { sessionId: "s2", cwd: projectA },
    { sessionId: "s3", cwd: projectB },
  ]);
  // s1: its own send is hidden; s3's directed mail is not addressed to it.
  expect(summary.s1).toEqual({
    project: projectA,
    unread: 1,
    newestId: broadcast,
    newestTs: "2026-08-01T10:00:00.000Z",
  });
  // s2: the broadcast, s1's send (only hidden from its author), and the mail
  // directed at it; the directed one is newest.
  expect(summary.s2).toEqual({
    project: projectA,
    unread: 3,
    newestId: directed,
    newestTs: "2026-08-01T10:02:00.000Z",
  });
  // s3: project B has no spool at all — an explicit zero, not a missing entry.
  expect(summary.s3).toEqual({
    project: projectB,
    unread: 0,
    newestId: null,
    newestTs: null,
  });
});

test("muted sessions and sessions without an id are omitted entirely", () => {
  const project = makeProject();
  send(project);
  const summary = computeUnreadSummary([
    { sessionId: "muted-session", cwd: project, muted: true },
    { sessionId: "live-session", cwd: project },
    { cwd: project },
  ]);
  expect(Object.keys(summary).sort()).toEqual(["live-session"]);
  expect(summary["live-session"].unread).toBe(1);
});

function tempSnapshotPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), "agent-loom-unread-summary-")),
    "unread-summary.json",
  );
}

const entry = {
  project: "/tmp/p",
  unread: 2,
  newestId: "m-9",
  newestTs: "2026-08-01T10:00:00.000Z",
};

test("a published snapshot round-trips", () => {
  const path = tempSnapshotPath();
  try {
    writeUnreadSummarySnapshot({ s1: entry }, 1000, path);
    const read = readUnreadSummarySnapshot(
      1000,
      UNREAD_SUMMARY_SNAPSHOT_TTL_MS,
      path,
    );
    expect(read?.bySession).toEqual({ s1: entry });
    expect(read?.generatedAt).toBe(1000);
  } finally {
    rmSync(path, { force: true });
  }
});

test("a snapshot past its TTL is not served", () => {
  const path = tempSnapshotPath();
  try {
    writeUnreadSummarySnapshot({ s1: entry }, 1000, path);
    const later = 1000 + UNREAD_SUMMARY_SNAPSHOT_TTL_MS + 1;
    expect(
      readUnreadSummarySnapshot(later, UNREAD_SUMMARY_SNAPSHOT_TTL_MS, path),
    ).toBe(undefined);
  } finally {
    rmSync(path, { force: true });
  }
});

test("a missing or malformed snapshot reads as unknown, never throws", () => {
  const path = tempSnapshotPath();
  expect(
    readUnreadSummarySnapshot(1000, UNREAD_SUMMARY_SNAPSHOT_TTL_MS, path),
  ).toBe(undefined);
  writeFileSync(path, "{ not json");
  expect(
    readUnreadSummarySnapshot(1000, UNREAD_SUMMARY_SNAPSHOT_TTL_MS, path),
  ).toBe(undefined);
  writeFileSync(path, JSON.stringify({ version: 99, generatedAt: 1000 }));
  expect(
    readUnreadSummarySnapshot(1000, UNREAD_SUMMARY_SNAPSHOT_TTL_MS, path),
  ).toBe(undefined);
  rmSync(path, { force: true });
});
