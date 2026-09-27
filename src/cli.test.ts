import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSlug } from "./paths.ts";
import { processInfo } from "./registry.ts";

test("notify --no-slack suppresses only that message's Slack echo", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>);
      return Response.json({ ok: true, status: "spooled", id: "test" });
    },
  });
  const project = mkdtempSync(join(tmpdir(), "agent-mail-cli-test-"));
  const cli = join(import.meta.dir, "cli.ts");

  try {
    for (const extra of [[], ["--no-slack"]]) {
      const child = Bun.spawn(
        [
          process.execPath,
          cli,
          "notify",
          "--project",
          project,
          "--message",
          "test message",
          ...extra,
        ],
        {
          env: { ...process.env, AGENT_MAIL_PORT: String(server.port) },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await child.exited).toBe(0);
    }
  } finally {
    server.stop(true);
    rmSync(project, { recursive: true });
  }

  expect(requests).toHaveLength(2);
  expect(requests[0].slackEcho).toBeUndefined();
  expect(requests[1].slackEcho).toBe(false);
});

/** Register this test process as `sessionId`'s channel server under `home`, so
 * a CLI subprocess run with that HOME finds a live, addressable session. */
function registerLiveSession(
  home: string,
  project: string,
  sessionId: string,
): void {
  const registry = join(home, ".claude", "agent-mail", "registry");
  mkdirSync(registry, { recursive: true });
  const procStart = processInfo([process.pid]).get(process.pid)?.start;
  expect(procStart).toBeTruthy();
  writeFileSync(
    join(registry, `${projectSlug(project)}-${process.pid}.json`),
    JSON.stringify({
      cwd: realpathSync(project),
      pid: process.pid,
      procStart,
      sessionId,
      started: new Date().toISOString(),
    }),
  );
}

test("status-line prints nothing and exits 0 without a registered session", async () => {
  // The consumer is a shell substitution inside a status-line script, so a
  // non-zero exit is hazardous under `set -e` and stray output corrupts the
  // user's prompt. Empty output is the signal for "nothing to show": no
  // session id, or a session id with no channel server registered behind it.
  // The second is the case that matters — that id is exactly the address peers
  // reject with "no live recipient", so naming it would advertise a session
  // nobody can reach. Being alone in the project is different: a registered
  // session's name is its address elsewhere, so it prints with no peers nearby.
  const root = mkdtempSync(join(tmpdir(), "agent-mail-statusline-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const cli = join(import.meta.dir, "cli.ts");
  // The environment carries this very session's id; inheriting it would have
  // the test name the agent running it.
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
  };
  for (const key of [
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_THREAD_ID",
    "AGENT_SESSION_ID",
  ]) {
    delete env[key];
  }
  try {
    const child = Bun.spawn(
      [process.execPath, cli, "status-line", "--project", project],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
    );
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("");

    const named = async (): Promise<string> => {
      const proc = Bun.spawn(
        [
          process.execPath,
          cli,
          "status-line",
          "--project",
          project,
          "--session",
          "solitary-session",
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
      );
      proc.stdin.end();
      expect(await proc.exited).toBe(0);
      return (await new Response(proc.stdout).text()).trim();
    };
    expect(await named()).toBe("");

    registerLiveSession(home, project, "solitary-session");
    expect(await named()).not.toBe("");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("status-line accepts Kimi cwd payload and launcher session id", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-kimi-statusline-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const cli = join(import.meta.dir, "cli.ts");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });

  const env = {
    ...process.env,
    HOME: home,
    AGENT_SESSION_ID: "kimi-launcher-session",
    CLAUDE_CODE_SESSION_ID: undefined,
    CODEX_THREAD_ID: undefined,
  };
  registerLiveSession(home, project, "kimi-launcher-session");

  try {
    const child = Bun.spawn([process.execPath, cli, "status-line", "--debug"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    child.stdin.write(
      JSON.stringify({
        model: "K3",
        cwd: project,
        sessionId: "kimi-native-session",
        contextUsage: 0.25,
      }),
    );
    child.stdin.end();

    expect(await child.exited).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).not.toBe("");
    const debug = await new Response(child.stderr).text();
    expect(debug).toContain(`project: ${realpathSync(project)}`);
    expect(debug).toContain("session: kimi-launcher-session");
    expect(debug).not.toContain("session: kimi-native-session");
  } finally {
    rmSync(root, { recursive: true });
  }
});
test("agy reminder uses workspacePaths and stops after one injected edge", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-agy-remind-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const hookCwd = join(home, ".gemini", "config");
  const stateRoot = join(home, ".claude", "agent-mail");
  const sessionId = "agy-session";
  const cli = join(import.meta.dir, "cli.ts");
  mkdirSync(project, { recursive: true });
  mkdirSync(hookCwd, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  const canonical = realpathSync(project);
  writeFileSync(
    join(stateRoot, "unread-summary.json"),
    JSON.stringify({
      version: 1,
      generatedAt: Date.now(),
      generatedBy: process.pid,
      bySession: {
        [sessionId]: {
          project: canonical,
          unread: 1,
          newestId: "message-1",
          newestTs: new Date().toISOString(),
        },
      },
    }),
  );
  const env = {
    ...process.env,
    HOME: home,
    AGENT_SESSION_ID: sessionId,
    CLAUDE_CODE_SESSION_ID: undefined,
    CODEX_THREAD_ID: undefined,
    GEMINI_SESSION_ID: undefined,
  };
  const outputs: string[] = [];

  try {
    for (let invocationNum = 0; invocationNum < 2; invocationNum += 1) {
      const child = Bun.spawn(
        [
          process.execPath,
          cli,
          "remind",
          "--format",
          "agy",
          "--event",
          "PreInvocation",
        ],
        {
          cwd: hookCwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env,
        },
      );
      child.stdin.write(
        JSON.stringify({
          conversationId: "agy-native-conversation",
          invocationNum,
          workspacePaths: [project],
        }),
      );
      child.stdin.end();
      expect(await child.exited).toBe(0);
      outputs.push((await new Response(child.stdout).text()).trim());
    }

    expect(JSON.parse(outputs[0])).toEqual({
      injectSteps: [
        {
          ephemeralMessage: expect.stringContaining(
            "Agent-mail: 1 unread message(s)",
          ),
        },
      ],
    });
    expect(outputs[1]).toBe("{}");
    const announced = JSON.parse(
      readFileSync(
        join(
          stateRoot,
          "announced",
          `${projectSlug(canonical)}-${sessionId}.json`,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(announced.project).toBe(canonical);
    expect(announced.lastNewestId).toBe("message-1");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("status-line exposes this session's work through an opt-in versioned field", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-statusline-work-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const canonical = realpathSync(project);
  const workDirectory = join(
    home,
    ".claude",
    "agent-mail",
    "work",
    projectSlug(canonical),
  );
  mkdirSync(workDirectory, { recursive: true });
  mkdirSync(join(home, ".claude", "agent-mail"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "agent-mail", "presence.json"),
    JSON.stringify({
      version: 1,
      generatedAt: Date.now(),
      generatedBy: process.pid,
      sessions: [
        {
          cwd: canonical,
          pid: process.pid,
          instanceId: "mcp-instance",
          sessionId: "status-session",
          client: "omp-coding-agent",
          capabilities: { workLeases: true },
          started: new Date().toISOString(),
        },
      ],
    }),
  );
  writeFileSync(
    join(workDirectory, "plan-lease.json"),
    JSON.stringify({
      version: 1,
      id: "plan-lease",
      project: canonical,
      resource: {
        type: "research-plan",
        key: "blinded-determinacy-calibration",
        label: "Blinded determinacy calibration",
        sourcePath: join(
          canonical,
          "lab-notebook",
          "plans",
          "active",
          "blinded-determinacy-calibration.md",
        ),
      },
      owner: {
        id: "status-session",
        label: "Quiet Lantern",
        sessionId: "status-session",
        pid: process.pid,
        instanceId: "mcp-instance",
      },
      state: "waiting",
      activity: "measurement · EXP-042",
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:01:00.000Z",
      revision: 1,
    }),
  );
  writeFileSync(
    join(workDirectory, "stale-plan-lease.json"),
    JSON.stringify({
      version: 1,
      id: "stale-plan-lease",
      project: canonical,
      resource: {
        type: "research-plan",
        key: "stale-plan",
      },
      owner: {
        id: "status-session",
        label: "Old Quiet Lantern",
        sessionId: "status-session",
        pid: process.pid + 1,
        instanceId: "old-mcp-instance",
      },
      state: "working",
      activity: "carried across quit-and-resume",
      createdAt: "2026-08-31T12:00:00.000Z",
      updatedAt: "2026-08-31T12:01:00.000Z",
      revision: 1,
    }),
  );
  const cli = join(import.meta.dir, "cli.ts");
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CODE_SESSION_ID: undefined,
    CODEX_THREAD_ID: undefined,
    AGENT_SESSION_ID: undefined,
  };

  try {
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        "status-line",
        "--fields",
        "--work",
        "--project",
        project,
        "--session",
        "status-session",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
    );
    child.stdin.end();
    expect(await child.exited).toBe(0);
    const fields = (await new Response(child.stdout).text()).trim().split("\t");
    expect(fields).toHaveLength(6);
    expect(JSON.parse(fields[5] ?? "")).toEqual({
      version: 1,
      items: [
        {
          id: "stale-plan-lease",
          resourceType: "research-plan",
          resourceKey: "stale-plan",
          state: "working",
          activity: "carried across quit-and-resume",
          updatedAt: "2026-08-31T12:01:00.000Z",
        },
        {
          id: "plan-lease",
          resourceType: "research-plan",
          resourceKey: "blinded-determinacy-calibration",
          label: "Blinded determinacy calibration",
          sourcePath: join(
            canonical,
            "lab-notebook",
            "plans",
            "active",
            "blinded-determinacy-calibration.md",
          ),
          state: "waiting",
          activity: "measurement · EXP-042",
          updatedAt: "2026-09-01T12:01:00.000Z",
        },
      ],
    });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("listeners --no-sync emits snapshot JSON without pruning registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-listeners-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const data = join(home, ".claude", "agent-mail");
  const registry = join(data, "registry");
  mkdirSync(project, { recursive: true });
  mkdirSync(registry, { recursive: true });
  const untouched = join(registry, "invalid.json");
  writeFileSync(untouched, "not a registration");
  writeFileSync(
    join(data, "presence.json"),
    JSON.stringify({
      version: 1,
      generatedAt: Date.now(),
      generatedBy: process.pid,
      sessions: [
        {
          cwd: project,
          pid: process.pid,
          sessionId: "shared-session",
          client: "omp-coding-agent",
          capabilities: { inboxPoll: true, claims: true },
          lastInboxPoll: "2026-08-12T12:00:00.000Z",
          started: "2026-08-12T11:00:00.000Z",
        },
        {
          cwd: project,
          pid: process.pid + 1,
          sessionId: "shared-session",
          client: "oh-my-pi",
          capabilities: { channelPush: true, receipts: true },
          started: "2026-08-12T11:00:01.000Z",
        },
      ],
    }),
  );
  const cli = join(import.meta.dir, "cli.ts");
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        "listeners",
        "--project",
        project,
        "--no-sync",
        "--json",
      ],
      { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    const report = JSON.parse(await new Response(child.stdout).text()) as {
      source: string;
      fresh: boolean;
      sessions: Array<{
        client: string;
        capabilities: Record<string, boolean>;
      }>;
    };
    expect(report.source).toBe("presence-snapshot");
    expect(report.fresh).toBe(true);
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({
      client: "oh-my-pi",
      capabilities: {
        inboxPoll: true,
        channelPush: true,
        claims: true,
        receipts: true,
      },
    });
    expect(existsSync(untouched)).toBe(true);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("session-address resolves only fresh project-scoped identity without writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-address-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const data = join(home, ".claude", "agent-mail");
  const registry = join(data, "registry");
  mkdirSync(project, { recursive: true });
  mkdirSync(registry, { recursive: true });
  const snapshotPath = join(data, "presence.json");
  const canonical = realpathSync(project);
  const row = {
    cwd: canonical,
    pid: process.pid + 1,
    parentPid: process.pid,
    sessionId: "registered",
    procStart: "channel-process-start-not-host-start",
    started: new Date().toISOString(),
  };
  // A live-looking registry entry must never become a snapshot fallback.
  writeFileSync(join(registry, "live.json"), JSON.stringify(row));
  writeFileSync(join(registry, "invalid.json"), "not a registration");
  const tree = (dir: string): Record<string, string> => {
    const files: Record<string, string> = {};
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) Object.assign(files, tree(path));
      else files[path] = readFileSync(path, "utf8");
    }
    return files;
  };
  const cases: Array<{
    label: string;
    requested: string;
    sessions?: unknown[];
    age?: number;
    raw?: string;
    expected: string | null;
    parentPid?: number | null;
  }> = [
    {
      label: "exact ID wins over a different host match",
      requested: "exact",
      sessions: [row, { ...row, sessionId: "exact", parentPid: 987654321 }],
      expected: "exact",
      parentPid: 987654321,
    },
    {
      label: "exact ID survives missing host PID",
      requested: "registered",
      sessions: [{ ...row, parentPid: undefined }],
      expected: "registered",
      parentPid: null,
    },
    {
      label: "clear rotates the ID but not the host",
      requested: "rotated",
      sessions: [row],
      expected: "registered",
    },
    {
      label: "multiple host registrations are ambiguous",
      requested: "rotated",
      sessions: [row, { ...row, sessionId: "second" }],
      expected: null,
    },
    {
      label: "other project exact ID is excluded",
      requested: "registered",
      sessions: [{ ...row, cwd: root }],
      expected: null,
    },
    {
      label: "unproven host does not match",
      requested: "rotated",
      sessions: [{ ...row, parentPid: 987654321 }],
      expected: null,
    },
    {
      label: "missing snapshot does not scan the registry",
      requested: "registered",
      expected: null,
    },
    {
      label: "stale snapshot does not scan the registry",
      requested: "registered",
      sessions: [row],
      age: 31_000,
      expected: null,
    },
    {
      label: "empty snapshot does not echo the requested ID",
      requested: "registered",
      sessions: [],
      expected: null,
    },
    {
      label: "stale registration activity is excluded",
      requested: "registered",
      sessions: [
        { ...row, started: new Date(Date.now() - 25 * 3600_000).toISOString() },
      ],
      expected: null,
    },
    {
      label: "malformed rows cannot supply a project",
      requested: "registered",
      sessions: [null, 3, {}, { ...row, cwd: "." }, { ...row, cwd: 7 }],
      expected: null,
    },
    {
      label: "malformed activity cannot remove a host competitor",
      requested: "rotated",
      sessions: [row, { ...row, sessionId: "second", started: {} }],
      expected: null,
    },
    {
      label: "null snapshot is unavailable",
      requested: "registered",
      raw: "null",
      expected: null,
    },
    {
      label: "torn snapshot is unavailable",
      requested: "registered",
      raw: "{",
      expected: null,
    },
  ];
  try {
    for (const scenario of cases) {
      rmSync(snapshotPath, { force: true });
      if (scenario.raw !== undefined) writeFileSync(snapshotPath, scenario.raw);
      else if (scenario.sessions !== undefined) {
        writeFileSync(
          snapshotPath,
          JSON.stringify({
            version: 1,
            generatedAt: Date.now() - (scenario.age ?? 0),
            generatedBy: process.pid,
            sessions: scenario.sessions,
          }),
        );
      }
      const before = tree(root);
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "cli.ts"),
          "session-address",
          "--project",
          project,
          "--session",
          scenario.requested,
          "--json",
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
            CLAUDE_CODE_SESSION_ID: "inherited-wrong-session",
            CLAUDE_PROJECT_DIR: root,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await child.exited, scenario.label).toBe(0);
      expect(await new Response(child.stderr).text(), scenario.label).toBe("");
      expect(
        JSON.parse(await new Response(child.stdout).text()),
        scenario.label,
      ).toEqual({
        version: 1,
        project: canonical,
        requestedSessionId: scenario.requested,
        sessionId: scenario.expected,
        parentPid:
          scenario.expected === null
            ? null
            : scenario.parentPid === undefined
              ? process.pid
              : scenario.parentPid,
        procStart: null,
      });
      expect(tree(root), scenario.label).toEqual(before);
    }
  } finally {
    rmSync(root, { recursive: true });
  }
}, 45_000);

test("session-address requires explicit absolute project, raw session, and JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-address-args-"));
  const home = join(root, "home");
  mkdirSync(home);
  const file = join(root, "file");
  writeFileSync(file, "");
  try {
    for (const args of [
      ["--session", "raw", "--json"],
      ["--project", ".", "--session", "raw", "--json"],
      ["--project", join(root, "missing"), "--session", "raw", "--json"],
      ["--project", file, "--session", "raw", "--json"],
      ["--project", root, "--json"],
      ["--project", root, "--session", "", "--json"],
      ["--project", root, "--session", "   ", "--json"],
      ["--project", root, "--session", "raw"],
    ]) {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "cli.ts"),
          "session-address",
          ...args,
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
            CLAUDE_CODE_SESSION_ID: "inherited",
            CLAUDE_PROJECT_DIR: root,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stdout).text()).toBe("");
      expect(readdirSync(home)).toEqual([]);
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("state --no-sync emits versioned aggregate data without pruning", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-state-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const data = join(home, ".claude", "agent-mail");
  const registry = join(data, "registry");
  const inbox = join(data, "inbox");
  mkdirSync(project, { recursive: true });
  const canonical = realpathSync(project);
  mkdirSync(registry, { recursive: true });
  mkdirSync(inbox, { recursive: true });
  const untouched = join(registry, "invalid.json");
  writeFileSync(untouched, "not a registration");
  const now = Date.now();
  writeFileSync(
    join(data, "presence.json"),
    JSON.stringify({
      version: 1,
      generatedAt: now,
      generatedBy: process.pid,
      sessions: [],
    }),
  );
  writeFileSync(
    join(data, "processes.json"),
    JSON.stringify({
      version: 1,
      generatedAt: now,
      generatedBy: process.pid,
      pids: [],
      reliable: true,
      processes: [],
    }),
  );
  writeFileSync(
    join(inbox, `${projectSlug(project)}.jsonl`),
    `${JSON.stringify({
      ts: "2026-08-13T12:00:00.000Z",
      from: "sender",
      project: canonical,
      message: "legacy id",
    })}\n`,
  );
  const cli = join(import.meta.dir, "cli.ts");
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        "state",
        "--project",
        project,
        "--no-sync",
        "--json",
      ],
      { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    const report = JSON.parse(await new Response(child.stdout).text()) as {
      schemaVersion: number;
      source: { mode: string };
      freshness: { presence: boolean };
      messages: Array<{ id: string; read: boolean }>;
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.source.mode).toBe("filesystem-snapshot");
    expect(report.freshness.presence).toBe(true);
    expect(report.messages).toHaveLength(1);
    expect(report.messages[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(report.messages[0].read).toBe(false);
    expect(existsSync(untouched)).toBe(true);
    expect(existsSync(join(data, "claims"))).toBe(false);
    expect(existsSync(join(data, "work"))).toBe(false);
    expect(existsSync(join(data, "transfers"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claim-path groups repeated path flags under one claim id", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-claims-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const cli = join(import.meta.dir, "cli.ts");
  const env = { ...process.env, HOME: home };
  try {
    const claim = Bun.spawn(
      [
        process.execPath,
        cli,
        "claim-path",
        "--project",
        project,
        "--path",
        "one.swift",
        "--path",
        "two.swift",
        "--owner",
        "operator",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await claim.exited).toBe(0);
    const output = await new Response(claim.stdout).text();
    const [claimId, releaseToken] = output.split("\n")[0].split(" ");
    expect(claimId).toMatch(/^[0-9a-f-]+$/);
    expect(releaseToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(output).toContain("file ");
    expect(output).toContain("one.swift");
    expect(output).toContain("two.swift");

    const list = Bun.spawn(
      [process.execPath, cli, "claims", "--project", project],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await list.exited).toBe(0);
    const listed = await new Response(list.stdout).text();
    expect(listed.trim().split("\n")).toHaveLength(1);
    expect(listed).toContain("one.swift");
    expect(listed).toContain("two.swift");
    expect(listed).toContain(realpathSync(project));
    expect(listed).toContain("[owner manual; manual-fresh]");
    expect(listed).toContain("[state active]");
    expect(listed).not.toContain(releaseToken);

    const release = Bun.spawn(
      [process.execPath, cli, "release-claim", "--token", releaseToken],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await release.exited).toBe(0);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("unregistered coordination acquisition requires a manual owner label", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-owner-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const cli = join(import.meta.dir, "cli.ts");
  const {
    CLAUDE_CODE_SESSION_ID: _claude,
    CODEX_THREAD_ID: _codex,
    ...base
  } = process.env;
  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      "work",
      "acquire",
      "--project",
      project,
      "--type",
      "task",
      "--key",
      "one",
    ],
    {
      env: { ...base, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain(
      "requires --owner <label>",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work CLI lists logical ownership across projects", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-work-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const cli = join(import.meta.dir, "cli.ts");
  const env = { ...process.env, HOME: home };
  try {
    const acquire = Bun.spawn(
      [
        process.execPath,
        cli,
        "work",
        "acquire",
        "--project",
        project,
        "--type",
        "research-plan",
        "--key",
        "2026-08-12-pilot",
        "--owner",
        "operator",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await acquire.exited).toBe(0);
    const acquired = await new Response(acquire.stdout).text();
    const workId = acquired.split(" ")[0];
    expect(workId).toMatch(/^[0-9a-f-]+$/);

    const list = Bun.spawn([process.execPath, cli, "work", "list", "--all"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await list.exited).toBe(0);
    expect(await new Response(list.stdout).text()).toContain(
      "research-plan:2026-08-12-pilot",
    );

    const release = Bun.spawn(
      [
        process.execPath,
        cli,
        "work",
        "release",
        "--project",
        project,
        "--id",
        workId,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await release.exited).toBe(0);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("work conflicts explain manual ownership and the recovery path", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-conflict-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const cli = join(import.meta.dir, "cli.ts");
  const env = { ...process.env, HOME: home };
  try {
    const first = Bun.spawn(
      [
        process.execPath,
        cli,
        "work",
        "acquire",
        "--project",
        project,
        "--type",
        "task",
        "--key",
        "one",
        "--owner",
        "holder",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await first.exited).toBe(0);
    const second = Bun.spawn(
      [
        process.execPath,
        cli,
        "work",
        "acquire",
        "--project",
        project,
        "--type",
        "task",
        "--key",
        "one",
        "--owner",
        "requester",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await second.exited).not.toBe(0);
    expect(await new Response(second.stderr).text()).toContain(
      "owner is deliberately manual",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work transfer CLI records and accepts an auditable handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-transfer-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const cli = join(import.meta.dir, "cli.ts");
  const env = { ...process.env, HOME: home };
  try {
    const acquired = Bun.spawn(
      [
        process.execPath,
        cli,
        "work",
        "acquire",
        "--project",
        project,
        "--type",
        "research-plan",
        "--key",
        "plan",
        "--owner",
        "holder",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await acquired.exited).toBe(0);
    const workId = (await new Response(acquired.stdout).text()).split(" ")[0];

    const requested = Bun.spawn(
      [
        process.execPath,
        cli,
        "coordination",
        "request-transfer",
        "--id",
        workId,
        "--owner",
        "requester",
        "--timeout",
        "60",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await requested.exited).toBe(0);
    const request = JSON.parse(await new Response(requested.stdout).text()) as {
      id: string;
      status: string;
      requestNotifiedAt?: string;
    };
    expect(request.status).toBe("requested");

    const accepted = Bun.spawn(
      [
        process.execPath,
        cli,
        "coordination",
        "respond-transfer",
        "--id",
        request.id,
        "--decision",
        "accept",
        "--owner",
        "holder",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await accepted.exited).toBe(0);
    const response = JSON.parse(await new Response(accepted.stdout).text()) as {
      status: string;
      actualOwner?: { label: string };
    };
    expect(response.status).toBe("accepted");
    expect(response.actualOwner?.label).toBe("requester");

    const transferFiles = readdirSync(
      join(home, ".claude", "agent-mail", "transfers"),
    ).filter((name) => name.endsWith(".json"));
    expect(transferFiles).toHaveLength(1);
    const stored = JSON.parse(
      readFileSync(
        join(home, ".claude", "agent-mail", "transfers", transferFiles[0]),
        "utf8",
      ),
    ) as { requestNotifiedAt?: string; resolutionNotifiedAt?: string };
    expect(stored.requestNotifiedAt).toBeDefined();
    expect(stored.resolutionNotifiedAt).toBeDefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work CLI attaches ownership to its registered Codex session", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-session-work-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const state = join(home, ".claude", "agent-mail");
  const registry = join(state, "registry");
  mkdirSync(project, { recursive: true });
  mkdirSync(registry, { recursive: true });
  const procStart = processInfo([process.pid]).get(process.pid)?.start;
  expect(procStart).toBeTruthy();
  writeFileSync(
    join(registry, `${projectSlug(project)}-${process.pid}.json`),
    JSON.stringify({
      cwd: project,
      pid: process.pid,
      procStart,
      sessionId: "codex-session",
      client: "codex",
      started: new Date().toISOString(),
    }),
  );
  const cli = join(import.meta.dir, "cli.ts");
  const { CLAUDE_CODE_SESSION_ID: _claudeSessionId, ...baseEnv } = process.env;
  const env = {
    ...baseEnv,
    HOME: home,
    CODEX_THREAD_ID: "codex-session",
  };
  try {
    const acquire = Bun.spawn(
      [
        process.execPath,
        cli,
        "work",
        "acquire",
        "--project",
        project,
        "--type",
        "research-plan",
        "--key",
        "session-plan",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await acquire.exited).toBe(0);
    const workDir = join(state, "work", projectSlug(project));
    const files = readdirSync(workDir);
    expect(files).toHaveLength(1);
    const lease = JSON.parse(readFileSync(join(workDir, files[0]), "utf8")) as {
      owner: Record<string, unknown>;
    };
    expect(lease.owner).toMatchObject({
      id: "codex-session",
      sessionId: "codex-session",
      pid: process.pid,
      procStart,
    });
  } finally {
    rmSync(root, { recursive: true });
  }
});

/** Spawn `notify` against a stub daemon and return the JSON it received. */
async function notifyRequest(
  args: string[],
  env: Record<string, string> = {},
): Promise<{
  body: Record<string, unknown> | undefined;
  exitCode: number;
  stderr: string;
}> {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>);
      return Response.json({ ok: true, status: "spooled", id: "test" });
    },
  });
  try {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "cli.ts"), "notify", ...args],
      {
        env: { ...process.env, ...env, AGENT_MAIL_PORT: String(server.port) },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = await new Response(child.stderr).text();
    return { body: requests[0], exitCode: await child.exited, stderr };
  } finally {
    server.stop(true);
  }
}

test("notify --session routes to the live mailbox despite an unrelated project", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-notify-session-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const sourceProject = join(root, "scratch");
  mkdirSync(sourceProject, { recursive: true });
  const registry = join(home, ".claude", "agent-mail", "registry");
  mkdirSync(project, { recursive: true });
  mkdirSync(registry, { recursive: true });
  // A registration is only live if its pid AND process start time still match,
  // so borrow this test process's real identity rather than inventing a pid.
  const self = processInfo([process.pid]).get(process.pid);
  const canonical = realpathSync(project);
  writeFileSync(
    join(registry, `${projectSlug(canonical)}-${process.pid}.json`),
    JSON.stringify({
      cwd: canonical,
      pid: process.pid,
      ...(self ? { procStart: self.start } : {}),
      sessionId: "submitter-session",
      started: new Date().toISOString(),
    }),
  );

  try {
    const addressed = await notifyRequest(
      [
        "--project",
        sourceProject,
        "--message",
        "job done",
        "--session",
        "submitter-session",
      ],
      { HOME: home },
    );
    expect(addressed.exitCode).toBe(0);
    expect(addressed.body?.project).toBe(canonical);
    expect(addressed.body?.meta).toHaveProperty(
      "toSession",
      "submitter-session",
    );
    expect(addressed.body?.meta).toMatchObject({
      sourceProject: realpathSync(sourceProject),
      fromCwd: realpathSync(process.cwd()),
    });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("notify never broadens an empty or unresolved explicit session to a broadcast", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-notify-unresolved-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  try {
    for (const session of ["", "missing-session"]) {
      const result = await notifyRequest(
        ["--project", project, "--message", "job done", "--session", session],
        { HOME: home },
      );
      expect(result.exitCode).toBe(1);
      expect(result.body).toBeUndefined();
    }
    // Omitting the selector is an intentional broadcast, not failed addressing.
    const broadcast = await notifyRequest(
      ["--project", project, "--message", "project announcement"],
      { HOME: home },
    );
    expect(broadcast.exitCode).toBe(0);
    expect(broadcast.body).toMatchObject({ message: "project announcement" });
    expect(broadcast.body?.meta).not.toHaveProperty("toSession");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("notify --reply-to returns cross-project mail to the sender", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-reply-"));
  const home = join(root, "home");
  const callerProject = join(root, "caller");
  const answerProject = join(root, "answer");
  const state = join(home, ".claude", "agent-mail");
  const registry = join(state, "registry");
  mkdirSync(callerProject, { recursive: true });
  mkdirSync(answerProject, { recursive: true });
  mkdirSync(registry, { recursive: true });
  const procStart = processInfo([process.pid]).get(process.pid)?.start;
  for (const [project, sessionId] of [
    [callerProject, "questioner"],
    [answerProject, "answerer"],
  ]) {
    writeFileSync(
      join(registry, `${projectSlug(project)}-${process.pid}.json`),
      JSON.stringify({
        cwd: realpathSync(project),
        pid: process.pid,
        parentPid: process.pid,
        procStart,
        sessionId,
        started: new Date().toISOString(),
      }),
    );
  }
  async function run(sessionId: string, args: string[]) {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "cli.ts"), ...args],
      {
        env: {
          ...process.env,
          HOME: home,
          AGENT_MAIL_PORT: "0",
          CLAUDE_CODE_SESSION_ID: "",
          CODEX_THREAD_ID: sessionId,
          AGENT_SESSION_ID: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr).toBe(0);
    return stdout;
  }
  try {
    await run("questioner", [
      "notify",
      "--project",
      answerProject,
      "--message",
      "cross-project question",
      "--from",
      "free-form sender label",
    ]);
    const questions = await run("answerer", [
      "inbox",
      "--project",
      answerProject,
      "--peek",
    ]);
    const questionId = questions.split(" ")[0];
    expect(questions).toContain("cross-project question");
    await run("answerer", [
      "notify",
      "--project",
      answerProject,
      "--reply-to",
      questionId,
      "--message",
      "cross-project answer",
    ]);
    const answers = await run("questioner", [
      "inbox",
      "--project",
      callerProject,
      "--peek",
    ]);
    expect(answers).toContain("cross-project answer");
    expect(
      await run("answerer", ["inbox", "--project", answerProject, "--peek"]),
    ).not.toContain("cross-project answer");
    const answerId = answers.split(" ")[0];
    await run("questioner", [
      "notify",
      "--project",
      callerProject,
      "--reply-to",
      answerId,
      "--message",
      "follow-up question",
    ]);
    expect(
      await run("answerer", ["inbox", "--project", answerProject, "--peek"]),
    ).toContain("follow-up question");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);

test("notify reports delivery when the daemon stored the message but lost its reply", async () => {
  // The observed defect. The daemon appended the message and then failed to
  // return a response; the CLI fell back to a direct append, found the daemon's
  // own line in the shared spool, and reported "duplicate suppressed" — telling
  // the caller their message was dropped when it had been delivered. Those call
  // for opposite reactions, so they must not render the same.
  const root = mkdtempSync(join(tmpdir(), "agent-mail-lost-reply-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const inbox = join(home, ".claude", "agent-mail", "inbox");
  mkdirSync(project, { recursive: true });
  mkdirSync(inbox, { recursive: true });
  const canonical = realpathSync(project);
  const spool = join(inbox, `${projectSlug(canonical)}.jsonl`);

  // Stands in for the daemon: append exactly what it would have appended, then
  // never answer, so the client times out the way it did in the field.
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const sent = (await request.json()) as { attemptKey?: string };
      writeFileSync(
        spool,
        `${JSON.stringify({
          id: "daemon-stored-id",
          ts: new Date().toISOString(),
          from: "cli",
          project: canonical,
          message: "job done",
          attemptKey: sent.attemptKey,
        })}\n`,
      );
      return await new Promise<Response>(() => {});
    },
  });

  try {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "cli.ts"),
        "notify",
        "--project",
        project,
        "--message",
        "job done",
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          AGENT_MAIL_PORT: String(server.port),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(0);
    const out = await new Response(child.stdout).text();
    expect(out).toContain("daemon-stored-id");
    expect(out).not.toContain("duplicate suppressed");

    // And the guard still did its job: one copy in the spool, not two.
    const lines = readFileSync(spool, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test("a daemon duplicate is read by reason, not just by status", async () => {
  // The regression: the daemon answers `{status, id, reason}` and this path read
  // `{status, id}`. A sender meeting its own retried attempt — reason
  // "attempt-key", which means the message IS in the spool — was told it had
  // sent a duplicate. Only the fallback path, which almost never runs,
  // distinguished them.
  const cases = [
    {
      reason: "attempt-key",
      expect: /spooled dup-1 via daemon \(an earlier attempt/,
    },
    { reason: "content-window", expect: /already sent as dup-1/ },
  ];
  const project = mkdtempSync(join(tmpdir(), "agent-mail-dup-"));
  const cli = join(import.meta.dir, "cli.ts");
  try {
    for (const testCase of cases) {
      const server = Bun.serve({
        port: 0,
        fetch: () =>
          Response.json({
            status: "duplicate",
            id: "dup-1",
            reason: testCase.reason,
          }),
      });
      try {
        const child = Bun.spawn(
          [
            process.execPath,
            cli,
            "notify",
            "--project",
            project,
            "--message",
            "a message sent once",
          ],
          {
            env: { ...process.env, AGENT_MAIL_PORT: String(server.port) },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        expect(await child.exited).toBe(0);
        const out = await new Response(child.stdout).text();
        expect(out).toMatch(testCase.expect);
      } finally {
        server.stop(true);
      }
    }
  } finally {
    rmSync(project, { recursive: true });
  }
});

test("CLI recognizes source and packaged daemon entry points, but not unrelated pids", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-daemonpid-"));
  const home = join(root, "home");
  const data = join(home, ".claude", "agent-mail");
  mkdirSync(data, { recursive: true });
  const cli = join(import.meta.dir, "cli.ts");
  // Daemon identity does not depend on the user's Claude plugin installation.
  // Keep that unrelated external probe off PATH.
  const env = { ...process.env, HOME: home, PATH: "/usr/bin:/bin" };

  const runCli = async (command: string): Promise<string> => {
    const child = Bun.spawn([process.execPath, cli, command], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return text;
  };

  try {
    // A live pid that is not the daemon: this test process itself.
    writeFileSync(join(data, "daemon.pid"), String(process.pid));
    expect(await runCli("status")).toContain("daemon: stopped");

    // The daemon and CLI can come from different installations. The process
    // command, not the inspecting CLI's suffix, identifies the daemon.
    for (const extension of ["ts", "js"]) {
      const standIn = join(root, `daemon.${extension}`);
      writeFileSync(standIn, "await Bun.stdin.text();\n");
      const daemon = Bun.spawn([process.execPath, standIn], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        writeFileSync(join(data, "daemon.pid"), String(daemon.pid));
        expect(await runCli("status")).toContain(
          `daemon: running (pid ${daemon.pid})`,
        );
        expect(await runCli("start")).toContain(
          `daemon already running (pid ${daemon.pid})`,
        );
      } finally {
        daemon.kill();
        await daemon.exited;
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("logs selects its file by flag and refuses arguments it does not know", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-logs-"));
  const home = join(root, "home");
  const data = join(home, ".claude", "agent-mail");
  mkdirSync(data, { recursive: true });
  const cli = join(import.meta.dir, "cli.ts");
  const env = { ...process.env, HOME: home, PATH: "/usr/bin:/bin" };

  const runLogs = async (
    ...args: string[]
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    const child = Bun.spawn([process.execPath, cli, "logs", ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, stdout, stderr };
  };

  try {
    writeFileSync(join(data, "daemon.log"), "daemon line\n");

    // With no lifecycle log, --lifecycle names the file it looked for and
    // never substitutes the daemon log.
    const missing = await runLogs("--lifecycle");
    expect(missing.code).toBe(0);
    expect(missing.stdout).toContain("channel-lifecycle.jsonl");
    expect(missing.stdout).not.toContain("daemon line");

    writeFileSync(
      join(data, "channel-lifecycle.jsonl"),
      '{"event":"attached"}\n',
    );
    const lifecycle = await runLogs("--lifecycle");
    expect(lifecycle.stdout).toContain('"event":"attached"');
    expect(lifecycle.stdout).not.toContain("daemon line");

    expect((await runLogs()).stdout).toContain("daemon line");

    // An unknown flag is an error, not a quiet fallback to the daemon log.
    const unknown = await runLogs("--lifecyle");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("--lifecyle");
    expect(unknown.stdout).not.toContain("daemon line");

    expect((await runLogs("--mcp", "--lifecycle")).code).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

/** A seeded project inbox: two unread messages, plus a live registration for
 * session "cli-reader" borrowed from this test process (a registration is only
 * live if its pid and start time still match, so an invented pid would not do). */
function seedInbox(
  root: string,
  hostPid: number = process.pid,
): {
  home: string;
  project: string;
  slug: string;
} {
  const home = join(root, "home");
  const project = join(root, "project");
  const state = join(home, ".claude", "agent-mail");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(state, "inbox"), { recursive: true });
  mkdirSync(join(state, "receipts"), { recursive: true });
  mkdirSync(join(state, "registry"), { recursive: true });
  const canonical = realpathSync(project);
  const slug = projectSlug(canonical);
  const messages = [
    {
      id: "note-a",
      ts: "2026-08-31T12:00:00.000Z",
      from: "peer",
      project: canonical,
      message: "broadcast body",
      meta: {
        fromName: "Quiet Peer",
        sessionId: "peer-session",
      },
    },
    {
      id: "note-b",
      ts: "2026-08-31T12:01:00.000Z",
      from: "peer",
      project: canonical,
      message: "direct body",
      meta: {
        fromName: "Quiet Peer",
        sessionId: "peer-session",
      },
    },
  ];
  writeFileSync(
    join(state, "inbox", `${slug}.jsonl`),
    `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  );
  const procStart = processInfo([process.pid]).get(process.pid)?.start;
  writeFileSync(
    join(state, "registry", `${slug}-${process.pid}.json`),
    JSON.stringify({
      cwd: canonical,
      pid: process.pid,
      // This test process spawns the CLI, so it stands in for the host agent:
      // the child's ancestor chain contains it, which is what makes the
      // registration's session id adoptable.
      parentPid: hostPid,
      ...(procStart ? { procStart } : {}),
      sessionId: "cli-reader",
      started: new Date().toISOString(),
    }),
  );
  return { home, project, slug };
}

const INBOX_READER_ENV = {
  CLAUDE_CODE_SESSION_ID: "cli-reader",
  CODEX_THREAD_ID: "",
  AGENT_SESSION_ID: "",
};

test("triage-candidates protects live and recently active recipients", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-triage-"));
  const cli = join(import.meta.dir, "cli.ts");
  try {
    const { home, project, slug } = seedInbox(root);
    const inbox = join(home, ".claude", "agent-mail", "inbox", `${slug}.jsonl`);
    const messages = [
      {
        id: "broadcast",
        ts: "2026-09-08T11:00:00.000Z",
        from: "peer",
        project,
        message: "project work",
      },
      {
        id: "inactive",
        ts: "2026-09-08T11:01:00.000Z",
        from: "peer",
        project,
        message: "abandoned direct work",
        meta: { toSession: "inactive-session" },
      },
      {
        id: "live-owned",
        ts: "2026-09-08T11:02:00.000Z",
        from: "peer",
        project,
        message: "owned direct work",
        meta: { toSession: "cli-reader" },
      },
      {
        id: "live-refused",
        ts: "2026-09-08T11:03:00.000Z",
        from: "peer",
        project,
        message: "refused direct work",
        meta: { toSession: "cli-reader" },
      },
      {
        id: "recently-active",
        ts: "2026-09-08T11:04:00.000Z",
        from: "peer",
        project,
        message: "work for a registry-lost session",
        meta: { toSession: "registry-lost" },
      },
    ];
    writeFileSync(
      inbox,
      `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    );
    const receiptProject = realpathSync(project);
    const receipts = [
      {
        messageId: "live-refused",
        project: receiptProject,
        ts: "2026-09-08T11:04:00.000Z",
        status: "refused",
        sessionId: "cli-reader",
      },
      {
        messageId: "recently-active",
        project: receiptProject,
        ts: new Date().toISOString(),
        status: "held",
        sessionId: "registry-lost",
      },
    ];
    writeFileSync(
      join(home, ".claude", "agent-mail", "receipts", `${slug}.jsonl`),
      `${receipts.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`,
    );

    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        "triage-candidates",
        "--project",
        project,
        "--limit",
        "2",
      ],
      {
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(0);
    const result = JSON.parse(await new Response(child.stdout).text()) as {
      schemaVersion: number;
      liveSessionIds: string[];
      recentlyActiveUnregisteredSessions: { sessionId: string }[];
      protectedRecipientSessionIds: string[];
      counts: Record<string, number>;
      limit: number;
      returned: number;
      truncated: boolean;
      messages: { id: string; triageReason: string }[];
    };

    expect(result.schemaVersion).toBe(1);
    expect(result.liveSessionIds).toEqual(["cli-reader"]);
    expect(result.recentlyActiveUnregisteredSessions).toEqual([
      expect.objectContaining({ sessionId: "registry-lost" }),
    ]);
    expect(result.protectedRecipientSessionIds).toEqual([
      "cli-reader",
      "registry-lost",
    ]);
    expect(result.limit).toBe(2);
    expect(result.returned).toBe(2);
    expect(result.truncated).toBe(true);
    expect(
      result.messages.map(({ id, triageReason }) => ({ id, triageReason })),
    ).toEqual([
      { id: "broadcast", triageReason: "broadcast" },
      { id: "inactive", triageReason: "recipient-not-live" },
    ]);
    expect(result.counts).toEqual({
      unread: 5,
      candidates: 3,
      broadcast: 1,
      recipientNotLive: 1,
      recipientRefused: 1,
      liveRecipient: 2,
      nonDeliverable: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mark-read accepts an exact set through repeated id flags", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-mark-read-"));
  const cli = join(import.meta.dir, "cli.ts");
  try {
    const { home, project } = seedInbox(root);
    const mark = Bun.spawn(
      [
        process.execPath,
        cli,
        "mark-read",
        "--project",
        project,
        "--id",
        "note-a",
        "--id",
        "note-b",
      ],
      {
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await mark.exited).toBe(0);
    expect(await new Response(mark.stdout).text()).toContain(
      "marked 2 message(s) read",
    );

    const inbox = Bun.spawn(
      [
        process.execPath,
        cli,
        "inbox",
        "--project",
        project,
        "--unread",
        "--peek",
      ],
      {
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await inbox.exited).toBe(0);
    expect(await new Response(inbox.stdout).text()).toStartWith("inbox empty");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mark-read rejects a value-less id combined with all", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-mark-read-guard-"));
  const cli = join(import.meta.dir, "cli.ts");
  try {
    const { home, project } = seedInbox(root);
    const mark = Bun.spawn(
      [
        process.execPath,
        cli,
        "mark-read",
        "--project",
        project,
        "--id",
        "--all",
      ],
      {
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await mark.exited).toBe(1);
    expect(await new Response(mark.stderr).text()).toContain(
      "--all cannot be combined with --id",
    );

    const inbox = Bun.spawn(
      [
        process.execPath,
        cli,
        "inbox",
        "--project",
        project,
        "--unread",
        "--peek",
      ],
      {
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await inbox.exited).toBe(0);
    expect(await new Response(inbox.stdout).text()).toContain("note-a unread");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox read with a session id records the pull and marks messages read", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-inbox-read-"));
  const cli = join(import.meta.dir, "cli.ts");
  try {
    const { home, project, slug } = seedInbox(root);
    const state = join(home, ".claude", "agent-mail");
    const child = Bun.spawn(
      [process.execPath, cli, "inbox", "--project", project],
      {
        env: { ...process.env, HOME: home, ...INBOX_READER_ENV },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(0);
    const out = await new Response(child.stdout).text();
    expect(out).toContain("note-a unread");
    expect(out).toContain("note-b unread");
    expect(out).toContain("marked 2 message(s) read");

    const receipts = readFileSync(
      join(state, "receipts", `${slug}.jsonl`),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, string>);
    expect(receipts.filter((r) => r.status === "pushed")).toHaveLength(2);
    expect(receipts.find((r) => r.status === "pushed")?.detail).toBe(
      "cli inbox",
    );
    expect(receipts.filter((r) => r.status === "read")).toHaveLength(2);
    expect(receipts.every((r) => r.sessionId === "cli-reader")).toBe(true);

    // The pull was also an explicit inbox check for the live registration.
    const registration = JSON.parse(
      readFileSync(
        join(state, "registry", `${slug}-${process.pid}.json`),
        "utf8",
      ),
    ) as { lastInboxPoll?: string };
    expect(registration.lastInboxPoll).toBeDefined();

    // A later pull sees them read; nothing is left for an --unread pass.
    const again = Bun.spawn(
      [process.execPath, cli, "inbox", "--project", project, "--unread"],
      {
        env: { ...process.env, HOME: home, ...INBOX_READER_ENV },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await again.exited).toBe(0);
    expect(await new Response(again.stdout).text()).toStartWith("inbox empty");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox text and JSON preserve sender identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-inbox-json-"));
  const cli = join(import.meta.dir, "cli.ts");
  try {
    const { home, project } = seedInbox(root);
    const text = Bun.spawn(
      [process.execPath, cli, "inbox", "--project", project, "--peek"],
      {
        env: { ...process.env, HOME: home, ...INBOX_READER_ENV },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await text.exited).toBe(0);
    expect(await new Response(text.stdout).text()).toContain(
      "from peer (Quiet Peer)",
    );

    const json = Bun.spawn(
      [
        process.execPath,
        cli,
        "inbox",
        "--project",
        project,
        "--peek",
        "--json",
      ],
      {
        env: { ...process.env, HOME: home, ...INBOX_READER_ENV },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await json.exited).toBe(0);
    const result = JSON.parse(await new Response(json.stdout).text()) as {
      schemaVersion: number;
      scope: string;
      counts: { returned: number; markedRead: number };
      messages: {
        sender: { project: string; name: string; sessionId: string };
      }[];
    };
    expect(result.schemaVersion).toBe(1);
    expect(result.scope).toBe("project");
    expect(result.counts).toEqual(
      expect.objectContaining({ returned: 2, markedRead: 0 }),
    );
    expect(result.messages[0]?.sender).toEqual({
      project: "peer",
      name: "Quiet Peer",
      sessionId: "peer-session",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox read cannot acknowledge mail directed to a sibling session", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-inbox-sibling-"));
  const cli = join(import.meta.dir, "cli.ts");
  try {
    const { home, project, slug } = seedInbox(root);
    const inboxPath = join(
      home,
      ".claude",
      "agent-mail",
      "inbox",
      `${slug}.jsonl`,
    );
    const sibling = {
      id: "sibling-only",
      ts: "2026-08-31T12:02:00.000Z",
      from: "peer",
      project: realpathSync(project),
      message: "private sibling body",
      meta: {
        fromName: "Quiet Peer",
        sessionId: "peer-session",
        toSession: "sibling-session",
      },
    };
    writeFileSync(
      inboxPath,
      `${readFileSync(inboxPath, "utf8")}${JSON.stringify(sibling)}\n`,
    );

    const child = Bun.spawn(
      [process.execPath, cli, "inbox", "--project", project],
      {
        env: { ...process.env, HOME: home, ...INBOX_READER_ENV },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toContain(
      "marked 2 message(s) read",
    );

    const receiptsPath = join(
      home,
      ".claude",
      "agent-mail",
      "receipts",
      `${slug}.jsonl`,
    );
    const receipts = readFileSync(receiptsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { messageId: string });
    expect(
      receipts.some((receipt) => receipt.messageId === "sibling-only"),
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox --peek leaves messages unread and appends no receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-inbox-peek-"));
  const cli = join(import.meta.dir, "cli.ts");
  try {
    const { home, project, slug } = seedInbox(root);
    const state = join(home, ".claude", "agent-mail");
    const child = Bun.spawn(
      [process.execPath, cli, "inbox", "--project", project, "--peek"],
      {
        env: { ...process.env, HOME: home, ...INBOX_READER_ENV },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(0);
    const out = await new Response(child.stdout).text();
    expect(out).toContain("note-a unread");
    expect(out).toContain("note-b unread");
    expect(out).not.toContain("marked");
    expect(existsSync(join(state, "receipts", `${slug}.jsonl`))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an indirect registered host cannot attribute a CLI read without a session id", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-inbox-anon-"));
  const cli = join(import.meta.dir, "cli.ts");
  const {
    CLAUDE_CODE_SESSION_ID: _claude,
    CODEX_THREAD_ID: _codex,
    AGENT_SESSION_ID: _agent,
    ...anonymous
  } = process.env;
  try {
    const { home, project, slug } = seedInbox(root);
    const state = join(home, ".claude", "agent-mail");
    const nested = join(root, "nested.ts");
    writeFileSync(
      nested,
      'const child = Bun.spawn(Bun.argv.slice(2), { stdout: "inherit", stderr: "inherit" }); process.exit(await child.exited);\n',
    );
    const child = Bun.spawn(
      [
        process.execPath,
        nested,
        process.execPath,
        cli,
        "inbox",
        "--project",
        project,
      ],
      {
        env: { ...anonymous, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(0);
    const out = await new Response(child.stdout).text();
    expect(out).toContain("note-a unread");
    expect(out).toContain("note-b unread");
    expect(out).not.toContain("marked");
    expect(await new Response(child.stderr).text()).toContain(
      "no verified agent session for this process",
    );
    expect(existsSync(join(state, "receipts", `${slug}.jsonl`))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("notify without a resolving sender stamps no identity and keeps the label", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-notify-anon-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const {
    CLAUDE_CODE_SESSION_ID: _claude,
    CODEX_THREAD_ID: _codex,
    AGENT_SESSION_ID: _agent,
    ...anonymous
  } = process.env;
  // A session id in the environment is not enough: without a live registration
  // for it, the id names no one, so nothing may be stamped from it.
  const ghostEnv = { ...anonymous, CLAUDE_CODE_SESSION_ID: "ghost-session" };
  try {
    const ghost = await notifyRequest(
      ["--project", project, "--message", "job done"],
      { ...ghostEnv, HOME: home },
    );
    expect(ghost.exitCode).toBe(0);
    expect(ghost.body?.meta).not.toHaveProperty("sessionId");
    expect(ghost.body?.from).toBe("cli");

    const unlabeled = await notifyRequest(
      ["--project", project, "--message", "job done"],
      { ...anonymous, HOME: home },
    );
    expect(unlabeled.exitCode).toBe(0);
    expect(unlabeled.body?.meta).not.toHaveProperty("sessionId");
    expect(unlabeled.body?.from).toBe("cli");

    const labeled = await notifyRequest(
      ["--project", project, "--message", "job done", "--from", "ops-robot"],
      { ...ghostEnv, HOME: home },
    );
    expect(labeled.exitCode).toBe(0);
    expect(labeled.body?.meta).not.toHaveProperty("sessionId");
    expect(labeled.body?.from).toBe("ops-robot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an inherited session id is not adopted without a host-process match", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-inbox-inherited-"));
  const cli = join(import.meta.dir, "cli.ts");
  try {
    // A live registration for "cli-reader" whose host agent is not an ancestor
    // of the CLI child — the shape a script or daemon launched from an agent
    // shell has, carrying that shell's session id without belonging to it.
    const { home, project, slug } = seedInbox(root, 999_999);
    const state = join(home, ".claude", "agent-mail");
    const child = Bun.spawn(
      [process.execPath, cli, "inbox", "--project", project],
      {
        env: { ...process.env, HOME: home, ...INBOX_READER_ENV },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(0);
    const out = await new Response(child.stdout).text();
    expect(out).toContain("note-a unread");
    expect(out).not.toContain("marked");
    expect(await new Response(child.stderr).text()).toContain(
      "no verified agent session for this process",
    );
    expect(existsSync(join(state, "receipts", `${slug}.jsonl`))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second inbox read does not re-stamp receipts it already settled", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-inbox-twice-"));
  const cli = join(import.meta.dir, "cli.ts");
  const read = async (home: string, project: string) => {
    const child = Bun.spawn(
      [process.execPath, cli, "inbox", "--project", project],
      {
        env: { ...process.env, HOME: home, ...INBOX_READER_ENV },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(0);
    return await new Response(child.stdout).text();
  };
  try {
    const { home, project, slug } = seedInbox(root);
    const receiptsPath = join(
      home,
      ".claude",
      "agent-mail",
      "receipts",
      `${slug}.jsonl`,
    );
    expect(await read(home, project)).toContain("marked 2 message(s) read");
    const afterFirst = readFileSync(receiptsPath, "utf8");

    // Receipts are append-only, so a repeat read must add nothing rather than
    // stack a second delivery history onto the same messages.
    expect(await read(home, project)).not.toContain("marked");
    expect(readFileSync(receiptsPath, "utf8")).toBe(afterFirst);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--help after a subcommand explains rather than acts", async () => {
  const project = mkdtempSync(join(tmpdir(), "agent-mail-cli-help-"));
  const cli = join(import.meta.dir, "cli.ts");

  // `inbox --help` printed the inbox, which is how a reader discovered mail
  // they had not read. The same shape on `notify --help` would have sent a
  // message, so the guard is checked on a command that acts, not only on one
  // that reads.
  for (const cmd of ["inbox", "notify"]) {
    const child = Bun.spawn(
      [process.execPath, cli, cmd, "--project", project, "--help"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(out).toContain("Usage: agent-mail <command>");
    // Every dispatched command must appear here, because this same string is
    // what `<command> --help` prints: a command missing from it is one whose
    // own help says nothing about it.
    expect(out).toContain("unregistered [--window <minutes>]");
  }

  // The spool stays empty: `notify --help` must not have sent anything.
  const spool = join(project, ".agent-mail");
  expect(existsSync(spool)).toBe(false);
});

test("inbox names the scope its count answers", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-scope-"));
  const cli = join(import.meta.dir, "cli.ts");
  const { home, project } = seedInbox(root);

  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      "inbox",
      "--project",
      project,
      "--peek",
      "--limit",
      "1",
    ],
    {
      env: { ...process.env, HOME: home, ...INBOX_READER_ENV },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);

  // The number this surface prints is project-wide across every session, while
  // status-line and check_inbox report one session's subset. Three bare
  // integers were compared as one fact; the output has to say which it is.
  expect(out).toContain("returned 1 of 2 matching in this project");
  expect(out).toContain("1 older match not shown");
  expect(out).toContain("not scoped to a session");
});

test("notify refuses unresolved replies instead of falling back to broadcast", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-reply-refusal-"));
  try {
    const { home, project } = seedInbox(root);
    for (const args of [
      ["--reply-to", "missing-parent"],
      ["--reply-to", "missing-parent", "--session", "cli-reader"],
      ["--reply-to", "note-a"],
      ["--reply-to", "note-a", "--session", "missing-recipient"],
    ]) {
      const result = await notifyRequest(
        ["--project", project, "--message", "must not broadcast", ...args],
        { HOME: home },
      );
      expect(result.exitCode).toBe(1);
      expect(result.body).toBeUndefined();
    }
    const accepted = await notifyRequest(
      [
        "--project",
        project,
        "--message",
        "answer automation",
        "--reply-to",
        "note-a",
        "--session",
        "cli-reader",
      ],
      { HOME: home },
    );
    expect(accepted.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status JSON reports unresolved identity as null instead of empty success output", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "agent-mail-json-unresolved-")),
  );
  try {
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(home);
    mkdirSync(project);
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "cli.ts"),
        "status-line",
        "--json",
        "--project",
        project,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: home,
          CLAUDE_CODE_SESSION_ID: "",
          CODEX_THREAD_ID: "",
          AGENT_SESSION_ID: "",
        },
      },
    );
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Run the obligations CLI as `caller-session` under `home`, cwd `project`. */
function obligationsRun(
  cli: string,
  home: string,
  project: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const {
    CLAUDE_CODE_SESSION_ID: _claude,
    AGENT_SESSION_ID: _agent,
    AGENT_SESSION_PID: _pid,
    ...baseEnv
  } = process.env;
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: {
      ...baseEnv,
      HOME: home,
      CODEX_THREAD_ID: "caller-session",
      ...extraEnv,
    },
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
  return (async () => {
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    return { stdout, stderr, exit: await child.exited };
  })();
}

test("obligations CLI announces, lists, closes, and contests as the operator", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-obligations-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  registerLiveSession(home, project, "caller-session");
  const cli = join(import.meta.dir, "cli.ts");
  const run = (args: string[]) => obligationsRun(cli, home, project, args);
  try {
    // Empty state is a line, never silence.
    const empty = await run(["obligations", "owed"]);
    expect(empty.exit, empty.stderr).toBe(0);
    expect(empty.stdout).toContain("no open obligations owed by you");

    const announced = await run([
      "obligations",
      "announce",
      "--user",
      "--kind",
      "decision",
      "--subject",
      "pick the deploy window",
    ]);
    expect(announced.exit, announced.stderr).toBe(0);
    const id = /announced (ob-[0-9a-f]+)/.exec(announced.stdout)?.[1];
    if (!id) throw new Error("announce returned no obligation id");

    const owed = await run(["obligations", "owed"]);
    expect(owed.exit, owed.stderr).toBe(0);
    expect(owed.stdout).toContain(id);
    expect(owed.stdout).toContain("pick the deploy window");
    expect(owed.stdout).toContain("by user");

    // A session may not contest a record that names the operator.
    const refused = await run([
      "obligations",
      "contest",
      "--id",
      id,
      "--reason",
      "not mine",
    ]);
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toContain("--user");

    const contested = await run([
      "obligations",
      "contest",
      "--id",
      id,
      "--reason",
      "not mine",
      "--user",
    ]);
    expect(contested.exit, contested.stderr).toBe(0);
    const listed = await run(["obligations", "list"]);
    expect(listed.exit, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("[contested");
    expect(listed.stdout).toContain("not mine");

    const closed = await run([
      "obligations",
      "close",
      "--id",
      id,
      "--resolution",
      "window picked",
    ]);
    expect(closed.exit, closed.stderr).toBe(0);
    const owedAfter = await run(["obligations", "owed"]);
    expect(owedAfter.stdout).toContain("no open obligations owed by you");
    const all = await run(["obligations", "list", "--all"]);
    expect(all.stdout).toContain("[satisfied]");
    expect(all.stdout).toContain("resolution window picked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("obligations CLI resolves a session obligor, pushes one notice, and adopts", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-obligor-"));
  const home = join(root, "home");
  const callerProject = join(root, "caller");
  const obligorProject = join(root, "obligor");
  mkdirSync(callerProject, { recursive: true });
  mkdirSync(obligorProject, { recursive: true });
  registerLiveSession(home, callerProject, "caller-session");
  // A live registration in another project: the caller pid is alive with a
  // matching procStart, which is all registry-backed liveness reads.
  registerLiveSession(home, obligorProject, "obligor-session");
  // An offline predecessor with one open obligation, seeded directly. The id
  // is UUID-shaped: real session ids are, and adoption accepts only
  // UUID-shaped ids that no live registry or name store can resolve.
  const predecessorId = "0eedd1a5-0000-4000-8000-00000000dead";
  const obligationsDir = join(home, ".claude", "agent-mail", "obligations");
  mkdirSync(obligationsDir, { recursive: true });
  writeFileSync(
    join(obligationsDir, "ob-deadbeef.json"),
    `${JSON.stringify(
      {
        version: 1,
        id: "ob-deadbeef",
        createdAt: new Date().toISOString(),
        obligee: { sessionId: predecessorId, label: "root-brief-owl" },
        obligor: { kind: "human", label: "user" },
        kind: "decision",
        subject: "resume the hunt",
        status: "open",
        contested: false,
        revision: 1,
      },
      null,
      2,
    )}\n`,
  );
  const cli = join(import.meta.dir, "cli.ts");
  const run = (args: string[]) =>
    obligationsRun(cli, home, callerProject, args);
  try {
    const announced = await run([
      "obligations",
      "announce",
      "--obligor",
      "obligor-session",
      "--kind",
      "claim_release",
      "--subject",
      "EXP-0007",
    ]);
    expect(announced.exit, announced.stderr).toBe(0);
    expect(announced.stdout).toContain("notified");

    // Exactly one notice, in the obligor's project spool, addressed to them.
    const spoolPath = join(
      home,
      ".claude",
      "agent-mail",
      "inbox",
      `${projectSlug(obligorProject)}.jsonl`,
    );
    const lines = readFileSync(spoolPath, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    const notice = JSON.parse(lines[0]) as {
      message: string;
      meta: Record<string, string>;
    };
    expect(notice.meta.toSession).toBe("obligor-session");
    expect(notice.message).toContain("claim_release");
    expect(notice.message).toContain("EXP-0007");

    // A resume id typed at the CLI proves nothing: only the id this shell's
    // host command line carried is accepted, and the runner was not launched
    // with --resume. Declared authority is the other route.
    const vacuous = await run([
      "obligations",
      "adopt",
      "--predecessor",
      predecessorId,
      "--resume-id",
      predecessorId,
    ]);
    expect(vacuous.exit).toBe(1);
    expect(vacuous.stderr).toContain("host command line");

    // Adoption by declared authority moves the offline obligee's record to
    // the caller.
    const adopted = await run([
      "obligations",
      "adopt",
      "--predecessor",
      predecessorId,
      "--authority",
      "operator",
      "--reason",
      "resume the hunt",
    ]);
    expect(adopted.exit, adopted.stderr).toBe(0);
    expect(adopted.stdout).toContain(
      `adopted 1 obligation(s) from ${predecessorId}`,
    );
    expect(adopted.stdout).toContain(`adopted from ${predecessorId}`);
    const listed = await run(["obligations", "list"]);
    expect(listed.stdout).toContain("ob-deadbeef");
    expect(listed.stdout).toContain("resume the hunt");

    // Succession proofs and authority clearing are strict about their flags.
    const proofless = await run([
      "obligations",
      "adopt",
      "--predecessor",
      predecessorId,
    ]);
    expect(proofless.exit).toBe(1);
    expect(proofless.stderr).toContain("resume-id");
    const reasonless = await run([
      "obligations",
      "adopt",
      "--predecessor",
      predecessorId,
      "--authority",
      "operator",
    ]);
    expect(reasonless.exit).toBe(1);
    expect(reasonless.stderr).toContain("--reason");
    const clearMissing = await run([
      "obligations",
      "clear",
      "--id",
      "ob-deadbeef",
    ]);
    expect(clearMissing.exit).toBe(1);
    expect(clearMissing.stderr).toContain("--authority");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("obligations CLI announces a system obligor and settles the wait on the weft event", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-cli-obligation-system-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  registerLiveSession(home, project, "caller-session");
  const cli = join(import.meta.dir, "cli.ts");
  const run = (args: string[], env: Record<string, string> = {}) =>
    obligationsRun(cli, home, project, args, env);
  try {
    const announced = await run([
      "obligations",
      "announce",
      "--system",
      "weft",
      "--kind",
      "job_completion",
      "--subject",
      "job-9",
    ]);
    expect(announced.exit, announced.stderr).toBe(0);
    const id = /announced (ob-[0-9a-f]+)/.exec(announced.stdout)?.[1];
    if (!id) throw new Error("announce returned no obligation id");
    // A system obligor gets no creation notice: its surface is its own
    // event feed.
    expect(announced.stdout).not.toContain("notified");

    // A system with no wired settlement hook is refused outright.
    const refused = await run([
      "obligations",
      "announce",
      "--system",
      "not-a-system",
      "--kind",
      "job_completion",
      "--subject",
      "job-10",
    ]);
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toContain("no wired settlement hook");

    // The weft notify command running with WEFT_JOB_ID set IS the
    // completion event: the wait settles deterministically, before any
    // delivery work.
    const notifyBinary = join(import.meta.dir, "cli.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        notifyBinary,
        "notify",
        "--project",
        project,
        "--message",
        "job finished",
      ],
      {
        env: {
          ...process.env,
          CLAUDE_CODE_SESSION_ID: "",
          AGENT_SESSION_ID: "",
          HOME: home,
          WEFT_JOB_ID: "job-9",
        },
        cwd: project,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const notifyStderr = await new Response(child.stderr).text();
    expect(await child.exited, notifyStderr).toBe(0);
    expect(notifyStderr).toContain(
      "settled 1 job_completion obligation(s) on weft job job-9",
    );

    const listed = await run(["obligations", "list", "--all"]);
    expect(listed.stdout).toContain(`${id} job_completion job-9`);
    expect(listed.stdout).toContain("[satisfied]");
    expect(listed.stdout).toContain("[system; closed");
    expect(listed.stdout).toContain("by weft");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("obligations CLI announces a component owner, notifies the resolved session, and refuses its contest", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "agent-mail-cli-obligation-component-"),
  );
  const home = join(root, "home");
  const project = join(root, "resolve-component");
  mkdirSync(project, { recursive: true });
  registerLiveSession(home, project, "caller-session");
  const cli = join(import.meta.dir, "cli.ts");
  const run = (args: string[]) => obligationsRun(cli, home, project, args);
  try {
    const announced = await run([
      "obligations",
      "announce",
      "--component",
      "resolve-component",
      "--kind",
      "external_fix",
      "--subject",
      "am42",
    ]);
    expect(announced.exit, announced.stderr).toBe(0);
    const id = /announced (ob-[0-9a-f]+)/.exec(announced.stdout)?.[1];
    if (!id) throw new Error("announce returned no obligation id");
    // The creation notice went to the one responsible session: the sole
    // live session in the component's project.
    expect(announced.stdout).toContain(
      "notified owner of resolve-component (caller-session)",
    );
    const spoolPath = join(
      home,
      ".claude",
      "agent-mail",
      "inbox",
      `${projectSlug(realpathSync(project))}.jsonl`,
    );
    const lines = readFileSync(spoolPath, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    const notice = JSON.parse(lines[0]) as { meta: Record<string, string> };
    expect(notice.meta.toSession).toBe("caller-session");

    // The role cannot contest, not even through the session it resolves to;
    // a system or role obligor settles by evidence or clears by authority.
    const contested = await run([
      "obligations",
      "contest",
      "--id",
      id,
      "--reason",
      "not mine",
    ]);
    expect(contested.exit).toBe(1);
    expect(contested.stderr).toContain("cannot contest");

    // The listing renders the role's resolution provenance.
    const listed = await run(["obligations", "list"]);
    expect(listed.stdout).toContain(
      "owner of resolve-component → caller-session",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
