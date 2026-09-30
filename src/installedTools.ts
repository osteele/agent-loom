/** Locating the CLIs the daemon shells out to (`weft`, `issues`).
 *
 * The daemon runs under launchd with a minimal PATH, so a bare name that
 * resolves in an interactive shell does not resolve there. Probing the usual
 * install locations keeps each refresher working without making the daemon
 * depend on a login environment it does not have. An explicit override names
 * the binary exactly and is never second-guessed: a missing override target is
 * "not found", not a cue to search elsewhere. */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { which } from "./runtime.ts";

export function resolveInstalledTool(
  command: string,
  override: string | undefined,
): string | undefined {
  if (override) return existsSync(override) ? override : undefined;
  const found = which(command);
  if (found) return found;
  for (const dir of [
    join(homedir(), "go", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local", "bin"),
  ]) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
