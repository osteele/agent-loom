/** Per-session unread-mail counts, cached for hook-driven reminders.
 *
 * Pull-only harnesses (Codex, Kimi, Gemini) never learn about unread mail
 * unless they ask, so their hooks run `agent-mail remind` on harness events
 * and that command must answer from a file: a hook fires per turn, sometimes
 * per tool call, and a spool scan per event is work the harness pays for
 * synchronously. The daemon already enumerates the live sessions on its 10s
 * presence tick; it publishes their unread counts here and the hook reads
 * the file.
 *
 * The same two invariants as `presence.ts` and `weftJobs.ts`, for the same
 * reasons:
 *
 * - **A presentation cache, never a routing input.** These counts are stale
 *   by construction. Nothing that decides delivery or coordination may read
 *   them, and the reminder text they feed carries only the count and the
 *   newest timestamp — never message bodies or sender names, which are
 *   peer-claimed and untrusted.
 * - **Raw counts, never derived text.** The file holds per-session counts
 *   and message ids/timestamps, nothing that depends on config, so the
 *   refresh needs no SIGHUP coupling.
 *
 * Readers degrade to silence. A missing, malformed, or stale snapshot
 * produces no count claim — never an implied 0, which would let a stopped
 * daemon read as an empty inbox — plus a rate-limited diagnostic line from
 * the `remind` command.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { UNREAD_SUMMARY_PATH, canonicalProject } from "./paths.ts";
import type { Registration } from "./registry.ts";
import { readMessages, readReceipts } from "./spool.ts";
import { filterUnreadForSession } from "./unread.ts";

/** One session's unread view of its project's shared spool. */
export interface UnreadSummaryEntry {
  /** Canonical project directory the session is registered in. */
  project: string;
  unread: number;
  /** Id and ISO timestamp of the newest visible unread message; both null
   * when unread is 0. The id is the reminder's edge trigger: a changed
   * newest id means new mail arrived since the last reminder. */
  newestId: string | null;
  newestTs: string | null;
}

export interface UnreadSummarySnapshot {
  version: 1;
  /** Epoch ms the scan ran. In-band rather than the file's mtime, which a
   * backup restore or `cp -p` destroys and a torn write refreshes. */
  generatedAt: number;
  /** Writing daemon's pid, for explaining a stale file. */
  generatedBy: number;
  bySession: Record<string, UnreadSummaryEntry>;
}

const SNAPSHOT_VERSION = 1;

/** Three presence ticks, matching how `presence.ts` sizes its own TTL: one
 * missed refresh is tolerated, a stopped daemon is not. The summary rides
 * the 10s tick, so there is no separate refresh interval. */
export const UNREAD_SUMMARY_SNAPSHOT_TTL_MS = 30_000;

/** Compute unread counts for every live, unmuted session.
 *
 * One spool scan per project, not per session: sessions sharing a project
 * share its spool, and the per-session part is a filter over the same scan
 * (`filterUnreadForSession`).
 *
 * Muted sessions are omitted entirely. Mute silences reminders exactly as it
 * silences channel push, and a missing entry reads downstream as "nothing to
 * say" — indistinguishable from a session the daemon has not ticked yet,
 * which is the safe direction. */
export function computeUnreadSummary(
  sessions: Pick<Registration, "sessionId" | "cwd" | "muted">[],
): Record<string, UnreadSummaryEntry> {
  const byProject = new Map<string, string[]>();
  for (const session of sessions) {
    if (session.muted || !session.sessionId) continue;
    const project = canonicalProject(session.cwd);
    const ids = byProject.get(project) ?? [];
    ids.push(session.sessionId);
    byProject.set(project, ids);
  }
  const bySession: Record<string, UnreadSummaryEntry> = {};
  for (const [project, sessionIds] of byProject) {
    const unread = readMessages(project, { limit: 0, unreadOnly: true });
    const receipts = readReceipts(project);
    for (const sessionId of sessionIds) {
      const visible = filterUnreadForSession(unread, receipts, sessionId);
      const newest = visible.at(-1);
      bySession[sessionId] = {
        project,
        unread: visible.length,
        newestId: newest?.id ?? null,
        newestTs: newest?.ts ?? null,
      };
    }
  }
  return bySession;
}

/** Publish a snapshot. Temp file plus rename, so a reader on a latency
 * budget never parses a half-written file. */
export function writeUnreadSummarySnapshot(
  bySession: Record<string, UnreadSummaryEntry>,
  nowMs = Date.now(),
  path = UNREAD_SUMMARY_PATH,
): UnreadSummarySnapshot {
  const snapshot: UnreadSummarySnapshot = {
    version: SNAPSHOT_VERSION,
    generatedAt: nowMs,
    generatedBy: process.pid,
    bySession,
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 1));
  renameSync(tmp, path);
  return snapshot;
}

/** The snapshot if it exists, parses, matches the version, and is younger
 * than `maxAgeMs`. Never throws: a hook that crashes its harness's event
 * handling is worse than one that says nothing. */
export function readUnreadSummarySnapshot(
  nowMs = Date.now(),
  maxAgeMs = UNREAD_SUMMARY_SNAPSHOT_TTL_MS,
  path = UNREAD_SUMMARY_PATH,
): UnreadSummarySnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined; // missing or unparseable
  }
  const snapshot = parsed as Partial<UnreadSummarySnapshot>;
  if (snapshot.version !== SNAPSHOT_VERSION) return undefined;
  if (typeof snapshot.generatedAt !== "number") return undefined;
  if (!Number.isFinite(snapshot.generatedAt)) return undefined;
  if (typeof snapshot.bySession !== "object" || snapshot.bySession === null) {
    return undefined;
  }
  if (nowMs - snapshot.generatedAt > maxAgeMs) return undefined;
  return snapshot as UnreadSummarySnapshot;
}
