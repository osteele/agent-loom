# Automation and machine-readable state

These interfaces do not scan processes, prune registrations, or mutate mail,
claims, or leases. Aggregate state maintains a disposable index; its writes
change no delivery or coordination records.

## The presence snapshot

The daemon republishes the pid-verified live registry to
`~/.claude/agent-mail/presence.json` every 10 seconds. This snapshot lets
latency-sensitive readers skip the process scan. It is a presentation cache
with a 30-second TTL, never a routing input.
`send_mail`, `list_sessions`, and both dashboards keep reading the registry
directly. That tick is also what prunes registrations whose process has exited.

Automation should use
`agent-mail listeners --project <dir> --no-sync --json`, not read the snapshot
file directly. The command returns a versioned JSON object with `source`,
`fresh`, `generatedAt`, and raw `sessions` (including `sessionId`, `cwd`,
`client`, `capabilities`, `inboundPolicy`, `muted`, `lastSeen`,
`lastInboxPoll`, and `started`).
`--no-sync` never scans processes, prunes registry entries, or falls back to a
different source. If the daemon snapshot is missing, malformed, or older than
30 seconds, it returns `fresh: false` with an empty `sessions` array. This mode
is suitable for conservative advisory routing; it is not proof of delivery or
attention.

## Aggregate state

For a normalized cross-surface view, use
`agent-mail state --no-sync --json` (optionally `--project <dir>`) or
`GET /api/v1/state?project=<dir>`. Schema version 1 includes normalized
presence with process identity and freshness, coordination entries with owner
status and conditions, transfer requests, recent canonical message IDs and read
state, routes, counts, logs, open-obligation summaries, and source provenance.
The CLI without `--no-sync`
asks the daemon first and falls back to the same filesystem-snapshot reader.
Consumers must inspect the `freshness` fields rather than treating an old
snapshot as negative liveness evidence.

Schema-v1 top-level fields are `schemaVersion`, `generatedAt`, `source`,
`freshness`, `totals`, `presence`, `coordination`, `transfers`, `messages`,
`routes`, `log`, `volume`, `obligations`, `obligationRecords`, and the
compatibility `work` projection. `messages`
contains the newest 60 records in newest-first order; totals, routes, and volume
are computed from the full spool history. Additive fields may appear within
version 1; removing or changing the meaning of a field requires a new schema
version and endpoint.

Aggregate state reads `~/.claude/agent-mail/message-index.sqlite`, an
incremental SQLite projection of the project JSONL spools and append-only read
markers. The spools remain authoritative. Each state request indexes newly
appended complete lines before returning; a missing index is built from the
spools, and a truncated, replaced, or removed spool rebuilds the projection.
The first build can take longer than subsequent requests. This cache is shared
by the CLI and daemon, so `--no-sync` stays current without an HTTP request.

A request reads the new bytes and resolves project paths before it takes the
index's write lock, and holds the lock only to insert what it read. The
inserts apply only if no other request committed since it read the index's
cursors; otherwise it reads again from the new cursors, so concurrent requests
never count a line twice or roll back each other's work. A request that cannot
get the lock within 5 seconds, because another process holding it has stalled,
or that loses that race three times running, does not fail. It answers from the last committed projection and reports
`freshness.messages: false`; totals, routes, volume, `log`, and `messages` may
then omit the newest messages and read marks, which the next request picks up.

### Change signal

`agent-mail state --revision` (or `GET /api/v1/state/revision`) prints
`{kind:"agent_mail_state_revision", version:1, digest, generatedAt}` in a few
milliseconds. The digest covers the identity (inode, size, mtime) of every file
aggregate state is built from: message spools, read logs, claims, work leases,
transfers, obligations, the session registry, Claude's session status files,
session-name assignments, and the config's alias table. It also covers the content and
freshness of the daemon's presence, process, and ledger snapshots, but not
their per-tick timestamps. It also covers the message index's files, which change
when an ingest commits. Compare digests for equality only; an unchanged digest
means `state --no-sync` would read the same inputs. A poller reads the revision
often and the full state only when the digest changes. A state read that
ingests new mail moves the digest itself, so expect one extra read after each
change. When a state read reports `freshness.messages: false`, re-read state
on the next revision poll even if the digest has not moved.

Two kinds of change do not move the digest. Time alone: a manual owner
expires, an age advances. And coordination conditions derived from files
outside agent-mail's state: an experiment file appearing in a notebook, or a
work lease's source path disappearing. Keep a slow reconciliation read
(minutes) alongside the revision poll to pick those up. No
process sees every write, so the revision is derived from the files rather
than counted, and it has no ordering: a later digest is not "greater".

`obligations` summarizes open obligation records: `waiting` counts records
this session is the obligee of, `owed` counts records naming it as session
obligor, `roleOwed` counts obligor roles resolving to it, `unresolvedOwed`
counts obligor roles resolving to nothing, and `humanOwed` is the operator's
global owed count. `obligationRecords` carries those open records flat, with
both ends resolved: each party carries `label`, `partyKind`, `roleKind` for
roles, `resolution` (resolves or unresolvable, with a `reason`), and, where
the party has a project, `project` with the `projectBasis` that produced it
(`registered`, `plan`, `ownership`, `claim`; human and system parties have
none). Sessions also carry `sessionId` and `live`. Grouping by project is the
consumer's job; the resolution and its provenance are agent-mail's.

`ledgerObligations` carries the open issue-ledger issues projected as
read-only obligations (`issue:<id>`), each with its component, resolved
component-owner obligor, watcher-session obligees, and the snapshot's
`observedAt` with a `stale` flag; `ledgerDiagnostic`, when present, explains
why the projection is missing or degraded. The summary counts above include
them: an issue adds to its owner's `owed` and each watcher's `waiting`.

Each `obligationRecords` entry has a short identifying `subject` and, when
provided, an optional `description` containing multiline decision context.
`options` names declared choices, `markers` holds typed path or label evidence
pointers, and `comments` holds appended discussion. `description` is additive
within schema version 1 and is absent on records without context.

## What presence and receipts prove

For poll-only sessions, `lastSeen` means only that some agent-mail tool ran; it
does not imply that the inbox was checked. `lastInboxPoll` is stamped only by
`check_inbox`, including an empty check, so automation can distinguish recent
polling from unrelated activity. It still predicts only that the session may
poll again. For a message already sent, `agent-mail receipts --id <message-id>`
distinguishes `pushed` (channel delivery or an inbox pull) from `read` (a
`check_inbox` pull, an explicit mark-read, or protocol-v3 OMP steering
acknowledgement after exact-session context insertion); neither status proves
that the recipient completed the requested work.

## The unread summary and reminder state

The daemon writes `~/.claude/agent-mail/unread-summary.json` on the same
10-second tick as the presence snapshot: per-session unread counts with the
newest visible message id and timestamp, omitting muted sessions, under a
30-second TTL. It is a presentation cache with the same rule as
`presence.json`: never a routing input. Its intended consumer is
`agent-mail remind`, which treats a missing or stale snapshot as unknown
rather than as zero unread. See [reminders.md](reminders.md).

Reminder bookkeeping lives in
`~/.claude/agent-mail/announced/<slug>-<sessionId>.json` and records which
newest-message id a session was last reminded about, plus a reminder count
and timestamps. Announced state is not a delivery receipt: a reminder
delivers nothing, so `announced/` never feeds `receipts/`, and `pushed`
continues to mean channel delivery or an inbox pull only. Automation that
needs delivery evidence keeps reading `receipts/`.

Daemon backlog reminders have a separate two-hour cooldown for each canonical
project and session ID, shared by that mailbox's MCP and push registrations.
Their bookkeeping is `~/.claude/agent-mail/ack-reminders.json` (version 2).
Version-1 cooldowns are discarded because they lack project identity. Upgrading
can repeat one reminder per mailbox; it does not change message read state.
