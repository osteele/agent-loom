import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  adoptLegacyEnvironment,
  migrateDirectory,
  migrateLegacyDirectories,
} from "./legacyName.ts";

test("an AGENT_MAIL_ setting fills the AGENT_LOOM_ name only when that is unset", () => {
  const env: Record<string, string | undefined> = {
    AGENT_MAIL_PORT: "9001",
    AGENT_MAIL_INBOUND_POLICY: "hold",
    AGENT_LOOM_INBOUND_POLICY: "refuse",
    UNRELATED: "x",
  };
  adoptLegacyEnvironment(env);
  expect(env.AGENT_LOOM_PORT).toBe("9001");
  expect(env.AGENT_LOOM_INBOUND_POLICY).toBe("refuse");
  expect(env.AGENT_LOOM_UNRELATED).toBeUndefined();
});

test("migration moves the old directory and leaves a symlink a stale build can follow", () => {
  const home = mkdtempSync(join(tmpdir(), "loom-migrate-"));
  const old = join(home, ".claude", "agent-mail");
  mkdirSync(join(old, "inbox"), { recursive: true });
  writeFileSync(join(old, "inbox", "m.jsonl"), "x\n");

  const [state, config] = migrateLegacyDirectories(home);
  expect(state.outcome).toBe("moved");
  expect(config.outcome).toBe("absent");
  const moved = join(home, ".claude", "agent-loom");
  expect(lstatSync(old).isSymbolicLink()).toBe(true);
  expect(realpathSync(old)).toBe(realpathSync(moved));
  expect(readFileSync(join(old, "inbox", "m.jsonl"), "utf8")).toBe("x\n");

  expect(migrateLegacyDirectories(home)[0].outcome).toBe("already-migrated");
});

test("migration refuses to merge when both directories are real", () => {
  const home = mkdtempSync(join(tmpdir(), "loom-conflict-"));
  const from = join(home, "old");
  const to = join(home, "new");
  mkdirSync(from);
  mkdirSync(to);
  expect(migrateDirectory(from, to).outcome).toBe("conflict");
  expect(lstatSync(from).isSymbolicLink()).toBe(false);
  expect(existsSync(to)).toBe(true);
});

// The audit hook is launched on its own by Claude Code, so it must adopt the
// legacy environment itself rather than relying on the CLI having done so.
test("the audit hook entry point adopts AGENT_MAIL_ settings when imported", () => {
  const home = mkdtempSync(join(tmpdir(), "loom-audit-env-"));
  const audit = resolve(import.meta.dir, "nativeAudit.ts");
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `await import(${JSON.stringify(audit)}); console.log(process.env.AGENT_LOOM_PORT ?? "unset");`,
    ],
    {
      env: { PATH: process.env.PATH, HOME: home, AGENT_MAIL_PORT: "47123" },
      encoding: "utf8",
    },
  );
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("47123");
});

// An MCP-only setup never runs `install`, so the first process to start must
// adopt the old store.
test("a fresh process moves the old store without install", () => {
  const home = mkdtempSync(join(tmpdir(), "loom-first-run-"));
  const old = join(home, ".claude", "agent-mail");
  mkdirSync(join(old, "inbox"), { recursive: true });
  writeFileSync(join(old, "inbox", "m.jsonl"), "x\n");
  const module = resolve(import.meta.dir, "legacyName.ts");
  const result = spawnSync(
    process.execPath,
    ["-e", `await import(${JSON.stringify(module)});`],
    { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  expect(lstatSync(old).isSymbolicLink()).toBe(true);
  expect(
    readFileSync(
      join(home, ".claude", "agent-loom", "inbox", "m.jsonl"),
      "utf8",
    ),
  ).toBe("x\n");
});

test("install --dry-run leaves the old store in place", () => {
  const home = mkdtempSync(join(tmpdir(), "loom-dry-run-"));
  const old = join(home, ".claude", "agent-mail");
  mkdirSync(old, { recursive: true });
  const cli = resolve(import.meta.dir, "cli.ts");
  const result = spawnSync(process.execPath, [cli, "install", "--dry-run"], {
    env: { PATH: process.env.PATH, HOME: home },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(lstatSync(old).isSymbolicLink()).toBe(false);
  expect(existsSync(join(home, ".claude", "agent-loom"))).toBe(false);
});
