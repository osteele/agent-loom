/** Read-only listing of a project's lab-notebook plans, for a session with no claimed work.
 *
 * Plan files follow the research-ops convention: active plans at the top of
 * `lab-notebook/plans/`, other statuses in same-named subdirectories, and
 * `status`/`updated`/`summary`/`next_action` in simple `key: value`
 * frontmatter. The convention's checker is research-ops `plan_index.py`; a
 * file this listing cannot reconcile is shown with a diagnostic naming it. */
import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkLease } from "./work.ts";
import {
  SourceUnavailable,
  age,
  readContainedFile,
  terminalText,
} from "./workTui.ts";

export const PLANS_DIRECTORY = "lab-notebook/plans";

/** Listed sections, in display order, with the directory each lives in. */
export const LISTED_PLAN_STATUSES = [
  { status: "active", directory: "" },
  { status: "proposed", directory: "proposed" },
  { status: "backlog", directory: "backlog" },
] as const;

export type ListedPlanStatus = (typeof LISTED_PLAN_STATUSES)[number]["status"];

export interface PlanEntry {
  status: ListedPlanStatus;
  /** Project-relative path, the entry's provenance. */
  path: string;
  stem: string;
  title: string;
  summary?: string;
  nextAction?: string;
  updated?: string;
  /** Why the file does not conform to the convention, when it does not. */
  problems: string[];
  /** research-plan leases keyed by this plan's stem, from any session. */
  claims: WorkLease[];
}

export interface PlanListing {
  /** Set when the plans directory does not exist. */
  missing: boolean;
  plans: PlanEntry[];
  /** Directory-level read failures; the listing shows what it could read. */
  problems: string[];
}

/** Simple `key: value` frontmatter, parsed as plan_index.py parses it. */
export function parsePlanFrontmatter(
  text: string,
): Record<string, string> | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return undefined;
  const meta: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#") || !line.includes(":"))
      continue;
    const colon = line.indexOf(":");
    let value = line.slice(colon + 1).trim();
    if (
      value.length >= 2 &&
      value[0] === value.at(-1) &&
      (value[0] === '"' || value[0] === "'")
    )
      value = value.slice(1, -1);
    meta[line.slice(0, colon).trim()] = value;
  }
  return meta;
}

function firstHeading(text: string): string | undefined {
  for (const line of text.split("\n"))
    if (line.startsWith("# ")) return line.slice(2).trim();
  return undefined;
}

function presentValue(value: string | undefined): string | undefined {
  return value && value !== "null" ? value : undefined;
}

function readPlan(
  project: string,
  status: ListedPlanStatus,
  path: string,
  stem: string,
  leases: WorkLease[],
): PlanEntry {
  const entry: PlanEntry = {
    status,
    path,
    stem,
    title: stem,
    problems: [],
    claims: leases.filter(
      (lease) =>
        lease.resource.type === "research-plan" && lease.resource.key === stem,
    ),
  };
  let text: string;
  try {
    text = readContainedFile(project, path);
  } catch (error) {
    entry.problems.push(
      error instanceof SourceUnavailable
        ? `unreadable: ${error.message}`
        : `unreadable: ${String(error)}`,
    );
    return entry;
  }
  entry.title = firstHeading(text) ?? stem;
  const meta = parsePlanFrontmatter(text);
  if (!meta) {
    entry.problems.push("no frontmatter");
    return entry;
  }
  entry.summary = presentValue(meta.summary);
  entry.nextAction = presentValue(meta.next_action);
  entry.updated = presentValue(meta.updated);
  if (meta.status !== status)
    entry.problems.push(
      meta.status
        ? `frontmatter says status ${meta.status}, but the file is filed as ${status}`
        : "frontmatter has no status",
    );
  return entry;
}

function directoryEntries(path: string): Dirent[] | undefined {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

/** Plans in the listed statuses, joined exactly to research-plan leases by stem. */
export function readPlanListing(
  project: string,
  leases: WorkLease[],
): PlanListing {
  const listing: PlanListing = { missing: false, plans: [], problems: [] };
  const root = join(project, PLANS_DIRECTORY);
  let rootEntries: Dirent[] | undefined;
  try {
    rootEntries = directoryEntries(root);
  } catch (error) {
    listing.problems.push(`${PLANS_DIRECTORY}: ${String(error)}`);
    return listing;
  }
  if (!rootEntries) {
    listing.missing = true;
    return listing;
  }
  for (const { status, directory } of LISTED_PLAN_STATUSES) {
    const relativeDirectory = directory
      ? `${PLANS_DIRECTORY}/${directory}`
      : PLANS_DIRECTORY;
    let entries: Dirent[] | undefined;
    try {
      entries = directory
        ? directoryEntries(join(root, directory))
        : rootEntries;
    } catch (error) {
      listing.problems.push(`${relativeDirectory}: ${String(error)}`);
      continue;
    }
    const names = (entries ?? [])
      .filter(
        (entry) =>
          !entry.isDirectory() &&
          entry.name.endsWith(".md") &&
          entry.name !== "README.md",
      )
      .map((entry) => entry.name)
      .sort();
    for (const name of names)
      listing.plans.push(
        readPlan(
          project,
          status,
          `${relativeDirectory}/${name}`,
          name.slice(0, -".md".length),
          leases,
        ),
      );
  }
  return listing;
}

const SECTION_TITLES: Record<ListedPlanStatus, string> = {
  active: "Active",
  proposed: "Proposed",
  backlog: "Backlog",
};

export function planListingLines(listing: PlanListing, now: number): string[] {
  const lines = [
    "No claimed work for this exact session and project.",
    `Plans in ${PLANS_DIRECTORY} (active, proposed, backlog), read at refresh:`,
  ];
  if (listing.missing) {
    lines.push(`No ${PLANS_DIRECTORY} directory in this project.`);
    return lines;
  }
  for (const problem of listing.problems)
    lines.push(`Plans unavailable: ${terminalText(problem)}`);
  for (const { status } of LISTED_PLAN_STATUSES) {
    const plans = listing.plans.filter((plan) => plan.status === status);
    lines.push("", `${SECTION_TITLES[status]} (${plans.length})`);
    if (!plans.length) lines.push("  none");
    for (const plan of plans) {
      lines.push(`- ${terminalText(plan.title)}`);
      lines.push(
        `  ${terminalText(plan.path)}${plan.updated ? ` · updated ${terminalText(plan.updated)}` : ""}`,
      );
      for (const lease of plan.claims)
        lines.push(
          `  Claimed by ${terminalText(lease.owner.label)} (lease ${terminalText(lease.id)}, ${terminalText(lease.state)}, last report ${age(lease.updatedAt, now)})`,
        );
      if (plan.summary) lines.push(`  ${terminalText(plan.summary)}`);
      if (plan.nextAction)
        lines.push(`  Next: ${terminalText(plan.nextAction)}`);
      for (const problem of plan.problems)
        lines.push(
          `  Check: ${terminalText(problem)}; run research-ops plan_index.py`,
        );
    }
  }
  return lines;
}
