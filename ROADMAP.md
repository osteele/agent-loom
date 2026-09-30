# Roadmap

Planned and in-progress work. Shipped items are removed from this file (the
git log is the record of what's done).

## Rename to agent-loom

Decided 2026-09-30 (`docs/decisions/log.md`); not yet carried out. The name
describes one feature of a tool that now also carries session identity, claims,
leases, experiment numbers, and obligations. Messaging keeps the name "mail".

- Inventory every surface first: GitHub repository and the `npx add-mcp
  github:osteele/agent-mail` install line; the MCP server name `agent-mail` in
  each client config (and the `mcp__plugin_agent-mail_agent-mail__*` tool
  prefixes that permission allowlists match); the Claude plugin id; the
  `agent-mail` CLI; `~/.config/agent-mail`, `~/.claude/agent-mail` state, and
  the launchd label `com.osteele.agent-mail`; `AGENT_MAIL_*` environment
  variables; hooks and status-line scripts; the `agent-mail-triage` skill;
  weft's notify integration; issue-ledger hooks (`agent-mail issues ...`);
  lore and the global agent instructions.
- Follow the agent-review rename (2026-08): read the old names alongside the
  new ones for a bounded transition, record an old-to-new lookup table, then
  retire the old names once no configured client or environment uses them.
- Rename state and config directories with a compatibility symlink rather than
  a copy, so a session on an old build and one on a new build share one store.

## Additional coding agents

- Add MCP registration adapters for other mainstream coding agents as their
  config formats stabilize. Each adapter needs presence detection, additive
  install and ownership-safe uninstall, conflict diagnostics, schema fixtures,
  and documentation of any session-identity or notification limitations.

## OpenCode push delivery

OpenCode is the one pull-only harness with a real out-of-band path into a live
session: `opencode serve` exposes `POST /session/:id/prompt_async` (the TUI
itself runs such a server, on a random port unless configured). That is much
closer to Claude's channel push than the hook reminders shipped for Codex,
Kimi, and Gemini — if the delivery semantics hold up.

- **Spike first.** Verify what `prompt_async` actually does to a running
  session: does the prompt land mid-turn, queue to the next turn, or require
  an idle session? Does it work against the TUI's own server, and what does
  `opencode run --attach` change? The design below assumes the spike answers
  "queues a turn against the live session"; revisit if it doesn't.
- **Endpoint registration.** A pinned port collides with concurrent OpenCode
  processes, so `agent-command-guards`' launcher needs dynamic port allocation
  plus registration of the endpoint in the agent-mail registry (alongside
  `capabilities`/`inboundPolicy`), or a shared long-lived server that sessions
  attach to.
- **Auth is mandatory.** A localhost endpoint that injects prompts into a live
  session is an attack surface; registration must carry a credential, not just
  a port.
- **Fixed system-authored payload only.** `prompt_async` creates something
  resembling a user prompt, so peer-authored mail text sent through it would
  be upgraded into user authority. Push only a fixed "you have unread
  agent-mail; call `check_inbox`" notification — the same
  harness-owned-facts-only rule as the hook reminders (decision 0008).
- **Fallback:** an OpenCode lifecycle plugin
  (`experimental.chat.system.transform`) if push proves unworkable; plugin
  hooks still cannot inject AI-visible messages directly
  (anomalyco/opencode#17412).

## Cross-harness wake and Hub integration

- **Lifecycle capabilities.** Separate activity age from harness lifecycle and
  delivery support. Sessions should report whether their adapter can notify an
  attached process, start a turn, or reconstruct a disposed session. Delivery
  status should preserve the distinction between durable mail state
  (`spooled`, `pushed`, `read`) and host outcome (`notified`, `woke`,
  `revived`).
- **Parked-session revival.** Extend the OMP adapter when OMP exposes a
  versioned host API that can enumerate and revive a native session by exact
  ID. The host should reconstruct the session and inject the message; agent-mail
  must not read OMP's private registry or transcript files. Other harness
  adapters should advertise this capability only when their supported APIs
  provide it.
- **Bounded reply waits.** Add a wait operation filtered by thread and sender.
  A timeout must leave the reply unread, and the wait must never consume
  unrelated inbox messages.
- **Native Hub visibility.** Offer a separate, read-only mail-peers and
  coordination section in compatible harness UIs. Preserve agent-mail and
  native-agent namespaces, show source age and failures, and consume a
  versioned agent-mail interface.
- **Explicit transport choice.** Let a user choose native immediate messaging
  or durable mail when an exact identity mapping exists. Never fall back
  automatically because a race could deliver the same instruction twice.
- **Native-message audit.** Allow opt-in recording of successful Hub messages
  in the flight log and Slack echo without appending them to an agent-mail
  inbox. Body retention must remain configurable.
- **Coordination in native inspectors.** Show path claims and work leases beside
  native agent activity. Keep task assignment, logical work ownership, and edit
  exclusion as separate facts.

## Storage evolution

The filesystem store remains suitable at the current scale. Append-only JSONL
spools are easy to inspect and repair, isolate failures by project, support
file-tail delivery, and let every entry point operate when the daemon is down.
Current limits include whole-log inbox and dashboard queries, admission checks
that can race between direct writers, separate message and receipt appends, and
registry updates that rewrite whole JSON documents.

Do not replace the spools wholesale yet. Evolve the storage layer in stages:

- **Storage interface:** isolate message, receipt, read-state, registry, and
  claim operations from their on-disk representations.
- **Filesystem hardening:** make registry updates atomic and safe against
  concurrent field updates. Retention is no longer prospective — see below.
- **Rebuildable SQLite index:** project the JSONL logs into a disposable SQL
  read model keyed by file and byte offset. Use it for dashboards, threads,
  receipts, history, and aggregate queries. JSONL remains authoritative, so the
  index can be deleted and rebuilt without recovery work.
- **Migration criteria:** consider making SQLite authoritative when agent-mail
  needs exact transactional admission, efficient retention, session-specific
  unread state, or handoff and lease state machines. Scan latency or background
  query cost becoming noticeable is also a migration signal.

If SQLite becomes authoritative, use Bun's built-in `bun:sqlite` with one local
database, WAL mode, foreign keys, a busy timeout, short transactions, and
versioned additive migrations. The daemon, CLI, channel servers, and dashboards
must continue opening the store directly; SQLite must not turn the daemon into
a required broker. Keep flexible message metadata as JSON while indexing fields
used for routing and queries. Add export, backup, integrity-check, and legacy
import commands, and retain the old files as a read-only rollback until the
import is validated.

Keep config, PID, and log files outside the database. Leave claims on their
existing project-scoped filesystem transactions until leases or richer workflow
state justify moving them. Decide whether read state belongs to a project or to
each session before defining the SQL schema.

### Spool retention

Inbox spools and receipt logs are append-only with no rotation, pruning, or
truncation anywhere in the codebase. They are 9.4 MB and 1.0 MB respectively,
and both grow monotonically for the life of a project.

Per-tick cost no longer scales with them — the poll path reads the archive only
when something is held, and the receipt log through an incremental cursor — so
this is now about disk and about one-shot readers (`check_inbox`, dashboards,
`delivery_status`), which still parse whole logs and get slower forever.

Retention is also the only lever that reaches an already-running listener. A
listener re-reads from disk each tick, so shrinking a file makes the process
cheaper immediately, with no session restart. Sessions idle for days never
restart on their own, so a code fix alone leaves their cost in place.

Constraints, all load-bearing:

- **Daemon-owned**, on its own slow timer rather than the 10s presence tick,
  taking the same per-project lock as admission. Listeners must not rotate:
  dozens of them racing on one file is worse than the growth.
- **Rotate, never delete.** Old lines move to a dated archive file. This is
  durable mail, and silently destroying it is a worse failure than disk use.
- **Messages and their receipts move together.** Pruning receipts alone strips
  a retained message's evidence that it was already delivered, and it gets
  re-sent.
- **Design out the offset collision.** A listener treats `size === offset` as
  "nothing new", so a rotated file whose size coincides with a live listener's
  offset leaves that listener parsing later appends from a wrong position — a
  torn read rather than a missed message. Roughly 1-in-filesize, but reachable
  only once rotation exists, so it has to be handled as part of it.

Re-delivery is already safe: a listener resets its offset when the file shrinks
and re-reads, but `decideNewMessageDelivery` skips anything already settled for
that session, and `pushed` is a terminal receipt status.

Retention thresholds warrant a decision record — they are exactly the kind of
choice a later contributor reverses by mistake.

## Session identity across agent-mail, weft, and Codex

The orphaned-jobs startup announcement is implemented but silent for every job
submitted from a Codex session, because the two tools disagree about what that
session is called.

Codex spawns its MCP child with no session env var, so `sessionIdFromEnv()`
falls through to a `randomUUID()` minted inside the channel server — the same
failure already documented for kimi and opencode, which `agent-command-guards`
solved for those by minting `AGENT_SESSION_ID` before exec. Observed: a codex
parent carrying `AGENT_SESSION_ID` whose channel child had no session variable
at all and registered under a different id, while weft recorded a third value
(the codex thread id) for jobs submitted from that same shell.

Across 1402 session ids agent-mail has named, not one matches a weft
`submitter_session`. The announcement therefore cannot prove any Codex-submitted
job is unowned, and correctly says nothing. `hasSeenSession` is what keeps that
honest — without it every such job reads as an orphan.

Fixing it means making one identity reach all three: whatever the launcher
mints must survive into the MCP child's environment *and* be what weft captures
at submit time. `SESSION_ID_ENV_VARS` here, the guard launcher's unset-and-mint,
and weft's `defaultSubmitterSessionEnvVars` already have to move together; this
adds the requirement that the value actually be present in the spawned child,
which is the part nothing currently checks.

Worth a check that fails loudly: if no live session id has ever matched a weft
submitter id, the join is vacuous and any feature built on it is silently inert.

## Native Slack threading

Threads exist in the mail layer (`replyTo`/`threadId` on every message), and the
Slack echo renders a reply's parent inline as quoted context. It does **not**
nest replies under the original Slack message, because that requires posting with
`thread_ts`, which incoming webhooks can't do.

The bot-token plumbing now exists (config `slack_bot_token` / `slack_channel`,
the Web API helper in `slackDashboard.ts`), so the remaining work is small:

- On echo via the Web API (`chat.postMessage`), persist a `threadId → Slack ts`
  mapping (a small JSON map under `~/.claude/agent-mail/`, consistent with the
  filesystem-is-the-bus invariant).
- A reply whose `threadId` is already mapped posts with that `thread_ts`; a new
  thread records the returned `ts`.
- Falls back to the current inline-quote echo when no bot token is configured.

## Presence

The registry already tracks attached sessions, protects against recycled pids,
and combines Claude Code activity with agent-mail `lastSeen` timestamps. The
CLI, MCP session listing, dashboards, and Slack routes all use the same readable
session names and busy/active/idle-age tags. The remaining work is to make that
presence data directly queryable and useful at send time:

- **`who` / presence query** — a CLI command and an MCP tool answering "who is
  live in project X right now, and what are they doing" (name, status,
  idle/working, last-seen), with project and client filters. `list_sessions` is
  the seed, but `who` should be a concise presence view rather than a transport
  capability dump. `presence.ts` already supplies the pieces: a project-scoped
  live read (`liveInProject`) and a non-stale peer filter (`peersInProject`).
- **Delivery hints at send time** — `send_mail` already notes "no session
  listening; spooled"; extend direct and broadcast results with a snapshot such
  as "delivered to nia (active)" or "2 attached: 1 busy, 1 idle 3h" so the
  sender knows whether to expect a fast reply. Keep this explicitly advisory:
  the spool, not the snapshot, defines delivery.

### Duplicate listeners under one parent

A single agent process can accumulate several live channel servers over its
lifetime — observed as three under one codex parent (aged 2d07h, 1d20h, 1d18h)
and two under another. They appear hours apart rather than in a burst, so this
is per-session-lifetime growth, independent of how many sessions exist.

Not the zombie case fixed in `isCurrentProcess`: those were three *running*
processes, each polling and each holding a registration.

Mechanism: teardown fires on signals and on `stdin` close/end. Both observed
parents were stopped (`ps stat` `T`), and a stopped parent holds the pipe open,
so a superseded listener never receives EOF, never runs `shutdown()`, and keeps
polling. On reconnect the parent spawns another server and nothing on either
side reconciles.

Likely fix: on register, a listener sharing `parentPid` and `cwd` with an
existing registration supersedes it, and the older one self-exits on its next
poll rather than being signalled — routing through the existing `shutdown()` so
its claims and work leases release instead of leaking a second resource.

**Blocked on evidence, deliberately.** The fix assumes two live listeners under
one parent are always a duplicate, and the registrations that would confirm it
were removed during a cleanup before they were captured. At least one
configuration makes the assumption false: a user-scope `mcpServers` entry
alongside the plugin has one parent legitimately spawning two agent-mail
servers. Terminating listener processes on an unverified premise is the wrong
trade — capture both registry entries from the next duplicate and check whether
they share `parentPid` and differ only in `pid` and `started`.

## Live handoff

Async mail can't express "I'm handing this task to you now, are you taking it."
A handoff is a small state machine layered on the spool:

- **Offer → accept/decline** — a message typed as a handoff carries a task
  reference; the recipient session accepts or declines, and the offerer is
  notified of the transition (not just delivery).
- **Work-lease transfer** — reuse the shipped exclusive logical-work lease for
  accepted handoffs, adding an atomic owner transfer so no third session can
  acquire the resource between release and acceptance.
- **Status echo** — handoff transitions echo to Slack as a compact status line
  (offered → accepted by <session> → done), giving a human-readable audit trail
  of which agent owns what.

Depends on **presence** (you can only hand off to a session known to be live)
and reuses **threading** (a handoff and its accept/decline are one thread).

## Visualization

The `dashboard` (web) and `slack-dashboard` commands already cover live
presence, unified coordination health, a sender→recipient traffic ranking, a
flight log, and 24h volume. The daemon serves the web monitor continuously;
the standalone command remains a daemon-down fallback. Building on the same
`dashboardData` aggregation:

- **Realtime stream** — a `/api/stream` SSE endpoint so the web dashboard
  updates on append instead of polling; edges in a force-directed graph pulse as
  messages fly (the "flight tracker").
- **`agent-mail top`** — a pure-terminal live dashboard (presence + sparkline +
  scrolling flight log) for when a browser isn't wanted.
- **Chord diagram / adjacency matrix** — replace the ranked route list with a
  matrix heatmap (scales past ~12 projects) or a chord diagram, with project and
  session-level views.
- **Sankey** — sender → recipient flow with width proportional to volume.
- **Stream graph** — stacked traffic over time banded by source type
  (weft vs. agent↔agent vs. cli).
- **Thread swimlanes** — each `threadId` a lane, messages as beads along time;
  the message→reply gap is visible latency.
- **Reply-latency leaderboard** — median message→reply time per project, derived
  from `replyTo` + timestamps.
- **Transcript reconstruction** — stitch both projects' spools for a `threadId`
  into one ordered, sender-attributed conversation view.
- **Historical replay** — a time scrubber that rebuilds the graph at any past
  moment; click a message to read it.
- **Statusline / menu-bar glyph** — unread count + a tiny traffic sparkline in
  the Claude Code statusline or the macOS menu bar.
