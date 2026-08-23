/** Per-session reminder bookkeeping for startup and hook-driven announcements.
 *
 * One JSON file per (project, session): `announced/<slug>-<sessionId>.json`.
 * It records what the MCP startup instructions or `remind` command last told
 * a session so the next hook event can decide whether anything changed (edge
 * trigger) and bound how often a session is re-reminded about mail it keeps
 * not reading.
 *
 * This is reminder bookkeeping, NOT delivery evidence. A reminder delivers
 * nothing — the message still reaches the session only via channel push or
 * an inbox pull, and only those write receipts. Nothing here ever touches
 * `receipts/` or the terminal-receipt logic in `delivery.ts`; see
 * `docs/automation.md` for what `pushed`/`read` receipts actually mean.
 * Conversely, nothing that computes delivery state reads this store.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANNOUNCED_DIR, projectSlug } from "./paths.ts";

export interface AnnouncedState {
  version: 1;
  sessionId: string;
  project: string;
  /** Newest visible unread message id the session was last reminded about.
   * Absent when no reminder has fired yet (a diagnostics-only write). */
  lastNewestId?: string;
  /** Unread count at the last reminder. */
  lastUnread: number;
  /** Epoch ms of the last reminder. */
  announcedAt: number;
  /** Reminders issued so far, counting re-reminders. */
  remindCount: number;
  /** Epoch ms of the last diagnostics-log line; rate-limits stale-summary
   * warnings so a hook firing per turn cannot flood the log. */
  lastDiagAt?: number;
}

const STATE_VERSION = 1;

export function announcedPath(
  project: string,
  sessionId: string,
  dir = ANNOUNCED_DIR,
): string {
  return join(dir, `${projectSlug(project)}-${sessionId}.json`);
}

/** The recorded state, or undefined when the file is missing, unparseable,
 * or from another version. Never throws: reminder bookkeeping must not be
 * able to break a hook, and treating corruption as "no prior reminder"
 * costs at most one repeated reminder. */
export function readAnnouncedState(
  project: string,
  sessionId: string,
  dir = ANNOUNCED_DIR,
): AnnouncedState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(announcedPath(project, sessionId, dir), "utf8"),
    );
  } catch {
    return undefined; // missing or unparseable
  }
  const state = parsed as Partial<AnnouncedState>;
  if (state.version !== STATE_VERSION) return undefined;
  if (typeof state.sessionId !== "string") return undefined;
  if (typeof state.announcedAt !== "number") return undefined;
  return state as AnnouncedState;
}

/** Persist the state. Temp file plus rename, so a concurrent hook never
 * reads a half-written file. */
export function writeAnnouncedState(
  state: AnnouncedState,
  dir = ANNOUNCED_DIR,
): void {
  mkdirSync(dir, { recursive: true });
  const path = announcedPath(state.project, state.sessionId, dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, path);
}
