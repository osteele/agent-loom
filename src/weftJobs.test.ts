import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WEFT_JOBS_SNAPSHOT_TTL_MS,
  orphansForProject,
  parseRunningJobs,
  parseUnprocessedGroups,
  readRunningJobsSnapshot,
  readWeftJobsSnapshot,
  runningForProjectSession,
  startupOrphanText,
  unprocessedForProjectSession,
  weftJobsForSession,
  writeRunningJobsSnapshot,
  writeWeftJobsSnapshot,
} from "./weftJobs.ts";

function tempSnapshotPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), "agent-loom-weft-")),
    "weft-jobs.json",
  );
}

test("a published snapshot round-trips", () => {
  const path = tempSnapshotPath();
  try {
    writeWeftJobsSnapshot({ bySession: { a: 2 }, total: 2 }, 1000, path);
    const read = readWeftJobsSnapshot(1000, WEFT_JOBS_SNAPSHOT_TTL_MS, path);
    expect(read?.bySession).toEqual({ a: 2 });
    expect(read?.generatedAt).toBe(1000);
  } finally {
    rmSync(path, { force: true });
  }
});

test("a snapshot past its TTL is not served", () => {
  const path = tempSnapshotPath();
  try {
    writeWeftJobsSnapshot({ bySession: { a: 2 }, total: 2 }, 1000, path);
    const later = 1000 + WEFT_JOBS_SNAPSHOT_TTL_MS + 1;
    expect(readWeftJobsSnapshot(later, WEFT_JOBS_SNAPSHOT_TTL_MS, path)).toBe(
      undefined,
    );
  } finally {
    rmSync(path, { force: true });
  }
});

test("a missing or malformed snapshot reads as unknown, never throws", () => {
  const path = tempSnapshotPath();
  expect(readWeftJobsSnapshot(1000, WEFT_JOBS_SNAPSHOT_TTL_MS, path)).toBe(
    undefined,
  );
  writeFileSync(path, "{ not json");
  expect(readWeftJobsSnapshot(1000, WEFT_JOBS_SNAPSHOT_TTL_MS, path)).toBe(
    undefined,
  );
  writeFileSync(path, JSON.stringify({ version: 99, generatedAt: 1000 }));
  expect(readWeftJobsSnapshot(1000, WEFT_JOBS_SNAPSHOT_TTL_MS, path)).toBe(
    undefined,
  );
  rmSync(path, { force: true });
});

test("no jobs for a session is a different answer from no snapshot", () => {
  // A stopped daemon must not report an all-clear. 0 says weft was asked;
  // undefined says nobody knows.
  const path = tempSnapshotPath();
  try {
    writeWeftJobsSnapshot({ bySession: { a: 2 }, total: 2 }, 1000, path);
    expect(weftJobsForSession("a", 1000, path)).toBe(2);
    expect(weftJobsForSession("quiet-session", 1000, path)).toBe(0);
    const later = 1000 + WEFT_JOBS_SNAPSHOT_TTL_MS + 1;
    expect(weftJobsForSession("a", later, path)).toBe(undefined);
    expect(weftJobsForSession(undefined, 1000, path)).toBe(undefined);
  } finally {
    rmSync(path, { force: true });
  }
});

// --- grouped inbox --------------------------------------------------------
// The orphan bucket is empty on this machine (every unattributed row aged out
// of weft's 14-day window), so real data exercises none of this. These fixtures
// are the only coverage the orphan path has.

const KNOWN = () => true;

const DOC = {
  kind: "unprocessed_groups",
  version: 1,
  scope: { state: "all_sessions" },
  groups: [
    {
      project_root: "/p/alpha",
      project: "alpha",
      submitter_session: "live-1",
      unattributed_session: false,
      dispositions: { completed_ok: 2, completed_error: 1 },
      total: 3,
    },
    {
      project_root: "/p/alpha",
      project: "alpha",
      submitter_session: "gone-1",
      unattributed_session: false,
      dispositions: { completed_ok: 1, infra_suspected: 2 },
      total: 3,
    },
    {
      project_root: "/p/alpha",
      project: "alpha",
      submitter_session: null,
      unattributed_session: true,
      dispositions: { dead: 4 },
      total: 4,
    },
    {
      project_root: null,
      project: "alpha",
      submitter_session: null,
      unattributed_session: true,
      dispositions: { completed_ok: 9 },
      total: 9,
    },
    {
      project_root: "/p/beta",
      project: "beta",
      submitter_session: "gone-2",
      unattributed_session: false,
      dispositions: { completed_ok: 5 },
      total: 5,
    },
  ],
};

test("a caller-scoped grouped document is refused", () => {
  // The ungrouped form of this command scopes to the calling session
  // implicitly. A document that arrived that way would describe one session's
  // jobs as every session's, and every other session's jobs would read as
  // unowned. Refusing is the only safe response; there is no partial parse.
  expect(
    parseUnprocessedGroups({
      ...DOC,
      scope: { state: "scoped_empty", submitter_session: "someone" },
    }),
  ).toBeUndefined();
  expect(parseUnprocessedGroups({ ...DOC, scope: null })).toBeUndefined();
});

test("an unrecognized kind or version is refused, never partially parsed", () => {
  expect(
    parseUnprocessedGroups({ ...DOC, kind: "something_else" }),
  ).toBeUndefined();
  expect(parseUnprocessedGroups({ ...DOC, version: 2 })).toBeUndefined();
  expect(parseUnprocessedGroups(null)).toBeUndefined();
});

test("a non-numeric disposition count is refused rather than coerced", () => {
  const bad = {
    ...DOC,
    groups: [{ ...DOC.groups[0], dispositions: { completed_ok: "2" } }],
  };
  expect(parseUnprocessedGroups(bad)).toBeUndefined();
});

test("an unattributed bucket is an orphan; a null project root is nobody's", () => {
  // The two nulls invert, and this is the assertion that pins it. A missing
  // submitter IS evidence of having no owner. A missing project root is absence
  // of evidence about membership, so counting it under alpha would invent the
  // one fact the announcement asserts — note the null-root group carries 9 jobs
  // and `project: "alpha"`, which is exactly the tempting wrong join.
  const groups = parseUnprocessedGroups(DOC);
  if (!groups) throw new Error("fixture failed to parse");
  const orphans = orphansForProject(
    "/p/alpha",
    new Set(["live-1"]),
    groups,
    KNOWN,
  );
  expect(orphans.dispositions).toEqual({
    completed_ok: 1,
    infra_suspected: 2,
    dead: 4,
  });
  expect(orphans.total).toBe(7);
});

test("a live submitter's jobs are not orphans, and liveness is global", () => {
  const groups = parseUnprocessedGroups(DOC);
  if (!groups) throw new Error("fixture failed to parse");
  // gone-1 alive somewhere else still counts as owned: it receives its own
  // session-addressed notice, so counting it here would double-report it.
  const both = orphansForProject(
    "/p/alpha",
    new Set(["live-1", "gone-1"]),
    groups,
    KNOWN,
  );
  expect(both.dispositions).toEqual({ dead: 4 });
  // Another project's orphans never leak in.
  expect(
    orphansForProject("/p/beta", new Set(["live-1"]), groups, KNOWN).total,
  ).toBe(5);
});

test("an unrecognized disposition is surfaced, not dropped", () => {
  // weft may add a value. Silently omitting it would undercount, and an
  // undercount in this feature reads as good news.
  const groups = parseUnprocessedGroups({
    ...DOC,
    groups: [
      {
        ...DOC.groups[1],
        dispositions: { quarantined: 3 },
        total: 3,
      },
    ],
  });
  if (!groups) throw new Error("fixture failed to parse");
  const orphans = orphansForProject("/p/alpha", new Set(), groups, KNOWN);
  expect(orphans.dispositions).toEqual({ quarantined: 3 });
  expect(startupOrphanText(orphans)).toContain("quarantined");
  expect(startupOrphanText(orphans)).toContain("unrecognized disposition");
});

test("the announcement names an action per line and is silent at zero", () => {
  expect(startupOrphanText({ dispositions: {}, total: 0 })).toBe("");
  const text = startupOrphanText({
    dispositions: { completed_ok: 1, infra_suspected: 2 },
    total: 3,
  });
  expect(text).toContain("3 unprocessed jobs");
  expect(text).toContain("1 completed_ok (process the results)");
  expect(text).toContain("2 infra_suspected (check weft or the host)");
});

test("a submitter agent-loom has never seen is not reported as an orphan", () => {
  // The live case on this machine: codex spawns its MCP child with no session
  // env var, so agent-loom registers a minted id while weft records the
  // shell's own. Across 1402 named sessions the two namespaces have never
  // intersected. Treating "not in the live set" as "gone" would mark every
  // weft job unowned — correct arithmetic, wrong claim, in the direction that
  // demands action.
  const groups = parseUnprocessedGroups(DOC);
  if (!groups) throw new Error("fixture failed to parse");
  const stranger = orphansForProject(
    "/p/alpha",
    new Set(),
    groups,
    () => false,
  );
  // Only the genuinely unattributed bucket survives: it has no submitter at
  // all, so there is no id whose provenance could be in doubt.
  expect(stranger.dispositions).toEqual({ dead: 4 });
  expect(startupOrphanText(stranger)).toContain("4 dead");
});

test("running counts require a complete versioned producer projection and exact root plus submitter", () => {
  const doc = {
    kind: "job_list",
    version: 1,
    selection: { complete: true, order: "newest_first", constraints: [] },
    jobs: [
      {
        id: 1,
        status_code: "running",
        project_root: "/projects/a",
        submitter_session: "owner",
      },
      {
        id: 2,
        status_code: "running",
        project_root: "/projects/b",
        submitter_session: "owner",
      },
      {
        id: 3,
        status_code: "running",
        project_root: "/projects/a",
        submitter_session: "other",
      },
    ],
  };
  const groups = parseRunningJobs(doc);
  if (!groups) throw new Error("Fixture failed to parse");
  const snapshot = { version: 1 as const, generatedAt: 1000, groups };
  expect(runningForProjectSession(snapshot, "/projects/a", "owner")).toBe(1);
  expect(runningForProjectSession(snapshot, "/projects/a", "quiet")).toBe(0);
  expect(
    runningForProjectSession(undefined, "/projects/a", "owner"),
  ).toBeNull();
  expect(
    parseRunningJobs({
      ...doc,
      selection: { ...doc.selection, complete: false },
    }),
  ).toBeUndefined();
  expect(parseRunningJobs({ ...doc, version: 2 })).toBeUndefined();
  expect(
    parseRunningJobs({
      ...doc,
      jobs: [{ ...doc.jobs[0], project_root: undefined }],
    }),
  ).toBeUndefined();
  expect(
    parseRunningJobs({
      ...doc,
      jobs: [{ ...doc.jobs[0], status_code: "queued" }],
    }),
  ).toBeUndefined();
  expect(
    parseRunningJobs({ ...doc, jobs: [doc.jobs[0], doc.jobs[0]] }),
  ).toBeUndefined();
  const unknownRoot = parseRunningJobs({
    ...doc,
    jobs: [{ ...doc.jobs[0], project_root: null }],
  });
  if (!unknownRoot) throw new Error("Fixture failed to parse");
  expect(
    runningForProjectSession(
      { ...snapshot, groups: unknownRoot },
      "/projects/a",
      "owner",
    ),
  ).toBeNull();
});

test("running snapshot distinguishes observed zero from missing, expired, and malformed data", () => {
  const path = tempSnapshotPath();
  try {
    expect(readRunningJobsSnapshot(1000, path)).toBeUndefined();
    writeRunningJobsSnapshot([], 1000, path);
    expect(
      runningForProjectSession(
        readRunningJobsSnapshot(1000, path),
        "/projects/a",
        "owner",
      ),
    ).toBe(0);
    expect(
      readRunningJobsSnapshot(1000 + WEFT_JOBS_SNAPSHOT_TTL_MS + 1, path),
    ).toBeUndefined();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        generatedAt: 1000,
        groups: [
          { projectRoot: "/projects/a", submitterSession: "owner", count: -1 },
        ],
      }),
    );
    expect(readRunningJobsSnapshot(1000, path)).toBeUndefined();
  } finally {
    rmSync(path, { force: true });
  }
});

test("awaiting-processing counts remain distinct and exact-project scoped", () => {
  const groups = parseUnprocessedGroups(DOC);
  if (!groups) throw new Error("Fixture failed to parse");
  const snapshot = {
    version: 2 as const,
    generatedAt: 1000,
    generatedBy: 1,
    bySession: { "live-1": 99 },
    total: 99,
    groups,
  };
  expect(unprocessedForProjectSession(snapshot, "/p/alpha", "live-1")).toBe(3);
  expect(unprocessedForProjectSession(snapshot, "/p/beta", "live-1")).toBe(0);
  expect(
    unprocessedForProjectSession(undefined, "/p/alpha", "live-1"),
  ).toBeNull();
  expect(
    unprocessedForProjectSession(
      { ...snapshot, groups: [{ ...groups[0], projectRoot: null }] },
      "/p/alpha",
      "live-1",
    ),
  ).toBeNull();
});
