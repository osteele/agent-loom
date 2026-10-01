import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimStore } from "./claims.ts";
import {
  MANUAL_OWNER_TTL_MS,
  coordinationConflictAdvice,
  describeCoordination,
  isDisplaceable,
  listCoordination,
  ownerStatus,
  recordForcedRecovery,
  recoverCoordination,
} from "./coordination.ts";
import { ObligationStore, obligations } from "./obligations.ts";
import { type Registration, register } from "./registry.ts";
import { WorkStore } from "./work.ts";

const PROJECT = "/project";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test("owner status distinguishes live, offline, and manual owners", () => {
  const registration: Registration = {
    cwd: "/project",
    pid: 42,
    sessionId: "session-a",
    started: "2026-08-12T00:00:00.000Z",
  };
  expect(
    ownerStatus(
      { id: "session-a", label: "A", sessionId: "session-a", pid: 42 },
      [registration],
    ),
  ).toBe("live");
  expect(
    ownerStatus(
      { id: "session-a", label: "A", sessionId: "session-a", pid: 43 },
      [registration],
    ),
  ).toBe("offline");
  expect(
    ownerStatus(
      {
        id: "session-a",
        label: "A",
        sessionId: "session-a",
        pid: 42,
        procStart: "different process",
      },
      [{ ...registration, procStart: "registered process" }],
    ),
  ).toBe("offline");
  expect(ownerStatus({ id: "cli", label: "operator" }, [registration])).toBe(
    "manual",
  );
});

test("an unavailable process scan does not classify a PID owner as offline", () => {
  expect(
    ownerStatus(
      { id: "cli:42", label: "cli", pid: 42 },
      [],
      "2026-08-13T12:00:00.000Z",
      { processes: new Map(), reliable: false },
    ),
  ).toBe("unverifiable");
});

test("unavailable PID evidence is surfaced as owner-unverifiable", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-unverifiable-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const workStore = new WorkStore(join(root, "work"));
  workStore.acquire(
    project,
    { type: "task", key: "legacy" },
    { id: "cli:42", label: "legacy", pid: 42 },
  );
  const entry = listCoordination({
    project,
    registrations: [],
    processes: { processes: new Map(), reliable: false },
    claimStore: new ClaimStore(join(root, "claims")),
    workStore,
  })[0];
  expect(entry.ownerStatus).toBe("unverifiable");
  expect(entry.condition).toBe("owner-unverifiable");
  expect(entry.recoverable).toBe(false);
});

test("a replacement registration cannot adopt a legacy session-owned record", () => {
  const owner = {
    id: "session-a",
    label: "A",
    sessionId: "session-a",
    pid: 42,
  };
  const replacement: Registration = {
    cwd: "/project",
    pid: 42,
    procStart: "new process",
    sessionId: "session-a",
    started: "2026-08-13T13:00:00.000Z",
  };
  expect(ownerStatus(owner, [replacement], "2026-08-13T12:00:00.000Z")).toBe(
    "offline",
  );
});

test("a process instance remains exact without a process-start timestamp", () => {
  const registration: Registration = {
    cwd: "/project",
    pid: 42,
    sessionId: "session-a",
    instanceId: "current",
    started: "2026-08-13T12:00:00.000Z",
  };
  expect(
    ownerStatus(
      {
        id: "session-a",
        label: "A",
        sessionId: "session-a",
        pid: 42,
        instanceId: "current",
      },
      [registration],
    ),
  ).toBe("live");
  expect(
    ownerStatus(
      {
        id: "session-a",
        label: "A",
        sessionId: "session-a",
        pid: 42,
        instanceId: "previous",
      },
      [registration],
    ),
  ).toBe("offline");
});

test("legacy PID-only owners become offline after exit or PID recycling", () => {
  const owner = { id: "cli:42", label: "cli", pid: 42 };
  const createdAt = "2026-08-13T12:00:00.000Z";

  expect(ownerStatus(owner, [], createdAt, new Map())).toBe("offline");
  expect(
    ownerStatus(
      owner,
      [],
      createdAt,
      new Map([
        [42, { start: "Thu Aug 13 07:00:00 2020", command: "agent-loom" }],
      ]),
    ),
  ).toBe("live");
  expect(
    ownerStatus(
      owner,
      [],
      createdAt,
      new Map([
        [42, { start: "Thu Aug 13 07:00:00 2030", command: "unrelated" }],
      ]),
    ),
  ).toBe("offline");
});

test("coordination makes dead legacy CLI work recoverable", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-coordination-cli-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const workStore = new WorkStore(join(root, "work"));
  workStore.acquire(
    project,
    { type: "research-plan", key: "plan" },
    { id: "cli:66204", label: "cli", pid: 66204 },
  );

  const entry = listCoordination({
    project,
    registrations: [],
    processes: new Map(),
    claimStore: new ClaimStore(join(root, "claims")),
    workStore,
  })[0];
  expect(entry.ownerStatus).toBe("offline");
  expect(entry.condition).toBe("owner-offline");
  expect(entry.recoverable).toBe(true);
});

test("coordination conditions preserve the different resource lifecycles", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-coordination-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const notebook = join(project, "lab-notebook");
  mkdirSync(join(notebook, "experiments"), { recursive: true });
  const claimStore = new ClaimStore(join(root, "claims"));
  const workStore = new WorkStore(join(root, "work"));
  const owner = { id: "operator", label: "operator" };
  const experiment = claimStore.claimExperiment(project, notebook, owner);
  claimStore.claimPath(project, join(project, "future.md"), "file", owner);
  workStore.acquire(
    project,
    {
      type: "research-plan",
      key: "plan",
      sourcePath: join(project, "missing-plan.md"),
    },
    owner,
  );

  let entries = listCoordination({
    project,
    registrations: [],
    claimStore,
    workStore,
  });
  expect(entries.find((entry) => entry.id === experiment.id)?.condition).toBe(
    "awaiting-materialization",
  );
  expect(entries.find((entry) => entry.kind === "path-claim")?.condition).toBe(
    "healthy",
  );
  expect(entries.find((entry) => entry.kind === "work")?.condition).toBe(
    "source-missing",
  );

  mkdirSync(join(notebook, "experiments", "EXP-001-scratch"));
  writeFileSync(join(notebook, "experiments", "EXP-001-notes.txt"), "");
  entries = listCoordination({
    project,
    registrations: [],
    claimStore,
    workStore,
  });
  expect(entries.find((entry) => entry.id === experiment.id)?.condition).toBe(
    "awaiting-materialization",
  );

  writeFileSync(join(notebook, "experiments", "EXP-001-pilot.md"), "");
  entries = listCoordination({
    project,
    registrations: [],
    claimStore,
    workStore,
  });
  expect(entries.find((entry) => entry.id === experiment.id)?.condition).toBe(
    "materialized",
  );
});

test("plan claim status follows a lease in another project", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-cross-plan-"));
  temporaryDirectories.push(root);
  const planProject = join(root, "plans");
  const targetProject = join(root, "target");
  mkdirSync(planProject);
  mkdirSync(targetProject);
  const claimStore = new ClaimStore(join(root, "claims"));
  const workStore = new WorkStore(join(root, "work"), claimStore);
  const executor = {
    id: "session-a",
    label: "Quiet Lantern",
    kind: "session" as const,
    sessionId: "session-a",
    pid: process.pid,
    instanceId: "session-a-instance",
  };
  workStore.acquire(
    planProject,
    { type: "research-plan", key: "pilot" },
    executor,
  );
  const canonicalPlanProject = realpathSync(planProject);
  const planOwner = {
    id: `plan:${canonicalPlanProject}:pilot`,
    label: "plan pilot",
    kind: "plan" as const,
    plan: { project: canonicalPlanProject, stem: "pilot" },
  };
  const claim = claimStore.claimPath(
    targetProject,
    join(targetProject, "future.ts"),
    undefined,
    planOwner,
    {
      actor: executor,
      planExecutor: () => executor,
    },
  ).claim;

  const entry = listCoordination({
    project: targetProject,
    registrations: [],
    claimStore,
    workStore,
  }).find((candidate) => candidate.id === claim.id);
  expect(entry?.ownerStatus).toBe("plan");
  expect(entry?.condition).toBe("healthy");
});

test("live-owner conflict advice only offers a transfer for work leases", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-coordination-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const notebook = join(project, "lab-notebook");
  mkdirSync(join(notebook, "experiments"), { recursive: true });
  const claimStore = new ClaimStore(join(root, "claims"));
  const workStore = new WorkStore(join(root, "work"));
  const owner = {
    id: "session-a",
    label: "Quiet Lantern",
    sessionId: "session-a",
    pid: process.pid,
  };
  const registration: Registration = {
    cwd: project,
    pid: process.pid,
    sessionId: "session-a",
    started: "2026-08-17T00:00:00.000Z",
  };
  claimStore.claimExperiment(project, notebook, owner);
  claimStore.claimPath(project, join(project, "notes.md"), "file", owner);
  workStore.acquire(project, { type: "research-plan", key: "plan" }, owner);

  const advice = new Map(
    listCoordination({
      project,
      registrations: [registration],
      claimStore,
      workStore,
    }).map((entry) => {
      expect(entry.ownerStatus).toBe("live");
      return [entry.kind, coordinationConflictAdvice(entry)];
    }),
  );

  expect(advice.get("work")).toContain("request_coordination_transfer");
  for (const kind of ["path-claim", "experiment-claim"] as const) {
    const text = advice.get(kind) ?? "";
    expect(text).not.toContain("request_coordination_transfer");
    expect(text).toContain("not transferable");
    expect(text).toContain("Quiet Lantern");
  }
});

test("recordForcedRecovery appends one JSON line per forced recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-forced-"));
  temporaryDirectories.push(root);
  const logPath = join(root, "nested", "forced-recoveries.jsonl");
  const base = {
    at: "2026-08-16T00:00:00.000Z",
    kind: "path-claim" as const,
    project: "/project",
    resourceType: "edit-set",
    resourceLabel: "2 claimed paths",
    ownerLabel: "Nimble Cloud",
    ownerStatus: "manual" as const,
  };

  expect(
    recordForcedRecovery(
      {
        ...base,
        authority: "operator: session is gone",
        reason: "verified abandoned terminal",
        coordinationId: "c1",
      },
      logPath,
    ).logged,
  ).toBe(true);
  expect(
    recordForcedRecovery(
      {
        ...base,
        authority: "operator: second",
        reason: "second verified recovery",
        coordinationId: "c2",
      },
      logPath,
    ).logged,
  ).toBe(true);

  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  const first = JSON.parse(lines[0]);
  expect(first.authority).toBe("operator: session is gone");
  expect(first.reason).toBe("verified abandoned terminal");
  expect(first.coordinationId).toBe("c1");
  expect(first.ownerStatus).toBe("manual");
  expect(JSON.parse(lines[1]).coordinationId).toBe("c2");
});

test("recordForcedRecovery reports failure instead of throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-forced-fail-"));
  temporaryDirectories.push(root);
  // A regular file where the log's parent directory must be: mkdirSync fails.
  const blocker = join(root, "blocker");
  writeFileSync(blocker, "");
  const result = recordForcedRecovery(
    {
      at: "2026-08-16T00:00:00.000Z",
      authority: "operator",
      reason: "verified orphaned lease",
      coordinationId: "c1",
      kind: "work",
      project: "/project",
      resourceType: "research-plan",
      resourceLabel: "plan",
      ownerLabel: "peer",
      ownerStatus: "live",
    },
    join(blocker, "forced.jsonl"),
  );
  expect(result.logged).toBe(false);
  expect(result.error).toBeDefined();
});

test("the store liveness gate is what a forced recovery stands down", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-force-release-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const claimStore = new ClaimStore(join(root, "claims"));
  const owner = { id: "peer", label: "Peer" };
  const target = join(project, "held.md");
  writeFileSync(target, "");
  const claim = claimStore.claimPath(project, target, "file", owner).claim;

  // Default behavior: a live owner is never displaced.
  expect(() => claimStore.recover(project, claim.id, () => true)).toThrow(
    /its owner is live or cannot be verified offline/,
  );
  expect(claimStore.list(project)).toHaveLength(1);

  // Forced behavior: recoverCoordination passes `() => false` when an authority
  // is declared, which releases the record regardless of owner liveness.
  const released = claimStore.recover(project, claim.id, () => false);
  expect(released.id).toBe(claim.id);
  expect(claimStore.list(project)).toHaveLength(0);
});

// --- manual owners expire -----------------------------------------------------
//
// A manual owner has no recorded process, so it can never be proven dead and
// used to be held until an operator broke it by hand. Containerized agents left
// these behind routinely. Time is the only available bound, since identity is
// not.

const MANUAL = { id: "cli:codex-root", label: "codex-root" };

test("a fresh manual owner still holds its resource", () => {
  const created = "2026-08-13T00:00:00.000Z";
  const now = Date.parse(created) + MANUAL_OWNER_TTL_MS - 60_000;
  const status = ownerStatus(
    MANUAL,
    [],
    created,
    undefined,
    true,
    undefined,
    now,
  );
  expect(status).toBe("manual");
  expect(isDisplaceable(status)).toBe(false);
});

test("a manual owner past the TTL becomes displaceable", () => {
  const created = "2026-08-13T00:00:00.000Z";
  const now = Date.parse(created) + MANUAL_OWNER_TTL_MS;
  const status = ownerStatus(
    MANUAL,
    [],
    created,
    undefined,
    true,
    undefined,
    now,
  );
  expect(status).toBe("expired");
  expect(isDisplaceable(status)).toBe(true);
});

test("a manual owner that renews keeps its resource", () => {
  // Renewal is the escape hatch that makes the TTL safe for long work: an owner
  // still on the job updates the record and the clock restarts.
  const created = "2026-08-13T00:00:00.000Z";
  const renewed = "2026-08-20T00:00:00.000Z";
  const now = Date.parse(renewed) + 60_000;
  expect(ownerStatus(MANUAL, [], created, undefined, true, renewed, now)).toBe(
    "manual",
  );
});

test("expiry never applies to an owner with a real process identity", () => {
  // The TTL is a fallback for records that cannot be checked, not a cap on how
  // long a live session may hold something.
  const old = "2026-01-01T00:00:00.000Z";
  const registration = {
    cwd: "/proj",
    pid: 42,
    sessionId: "s",
    procStart: "same process",
    started: old,
  };
  expect(
    ownerStatus(
      {
        id: "s",
        label: "Live",
        sessionId: "s",
        pid: 42,
        procStart: "same process",
      },
      [registration],
      old,
      undefined,
      true,
      undefined,
      Date.parse(old) + 400 * 24 * 3600_000,
    ),
  ).toBe("live");
});

test("an expired manual owner is reported as recoverable", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-expired-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const workStore = new WorkStore(join(root, "work"));
  const lease = workStore.acquire(
    project,
    { type: "task", key: "abandoned" },
    MANUAL,
  );
  // Backdate the lease past the TTL the way an abandoned container would.
  const stale = new Date(
    Date.now() - MANUAL_OWNER_TTL_MS - 60_000,
  ).toISOString();
  // Locate the lease rather than assume the store's on-disk layout.
  const workRoot = join(root, "work");
  const path = readdirSync(workRoot, { recursive: true })
    .map((entry) => join(workRoot, String(entry)))
    .find((candidate) => candidate.endsWith(`${lease.id}.json`));
  if (!path) throw new Error(`lease file for ${lease.id} not found`);
  writeFileSync(
    path,
    JSON.stringify({
      ...JSON.parse(readFileSync(path, "utf8")),
      createdAt: stale,
      updatedAt: stale,
    }),
  );
  const entry = listCoordination({
    project,
    registrations: [],
    processes: { processes: new Map(), reliable: true },
    claimStore: new ClaimStore(join(root, "claims")),
    workStore: new WorkStore(join(root, "work")),
  })[0];
  expect(entry.ownerStatus).toBe("expired");
  expect(entry.condition).toBe("owner-expired");
  expect(entry.recoverable).toBe(true);
});

// --- obligations in the join ---------------------------------------------------
//
// Open obligations join the cross-project coordination view with the obligor
// as owner. Records are machine-global: they carry no project, so only the
// --all view lists them, and their store is injected the way the claim and
// work stores are.

function obligationStore(root: string): ObligationStore {
  // Announce and contest consult this predicate; the join's own liveness
  // verdict comes from the registrations handed to listCoordination.
  return new ObligationStore({
    root: join(root, "obligations"),
    isLive: () => true,
  });
}

const OBLIGATION_CREATED = "2026-09-27T00:00:00.000Z";

function seedDecision(store: ObligationStore): { id: string } {
  return store.announce(
    {
      obligee: {
        kind: "session" as const,
        sessionId: "session-a",
        label: "Quiet Lantern",
      },
      obligor: {
        kind: "session",
        sessionId: "session-b",
        label: "Nimble Cloud",
      },
      kind: "decision",
      subject: "pick the release name",
    },
    { now: OBLIGATION_CREATED },
  );
}

function joinEntries(
  root: string,
  store: ObligationStore,
  registrations: Registration[],
) {
  return listCoordination({
    allProjects: true,
    registrations,
    claimStore: new ClaimStore(join(root, "claims")),
    workStore: new WorkStore(join(root, "work")),
    obligationsStore: store,
  });
}

test("an open obligation joins the cross-project view with the obligor as owner", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-obligation-join-"));
  temporaryDirectories.push(root);
  const store = obligationStore(root);
  const decision = seedDecision(store);
  const obligor: Registration = {
    cwd: "/project",
    pid: 42,
    sessionId: "session-b",
    started: OBLIGATION_CREATED,
  };

  const entry = joinEntries(root, store, [obligor]).find(
    (candidate) => candidate.id === decision.id,
  );
  expect(entry).toMatchObject({
    kind: "obligation",
    resourceType: "obligation",
    resourceKey: "decision:pick the release name",
    obligee: "Quiet Lantern",
    ownerStatus: "live",
    condition: "healthy",
    contested: false,
    state: "open",
    recoverable: false,
    createdAt: OBLIGATION_CREATED,
  });
  expect(entry?.owner.label).toBe("Nimble Cloud");
});

test("a dead session obligor surfaces owner-offline and never recovery advice", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-obligation-dead-"));
  temporaryDirectories.push(root);
  const store = obligationStore(root);
  const decision = seedDecision(store);

  const entry = joinEntries(root, store, []).find(
    (candidate) => candidate.id === decision.id,
  );
  if (!entry) throw new Error("obligation missing from the join");
  expect(entry).toMatchObject({
    ownerStatus: "offline",
    condition: "owner-offline",
    recoverable: false,
  });
  const advice = coordinationConflictAdvice(entry);
  expect(advice).toContain("Quiet Lantern");
  expect(advice).not.toContain("recover");
});

test("a contested obligation stays visible and carries its reason", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-obligation-contest-"));
  temporaryDirectories.push(root);
  const store = obligationStore(root);
  const decision = seedDecision(store);
  store.contest(
    decision.id,
    { sessionId: "session-b" },
    "the decision was already made",
  );
  const obligor: Registration = {
    cwd: "/project",
    pid: 42,
    sessionId: "session-b",
    started: OBLIGATION_CREATED,
  };

  const entry = joinEntries(root, store, [obligor]).find(
    (candidate) => candidate.id === decision.id,
  );
  if (!entry) throw new Error("obligation missing from the join");
  expect(entry).toMatchObject({
    ownerStatus: "live",
    contested: true,
    state: "open",
  });
  expect(entry.activity).toBe("contested: the decision was already made");
  expect(describeCoordination(entry)).toContain(
    "the decision was already made",
  );
});

test("a human obligor is owned by the operator without a liveness check", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-obligation-human-"));
  temporaryDirectories.push(root);
  const store = obligationStore(root);
  const owed = store.announce(
    {
      obligee: {
        kind: "session" as const,
        sessionId: "session-a",
        label: "Quiet Lantern",
      },
      obligor: { kind: "human", label: "user" },
      kind: "external_fix",
      subject: "am17",
    },
    { now: OBLIGATION_CREATED },
  );

  // Empty registrations: a session obligor would read offline here; the
  // operator is never liveness-checked.
  const entry = joinEntries(root, store, []).find(
    (candidate) => candidate.id === owed.id,
  );
  if (!entry) throw new Error("obligation missing from the join");
  expect(entry).toMatchObject({
    resourceKey: "external_fix:am17",
    ownerStatus: "manual",
    condition: "healthy",
    recoverable: false,
  });
  expect(entry.owner.label).toBe("user");
});

test("obligations list only in the cross-project view and leave it when settled", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-obligation-scope-"));
  temporaryDirectories.push(root);
  const store = obligationStore(root);
  const decision = seedDecision(store);
  const project = join(root, "project");
  mkdirSync(project);

  const scoped = listCoordination({
    project,
    registrations: [],
    claimStore: new ClaimStore(join(root, "claims")),
    workStore: new WorkStore(join(root, "work")),
    obligationsStore: store,
  });
  expect(scoped.some((entry) => entry.kind === "obligation")).toBe(false);

  store.close(
    decision.id,
    { kind: "session", sessionId: "session-a", label: "Quiet Lantern" },
    "picked",
    { now: "2026-09-27T01:00:00.000Z" },
  );
  const joined = joinEntries(root, store, []);
  expect(joined.some((entry) => entry.id === decision.id)).toBe(false);
});

test("coordination recovery refuses obligation records", () => {
  // recoverCoordination reads the process-wide stores, so this record is
  // seeded through the singleton — which requires the sessions it names to
  // be registered live.
  register(PROJECT, process.pid, "session-a");
  // A distinct, certainly-live pid: registry entries are keyed by project and
  // pid, so a second register under process.pid would overwrite the first.
  register(PROJECT, process.ppid, "session-b");
  const decision = obligations.announce(
    {
      obligee: {
        kind: "session" as const,
        sessionId: "session-a",
        label: "Quiet Lantern",
      },
      obligor: {
        kind: "session",
        sessionId: "session-b",
        label: "Nimble Cloud",
      },
      kind: "decision",
      subject: "not recoverable",
    },
    { now: OBLIGATION_CREATED },
  );

  expect(() =>
    recoverCoordination(decision.id, [], {
      authority: "operator",
      reason: "not how obligations leave the view",
    }),
  ).toThrow(/obligation, not a claim or lease/);
});
