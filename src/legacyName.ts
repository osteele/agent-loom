/** Compatibility with the name this project had before agent-loom: agent-mail.
 *
 * Every entry point (CLI, channel server, daemon, audit hook) imports this
 * module first, for two side effects:
 *
 * - Each `AGENT_MAIL_*` environment variable is copied to its `AGENT_LOOM_*`
 *   name when the new name is unset, so a shell profile, launchd plist, or
 *   test harness configured before the rename keeps working and every reader
 *   in this codebase consults only the new names.
 * - The state and config directories are moved to their new names, leaving
 *   the old paths as symlinks, the first time any entry point runs. This must
 *   not wait for `agent-loom install`: an MCP-only setup never runs it, and
 *   would otherwise start on an empty store while the old mail sat unread.
 *   A client still running a build from before the rename keeps working
 *   through the symlink.
 *
 * When both directories already hold data the move is refused, never merged;
 * `agent-loom install` reports that conflict.
 */

import { existsSync, lstatSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LEGACY_ENV_PREFIX = "AGENT_MAIL_";
const ENV_PREFIX = "AGENT_LOOM_";

export const LEGACY_LAUNCHD_LABEL = "com.osteele.agent-mail";

export function adoptLegacyEnvironment(
  env: Record<string, string | undefined> = process.env,
): void {
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue;
    const current = ENV_PREFIX + name.slice(LEGACY_ENV_PREFIX.length);
    if (env[current] === undefined) env[current] = value;
  }
}

export interface DirectoryMigration {
  from: string;
  to: string;
  outcome: "moved" | "already-migrated" | "absent" | "conflict";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** Move `from` to `to` and leave `from` as a symlink to `to`. A `to` that
 * already exists while `from` is still a real directory is a conflict to
 * report, never to merge. Several processes may start at once after an
 * upgrade; whichever loses the race finds the work done. */
export function migrateDirectory(from: string, to: string): DirectoryMigration {
  if (!existsSync(from)) return { from, to, outcome: "absent" };
  if (lstatSync(from).isSymbolicLink()) {
    return { from, to, outcome: "already-migrated" };
  }
  if (existsSync(to)) return { from, to, outcome: "conflict" };
  try {
    renameSync(from, to);
  } catch (error) {
    // ENOENT: another process moved it first.
    if (errorCode(error) !== "ENOENT") throw error;
  }
  try {
    symlinkSync(to, from);
  } catch (error) {
    // EEXIST: another process left the symlink first.
    if (errorCode(error) !== "EEXIST") throw error;
  }
  return { from, to, outcome: "moved" };
}

export function migrateLegacyDirectories(
  home = homedir(),
): DirectoryMigration[] {
  return [
    migrateDirectory(
      join(home, ".claude", "agent-mail"),
      join(home, ".claude", "agent-loom"),
    ),
    migrateDirectory(
      join(home, ".config", "agent-mail"),
      join(home, ".config", "agent-loom"),
    ),
  ];
}

adoptLegacyEnvironment();
// A dry run promises to change nothing, so it does not move directories.
if (!process.argv.includes("--dry-run")) migrateLegacyDirectories();
