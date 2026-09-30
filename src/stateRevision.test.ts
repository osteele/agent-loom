import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// paths.ts fixes STATE_DIR from HOME at load, so each scenario runs in a child.
test("the state revision moves with state's inputs and not with snapshot ticks", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-mail-rev-")));
  // Claude's session directory follows CLAUDE_CONFIG_DIR, which must not
  // point the child at the developer's real sessions.
  const { CLAUDE_CONFIG_DIR: _real, ...env } = process.env;
  try {
    const code = `
      import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import * as paths from ${JSON.stringify(join(import.meta.dir, "paths.ts"))};
      import { stateRevision } from ${JSON.stringify(join(import.meta.dir, "stateRevision.ts"))};
      const now = 1_000_000_000;
      const rev = (at = now) => stateRevision(at).digest;
      const presence = (at, sessions) => writeFileSync(paths.PRESENCE_SNAPSHOT_PATH,
        JSON.stringify({ version: 1, generatedAt: at, generatedBy: 1, sessions }));
      for (const dir of [paths.INBOX_DIR, paths.READ_DIR, join(paths.CLAIMS_DIR, "p")])
        mkdirSync(dir, { recursive: true });
      presence(now, []);
      const results = {};
      const base = rev();
      results.stable = rev() === base;
      presence(now + 10_000, []);
      results.tickIgnored = rev(now + 10_000) === base;
      results.staleCounts = rev(now + 60_000) !== rev(now + 10_000);
      let last = rev(now + 10_000);
      const moved = (label) => { const next = rev(now + 10_000); results[label] = next !== last; last = next; };
      appendFileSync(join(paths.INBOX_DIR, "p.jsonl"), "{}\\n"); moved("spool");
      appendFileSync(join(paths.READ_DIR, "p.read"), "id\\n"); moved("readMark");
      writeFileSync(join(paths.CLAIMS_DIR, "p", "c.json"), "{}"); moved("claim");
      presence(now + 10_000, [{ pid: 1 }]); moved("presence");
      mkdirSync(paths.REGISTRY_DIR, { recursive: true });
      writeFileSync(join(paths.REGISTRY_DIR, "1.json"), "{}"); moved("registration");
      const sessions = join(process.env.HOME, ".claude", "sessions");
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(sessions, "1.json"), '{"status":"busy"}'); moved("sessionStatus");
      writeFileSync(join(sessions, "1.json"), '{"status":"idle"}'); moved("sessionStatusRewrite");
      mkdirSync(paths.SESSION_NAMES_DIR, { recursive: true }); moved("namesDir");
      writeFileSync(join(paths.SESSION_NAMES_DIR, "s.json"), "{}"); moved("nameAssigned");
      mkdirSync(paths.CONFIG_DIR, { recursive: true });
      writeFileSync(paths.CONFIG_PATH, "[aliases]\\n"); moved("config");
      writeFileSync(paths.MESSAGE_INDEX_PATH + "-wal", "commit"); moved("indexCommit");
      console.log(JSON.stringify(results));
    `;
    const result = spawnSync(process.execPath, ["-e", code], {
      env: { ...env, HOME: home },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      stable: true,
      tickIgnored: true,
      staleCounts: true,
      spool: true,
      readMark: true,
      claim: true,
      presence: true,
      registration: true,
      sessionStatus: true,
      sessionStatusRewrite: true,
      namesDir: true,
      nameAssigned: true,
      config: true,
      indexCommit: true,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
