import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClaimOwner, ClaimStore } from "./claims.ts";
import { projectSlug } from "./paths.ts";
import {
  WorkConflictError,
  type WorkOwner,
  WorkStore,
  WorkTransferSupersededError,
} from "./work.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture(): { project: string; workRoot: string; store: WorkStore } {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-work-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const workRoot = join(root, "work");
  return { project, workRoot, store: new WorkStore(workRoot) };
}

const ownerA: WorkOwner = {
  id: "agent-a",
  label: "Agent A",
  sessionId: "session-a",
  pid: 101,
  instanceId: "instance-a",
};
const ownerB: WorkOwner = {
  id: "agent-b",
  label: "Agent B",
  sessionId: "session-b",
  pid: 202,
  instanceId: "instance-b",
};

test("a logical resource has one active owner", () => {
  const { project, store } = fixture();
  const lease = store.acquire(
    project,
    { type: "research-plan", key: "2026-08-12-pilot" },
    ownerA,
  );

  expect(() =>
    store.acquire(
      project,
      { type: "research-plan", key: "2026-08-12-pilot" },
      ownerB,
    ),
  ).toThrow(WorkConflictError);
  expect(store.list(project)).toEqual([lease]);
});

test("acquisition is idempotent for the current owner", () => {
  const { project, store } = fixture();
  const first = store.acquire(
    project,
    { type: "research-plan", key: "2026-08-12-pilot" },
    ownerA,
    { activity: "Startup audit" },
  );
  const second = store.acquire(
    project,
    {
      type: "research-plan",
      key: "2026-08-12-pilot",
      label: "Pilot campaign",
    },
    ownerA,
    { activity: "Running G1" },
  );

  expect(second.id).toBe(first.id);
  expect(second.resource.label).toBe("Pilot campaign");
  expect(second.activity).toBe("Running G1");
  expect(store.list(project)).toHaveLength(1);
});

test("a stable session id does not let a replacement adopt live work", () => {
  const { project, store } = fixture();
  const original = store.acquire(
    project,
    { type: "research-plan", key: "same-session" },
    ownerA,
  );
  let livenessChecks = 0;
  const replacement = {
    ...ownerA,
    pid: 303,
    instanceId: "replacement-instance",
  };

  expect(() =>
    store.acquire(
      project,
      { type: "research-plan", key: "same-session" },
      replacement,
      {
        ownerIsLive: () => {
          livenessChecks += 1;
          return true;
        },
      },
    ),
  ).toThrow(WorkConflictError);
  expect(livenessChecks).toBe(1);
  expect(() =>
    store.update(project, original.id, replacement, { state: "waiting" }),
  ).toThrow("only its owner can update it");
  expect(() => store.release(project, original.id, replacement)).toThrow(
    "only its owner can release it",
  );
  expect(store.list(project)).toEqual([original]);
});

test("a definitively dead owner can be displaced", () => {
  const { project, store } = fixture();
  store.acquire(
    project,
    { type: "research-plan", key: "2026-08-12-pilot" },
    ownerA,
  );

  const replacement = store.acquire(
    project,
    { type: "research-plan", key: "2026-08-12-pilot" },
    ownerB,
    { ownerIsLive: (owner) => owner.id !== ownerA.id },
  );

  expect(replacement.owner).toEqual(ownerB);
  expect(store.list(project)).toEqual([replacement]);
});

test("takeover checks every duplicate record left by an interruption", () => {
  const { project, workRoot, store } = fixture();
  const canonical = realpathSync(project);
  const directory = join(workRoot, projectSlug(canonical));
  mkdirSync(directory, { recursive: true });
  const resource = { type: "task", key: "same" };
  const records = [
    {
      version: 1,
      id: "00-stale",
      project: canonical,
      resource,
      owner: ownerA,
      state: "working",
      createdAt: "2026-08-13T10:00:00.000Z",
      updatedAt: "2026-08-13T10:00:00.000Z",
      revision: 1,
    },
    {
      version: 1,
      id: "01-live",
      project: canonical,
      resource,
      owner: ownerB,
      state: "working",
      createdAt: "2026-08-13T10:01:00.000Z",
      updatedAt: "2026-08-13T10:01:00.000Z",
      revision: 1,
    },
  ];
  for (const record of records) {
    writeFileSync(join(directory, `${record.id}.json`), JSON.stringify(record));
  }

  expect(() =>
    store.acquire(
      project,
      resource,
      { id: "agent-c", label: "Agent C" },
      { ownerIsLive: (owner) => owner.id === ownerB.id },
    ),
  ).toThrow(WorkConflictError);
  expect(store.list(project).map((lease) => lease.id)).toEqual([
    "00-stale",
    "01-live",
  ]);
});

test("only the owner can update or release a work lease", () => {
  const { project, store } = fixture();
  const lease = store.acquire(
    project,
    { type: "research-plan", key: "2026-08-12-pilot" },
    ownerA,
  );

  expect(() =>
    store.update(project, lease.id, ownerB.id, { state: "waiting" }),
  ).toThrow("only its owner can update it");
  const waiting = store.update(project, lease.id, ownerA.id, {
    state: "waiting",
    activity: "Waiting for job 42",
  });
  expect(waiting.state).toBe("waiting");
  expect(() => store.release(project, lease.id, ownerB.id)).toThrow(
    "only its owner can release it",
  );
  expect(store.release(project, lease.id, ownerA.id)).toEqual(waiting);
});

test("leases carry a monotonic revision counter", () => {
  const { project, store } = fixture();
  const lease = store.acquire(
    project,
    { type: "research-plan", key: "2026-08-12-pilot" },
    ownerA,
  );
  expect(lease.revision).toBe(1);

  const updated = store.update(project, lease.id, ownerA.id, {
    state: "waiting",
  });
  expect(updated.revision).toBe(2);

  const same = store.acquire(
    project,
    { type: "research-plan", key: "2026-08-12-pilot" },
    ownerA,
  );
  expect(same.revision).toBe(3);
  expect(same.state).toBe("waiting");
});

test("transfer CAS uses revision, not updatedAt", () => {
  const { project, workRoot, store } = fixture();
  const canonical = realpathSync(project);
  const directory = join(workRoot, projectSlug(canonical));
  mkdirSync(directory, { recursive: true });
  const resource = { type: "task", key: "aba" };

  // Simulate a lease that has been updated twice within the same millisecond:
  // the updatedAt string is unchanged from the original, but revision advanced.
  const lease = {
    version: 1 as const,
    id: "aba-lease",
    project: canonical,
    resource,
    owner: ownerA,
    state: "working",
    createdAt: "2026-08-13T10:00:00.000Z",
    updatedAt: "2026-08-13T10:00:00.000Z",
    revision: 3,
  };
  writeFileSync(join(directory, `${lease.id}.json`), JSON.stringify(lease));

  // A transfer requested against revision 1 must fail even though the
  // updatedAt string still matches what revision 1 had.
  expect(() => store.transfer(project, lease.id, ownerA, 1, ownerB)).toThrow(
    WorkTransferSupersededError,
  );

  // A transfer against the current revision succeeds.
  const transferred = store.transfer(project, lease.id, ownerA, 3, ownerB);
  expect(transferred.owner).toEqual(ownerB);
});

test("listAll and releaseOwner span independent projects", () => {
  const { project, store } = fixture();
  const other = join(project, "other");
  mkdirSync(other);
  store.acquire(project, { type: "research-plan", key: "plan-a" }, ownerA);
  store.acquire(other, { type: "research-plan", key: "plan-b" }, ownerA);

  expect(store.listAll()).toHaveLength(2);
  expect(store.releaseOwner(project, ownerA.id)).toBe(1);
  expect(store.listAll().map((lease) => lease.resource.key)).toEqual([
    "plan-b",
  ]);
});

test("shutdown cleanup only releases work from the same owner process", () => {
  const { project, store } = fixture();
  const oldOwner = { ...ownerA, pid: 101 };
  const replacementOwner = { ...ownerA, pid: 202 };
  store.acquire(project, { type: "task", key: "old" }, oldOwner);
  const replacement = store.acquire(
    project,
    { type: "task", key: "replacement" },
    replacementOwner,
  );

  expect(store.releaseOwner(project, ownerA.id, oldOwner.pid)).toBe(1);
  expect(store.list(project)).toEqual([replacement]);
});

test("recovery only removes a lease whose owner is definitively offline", () => {
  const { project, store } = fixture();
  const lease = store.acquire(
    project,
    { type: "research-plan", key: "plan-a" },
    ownerA,
  );
  expect(() => store.recover(project, lease.id, () => true)).toThrow(
    "live or cannot be verified offline",
  );
  expect(store.recover(project, lease.id, () => false)).toEqual(lease);
  expect(store.listAll()).toEqual([]);
});

test("reported position persists until replaced or explicitly cleared", () => {
  const { project, store } = fixture();
  const resource = { type: "research-plan", key: "position" };
  const lease = store.acquire(project, resource, ownerA, {
    progress: { current: 2, total: 4, label: "Pilot" },
  });
  store.update(project, lease.id, ownerA, { activity: "Waiting for results" });
  expect(store.list(project)[0].progress).toEqual({
    current: 2,
    total: 4,
    label: "Pilot",
  });
  store.acquire(project, resource, ownerA, { state: "waiting" });
  expect(store.list(project)[0].progress?.current).toBe(2);
  store.update(project, lease.id, ownerA, { progress: { current: 3 } });
  expect(store.list(project)[0].progress).toEqual({ current: 3 });
  store.update(project, lease.id, ownerA, { progress: null });
  expect(store.list(project)[0].progress).toBeUndefined();
  store.acquire(project, resource, ownerA, { progress: { current: 1 } });
  store.acquire(project, resource, ownerA, { progress: null });
  expect(store.list(project)[0].progress).toBeUndefined();
});

test("invalid reported position cannot change a lease or displace its owner", () => {
  const { project, store } = fixture();
  const resource = { type: "research-plan", key: "validated-position" };
  const lease = store.acquire(project, resource, ownerA);
  for (const progress of [
    { current: 0 },
    { current: 1.5 },
    { current: Number.NaN },
    { current: Number.MAX_SAFE_INTEGER + 1 },
    { current: 2, total: 1 },
    { current: 1, total: 0 },
    { current: 1, total: 2.5 },
  ]) {
    expect(() =>
      store.update(project, lease.id, ownerA, { progress }),
    ).toThrow();
    expect(() =>
      store.acquire(project, resource, ownerB, {
        progress,
        ownerIsLive: () => false,
      }),
    ).toThrow();
    expect(store.list(project)).toEqual([lease]);
  }
});

test("plan claims require the current lease executor and follow lease outcomes", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-plan-claims-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const canonical = realpathSync(project);
  const claimStore = new ClaimStore(join(root, "claims"));
  const store = new WorkStore(join(root, "work"), claimStore);
  const lease = store.acquire(
    project,
    { type: "research-plan", key: "pilot" },
    ownerA,
  );
  const planOwner: ClaimOwner = {
    id: `plan:${canonical}:pilot`,
    label: "plan pilot",
    kind: "plan",
    plan: { project: canonical, stem: "pilot" },
  };

  expect(() =>
    claimStore.claimPath(
      project,
      join(project, "future.ts"),
      undefined,
      planOwner,
      {
        actor: ownerB,
        planExecutor: () => ownerA,
      },
    ),
  ).toThrow("only the current executor may acquire claims");
  const claim = claimStore.claimPath(
    project,
    join(project, "future.ts"),
    undefined,
    planOwner,
    {
      actor: ownerA,
      planExecutor: () => ownerA,
    },
  ).claim;

  store.release(project, lease.id, ownerA, "completed");
  expect(claimStore.list(project)).toEqual([]);
  expect(claimStore.listReleased(project)[0]).toMatchObject({
    id: claim.id,
    releaseReason: "plan-completed",
  });
});

test("plan lease transfer preserves claims and changes release authority", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-plan-transfer-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const canonical = realpathSync(project);
  const claimStore = new ClaimStore(join(root, "claims"));
  const store = new WorkStore(join(root, "work"), claimStore);
  const lease = store.acquire(
    project,
    { type: "research-plan", key: "pilot" },
    ownerA,
  );
  const planOwner: ClaimOwner = {
    id: `plan:${canonical}:pilot`,
    label: "plan pilot",
    kind: "plan",
    plan: { project: canonical, stem: "pilot" },
  };
  const claim = claimStore.claimPath(
    project,
    join(project, "future.ts"),
    undefined,
    planOwner,
    {
      actor: ownerA,
      planExecutor: () => ownerA,
    },
  ).claim;

  store.transfer(project, lease.id, ownerA, lease.revision, ownerB);
  expect(claimStore.list(project).map((item) => item.id)).toEqual([claim.id]);
  expect(() =>
    claimStore.release({
      claimId: claim.id,
      actor: ownerA,
      planExecutor: () => ownerB,
    }),
  ).toThrow("release requires its token or proven owner identity");
  expect(
    claimStore.release({
      claimId: claim.id,
      actor: ownerB,
      planExecutor: () => ownerB,
    }).disposition,
  ).toBe("released");
});
