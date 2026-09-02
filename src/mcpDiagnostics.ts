/** Durable diagnostics for failures before an MCP handshake completes.
 *
 * Some hosts discard MCP subprocess stderr. A pre-handshake exception then
 * reaches the user only as "stdout closed", with the useful stack erased.
 * This module preserves a sanitized, append-only local record without ever
 * touching protocol stdout or recording environment variables, messages, or
 * MCP request bodies.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MCP_STARTUP_FAILURES_PATH } from "./paths.ts";

export type McpDiagnosticEvent =
  | "uncaught-exception"
  | "exit-before-initialize";

export interface McpStartupDiagnostic {
  version: 1;
  timestamp: string;
  event: McpDiagnosticEvent;
  phase: string;
  pid: number;
  parentPid: number;
  cwd: string;
  runtime: string;
  runtimeVersion: string;
  exitCode?: number;
  origin?: string;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string | number;
  };
}

let installed = false;
let initialized = false;
let fatalRecorded = false;
let startupPhase = "module-load";

function runtimeIdentity(): { runtime: string; runtimeVersion: string } {
  const bunVersion = process.versions.bun;
  return bunVersion
    ? { runtime: "bun", runtimeVersion: bunVersion }
    : { runtime: "node", runtimeVersion: process.version };
}

export function diagnosticError(value: unknown): {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
} {
  if (!(value instanceof Error)) {
    return { name: "NonError", message: String(value) };
  }
  const code = (value as NodeJS.ErrnoException).code;
  return {
    name: value.name,
    message: value.message,
    ...(value.stack ? { stack: value.stack } : {}),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
  };
}

export function mcpStartupDiagnostic(input: {
  event: McpDiagnosticEvent;
  phase: string;
  now?: Date;
  exitCode?: number;
  origin?: string;
  error?: unknown;
}): McpStartupDiagnostic {
  return {
    version: 1,
    timestamp: (input.now ?? new Date()).toISOString(),
    event: input.event,
    phase: input.phase,
    pid: process.pid,
    parentPid: process.ppid,
    cwd: process.cwd(),
    ...runtimeIdentity(),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.error !== undefined
      ? { error: diagnosticError(input.error) }
      : {}),
  };
}

/** Append one diagnostic without risking a second failure on the fatal path. */
export function appendMcpStartupDiagnostic(
  diagnostic: McpStartupDiagnostic,
  path = MCP_STARTUP_FAILURES_PATH,
): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(diagnostic)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function installMcpStartupDiagnostics(): void {
  if (installed) return;
  installed = true;

  process.on("uncaughtExceptionMonitor", (error, origin) => {
    fatalRecorded = true;
    appendMcpStartupDiagnostic(
      mcpStartupDiagnostic({
        event: "uncaught-exception",
        phase: startupPhase,
        origin,
        error,
      }),
    );
  });

  process.on("exit", (code) => {
    if (initialized || fatalRecorded) return;
    appendMcpStartupDiagnostic(
      mcpStartupDiagnostic({
        event: "exit-before-initialize",
        phase: startupPhase,
        exitCode: code,
      }),
    );
  });
}

export function setMcpStartupPhase(phase: string): void {
  startupPhase = phase;
}

export function markMcpInitialized(): void {
  initialized = true;
  startupPhase = "initialized";
}
