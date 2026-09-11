import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Registration } from "./registry.ts";
import { SESSION_STATUS_TTL_MS, SessionStatusCache } from "./sessionStatus.ts";
import { appendMessage } from "./spool.ts";
import { work } from "./work.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function registration(
  sessionId: string,
  overrides: Partial<Registration> = {},
): Registration {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agent-mail-status-")));
  directories.push(cwd);
  return {
    cwd,
    sessionId,
    pid: 101,
    instanceId: "instance-a",
    started: new Date().toISOString(),
    ...overrides,
  };
}

test("session status serves a bounded snapshot without collecting on reads", async () => {
  const owner = registration("cached-owner");
  const now = Date.now();
  const cache = new SessionStatusCache();
  expect(cache.response(owner.cwd, "cached-owner", now).status).toBe(503);
  cache.refresh([owner], now);
  const initial = await cache.response(owner.cwd, "cached-owner", now).json();
  expect(initial).toMatchObject({
    version: 1,
    project: owner.cwd,
    sessionId: "cached-owner",
    generatedAt: now,
    unread: 0,
  });
  appendMessage({
    id: "cached-message",
    project: owner.cwd,
    from: "sender",
    message: "visible after collection",
    ts: new Date(now).toISOString(),
  });
  expect(
    await cache.response(owner.cwd, "cached-owner", now + 1).json(),
  ).toEqual(initial);
  cache.refresh([owner], now + 2);
  expect(
    await cache.response(owner.cwd, "cached-owner", now + 2).json(),
  ).toMatchObject({ unread: 1, generatedAt: now + 2 });
  expect(
    cache.response(
      owner.cwd,
      "cached-owner",
      now + 2 + SESSION_STATUS_TTL_MS + 1,
    ).status,
  ).toBe(503);
  expect(cache.response(owner.cwd, "other-owner", now + 3).status).toBe(404);
  cache.refresh([], now + 4);
  expect(cache.response(owner.cwd, "cached-owner", now + 4).status).toBe(404);
});

test("status preserves exact project scope and muted counts without announcing them", async () => {
  const muted = registration("shared-id", { muted: true });
  const other = registration("shared-id");
  appendMessage({
    id: "muted-message",
    project: muted.cwd,
    from: "sender",
    message: "muted mail",
    ts: new Date().toISOString(),
  });
  appendMessage({
    id: "directed-message",
    project: muted.cwd,
    from: "sender",
    message: "other recipient",
    ts: new Date().toISOString(),
    meta: { toSession: "someone-else" },
  });
  const cache = new SessionStatusCache();
  const mutedOnly = cache.refresh([muted]);
  expect(mutedOnly.unreadSummary["shared-id"]).toBeUndefined();
  expect(await cache.response(muted.cwd, "shared-id").json()).toMatchObject({
    unread: 1,
  });
  cache.refresh([muted, other]);
  expect(await cache.response(muted.cwd, "shared-id").json()).toMatchObject({
    project: muted.cwd,
    unread: 1,
  });
  expect(await cache.response(other.cwd, "shared-id").json()).toMatchObject({
    project: other.cwd,
    unread: 0,
  });
});

test("status joins work to its component instance and degrades work failures independently", async () => {
  const owner = registration("work-owner");
  const sibling = {
    ...owner,
    pid: 202,
    instanceId: "push-component",
    capabilities: {
      tools: false,
      inboxPoll: false,
      channelPush: true,
      claims: false,
      workLeases: false,
      receipts: true,
      nativePeerMessaging: false,
      channelPushStatus: "authorized" as const,
    },
  };
  const lease = work.acquire(
    owner.cwd,
    { type: "test", key: "owned" },
    {
      id: "owner",
      label: "Owner",
      sessionId: "work-owner",
      pid: owner.pid,
      instanceId: owner.instanceId,
    },
  );
  work.acquire(
    owner.cwd,
    { type: "test", key: "obsolete" },
    {
      id: "retired-owner",
      label: "Retired",
      sessionId: "work-owner",
      pid: owner.pid,
      instanceId: "old-instance",
    },
  );
  const cache = new SessionStatusCache();
  cache.refresh([owner, sibling]);
  const status = await cache.response(owner.cwd, "work-owner").json();
  expect(status).toMatchObject({
    peers: 0,
    delivery: "push",
    work: {
      version: 1,
      items: [expect.objectContaining({ id: lease.id, resourceKey: "owned" })],
    },
  });
  const failure = spyOn(work, "list").mockImplementation(() => {
    throw new Error("work unavailable");
  });
  try {
    const refreshed = cache.refresh([owner, sibling]);
    expect(refreshed.errors).toEqual([
      expect.stringContaining("work unavailable"),
    ]);
    expect(await cache.response(owner.cwd, "work-owner").json()).toMatchObject({
      unread: 0,
      delivery: "push",
      work: null,
    });
  } finally {
    failure.mockRestore();
  }
});
