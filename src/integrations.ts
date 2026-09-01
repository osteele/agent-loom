/** Pure configuration transforms for host integrations. */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNativeAuditHandler(value: unknown, scriptPath: string): boolean {
  if (!isObject(value) || value.type !== "command") return false;
  const args = Array.isArray(value.args) ? value.args : [];
  return (
    args.includes(scriptPath) ||
    (typeof value.command === "string" && value.command.includes(scriptPath))
  );
}

/** Add the optional SendMessage audit hook without disturbing other hooks. */
export function addNativeAuditHook(
  document: Record<string, unknown>,
  command: string,
  scriptPath: string,
): { document: Record<string, unknown>; changed: boolean } {
  const output = structuredClone(document);
  const hooks = isObject(output.hooks) ? output.hooks : {};
  const postToolUse = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  for (const group of postToolUse) {
    if (!isObject(group) || !Array.isArray(group.hooks)) continue;
    if (
      group.hooks.some((handler) => isNativeAuditHandler(handler, scriptPath))
    ) {
      return { document: output, changed: false };
    }
  }
  postToolUse.push({
    matcher: "SendMessage",
    hooks: [
      {
        type: "command",
        command,
        args: [scriptPath],
        timeout: 10,
      },
    ],
  });
  hooks.PostToolUse = postToolUse;
  output.hooks = hooks;
  return { document: output, changed: true };
}

/** Remove only handlers installed by agent-mail, retaining neighboring hooks. */
export function removeNativeAuditHook(
  document: Record<string, unknown>,
  scriptPath: string,
): { document: Record<string, unknown>; changed: boolean } {
  const output = structuredClone(document);
  if (!isObject(output.hooks) || !Array.isArray(output.hooks.PostToolUse)) {
    return { document: output, changed: false };
  }
  let changed = false;
  const groups: unknown[] = [];
  for (const group of output.hooks.PostToolUse) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      groups.push(group);
      continue;
    }
    const handlers = group.hooks.filter((handler) => {
      const remove = isNativeAuditHandler(handler, scriptPath);
      if (remove) changed = true;
      return !remove;
    });
    if (handlers.length > 0) groups.push({ ...group, hooks: handlers });
  }
  output.hooks.PostToolUse = groups;
  return { document: output, changed };
}

// --- reminder hooks (pull-only harnesses) -------------------------------------
//
// Codex, Kimi, and Gemini never learn about unread mail unless they ask, so
// `agent-mail hooks install` registers harness hooks that run `agent-mail
// remind` on turn activity and, where supported, Stop. Every transform keys on the command string (the hook's
// routing identity), preserves neighbor hooks, and returns {document, changed}
// like the native-audit transforms above.

/** Match a hook handler installed by `agent-mail hooks install`. */
function isReminderHookHandler(value: unknown, command: string): boolean {
  if (!isObject(value) || value.type !== "command") return false;
  return typeof value.command === "string" && value.command.includes(command);
}

function eventHasReminderHook(
  document: Record<string, unknown>,
  event: string,
  command: string,
): boolean {
  if (!isObject(document.hooks)) return false;
  const groups = document.hooks[event];
  if (!Array.isArray(groups)) return false;
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) continue;
    if (
      group.hooks.some((handler) => isReminderHookHandler(handler, command))
    ) {
      return true;
    }
  }
  return false;
}

/** Append one group to an event's group list, preserving neighbors. */
function addReminderGroup(
  output: Record<string, unknown>,
  hooks: Record<string, unknown>,
  event: string,
  group: Record<string, unknown>,
): void {
  const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
  groups.push(group);
  hooks[event] = groups;
  output.hooks = hooks;
}

/** Drop reminder handlers from each event's groups; empty groups go with them. */
function removeReminderHandlers(
  output: Record<string, unknown>,
  events: readonly string[],
  command: string,
): boolean {
  if (!isObject(output.hooks)) return false;
  let changed = false;
  for (const event of events) {
    const groups = output.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const handlers = group.hooks.filter((handler) => {
        const remove = isReminderHookHandler(handler, command);
        if (remove) changed = true;
        return !remove;
      });
      if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
    }
    output.hooks[event] = kept;
  }
  return changed;
}

/** Codex events the reminder hook is installed under, in install order. */
export const CODEX_REMINDER_EVENTS = [
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
] as const;

/** Add the Codex reminder hooks to a hooks.json document.
 *
 * `command` is the base command (`<runtime> <cli> remind --format codex`); the
 * per-event handler appends `--event <name>`. PostToolUse runs `async` so the
 * hook never blocks the tool call — Codex delivers its additionalContext at
 * the next safe point instead. Stop is synchronous because exit 2 is the
 * documented continuation signal. */
export function addReminderHookCodex(
  document: Record<string, unknown>,
  command: string,
): { document: Record<string, unknown>; changed: boolean } {
  const output = structuredClone(document);
  const hooks = isObject(output.hooks) ? output.hooks : {};
  let changed = false;
  for (const event of CODEX_REMINDER_EVENTS) {
    if (eventHasReminderHook(output, event, command)) continue;
    const handler: Record<string, unknown> = {
      type: "command",
      command: `${command} --event ${event}`,
      timeout: event === "PostToolUse" ? 30 : 5,
    };
    if (event === "PostToolUse") handler.async = true;
    addReminderGroup(output, hooks, event, { hooks: [handler] });
    changed = true;
  }
  return { document: output, changed };
}

/** Remove only the Codex reminder handlers, retaining neighboring hooks. */
export function removeReminderHookCodex(
  document: Record<string, unknown>,
  command: string,
): { document: Record<string, unknown>; changed: boolean } {
  const output = structuredClone(document);
  const changed = removeReminderHandlers(
    output,
    CODEX_REMINDER_EVENTS,
    command,
  );
  return { document: output, changed };
}

/** The Codex events with an installed reminder hook (for `hooks status`). */
export function codexReminderHookEvents(
  document: Record<string, unknown>,
  command: string,
): string[] {
  return CODEX_REMINDER_EVENTS.filter((event) =>
    eventHasReminderHook(document, event, command),
  );
}

/** Gemini events the reminder hook can be installed under. */
export const GEMINI_REMINDER_EVENTS = ["BeforeAgent", "AfterTool"] as const;

/** Add the Gemini reminder hook(s) to a settings.json document.
 *
 * `command` is the base command (`<runtime> <cli> remind --format gemini`).
 * Timeouts are milliseconds — Gemini's hook config uses ms, unlike Codex's
 * seconds. AfterTool installs only when `afterTool` is set: Gemini hooks are
 * synchronous, so a per-tool-call spawn is a hot-path cost that stays opt-in.
 * Add is purely additive; an AfterTool hook from an earlier opt-in install is
 * left alone here and removed by `removeReminderHookGemini`. */
export function addReminderHookGemini(
  document: Record<string, unknown>,
  command: string,
  options: { afterTool: boolean },
): { document: Record<string, unknown>; changed: boolean } {
  const output = structuredClone(document);
  const hooks = isObject(output.hooks) ? output.hooks : {};
  let changed = false;
  if (!eventHasReminderHook(output, "BeforeAgent", command)) {
    addReminderGroup(output, hooks, "BeforeAgent", {
      hooks: [
        {
          name: "agent-mail-remind",
          type: "command",
          command: `${command} --event BeforeAgent`,
          timeout: 5000,
        },
      ],
    });
    changed = true;
  }
  if (
    options.afterTool &&
    !eventHasReminderHook(output, "AfterTool", command)
  ) {
    addReminderGroup(output, hooks, "AfterTool", {
      matcher: "*",
      hooks: [
        {
          name: "agent-mail-remind",
          type: "command",
          command: `${command} --event AfterTool`,
          timeout: 5000,
        },
      ],
    });
    changed = true;
  }
  return { document: output, changed };
}

/** Remove only the Gemini reminder handlers, retaining neighboring hooks. */
export function removeReminderHookGemini(
  document: Record<string, unknown>,
  command: string,
): { document: Record<string, unknown>; changed: boolean } {
  const output = structuredClone(document);
  const changed = removeReminderHandlers(
    output,
    GEMINI_REMINDER_EVENTS,
    command,
  );
  return { document: output, changed };
}

/** The Gemini events with an installed reminder hook (for `hooks status`). */
export function geminiReminderHookEvents(
  document: Record<string, unknown>,
  command: string,
): string[] {
  return GEMINI_REMINDER_EVENTS.filter((event) =>
    eventHasReminderHook(document, event, command),
  );
}

/** Markers delimiting the agent-mail block in ~/.kimi-code/config.toml. */
export const KIMI_REMIND_BEGIN_MARKER = "# agent-mail-remind-begin";
export const KIMI_REMIND_END_MARKER = "# agent-mail-remind-end";
export const KIMI_REMINDER_EVENTS = ["UserPromptSubmit", "Stop"] as const;

function kimiReminderBlock(command: string): string {
  const hookLines = KIMI_REMINDER_EVENTS.flatMap((event, index) => {
    const eventCommand = `${command} --event ${event}`;
    const escaped = eventCommand
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"');
    return [
      ...(index === 0 ? [] : [""]),
      "[[hooks]]",
      `event = "${event}"`,
      `command = "${escaped}"`,
      "timeout = 5",
    ];
  });
  return [
    KIMI_REMIND_BEGIN_MARKER,
    ...hookLines,
    KIMI_REMIND_END_MARKER,
    "",
  ].join("\n");
}

/** Events present inside agent-mail's owned Kimi marker block. */
export function kimiReminderHookEvents(text: string): string[] {
  const begin = text.indexOf(KIMI_REMIND_BEGIN_MARKER);
  if (begin === -1) return [];
  const endMarker = text.indexOf(KIMI_REMIND_END_MARKER, begin);
  const block = text.slice(begin, endMarker === -1 ? text.length : endMarker);
  return KIMI_REMINDER_EVENTS.filter((event) =>
    block.includes(`event = "${event}"`),
  );
}

/** Append the Kimi reminder hook block to config.toml text.
 *
 * No TOML writer exists in-repo, and none is needed: a `[[hooks]]` table
 * appended at EOF is always valid TOML, whatever section the existing file
 * ends inside. The marker comments make removal exact and re-add a no-op. */
export function addReminderHookKimi(
  text: string,
  command: string,
): { document: string; changed: boolean } {
  const block = kimiReminderBlock(command);
  const begin = text.indexOf(KIMI_REMIND_BEGIN_MARKER);
  if (begin !== -1) {
    const endMarker = text.indexOf(KIMI_REMIND_END_MARKER, begin);
    let end =
      endMarker === -1
        ? text.length
        : endMarker + KIMI_REMIND_END_MARKER.length;
    if (text[end] === "\n") end += 1;
    const document = text.slice(0, begin) + block + text.slice(end);
    return { document, changed: document !== text };
  }
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  return { document: `${text}${separator}${block}`, changed: true };
}

/** Strip exactly the marked reminder block; a no-op when it is absent. */
export function removeReminderHookKimi(text: string): {
  document: string;
  changed: boolean;
} {
  const begin = text.indexOf(KIMI_REMIND_BEGIN_MARKER);
  if (begin === -1) return { document: text, changed: false };
  const endMarker = text.indexOf(KIMI_REMIND_END_MARKER, begin);
  if (endMarker === -1) {
    // Unterminated block (hand edit?): strip from the begin marker to EOF.
    return { document: text.slice(0, begin), changed: true };
  }
  let end = endMarker + KIMI_REMIND_END_MARKER.length;
  if (text[end] === "\n") end += 1;
  return { document: text.slice(0, begin) + text.slice(end), changed: true };
}

/** Whether `codex mcp get --json` describes this checkout's server. */
export function codexRegistrationMatches(
  value: unknown,
  command: string,
  channelPath: string,
): boolean {
  if (!isObject(value) || !isObject(value.transport)) return false;
  const transport = value.transport;
  return (
    transport.type === "stdio" &&
    transport.command === command &&
    Array.isArray(transport.args) &&
    transport.args.length === 1 &&
    transport.args[0] === channelPath
  );
}

/** Whether a standard JSON `mcpServers` stdio entry belongs to this checkout.
 *
 * Kimi Code and Gemini CLI both use this shape. Neither requires Claude's
 * additional `type: "stdio"` field. */
export function stdioRegistrationMatches(
  value: unknown,
  command: string,
  channelPath: string,
): boolean {
  if (!isObject(value)) return false;
  return (
    value.command === command &&
    Array.isArray(value.args) &&
    value.args.length === 1 &&
    value.args[0] === channelPath
  );
}

export type McpRegistrationUpdateStatus =
  | "added"
  | "replaced"
  | "matching"
  | "conflict";

/** Add or inspect an agent-mail entry in a standard JSON `mcpServers` map.
 * Neighboring servers and top-level client settings are preserved. */
export function upsertStdioMcpRegistration(
  document: Record<string, unknown>,
  command: string,
  channelPath: string,
  replace: boolean,
): {
  document: Record<string, unknown>;
  status: McpRegistrationUpdateStatus;
} {
  const output = structuredClone(document);
  if (output.mcpServers !== undefined && !isObject(output.mcpServers)) {
    throw new TypeError("mcpServers must be an object");
  }
  const servers = isObject(output.mcpServers) ? output.mcpServers : {};
  const existing = servers["agent-mail"];
  if (stdioRegistrationMatches(existing, command, channelPath)) {
    return { document: output, status: "matching" };
  }
  if (existing !== undefined && !replace) {
    return { document: output, status: "conflict" };
  }
  servers["agent-mail"] = { command, args: [channelPath] };
  output.mcpServers = servers;
  return {
    document: output,
    status: existing === undefined ? "added" : "replaced",
  };
}

export type McpRegistrationRemovalStatus = "removed" | "absent" | "foreign";

/** Remove only an agent-mail registration owned by this checkout. */
export function removeStdioMcpRegistration(
  document: Record<string, unknown>,
  command: string,
  channelPath: string,
): {
  document: Record<string, unknown>;
  status: McpRegistrationRemovalStatus;
} {
  const output = structuredClone(document);
  if (output.mcpServers !== undefined && !isObject(output.mcpServers)) {
    throw new TypeError("mcpServers must be an object");
  }
  if (!isObject(output.mcpServers)) {
    return { document: output, status: "absent" };
  }
  const existing = output.mcpServers["agent-mail"];
  if (existing === undefined) return { document: output, status: "absent" };
  if (!stdioRegistrationMatches(existing, command, channelPath)) {
    return { document: output, status: "foreign" };
  }
  const { "agent-mail": _removed, ...rest } = output.mcpServers;
  output.mcpServers = rest;
  return { document: output, status: "removed" };
}

/** The OpenCode MCP server map path for the observed config schema.
 * OpenCode 1.x stores servers directly under `mcp`; 2.x nests them under
 * `mcp.servers` and uses `disabled` in place of `enabled`. */
export function openCodeMcpServersPath(
  document: Record<string, unknown>,
): readonly ["mcp"] | readonly ["mcp", "servers"] {
  if (document.mcp !== undefined && !isObject(document.mcp)) {
    throw new TypeError("mcp must be an object");
  }
  const mcp = isObject(document.mcp) ? document.mcp : {};
  if ("servers" in mcp || "disabled" in mcp) {
    if (mcp.servers !== undefined && !isObject(mcp.servers)) {
      throw new TypeError("mcp.servers must be an object");
    }
    return ["mcp", "servers"];
  }
  return ["mcp"];
}

function openCodeRegistrationOwned(
  value: unknown,
  command: string,
  channelPath: string,
): boolean {
  return (
    isObject(value) &&
    value.type === "local" &&
    Array.isArray(value.command) &&
    value.command.length === 2 &&
    value.command[0] === command &&
    value.command[1] === channelPath
  );
}

/** Add or inspect an OpenCode-local MCP registration across its 1.x and 2.x
 * config schemas. */
export function upsertOpenCodeMcpRegistration(
  document: Record<string, unknown>,
  command: string,
  channelPath: string,
  replace: boolean,
): {
  document: Record<string, unknown>;
  status: McpRegistrationUpdateStatus;
  path:
    | readonly ["mcp", "agent-mail"]
    | readonly ["mcp", "servers", "agent-mail"];
  value: Record<string, unknown>;
} {
  const output = structuredClone(document);
  const serversPath = openCodeMcpServersPath(output);
  const mcp = isObject(output.mcp) ? output.mcp : {};
  const servers =
    serversPath.length === 2 && isObject(mcp.servers) ? mcp.servers : mcp;
  const existing = servers["agent-mail"];
  const value: Record<string, unknown> = {
    type: "local",
    command: [command, channelPath],
    ...(serversPath.length === 2 ? { disabled: false } : { enabled: true }),
  };
  const owned = openCodeRegistrationOwned(existing, command, channelPath);
  const active =
    owned &&
    (serversPath.length === 2
      ? (existing as Record<string, unknown>).disabled !== true
      : (existing as Record<string, unknown>).enabled !== false);
  const path = [...serversPath, "agent-mail"] as
    | readonly ["mcp", "agent-mail"]
    | readonly ["mcp", "servers", "agent-mail"];
  if (active) return { document: output, status: "matching", path, value };
  if (existing !== undefined && !owned && !replace) {
    return { document: output, status: "conflict", path, value };
  }
  servers["agent-mail"] = value;
  if (serversPath.length === 2) {
    mcp.servers = servers;
  }
  output.mcp = mcp;
  return {
    document: output,
    status: existing === undefined ? "added" : "replaced",
    path,
    value,
  };
}

/** Remove an OpenCode registration only when this checkout owns it. */
export function removeOpenCodeMcpRegistration(
  document: Record<string, unknown>,
  command: string,
  channelPath: string,
): {
  document: Record<string, unknown>;
  status: McpRegistrationRemovalStatus;
  path:
    | readonly ["mcp", "agent-mail"]
    | readonly ["mcp", "servers", "agent-mail"];
} {
  const output = structuredClone(document);
  const serversPath = openCodeMcpServersPath(output);
  const mcp = isObject(output.mcp) ? output.mcp : {};
  const servers =
    serversPath.length === 2 && isObject(mcp.servers) ? mcp.servers : mcp;
  const path = [...serversPath, "agent-mail"] as
    | readonly ["mcp", "agent-mail"]
    | readonly ["mcp", "servers", "agent-mail"];
  const existing = servers["agent-mail"];
  if (existing === undefined)
    return { document: output, status: "absent", path };
  if (!openCodeRegistrationOwned(existing, command, channelPath)) {
    return { document: output, status: "foreign", path };
  }
  const { "agent-mail": _removed, ...rest } = servers;
  if (serversPath.length === 2) {
    mcp.servers = rest;
    output.mcp = mcp;
  } else {
    output.mcp = rest;
  }
  return { document: output, status: "removed", path };
}

/** The enabled `agent-mail@<marketplace>` plugin key, if any.
 *
 * A user-scope `mcpServers` entry and the plugin register the same server name,
 * so Claude dedupes them and the user-scope entry wins. That instance's channel
 * identity is `server:agent-mail`, which the channels allowlist does not cover,
 * so its pushes are dropped without an error. Installing the user-scope entry
 * alongside an enabled plugin therefore breaks push — check for the plugin
 * first. */
export function enabledAgentMailPlugin(settings: unknown): string | undefined {
  if (!isObject(settings)) return undefined;
  const plugins = settings.enabledPlugins;
  if (!isObject(plugins)) return undefined;
  return Object.keys(plugins).find(
    (key) => plugins[key] === true && key.split("@", 1)[0] === "agent-mail",
  );
}

/** Whether a Claude user-scope mcpServers entry belongs to this checkout. */
export function claudeRegistrationMatches(
  value: unknown,
  command: string,
  channelPath: string,
): boolean {
  if (!isObject(value)) return false;
  return (
    value.type === "stdio" &&
    value.command === command &&
    Array.isArray(value.args) &&
    value.args.length === 1 &&
    value.args[0] === channelPath
  );
}
