/** Guard against a suite writing into the developer's real state directory.
 *
 * `paths.ts` resolves STATE_DIR from `homedir()` at module load, so a suite run
 * with the real HOME writes spool, read, and receipt files into
 * ~/.claude/agent-mail. Two suites did, leaving ~37k fuzzed files there.
 *
 * This cannot fix it — Bun captures HOME at process start and ignores mutation
 * of `process.env.HOME`, so redirecting from a preload is too late. Only
 * `scripts/test.sh` can, by setting HOME before bun starts. What this can do is
 * make a bare `bun test` fail immediately and say so, rather than silently
 * polluting live state again. */
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

const home = realpathSync(homedir());
if (!home.startsWith(realpathSync(tmpdir()))) {
  throw new Error(
    `agent-mail tests must run under a throwaway HOME (got ${home}). Run \`bun run test\` (scripts/test.sh) rather than \`bun test\`: paths.ts resolves the state root from homedir() at module load, so a suite run with your real HOME writes into ~/.claude/agent-mail.`,
  );
}
