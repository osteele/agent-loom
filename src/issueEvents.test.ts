import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueWatcherSessions } from "./issueEvents.ts";
import { projectSlug } from "./paths.ts";
import { processInfo } from "./registry.ts";

const cli = join(import.meta.dir, "cli.ts");

type Notice = {
  from: string;
  message: string;
  meta: Record<string, string>;
  origin: Record<string, string>;
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-issue-hook-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const registry = join(home, ".claude", "agent-mail", "registry");
  mkdirSync(registry, { recursive: true });
  const register = (sessionId: string, parentPid = process.pid) => {
    writeFileSync(
      join(registry, `${projectSlug(project)}-${process.pid}.json`),
      JSON.stringify({
        cwd: project,
        pid: process.pid,
        parentPid,
        procStart: processInfo([process.pid]).get(process.pid)?.start,
        sessionId,
        started: new Date().toISOString(),
      }),
    );
  };
  const run = async (
    command: string,
    input?: string,
    sessionId = "inherited",
  ) => {
    const child = Bun.spawn([process.execPath, cli, "issues", command], {
      env: {
        ...process.env,
        HOME: home,
        AGENT_MAIL_PORT: "0",
        CLAUDE_CODE_SESSION_ID: sessionId,
        CODEX_THREAD_ID: "",
        AGENT_SESSION_ID: "",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(input ?? "");
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  return {
    root,
    home,
    project,
    register,
    run,
    close: () => rmSync(root, { recursive: true }),
  };
}

const issue = (component_path: string, watchers: string[] = []) => ({
  schema: "issue-ledger-event/v1",
  event: "reported",
  issue: {
    id: "am17",
    title: "retry loop",
    severity: "high",
    component: "project",
    component_path,
    status: "open",
    watchers,
    close_reason: "fixed",
  },
});

test("watcher-token requires a live host ancestor, not merely an inherited id", async () => {
  const f = fixture();
  try {
    f.register("inherited");
    expect(await f.run("watcher-token")).toMatchObject({
      code: 0,
      stdout: "agent-mail:inherited\n",
    });
    f.register("inherited", 987654321);
    expect(await f.run("watcher-token")).toMatchObject({
      code: 0,
      stdout: "",
    });
    expect(await f.run("watcher-token", "", "unknown")).toMatchObject({
      code: 0,
      stdout: "",
    });
  } finally {
    f.close();
  }
});

test("event rejects invalid JSON and schema with exit 2", async () => {
  const f = fixture();
  try {
    const invalid = await f.run("event", "{");
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("JSON");
    const schema = await f.run(
      "event",
      JSON.stringify({ ...issue(f.project), schema: "other" }),
    );
    expect(schema.code).toBe(2);
    expect(schema.stderr).toContain("schema");
  } finally {
    f.close();
  }
});

test("reported sends exactly one owner notice via exact-session automation delivery", async () => {
  const f = fixture();
  const bodies: Notice[] = [];
  const refreshes: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/notify") {
        refreshes.push(new URL(request.url).pathname);
        return Response.json({ ok: true });
      }
      bodies.push((await request.json()) as Notice);
      return Response.json({ status: "spooled", id: "notice" });
    },
  });
  try {
    f.register("owner-session");
    // The reporting shell's id does not stamp an automation sender identity.
    const child = Bun.spawn([process.execPath, cli, "issues", "event"], {
      env: {
        ...process.env,
        HOME: f.home,
        AGENT_MAIL_PORT: String(server.port),
        CLAUDE_CODE_SESSION_ID: "owner-session",
        CODEX_THREAD_ID: "",
        AGENT_SESSION_ID: "",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify(issue(f.project)));
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      from: "issue-ledger",
      meta: { toSession: "owner-session" },
      origin: {
        kind: "automation",
        transport: "cli",
        authority: "untrusted",
      },
    });
    expect(bodies[0].meta.sessionId).toBeUndefined();
    expect(bodies[0].message).toContain("issues show am17");
    expect(bodies[0].message).toContain("high");
    expect(refreshes).toEqual(["/api/v1/ledger-issues/refresh"]);
  } finally {
    server.stop(true);
    f.close();
  }
});

test("unresolved owner warns without sending; no daemon is harmless", async () => {
  const f = fixture();
  try {
    const result = await f.run(
      "event",
      JSON.stringify(issue(join(f.root, "missing"))),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("owner unresolved");
    expect(result.stdout).toBe("");
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        paths.push(new URL(request.url).pathname);
        return Response.json({ ok: true });
      },
    });
    try {
      const child = Bun.spawn([process.execPath, cli, "issues", "event"], {
        env: {
          ...process.env,
          HOME: f.home,
          AGENT_MAIL_PORT: String(server.port),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.write(JSON.stringify(issue(join(f.root, "missing"))));
      child.stdin.end();
      expect(await child.exited).toBe(0);
      expect(paths).toEqual(["/api/v1/ledger-issues/refresh"]);
    } finally {
      server.stop(true);
    }
  } finally {
    f.close();
  }
});

test("closed notifies only live agent-mail watchers; quiet events never send", async () => {
  const f = fixture();
  const bodies: Notice[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/notify")
        return Response.json({ ok: true });
      bodies.push((await request.json()) as Notice);
      return Response.json({ status: "spooled", id: "notice" });
    },
  });
  try {
    f.register("live-watcher");
    const run = async (event: string) => {
      const child = Bun.spawn([process.execPath, cli, "issues", "event"], {
        env: {
          ...process.env,
          HOME: f.home,
          AGENT_MAIL_PORT: String(server.port),
          CLAUDE_CODE_SESSION_ID: "",
          CODEX_THREAD_ID: "",
          AGENT_SESSION_ID: "",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.write(
        JSON.stringify({
          ...issue(f.project, [
            "agent-mail:live-watcher",
            "foreign:peer",
            "agent-mail:offline",
          ]),
          event,
        }),
      );
      child.stdin.end();
      const [code, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      return { code, stderr };
    };
    const closed = await run("closed");
    expect(closed.code).toBe(0);
    expect(closed.stderr).toContain("offline");
    expect(bodies).toHaveLength(1);
    expect(bodies[0].meta.toSession).toBe("live-watcher");
    expect(bodies[0].message).toContain("fixed");
    for (const event of ["recurred", "reopened"]) {
      const result = await run(event);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("offline");
    }
    // This session is both the inferred owner and a watcher: each transition
    // sends the owner notice and the separate watcher notice.
    expect(bodies).toHaveLength(5);
    for (const event of ["sighted", "noted", "watched", "unwatched"]) {
      expect((await run(event)).code).toBe(0);
    }
    expect(bodies).toHaveLength(5);
  } finally {
    server.stop(true);
    f.close();
  }
});

// A foreign token longer than the agent-mail: prefix, so dropping the prefix
// check would leave a non-empty suffix that routes a notice to a bogus
// session rather than being filtered out by accident.
test("only agent-mail: tokens name watcher sessions", () => {
  expect(
    issueWatcherSessions([
      "agent-mail:sess-a",
      "other-tool:session-0123456789",
      "agent-mail:sess-a",
      "agent-mail:",
    ]),
  ).toEqual(["sess-a"]);
});
