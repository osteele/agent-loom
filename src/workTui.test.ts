import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSlug } from "./paths.ts";
import { type WorkLease, WorkStore } from "./work.ts";
import {
  MAX_PLAN_BYTES,
  formatWorkSnapshot,
  readWorkSnapshot,
  readWorkSource,
  terminalText,
  workTuiOptions,
  wrapWorkLines,
} from "./workTui.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "agent-loom-work-tui-")),
  );
  roots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const workRoot = join(home, ".claude", "agent-loom", "work");
  const store = new WorkStore(workRoot);
  const owner = {
    id: "owner-route",
    label: "Owner label",
    sessionId: "exact-session",
  };
  const options = { project, sessionId: owner.sessionId, once: true };
  return { root, home, project, workRoot, store, owner, options };
}

/** Include mtimes and directory membership, but not read-induced access times. */
function diskState(path: string): Record<string, string | number> {
  const state: Record<string, string | number> = {};
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    state[`${entry.name}:mtime`] = statSync(child).mtimeMs;
    if (entry.isDirectory()) {
      for (const [key, value] of Object.entries(diskState(child)))
        state[`${entry.name}/${key}`] = value;
    } else state[entry.name] = readFileSync(child).toString("base64");
  }
  return state;
}

function cli(home: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [join(import.meta.dir, "cli.ts"), "work", ...args],
    {
      env: {
        ...process.env,
        HOME: home,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        CLAUDE_SESSION_ID: "inherited-session",
        CODEX_THREAD_ID: "inherited-session",
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
}

test("explicit exact session and canonical project never widen to owner names or other projects", () => {
  const { root, project, store, owner, options } = fixture();
  const selected = store.acquire(
    project,
    { type: "plan", key: "selected" },
    owner,
  );
  store.acquire(
    project,
    { type: "plan", key: "manual" },
    { id: owner.sessionId, label: owner.sessionId },
  );
  store.acquire(
    project,
    { type: "plan", key: "different-session" },
    { ...owner, sessionId: "other-session" },
  );
  const otherProject = join(root, "other");
  mkdirSync(otherProject);
  store.acquire(otherProject, { type: "plan", key: "other-project" }, owner);
  const alias = join(root, "project-alias");
  symlinkSync(project, alias);
  const parsed = workTuiOptions([
    "--session",
    owner.sessionId,
    "--project",
    alias,
  ]);
  expect(parsed.project).toBe(project);
  expect(
    readWorkSnapshot(parsed, store).items.map((item) => item.lease.id),
  ).toEqual([selected.id]);
  for (const sessionId of ["unknown", owner.id, owner.label, "EXACT-SESSION"]) {
    expect(readWorkSnapshot({ ...options, sessionId }, store).items).toEqual(
      [],
    );
  }
  expect(
    readWorkSnapshot({ ...options, sessionId: "" }, store).unavailable,
  ).toBeDefined();
  const misplaced: WorkLease = {
    ...selected,
    id: "wrong-project",
    project: otherProject,
  };
  expect(readWorkSnapshot(options, { list: () => [misplaced] }).items).toEqual(
    [],
  );
});

test("TUI rejects implicit, empty, relative, duplicate, and incompatible selectors", () => {
  const { project, root } = fixture();
  for (const args of [
    [],
    ["--project", project],
    ["--session", "", "--project", project],
    ["--session", "   ", "--project", project],
    ["--session", "id", "--project", "."],
    ["--session", "id", "--project", join(root, "absent")],
    ["--session", "id", "--project", project, "--all"],
    ["--session", "id", "--project", project, "--owner", "id"],
    ["--session", "id", "--project", project, "--session", "other"],
    ["--session", "id", "--project", project, "--once", "false"],
  ])
    expect(() => workTuiOptions(args)).toThrow();
});

test("once and non-TTY commands read real leases without changing state or pruning stale records", () => {
  const { home, project, store, owner } = fixture();
  const source = join(project, "plan.txt");
  writeFileSync(source, "First step\nFinal step\n");
  store.acquire(
    project,
    { type: "plan", key: "visible-plan", sourcePath: source },
    owner,
  );
  const data = join(home, ".claude", "agent-loom");
  const registry = join(data, "registry");
  mkdirSync(registry);
  writeFileSync(
    join(registry, "stale.json"),
    JSON.stringify({ cwd: project, pid: 99999999, sessionId: owner.sessionId }),
  );
  const lock = join(data, "work", `${projectSlug(project)}.lock`);
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 99999999 }));
  const before = diskState(home);
  for (const flags of [["--once"], []]) {
    const result = cli(home, [
      "tui",
      "--session",
      owner.sessionId,
      "--project",
      project,
      ...flags,
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("visible-plan");
    expect(result.stdout).toContain("First step\nFinal step");
    expect(result.stdout).toContain("Current position: unreported");
    expect(result.stdout).not.toContain("\x1b");
    expect(diskState(home)).toEqual(before);
  }
  const inherited = cli(home, ["tui", "--project", project, "--once"]);
  expect(inherited.status).toBe(1);
  expect(diskState(home)).toEqual(before);
});

test("malformed and unreadable stores remain unavailable rather than empty", () => {
  const { project, workRoot, store, options } = fixture();
  expect(formatWorkSnapshot(readWorkSnapshot(options, store))).toContain(
    "No claimed work",
  );
  const dir = join(workRoot, projectSlug(project));
  mkdirSync(dir, { recursive: true });
  const record = join(dir, "broken.json");
  for (const contents of [
    "{",
    "null",
    JSON.stringify({ version: 1, createdAt: "invalid" }),
  ]) {
    writeFileSync(record, contents);
    const report = formatWorkSnapshot(readWorkSnapshot(options, store));
    expect(report).toContain("Work store unavailable");
    expect(report).not.toContain("No claimed work");
  }
  rmSync(dir, { recursive: true });
  writeFileSync(dir, "not a directory");
  expect(readWorkSnapshot(options, store).unavailable).toBeDefined();
  const failure = readWorkSnapshot(options, {
    list: () => {
      throw new Error("denied\x1b]52;c;payload\x07");
    },
  });
  expect(formatWorkSnapshot(failure)).not.toContain("\x1b");
});

test("all external fields and plan controls are escaped without inferring checkbox progress", () => {
  const { project, store, owner, options, workRoot } = fixture();
  const source = join(project, "plan.txt");
  writeFileSync(
    source,
    "- [x] completed\n- [ ] unfinished\n\x1b]52;c;payload\x07\u009b2J\rhidden\nlast",
  );
  const lease = store.acquire(
    project,
    { type: "plan", key: "key", sourcePath: source },
    owner,
    { activity: "Discussing step 9" },
  );
  const path = join(workRoot, projectSlug(project), `${lease.id}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      ...lease,
      resource: { ...lease.resource, label: "title\x1b[2J" },
      activity: "Discussing step 9\u202e",
    }),
  );
  const report = formatWorkSnapshot(readWorkSnapshot(options, store));
  expect(report).toContain("Current position: unreported");
  expect(report).toContain("Current activity: Discussing step 9");
  expect(report).toContain("- [x] completed\n- [ ] unfinished");
  expect(report).toContain("\\u{1b}]52;c;payload\\u{7}");
  expect(report.replaceAll("\n", "")).not.toMatch(/\p{C}/u);
  expect(terminalText("project\n\x1b]0;title\x07")).toBe(
    "project\\u{a}\\u{1b}]0;title\\u{7}",
  );
});

test("source reads distinguish missing, escaped, nonregular, and unsupported files", () => {
  const { root, project } = fixture();
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "must not appear");
  const link = join(project, "escape");
  symlinkSync(outside, link);
  expect(readWorkSource(project, link)).toContain("escapes project");
  expect(readWorkSource(project, outside)).not.toContain("must not appear");
  expect(readWorkSource(project, join(project, "absent"))).toBe(
    "Plan/source missing",
  );
  expect(readWorkSource(project, project)).toContain("not a regular file");
  const large = join(project, "large.txt");
  writeFileSync(large, Buffer.alloc(MAX_PLAN_BYTES + 1, 65));
  expect(readWorkSource(project, large)).toContain("unsupported size");
  const allowed = join(project, "..notes");
  writeFileSync(allowed, "inside project");
  const safeLink = join(project, "safe-link");
  symlinkSync(allowed, safeLink);
  expect(readWorkSource(project, safeLink)).toContain("inside project");
});

test("a FIFO source cannot block one-shot inspection", () => {
  const { home, project, store, owner } = fixture();
  const fifo = join(project, "plan.fifo");
  const created = spawnSync("mkfifo", [fifo], { timeout: 1000 });
  expect(created.status).toBe(0);
  store.acquire(
    project,
    { type: "plan", key: "fifo", sourcePath: fifo },
    owner,
  );
  const result = cli(home, [
    "tui",
    "--session",
    owner.sessionId,
    "--project",
    project,
    "--once",
  ]);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("not a regular file");
});
test("full content survives many lines and long wide-character lines at narrow widths", () => {
  const { project, store, owner, options } = fixture();
  const source = join(project, "long.txt");
  const longLine = "界x".repeat(200);
  writeFileSync(source, `${"\n".repeat(140000)}${longLine}\nLAST-LINE`);
  store.acquire(
    project,
    { type: "plan", key: "long", sourcePath: source },
    owner,
  );
  const report = formatWorkSnapshot(readWorkSnapshot(options, store));
  expect(report.endsWith("LAST-LINE")).toBe(true);
  for (const columns of [3, 20, 80]) {
    const wrapped = wrapWorkLines([longLine], columns);
    expect(wrapped.join("")).toBe(longLine);
    for (const line of wrapped) {
      const cells = [...line].reduce(
        (sum, char) => sum + ((char.codePointAt(0) ?? 0) > 127 ? 2 : 1),
        0,
      );
      expect(cells).toBeLessThanOrEqual(columns - 1);
    }
  }
});

test("CLI structured position replaces, validates, preserves, and clears the stored report", () => {
  const { home, project, store, owner, options } = fixture();
  const lease = store.acquire(
    project,
    { type: "plan", key: "progress" },
    owner,
  );
  const update = (flags: string[]) =>
    cli(home, ["update", "--id", lease.id, "--project", project, ...flags]);
  expect(
    update(["--step", "2", "--steps", "3", "--step-label", "Pilot"]).status,
  ).toBe(0);
  expect(formatWorkSnapshot(readWorkSnapshot(options, store))).toContain(
    "Current position: 2 / 3: Pilot",
  );
  const before = store.list(project);
  for (const flags of [
    ["--step", "4", "--steps", "3"],
    ["--step", "1.5"],
    ["--steps", "3"],
    ["--clear-progress", "--step", "1"],
  ]) {
    expect(update(flags).status).not.toBe(0);
    expect(store.list(project)).toEqual(before);
  }
  expect(update(["--activity", "Continuing"]).status).toBe(0);
  expect(store.list(project)[0].progress?.current).toBe(2);
  expect(update(["--clear-progress"]).status).toBe(0);
  expect(formatWorkSnapshot(readWorkSnapshot(options, store))).toContain(
    "Current position: unreported",
  );
});
