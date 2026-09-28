import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardResponse } from "./dashboard.ts";
import { buildState } from "./dashboardData.ts";
import type { DashboardState } from "./dashboardData.ts";
import { obligations } from "./obligations.ts";
import { canonicalProject } from "./paths.ts";
import { listLive, register } from "./registry.ts";
import { slowTest } from "./slowTests.ts";

const temporaryDirectories: string[] = [];
const createdRecordIds: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  // The obligations singleton persists across the whole run under the shared
  // throwaway HOME. Withdraw this file's records so later files' aggregate
  // assertions see only their own seeds; records whose component directory
  // just vanished would otherwise resolve onto unrelated live sessions.
  for (const id of createdRecordIds.splice(0)) {
    const record = obligations.get(id);
    if (record?.status !== "open") continue;
    const obligee = record.obligee;
    if (obligee.kind === "session") {
      obligations.withdraw(id, {
        kind: "session",
        sessionId: obligee.sessionId,
        label: obligee.label,
      });
    }
  }
});

slowTest("the persistent daemon can serve the dashboard page", async () => {
  const response = dashboardResponse(new Request("http://127.0.0.1:8377/"));
  expect(response?.status).toBe(200);
  const page = await response?.text();
  expect(page).toContain("agent-mail");
  expect(page).toContain("Coordination");
  expect(page).toContain("recover_coordination");
});

// This asserts on the schema, but the endpoint runs a real process scan
// (listLive → per-pid `ps`), so wall time scales with the number of attached
// agent sessions and machine load — the default 5s limit tips over when the
// suite runs on a busy machine.
slowTest(
  "the versioned state endpoint uses the non-mutating schema",
  async () => {
    const response = dashboardResponse(
      new Request("http://127.0.0.1/api/v1/state"),
    );
    expect(response?.status).toBe(200);
    const state = (await response?.json()) as DashboardState;
    expect(state.schemaVersion).toBe(1);
    expect(state.source.mode).toBe("filesystem-snapshot");
    expect(Array.isArray(state.messages)).toBe(true);
    expect(Array.isArray(state.coordination)).toBe(true);
    expect(Array.isArray(state.transfers)).toBe(true);
  },
);

test("state obligationRecords project both ends with resolution and project provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-dashboard-records-"));
  temporaryDirectories.push(root);
  const projectP1 = join(root, "p1");
  const projectP2 = join(root, "p2");
  mkdirSync(projectP1, { recursive: true });
  mkdirSync(projectP2, { recursive: true });
  // Two real pids: registry liveness is verified against the process table.
  register(projectP1, process.ppid, "alice");
  register(projectP2, process.pid, "bob");

  const record = obligations.announce(
    {
      obligee: { kind: "session", sessionId: "alice", label: "Alice" },
      obligor: { kind: "session", sessionId: "bob", label: "Bob" },
      kind: "decision",
      subject: "approve the deploy window",
    },
    { now: "2026-09-27T00:00:00.000Z" },
  );
  createdRecordIds.push(record.id);
  createdRecordIds.push(
    obligations.announce(
      {
        obligee: { kind: "session", sessionId: "alice", label: "Alice" },
        obligor: { kind: "human", label: "user" },
        kind: "decision",
        subject: "pick the reviewer",
      },
      { now: "2026-09-27T00:00:00.000Z" },
    ).id,
  );
  const repair = obligations.announce(
    {
      obligee: { kind: "session", sessionId: "alice", label: "Alice" },
      obligor: {
        kind: "role",
        role: { kind: "component_owner", component: projectP1 },
        label: "owner of p1",
      },
      kind: "external_fix",
      subject: "am17",
    },
    { now: "2026-09-27T00:00:00.000Z" },
  );
  createdRecordIds.push(repair.id);
  obligations.observeRef(repair.id, "unresolvable", {
    now: "2026-09-27T00:01:00.000Z",
  });

  const state = buildState({ registrations: listLive(), logLimit: 20 });
  expect(state.obligationRecords.length).toBeGreaterThanOrEqual(3);

  const bySubject = new Map(
    state.obligationRecords.map((record) => [record.subject, record]),
  );
  expect(bySubject.get("approve the deploy window")?.obligee).toMatchObject({
    partyKind: "session",
    resolution: "resolves",
    live: true,
    sessionId: "alice",
    project: canonicalProject(projectP1),
    projectBasis: "registered",
  });
  expect(bySubject.get("approve the deploy window")?.obligor).toMatchObject({
    partyKind: "session",
    resolution: "resolves",
    live: true,
    sessionId: "bob",
    project: canonicalProject(projectP2),
    projectBasis: "registered",
  });
  expect(bySubject.get("pick the reviewer")?.obligor).toMatchObject({
    partyKind: "human",
    resolution: "resolves",
    projectBasis: "none",
  });
  expect(bySubject.get("pick the reviewer")?.obligor.project).toBeUndefined();

  const repairView = bySubject.get("am17");
  expect(repairView?.ref).toEqual({ state: "unresolvable" });
  expect(repairView?.obligor).toMatchObject({
    partyKind: "role",
    roleKind: "component_owner",
    resolution: "resolves",
    sessionId: "alice",
    live: true,
    project: canonicalProject(projectP1),
    projectBasis: "ownership",
  });

  // Machine-global counters include other files' seeds; the exact per-record
  // assertions above are the real checks.
  expect(state.obligations.waiting).toBeGreaterThanOrEqual(3);
  expect(state.obligations.humanOwed).toBeGreaterThanOrEqual(1);
});

test("a project-scoped query still resolves cross-project obligation parties", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-dashboard-scoped-"));
  temporaryDirectories.push(root);
  const projectP1 = join(root, "owed-to");
  const projectP2 = join(root, "owed-by");
  mkdirSync(projectP1, { recursive: true });
  mkdirSync(projectP2, { recursive: true });
  register(projectP1, process.ppid, "alice");
  register(projectP2, process.pid, "bob");
  obligations.announce(
    {
      obligee: { kind: "session", sessionId: "alice", label: "Alice" },
      obligor: { kind: "session", sessionId: "bob", label: "Bob" },
      kind: "decision",
      subject: "scoped query keeps cross-project parties live",
    },
    { now: "2026-09-27T00:00:00.000Z" },
  );

  // The regression: the project filter used to bound the liveness set, so a
  // scoped query rendered the cross-project obligor as offline — false
  // negative-liveness evidence in fields documented as authoritative.
  const state = buildState({
    project: projectP1,
    registrations: listLive(),
    logLimit: 20,
  });
  const record = state.obligationRecords.find(
    (entry) =>
      entry.subject === "scoped query keeps cross-project parties live",
  );
  expect(record?.obligee).toMatchObject({
    partyKind: "session",
    resolution: "resolves",
    live: true,
    project: canonicalProject(projectP1),
    projectBasis: "registered",
  });
  expect(record?.obligor).toMatchObject({
    partyKind: "session",
    resolution: "resolves",
    live: true,
    project: canonicalProject(projectP2),
    projectBasis: "registered",
  });
});
