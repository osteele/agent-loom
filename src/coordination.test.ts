import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimStore } from "./claims.ts";
import {
  MANUAL_OWNER_TTL_MS,
  coordinationConflictAdvice,
  isDisplaceable,
  listCoordination,
  ownerStatus,
  recordForcedRecovery,
} from "./coordination.ts";
import type { Registration } from "./registry.ts";
import { WorkStore } from "./work.ts";

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
  const root = mkdtempSync(join(tmpdir(), "agent-mail-unverifiable-"));
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
        [42, { start: "Thu Aug 13 07:00:00 2020", command: "agent-mail" }],
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
  const root = mkdtempSync(join(tmpdir(), "agent-mail-coordination-cli-"));
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
  const root = mkdtempSync(join(tmpdir(), "agent-mail-coordination-"));
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
    "target-absent",
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

test("live-owner conflict advice only offers a transfer for work leases", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-coordination-"));
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
  const root = mkdtempSync(join(tmpdir(), "agent-mail-forced-"));
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
      { ...base, authority: "operator: session is gone", coordinationId: "c1" },
      logPath,
    ).logged,
  ).toBe(true);
  expect(
    recordForcedRecovery(
      { ...base, authority: "operator: second", coordinationId: "c2" },
      logPath,
    ).logged,
  ).toBe(true);

  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  const first = JSON.parse(lines[0]);
  expect(first.authority).toBe("operator: session is gone");
  expect(first.coordinationId).toBe("c1");
  expect(first.ownerStatus).toBe("manual");
  expect(JSON.parse(lines[1]).coordinationId).toBe("c2");
});

test("recordForcedRecovery reports failure instead of throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-forced-fail-"));
  temporaryDirectories.push(root);
  // A regular file where the log's parent directory must be: mkdirSync fails.
  const blocker = join(root, "blocker");
  writeFileSync(blocker, "");
  const result = recordForcedRecovery(
    {
      at: "2026-08-16T00:00:00.000Z",
      authority: "operator",
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
  const root = mkdtempSync(join(tmpdir(), "agent-mail-force-release-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const claimStore = new ClaimStore(join(root, "claims"));
  const owner = { id: "peer", label: "Peer" };
  const target = join(project, "held.md");
  writeFileSync(target, "");
  const claim = claimStore.claimPath(project, target, "file", owner);

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
  const root = mkdtempSync(join(tmpdir(), "agent-mail-expired-"));
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
