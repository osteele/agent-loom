/** A cheap change signal for `agent-mail state`.
 *
 * No single process sees every mutation: spools and read logs are O_APPEND
 * files written by whichever process sends or reads, and the coordination
 * stores are temp-file-plus-rename transactions. So the revision is derived,
 * not counted: a digest of the identity (inode, size, mtime) of every file the
 * read-only state is built from, plus the content of the daemon's snapshots
 * with their generation timestamps removed. Equal digests mean `state
 * --no-sync` would read the same inputs; a consumer runs the full dump only
 * when the digest moves.
 *
 * Not covered: time alone (a manual owner expires, an age advances; the
 * digest does carry each snapshot's freshness bit), and coordination
 * conditions derived from files outside agent-mail's state (an experiment
 * file appearing, a work lease's source path disappearing). Consumers
 * reconcile those on a slow interval. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LEDGER_ISSUES_SNAPSHOT_TTL_MS } from "./ledgerIssues.ts";
import {
  CLAIMS_DIR,
  CONFIG_PATH,
  INBOX_DIR,
  LEDGER_ISSUES_SNAPSHOT_PATH,
  MESSAGE_INDEX_PATH,
  OBLIGATIONS_DIR,
  PRESENCE_SNAPSHOT_PATH,
  PROCESS_SNAPSHOT_PATH,
  READ_DIR,
  REGISTRY_DIR,
  SESSION_NAMES_DIR,
  TRANSFERS_DIR,
  WORK_DIR,
} from "./paths.ts";
import { PRESENCE_SNAPSHOT_TTL_MS } from "./presence.ts";
import { PROCESS_SNAPSHOT_TTL_MS } from "./processSnapshot.ts";
import { CLAUDE_SESSIONS_DIR } from "./sessions.ts";

export interface StateRevision {
  kind: "agent_mail_state_revision";
  version: 1;
  /** Opaque; compare for equality only. */
  digest: string;
  generatedAt: string;
}

/** name:inode:size:mtime for every file under `dir`, `depth` levels down. */
function tree(dir: string, depth: number, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    // Removed between the listing and the stat: the next revision sees it.
    if (!stat) continue;
    if (stat.isDirectory()) {
      if (depth > 0) tree(path, depth - 1, out);
      continue;
    }
    out.push(`${path}:${stat.ino}:${stat.size}:${stat.mtimeMs}`);
  }
}

/** One path's identity; for a directory this moves when an entry is added,
 * removed or renamed, not when a file in it is rewritten. */
function identity(path: string, out: string[]): void {
  const stat = statSync(path, { throwIfNoEntry: false });
  out.push(
    stat
      ? `${path}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
      : `${path}:absent`,
  );
}

/** A daemon snapshot's content without the timestamp that changes every tick,
 * plus whether it is fresh — readers report staleness, so it is state. */
function snapshot(
  path: string,
  timeKey: string,
  ttlMs: number,
  nowMs: number,
): string {
  if (!existsSync(path)) return `${path}:absent`;
  const text = readFileSync(path, "utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return `${path}:malformed:${text}`;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    return `${path}:unexpected:${text}`;
  const {
    [timeKey]: time,
    generatedBy: _by,
    ...content
  } = doc as Record<string, unknown>;
  const fresh = typeof time === "number" && nowMs - time <= ttlMs;
  return `${path}:${fresh}:${JSON.stringify(content)}`;
}

export function stateRevision(nowMs = Date.now()): StateRevision {
  const parts: string[] = [];
  tree(INBOX_DIR, 0, parts);
  tree(READ_DIR, 0, parts);
  tree(OBLIGATIONS_DIR, 0, parts);
  tree(TRANSFERS_DIR, 0, parts);
  tree(CLAIMS_DIR, 2, parts);
  tree(WORK_DIR, 2, parts);
  // Obligation role resolution reads the live registry, not the snapshot.
  tree(REGISTRY_DIR, 0, parts);
  // The message index's files move when an ingest commits. A state read that
  // fell back to a stale projection (freshness.messages: false) then sees the
  // digest move once the peer's ingest lands, even though no spool changed.
  identity(MESSAGE_INDEX_PATH, parts);
  identity(`${MESSAGE_INDEX_PATH}-wal`, parts);
  // Presence names and statuses: Claude's per-session status files, the
  // alias table in the config, and generated-name assignments. Assignments
  // are written once each and there are thousands, so the directory's
  // identity stands in for them.
  tree(CLAUDE_SESSIONS_DIR, 0, parts);
  identity(CONFIG_PATH, parts);
  identity(SESSION_NAMES_DIR, parts);
  parts.push(
    snapshot(
      PRESENCE_SNAPSHOT_PATH,
      "generatedAt",
      PRESENCE_SNAPSHOT_TTL_MS,
      nowMs,
    ),
    snapshot(
      PROCESS_SNAPSHOT_PATH,
      "generatedAt",
      PROCESS_SNAPSHOT_TTL_MS,
      nowMs,
    ),
    snapshot(
      LEDGER_ISSUES_SNAPSHOT_PATH,
      "observedAt",
      LEDGER_ISSUES_SNAPSHOT_TTL_MS,
      nowMs,
    ),
  );
  return {
    kind: "agent_mail_state_revision",
    version: 1,
    digest: createHash("sha256").update(parts.join("\n")).digest("hex"),
    generatedAt: new Date(nowMs).toISOString(),
  };
}
