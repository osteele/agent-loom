import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ClaimConflictError,
  type ClaimOwner,
  ClaimStore,
  PATH_CLAIM_MANUAL_TTL_MS,
  PATH_CLAIM_RETENTION_MS,
  PATH_CLAIM_SESSION_GRACE_MS,
  pathClaimTargets,
} from "./claims.ts";
import { projectSlug } from "./paths.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture(): {
  project: string;
  notebook: string;
  claimRoot: string;
  store: ClaimStore;
} {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-claims-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const notebook = join(project, "lab-notebook");
  const claimRoot = join(root, "claims");
  mkdirSync(join(notebook, "experiments"), { recursive: true });
  return { project, notebook, claimRoot, store: new ClaimStore(claimRoot) };
}

const manualA: ClaimOwner = {
  id: "cli:agent-a",
  label: "agent A",
  kind: "manual",
};
const manualB: ClaimOwner = {
  id: "cli:agent-b",
  label: "agent B",
  kind: "manual",
};

function sessionOwner(sessionId: string, pid: number): ClaimOwner {
  return {
    id: sessionId,
    label: sessionId,
    kind: "session",
    sessionId,
    pid,
    instanceId: `${sessionId}-${pid}`,
  };
}

test("experiment claims atomically advance past files and active claims", () => {
  const { project, notebook, store } = fixture();
  writeFileSync(join(notebook, "experiments", "EXP-002-baseline.md"), "");

  const first = store.claimExperiment(project, notebook, manualA);
  const second = store.claimExperiment(project, notebook, manualB);

  expect(first.experimentId).toBe("EXP-003");
  expect(second.experimentId).toBe("EXP-004");
  expect(store.list(project).map((claim) => claim.id)).toEqual([
    first.id,
    second.id,
  ]);
});

test("target kind is observed for existing names and defaults for absent names", () => {
  const { project, store } = fixture();
  const existingDirectory = join(project, "src");
  mkdirSync(existingDirectory);
  const existingFile = join(project, "README.md");
  writeFileSync(existingFile, "");

  const acquisition = store.claimPaths(
    project,
    [
      { path: existingDirectory },
      { path: existingFile },
      { path: join(project, "future.txt") },
      { path: join(project, "future-dir"), pathType: "directory" },
    ],
    manualA,
  );

  expect(pathClaimTargets(acquisition.claim)).toEqual(
    [
      { path: realpathSync(existingFile), pathType: "file" as const },
      { path: realpathSync(existingDirectory), pathType: "directory" as const },
      {
        path: join(realpathSync(project), "future-dir"),
        pathType: "directory" as const,
      },
      {
        path: join(realpathSync(project), "future.txt"),
        pathType: "file" as const,
      },
    ].sort((a, b) => a.path.localeCompare(b.path)),
  );
  expect(() =>
    store.claimPath(project, existingDirectory, "file", manualB),
  ).toThrow("is a directory, not a file");
});

test("symlinks resolve before project-boundary validation", () => {
  const { project, store } = fixture();
  const target = join(project, "target.ts");
  writeFileSync(target, "");
  const alias = join(project, "alias.ts");
  symlinkSync(target, alias);
  expect(
    pathClaimTargets(
      store.claimPath(project, alias, undefined, manualA).claim,
    )[0],
  ).toEqual({ path: realpathSync(target), pathType: "file" });

  const outside = join(dirname(project), "outside.ts");
  writeFileSync(outside, "");
  const outsideAlias = join(project, "outside-alias.ts");
  symlinkSync(outside, outsideAlias);
  expect(() =>
    store.claimPath(project, outsideAlias, undefined, manualB),
  ).toThrow("claim target must be inside project");
});

test("normalization removes duplicates and descendants covered by a directory", () => {
  const { project, store } = fixture();
  const acquisition = store.claimPaths(
    project,
    [
      { path: join(project, "src"), pathType: "directory" },
      { path: join(project, "src", "worker.ts") },
      { path: join(project, "src"), pathType: "directory" },
    ],
    manualA,
  );

  expect(pathClaimTargets(acquisition.claim)).toEqual([
    {
      path: join(realpathSync(project), "src"),
      pathType: "directory",
    },
  ]);
});

test("directory conflict detection is hierarchical and symmetric", () => {
  const { project, store } = fixture();
  const source = join(project, "src");
  const held = store.claimPath(project, source, "directory", manualA).claim;

  expect(() =>
    store.claimPath(project, join(source, "worker.ts"), undefined, manualB),
  ).toThrow(ClaimConflictError);
  expect(() =>
    store.claimPath(project, project, "directory", manualB),
  ).toThrow(ClaimConflictError);
  expect(store.list(project)).toEqual([held]);

  const sibling = store.claimPath(
    project,
    join(project, "README.md"),
    undefined,
    manualB,
  ).claim;
  expect(pathClaimTargets(sibling)[0].path).toBe(
    join(realpathSync(project), "README.md"),
  );
});

test("a conflicting path batch creates no partial claim", () => {
  const { project, store } = fixture();
  const occupied = store.claimPath(
    project,
    join(project, "occupied.swift"),
    undefined,
    manualA,
  ).claim;

  expect(() =>
    store.claimPaths(
      project,
      [
        { path: join(project, "free.swift") },
        { path: join(project, "occupied.swift") },
      ],
      manualB,
    ),
  ).toThrow(ClaimConflictError);
  expect(store.list(project)).toEqual([occupied]);
});

test("same-owner overlaps stay separate while an exact repeat is existing", () => {
  const { project, store } = fixture();
  let nowMs = Date.parse("2026-09-22T00:00:00.000Z");
  const now = () => new Date(nowMs);
  const first = store.claimPath(
    project,
    join(project, "src"),
    "directory",
    manualA,
    { now },
  );
  nowMs += 1_000;
  const nested = store.claimPath(
    project,
    join(project, "src", "worker.ts"),
    undefined,
    manualA,
    { now },
  );
  nowMs += 1_000;
  const repeated = store.claimPath(
    project,
    join(project, "src"),
    "directory",
    manualA,
    { now },
  );

  expect(first.disposition).toBe("acquired");
  expect(nested.disposition).toBe("acquired");
  expect(nested.claim.id).not.toBe(first.claim.id);
  expect(repeated.disposition).toBe("existing");
  expect(repeated.claim.id).toBe(first.claim.id);
  expect(repeated.releaseToken).toBeUndefined();
  expect(store.list(project)).toHaveLength(2);
  expect("lastActivityAt" in repeated.claim && repeated.claim.lastActivityAt).toBe(
    new Date(nowMs).toISOString(),
  );
});

test("manual release requires the token and remains idempotent during retention", () => {
  const { project, store } = fixture();
  const acquisition = store.claimPath(
    project,
    join(project, "notes.md"),
    undefined,
    manualA,
  );
  expect(acquisition.releaseToken).toBeTruthy();

  expect(() =>
    store.release({ claimId: acquisition.claim.id, actor: manualA }),
  ).toThrow("release requires its token or proven owner identity");
  const released = store.release({ releaseToken: acquisition.releaseToken });
  expect(released.disposition).toBe("released");
  expect(store.list(project)).toEqual([]);
  expect(store.listReleased(project)).toHaveLength(1);
  expect(
    store.release({ releaseToken: acquisition.releaseToken }).disposition,
  ).toBe("already-released");
  expect(store.release({ claimId: acquisition.claim.id }).disposition).toBe(
    "already-released",
  );
});

test("the same logical session may release after its process restarts", () => {
  const { project, store } = fixture();
  const original = sessionOwner("session-a", 101);
  const resumed = sessionOwner("session-a", 202);
  const acquisition = store.claimPath(
    project,
    join(project, "owned.ts"),
    undefined,
    original,
  );

  expect(
    store.release({ claimId: acquisition.claim.id, actor: resumed }).disposition,
  ).toBe("released");
});

test("session absence starts grace and a later transaction settles its deadline", () => {
  const { project, store } = fixture();
  const owner = sessionOwner("session-a", 101);
  let nowMs = Date.parse("2026-09-22T00:00:00.000Z");
  const now = () => new Date(nowMs);
  const held = store.claimPath(
    project,
    join(project, "owned.ts"),
    undefined,
    owner,
    { now, sessionIsLive: () => true },
  ).claim;

  nowMs += 60_000;
  expect(() =>
    store.claimPath(
      project,
      join(project, "owned.ts"),
      undefined,
      manualB,
      { now, sessionIsLive: () => false },
    ),
  ).toThrow(ClaimConflictError);
  const grace = store.list(project, nowMs).find((claim) => claim.id === held.id);
  expect(grace).toMatchObject({ state: "restart-grace" });
  expect(grace && "graceDeadline" in grace ? grace.graceDeadline : undefined).toBe(
    new Date(nowMs + PATH_CLAIM_SESSION_GRACE_MS).toISOString(),
  );

  nowMs += PATH_CLAIM_SESSION_GRACE_MS + 1;
  const replacement = store.claimPath(
    project,
    join(project, "owned.ts"),
    undefined,
    manualB,
    { now, sessionIsLive: () => false },
  );
  expect(replacement.disposition).toBe("acquired");
  const history = store.listReleased(project);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    id: held.id,
    releaseReason: "session-absence",
    releasedAt: new Date(nowMs - 1).toISOString(),
  });
});

test("a session return before the deadline cancels restart grace", () => {
  const { project, store } = fixture();
  const owner = sessionOwner("session-a", 101);
  let live = true;
  const held = store.claimPath(
    project,
    join(project, "owned.ts"),
    undefined,
    owner,
    { sessionIsLive: () => live },
  ).claim;
  live = false;
  expect(() =>
    store.claimPath(
      project,
      join(project, "owned.ts"),
      undefined,
      manualB,
      { sessionIsLive: () => live },
    ),
  ).toThrow(ClaimConflictError);
  live = true;
  expect(() =>
    store.claimPath(
      project,
      join(project, "owned.ts"),
      undefined,
      manualB,
      { sessionIsLive: () => live },
    ),
  ).toThrow(ClaimConflictError);
  expect(store.list(project).find((claim) => claim.id === held.id)).toMatchObject(
    { state: "active" },
  );
});

test("recovery observes session liveness inside the transaction", () => {
  const { project, store } = fixture();
  const owner = sessionOwner("session-a", 101);
  const createdMs = Date.parse("2026-09-22T00:00:00.000Z");
  const claim = store.claimPath(
    project,
    join(project, "owned.ts"),
    undefined,
    owner,
    { now: () => new Date(createdMs) },
  ).claim;
  const firstObservation = new Date(createdMs + 60_000).toISOString();

  expect(() =>
    store.recover(project, claim.id, () => false, {
      reason: "session-absence",
      at: firstObservation,
    }),
  ).toThrow("is in restart grace");
  const grace = store.list(project, Date.parse(firstObservation))[0];
  expect(grace).toMatchObject({ state: "restart-grace" });
  const deadline =
    grace.type === "path" && "graceDeadline" in grace
      ? grace.graceDeadline
      : undefined;
  expect(deadline).toBeDefined();

  const released = store.recover(project, claim.id, () => true, {
    reason: "session-absence",
    at: deadline,
  });
  expect(released).toMatchObject({
    state: "released",
    releaseReason: "session-absence",
    releasedAt: deadline,
  });
});

test("manual expiry stops blocking and records its fixed deadline", () => {
  const { project, store } = fixture();
  const createdMs = Date.parse("2026-09-20T00:00:00.000Z");
  const held = store.claimPath(
    project,
    join(project, "owned.ts"),
    undefined,
    manualA,
    { now: () => new Date(createdMs) },
  ).claim;
  const replacement = store.claimPath(
    project,
    join(project, "owned.ts"),
    undefined,
    manualB,
    { now: () => new Date(createdMs + PATH_CLAIM_MANUAL_TTL_MS + 1) },
  );

  expect(replacement.disposition).toBe("acquired");
  expect(store.listReleased(project)[0]).toMatchObject({
    id: held.id,
    releaseReason: "manual-expiry",
    releasedAt: new Date(createdMs + PATH_CLAIM_MANUAL_TTL_MS).toISOString(),
  });
});

test("normal listing settles expired claims into retained history", () => {
  const { project, store } = fixture();
  const createdMs = Date.parse("2026-09-20T00:00:00.000Z");
  const claim = store.claimPath(
    project,
    join(project, "owned.ts"),
    undefined,
    manualA,
    { now: () => new Date(createdMs) },
  ).claim;

  expect(store.list(project, createdMs + PATH_CLAIM_MANUAL_TTL_MS)).toEqual([]);
  expect(
    store.listReleased(project, createdMs + PATH_CLAIM_MANUAL_TTL_MS)[0],
  ).toMatchObject({
    id: claim.id,
    releaseReason: "manual-expiry",
  });
});

test("released history disappears from reads after retention", () => {
  const { project, store } = fixture();
  const at = new Date("2026-09-22T00:00:00.000Z");
  const acquisition = store.claimPath(
    project,
    join(project, "owned.ts"),
    undefined,
    manualA,
    { now: () => at },
  );
  store.release({
    releaseToken: acquisition.releaseToken,
    now: at,
  });

  expect(store.listReleased(project, at.getTime() + PATH_CLAIM_RETENTION_MS - 1)).toHaveLength(1);
  expect(store.listReleased(project, at.getTime() + PATH_CLAIM_RETENTION_MS)).toEqual([]);
});

test("legacy singular path records still block another owner", () => {
  const { project, claimRoot, store } = fixture();
  const canonical = realpathSync(project);
  const directory = join(claimRoot, projectSlug(canonical));
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "legacy.json"),
    JSON.stringify({
      id: "legacy",
      type: "path",
      project: canonical,
      path: join(canonical, "legacy.swift"),
      pathType: "file",
      owner: manualA,
      createdAt: new Date().toISOString(),
    }),
  );

  expect(() =>
    store.claimPath(
      project,
      join(project, "legacy.swift"),
      undefined,
      manualB,
    ),
  ).toThrow(ClaimConflictError);
});

test("shutdown owner cleanup leaves path claims and releases experiment claims", () => {
  const { project, notebook, store } = fixture();
  store.claimExperiment(project, notebook, manualA);
  const path = store.claimPath(
    project,
    join(project, "one.md"),
    undefined,
    manualA,
  ).claim;

  expect(store.releaseOwner(project, manualA.id)).toBe(1);
  expect(store.list(project)).toEqual([path]);
});

test("recovery records a retained path release", () => {
  const { project, store } = fixture();
  const claim = store.claimPath(
    project,
    join(project, "notes.md"),
    undefined,
    manualA,
  ).claim;
  expect(() => store.recover(project, claim.id, () => true)).toThrow(
    "live or cannot be verified offline",
  );
  const recovered = store.recover(project, claim.id, () => false, {
    reason: "forced-recovery",
  });
  expect(recovered).toMatchObject({
    id: claim.id,
    state: "released",
    releaseReason: "forced-recovery",
  });
  expect(store.list(project)).toEqual([]);
  expect(store.listReleased(project)).toHaveLength(1);
});

test("an abandoned transaction lock does not permanently block claims", () => {
  const { project, notebook } = fixture();
  const root = dirname(project);
  const claimRoot = join(root, "claims-with-stale-lock");
  const store = new ClaimStore(claimRoot);
  const lock = join(claimRoot, `${projectSlug(project)}.lock`);
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 31_000);
  utimesSync(lock, old, old);

  expect(store.claimExperiment(project, notebook, manualA).experimentId).toBe(
    "EXP-001",
  );
});
