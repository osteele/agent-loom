# agent-mail

Durable local mail and advisory coordination between coding-agent sessions.

You are running several coding agents at once, in different projects and
different tools. One of them finishes something another is waiting on. You
copy text from one session and paste it into another.

agent-mail is a local message bus for those sessions. A message lands in a
project's on-disk inbox (its spool) whether or not anyone is listening. A
running session can receive it in context when its push integration is
enabled.

The same sessions also need to stay out of each other's way and keep track of
what they are waiting for. agent-mail records that too: who is editing which
files, who is responsible for which piece of work, and who owes whom a decision,
a fix, or a finished job.

```mermaid
graph LR
    QL["Quiet Lantern<br/>a Claude Code session"] -->|send_mail| IN[("the project's inbox")]
    AUTO["CLI · weft · HTTP"] --> IN
    IN -->|"read on check_inbox"| SO["Silver Otter<br/>a Codex session"]
    IN -.->|echo| SLACK["Slack"]
```

Sessions address each other by stable names across project directories.

- **Durable delivery.** A message waits in the project's inbox until an
  intended recipient retrieves it with `check_inbox`, unless it expires. A
  running session with push enabled can receive it automatically.
  Receipts distinguish spooled, pending, held, pushed, push-unreachable, read,
  refused, and expired mail.
- **Any endpoint.** agent-mail speaks standard MCP over stdio, so any MCP
  client can use the same tools and inboxes. Setup is tested with Claude Code,
  Antigravity CLI, and Codex; the CLI, an HTTP client, or a tool such as
  [weft](https://github.com/osteele/weft) reporting a finished job can send
  too.
- **Push into supported sessions.** With the corresponding channel or extension
  enabled, mail arrives in a session's context without the agent asking.
- **Advisory coordination.** Path claims keep two agents from editing the
  same files, work leases record who is responsible for a logical unit, and
  lab-notebook experiment numbers (`EXP-NNN`) allocate atomically.
- **Obligations.** A session records that someone owes it an outcome —
  another session, a component's owner, you, or a system such as weft. Open
  [issue-ledger](#related-projects) issues are obligations without any
  record: each is owed by its component's owner and lists as a read-only
  `issue:<id>` row. Records owed by a system settle on that
  system's own evidence, and `obligations owed` lists everything open that
  names you, across every project.
- **Inspectable traffic.** Unread state, threads, Slack echo, and web and
  Slack dashboards.

Claude Code's own cross-session messaging and agent teams cover the
all-Claude, all-live, spawned-together case without any of this;
[When to use Claude Code's built-ins](#when-to-use-claude-codes-built-ins)
maps the boundary.

## Quick start

Register agent-mail with the agents you use, in one command:

```bash
npx add-mcp github:osteele/agent-mail --args mcp --name agent-mail --global \
  --agent claude-code --agent codex
```

Sessions can then send mail, read their inbox, and take claims. The command's
only effect is the config entry:
[`add-mcp`](https://github.com/neon-solutions/add-mcp) writes each agent's
config file, and `npx` fetches agent-mail when a session starts it, so there
is no repository to clone and no background process to run.

Pass `mcp` through `--args`: add-mcp does not split a quoted command string
and silently writes a broken entry.

Name any other clients the same way (`--agent cursor --agent zed`, and so on);
`npx add-mcp list-agents` lists the twenty or so it knows. Every client gets the
same tools and the same durable inbox. Channel push is specific to Claude Code
and needs [its own setup](#enabling-channel-push-in-claude-code).

`--global` writes each agent's user-level config rather than the current
project, so a session in any directory stays reachable.

Requires Node 22.18 or later. Restart existing sessions afterward.

### Send the first message

The MCP tools are enough for a complete exchange. In one registered session,
ask the agent:

> Use agent-mail to send "ping" to the project
> `/absolute/path/to/the/receiving/project`.

In a session working in that receiving project, ask:

> Check agent-mail for unread messages, then mark the ping as read.

That sends a project broadcast. To reach one session when several share the
project, use `list_sessions` to find its full name and pass that name to
`send_mail`. Exact IDs and globally unique full/display names select the
recipient's registered inbox. The supplied project disambiguates name
collisions. Missing, ambiguous, or refusing recipients are errors.

To reach the project's owner without choosing a session name, use `send_mail`
with `role: "owner"`. `project_owner` inspects, claims, or releases that role.
Without an explicit assignment, a sole live session is inferred as owner;
multiple sessions make it ambiguous and owner-addressed mail is refused.
See [project owner commands](docs/cli.md#project-owner) for assignment and handoff.

Generated addresses use a credited 256 × 256 subset of Glitch's
[`friendly-words`](https://github.com/glitchdotcom/friendly-words). Agent-mail
does not reuse a noun held by another registered session and normally waits 30
days before reusing a noun, so a human can usually address an established agent
by its noun alone. Names may eventually recycle; session IDs remain the durable
identity. See [ADR 0012](docs/decisions/0012-allow-friendly-session-names-to-recycle.md)
and [the third-party notice](THIRD_PARTY_NOTICES.md).

### Mail vocabulary

Use **mail** for agent-mail across harnesses. “Check mail,” “read mail,” and an
unqualified “check the inbox” read the agent-mail inbox. “Send mail” uses
agent-mail's durable delivery. Name a harness, Hub, teammate, or subagent when
you want that harness's native peer messaging instead.

An attached recipient with push support starts a turn when mail arrives. Mail
for a disconnected or pull-only recipient remains in the spool until that
session resumes or checks its inbox.

### Install only what you need

| Component | What it adds | Setup |
| --- | --- | --- |
| MCP registration | `send_mail`, `check_inbox`, session discovery, and coordination | The `npx add-mcp` command above |
| Local CLI | Shell automation, status commands, daemon management, and dashboards | `npm install -g github:osteele/agent-mail` |
| Daemon | Slack echo, fast presence status, automatic dead-session cleanup, later-arrival reminder data, and a persistent dashboard | `agent-mail install` on macOS; `agent-mail start` on Linux |
| Claude Code channel | Automatic message push into a running Claude session | Add and configure the plugin below |
| Oh My Pi extension | Automatic exact-session push plus agent-mail and Weft state in OMP's native status line | Link the bundled extension; see [Oh My Pi](docs/oh-my-pi.md) |
| Reminder hooks | Unread counts on later turns in pull-only clients | `agent-mail hooks install` |
| Web dashboard | Local read-only traffic and coordination view | Set `dashboard = true`; requires the local CLI |

### Adding the daemon on macOS

An optional daemon adds [Slack echo](#connecting-to-slack), cached presence
data that keeps the [status line](#status-lines) fast, and automatic cleanup of
dead sessions. It also supplies later-arrival reminder data and serves the
persistent dashboard when that dashboard is enabled:

```bash
npm install -g github:osteele/agent-mail
agent-mail install
agent-mail status
```

Mail is delivered with or without it: when no daemon answers, a session writes
to the project's spool itself. On macOS, the daemon runs as a launchd service.
Nothing about delivery depends on it.

The LaunchAgent uses the `Interactive` process class for latency-sensitive
HTTP status requests and push connections.

`agent-mail install` also registers agent-mail with Claude Code and Codex. If
Antigravity CLI (`agy`), Kimi Code, Gemini CLI, or OpenCode has a user config
directory, it registers with those clients too. Running both setup paths is
harmless: a matching entry is a no-op, and a different entry is left alone.

On Linux, the CLI and MCP server work, and `agent-mail start` starts a detached
bare-mode daemon; agent-mail does not install a Linux boot service.

**Platforms.** The CLI and MCP server are tested on macOS and Linux. The
daemon installer is macOS-only. Windows is unsupported:
session liveness is read from `ps`, and without it the registry cannot prune
sessions or expire claims. See
[docs/decisions/0005](docs/decisions/0005-no-windows-support.md).

### Enabling channel push in Claude Code

The MCP tools and the durable inbox work as soon as the server is registered.
Channel push is a separate opt-in with three parts, all of which must line up.

The marketplace lives in this repository and can be added directly from
GitHub. A clone is only needed for local development or testing.

1. **The marketplace added and the plugin installed**, which `agent-mail
   install` does not do for you:

   ```bash
   claude plugin marketplace add osteele/agent-mail
   claude plugin install agent-mail@osteele-local
   ```

2. **Channels enabled and this plugin allowed**, in managed settings
   (`/Library/Application Support/ClaudeCode/managed-settings.json`):

   ```json
   {
     "channelsEnabled": true,
     "allowedChannelPlugins": [
       { "marketplace": "osteele-local", "plugin": "agent-mail" }
     ]
   }
   ```

3. **Each session launched with the channel loaded:**

   ```bash
   claude --channels=plugin:agent-mail@osteele-local
   ```

   This is a per-launch decision, so set it once for every session instead of
   typing it each time. With a launcher wrapper, put it in global
   `extra_args`; scoping it to some paths leaves whole directories silently
   without push.

Run `agent-mail status` to see what is actually in place, and `agent-mail
listeners` to see which live sessions were launched with the channel: one whose
host was not is tagged `{channel:host-not-loaded}`.

To test from another registered agent, use the `send_mail` exchange above. If
you installed the local CLI, the equivalent shell smoke test is:

```bash
agent-mail notify --project "$PWD" --from cli --message "agent-mail is ready"
agent-mail inbox --project "$PWD"
```

`inbox` prints the project-wide spool. A verified session acknowledges only the
returned messages visible to that session; direct mail addressed to a sibling
session stays unread. Pass `--peek` to read without acknowledging, or `--json`
for versioned output with structured sender project, name, and session fields.
Attribution depends on agent-mail proving that the registered session's host
process is an ancestor of the CLI process. An unattributed read reports the
condition on stderr and leaves the mail unread.

For project-level cleanup, run `agent-mail triage-candidates --project <dir>`
with optional `--limit N`. It returns unread broadcasts, direct mail whose
recipient has no current or recent delivery activity, and direct mail its
live recipient refused. It excludes direct mail owned by a registered live
session and conservatively protects a recipient that stamped any delivery
receipt during the previous hour despite a missing registry entry. The default
response contains the oldest 20 candidates, reports the total candidate count,
and sets `truncated` when more remain. After handling the returned messages,
pass their exact ids as repeated `--id` flags to `agent-mail mark-read`.
Marking a broadcast read removes it from every session's unread view, including
a live pull-only session that never received it, so this workflow assigns
project broadcasts to the triaging agent. `--all` would also consume the
excluded live-session mail.

The local Claude plugin includes the `agent-mail-triage` skill for requests to
process unattended mail or mail for terminated sessions. Other harnesses can
load the same skill from
`plugins/agent-mail/skills/agent-mail-triage/`.

Sending has the mirror rule: `notify` stamps a resolvable sender identity when
it can prove one, and otherwise sends with `--from` as a free-form label. A
recipient sees such a label tagged `[label; not a reply address]`, because
replying to it by name will not resolve.

### Read-only session mail history

```bash
agent-mail mail tui --session EXACT_ID --project /absolute/project
agent-mail mail tui --session EXACT_ID --project /absolute/project --once
agent-mail mail history --session EXACT_ID --project /absolute/project
```

The timeline shows incoming and outgoing mail, newest first, including sends
to other projects. Direct mail is attributed by its exact target; broadcasts
need a persisted receipt naming the session. Sender attribution uses the
stored session ID and source project. Sharing a project or matching a display
name is insufficient. Historical refused and expired mail remains visible.

Enter expands the message at the top of the viewport; `n`/`p` moves between
messages, `j`/`k` and Page Up/Down scroll, `g` follows newest arrivals, and `G`
moves to the bottom. While browsing older messages, arrivals preserve the
visible message and line offset. `r` refreshes; `q` quits. A non-TTY invocation
or `--once` prints the full bodies once. All external terminal controls are
escaped. Viewing, expanding, refreshing, and quitting create no read or
delivery receipts, register no session, and prune no state.

`mail history` returns `{kind:"session_mail_history", version:1, project,
sessionId, generatedAt, messages}`. `generatedAt` is epoch milliseconds.
Each message has `key`, `id`, `direction` (`incoming` or `outgoing`),
`timestamp` (ISO timestamp), destination `project`, `sender`,
`senderSessionId` (string or null), `recipients` (exact session IDs),
`broadcast` (boolean), `body`, and nullable `replyTo` and `threadId`.
The key identifies one project/message/direction appearance; self-addressed
mail has both appearances. Unknown broadcast recipients are left absent,
never inferred. Invalid selectors or unreadable history exit nonzero.

### Unread-mail reminders for pull-only clients

Every agent-mail MCP server reports an existing unread backlog in its initial
instructions. Antigravity CLI (`agy`), Codex, Kimi Code, and Gemini CLI have no
channel push for mail that arrives afterward. Reminder hooks close that gap:
the harness runs `agent-mail remind` on turn events, and unread counts enter
the model's context when mail is waiting. Agy, Codex, and Kimi also check once
at Stop. A newly unannounced mail edge requests one follow-up turn; unchanged
unread mail allows the session to stop. The later-arrival reminders need the
daemon, which computes the per-session unread summary. Reminder text never
includes a sender, subject, topic, preview, or body.

```bash
agent-mail hooks install
agent-mail hooks status
```

With no flag, install covers every harness whose config directory exists;
pass `--agy`, `--codex`, `--kimi`, or `--gemini` to pick one. Agy reads its
global hook file between invocations; restart other harness sessions after
installation. [docs/reminders.md](docs/reminders.md) covers the mechanism,
per-harness details, and verifying that hook output reaches the model.

### Updating and restarting

Installing the package puts the `agent-mail` command on `PATH`;
`agent-mail install` is the separate step that creates the launchd service and
registers agent-mail with Claude Code and Codex, plus Antigravity CLI, Kimi
Code, Gemini CLI, and OpenCode when their user config directories exist. It
registers whichever copy you ran it from, and with whichever runtime ran it,
so the same command works from an installed package and from a development
checkout. `agent-mail uninstall` unloads and removes the launchd service, then
removes the audit hook and MCP registrations that belong to this installation.

[docs/install.md](docs/install.md) covers the installer's edge cases: when an
existing entry is preserved, replaced, or left alone, and the plugin versus
user-scope registration conflict that silently discards channel pushes.

Restart every existing agent session after an integration change or an
agent-mail code update. Each session owns a long-running MCP process, so it
does not load new tool schemas or server code automatically.
Restart the daemon after changing daemon code:

```bash
agent-mail restart
```

Most daemon configuration changes can be reloaded with `agent-mail graceful`.
Changing the port requires `agent-mail restart` because the listening socket is
bound when the process starts.

## How delivery works

Claude Code, Antigravity CLI, Codex, and any other MCP client load the same MCP
server and use the same tools and spools. Every sender (a session, the CLI,
weft, or an HTTP client) is delivered the same way. Under the default `accept`
inbound policy, the receiving client determines when a message enters its
context. A Claude Code session with channel push enabled receives it unasked.
A pull-only session reads the body on its next `check_inbox`; reminder hooks
can inject the unread count first. A `check_inbox` call marks the messages it
returns read (pass `peek` to look without marking them). OMP steering push also
marks a message read after inserting it into the exact session's context.
`mark_read` covers mail handled from other push transports. Per-session `hold`
and `refuse` policies delay or suppress entry into context. Pull-only clients'
MCP tools still register the session, send mail, inspect peers, read and mark
inbox messages, and manage claims. Messages remain available in the project
spool after delivery.

## Coordination

Four primitives, all advisory, and all filesystem transactions rather than
daemon state:

- **Path claims** reserve names before you edit them. Existing targets use
  their observed file or directory kind; missing targets reserve a file name by
  default. Multi-file claims are atomic, and directory claims cover
  descendants. A new claim returns a one-time release token. Session claims
  survive a disconnect for 15 minutes. A research plan can own claims through
  its work lease, so transferring the lease transfers release authority.
- **Work leases** record which session is responsible for a logical unit, such
  as executing a research plan. A lease does not block unrelated file edits.
- **Experiment numbers** (`EXP-NNN`) are allocated atomically against a lab
  notebook, counting both existing files and outstanding reservations.
- **Obligations** record who owes whom a specific outcome. Unlike the other
  three they are machine-global rather than per-project;
  [Obligations](#obligations) below covers them.

The daemon reminds a live session when a claim reaches a condition or age
milestone: a materialized experiment reservation after 15 minutes, any claim
after 2 and 8 hours, and then daily starting at 24 hours. Reminders are
addressed only to the exact owning session. Work leases carry explicit activity
instead.

`list_coordination` shows all four together, with owners and conditions.
`recover_coordination` releases a record after revalidating its lifecycle.
Forced recovery requires user-supplied `authority` and `reason` values;
agent-mail records both in an audit log.
[docs/architecture.md](docs/architecture.md#coordination-claims) specifies
conflicts, ownership, release, recovery, and work-lease transfer.

Inspect one session's work and full plan files with
`agent-mail work tui --session ID --project /absolute/project`.
Both selectors are explicit: the view matches the exact originating session ID
and canonical project, including leases retained across restarts. It reads
without starting a daemon, pruning records, or changing claims. `--once` emits
one plain-text snapshot; redirected input or output does the same. A session
with no claimed work sees the project's active, proposed, and backlog plans from
`lab-notebook/plans/` instead, each marked with any `research-plan` lease that
holds it.

In a terminal, use `n`/`p` to select a lease, arrows or `j`/`k` to scroll,
Page Up/Page Down or Space for pages, `g`/`G` for the start/end, `r` to refresh,
and `q` or Ctrl-C to quit. The view refreshes every two seconds and on resize.
It labels freeform text **Current activity** and missing position **unreported**.
Created/updated ages describe persisted lease reports, not owner liveness.

`work acquire` and `work update` accept `--step N`, optional `--steps TOTAL`
and `--step-label TEXT`, or `--clear-progress`. These are explicit position
reports; checkboxes and activity prose never infer a step. Omitting all position
flags preserves the prior report; supplying `--step` replaces it in full.
See [work command details](docs/cli.md#work-tui) for source-reading limits
and the equivalent MCP metadata.

### Obligations

An obligation is a session's public record that someone owes it a specific
outcome. It is announced, not negotiated: the waiting session (the obligee)
creates the record and closes it; the obligor can contest it — a tag, never a
closure — but cannot confirm or delete it.

The obligor is one of:

- **a session**, which must be live, and receives exactly one notice;
- **you, the human operator** — never pushed anywhere; the `owed` view is how
  you see these;
- **a system** with its own events: `claims` or `weft`;
- **a role**, resolved to one responsible session when it is read: a
  component's owner (see `project_owner`), a research plan's current executor,
  or an experiment's claimer.

A record owed by a system or a role cannot be contested, because evidence
settles it rather than anyone's say-so:

| Kind | Settles when |
|---|---|
| `claim_release` | the referenced claim releases, inside the release transaction |
| `job_completion` | weft reports the job finished, through `agent-mail notify` |
| `decision`, `review`, `external_fix` | the obligee closes it with the outcome |

Open issue-ledger issues need no announce: every open issue already **is** an
obligation, owed by the owner of the issue's component. The daemon snapshots
`issues list --json` once a minute and every obligation view projects the
open issues from it as read-only `issue:<id>` rows tagged `[issue-ledger]` —
`obligations list`, `coordination list --all`, the dashboards, and the
per-session `waiting`/`owed` counts all include them. A session named by an
`agent-mail:<session-id>` watcher token on the issue is its obligee; an
unwatched issue is still owed, with no watcher. The rows settle when the
issue leaves the ledger's open listing, and the mutating verbs refuse them —
close, note, or unwatch the issue with `issues` instead. The rows are as
fresh as the last daemon refresh and absent (with a diagnostic line) when the
daemon or `issues` is unavailable.

Configure issue-ledger's watcher hook with `issues hook set watcher 'agent-mail issues watcher-token'` to record the reporting session when its host identity is proved.
Configure its event hook with `issues hook set event 'agent-mail issues event'` to notify the component owner and watchers and request an early daemon snapshot refresh.

The `obligations_*` MCP tools and the `agent-mail obligations` subcommands
share one store. `announce` creates a record with a short subject; a
Markdown `--description` carries the context, `--option` declares the choices
for a decision, and `--marker` points at evidence (a path, or a label resolved
against the obligee's lab notebook). `update` amends those presentation fields,
and `comment` appends a note from either end. `close` and `withdraw` end a
record as its obligee; `contest` tags it as its obligor.

```bash
agent-mail obligations announce --user --kind decision \
  --subject "Review packet format" \
  --description '**Finding:** A PDF export drops table labels.' \
  --option 'Tagged **PDF**' --option 'Structured export (`.json`)'
```

- `owed` lists everything open that names you as obligor, across every
  project. That view is the feature: what you owe, in one place. `state
  --json` and the status line carry the same counts per session.
- `adopt` moves an offline session's open obligations to its successor, proven
  by the host resume id or by declared operator authority.
- `clear` withdraws a record on declared operator authority — recorded, never
  verified — typically for a contested record the obligee will not withdraw.

[docs/cli.md](docs/cli.md#obligations) documents every subcommand, and
`specs/obligations.allium` is the full contract.

## Configuration

`~/.config/agent-mail/config.toml` holds the port, the Slack echo and
dashboard settings, session aliases, the inbound policy, and the rate,
deduplication, and expiry limits.
[docs/configuration.md](docs/configuration.md) is the reference.

### Connecting to Slack

An incoming webhook can mirror messages into a Slack channel. Create a Slack
app and enable [Incoming
Webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks).
Then select **Add New Webhook to Workspace**. Choose the channel that should
receive agent-mail traffic, then copy the generated webhook URL. Treat this
URL as a secret. Message Markdown is translated to Slack's `mrkdwn`, including
headings, emphasis, lists, code, and links.

Add the URL to `~/.config/agent-mail/config.toml`:

```toml
slack_webhook = "https://hooks.slack.com/services/..."
slack_echo = "all"
```

`AGENT_MAIL_SLACK_WEBHOOK` can supply the URL instead. Reload the daemon and
send a test message:

```bash
agent-mail graceful
agent-mail notify --project "$PWD" --from cli --message "Slack connection test"
```

The webhook is enough for per-message echoes. The editable Slack dashboard
also uses the Web API. Add the [`chat:write`
scope](https://docs.slack.dev/reference/scopes/chat.write/) to the Slack app,
reinstall the app in the workspace, and invite its bot to the target channel.
Copy the Bot User OAuth Token and the channel ID into the same config file:

```toml
slack_bot_token = "xoxb-..."
slack_channel = "C0123ABCD"
```

Environment-variable equivalents are `AGENT_MAIL_SLACK_BOT_TOKEN` and
`AGENT_MAIL_SLACK_CHANNEL`. Post or refresh the dashboard with:

```bash
agent-mail slack-dashboard
```

### Status lines

`agent-mail status-line` prints this session's display name, whether or not
anyone else is in the project. Agents can use the display name as an address
when it is unique in the target project; `list_sessions` also reports the full
name and session ID for unambiguous routing. The command prints the name this
session is actually registered and reachable under — see
[identity resolution](docs/status-line.md#project-and-session-resolution) for
why the two can differ. It prints nothing when it cannot resolve a session ID,
when the session has no registered channel server (so peers could not reach it),
or when it cannot tell which registration in the project is its own. `--debug`
says which, and `agent-mail logs --lifecycle` shows when channel servers attach
and go away.

`--json` returns the version-1
[session status document](docs/http-api.md#session-status), including
authoritative `nameNoun`, separate exact-project/session `running` and
`unprocessed` Weft counts, and `work` without an extra flag. Missing job data
is `null`; observed zero is `0`. An unresolved identity prints JSON `null`.
Collection errors exit nonzero with a diagnostic on stderr. The older name
and `--fields` modes retain their existing behavior.

`--fields` prints one tab-separated line instead: the name, peer count, unread
messages, delivery mode, and unprocessed weft jobs this session submitted. The
delivery field is `push`, `pull`, `unknown`, or empty when no registered session
can be identified. A status line can then show all five from a single
invocation, rather than reimplementing agent-mail's registry and spool
semantics in shell. Fields are only ever appended, so a consuming script can
split positionally.

`--fields --work` opts into a sixth, versioned JSON field containing the
resolved session's logical-work leases. Status widgets can use it to show an
executing research plan or autonomous loop without reading agent-mail's private
state or parsing human-readable coordination output.

#### Claude Code

It reads Claude Code's [statusLine](https://code.claude.com/docs/en/statusline)
JSON payload on stdin, taking the session ID and project directory from it. Add
it to your status line script:

```bash
#!/bin/bash
# Claude Code closes stdin when it is done, so `cat` returns. The tty check
# keeps a manual invocation from blocking.
input=""
[ -t 0 ] || input=$(cat)

cwd=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // empty')

# Forward the payload already captured because stdin was consumed above.
session=""
if [ -n "$input" ] && command -v agent-mail >/dev/null 2>&1; then
    session=$(printf '%s' "$input" | agent-mail status-line 2>/dev/null)
    [ -n "$session" ] && session=" · $session"
fi

printf '%s%s\n' "${cwd/#$HOME/\~}" "$session"
```

```
~/code/agent-tools/agent-mail · Quiet Lantern
```

Then point `statusLine` at it in `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "bash ~/.claude/statusline.sh" } }
```

#### Kimi Code

Kimi Code supports an external status-line command through `[status_line]` in
`~/.kimi-code/tui.toml`. Its native `sessionId` is not the identity registered
by the agent-mail MCP process. Launch Kimi through a wrapper that exports a
fresh `AGENT_SESSION_ID`; the MCP server and status-line command inherit that
same value. Without it, the example omits agent-mail identity and mailbox
fields instead of joining unrelated IDs.

Copy the checked-in formatter from a clone of this repository:

```bash
install -m 755 examples/status-lines/kimi.sh ~/.kimi-code/statusline.sh
```

Then configure Kimi:

```toml
[status_line]
command = "bash ~/.kimi-code/statusline.sh"
```

Run `/reload-tui` or restart Kimi. The formatter shows the agent-mail name,
delivery mode, unread messages, unprocessed weft jobs, and peers:

```
Quiet Lantern ↻ · 2 unread · 3 unprocessed · 1 peer
```

Kimi renders only the first stdout line. It caps the command at 300 ms and
falls back to its built-in footer on failure, so the example uses only one
external process.

#### Clients without an external status command

OpenCode, Codex, and Gemini can run the agent-mail MCP server, but their native
footers do not currently accept an external command or custom agent-mail field.
Gemini and Codex can show their own session identifiers; those identifiers are
not substitutes for the agent-mail display name or mailbox fields.

Agy, Codex, and Gemini (and Kimi, alongside its status line) can still learn
about unread mail without polling: `agent-mail hooks install` registers a
per-turn hook that injects unread counts into the model's context.
[docs/reminders.md](docs/reminders.md) covers setup.

[docs/status-line.md](docs/status-line.md) specifies the `--fields` output and
the separate Claude Code and Kimi Code payload and rendering constraints.

## Dashboards

The read-only dashboard is off by default because it exposes every project's
session and message metadata to local processes. Both dashboard forms require
the local CLI and `dashboard = true` in
`~/.config/agent-mail/config.toml`. Run `agent-mail graceful` if the daemon is
already running so it picks up that setting. The daemon then serves the
dashboard at `http://127.0.0.1:8377/`, showing live sessions, coordination
health, sender-to-recipient traffic, and a flight log. `agent-mail dashboard
--open` opens it; when the daemon is down, the same command starts a
filesystem-backed fallback server. `agent-mail slack-dashboard` posts the same
summary into Slack and edits that message in place on later runs, which needs
the bot token rather than the webhook.
[docs/dashboards.md](docs/dashboards.md) covers both.

## Security

The daemon binds 127.0.0.1, so any process running as the local user can submit
text. All inbound mail is explicitly marked untrusted and cannot approve
permissions or override the receiving session's rules. Use `hold` or `refuse`
for sessions that should not accept agent-mail automatically, and do not expose
the port.

## When to use Claude Code's built-ins

Claude Code ships two things that overlap with agent-mail.

**[Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)**
(`ListAgents` and `SendMessage`, Claude Code 2.1.224) sends a message to a
named, running Claude session on the same machine. It needs no daemon and no
configuration. For a direct message to a live Claude session, use it with the
name or id returned by `ListAgents`. Agent-mail display names such as `Quiet
Lantern` are a separate namespace and resolve through `list_sessions` and
`send_mail`, not native `SendMessage`.

**[Agent teams](https://code.claude.com/docs/en/agent-teams)** (experimental,
off by default) let one session spawn teammates that share a task list and
message each other through per-agent mailboxes, with file locking on task
claims. For parallel work you are launching now, under one lead, in one
project, use it.

Use agent-mail when the shape is different in one of these ways:

- **You started the sessions yourself.** Agent teams have a
  lead and teammates for the lead's lifetime, one team per session. agent-mail
  addresses peers that started independently, in their own projects, with no
  hierarchy and nothing to promote or transfer.
- **Not every endpoint is Claude Code.** Antigravity CLI, Codex, Kimi Code,
  and Gemini CLI sessions use the same tools and inboxes. So do the CLI, weft,
  and any HTTP client.
- **The recipient can be offline.** Unless it expires, a project broadcast
  waits in the inbox for a future session to retrieve with `check_inbox`. A
  message addressed to a known session remains available to that same session
  ID if it disconnects and later resumes, unless it expires. A team's config is
  removed when its session ends.
- **The unit of coordination is a file or a plan, not a task.** Path
  claims express edit exclusion, work leases express who is responsible for a
  logical unit, and the two are deliberately separate.
- **The traffic is inspectable.** agent-mail keeps unread state,
  threads, and receipts, echoes to Slack, and serves dashboards.

Where Claude Code's built-ins overlap with agent-mail, they are the better
choice: they need no daemon, no channel flag, and no second inbox to reason
about. If your sessions are all Claude Code, all spawned together, and all
still running, you probably do not need this.

### Auditing native SendMessage

The transports coexist: by default a native `SendMessage` does not pass
through agent-mail, so it does not appear in the spool, Slack, or dashboards.
Install the optional audit hook with `agent-mail install --native-audit` to
record successful native `SendMessage` calls in the sender's
agent-mail log and Slack echo. Audit records are never delivered through an
agent-mail inbox, which prevents the hook from creating a second delivery or a
message loop. The hook observes all `SendMessage` calls, including subagent and
agent-team messages, and records the destination exactly as Claude supplies it.
It is added to `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`)
without replacing other hooks.

## Reference

- [docs/cli.md](docs/cli.md) — every subcommand and flag. `agent-mail help`
  prints a compact version of the same listing.
- [docs/configuration.md](docs/configuration.md) — every config key.
- [docs/status-line.md](docs/status-line.md) — status-line client adapters,
  `--fields` output, and timing constraints.
- [docs/http-api.md](docs/http-api.md) — the daemon's HTTP endpoints, for
  automations that should not shell out to the CLI.
- [docs/automation.md](docs/automation.md) — the read-only machine-readable
  state outputs.
- [docs/install.md](docs/install.md) — what the installer preserves, replaces,
  and leaves alone.
- [docs/architecture.md](docs/architecture.md) — how agent-mail works
  underneath.
- [docs/decisions/](docs/decisions/README.md) — why it works that way.

## Development

Development setup, the Bun/Node runtime split, and the build are in
[DEVELOPMENT.md](DEVELOPMENT.md).
[docs/architecture.md](docs/architecture.md) covers how agent-mail works
underneath.

## Related projects

[agent-lore](https://github.com/osteele/agent-lore) is a related project:
mail carries something one session needs to tell another now, while lore is
where a session records what it worked out for whoever comes next. If you
find yourself sending the same explanation to a third agent, that is the
boundary.

[issue-ledger](https://github.com/osteele/issue-ledger) is a local issue
ledger shared across projects, with its `issues` CLI. Every open issue is an
obligation owed by its component's owner, projected into the obligation views
from the daemon's once-a-minute `issues list --json` snapshot — nothing is
stored or announced. The integration is optional: without the daemon or the
`issues` binary, the listings print a diagnostic and omit the rows.

Both sit in a wider set of agent infrastructure, listed at
[osteele.com/software/agent-tools](https://osteele.com/software/agent-tools).

## License

MIT. See [LICENSE](LICENSE).
