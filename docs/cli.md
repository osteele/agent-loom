# CLI reference

Every `agent-mail` subcommand, grouped by area. The README's
[quick start](../README.md#quick-start) shows the common flows; this page is the
reference. Running `agent-mail` with no arguments, or `agent-mail help`,
prints a compact version of the same listing.

Two conventions apply everywhere below.

- `--project <dir>` names the project whose spool, claims, or leases the
  command touches. It defaults to the current directory. An existing path
  resolves directly; a bare name is matched against live listeners and projects
  that have received mail before, so a relative path cannot silently create a
  phantom mailbox. Ambiguous or unknown names are errors.
- Commands that acquire or act on coordination records (`claim-experiment`,
  `claim-path`, `work acquire`, `coordination request-transfer`,
  `coordination respond-transfer`) take their owner from the calling session's
  environment when run inside a registered agent shell. Outside one, they
  require `--owner <label>` and create explicit manual ownership, which expires
  24 hours after its last update.

## Messaging

### `notify`

```
agent-mail notify --project <dir> --message <text> [--from <label>]
  [--session <name-or-id> | --role owner] [--reply-to <id>] [--idempotency-key <key>]
  [--ttl <seconds>] [--no-slack]
```

Sends a message to a project's inbox. This is the entry point for automations
such as job notifiers; agents talking to each other use the `send_mail` MCP
tool instead. The command posts to the daemon first and appends to the spool
directly when the daemon does not answer, so a send works with the daemon
down. The direct fallback cannot echo to Slack.

- `--from <label>` sets the display label. A verified calling session supplies
  its reply address independently of this label, including cross-project sends.
  Without a verified session, the default label is `cli`.
- `--session <name-or-id>` addresses one live session. Exact opaque IDs resolve
  globally and select the recipient's registered mailbox, regardless of
  `--project`. Unique full/display names also resolve globally; display names are
  case-insensitive. If names collide, one match in `--project` disambiguates them.
  Otherwise the error lists candidate IDs and projects, with nothing sent.
  Exact IDs take precedence over names, and prefixes do not
  match. An empty, unknown, ambiguous, or refusing recipient fails with a
  nonzero exit status; nothing is sent. A held recipient remains addressable.
  Omit `--session` only for an intentional project broadcast.
  [architecture.md](architecture.md#addressing-one-session-from-an-automation)
  covers the contract.
- `--role owner` addresses the project's [owner](#owner), resolved to a concrete
  session when the command sends. Missing or ambiguous ownership is an error;
  it never falls back to a broadcast. Cannot be combined with `--session`.
- `--reply-to <id>` addresses the earlier message's sender in their live
  project mailbox and inherits the conversation's thread. Set `--project` to
  the inbox containing that message; the verified calling session's inbox is
  also searched. An explicit `--session` or `--role owner` overrides automatic
  return routing. Session addressing uses the global ID/name rules above;
  owner routing uses `--project`.
  Missing parents, unstamped senders, and senders without one identifiable
  live mailbox cause an error before sending. For historical or automation
  messages without a reply address, select `--project` and `--session`
  explicitly. An unresolved reply recipient never falls back to a broadcast.
- `--idempotency-key <key>` makes a retried send return the original message
  id instead of spooling a copy.
- `--ttl <seconds>` expires the message after that long; expired messages stay
  visible to dashboards but never enter an inbox.
- `--no-slack` suppresses the Slack echo for this message.

The stored message's `project` identifies the recipient mailbox.
`meta.sourceProject` preserves the supplied `--project` (for example, a job's
scratch directory), and `meta.fromCwd` records the invoking working directory.
`meta.fromProject` identifies the verified sender's workspace, or the supplied
project when the sender is unattributed. Routing does not change job ownership.

A send reports its outcome: spooled, dropped as a duplicate inside the
duplicate window, matched to an earlier attempt whose reply was lost, or rate
limited with a retry delay. [architecture.md](architecture.md#delivery-controls-and-receipts)
defines each outcome.

A CLI launched directly by a registered in-process host, such as OMP, can use
that host's reply address even without session-ID environment variables. This
requires one live mailbox owned by the immediate parent process. Without those
variables, an indirect or ambiguous host leaves the send unattributed.

### `inbox`

```
agent-mail inbox [--project <dir>] [--limit N] [--unread] [--peek]
```

Prints a project's spool, newest messages last, one line each with id, read
state, timestamp, sender, and any reply marker. `--limit` defaults to 20;
`--unread` shows only unread messages. Unless `--peek` is set, a verified agent
session registered in the selected project records delivery receipts for the
returned messages and marks them read. Reading another project's inbox is
unattributed and leaves its read state unchanged. Sending can carry a return
address across projects; inspecting another mailbox does not claim its mail.

### `triage-candidates`

```
agent-mail triage-candidates [--project <dir>] [--limit N]
```

Returns a versioned JSON snapshot of unread mail available for project-level
triage: broadcasts, direct messages whose recipient has no current or recent
delivery activity, and direct messages their live recipient refused. Direct
mail owned by a registered live session stays out of the candidate set. The
command also protects a recipient that stamped any delivery receipt during the
previous hour despite a missing registry entry. The response reports those
cases in `recentlyActiveUnregisteredSessions` and reports the
complete exclusion set in `protectedRecipientSessionIds`. Audit records and
TTL-expired mail are counted as non-deliverable and are not candidates.

The response returns the oldest 20 candidates by default while
`counts.candidates` reports the complete matching set; `returned` and
`truncated` describe the current batch. Set `--limit N` to choose a batch size
or `--limit 0` to request every candidate. Prefer bounded batches for automated
triage because message bodies are included in full.

A failed process scan is conservative: existing registrations remain live for
this selection, so an inspection failure cannot expose their direct mail to
another agent.

Mark handled candidates by exact id with `mark-read`. A broadcast read marker
removes that message from every session's unread view, including live pull-only
sessions that have not received it, so the triaging agent assumes
responsibility for every broadcast it settles. Do not use `--all` while live
sessions still own unread direct messages.

### `mark-read`

```
agent-mail mark-read [--project <dir>] (--id <message-id>... | --all)
```

Marks one or more messages, or the whole inbox, read. Repeat `--id` to settle a
triaged set without consuming messages that were excluded from that set.

### `receipts`

```
agent-mail receipts [--project <dir>] [--id <message-id>] [--limit N]
```

Shows the append-only delivery receipts for a project, or for one message with
`--id`. A `pushed` receipt means push transport acceptance or emission, or an
inbox pull; it does not prove context delivery. A `read` receipt means
`check_inbox` returned the message, an explicit mark-read recorded it, or a
protocol-v3 OMP steering acknowledgement attested exact-session context
insertion. None proves the recipient completed the requested work.
[automation.md](automation.md#what-presence-and-receipts-prove) covers what
each status does and does not establish.

### `listeners`

```
agent-mail listeners [--project <dir>] [--json] [--no-sync]
```

Lists the sessions attached to a project, or to every project, with display
name, full-name address, pid, capabilities, recency tag, inbound policy, and
mute state. The default mode scans processes and prunes dead registrations as
a side effect. `--no-sync` reads only the daemon's presence snapshot and never
scans or prunes; it is the mode automation should use, together with `--json`
for a versioned object. [automation.md](automation.md#the-presence-snapshot)
specifies the snapshot output.

## Sessions

### `mute` / `unmute`

```
agent-mail mute|unmute (--session <name-or-id> | --project <dir>)
```

Pauses or resumes channel push for the matching live sessions. Muting holds
pushed mail at the session's spool offset; everything held flushes on the
first poll after unmute. The daemon keeps spooling and Slack-echoing while a
session is muted. At least one selector is required, so `mute` never silently
targets every session. [architecture.md](architecture.md#muting) describes
the mechanism.

### `inbound`

```
agent-mail inbound --policy accept|hold|refuse (--session <name-or-id> | --project <dir>)
```

Sets how the matching live sessions treat incoming mail: `accept` delivers new
mail and releases held mail, `hold` keeps mail out of the agent's context
while retaining it, `refuse` drops it for that session while retaining the
audit record. The default policy comes from the `inbound_policy` config key.

### `status-line`

```
agent-mail status-line [--project <dir>] [--session <id>] [--fields] [--work] [--debug]
```

Prints this session's display name for a supported client status line, or one
tab-separated line of identity fields with `--fields`. The command accepts
explicit project and session flags, reads a client payload on stdin, and falls
back to the session identity environment variables. It always exits 0.
With `--fields --work`, it appends a versioned JSON document containing the
resolved session's logical-work leases.
[status-line.md](status-line.md) specifies the field order and the Claude Code
and Kimi Code adapters.

### `remind`

```
agent-mail remind --format codex|kimi|gemini|pi [--event <name>] [--session <id>] [--project <dir>]
```

Prints an unread-mail reminder for a harness hook, or nothing. Harnesses
without channel push run this command from their hooks and inject its output
into the model's context. The answer comes from the daemon's unread-summary
snapshot: the command edge-triggers on a new newest message and re-reminds
after 15 minutes while the same mail stays unread. At Codex or Kimi `Stop`, a
new edge is persisted and then exits 2 with fixed reminder text on stderr to
request one continuation; the same edge cannot continue twice. The `pi`
format exposes that signal to the example Pi extension. All failures fail open
with exit 0; a stale or missing snapshot prints nothing and appends a
rate-limited line to
`~/.claude/agent-mail/remind-diagnostics.log`. The session id resolves from
`--session`, then the stdin hook payload's `session_id`, then
`GEMINI_SESSION_ID`, then the session identity environment variables.
[reminders.md](reminders.md) covers the mechanism and the invariants.

## Coordination claims

Claims are filesystem transactions under `~/.claude/agent-mail/claims/`,
independent of the daemon.
[architecture.md](architecture.md#coordination-claims) covers the conflict
rules.

### `claim-experiment`

```
agent-mail claim-experiment [--project <dir>] [--notebook <dir>] [--owner <label>]
```

Atomically reserves the next `EXP-NNN` number in a research lab notebook and
prints the experiment id and claim id. The notebook defaults to
`./lab-notebook` when it exists, otherwise the project root. The reservation
counts existing `EXP-*` files plus active reservations, so create the
experiment file before releasing the reservation or the number can be reissued.

### `claim-path`

```
agent-mail claim-path --path <path> [--path <path> ...] [--directory]
  [--project <dir>] [--owner <label>]
```

Atomically claims one or more files under a single claim id, so a multi-file
edit set either succeeds together or fails without partial claims. Paths
resolve against the project. `--directory` marks every target as a directory;
a directory claim conflicts with claims on its ancestors and descendants,
while non-overlapping siblings may proceed. A conflict fails with advice on
how to recover the blocking claim.

### `claims`

```
agent-mail claims [--project <dir>]
```

Lists the project's active experiment and path claims with owner and creation
time.

### `release-claim`

```
agent-mail release-claim --id <claim-id> [--project <dir>]
```

Releases a claim by id, as printed by `claim-experiment`, `claim-path`, or
`claims`.

## Project owner

### `owner`

```
agent-mail owner [show|claim|release] [--project <dir>] [--json]
```

`show` (the default) reports the owner address and whether it is assigned,
inferred, unavailable, or ambiguous. Ownership is scoped to the canonical
project directory; separate worktrees have separate owners.

`claim` assigns the verified calling session as owner. It conflicts with an
existing live assignment. `release` removes that session's explicit assignment.
Neither command accepts a manual `--owner` label or a target `--session`.
Run them from the registered agent's shell in the owning project.

Without an explicit assignment, exactly one live logical session is the
inferred owner. Its MCP and push registrations count as one session. Adding a
second session makes inference ambiguous; removing it restores inference.
Releasing an assignment can therefore leave the same sole session as inferred
owner. A dead owner's assignment can be displaced; an assignment whose owner
cannot be identified safely does not authorize guessing another owner.

`--json` returns a versioned object (`schemaVersion: 1`) with `project`,
`address`, and `status`. Resolved owners include `source`, `sessionId`, and, for
explicit assignments, `leaseId`; unresolved owners include `reason`.
The assignment is a work lease with resource `project-owner:owner`. A registered
session can request its `leaseId` through `coordination request-transfer`, and
the current owner can accept or decline through `coordination respond-transfer`.
Existing transfer deadlines apply. Owner transfers require verified sessions,
not manual owner labels.
Generic `work acquire`, `work update`, and `work release` commands (and their
MCP equivalents) reject this reserved resource. The explicit, audited
`coordination recover --authority` escape remains available to an operator;
its declared authority is recorded, not authenticated.

For MCP clients, `project_owner` provides the same `show`, `claim`, and `release`
actions; mutations apply only to the client's registered project. Send with
`send_mail` arguments `project`, `role: "owner"`, and `message`. Replies return to
the actual sender unless an explicit `session` or `role` overrides that address.

Owner is a routing role, not a permission: it grants no file-edit authority or
plan-execution lease. Messages retain their resolved session across subsequent
ownership changes and use normal delivery, mute, and receipt behavior.

## Work leases

A work lease records exclusive responsibility for a logical resource, distinct
from a path claim: leases never block file edits, and path claims never imply
execution responsibility. [architecture.md](architecture.md#logical-work-leases)
develops the distinction.

### `work list`

```
agent-mail work list [--project <dir> | --all] [--type <type>] [--owner <owner>]
```

Lists active leases with resource, owner, state, current activity, and an
owner-offline marker. `--type` filters by resource type and `--owner` by owner
id, session id, or label.

### `work acquire`

```
agent-mail work acquire --type <type> --key <key> [--label <label>]
  [--source <path>] [--state working|waiting] [--activity <text>]
  [--project <dir>] [--owner <label>]
```

Acquires exclusive responsibility for the resource `type:key`, or updates the
caller-owned lease in place. Research plans use the plan's filename stem as
the key so status-directory moves keep the lease's identity. `--source`
records the file the lease is about, `--label` gives it a display name, and
`--state` and `--activity` set the initial progress note. A conflict with a
live owner fails with recovery advice; acquisition displaces only an owner
proven dead. Run inside a registered agent shell, or pass `--owner`.

### `work update`

```
agent-mail work update --id <work-id> [--state working|waiting] [--activity <text>]
```

Updates a lease's state or current activity. One of the two flags is required.

### `work release`

```
agent-mail work release --id <work-id> [--project <dir>]
```

Releases responsibility for a lease. The resource itself is untouched.

## Unified coordination

`coordination` presents work leases, path claims, and experiment reservations
as one health-oriented view. [architecture.md](architecture.md#inspection-and-recovery)
defines the conditions.

### `coordination list`

```
agent-mail coordination list [--project <dir> | --all] [--kind <kind>]
  [--owner <owner>] [--condition <condition>] [--json]
```

Lists every active coordination record with its owner status and recovery
condition: `healthy`, `owner-offline`, `owner-expired`, `owner-unverifiable`,
`source-missing`, `target-absent`, `awaiting-materialization`, or
`materialized`. `--kind`
filters to `work`, `path-claim`, or `experiment-claim`; `--owner` and
`--condition` filter further. `--json` prints a versioned object.

### `coordination recover`

```
agent-mail coordination recover --id <coordination-id> [--authority <text>]
```

Releases a stale work lease or claim after revalidating that the owning process
is definitively dead, or that a manual owner has gone 24 hours without renewal.
A live owner, an unverifiable one, or a manual owner still inside that window is
left in place. `--authority <text>` skips the liveness proof and force-releases; the
text is recorded verbatim in an append-only audit log at
`~/.claude/agent-mail/forced-recoveries.jsonl` and never verified, so pass it
only on explicit operator instruction.

### `coordination request-transfer`

```
agent-mail coordination request-transfer --id <work-id> [--reason <text>]
  [--timeout <seconds>] [--owner <label>]
```

Requests an asynchronous handoff of a work lease from its current owner. The
request is durable and idempotent for the same requester and lease version,
and prints as JSON. If the owner does not respond before the deadline,
ownership transfers automatically. `--timeout` defaults to 300 seconds and
accepts 5 to 86400. [architecture.md](architecture.md#work-transfer-requests)
covers the protocol.

### `coordination respond-transfer`

```
agent-mail coordination respond-transfer --id <request-id> --decision accept|decline
  [--message <text>] [--owner <label>]
```

Answers a pending transfer request. Only the exact current owner captured by
the request may respond.

### `coordination transfers`

```
agent-mail coordination transfers [--project <dir> | --all] [--json]
```

Lists transfer requests with status and deadline, settling expired ones first.

## State and dashboards

### `state`

```
agent-mail state [--project <dir>] [--no-sync] [--json]
```

Prints versioned, non-mutating aggregate state: presence, coordination,
transfers, recent messages, routes, counts, and provenance. The command asks
the daemon first and falls back to a read-only filesystem snapshot reader;
`--no-sync` uses the snapshot directly. The output is JSON either way, so
`--json` is accepted for symmetry but changes nothing.
[automation.md](automation.md#aggregate-state) specifies the schema.

### `dashboard`

```
agent-mail dashboard [--port N] [--open] [--no-tui]
```

Reports the persistent dashboard URL served by the daemon, opening it with
`--open`. When the daemon is down, starts a direct-filesystem fallback server
on the daemon port plus one; an explicit `--port N` always starts the
fallback. The fallback's terminal controls are `o` to open and `q` to quit;
`--no-tui` runs a plain long-running server instead. The dashboard is off
unless `dashboard = true` is set in the config, or `AGENT_MAIL_DASHBOARD=1`
for one invocation. Both forms are read-only.
[dashboards.md](dashboards.md) describes what the dashboard shows.

### `slack-dashboard`

```
agent-mail slack-dashboard [--watch <seconds>]
```

Posts the same summary as a single Slack message and edits it in place on each
run. `--watch <seconds>` refreshes on a timer until interrupted. This needs a
Slack bot token with `chat:write` scope; the incoming webhook used for
per-message echoes cannot edit messages. Without one, the command prints the
required config keys and exits nonzero.

## Daemon

The daemon is launchd-aware: these commands drive `launchctl` when the
LaunchAgent is installed and manage a bare pidfile process otherwise.

### `start` / `stop` / `restart`

```
agent-mail start|stop|restart
```

Starts, stops, or restarts the daemon. `start` is a no-op when the daemon is
already running. Use `restart` after a code change; `graceful` reloads config
only.

### `status`

```
agent-mail status
```

Prints daemon health: process and launchd state, port, dashboard URL, Slack
echo state, an HTTP health probe, the listening sessions with recency tags,
and the observed channel opt-in state. The channel check runs
`claude plugin list` and takes about two seconds, so keep `status` out of
latency-bound surfaces.

### `graceful`

```
agent-mail graceful
```

Sends the daemon SIGHUP to reload its config without a restart. Also available
as `agent-mail reload`.

### `logs`

```
agent-mail logs [-f]
```

Prints the last 50 lines of the daemon log, or follows it with `-f`
(`--follow`).

## Setup

### `mcp`

```
agent-mail mcp
```

Runs the MCP server on stdio. Agent configs launch this; you do not run it by
hand. One command both registers and serves, so a client can be configured in
a single line without a prior global install, and sending falls back to a
direct spool append when no daemon answers.

### `oh-my-pi-plugin-path`

```
agent-mail oh-my-pi-plugin-path
```

Prints the absolute directory of the bundled Oh My Pi push extension. Pass the
result to `omp plugin link --scope user`. See [oh-my-pi.md](oh-my-pi.md) for
session identity, native status, and delivery behavior.

### `install`

```
agent-mail install [--dry-run] [--native-audit] [--no-codex]
                   [--replace-claude] [--replace-codex]
                   [--replace-kimi] [--replace-gemini] [--replace-opencode]
```

On macOS, writes the config template if missing, installs the LaunchAgent and
bootstraps the daemon to start at boot, and registers agent-mail with Claude
Code and Codex. It also registers Kimi Code, Gemini CLI, and OpenCode when their
user config directories exist. Existing registrations that match this install are
preserved; ones that point elsewhere are left unchanged unless the matching
`--replace-claude`, `--replace-codex`, `--replace-kimi`, `--replace-gemini`, or
`--replace-opencode` flag is passed. `--no-codex` skips Codex registration, and `--native-audit`
adds a Claude hook that audits native SendMessage traffic.

`--dry-run` is available on every platform and makes no changes. It prints a
versioned JSON object containing the runtime and entry points that an install
would persist. [install.md](install.md) covers the edge cases, including the
plugin registration conflict that silently disables channel push.

### `hooks`

```
agent-mail hooks install|uninstall|status [--codex] [--kimi] [--gemini] [--gemini-after-tool]
```

Installs, removes, or reports the unread-mail reminder hooks for pull-only
harnesses. With no harness flag, install and uninstall apply to every harness
whose config directory exists (`~/.codex`, `~/.kimi-code`, `~/.gemini`). Codex
gains synchronous `UserPromptSubmit` and `Stop` hooks plus an asynchronous
`PostToolUse` hook in `~/.codex/hooks.json`; Kimi gains marker-delimited
`[[hooks]]` entries for `UserPromptSubmit` and `Stop` in
`~/.kimi-code/config.toml`; Gemini gains a `BeforeAgent` hook in
`~/.gemini/settings.json`. `--gemini-after-tool`
additionally installs Gemini's `AfterTool` hook, which is opt-in because
Gemini waits for each hook to finish. `status` prints, per harness, whether
the hooks are installed and on which events. The transforms are additive and
idempotent, preserve neighboring hooks, and are fully removed by `uninstall`.
[reminders.md](reminders.md) covers setup and verification.

### `uninstall`

```
agent-mail uninstall
```

Boots out the LaunchAgent, removes its plist, and removes the Claude, Codex,
Kimi, Gemini, and OpenCode registrations and the native audit hook owned by
this install. Registrations belonging to a different checkout are reported and
left in place.
