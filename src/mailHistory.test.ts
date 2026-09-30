import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SessionMailHistory,
  mailHistoryPoller,
  projectSessionMail,
} from "./mailHistory.ts";
import { projectSlug } from "./paths.ts";
import type { DeliveryReceipt, StoredMessage } from "./spool.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function message(
  id: string,
  extra: Partial<StoredMessage> = {},
): StoredMessage {
  return {
    id,
    ts: "2026-09-01T00:00:00Z",
    from: "sender",
    project: "/projects/a",
    message: id,
    read: false,
    ...extra,
  };
}

function receipt(
  messageId: string,
  sessionId: string,
  extra: Partial<DeliveryReceipt> = {},
): DeliveryReceipt {
  return {
    messageId,
    project: "/projects/a",
    sessionId,
    status: "pending",
    ts: "2026-09-01T00:00:00Z",
    ...extra,
  };
}

test("session history joins direct intent, broadcast receipts and cross-project authorship without mailbox guessing", () => {
  const messages = [
    message("direct", { meta: { toSession: "owner" } }),
    message("other-direct", { meta: { toSession: "other" } }),
    message("broadcast"),
    message("unproven-broadcast"),
    message("own-broadcast", {
      meta: { sessionId: "owner", fromProject: "/projects/a" },
    }),
    message("cross-project", {
      project: "/projects/b",
      meta: {
        sessionId: "owner",
        fromProject: "/projects/a",
        toSession: "recipient",
      },
      replyTo: "direct",
      threadId: "direct",
    }),
    message("origin-send", {
      project: "/projects/b",
      origin: {
        kind: "agent",
        transport: "mcp",
        sessionId: "owner",
        authority: "untrusted",
      },
      meta: { sessionId: "different-legacy-id", fromProject: "/projects/a" },
    }),
    message("same-id-other-project", {
      project: "/projects/b",
      meta: { sessionId: "owner", fromProject: "/projects/b" },
    }),
    message("other-project-direct", {
      project: "/projects/b",
      meta: { toSession: "owner" },
    }),
    message("lookalike", {
      from: "owner",
      meta: { fromProject: "/projects/a" },
    }),
    message("audit", { delivery: "audit", meta: { toSession: "owner" } }),
    message("expired", {
      expiresAt: "2000-01-01T00:00:00Z",
      meta: { toSession: "owner" },
    }),
  ];
  const receipts = new Map([
    [
      "/projects/a",
      [
        receipt("broadcast", "owner"),
        receipt("broadcast", "other"),
        receipt("other-direct", "owner"),
        receipt("own-broadcast", "owner"),
        receipt("lookalike", "other"),
      ],
    ],
  ]);
  const history = projectSessionMail(
    "/projects/a",
    "owner",
    messages,
    receipts,
    1000,
  );
  expect(
    history.messages.map((item) => `${item.direction}:${item.id}`).sort(),
  ).toEqual([
    "incoming:broadcast",
    "incoming:direct",
    "incoming:expired",
    "outgoing:cross-project",
    "outgoing:origin-send",
    "outgoing:own-broadcast",
  ]);
  expect(
    history.messages.find((item) => item.id === "broadcast")?.recipients,
  ).toEqual(["other", "owner"]);
  expect(
    history.messages.find((item) => item.id === "cross-project"),
  ).toMatchObject({
    replyTo: "direct",
    threadId: "direct",
    project: "/projects/b",
    recipients: ["recipient"],
  });
  expect(
    projectSessionMail("/projects/a", "OWNER", messages, receipts).messages,
  ).toEqual([]);
});

test("timestamp order uses instants and stable keys, and self-addressed mail has both appearances", () => {
  const messages = [
    message("older", {
      ts: "2026-09-01T01:00:00+02:00",
      meta: { toSession: "owner" },
    }),
    message("newer", {
      ts: "2026-09-01T00:00:00Z",
      meta: {
        toSession: "owner",
        sessionId: "owner",
        fromProject: "/projects/a",
      },
    }),
  ];
  const history = projectSessionMail(
    "/projects/a",
    "owner",
    messages,
    new Map(),
  );
  expect(
    history.messages.map((item) => `${item.direction}:${item.id}`),
  ).toEqual(["incoming:newer", "outgoing:newer", "incoming:older"]);
  expect(() =>
    projectSessionMail(
      "/projects/a",
      "owner",
      [message("bad", { ts: "not a date" })],
      new Map(),
    ),
  ).toThrow();
});

function diskState(path: string): Record<string, string | number> {
  const state: Record<string, string | number> = {};
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    state[`${entry.name}:mtime`] = statSync(child).mtimeMs;
    if (entry.isDirectory()) {
      for (const [key, value] of Object.entries(diskState(child)))
        state[`${entry.name}/${key}`] = value;
    } else state[entry.name] = readFileSync(child).toString("base64");
  }
  return state;
}

test("history and both one-shot TUI paths never change messages, receipts, read markers or registry", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-mail-history-")));
  roots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  const other = join(root, "other");
  const state = join(home, ".claude", "agent-mail");
  for (const path of [
    home,
    project,
    other,
    ...["inbox", "receipts", "registry", "read"].map((name) =>
      join(state, name),
    ),
  ])
    mkdirSync(path, { recursive: true });
  const incoming = message("incoming", {
    project,
    meta: { toSession: "owner" },
    message: "hello\nfull body\u001b]52;secret\u0007",
  });
  const outgoing = message("outgoing", {
    project: other,
    meta: { sessionId: "owner", fromProject: project, toSession: "recipient" },
  });
  writeFileSync(
    join(state, "inbox", `${projectSlug(project)}.jsonl`),
    `${JSON.stringify(incoming)}\n`,
  );
  writeFileSync(
    join(state, "inbox", `${projectSlug(other)}.jsonl`),
    `${JSON.stringify(outgoing)}\n`,
  );
  writeFileSync(
    join(state, "receipts", `${projectSlug(project)}.jsonl`),
    `${JSON.stringify(receipt("incoming", "owner", { project }))}\n`,
  );
  writeFileSync(
    join(state, "registry", "dead.json"),
    JSON.stringify({ pid: 2147483647, sessionId: "obsolete", cwd: project }),
  );
  const invoke = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        join(import.meta.dir, "cli.ts"),
        "mail",
        ...args,
        "--session",
        "owner",
        "--project",
        project,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          AGENT_SESSION_ID: "wrong-inherited-session",
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
  const before = diskState(home);
  const json = invoke(["history"]);
  expect(json.error).toBeUndefined();
  expect(json.status).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({
    kind: "session_mail_history",
    version: 1,
    project,
    sessionId: "owner",
    messages: expect.arrayContaining([
      expect.objectContaining({ id: "incoming", direction: "incoming" }),
      expect.objectContaining({ id: "outgoing", direction: "outgoing" }),
    ]),
  });
  for (const args of [["tui", "--once"], ["tui"]]) {
    const report = invoke(args);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("full body\\u{1b}]");
    expect(report.stdout).toContain("outgoing");
    expect(report.stdout).not.toContain("\u001b");
  }
  expect(diskState(home)).toEqual(before);
  writeFileSync(
    join(state, "inbox", `${projectSlug(project)}.jsonl`),
    "malformed JSON\n",
  );
  const failed = invoke(["history"]);
  expect(failed.status).toBe(1);
  expect(failed.stdout).toBe("");
  expect(failed.stderr).toContain("Cannot read message history");
});

test("viewing an empty home creates no mail state and refuses implicit selectors", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "agent-mail-empty-history-")),
  );
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const before = diskState(home);
  const invoke = (args: string[]) =>
    spawnSync(
      process.execPath,
      [join(import.meta.dir, "cli.ts"), "mail", ...args],
      {
        env: {
          ...process.env,
          HOME: home,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
  expect(
    invoke(["history", "--session", "owner", "--project", root]).status,
  ).toBe(0);
  expect(invoke(["tui", "--project", root]).status).toBe(1);
  expect(
    invoke(["history", "--session", "owner", "--project", root, "--all"])
      .status,
  ).toBe(1);
  expect(diskState(home)).toEqual(before);
});

test("the history poller reads the archive only when its inputs change", () => {
  let stamp = "a";
  let reads = 0;
  const history = (): SessionMailHistory => {
    reads++;
    return {
      kind: "session_mail_history",
      version: 1,
      project: "/projects/a",
      sessionId: "owner",
      generatedAt: reads,
      messages: [],
    };
  };
  const poll = mailHistoryPoller("/projects/a", "owner", history, () => stamp);
  expect(poll()?.generatedAt).toBe(1);
  for (let tick = 0; tick < 5; tick++) expect(poll()).toBeUndefined();
  expect(reads).toBe(1);
  stamp = "b";
  expect(poll()?.generatedAt).toBe(2);
  expect(poll()).toBeUndefined();
  expect(reads).toBe(2);
});

test("history input stamps change on a spool or receipt append and not otherwise", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-mail-stamps-")));
  roots.push(root);
  const home = join(root, "home");
  const state = join(home, ".claude", "agent-mail");
  for (const name of ["inbox", "receipts"])
    mkdirSync(join(state, name), { recursive: true });
  const code = `
    import { appendFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { mailHistoryInputs } from ${JSON.stringify(join(import.meta.dir, "mailHistory.ts"))};
    const state = ${JSON.stringify(state)};
    const inbox = join(state, "inbox", "p.jsonl");
    const receipts = join(state, "receipts", "p.jsonl");
    writeFileSync(inbox, "{}\\n");
    writeFileSync(receipts, "{}\\n");
    const a = mailHistoryInputs();
    const b = mailHistoryInputs();
    appendFileSync(inbox, "{}\\n");
    const c = mailHistoryInputs();
    appendFileSync(receipts, "{}\\n");
    const d = mailHistoryInputs();
    writeFileSync(join(state, "unrelated.json"), "{}");
    const e = mailHistoryInputs();
    console.log(JSON.stringify([a === b, b === c, c === d, d === e]));
  `;
  const result = spawnSync(process.execPath, ["-e", code], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual([true, false, false, true]);
});
