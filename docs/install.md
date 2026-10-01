# Installer behavior

How `agent-loom install` treats existing registrations, and the registration
conflict that can silently disable channel push. The
[README](../README.md#updating-and-restarting) covers the normal
install and update flow.

The installer is macOS-only because it provisions a launchd service.
`agent-loom install --dry-run` is available on every platform and prints the
runtime and entry points it would persist without changing anything.

## Client detection and existing entries

Claude Code and Codex are the installer's primary targets. Antigravity CLI,
Kimi Code, Gemini CLI, and OpenCode are also registered when their user config
directories (`~/.gemini/config`, `~/.kimi-code`, `~/.gemini`, and
`~/.config/opencode`) exist. The installer does not create those directories
merely to declare a client present.

The installer uses `codex mcp add` only when `codex mcp get --json` reports the
agent-loom entry missing. Other probe failures stop registration and preserve
the current config. A deliberate `--replace-codex` operation snapshots the
config before removal and restores the exact snapshot if the replacement add
fails.

Antigravity, Kimi, and Gemini entries merge into each client's documented
`mcpServers` map; OpenCode uses its JSONC-aware `mcp` map. Existing matching
entries are preserved. If a client already uses the name for a different
command, the installer reports the conflict and leaves it unchanged. Use
`--replace-claude`, `--replace-agy`, `--replace-codex`, `--replace-kimi`,
`--replace-gemini`, or `--replace-opencode` to replace one deliberately. Use
`--no-codex` to skip Codex registration.

Gemini's optional `mcp.allowed` and `mcp.excluded` lists remain user-owned. The
installer reports when either list would hide agent-loom, but does not broaden
an allowlist or override an exclusion.

## Plugin versus user-scope registration

A user-scope `mcpServers` entry and the plugin register the same server name,
and when both exist Claude keeps only the user-scope entry. That instance
pushes under the channel identity `server:agent-loom` rather than
`plugin:agent-loom@<marketplace>`, which the host has not authorized, so every
push is discarded without an error while tools and the CLI keep working. The
installer therefore does not write a user-scope entry when the plugin is
enabled in `~/.claude/settings.json`, and removes one that belongs to this
installation. If the entry points somewhere else, the installer reports it and
leaves it in place; remove it with `claude mcp remove agent-loom`. Restart
Claude sessions afterward.

Each session's MCP server log records this at startup when push cannot land,
naming the identity it would push under and the channels the host authorized.

## Reminder hooks for pull-only clients

The installed MCP server's initial instructions report mail already waiting
when a session starts. To announce mail that arrives later in pull-only
clients, install reminder hooks as a separate, platform-neutral step:

```bash
agent-loom hooks install [--agy] [--codex] [--kimi] [--gemini] [--gemini-after-tool]
```

With no harness flag, install applies to every harness whose config directory
exists. The edits are additive and removable (`agent-loom hooks uninstall`),
and `agent-loom hooks status` reports what is in place. Agy reads its global
hook file between invocations. Restart Codex, Kimi, and Gemini sessions after
installation. [reminders.md](reminders.md) covers what each harness gets and
how to verify it reaches the model, including bounded Stop continuation in
Agy, Codex, and Kimi.
