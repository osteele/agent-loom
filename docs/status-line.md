# Status line reference

`agent-mail status-line` prints the current session's display name. The
[README](../README.md#status-lines) shows the Claude Code and Kimi Code setup;
this page specifies identity resolution, `--json`, `--fields`, and each
client's rendering constraints.

The display name prints whether or not anyone else is in the project and can be
used as an address when it is unique there. The full name and session ID from
`list_sessions` disambiguate collisions. The command prints nothing when it
cannot resolve a session ID, when no channel server is registered for the
session, and when it cannot tell which registration is its own (see below). A
name is shown only for a session that mail can reach.

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
3. otherwise nothing.

The resolved ID is never used on its own. A session with no registration has no
channel server, so peers sending to it get "no live recipient"; a status line
that named it would report the session as reachable when it is not.

Every `--fields` value keys off that address, not the payload ID, so a rotated
session cannot report another session's unread count or weft jobs. An empty
name where one is expected means either that the session has no channel server
or that it could not be identified in its own project. `--debug` says which.
Restarting the session fixes both, by respawning its channel server.
`agent-mail logs --lifecycle` records when channel servers attach, shut down,
exit, and are pruned from the registry. A session whose server has vanished
shows there as an `attached` record followed by a `pruned` record with no
`shutdown` or `exit` between them.

## `--json`

`agent-mail status-line --json` prints the version-1
[SessionStatus document](http-api.md#session-status) with the resolved
`project`, `sessionId`, epoch-millisecond `generatedAt`, `name`, `nameNoun`,
`peers`, `unread`, `delivery`, `unprocessed`, `running`, and `work`.
Work is always present, independent of `--work`. No resolved identity prints
JSON `null`; collection errors print a diagnostic to stderr and exit nonzero.

`obligations` carries this session's open-wait summary: `waiting` counts
records the session is the obligee of, `owed` counts records naming it as
session obligor, `roleOwed` counts records whose obligor role resolves to
it, `unresolvedOwed` counts obligor roles that resolve to nothing, and
`humanOwed` carries the operator's global owed count. All are additive and
may be absent in older snapshots.

`nameNoun` is supplied by the naming model. Generated adjective-noun names
expose the full noun portion; custom and legacy names retain their full display
name. Consumers need not split arbitrary names into words.

The two job counts are independent. `running` counts actual running jobs and
`unprocessed` counts terminal jobs awaiting processing, both matched by exact
submitter session and canonical owning-project root. A job from the same
session in another project is excluded. An unknown project root for that
session makes the count unavailable. Null means unavailable; zero requires a
usable producer snapshot.

The daemon refreshes the job snapshots in the background every 60 seconds.
Running jobs use the version-1 Weft `job_list` envelope with a complete,
unbounded selection and the `project_root` column. The supported query is
`weft list jobs --running --all --all-hosts --limit 0 --no-sync --format json
--columns id,status_code,submitter_session,project_root`.
The running query has a 15-second deadline and bounded output. A failed query
retains its previous snapshot until the three-minute expiry, independently
of the awaiting-processing snapshot. Older Weft versions without the column
leave running counts unavailable. The CLI never launches Weft.

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

Pass `--work` with `--fields` to append a sixth field containing this exact
session's logical work as a versioned JSON document:

```json
{"version":1,"items":[{"id":"…","resourceType":"research-plan","resourceKey":"blinded-determinacy-calibration","label":"Blinded determinacy calibration","sourcePath":"/project/lab-notebook/plans/active/blinded-determinacy-calibration.md","state":"waiting","activity":"measurement · EXP-042","updatedAt":"2026-09-01T12:01:00.000Z"}]}
```

The document is `{ "version": 1, "items": [] }` when the session owns no
work. The field is empty when the work source cannot be read or the session has
no resolved address. Consumers must validate the version and item schema before
rendering it. `resourceKey` is the stable plan filename stem; `sourcePath` is
optional provenance rather than identity. The JSON is opt-in so existing shell
adapters that bind the fifth field as the remainder of the row keep working.

Items may also contain `progress: { current: 2, total: 5, label: "Pilot" }`.
`current` is a positive safe integer; optional `total` is a positive safe integer
at least as large as `current`, and optional `label` is a string. Missing
`progress` means position is unreported, including for older version-1 leases.
An explicit clear removes the field. `activity` remains freeform current
activity, never an inferred step. Existing widget formats are unchanged.

### The push/pull field

The fourth field is `push` when channel push is expected to land, `pull` when it
is not, `unknown` when the session is registered but carries no diagnosis, and
empty when no session is registered to ask about. There are two unrelated ways
to be pulling. A client other than Claude Code has no channel, so Antigravity,
Codex, Kimi, Gemini, and OpenCode sessions are pull-only. A Claude Code session
can also hold a channel it cannot use because its host was launched without the
channel or under an identity the host will not authorize.

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
- Keep one `agent-mail status-line --json` call for structured consumers.
  Existing positional consumers can retain `--fields` and optional `--work`.
  Separate calls repeat startup and can observe different snapshots.
- Name and TSV modes exit 0 on errors and print nothing. JSON mode exits
  nonzero on collection errors so callers can retain stale data accurately.
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
