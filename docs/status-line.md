# Status line reference

`agent-mail status-line` prints the current session's display name. The
[README](../README.md#status-lines) shows the Claude Code and Kimi Code setup;
this page specifies identity resolution, `--fields`, and each client's
rendering constraints.

The display name prints whether or not anyone else is in the project and can be
used as an address when it is unique there. The full name and session ID from
`list_sessions` disambiguate collisions. The command prints nothing when it
cannot resolve a session ID, and when it can resolve one but cannot tell which
registration is its own (see below).

## Project and session resolution

The command resolves the project in this order:

1. `--project`
2. `workspace.project_dir` in the JSON payload
3. `workspace.current_dir` in the JSON payload
4. `cwd` in the JSON payload
5. the command's working directory

It resolves the session in this order:

1. `--session`
2. `session_id` in the JSON payload
3. `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, then `AGENT_SESSION_ID`

Claude Code supplies `session_id` and a workspace path in its payload. Kimi
supplies `cwd`, while a launcher supplies `AGENT_SESSION_ID`. Kimi's native
`sessionId` is deliberately ignored: it belongs to a different namespace from
the identity inherited by the agent-mail MCP process. Treating the two as the
same would display a plausible but incorrect address.

The resolved ID is then reconciled against the registry, because the two can
drift. Claude Code injects `CLAUDE_CODE_SESSION_ID` into an MCP server's spawn
environment and never updates it, but mints a new session ID on `/clear` without
respawning MCP servers. From then on the channel server is registered under the
old ID while the payload carries the new one. Since the name is the address,
naming the payload ID would advertise an identity that exists in no registry and
that peers cannot deliver to.

So the command reports the ID the session is registered and addressable under:

1. the registration whose session ID matches, if there is one;
2. otherwise the registration spawned by the same host agent process, which the
   status-line process and the channel server share as a parent;
3. otherwise nothing, unless no registration exists at all — with nothing to
   contradict, the resolved ID stands.

Every `--fields` value keys off that address, not the payload ID, so a rotated
session cannot report another session's unread count or weft jobs. An empty
name where one is expected means the session could not be identified in its own
project; restarting it re-syncs the two IDs.

## `--fields`

`--fields` prints one tab-separated line carrying the name, peer count, unread
messages, whether mail reaches this session on its own, and unprocessed weft
jobs this session submitted. A status line can show all five from one
invocation instead of reimplementing agent-mail's registry and spool semantics
in shell:

```
Quiet Lantern\t2\t0\tpush\t3
Quiet Lantern\t2\t3\tpull\t0
Quiet Lantern\t0\t0\tunknown\t
```

Fields are only ever appended. A consuming script splits positionally, so
inserting one would silently mislabel every field after it. Empty fields are
significant; use a non-whitespace separator when parsing them in shell. The
[Kimi example](../examples/status-lines/kimi.sh) replaces tabs with an ASCII
unit separator before calling `read`.

### The push/pull field

The fourth field is `push` when channel push is expected to land, `pull` when it
is not, `unknown` when the session is registered but carries no diagnosis, and
empty when no session is registered to ask about. There are two unrelated ways
to be pulling. A client other than Claude Code has no channel, so Codex, Kimi,
and OpenCode sessions are pull-only. A Claude Code session can also hold a
channel it cannot use because its host was launched without the channel or
under an identity the host will not authorize.

`agent-mail status` distinguishes those causes. Both require the reader to
check mail instead of waiting for a push. A session cannot diagnose this from
its own successful sends.

### The weft-jobs field

The fifth field counts unprocessed weft jobs whose submitter session is this
one. It is read from a snapshot the daemon refreshes every 60 seconds
(`~/.claude/agent-mail/weft-jobs.json`), never by running weft on the status-line
path. The field is empty when no usable snapshot exists, which covers a stopped
daemon, a snapshot older than three minutes, and a weft installation that has
never run. Empty and `0` are different claims: `0` says weft was checked and
this session has nothing pending.

## Shared script rules

- Guard on `command -v agent-mail`. A global status-line script also runs in
  projects where agent-mail may not be installed.
- Redirect stderr. `--debug` reports the resolved project, session ID, and peer
  recency there; ordinary status lines should not render it.
- Keep one `agent-mail status-line --fields` call. Separate calls repeat process
  startup and can observe different snapshots.
- The command always exits 0, including on errors. Empty output means there is
  nothing to show.
- Keep the path fast. `status-line` reads the daemon's presence snapshot and
  scans the project spool for unread messages. With the daemon stopped, a
  project-scoped process scan replaces the snapshot read.

## Claude Code adapter

Claude Code pipes its
[statusLine](https://code.claude.com/docs/en/statusline) payload to the command.
The payload carries both the project path and native session ID, so no launcher
identity bridge is required.

Claude Code can render several stdout lines. Give identity and alarms a short
first row, then put expendable telemetry on a second row. A single long line is
truncated from the right in a split pane.

Claude Code sets `COLUMNS` and `LINES` before each run. `COLUMNS` tracks the
pane width; `tput cols` cannot work because the script's output is captured
instead of connected to the terminal. `LINES` is the terminal height, not a
row allowance. Every status row takes one row from the transcript.

Claude Code cancels a status-line command when the next update arrives. A
canceled script drops the whole result, so it should finish well within the
roughly 300 ms update interval.

## Kimi Code adapter

Kimi Code passes a JSON snapshot whose `cwd` selects the agent-mail project.
The checked-in [Kimi formatter](../examples/status-lines/kimi.sh) passes that
snapshot to one `agent-mail status-line --fields` call and renders the
agent-mail fields on Kimi's first footer row.

The formatter requires the same `AGENT_SESSION_ID` that the agent-mail MCP
process inherited when Kimi started. A launcher should mint a fresh value for
each Kimi invocation and clear any parent agent's native session variables
before starting the child. The formatter omits agent-mail fields when that
identity is unavailable.

Kimi renders only the first stdout line. It runs the command at most once per
second, caps each run at 300 ms, and falls back to the built-in footer after a
failure or timeout. The example therefore avoids a second formatter process;
measure changes before adding filesystem or process scans.

## Clients without an external command slot

OpenCode, Codex, and Gemini can host the agent-mail MCP server, but their native
footers do not currently accept an external command or custom agent-mail field.
Gemini and Codex can display their own session identifiers. Those built-in
identifiers do not expose the agent-mail display name, peer count, unread
messages, delivery mode, or weft jobs.
