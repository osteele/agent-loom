import { watcherSessionIds } from "./ledgerIssues.ts";

const EVENTS = new Set([
  "reported",
  "sighted",
  "recurred",
  "closed",
  "reopened",
  "noted",
  "watched",
  "unwatched",
]);

export interface IssueLedgerEvent {
  schema: "issue-ledger-event/v1";
  event: string;
  issue: {
    id: string;
    title: string;
    component: string;
    component_path?: string;
    severity?: string;
    close_reason?: string;
    watchers: string[];
  };
}

/** Refuse malformed hook input before any routing decision. Other fields in
 * issues show --json may be present; only the fields used here are checked. */
export function parseIssueLedgerEvent(text: string): IssueLedgerEvent {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid issue-ledger event JSON: ${String(error)}`);
  }
  if (!value || typeof value !== "object")
    throw new Error("issue-ledger event must be an object");
  const doc = value as Record<string, unknown>;
  if (doc.schema !== "issue-ledger-event/v1")
    throw new Error(
      `issue-ledger event schema must be issue-ledger-event/v1 (got ${JSON.stringify(doc.schema)})`,
    );
  if (typeof doc.event !== "string" || !EVENTS.has(doc.event))
    throw new Error(`unknown issue-ledger event: ${String(doc.event)}`);
  const issue = doc.issue;
  if (!issue || typeof issue !== "object" || Array.isArray(issue))
    throw new Error("issue-ledger event missing issue object");
  const row = issue as Record<string, unknown>;
  for (const key of ["id", "title", "component"]) {
    if (typeof row[key] !== "string" || !row[key])
      throw new Error(
        `issue-ledger event issue.${key} must be a nonempty string`,
      );
  }
  if (
    row.component_path !== undefined &&
    typeof row.component_path !== "string"
  )
    throw new Error("issue-ledger event issue.component_path must be a string");
  if (
    row.watchers !== undefined &&
    (!Array.isArray(row.watchers) ||
      row.watchers.some((token) => typeof token !== "string"))
  )
    throw new Error("issue-ledger event issue.watchers must be string tokens");
  return {
    schema: "issue-ledger-event/v1",
    event: doc.event,
    issue: {
      id: row.id as string,
      title: row.title as string,
      component: row.component as string,
      ...(typeof row.component_path === "string"
        ? { component_path: row.component_path }
        : {}),
      ...(typeof row.severity === "string" ? { severity: row.severity } : {}),
      ...(typeof row.close_reason === "string"
        ? { close_reason: row.close_reason }
        : {}),
      watchers: (row.watchers ?? []) as string[],
    },
  };
}

export function issueWatcherSessions(tokens: string[]): string[] {
  return watcherSessionIds(tokens);
}
