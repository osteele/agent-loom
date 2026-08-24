# Roadmap

Planned and in-progress work. Shipped items are removed from this file (the
git log is the record of what's done).

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

## Orphaned weft jobs at session startup

Tell a session, on startup, how many unprocessed weft jobs belong to its project
and are not assigned to any surviving session. Jobs whose submitter is still
alive already get a session-addressed notification; the orphans are the ones
with no owner, and a session starting in that project is the natural inheritor.

Interface agreed with weft 2026-08-24; awaiting a weft build. Nothing here is
implemented.

**Layer division.** weft supplies job facts (owning project as a canonical path,
submitter session, disposition, counts); agent-mail supplies session liveness;
the join happens here. weft must *not* model session liveness — it cannot
observe it, and adding it would make weft a reader of agent-mail's registry,
which is exactly the private-state coupling that rots. Do not "simplify" this
later by asking weft to track owners.

**Orphaned** means the submitter session is empty *or* is not live anywhere.
Live-anywhere rather than live-in-project: a submitter alive in another project
still receives its own notice, so counting it here would double-report it.

**The two absent fields are handled in opposite directions**, which is the part
most likely to be wrongly "unified" later:

- absent `submitter_session` -> **include** as orphaned. A missing owner is
  evidence of having no owner; unattributable and unowned are the same state.
- absent `project_root` -> **exclude** from every per-project count. A missing
  project is absence of evidence about membership, and bucketing it into project
  P would invent the one fact the announcement asserts.

Unknown-project jobs are not a line in the startup announcement: that surface is
a demand, every line must prompt something the reader can do now, and a job of
unknown project cannot be acted on in P's context. They belong on a diagnostic
surface that reports a level. They must not be silently dropped either — the
aggregate emits them as an explicit bucket so "none exist" stays
distinguishable from "never seen".

`project_root` is backfilled for legacy rows by a *derivation*, not a guess:
expand `working_dir`, realpath, walk up to the repo root, and accept it only if
that root's basename equals the recorded `project`. Measured coverage 6092 of
6231 tilde rows; the ~139 rejected are genuine overrides and vanished
directories, which stay NULL and land in the unattributable bucket. The bucket
is therefore small at rollout rather than total, and the announcement is useful
from day one.

The basename check is load-bearing and must not be removed as redundant. It is
*not* corroboration between independent facts: `ResolveProjectName` returns
`filepath.Base(ProjectDir(dir))`, so for non-override rows `project` is a
function of the same input the derivation walks. What it verifies is that the
project name recorded at submit time still equals the basename of the repo root
this job's `working_dir` leads to today.

    rejects  an override, where `project` names a tree the path does not lead to
    rejects  a path that no longer resolves to a same-named repo root
    accepts  a job run in a SUBDIRECTORY of its project — `project` was already
             the repo-root name, never the directory basename (11 such rows)

The subdirectory behaviour is intended, not a leak; do not "fix" it. Dropping
the check entirely would silently readmit every override. Two repos sharing a
basename stay safe because the root is derived from this job's own
`working_dir` rather than looked up by name.

**Source of truth is weft's session-inbox contract**, `weft session unprocessed`
(versioned envelope, `version: 1`), *not* `weft list jobs --unprocessed`. The
two disagree by 13 of 21 rows: `IsInboxJob` excludes canceled and killed, which
is the action-uniformity rule expressed as a contract. `list --format json`
reports a rendered display label (`completed ok`, with a space) that is not safe
to depend on. Migrate the existing daemon snapshot to the same contract rather
than publishing two numbers that disagree about what "unprocessed" means.

**Disposition cuts on observables, never on weft's attempt status.** Every value
below is derived from whether an exit code exists and whether it was zero,
because that is the part of the record that does not drift:

    completed_ok      exit 0                         bookkeeping
    completed_error   exit != 0, any attempt status  read the program's output
    no_exit           no exit code recorded          look at weft or the host
    dead                                             weft concluded the job is gone

`dead` stays its own line rather than folding into `no_exit`: it never carries
an exit code, but it means something more specific than "no exit recorded".

The attempt status is unusable for this. Among non-zero-exit attempts, 6030 of
6645 have no specific `failure_reason`, and the same queue-runner marked those
`completed` (2715) and `failed` (2178) over the same 175-day span. The marking
carries no information for that 91%, so a `failed` line meaning "look at weft or
the host" would have been unfounded for 83% of the rows it covered — sending
someone to the host for something their own program did.

Two traps recorded so they are not re-derived:

- **Do not write a reconciliation check between `counts` and the per-job
  `status`.** They agree. The `job_status` view remaps a non-zero exit to
  `failed` before `EffectiveStatus()` sees it, so the `StatusCompleted` branch
  in `IsFailedJob` is unreachable through this path — zero rows, not a
  discrepancy to guard against.
- **Do not build an infra-vs-program classifier from `failure_reason`.** The 614
  specific reasons include `exit_2` and `exit_127`, which are program exit codes
  in a field that otherwise names infrastructure (`oom`, `disk_full`,
  `infra_prewarm_download_failed`). "Has a reason" is not an infra predicate.
  That judgement belongs in weft's triage surfaces, which carry the full
  `failure_reason`, not in a four-value announcement.

**Report by disposition, never as one integer.** A single count filtered only by
project and ownership reproduces the defect of the advisory it replaces: a
number dominated by low-urgency rows with the one genuine failure invisible
inside it. The test is whether every item in a count deserves the same response
latency. Treat an unrecognized disposition as "unknown disposition" and show it,
rather than discarding a row the breakdown has no line for.

**Efficiency: delete the 60s poll, do not optimize it.** The current
`weft list jobs --unprocessed` refresh is a full table scan over ~6400 rows and
growing, with no index on project or on the unprocessed predicate. weft is
adding a grouped aggregate keyed by (project_root, submitter session,
disposition), computed in SQL, so agent-mail stops shipping and re-bucketing
every row every minute. Raw session ids are required in that output — the
liveness join cannot run against an aggregate that has collapsed them.

**Hazard to verify on arrival:** weft's `idx_jobs_submitter_session` is partial
(`submitter_session IS NOT NULL AND != ''`) and therefore excludes exactly the
unattributed rows that *are* the orphans — 11 of 21 when sampled. A grouped
query relying on that index returns a count that is plausible, small, and wrong,
and a too-low orphan count looks like good news. Check this explicitly against a
known-unattributed job before trusting the first numbers.

**The grouped document** is a distinct kind, refusable on either axis:

    {"kind": "unprocessed_groups", "version": 1,
     "scope": {"state": "all_sessions"},
     "groups": [{"project_root": ..., "project": ..., "submitter_session": ...,
                 "unattributed_session": bool,
                 "dispositions": {...}, "total": N}]}

`scope.state` is `all_sessions` by construction — the grouped path never reads
the caller's session id, so there is nothing for it to inherit. Ungrouped
`weft session unprocessed` stays `version: 1` with `project_root` added
additively.

**Canonicalize `project_root` at read time anyway.** weft canonicalizes at
submit time, which does not survive the project moving afterwards — this repo
has carried live registry entries under both `code/utils/agent-mail` and
`code/agent-tools/agent-mail`, one a symlink to the other. Compare
`canonicalProject(project_root)` against `canonicalProject(P)` rather than
string-matching a value that was canonical when it was written. A genuine move
is unrecoverable; a symlink is not, and realpath at read time handles it.

**Delivery split.** weft is separating the broadcast-safe completion notice from
the session-scoped count, so agent-mail is no longer handed one opaque string
with a safe half and an unsafe half. The completion notice keeps the existing
project-broadcast fallback. The session-scoped count gets **no** fallback: if
the submitter is not listening it is dropped, because a "this session has N"
sentence delivered to anyone else is false by construction. A lost count is
recoverable from the inbox on demand; a confident false claim is not recallable
once read.

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
