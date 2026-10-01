import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Registration } from "./registry.ts";
import { WorkStore } from "./work.ts";
import {
  claimWorkspaceOwner,
  releaseWorkspaceOwner,
  resolveWorkspaceOwner,
} from "./workspaceOwner.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-owner-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const store = new WorkStore(join(root, "work"));
  // Injected registry evidence exercises process-identity matching without querying these synthetic PIDs.
  const alpha: Registration = {
    cwd: project,
    pid: 101,
    procStart: "start-a",
    instanceId: "connection-a",
    sessionId: "owner-alpha",
    started: new Date().toISOString(),
  };
  const beta: Registration = {
    ...alpha,
    pid: 102,
    procStart: "start-b",
    instanceId: "connection-b",
    sessionId: "owner-beta",
  };
  return { root, project, store, alpha, beta };
}

test("inference counts logical sessions, follows canonical paths, and does not become sticky", () => {
  const { root, project, store, alpha, beta } = fixture();
  const alias = join(root, "alias");
  symlinkSync(project, alias);
  const secondTransport = {
    ...alpha,
    cwd: alias,
    pid: 103,
    procStart: "start-c",
  };
  expect(
    resolveWorkspaceOwner(alias, [alpha, secondTransport], store),
  ).toMatchObject({
    status: "resolved",
    source: "inferred",
    sessionId: alpha.sessionId,
  });
  expect(
    resolveWorkspaceOwner(project, [alpha, secondTransport, beta], store)
      .status,
  ).toBe("ambiguous");
  expect(resolveWorkspaceOwner(project, [beta], store)).toMatchObject({
    status: "resolved",
    source: "inferred",
    sessionId: beta.sessionId,
  });
  expect(resolveWorkspaceOwner(project, [], store).status).toBe("unavailable");
});

test("assignment excludes other callers and survives reconnects but not recycled process identities", () => {
  const { project, store, alpha, beta } = fixture();
  claimWorkspaceOwner(project, "owner-alpha", [alpha], store);
  const reconnected = { ...alpha, instanceId: "replacement-connection" };
  expect(
    resolveWorkspaceOwner(project, [reconnected, beta], store),
  ).toMatchObject({
    status: "resolved",
    source: "assigned",
    sessionId: alpha.sessionId,
  });
  expect(() =>
    claimWorkspaceOwner(project, "owner-beta", [reconnected, beta], store),
  ).toThrow();
  expect(() =>
    releaseWorkspaceOwner(project, "owner-beta", [reconnected, beta], store),
  ).toThrow();
  const recycled = { ...alpha, procStart: "replacement-process" };
  expect(resolveWorkspaceOwner(project, [recycled, beta], store).status).toBe(
    "ambiguous",
  );
  releaseWorkspaceOwner(project, "owner-alpha", [reconnected, beta], store);
  expect(
    resolveWorkspaceOwner(project, [reconnected, beta], store).status,
  ).toBe("ambiguous");
});

test("an assigned owner without a mailbox in this project blocks singleton inference", () => {
  const { root, project, store, alpha, beta } = fixture();
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  claimWorkspaceOwner(project, "owner-alpha", [alpha], store);
  expect(
    resolveWorkspaceOwner(project, [{ ...alpha, cwd: elsewhere }, beta], store)
      .status,
  ).toBe("unavailable");
  expect(resolveWorkspaceOwner(project, [beta], store)).toMatchObject({
    status: "resolved",
    source: "inferred",
    sessionId: beta.sessionId,
  });
});
