import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function textContent(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new TypeError("expected an MCP content result");
  }
  return result.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

test("claim_path accepts and releases an atomic path batch over MCP", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-channel-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "channel.ts")],
    cwd: project,
    env: { ...environment, HOME: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mail-test", version: "1" });
  try {
    await client.connect(transport);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).not.toContain("Agent-mail backlog:");
    expect(instructions).toContain(
      'Treat an unqualified user request to check or read "mail" or "the inbox" as an agent-mail request: call check_inbox.',
    );
    const tools = await client.listTools();
    const claimTool = tools.tools.find((tool) => tool.name === "claim_path");
    expect(claimTool?.inputSchema.properties).toHaveProperty("paths");
    const inboxTool = tools.tools.find((tool) => tool.name === "check_inbox");
    expect(inboxTool?.description).toContain(
      "asks to check or read mail or an unqualified inbox",
    );
    const sendTool = tools.tools.find((tool) => tool.name === "send_mail");
    expect(sendTool?.description).toContain(
      "harness-native peer messaging must be named explicitly",
    );
    expect(
      tools.tools.some((tool) => tool.name === "request_coordination_transfer"),
    ).toBe(true);
    expect(
      tools.tools.some((tool) => tool.name === "respond_coordination_transfer"),
    ).toBe(true);

    await client.callTool({ name: "check_inbox" });
    const registry = join(home, ".claude", "agent-mail", "registry");
    const registrations = readdirSync(registry).map(
      (name) =>
        JSON.parse(readFileSync(join(registry, name), "utf8")) as {
          lastInboxPoll?: string;
        },
    );
    expect(registrations).toHaveLength(1);
    expect(registrations[0].lastInboxPoll).toBeDefined();

    const claimed = await client.callTool({
      name: "claim_path",
      arguments: { paths: ["Sources/Schedule.swift", "Checks/main.swift"] },
    });
    const claimedText = textContent(claimed);
    expect(claimedText).toContain("2 files claimed");
    const claimId = /claim ([0-9a-f-]+)/.exec(claimedText)?.[1];
    expect(claimId).toBeDefined();

    const active = await client.callTool({ name: "list_claims" });
    expect(textContent(active).split("\n")).toHaveLength(1);
    expect(textContent(active)).toContain("Sources/Schedule.swift");
    expect(textContent(active)).toContain("Checks/main.swift");

    await client.callTool({
      name: "release_claim",
      arguments: { claim_id: claimId },
    });
    const empty = await client.callTool({ name: "list_claims" });
    expect(textContent(empty)).toBe("no active claims");
  } finally {
    await client.close();
  }
});

test("a live channel restores a missing registry entry without another tool call", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-channel-presence-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "channel.ts")],
    cwd: project,
    env: {
      ...environment,
      HOME: home,
      CLAUDE_CODE_SESSION_ID: "registration-heartbeat",
      CODEX_THREAD_ID: "",
      AGENT_SESSION_ID: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mail-test", version: "1" });
  try {
    await client.connect(transport);
    // Ensure the initialized callback's second registration has completed;
    // any later recreation can only come from the idle poll.
    await client.listTools();
    const registry = join(home, ".claude", "agent-mail", "registry");

    // This integration test crosses a child-process timer; fake timers in
    // the test process cannot advance the channel server's poll interval.
    const [name] = readdirSync(registry);
    const path = join(registry, name);
    rmSync(path);

    const deadline = Date.now() + 2_500;
    while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(25);

    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      cwd: realpathSync(project),
      sessionId: "registration-heartbeat",
    });
  } finally {
    await client.close();
  }
}, 5_000);

test("a stale registration is rewritten, not just a missing one", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-channel-stale-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "channel.ts")],
    cwd: project,
    env: {
      ...environment,
      HOME: home,
      CLAUDE_CODE_SESSION_ID: "stale-capabilities",
      CODEX_THREAD_ID: "",
      AGENT_SESSION_ID: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mail-test", version: "1" });
  try {
    await client.connect(transport);
    await client.listTools();
    const registry = join(home, ".claude", "agent-mail", "registry");
    const [name] = readdirSync(registry);
    const path = join(registry, name);

    // An entry an older build could have left behind: it exists, so an
    // existence check is satisfied, and it claims a channel this host has not.
    const stored = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify({
        ...stored,
        client: "some-older-host",
        capabilities: { ...stored.capabilities, channelPush: true },
      }),
    );

    const deadline = Date.now() + 2_500;
    let current = stored;
    while (Date.now() < deadline) {
      current = JSON.parse(readFileSync(path, "utf8"));
      if (current.client !== "some-older-host") break;
      await Bun.sleep(25);
    }
    expect(current.client).not.toBe("some-older-host");
    expect(current.capabilities).toEqual(stored.capabilities);
  } finally {
    await client.close();
  }
}, 5_000);

test("initial MCP instructions report the session's unread backlog only", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-channel-backlog-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const canonical = realpathSync(project);
  const slug = `${project.split("/").pop()}-${createHash("sha256").update(canonical).digest("hex").slice(0, 10)}`;
  const inboxDirectory = join(home, ".claude", "agent-mail", "inbox");
  mkdirSync(inboxDirectory, { recursive: true });
  const messages = [
    {
      id: "broadcast",
      ts: "2026-08-22T12:00:00.000Z",
      from: "secret-sender",
      project: canonical,
      message: "SECRET BROADCAST BODY",
    },
    {
      id: "direct",
      ts: "2026-08-22T12:01:00.000Z",
      from: "secret-sender",
      project: canonical,
      message: "SECRET DIRECT BODY",
      meta: { toSession: "recipient-session" },
    },
    {
      id: "for-someone-else",
      ts: "2026-08-22T12:02:00.000Z",
      from: "secret-sender",
      project: canonical,
      message: "SECRET OTHER BODY",
      meta: { toSession: "other-session" },
    },
    {
      id: "self-authored",
      ts: "2026-08-22T12:03:00.000Z",
      from: canonical,
      project: canonical,
      message: "SECRET SELF BODY",
      meta: { sessionId: "recipient-session" },
    },
  ];
  writeFileSync(
    join(inboxDirectory, `${slug}.jsonl`),
    `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "channel.ts")],
    cwd: project,
    env: {
      ...environment,
      HOME: home,
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      AGENT_SESSION_ID: "recipient-session",
      AGENT_SESSION_PID: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mail-test", version: "1" });

  try {
    await client.connect(transport);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain(
      "Agent-mail backlog: 2 unread messages are waiting for this session. " +
        "Call check_inbox to read them.",
    );
    expect(instructions).not.toContain("secret-sender");
    expect(instructions).not.toContain("SECRET");

    // A following request establishes that the server handled the initialized
    // notification and stamped announcement state without writing a receipt.
    await client.listTools();
    const announcedPath = join(
      home,
      ".claude",
      "agent-mail",
      "announced",
      `${slug}-recipient-session.json`,
    );
    const announced = JSON.parse(readFileSync(announcedPath, "utf8")) as {
      lastUnread: number;
      lastNewestId?: string;
      remindCount: number;
    };
    expect(announced.lastUnread).toBe(2);
    expect(announced.lastNewestId).toBe("direct");
    expect(announced.remindCount).toBe(1);
    expect(
      readdirSync(join(home, ".claude", "agent-mail", "receipts")),
    ).toHaveLength(0);
  } finally {
    await client.close();
  }
});

test("logical work can be acquired, updated, listed, and released over MCP", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-channel-work-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "channel.ts")],
    cwd: project,
    env: { ...environment, HOME: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mail-test", version: "1" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("acquire_work");

    const acquired = await client.callTool({
      name: "acquire_work",
      arguments: {
        resource_type: "research-plan",
        resource_key: "2026-08-12-pilot",
        label: "Pilot campaign",
        activity: "Startup audit",
      },
    });
    const acquiredText = textContent(acquired);
    expect(acquiredText).toContain("Pilot campaign");
    const workId = /acquired ([0-9a-f-]+)/.exec(acquiredText)?.[1];
    expect(workId).toBeDefined();
    const workRoot = join(home, ".claude", "agent-mail", "work");
    const [workProject] = readdirSync(workRoot);
    const [workFile] = readdirSync(join(workRoot, workProject));
    const stored = JSON.parse(
      readFileSync(join(workRoot, workProject, workFile), "utf8"),
    ) as { owner: { instanceId?: string; procStart?: string } };
    expect(stored.owner.instanceId).toBeDefined();

    const updated = await client.callTool({
      name: "update_work",
      arguments: {
        work_id: workId,
        state: "waiting",
        activity: "Waiting for job 42",
      },
    });
    expect(textContent(updated)).toContain("Waiting for job 42");

    const listed = await client.callTool({ name: "list_work" });
    expect(textContent(listed)).toContain("research-plan:2026-08-12-pilot");
    expect(textContent(listed)).toContain("[waiting]");

    await client.callTool({
      name: "release_work",
      arguments: { work_id: workId },
    });
    expect(textContent(await client.callTool({ name: "list_work" }))).toBe(
      "no active work",
    );
  } finally {
    await client.close();
  }
});

test("coordination tools expose and recover only dead-session records", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-channel-recovery-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const canonical = realpathSync(project);
  const slug = `${project.split("/").pop()}-${createHash("sha256").update(canonical).digest("hex").slice(0, 10)}`;
  const claimDirectory = join(home, ".claude", "agent-mail", "claims", slug);
  mkdirSync(claimDirectory, { recursive: true });
  writeFileSync(
    join(claimDirectory, "stale-claim.json"),
    JSON.stringify({
      id: "stale-claim",
      type: "path",
      project: canonical,
      path: join(canonical, "notes.md"),
      pathType: "file",
      owner: {
        id: "dead-session",
        label: "Offline Agent",
        sessionId: "dead-session",
        pid: 999_999,
      },
      createdAt: "2026-08-12T00:00:00.000Z",
    }),
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "channel.ts")],
    cwd: project,
    env: { ...environment, HOME: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mail-test", version: "1" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("list_coordination");
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "recover_coordination",
    );
    const listed = await client.callTool({ name: "list_coordination" });
    expect(textContent(listed)).toContain("stale-claim");
    expect(textContent(listed)).toContain("[owner-offline]");

    const recovered = await client.callTool({
      name: "recover_coordination",
      arguments: { coordination_id: "stale-claim" },
    });
    expect(textContent(recovered)).toContain("Offline Agent");
    expect(
      textContent(await client.callTool({ name: "list_coordination" })),
    ).toBe("no active coordination");
  } finally {
    await client.close();
  }
});

test("a channel push carries the acknowledgement it cannot perform", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-channel-instruct-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const canonical = realpathSync(project);
  const slug = `${project.split("/").pop()}-${createHash("sha256").update(canonical).digest("hex").slice(0, 10)}`;
  const inboxDirectory = join(home, ".claude", "agent-mail", "inbox");
  mkdirSync(inboxDirectory, { recursive: true });
  writeFileSync(
    join(inboxDirectory, `${slug}.jsonl`),
    `${JSON.stringify({
      id: "instruct-me",
      ts: "2026-09-01T12:00:00.000Z",
      from: "peer",
      project: canonical,
      message: "body",
    })}\n`,
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "channel.ts")],
    cwd: project,
    env: {
      ...environment,
      HOME: home,
      CLAUDE_CODE_SESSION_ID: "instructed-session",
      CODEX_THREAD_ID: "",
      AGENT_SESSION_ID: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mail-test", version: "1" });
  try {
    await client.connect(transport);
    // The pull renders the same stored message. The instruction belongs to the
    // push, where the agent is reading it and the id is in front of them — not
    // to the pull, which has already marked it read.
    const pulled = await client.callTool({
      name: "check_inbox",
      arguments: { peek: true },
    });
    expect(textContent(pulled)).not.toContain("[agent-mail] handled?");
  } finally {
    await client.close();
  }
}, 5_000);

test("the unread count separates delivered-but-unacknowledged from never delivered", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-channel-split-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const canonical = realpathSync(project);
  const slug = `${project.split("/").pop()}-${createHash("sha256").update(canonical).digest("hex").slice(0, 10)}`;
  const inboxDirectory = join(home, ".claude", "agent-mail", "inbox");
  mkdirSync(inboxDirectory, { recursive: true });
  const seeded = ["p1", "p2"].map((id, index) => ({
    id,
    ts: `2026-09-01T12:0${index}:00.000Z`,
    from: "peer",
    project: canonical,
    message: `body ${id}`,
  }));
  writeFileSync(
    join(inboxDirectory, `${slug}.jsonl`),
    `${seeded.map((m) => JSON.stringify(m)).join("\n")}\n`,
  );

  // One of the two was pushed to this session and never acknowledged — the
  // state an agent lands in when it answers straight from the push. The other
  // has never reached it. Both are "unread"; only the second is outstanding.
  const receiptDirectory = join(home, ".claude", "agent-mail", "receipts");
  mkdirSync(receiptDirectory, { recursive: true });
  writeFileSync(
    join(receiptDirectory, `${slug}.jsonl`),
    `${JSON.stringify({
      messageId: "p1",
      project: canonical,
      ts: "2026-09-01T12:05:00.000Z",
      status: "pushed",
      sessionId: "split-session",
    })}\n`,
  );

  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "channel.ts")],
    cwd: project,
    env: {
      ...environment,
      HOME: home,
      CLAUDE_CODE_SESSION_ID: "split-session",
      CODEX_THREAD_ID: "",
      AGENT_SESSION_ID: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mail-test", version: "1" });
  try {
    await client.connect(transport);
    const pulled = await client.callTool({
      name: "check_inbox",
      arguments: { peek: true },
    });
    expect(textContent(pulled)).toContain(
      "2 unread for this session (1 delivered but unacknowledged, 1 never delivered)",
    );
  } finally {
    await client.close();
  }
}, 5_000);

test("refusal counts only what it refused, and still reports what the limit withheld", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-channel-refuse-count-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const canonical = realpathSync(project);
  const slug = `${project.split("/").pop()}-${createHash("sha256").update(canonical).digest("hex").slice(0, 10)}`;
  const inboxDirectory = join(home, ".claude", "agent-mail", "inbox");
  mkdirSync(inboxDirectory, { recursive: true });
  const seeded = ["m1", "m2", "m3"].map((id, index) => ({
    id,
    ts: `2026-09-01T12:0${index}:00.000Z`,
    from: "peer",
    project: canonical,
    message: `body ${id}`,
  }));
  writeFileSync(
    join(inboxDirectory, `${slug}.jsonl`),
    `${seeded.map((m) => JSON.stringify(m)).join("\n")}\n`,
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "channel.ts")],
    cwd: project,
    env: {
      ...environment,
      HOME: home,
      CLAUDE_CODE_SESSION_ID: "refuse-counting-session",
      CODEX_THREAD_ID: "",
      AGENT_SESSION_ID: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mail-test", version: "1" });
  try {
    await client.connect(transport);

    // Settle the newest message first: a normal pull records a terminal
    // receipt for it while leaving it visible.
    await client.callTool({ name: "check_inbox", arguments: { limit: 1 } });

    await client.callTool({
      name: "set_inbound_policy",
      arguments: { policy: "refuse" },
    });
    const refused = await client.callTool({
      name: "check_inbox",
      arguments: { limit: 1 },
    });
    const text = textContent(refused);

    // The page holds one already-settled message, so nothing was newly
    // refused — counting the page would have reported a refusal that never
    // happened and wrote no receipt.
    expect(text).toContain("refused 0 of 3 matching");
    // And the two the limit withheld were never acted on, so the hint that
    // reaches them must survive the refuse branch.
    expect(text).toContain("2 older match not shown");
  } finally {
    await client.close();
  }
}, 5_000);

test("refused mail is reported as refused, not as a page the limit withheld", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-channel-refuse-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const canonical = realpathSync(project);
  const slug = `${project.split("/").pop()}-${createHash("sha256").update(canonical).digest("hex").slice(0, 10)}`;
  const inboxDirectory = join(home, ".claude", "agent-mail", "inbox");
  mkdirSync(inboxDirectory, { recursive: true });
  writeFileSync(
    join(inboxDirectory, `${slug}.jsonl`),
    `${JSON.stringify({
      id: "refused-note",
      ts: "2026-09-01T12:00:00.000Z",
      from: "peer",
      project: canonical,
      message: "body",
    })}\n`,
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "channel.ts")],
    cwd: project,
    env: {
      ...environment,
      HOME: home,
      CLAUDE_CODE_SESSION_ID: "refusing-session",
      CODEX_THREAD_ID: "",
      AGENT_SESSION_ID: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mail-test", version: "1" });
  try {
    await client.connect(transport);
    await client.callTool({
      name: "set_inbound_policy",
      arguments: { policy: "refuse" },
    });
    const pulled = await client.callTool({
      name: "check_inbox",
      arguments: { peek: true },
    });
    const text = textContent(pulled);

    // Refusal settles a message: raising `limit` will never return it. Saying
    // it was "not shown" would send a reader after mail no limit can reach —
    // the misdirection this scope line exists to prevent.
    expect(text).toContain("refused 1 of 1 matching");
    expect(text).not.toContain("not shown");
  } finally {
    await client.close();
  }
}, 5_000);

test("check_inbox marks returned messages read unless peek", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-channel-markread-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const canonical = realpathSync(project);
  const slug = `${project.split("/").pop()}-${createHash("sha256").update(canonical).digest("hex").slice(0, 10)}`;
  const inboxDirectory = join(home, ".claude", "agent-mail", "inbox");
  mkdirSync(inboxDirectory, { recursive: true });
  const messages = [
    {
      id: "note-a",
      ts: "2026-08-28T12:00:00.000Z",
      from: "peer",
      project: canonical,
      message: "broadcast body",
    },
    {
      id: "note-b",
      ts: "2026-08-28T12:01:00.000Z",
      from: "peer",
      project: canonical,
      message: "direct body",
      meta: { toSession: "recipient-session" },
    },
  ];
  writeFileSync(
    join(inboxDirectory, `${slug}.jsonl`),
    `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "channel.ts")],
    cwd: project,
    env: {
      ...environment,
      HOME: home,
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      AGENT_SESSION_ID: "recipient-session",
      AGENT_SESSION_PID: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mail-test", version: "1" });
  try {
    await client.connect(transport);

    const peeked = await client.callTool({
      name: "check_inbox",
      arguments: { peek: true },
    });
    const peekedText = textContent(peeked);
    expect(peekedText).toContain("note-a unread");
    expect(peekedText).toContain("note-b unread");
    expect(peekedText).not.toContain("marked");

    const stillUnread = await client.callTool({
      name: "check_inbox",
      arguments: { unread: true, peek: true },
    });
    expect(textContent(stillUnread)).toContain("note-a unread");
    expect(textContent(stillUnread)).toContain("note-b unread");

    const pulled = await client.callTool({ name: "check_inbox" });
    const pulledText = textContent(pulled);
    expect(pulledText).toContain("note-a unread");
    expect(pulledText).toContain("marked 2 message(s) read");

    const after = await client.callTool({
      name: "check_inbox",
      arguments: { unread: true },
    });
    const afterText = textContent(after);
    expect(afterText).toStartWith("inbox empty");
    // The scope line must not describe the read messages the `unread` filter
    // excluded as pages the caller could reach by raising `limit`.
    expect(afterText).toContain("returned 0 of 0 matching");
    expect(afterText).toContain("0 unread for this session");
    expect(afterText).not.toContain("not shown");

    const again = await client.callTool({ name: "check_inbox" });
    const againText = textContent(again);
    expect(againText).toContain("note-a read");
    expect(againText).not.toContain("marked");

    const receipts = readFileSync(
      join(home, ".claude", "agent-mail", "receipts", `${slug}.jsonl`),
      "utf8",
    );
    expect(receipts).toContain('"status":"read"');
  } finally {
    await client.close();
  }
});

test("cli-origin senders without a stamped session render as labels, not addresses", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-channel-label-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const canonical = realpathSync(project);
  const slug = `${project.split("/").pop()}-${createHash("sha256").update(canonical).digest("hex").slice(0, 10)}`;
  const inboxDirectory = join(home, ".claude", "agent-mail", "inbox");
  mkdirSync(inboxDirectory, { recursive: true });
  const cliOrigin = {
    kind: "automation",
    transport: "cli",
    authority: "untrusted",
  };
  const messages = [
    {
      id: "cli-label",
      ts: "2026-08-31T12:00:00.000Z",
      from: "ci-robot",
      project: canonical,
      message: "unattributed body",
      origin: cliOrigin,
    },
    {
      id: "cli-attributed",
      ts: "2026-08-31T12:01:00.000Z",
      from: "ci-robot",
      project: canonical,
      message: "attributed body",
      origin: cliOrigin,
      meta: { sessionId: "sender-session", fromName: "sender-full-name" },
    },
  ];
  writeFileSync(
    join(inboxDirectory, `${slug}.jsonl`),
    `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "channel.ts")],
    cwd: project,
    env: {
      ...environment,
      HOME: home,
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      AGENT_SESSION_ID: "recipient-session",
      AGENT_SESSION_PID: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mail-test", version: "1" });
  try {
    await client.connect(transport);
    const pulled = await client.callTool({
      name: "check_inbox",
      arguments: { peek: true },
    });
    const lines = textContent(pulled).split("\n");
    const unattributed = lines.find((line) => line.startsWith("cli-label "));
    expect(unattributed).toContain("[automation/cli; untrusted]");
    expect(unattributed).toContain("[label; not a reply address]");
    const attributed = lines.find((line) => line.startsWith("cli-attributed "));
    expect(attributed).toContain("[sender-full-name]");
    expect(attributed).not.toContain("[label; not a reply address]");
  } finally {
    await client.close();
  }
});
