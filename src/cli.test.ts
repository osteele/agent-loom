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
import { sessionNames } from "./sessions.ts";

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

test("status-line prints nothing and exits 0 with no session to name", async () => {
  // The consumer is a shell substitution inside a status-line script, so a
  // non-zero exit is hazardous under `set -e` and stray output corrupts the
  // user's prompt. Empty output is the signal for "nothing to show" — which
  // now means only that no session id could be resolved. Being alone in the
  // project is not that: the name is this session's address elsewhere, so it
  // prints whether or not anyone is standing nearby.
  const project = mkdtempSync(join(tmpdir(), "agent-mail-statusline-"));
  const cli = join(import.meta.dir, "cli.ts");
  // The environment carries this very session's id; inheriting it would have
  // the test name the agent running it.
  const env = { ...process.env };
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

    const named = Bun.spawn(
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
    named.stdin.end();
    expect(await named.exited).toBe(0);
    expect((await new Response(named.stdout).text()).trim()).not.toBe("");
  } finally {
    rmSync(project, { recursive: true });
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
    const claimId = output.split("\n")[0];
    expect(claimId).toMatch(/^[0-9a-f-]+$/);
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

    const release = Bun.spawn(
      [
        process.execPath,
        cli,
        "release-claim",
        "--project",
        project,
        "--id",
        claimId,
      ],
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

test("notify --session addresses one live session instead of broadcasting", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-notify-session-"));
  const home = join(root, "home");
  const project = join(root, "project");
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
        project,
        "--message",
        "job done",
        "--session",
        "submitter-session",
      ],
      { HOME: home },
    );
    expect(addressed.exitCode).toBe(0);
    expect(addressed.body?.meta).toEqual({ toSession: "submitter-session" });
  } finally {
    rmSync(root, { recursive: true });
  }
});

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

test("status trusts the daemon pidfile only when the pid is still the daemon", async () => {
  // A pidfile is a claim about a number, and numbers get reused. A daemon that
  // exited days ago left 85066 behind; something unrelated later held that pid
  // and `status` reported a daemon that was not there. Identity, not liveness.
  const root = mkdtempSync(join(tmpdir(), "agent-mail-daemonpid-"));
  const home = join(root, "home");
  const data = join(home, ".claude", "agent-mail");
  mkdirSync(data, { recursive: true });
  const cli = join(import.meta.dir, "cli.ts");
  const env = { ...process.env, HOME: home };

  const runStatus = async (): Promise<string> => {
    const child = Bun.spawn([process.execPath, cli, "status"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(child.stdout).text();
    await child.exited;
    return text;
  };

  // A live pid that is not the daemon: this test process itself.
  writeFileSync(join(data, "daemon.pid"), String(process.pid));
  expect(await runStatus()).toContain("daemon: stopped");

  // A live pid whose command *is* the daemon entry point. Named to match what
  // `ps` will show, since that is the whole signal.
  const stand_in = join(root, "daemon.ts");
  writeFileSync(stand_in, "await new Promise((r) => setTimeout(r, 30_000));\n");
  const daemon = Bun.spawn([process.execPath, stand_in], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    writeFileSync(join(data, "daemon.pid"), String(daemon.pid));
    expect(await runStatus()).toContain(`daemon: running (pid ${daemon.pid})`);
  } finally {
    daemon.kill();
    await daemon.exited;
    rmSync(root, { recursive: true, force: true });
  }
  // Two CLI spawns, each paying module load plus a health probe.
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
    },
    {
      id: "note-b",
      ts: "2026-08-31T12:01:00.000Z",
      from: "peer",
      project: canonical,
      message: "direct body",
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
    expect(await new Response(again.stdout).text()).toBe("inbox empty\n");
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

test("inbox read with no session id is unattributed and leaves the spool alone", async () => {
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
    const child = Bun.spawn(
      [process.execPath, cli, "inbox", "--project", project],
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

test("notify stamps a live sender session so its label resolves as an address", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-notify-sender-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const registry = join(home, ".claude", "agent-mail", "registry");
  mkdirSync(project, { recursive: true });
  mkdirSync(registry, { recursive: true });
  const self = processInfo([process.pid]).get(process.pid);
  const canonical = realpathSync(project);
  writeFileSync(
    join(registry, `${projectSlug(canonical)}-${process.pid}.json`),
    JSON.stringify({
      cwd: canonical,
      pid: process.pid,
      parentPid: process.pid,
      ...(self ? { procStart: self.start } : {}),
      sessionId: "submitter-session",
      started: new Date().toISOString(),
    }),
  );
  const names = sessionNames("submitter-session", undefined, canonical);
  const senderEnv = {
    HOME: home,
    CLAUDE_CODE_SESSION_ID: "",
    CODEX_THREAD_ID: "submitter-session",
    AGENT_SESSION_ID: "",
  };

  try {
    const stamped = await notifyRequest(
      ["--project", project, "--message", "job done"],
      senderEnv,
    );
    expect(stamped.exitCode).toBe(0);
    expect(stamped.body?.meta).toEqual({
      sessionId: "submitter-session",
      fromName: names.fullName,
    });
    // No --from passed: the display name replaces the bare "cli" label.
    expect(stamped.body?.from).toBe(names.displayName);

    // An explicit --from still wins for the free-form label.
    const labeled = await notifyRequest(
      ["--project", project, "--message", "job done", "--from", "ops-robot"],
      senderEnv,
    );
    expect(labeled.exitCode).toBe(0);
    expect(labeled.body?.from).toBe("ops-robot");
    expect(labeled.body?.meta).toEqual({
      sessionId: "submitter-session",
      fromName: names.fullName,
    });
  } finally {
    rmSync(root, { recursive: true });
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
    expect(ghost.body?.meta).toBeUndefined();
    expect(ghost.body?.from).toBe("cli");

    const unlabeled = await notifyRequest(
      ["--project", project, "--message", "job done"],
      { ...anonymous, HOME: home },
    );
    expect(unlabeled.exitCode).toBe(0);
    expect(unlabeled.body?.meta).toBeUndefined();
    expect(unlabeled.body?.from).toBe("cli");

    const labeled = await notifyRequest(
      ["--project", project, "--message", "job done", "--from", "ops-robot"],
      { ...ghostEnv, HOME: home },
    );
    expect(labeled.exitCode).toBe(0);
    expect(labeled.body?.meta).toBeUndefined();
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
