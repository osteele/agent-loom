# CLI reference

Every `agent-mail` subcommand, grouped by area. The README's
[quick start](../README.md#quick-start) shows the common flows; this page is the
reference. Running `agent-mail` with no arguments, or `agent-mail help`,
prints a compact version of the same listing.

These conventions apply except where a command specifies explicit selectors.

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
agent-mail inbox [--project <dir>] [--limit N] [--unread] [--peek] [--json]
```

Prints a project's spool, newest messages last. Text rows include the id, read
state, timestamp, sender project and name, and any reply marker. `--json`
returns a versioned object with structured sender project, name, and session
fields. `--limit` defaults to 20; `--unread` shows only unread messages.

Unless `--peek` is set, a verified agent session registered in the selected
project records delivery receipts and marks only its visible returned messages
read. Direct mail addressed to a sibling session stays unread even though the
project-wide listing displays it. Reading another project's inbox is
unattributed and leaves its read state unchanged.

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
`--id`. `pending` records that the session was a live intended recipient when
the message entered the spool, before its transport reports an attempt.
`push-unreachable` records a channel setup that is known to reject the push;
the message remains available through inbox pull. A `pushed` receipt means push
transport acceptance or emission, or an inbox pull; it does not prove context
delivery. A `read` receipt means `check_inbox` returned the message, an explicit
mark-read recorded it, or a protocol-v3 OMP steering acknowledgement attested
exact-session context insertion. None proves the recipient completed the
requested work. [automation.md](automation.md#what-presence-and-receipts-prove)
covers what each status does and does not establish.

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

### `session-address`

```
agent-mail session-address --project ABS --session RAW --json
```

Resolves an advisory session identity for companion-pane launchers. All three
flags are required. `ABS` must be an absolute path to an existing directory;
the output uses its canonical, symlink-resolved path. `RAW` must be a nonempty
raw session ID, not a display name. Neither selector is inherited from the
environment, and project basenames are not resolved heuristically. Invalid
arguments exit nonzero with a diagnostic on stderr.

Successful queries print only a versioned JSON object to stdout:

```json
{
  "version": 1,
  "project": "/absolute/canonical/project",
  "requestedSessionId": "raw-requested-id",
  "sessionId": "registered-id",
  "parentPid": 12345,
  "procStart": null
}
```

The query reads only the supported listener snapshot, with a 30-second TTL.
Within the explicit project, it applies `resolveSelf`'s stale-activity filter
and prefers an exact session ID. Otherwise, exactly one registration must have
a host `parentPid` in the query process's ancestor chain. This can resolve the
original registration after Claude `/clear` changes the session ID. Run the
query beneath the host agent when relying on that fallback.

A missing, stale, or unavailable snapshot, an unresolved identity, or ambiguous
host matches return `sessionId`, `parentPid`, and `procStart` as `null`, with
exit status zero. Empty snapshots never fall back to the requested ID.
Malformed rows cannot supply a project identity; malformed identity/activity
fields in the selected project fail closed.

`parentPid` is the selected registration's host agent PID, when available.
An exact session match remains valid without it and returns `parentPid: null`.
`procStart` is currently always `null`: the registration's start stamp belongs
to the MCP channel process, not its host. Consumers must independently capture
and verify the host's process start stamp. Snapshot identity is advisory, not
a current liveness guarantee.

This command never scans or prunes the registry, starts or refreshes the daemon,
joins session-name metadata, or writes snapshots, leases, names, or other state.
Only a host-fallback query inspects process ancestry.

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
agent-mail remind --format agy|codex|kimi|gemini|pi [--event <name>] [--session <id>] [--project <dir>]
```

Prints an unread-mail reminder for a harness hook or a harness-specific no-op.
Harnesses without channel push run this command from their hooks and inject its
output into the model's context. The answer comes from the daemon's
unread-summary snapshot. The command edge-triggers on a new newest message and
re-reminds after 15 minutes while the same mail stays unread. At Agy, Codex, or
Kimi `Stop`, a new edge is persisted before one continuation is requested.
Codex and Kimi use exit 2 with fixed reminder text on stderr; Agy uses its JSON
continue response. The `pi` format exposes the exit-2 signal to the example Pi
extension. All failures fail open with exit 0. Agy receives `{}` on no-op
paths; other formats print nothing. A stale or missing snapshot also appends a
rate-limited line to
`~/.claude/agent-mail/remind-diagnostics.log`. The session id resolves from
`--session`, then the stdin hook payload's `session_id`, then
`GEMINI_SESSION_ID`, then the session identity environment variables. Agy's
documented `workspacePaths` supplies the project when the hook process runs
from its global config directory.
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
  [--plan <stem> [--plan-project <dir>]]
```

Claims one or more names atomically. Existing targets use their observed kind.
Missing targets default to files; `--directory` declares them as directories.
Duplicate targets and descendants covered by a directory are removed. Other
owners conflict hierarchically, while the same owner may hold separate
overlapping claims. An exact repeat prints the existing claim without a token.
A new claim prints its ID and one-time release token on the first line.

CLI paths resolve against `--project`. The MCP `claim_path` tool requires a
canonical absolute `project` for cross-project claims. `--plan` makes the
research plan the owner and requires the caller to hold that plan's work lease.

### `claims`

```
agent-mail claims [--project <dir> | --all] [--history]
```

Lists active experiment and path claims. `--history` adds path claims released
within the 30-day retention window. Release tokens are never listed.

### `release-claim`

```
agent-mail release-claim (--id <claim-id> | --token <release-token>)
  [--project <dir>]
```

Releases a claim. A path claim accepts its one-time token, its logical session
identity, or the current executor of its owning plan. Manual labels are not
release credentials. Repeated release remains idempotent during retention.

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

### `work tui`

```
agent-mail work tui --session ID --project /absolute/existing/project [--once]
```

Shows every work lease whose `owner.sessionId` exactly matches `ID` in the
canonical project. It includes retained leases without a live registration.
Session and project must both be supplied explicitly; the project must be an
absolute existing directory. Project symlink aliases resolve to the same
directory. Empty sessions, relative projects, duplicate flags, positional
arguments, and all other selectors (including `--all`, `--owner`, and `--type`)
are rejected. The command never infers identity from the environment.

The view shows resource type/key, label, last-reported working/waiting state,
**Current activity**, explicit **Current position**, creation/update timestamps
and ages, source path, and full source text. Missing activity or position is
`unreported`. Markdown checkboxes and freeform activity do not establish a
position. Ages are measured from persisted lease timestamps at snapshot time;
an old report may be stale but does not prove the owner dead. Updating any lease
metadata changes `updatedAt`, even if the activity text was preserved.

When the session has no claimed work, the view lists the project's plans
instead: the active plans at the top of `lab-notebook/plans/`, and those in its
`proposed/` and `backlog/` subdirectories, following the research-ops plan
convention. Each entry shows the plan's first heading, its project-relative
path, and the `updated`, `summary`, and `next_action` frontmatter. A plan held
by a `research-plan` lease whose key is exactly the plan's filename stem shows
that lease's owner, id, state, and last-report age, from any session; no other
join is attempted. A plan without frontmatter, whose `status` disagrees with
its directory, or that cannot be read stays listed with a diagnostic naming
`plan_index.py`, the convention's checker. A project with no
`lab-notebook/plans` directory says so. Plan files are read under the same
containment and size limits as lease sources.

`--once` prints one plain-text snapshot without ANSI and exits. Non-TTY stdin
or stdout also selects one-shot output. An unavailable work store produces a
visible diagnostic and exit status 1, distinct from no claimed work. A missing
or unreadable source is reported on its lease without hiding the other leases.
No refresh writes leases, claims, locks, registry entries, or session names,
and no daemon is started.

Interactive controls:

| Key | Action |
| --- | --- |
| `n`, Right, Tab | Next lease |
| `p`, Left, Shift-Tab | Previous lease |
| `j` / Down, `k` / Up | Scroll down / up |
| Page Down / Space, Page Up | Scroll one page |
| `g` / Home, `G` / End | Start / end of selected lease content |
| `r` | Refresh immediately |
| `q`, Ctrl-C | Quit |

Refresh runs every two seconds and preserves the selected lease by ID when it
still exists. Resize reflows the text. Long lines wrap and all supported content
is scrollable; very small terminals need resizing to at least 3 columns and
2 rows. Quitting, EOF, SIGINT, SIGTERM, SIGHUP, SIGQUIT, and SIGTSTP restore raw
mode, cursor visibility, and the main screen. SIGTSTP exits rather than suspends.

Sources are read only from regular files contained in the project after symlink
resolution. Escaping symlinks, devices, FIFOs, and directories are refused.
Files above 1 MiB are explicitly reported as unsupported, with no partial
content presented as complete. Files changed during reading report unavailable
until a later refresh. Source text is read at refresh time and may be newer than
the lease's activity. Terminal controls are escaped visibly; source line breaks
are preserved, CRLF becomes LF, and tabs become four spaces.

### `work acquire`

```
agent-mail work acquire --type <type> --key <key> [--label <label>]
  [--source <path>] [--state working|waiting] [--activity <text>]
  [--project <dir>] [--owner <label>]
  [--step N [--steps TOTAL] [--step-label TEXT] | --clear-progress]
```

Acquires exclusive responsibility for the resource `type:key`, or updates the
caller-owned lease in place. Research plans use the plan's filename stem as
the key so status-directory moves keep the lease's identity. `--source`
records the file the lease is about, `--label` gives it a display name, and
`--state` and `--activity` set the initial state and activity note. A conflict with a
live owner fails with recovery advice; acquisition displaces only an owner
proven dead. Run inside a registered agent shell, or pass `--owner`.

### `work update`

```
agent-mail work update --id <work-id> [--state working|waiting] [--activity <text>]
  [--step N [--steps TOTAL] [--step-label TEXT] | --clear-progress]
```

Updates a lease's state, current activity, or structured position. At least one
of `--state`, `--activity`, `--step`, or `--clear-progress` is required.

For both acquire and update, `--step N` supplies a positive safe integer and
replaces the entire prior position report. `--steps TOTAL` supplies an optional
positive safe integer total with `N <= TOTAL`; `--step-label TEXT` supplies an
optional short label (trimmed, at most 500 characters, no C0 controls). Both
require `--step`. Omitting a total or label from a replacement removes that
field. `--clear-progress` takes no value, conflicts with all step flags, and
removes the position. Omitting all position flags preserves the existing report.

MCP `acquire_work` and `update_work` accept the same optional
`progress: { current: N, total?: TOTAL, label?: TEXT }`. Omission preserves;
`progress: null` clears. WorkStore uses this same object and validation.
Leases and published status-work documents remain version 1; old records
without `progress` remain valid. Position is a caller report, not verified step
completion. Ownership, transfer, recovery, and delivery rules are unchanged.

### `work release`

```
agent-mail work release --id <work-id> [--project <dir>]
  [--outcome completed|abandoned]
```

Releases responsibility for a lease. Releasing a research-plan lease also
releases that plan's path claims and records the selected outcome. Omitting the
outcome records lease loss.

## Obligations

Obligations are machine-global records of who owes whom a specific outcome —
a claim release, a decision, a referenced fix, a job completion, a review.
Parties are sessions, the human operator, systems (a wired integration such
as `weft` or `agent-issues`), and roles (the component owner, the plan's
current executor, the experiment's claimer of record). The model is
announced, not negotiated: the obligee creates the record and closes it, the
obligor can contest but never confirm, and deterministic evidence settles
its own waits — a claim release settles claim-release obligations, and a
system event settles records owed by a system or a role. Records span
projects, so these commands take no `--project`. `--user` addresses the
operator; the obligor's copy of a session-addressed record arrives as
exactly one notice.

### `obligations announce`

```
agent-mail obligations announce (--obligor <name-or-id> | --user |
                                 --system <name> | --component <name>)
  --kind <claim_release|decision|external_fix|job_completion|review>
  --subject <text>
```

Announces that the obligor owes the calling session a specific outcome. A
session obligor must resolve to a live session; `--system <name>` names a
wired integration (`claims`, `weft`, `agent-issues`) whose own events settle
the record; `--component <name>` names the component whose owner owes the
repair, and resolves at read time to the one responsible session — its
creation notice goes to that session. A role or system obligor cannot be
contested. An open record with the same obligee, kind, and subject blocks a
duplicate and names the existing id.

### `obligations close`

```
agent-mail obligations close --id <obligation-id> [--resolution <text>]
```

Satisfies an open obligation. Obligee-only; the resolution text is captured
at the act and never edited. Closed records are retained for 30 days. Besides
the obligee's own close, `claim_release` records settle when the claim
releases, and records owed by a system or a role settle when the owning
system reports the event (a weft job finishing, an issue reaching fixed).

### `obligations withdraw`

```
agent-mail obligations withdraw --id <obligation-id>
```

Withdraws an open obligation. Obligee-only, like `close`.

### `obligations contest`

```
agent-mail obligations contest --id <obligation-id> --reason <text> [--user]
```

The named obligor marks the record contested — visible everywhere, tagged,
never closing. `--user` is the operator's form for records naming the human.
A second contest is refused. Records owed by a system or a role have no
contest path: those obligors cannot act, so the record settles by its own
evidence or clears by authority.

### `obligations adopt`

```
agent-mail obligations adopt --predecessor <id>
  (--resume-id <id> | --authority <text> --reason <text>)
```

A successor session adopts every open obligation of an offline predecessor —
both what it was owed and what it owed. Succession requires the
predecessor's resume id (from the host command line) or declared authority.
The transfer is atomic, carries contested flags, and skips terminal records.

### `obligations owed`

```
agent-mail obligations owed
```

Lists open obligations naming the operator, across all projects. Records
naming a session appear in that session's status line and in
`coordination list --all`.

### `obligations list`

```
agent-mail obligations list [--all] [--owed]
```

Lists obligations; `--all` includes satisfied and withdrawn records within
the 30-day retention window, `--owed` filters to the operator's.

### `obligations clear`

```
agent-mail obligations clear --id <obligation-id> --authority <text> --reason <text>
```

Withdraws an open obligation under declared user authority — recorded, never
verified.

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
condition: `healthy`, `restart-grace`, `owner-offline`, `owner-expired`,
`owner-unverifiable`, `source-missing`, `awaiting-materialization`, or
`materialized`. `--kind` filters to `work`, `path-claim`, or
`experiment-claim`; `--owner` and `--condition` filter further. `--json` prints
a versioned object.

### `coordination recover`

```
agent-mail coordination recover --id <coordination-id>
  [--authority <text> --reason <text>]
```

Releases a record after revalidating its lifecycle. A forced recovery requires
both `--authority` and `--reason`. Agent-mail records both values verbatim in
`~/.claude/agent-mail/forced-recoveries.jsonl` and does not verify them. Only
explicit operator instruction can supply the authority.

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
agent-mail logs [-f] [--mcp|--lifecycle]
```

Prints the last 50 lines of the daemon log, or follows it with `-f`
(`--follow`). `--mcp` selects the sanitized record of MCP servers that failed
before completing the handshake. `--lifecycle` selects the channel-server
lifecycle log, `channel-lifecycle.jsonl`, with one JSON line per event:

- `attached`: a host completed the handshake with a channel server.
- `shutdown`: a server left on its own path, after a signal or when stdin
  closed. The line gives the reason.
- `exit`: a server exited some other way. The line gives the exit code and any
  uncaught exception.
- `pruned`: a registry sweep removed an entry whose process was gone. The line
  gives the cause (`no-process`, `pid-reused`, or `defunct`) and the pid of the
  process that swept it.

An `attached` record followed by `pruned`, with no `shutdown` or `exit` between
them, means the server was killed outright. A session with no `attached` record
was never given a channel server by its host.

Any other argument is an error, as is passing both `--mcp` and `--lifecycle`.
When the selected log does not exist yet, `logs` names the path it looked for.

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
                   [--replace-claude] [--replace-agy] [--replace-codex]
                   [--replace-kimi] [--replace-gemini] [--replace-opencode]
```

On macOS, writes the config template if missing, installs the LaunchAgent and
bootstraps the daemon to start at boot, and registers agent-mail with Claude
Code and Codex. It also registers Antigravity CLI, Kimi Code, Gemini CLI, and
OpenCode when their user config directories exist. Existing registrations
that match this install are preserved; ones that point elsewhere are left
unchanged unless the matching `--replace-claude`, `--replace-agy`,
`--replace-codex`, `--replace-kimi`, `--replace-gemini`, or
`--replace-opencode` flag is passed. `--no-codex` skips Codex registration,
and `--native-audit` adds a Claude hook that audits native SendMessage traffic.

`--dry-run` is available on every platform and makes no changes. It prints a
versioned JSON object containing the runtime and entry points that an install
would persist. [install.md](install.md) covers the edge cases, including the
plugin registration conflict that silently disables channel push.

### `hooks`

```
agent-mail hooks install|uninstall|status [--agy] [--codex] [--kimi] [--gemini] [--gemini-after-tool]
```

Installs, removes, or reports unread-mail reminder hooks for pull-only
harnesses. With no harness flag, install and uninstall apply to every harness
whose config directory exists (`~/.gemini/config`, `~/.codex`,
`~/.kimi-code`, `~/.gemini`). Agy gains direct `PreInvocation` and `Stop`
handlers in `~/.gemini/config/hooks.json`. Codex gains synchronous
`UserPromptSubmit` and `Stop` hooks plus an asynchronous `PostToolUse` hook in
`~/.codex/hooks.json`. Kimi gains marker-delimited `[[hooks]]` entries for
`UserPromptSubmit` and `Stop` in `~/.kimi-code/config.toml`. Gemini gains a
`BeforeAgent` hook in `~/.gemini/settings.json`; `--gemini-after-tool`
additionally installs Gemini's `AfterTool` hook, which is opt-in because
Gemini waits for each hook to finish. `status` prints the installed events for
each harness. The transforms are additive, idempotent, preserve neighboring
hooks, and are fully removed by `uninstall`.
[reminders.md](reminders.md) covers setup and verification.

### `uninstall`

```
agent-mail uninstall
```

Boots out the LaunchAgent, removes its plist, and removes the Claude, Codex,
Kimi, Gemini, and OpenCode registrations and the native audit hook owned by
this install. Registrations belonging to a different checkout are reported and
left in place.
