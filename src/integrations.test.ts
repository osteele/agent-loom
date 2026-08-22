import { expect, test } from "bun:test";
import {
  addNativeAuditHook,
  addReminderHookCodex,
  addReminderHookGemini,
  addReminderHookKimi,
  claudeRegistrationMatches,
  codexRegistrationMatches,
  codexReminderHookEvents,
  enabledAgentMailPlugin,
  geminiReminderHookEvents,
  removeNativeAuditHook,
  removeOpenCodeMcpRegistration,
  removeReminderHookCodex,
  removeReminderHookGemini,
  removeReminderHookKimi,
  removeStdioMcpRegistration,
  stdioRegistrationMatches,
  upsertOpenCodeMcpRegistration,
  upsertStdioMcpRegistration,
} from "./integrations.ts";

const bun = "/opt/bun/bin/bun";
const audit = "/code/agent-mail/src/nativeAudit.ts";
const remindBase = `${bun} /code/agent-mail/src/cli.ts remind --format`;

test("native audit hook installation is additive and idempotent", () => {
  const initial = {
    hooks: {
      PostToolUse: [
        {
          matcher: "Edit",
          hooks: [{ type: "command", command: "lint" }],
        },
      ],
    },
  };
  const first = addNativeAuditHook(initial, bun, audit);
  expect(first.changed).toBe(true);
  expect(
    (first.document.hooks as { PostToolUse: unknown[] }).PostToolUse,
  ).toHaveLength(2);
  const second = addNativeAuditHook(first.document, bun, audit);
  expect(second.changed).toBe(false);
  expect(
    (second.document.hooks as { PostToolUse: unknown[] }).PostToolUse,
  ).toHaveLength(2);
});

test("native audit hook removal preserves unrelated handlers", () => {
  const installed = addNativeAuditHook({}, bun, audit).document;
  const hooks = installed.hooks as { PostToolUse: unknown[] };
  hooks.PostToolUse.push({
    matcher: "SendMessage",
    hooks: [{ type: "command", command: "other-audit" }],
  });
  const result = removeNativeAuditHook(installed, audit);
  expect(result.changed).toBe(true);
  expect(
    (result.document.hooks as { PostToolUse: unknown[] }).PostToolUse,
  ).toEqual([
    {
      matcher: "SendMessage",
      hooks: [{ type: "command", command: "other-audit" }],
    },
  ]);
});

test("Codex registration matching requires the exact stdio command", () => {
  const registration = {
    transport: { type: "stdio", command: bun, args: ["/code/channel.ts"] },
  };
  expect(codexRegistrationMatches(registration, bun, "/code/channel.ts")).toBe(
    true,
  );
  expect(codexRegistrationMatches(registration, bun, "/other/channel.ts")).toBe(
    false,
  );
});

test("Claude registration matching requires the exact stdio command", () => {
  const registration = {
    type: "stdio",
    command: bun,
    args: ["/code/channel.ts"],
    env: {},
  };
  expect(claudeRegistrationMatches(registration, bun, "/code/channel.ts")).toBe(
    true,
  );
  expect(
    claudeRegistrationMatches(registration, bun, "/other/channel.ts"),
  ).toBe(false);
});

test("an enabled agent-mail plugin is found under any marketplace", () => {
  expect(
    enabledAgentMailPlugin({
      enabledPlugins: { "other@mkt": true, "agent-mail@osteele-local": true },
    }),
  ).toBe("agent-mail@osteele-local");
});

test("a disabled or absent agent-mail plugin does not count", () => {
  expect(
    enabledAgentMailPlugin({ enabledPlugins: { "agent-mail@mkt": false } }),
  ).toBeUndefined();
  expect(enabledAgentMailPlugin({ enabledPlugins: {} })).toBeUndefined();
  expect(enabledAgentMailPlugin({})).toBeUndefined();
  expect(enabledAgentMailPlugin(undefined)).toBeUndefined();
});

test("a plugin whose name merely starts with agent-mail does not count", () => {
  expect(
    enabledAgentMailPlugin({ enabledPlugins: { "agent-mailer@mkt": true } }),
  ).toBeUndefined();
});

// --- JSON MCP registrations (Kimi and Gemini) --------------------------------

test("standard stdio registration matching is exact", () => {
  const registration = { command: bun, args: [audit] };
  expect(stdioRegistrationMatches(registration, bun, audit)).toBe(true);
  expect(stdioRegistrationMatches(registration, bun, `${audit}.old`)).toBe(
    false,
  );
  expect(
    stdioRegistrationMatches(
      { command: bun, args: [audit, "extra"] },
      bun,
      audit,
    ),
  ).toBe(false);
});

test("standard MCP registration add preserves neighboring settings", () => {
  const initial = {
    theme: "dark",
    mcpServers: { lore: { command: "lore", args: ["mcp"] } },
  };
  const result = upsertStdioMcpRegistration(initial, bun, audit, false);
  expect(result.status).toBe("added");
  expect(result.document).toEqual({
    theme: "dark",
    mcpServers: {
      lore: { command: "lore", args: ["mcp"] },
      "agent-mail": { command: bun, args: [audit] },
    },
  });
  expect(initial).toEqual({
    theme: "dark",
    mcpServers: { lore: { command: "lore", args: ["mcp"] } },
  });
});

test("standard MCP registration preserves conflicts unless replacement is explicit", () => {
  const initial = {
    mcpServers: {
      "agent-mail": { command: "/other/node", args: ["/other/channel.js"] },
    },
  };
  const conflict = upsertStdioMcpRegistration(initial, bun, audit, false);
  expect(conflict.status).toBe("conflict");
  expect(conflict.document).toEqual(initial);

  const replaced = upsertStdioMcpRegistration(initial, bun, audit, true);
  expect(replaced.status).toBe("replaced");
  expect(replaced.document).toEqual({
    mcpServers: { "agent-mail": { command: bun, args: [audit] } },
  });
  expect(
    upsertStdioMcpRegistration(replaced.document, bun, audit, false).status,
  ).toBe("matching");
});

test("standard MCP registration rejects a malformed server map", () => {
  expect(() =>
    upsertStdioMcpRegistration({ mcpServers: [] }, bun, audit, false),
  ).toThrow("mcpServers must be an object");
});

test("standard MCP removal removes owned entries and preserves foreign ones", () => {
  const owned = {
    mcpServers: {
      "agent-mail": { command: bun, args: [audit] },
      lore: { command: "lore", args: ["mcp"] },
    },
  };
  const removed = removeStdioMcpRegistration(owned, bun, audit);
  expect(removed.status).toBe("removed");
  expect(removed.document).toEqual({
    mcpServers: { lore: { command: "lore", args: ["mcp"] } },
  });

  const foreign = {
    mcpServers: {
      "agent-mail": { command: "/other/node", args: ["/other/channel.js"] },
    },
  };
  expect(removeStdioMcpRegistration(foreign, bun, audit)).toEqual({
    document: foreign,
    status: "foreign",
  });
});

test("OpenCode registration supports and preserves the 1.x schema", () => {
  const initial = {
    theme: "dark",
    mcp: { lore: { type: "local", command: ["lore", "mcp"] } },
  };
  const added = upsertOpenCodeMcpRegistration(initial, bun, audit, false);
  expect(added.status).toBe("added");
  expect(added.path).toEqual(["mcp", "agent-mail"]);
  expect(added.document).toEqual({
    theme: "dark",
    mcp: {
      lore: { type: "local", command: ["lore", "mcp"] },
      "agent-mail": {
        type: "local",
        command: [bun, audit],
        enabled: true,
      },
    },
  });
  expect(removeOpenCodeMcpRegistration(added.document, bun, audit).status).toBe(
    "removed",
  );
});

test("OpenCode registration supports the 2.x schema and respects conflicts", () => {
  const initial = {
    mcp: {
      disabled: false,
      servers: {
        "agent-mail": { type: "local", command: ["other", "server"] },
      },
    },
  };
  const conflict = upsertOpenCodeMcpRegistration(initial, bun, audit, false);
  expect(conflict.status).toBe("conflict");
  expect(conflict.path).toEqual(["mcp", "servers", "agent-mail"]);

  const replaced = upsertOpenCodeMcpRegistration(initial, bun, audit, true);
  expect(replaced.status).toBe("replaced");
  expect(replaced.document).toEqual({
    mcp: {
      disabled: false,
      servers: {
        "agent-mail": {
          type: "local",
          command: [bun, audit],
          disabled: false,
        },
      },
    },
  });
  expect(removeOpenCodeMcpRegistration(initial, bun, audit).status).toBe(
    "foreign",
  );
});

test("OpenCode registration rejects malformed schema containers", () => {
  expect(() =>
    upsertOpenCodeMcpRegistration({ mcp: [] }, bun, audit, false),
  ).toThrow("mcp must be an object");
  expect(() =>
    upsertOpenCodeMcpRegistration({ mcp: { servers: [] } }, bun, audit, false),
  ).toThrow("mcp.servers must be an object");
});

// --- reminder hooks (pull-only harnesses) -------------------------------------

test("codex reminder hook adds both event groups to an empty document", () => {
  const result = addReminderHookCodex({}, `${remindBase} codex`);
  expect(result.changed).toBe(true);
  expect(result.document).toEqual({
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: `${remindBase} codex --event UserPromptSubmit`,
              timeout: 5,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            {
              type: "command",
              command: `${remindBase} codex --event PostToolUse`,
              timeout: 30,
              async: true,
            },
          ],
        },
      ],
    },
  });
});

test("codex reminder hook re-add is a no-op", () => {
  const first = addReminderHookCodex({}, `${remindBase} codex`);
  const second = addReminderHookCodex(first.document, `${remindBase} codex`);
  expect(second.changed).toBe(false);
  expect(second.document).toEqual(first.document);
});

test("codex reminder hook removal preserves neighbor hooks", () => {
  const initial = {
    description: "codex hooks",
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "other-tool" }] },
      ],
      PreToolUse: [{ hooks: [{ type: "command", command: "guard" }] }],
    },
  };
  const installed = addReminderHookCodex(initial, `${remindBase} codex`);
  expect(installed.changed).toBe(true);
  const removed = removeReminderHookCodex(
    installed.document,
    `${remindBase} codex`,
  );
  expect(removed.changed).toBe(true);
  expect(removed.document).toEqual({
    description: "codex hooks",
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "other-tool" }] },
      ],
      PreToolUse: [{ hooks: [{ type: "command", command: "guard" }] }],
      PostToolUse: [],
    },
  });
  // Removal from a document without the hook is a no-op.
  const absent = removeReminderHookCodex(initial, `${remindBase} codex`);
  expect(absent.changed).toBe(false);
  expect(absent.document).toEqual(initial);
});

test("codex reminder hook events report what is installed", () => {
  expect(codexReminderHookEvents({}, `${remindBase} codex`)).toEqual([]);
  const installed = addReminderHookCodex({}, `${remindBase} codex`).document;
  expect(codexReminderHookEvents(installed, `${remindBase} codex`)).toEqual([
    "UserPromptSubmit",
    "PostToolUse",
  ]);
});

test("gemini reminder hook adds BeforeAgent only by default", () => {
  const result = addReminderHookGemini({}, `${remindBase} gemini`, {
    afterTool: false,
  });
  expect(result.changed).toBe(true);
  expect(result.document).toEqual({
    hooks: {
      BeforeAgent: [
        {
          hooks: [
            {
              name: "agent-mail-remind",
              type: "command",
              command: `${remindBase} gemini --event BeforeAgent`,
              timeout: 5000,
            },
          ],
        },
      ],
    },
  });
});

test("gemini reminder hook adds AfterTool when opted in", () => {
  const result = addReminderHookGemini({}, `${remindBase} gemini`, {
    afterTool: true,
  });
  expect(result.changed).toBe(true);
  const hooks = result.document.hooks as Record<string, unknown[]>;
  expect(hooks.AfterTool).toEqual([
    {
      matcher: "*",
      hooks: [
        {
          name: "agent-mail-remind",
          type: "command",
          command: `${remindBase} gemini --event AfterTool`,
          timeout: 5000,
        },
      ],
    },
  ]);
});

test("gemini reminder hook re-add is a no-op", () => {
  const first = addReminderHookGemini({}, `${remindBase} gemini`, {
    afterTool: true,
  });
  const second = addReminderHookGemini(first.document, `${remindBase} gemini`, {
    afterTool: true,
  });
  expect(second.changed).toBe(false);
  expect(second.document).toEqual(first.document);
});

test("gemini reminder hook removal preserves neighbor hooks", () => {
  const initial = {
    theme: "dark",
    hooks: {
      BeforeAgent: [
        { hooks: [{ name: "other", type: "command", command: "other-tool" }] },
      ],
    },
  };
  const installed = addReminderHookGemini(initial, `${remindBase} gemini`, {
    afterTool: true,
  });
  const removed = removeReminderHookGemini(
    installed.document,
    `${remindBase} gemini`,
  );
  expect(removed.changed).toBe(true);
  expect(removed.document).toEqual({
    theme: "dark",
    hooks: {
      BeforeAgent: [
        { hooks: [{ name: "other", type: "command", command: "other-tool" }] },
      ],
      AfterTool: [],
    },
  });
  const absent = removeReminderHookGemini(initial, `${remindBase} gemini`);
  expect(absent.changed).toBe(false);
  expect(absent.document).toEqual(initial);
});

test("gemini reminder hook events report what is installed", () => {
  expect(geminiReminderHookEvents({}, `${remindBase} gemini`)).toEqual([]);
  const installed = addReminderHookGemini({}, `${remindBase} gemini`, {
    afterTool: false,
  }).document;
  expect(geminiReminderHookEvents(installed, `${remindBase} gemini`)).toEqual([
    "BeforeAgent",
  ]);
});

test("kimi reminder hook appends a marked block at EOF", () => {
  const result = addReminderHookKimi(
    "",
    `${remindBase} kimi --event UserPromptSubmit`,
  );
  expect(result.changed).toBe(true);
  expect(result.document).toBe(
    [
      "# agent-mail-remind-begin",
      "[[hooks]]",
      'event = "UserPromptSubmit"',
      `command = "${remindBase} kimi --event UserPromptSubmit"`,
      "timeout = 5",
      "# agent-mail-remind-end",
      "",
    ].join("\n"),
  );
});

test("kimi reminder hook appends cleanly after another table section", () => {
  // A config ending mid-table (no trailing newline) must still produce valid
  // TOML: the new [[hooks]] header starts its own table.
  const existing = '[mcp_servers.agent-mail]\ncommand = "bun"';
  const result = addReminderHookKimi(
    existing,
    `${remindBase} kimi --event UserPromptSubmit`,
  );
  expect(result.changed).toBe(true);
  expect(result.document.startsWith(`${existing}\n`)).toBe(true);
  expect(result.document).toContain(
    '# agent-mail-remind-begin\n[[hooks]]\nevent = "UserPromptSubmit"',
  );
});

test("kimi reminder hook re-add is a no-op", () => {
  const first = addReminderHookKimi(
    "# existing\n",
    `${remindBase} kimi --event UserPromptSubmit`,
  );
  const second = addReminderHookKimi(
    first.document,
    `${remindBase} kimi --event UserPromptSubmit`,
  );
  expect(second.changed).toBe(false);
  expect(second.document).toBe(first.document);
});

test("kimi reminder hook removal strips exactly the marked region", () => {
  const head = "# my config\ntimeout = 10\n";
  const tail = "[other]\nkey = 1\n";
  const installed = addReminderHookKimi(
    `${head}\n`,
    `${remindBase} kimi --event UserPromptSubmit`,
  ).document;
  const withTail = installed + tail;
  const result = removeReminderHookKimi(withTail);
  expect(result.changed).toBe(true);
  expect(result.document).toBe(`${head}\n${tail}`);
});

test("kimi reminder hook removal is a no-op when the block is absent", () => {
  const text = "[other]\nkey = 1\n";
  const result = removeReminderHookKimi(text);
  expect(result.changed).toBe(false);
  expect(result.document).toBe(text);
});
