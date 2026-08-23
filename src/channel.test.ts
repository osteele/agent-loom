import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
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
    expect(client.getInstructions()).not.toContain("Agent-mail backlog:");
    const tools = await client.listTools();
    const claimTool = tools.tools.find((tool) => tool.name === "claim_path");
    expect(claimTool?.inputSchema.properties).toHaveProperty("paths");
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
    const announced = JSON.parse(
      readFileSync(
        join(
          home,
          ".claude",
          "agent-mail",
          "announced",
          `${slug}-recipient-session.json`,
        ),
        "utf8",
      ),
    ) as { lastUnread: number; lastNewestId?: string; remindCount: number };
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
