import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMcpStartupDiagnostic,
  diagnosticError,
  mcpStartupDiagnostic,
} from "./mcpDiagnostics.ts";

test("MCP startup diagnostics preserve a sanitized exception", () => {
  const error = Object.assign(new Error("name lock timed out"), {
    code: "ETIMEDOUT",
  });
  expect(diagnosticError(error)).toMatchObject({
    name: "Error",
    message: "name lock timed out",
    code: "ETIMEDOUT",
  });

  const diagnostic = mcpStartupDiagnostic({
    event: "uncaught-exception",
    phase: "resolve-session-name",
    now: new Date("2026-09-02T00:00:00.000Z"),
    origin: "unhandledRejection",
    error,
  });
  expect(diagnostic).toMatchObject({
    version: 1,
    timestamp: "2026-09-02T00:00:00.000Z",
    event: "uncaught-exception",
    phase: "resolve-session-name",
    origin: "unhandledRejection",
    error: { message: "name lock timed out", code: "ETIMEDOUT" },
  });
  expect(JSON.stringify(diagnostic)).not.toContain("AGENT_SESSION_ID");
});

test("MCP startup diagnostics append as JSONL", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-mcp-diagnostic-"));
  const path = join(root, "nested", "failures.jsonl");
  try {
    const diagnostic = mcpStartupDiagnostic({
      event: "exit-before-initialize",
      phase: "waiting-for-initialize",
      now: new Date("2026-09-02T00:00:00.000Z"),
      exitCode: 1,
    });
    expect(appendMcpStartupDiagnostic(diagnostic, path)).toBe(true);
    expect(
      readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([diagnostic]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
