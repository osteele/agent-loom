import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerObligation } from "./ledgerIssues.ts";
import { type Obligation, obligations } from "./obligations.ts";
import {
  PRESENCE_SNAPSHOT_PATH,
  WEFT_JOBS_SNAPSHOT_PATH,
  WORK_DIR,
  ensureDirs,
  projectSlug,
} from "./paths.ts";
import { writePresenceSnapshot } from "./presence.ts";
import { type Registration, register } from "./registry.ts";
import {
  SESSION_STATUS_TTL_MS,
  SessionStatusCache,
  makeSessionStatus,
  statusWorkForSession,
  summarizeObligations,
} from "./sessionStatus.ts";
import { appendMessage } from "./spool.ts";
import {
  WEFT_RUNNING_SNAPSHOT_PATH,
  writeRunningJobsSnapshot,
  writeWeftJobsSnapshot,
} from "./weftJobs.ts";
import { type WorkLease, work } from "./work.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function registration(
  sessionId: string,
  overrides: Partial<Registration> = {},
): Registration {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agent-loom-status-")));
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

test("status joins work to the logical session across instance restarts and degrades work failures independently", async () => {
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
      items: expect.arrayContaining([
        expect.objectContaining({ id: lease.id, resourceKey: "owned" }),
        expect.objectContaining({ resourceKey: "obsolete" }),
      ]),
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

test("status work follows the logical session across quit-and-resume", () => {
  const lease: WorkLease = {
    version: 1,
    id: "lease-1",
    project: "/project",
    resource: { type: "research-plan", key: "plan-key" },
    owner: {
      id: "route-a",
      label: "Route A",
      sessionId: "route-a",
      pid: 1,
      instanceId: "instance-before-restart",
    },
    state: "working",
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:01:00.000Z",
    revision: 1,
  };
  const resumed = registration("route-a", {
    pid: 102,
    instanceId: "instance-after-restart",
  });
  expect(statusWorkForSession([lease], "route-a", [resumed])).toEqual({
    version: 1,
    items: [
      {
        id: "lease-1",
        resourceType: "research-plan",
        resourceKey: "plan-key",
        state: "working",
        updatedAt: "2026-09-12T00:01:00.000Z",
      },
    ],
  });
});

test("status work excludes other sessions, manual owners, and dead sessions", () => {
  const owned: WorkLease = {
    version: 1,
    id: "lease-1",
    project: "/project",
    resource: { type: "research-plan", key: "plan-key" },
    owner: { id: "route-a", label: "Route A", sessionId: "route-a", pid: 1 },
    state: "working",
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:01:00.000Z",
    revision: 1,
  };
  const manual: WorkLease = {
    ...owned,
    id: "lease-2",
    owner: { id: "cli:label", label: "label" },
  };
  const other: WorkLease = {
    ...owned,
    id: "lease-3",
    owner: { id: "route-b", label: "Route B", sessionId: "route-b" },
  };
  const live = registration("route-a");
  expect(statusWorkForSession([manual], "route-a", [live]).items).toEqual([]);
  expect(statusWorkForSession([other], "route-a", [live]).items).toEqual([]);
  expect(statusWorkForSession([owned], "route-a", []).items).toEqual([]);
});

test("published position survives a session restart and becomes unreported after clear", async () => {
  const owner = registration("reported-position");
  const lease = work.acquire(
    owner.cwd,
    { type: "plan", key: "position" },
    { id: "reported-position", label: "Reporter", sessionId: owner.sessionId },
    { progress: { current: 2, total: 3 } },
  );
  try {
    const cache = new SessionStatusCache();
    const resumed = { ...owner, pid: 202, instanceId: "resumed" };
    cache.refresh([resumed]);
    const reported = await cache
      .response(owner.cwd, "reported-position")
      .json();
    expect(reported.work.items[0].progress).toEqual({ current: 2, total: 3 });
    work.update(owner.cwd, lease.id, lease.owner.id, { progress: null });
    cache.refresh([resumed]);
    const cleared = await cache.response(owner.cwd, "reported-position").json();
    expect(cleared.work.version).toBe(1);
    expect(cleared.work.items[0].progress).toBeUndefined();
  } finally {
    work.release(owner.cwd, lease.id);
  }
});

test("source JSON CLI and cached daemon agree on exact-scoped counts, identity and always-present work", async () => {
  const owner = registration("json-status-owner");
  const ownerId = owner.sessionId;
  if (!ownerId) throw new Error("Fixture has no session identity");
  const now = Date.now();
  ensureDirs();
  const paths = [
    PRESENCE_SNAPSHOT_PATH,
    WEFT_JOBS_SNAPSHOT_PATH,
    WEFT_RUNNING_SNAPSHOT_PATH,
  ];
  const previous = paths.map((path) =>
    existsSync(path) ? readFileSync(path) : undefined,
  );
  const invoke = () =>
    spawnSync(
      process.execPath,
      [
        join(import.meta.dir, "cli.ts"),
        "status-line",
        "--json",
        "--project",
        owner.cwd,
        "--session",
        ownerId,
      ],
      {
        env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
        encoding: "utf8",
        timeout: 5000,
      },
    );
  try {
    writePresenceSnapshot(now, PRESENCE_SNAPSHOT_PATH, [owner]);
    writeWeftJobsSnapshot(
      {
        total: 8,
        bySession: { [ownerId]: 8 },
        groups: [
          {
            projectRoot: owner.cwd,
            project: "owner",
            submitterSession: ownerId,
            unattributedSession: false,
            dispositions: { completed_ok: 2 },
            total: 2,
          },
          {
            projectRoot: "/different/project",
            project: "other",
            submitterSession: ownerId,
            unattributedSession: false,
            dispositions: { completed_ok: 6 },
            total: 6,
          },
        ],
      },
      now,
    );
    writeRunningJobsSnapshot(
      [
        {
          projectRoot: owner.cwd,
          submitterSession: ownerId,
          count: 1,
        },
        {
          projectRoot: "/different/project",
          submitterSession: ownerId,
          count: 9,
        },
        { projectRoot: owner.cwd, submitterSession: "other-session", count: 8 },
      ],
      now,
    );
    const cache = new SessionStatusCache();
    cache.refresh([owner], now);
    const daemon = await cache.response(owner.cwd, ownerId, now).json();
    const source = invoke();
    expect(source.error).toBeUndefined();
    expect(source.status).toBe(0);
    const cli = JSON.parse(source.stdout);
    expect({ ...cli, generatedAt: 0 }).toEqual({ ...daemon, generatedAt: 0 });
    expect(cli).toMatchObject({
      version: 1,
      project: owner.cwd,
      sessionId: owner.sessionId,
      running: 1,
      unprocessed: 2,
      work: { version: 1, items: [] },
    });
    expect(cli.name.endsWith(cli.nameNoun)).toBe(true);
    rmSync(WEFT_RUNNING_SNAPSHOT_PATH);
    expect(JSON.parse(invoke().stdout).running).toBeNull();
    writeRunningJobsSnapshot([], now);
    expect(JSON.parse(invoke().stdout).running).toBe(0);
    const directory = join(WORK_DIR, projectSlug(owner.cwd));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "broken.json"), "{not JSON");
    const failed = invoke();
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain("status-line failed");
    rmSync(directory, { recursive: true, force: true });
  } finally {
    for (let index = 0; index < paths.length; index++) {
      const contents = previous[index];
      if (contents) writeFileSync(paths[index], contents);
      else rmSync(paths[index], { force: true });
    }
  }
});

// --- obligations summary -------------------------------------------------------
//
// The summary is the session-sized slice of the machine-global obligation
// store: what this session waits for, what waits on it, and — identically in
// every session's status, because the operator is one principal — what the
// human owes.

function obligation(overrides: Partial<Obligation> = {}): Obligation {
  return {
    version: 2,
    id: "ob-x",
    createdAt: "2026-09-12T00:00:00.000Z",
    obligee: {
      kind: "session",
      sessionId: "route-a",
      label: "Route A",
    },
    obligor: { kind: "session", sessionId: "route-b", label: "Route B" },
    kind: "decision",
    subject: "subject",
    status: "open",
    contested: false,
    revision: 1,
    ...overrides,
  };
}

test("the obligations summary counts waiting, owed, and the global human debt", () => {
  const waiting = obligation({ id: "ob-1" });
  const owed = obligation({
    id: "ob-2",
    obligee: { kind: "session", sessionId: "route-b", label: "Route B" },
    obligor: { kind: "session", sessionId: "route-a", label: "Route A" },
    kind: "claim_release",
  });
  const human = obligation({
    id: "ob-3",
    obligee: { kind: "session", sessionId: "route-b", label: "Route B" },
    obligor: { kind: "human", label: "user" },
    kind: "external_fix",
  });
  const open = [waiting, owed, human];

  expect(summarizeObligations(open, "route-a")).toEqual({
    waiting: 1,
    owed: 1,
    humanOwed: 1,
    roleOwed: 0,
    unresolvedOwed: 0,
  });
  expect(summarizeObligations(open, "route-b")).toEqual({
    waiting: 2,
    owed: 1,
    humanOwed: 1,
    roleOwed: 0,
    unresolvedOwed: 0,
  });
  // With no session named, the summary is the machine's: every open record
  // waits on someone, owed by a session or by the operator.
  expect(summarizeObligations(open)).toEqual({
    waiting: 3,
    owed: 2,
    humanOwed: 1,
    roleOwed: 0,
    unresolvedOwed: 0,
  });
});

test("a role obligor counts toward the session it resolves to, or as unresolved", () => {
  const role = {
    kind: "component_owner",
    component: "agent-loom",
  } as const;
  const owedByRole = obligation({
    id: "ob-role",
    obligor: {
      kind: "role",
      role,
      label: "owner of agent-loom",
    },
    kind: "external_fix",
  });
  const open = [owedByRole];
  const resolveToA = () => "route-a";
  expect(summarizeObligations(open, "route-a", resolveToA)).toEqual({
    waiting: 1,
    owed: 1,
    humanOwed: 0,
    roleOwed: 1,
    unresolvedOwed: 0,
  });
  // Another session does not see the role's debt as its own.
  expect(summarizeObligations(open, "route-b", resolveToA)).toEqual({
    waiting: 0,
    owed: 0,
    humanOwed: 0,
    roleOwed: 1,
    unresolvedOwed: 0,
  });
  // Without a resolver the summary never guesses a resolution.
  expect(summarizeObligations(open, "route-a")).toEqual({
    waiting: 1,
    owed: 0,
    humanOwed: 0,
    roleOwed: 1,
    unresolvedOwed: 1,
  });
  expect(summarizeObligations(open)).toEqual({
    waiting: 1,
    owed: 0,
    humanOwed: 0,
    roleOwed: 1,
    unresolvedOwed: 1,
  });
});

test("the obligations summary is absent without records and zeros with an empty store", () => {
  const owner = registration("summary-absent");
  const base = {
    project: owner.cwd,
    sessionId: "summary-absent",
    sessions: [owner],
    meta: new Map(),
    unread: 0,
    leases: [],
    jobs: undefined,
    running: undefined,
    nowMs: Date.parse("2026-09-27T00:00:00.000Z"),
  };
  expect("obligations" in makeSessionStatus(base)).toBe(false);
  expect(
    makeSessionStatus({ ...base, openObligations: [] }).obligations,
  ).toEqual({
    waiting: 0,
    owed: 0,
    humanOwed: 0,
    roleOwed: 0,
    unresolvedOwed: 0,
  });
});

// The per-session summary behind `state --json`, the status line, and the
// daemon cache is built here, not in summarizeObligations alone: a ledger
// issue must reach it through makeSessionStatus.
test("the session summary counts a ledger issue for its owner and its watcher", () => {
  const owner = registration("ledger-owner");
  const ledger: LedgerObligation[] = [
    {
      id: "issue:am17",
      kind: "external_fix",
      subject: "am17: fix the retry loop",
      component: "agent-loom",
      obligorRole: { kind: "component_owner", component: owner.cwd },
      ownerSessionId: "ledger-owner",
      obligees: ["ledger-watcher"],
      source: "issue-ledger",
      observedAt: Date.parse("2026-09-27T00:00:00.000Z"),
      stale: false,
    },
  ];
  const base = {
    project: owner.cwd,
    sessions: [owner],
    meta: new Map(),
    unread: 0,
    leases: [],
    jobs: undefined,
    running: undefined,
    openObligations: [],
    ledgerObligations: ledger,
    nowMs: Date.parse("2026-09-27T00:00:00.000Z"),
  };
  expect(
    makeSessionStatus({ ...base, sessionId: "ledger-owner" }).obligations?.owed,
  ).toBe(1);
  expect(
    makeSessionStatus({ ...base, sessionId: "ledger-watcher" }).obligations
      ?.waiting,
  ).toBe(1);
});

test("the cached status carries the session's obligations aggregate", async () => {
  const holder = registration("obligation-holder");
  const debtor = registration("obligation-debtor");
  // The singleton store verifies liveness against the registry, so both
  // sessions register — under this process's pid, which a live scan verifies.
  register(holder.cwd, process.pid, "obligation-holder");
  register(debtor.cwd, process.pid, "obligation-debtor");
  obligations.announce(
    {
      obligee: {
        kind: "session",
        sessionId: "obligation-holder",
        label: "Holder",
      },
      obligor: {
        kind: "session",
        sessionId: "obligation-debtor",
        label: "Debtor",
      },
      kind: "decision",
      subject: "pick a name",
    },
    { now: "2026-09-27T00:00:00.000Z" },
  );
  obligations.announce(
    {
      obligee: {
        kind: "session",
        sessionId: "obligation-debtor",
        label: "Debtor",
      },
      obligor: {
        kind: "session",
        sessionId: "obligation-holder",
        label: "Holder",
      },
      kind: "claim_release",
      subject: "claim-1",
    },
    { now: "2026-09-27T00:01:00.000Z" },
  );
  obligations.announce(
    {
      obligee: {
        kind: "session",
        sessionId: "obligation-holder",
        label: "Holder",
      },
      obligor: { kind: "human", label: "user" },
      kind: "external_fix",
      subject: "am17",
    },
    { now: "2026-09-27T00:02:00.000Z" },
  );
  const settled = obligations.announce(
    {
      obligee: {
        kind: "session",
        sessionId: "obligation-debtor",
        label: "Debtor",
      },
      obligor: {
        kind: "session",
        sessionId: "obligation-holder",
        label: "Holder",
      },
      kind: "decision",
      subject: "already closed",
    },
    { now: "2026-09-27T00:03:00.000Z" },
  );
  obligations.close(
    settled.id,
    { kind: "session", sessionId: "obligation-debtor", label: "Debtor" },
    "done",
    { now: "2026-09-27T00:04:00.000Z" },
  );

  const cache = new SessionStatusCache();
  cache.refresh([holder, debtor]);
  const holderView = await cache
    .response(holder.cwd, "obligation-holder")
    .json();
  expect(holderView.obligations).toEqual({
    waiting: 2,
    owed: 1,
    humanOwed: 1,
    roleOwed: 0,
    unresolvedOwed: 0,
  });
  const debtorView = await cache
    .response(debtor.cwd, "obligation-debtor")
    .json();
  expect(debtorView.obligations).toEqual({
    waiting: 1,
    owed: 1,
    humanOwed: 1,
    roleOwed: 0,
    unresolvedOwed: 0,
  });
});
