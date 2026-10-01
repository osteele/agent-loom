import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  parsePlanFrontmatter,
  planListingLines,
  readPlanListing,
} from "./planListing.ts";
import { WorkStore } from "./work.ts";
import { formatWorkSnapshot, readWorkSnapshot } from "./workTui.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "agent-loom-plan-listing-")),
  );
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const store = new WorkStore(join(root, "work"));
  const owner = { id: "owner", label: "Owner label", sessionId: "session" };
  const options = { project, sessionId: owner.sessionId, once: true };
  return { project, store, owner, options };
}

function writePlan(project: string, path: string, text: string) {
  const file = join(project, "lab-notebook/plans", path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function plan(status: string, title: string, extra = ""): string {
  return `---\nstatus: ${status}\nupdated: 2026-09-20\nsummary: "${title} summary"\nnext_action: ${title} next${extra}\n---\n\n# ${title}\n`;
}

test("frontmatter parses as plan_index.py parses it", () => {
  expect(
    parsePlanFrontmatter(
      "---\nstatus: active\n# comment\nno colon here\n\nsummary: 'a: b'\nurl: x:y\n---\nbody",
    ),
  ).toEqual({ status: "active", summary: "a: b", url: "x:y" });
  expect(parsePlanFrontmatter("# Title\nstatus: active\n")).toBeUndefined();
  expect(parsePlanFrontmatter("---\nstatus: active\n")).toBeUndefined();
});

test("lists active, proposed, and backlog plans in path order and nothing else", () => {
  const { project } = fixture();
  writePlan(project, "b-active.md", plan("active", "Second active"));
  writePlan(project, "a-active.md", plan("active", "First active"));
  writePlan(project, "README.md", "# Plans Index\n");
  writePlan(project, "proposed/p.md", plan("proposed", "Proposal"));
  writePlan(project, "backlog/l.md", plan("backlog", "Later"));
  writePlan(project, "gated/g.md", plan("gated", "Gated plan"));
  writePlan(project, "complete/c.md", plan("complete", "Done plan"));
  writePlan(project, "spend/s.md", plan("active", "Spend ledger"));
  writePlan(project, "notes.txt", "not a plan");

  const listing = readPlanListing(project, []);
  expect(listing.missing).toBe(false);
  expect(listing.problems).toEqual([]);
  expect(
    listing.plans.map((entry) => [entry.status, entry.path, entry.title]),
  ).toEqual([
    ["active", "lab-notebook/plans/a-active.md", "First active"],
    ["active", "lab-notebook/plans/b-active.md", "Second active"],
    ["proposed", "lab-notebook/plans/proposed/p.md", "Proposal"],
    ["backlog", "lab-notebook/plans/backlog/l.md", "Later"],
  ]);
  expect(listing.plans.every((entry) => !entry.problems.length)).toBe(true);

  const text = planListingLines(listing, Date.now()).join("\n");
  for (const want of [
    "Active (2)",
    "Proposed (1)",
    "Backlog (1)",
    "lab-notebook/plans/proposed/p.md · updated 2026-09-20",
    "Proposal summary",
    "Next: Proposal next",
  ])
    expect(text).toContain(want);
  for (const unwanted of ["Gated plan", "Done plan", "Spend ledger"])
    expect(text).not.toContain(unwanted);
});

test("claims join exactly on research-plan leases keyed by the plan stem", () => {
  const { project, store, owner } = fixture();
  writePlan(project, "2026-09-01-entity.md", plan("active", "Entity plan"));
  writePlan(project, "proposed/2026-09-02-other.md", plan("proposed", "Other"));
  const claim = store.acquire(
    project,
    { type: "research-plan", key: "2026-09-01-entity" },
    { ...owner, sessionId: "another-session" },
  );
  store.acquire(project, { type: "plan", key: "2026-09-02-other" }, owner);
  store.acquire(
    project,
    { type: "research-plan", key: "2026-09-02" },
    { ...owner, sessionId: "third-session" },
  );

  const listing = readPlanListing(project, store.list(project));
  expect(
    listing.plans.map((entry) => entry.claims.map((lease) => lease.id)),
  ).toEqual([[claim.id], []]);
  const text = planListingLines(listing, Date.now()).join("\n");
  expect(text).toContain(`Claimed by Owner label (lease ${claim.id}`);
  expect(text.match(/Claimed by/g)?.length).toBe(1);
});

test("nonconforming plans stay listed with a visible diagnostic", () => {
  const { project } = fixture();
  writePlan(project, "bare.md", "# Bare plan\n\nNo frontmatter.\n");
  writePlan(project, "misfiled.md", plan("backlog", "Misfiled"));
  writePlan(project, "backlog/untitled.md", "---\nupdated: 2026-09-01\n---\n");

  const listing = readPlanListing(project, []);
  expect(listing.plans.map((entry) => [entry.title, entry.problems])).toEqual([
    ["Bare plan", ["no frontmatter"]],
    [
      "Misfiled",
      ["frontmatter says status backlog, but the file is filed as active"],
    ],
    ["untitled", ["frontmatter has no status"]],
  ]);
  expect(planListingLines(listing, Date.now()).join("\n")).toContain(
    "Check: no frontmatter; run research-ops plan_index.py",
  );
});

test("a project without a plans directory says so", () => {
  const { project } = fixture();
  const listing = readPlanListing(project, []);
  expect(listing).toEqual({ missing: true, plans: [], problems: [] });
  expect(planListingLines(listing, Date.now())).toContain(
    "No lab-notebook/plans directory in this project.",
  );
});

test("plan text is escaped before display", () => {
  const { project } = fixture();
  writePlan(
    project,
    "escape.md",
    plan("active", "Title\u001b[2J", "\nsummary_extra: x"),
  );
  const text = planListingLines(readPlanListing(project, []), Date.now()).join(
    "\n",
  );
  expect(text).not.toContain("\u001b");
  expect(text).toContain("Title\\u{1b}[2J");
});

test("the work view lists plans only when the session has no claimed work", () => {
  const { project, store, owner, options } = fixture();
  writePlan(project, "active-plan.md", plan("active", "Active plan"));
  const before = readFileSync(
    join(project, "lab-notebook/plans/active-plan.md"),
    "utf8",
  );

  const idle = readWorkSnapshot(options, store);
  expect(idle.items).toEqual([]);
  expect(idle.plans?.plans.map((entry) => entry.title)).toEqual([
    "Active plan",
  ]);
  const idleText = formatWorkSnapshot(idle);
  expect(idleText).toContain("No claimed work for this exact session");
  expect(idleText).toContain("Plans in lab-notebook/plans");
  expect(idleText).toContain("Active plan");

  store.acquire(project, { type: "research-plan", key: "active-plan" }, owner);
  const busy = readWorkSnapshot(options, store);
  expect(busy.items).toHaveLength(1);
  expect(busy.plans).toBeUndefined();
  expect(formatWorkSnapshot(busy)).not.toContain("Plans in lab-notebook/plans");

  expect(
    readFileSync(join(project, "lab-notebook/plans/active-plan.md"), "utf8"),
  ).toBe(before);
});
