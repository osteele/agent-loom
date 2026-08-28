---
status: accepted
date: 2026-08-28
---

# 0013. Reading marks read: check_inbox acknowledges the mail it returns

## Context and Problem Statement

The project-global read flag — the basis of every unread count — was written
only by an explicit `mark_read` call. Delivery wrote per-session receipts
(`pushed`, on channel push or inbox pull), but the unread predicate ignores
them, so the only exit from "unread" was an acknowledgment agents were asked
to volunteer in one sentence of the server startup instructions. In practice
they never did: spools accumulated unread backlogs of mail that had been read
and acted on. Per-session receipts cannot absorb this, because session ids are
minted per conversation — every fresh session starts with no receipts and is
greeted with the full historical backlog.

An unread count that mostly counts acted-on mail stops signalling anything.

## Decision Outcome

`check_inbox` marks the messages it returns read, as it returns them. The tool
result is the one delivery the server can verify: the messages demonstrably
entered the calling agent's context. `peek=true` opts out for a look that
acknowledges nothing. The `hold` and `refuse` inbound-policy paths deliver
nothing and mark nothing.

Channel push still never marks read. A push is fire-and-forget — the server
cannot confirm the notification surfaced (`host-not-loaded` and its kin fail
silently) — and marking there would convert "possibly never seen" into
"read", the status-overclaim family of defects again. `mark_read` remains for
mail an agent handled from a push.

"Read" thereby means "was delivered into an agent's context by a pull", not
"was deliberately acknowledged". The ack semantic was already fictional; a
flag nothing sets is not a signal worth preserving.

### Consequences

- Unread counts converge on truth without relying on model discipline:
  reminders and startup backlogs funnel every harness toward `check_inbox`,
  which now clears what it delivers.
- Read state is project-global, so one session's pull hides a broadcast from
  every other session's unread count. Listening sessions got the push anyway;
  the loss is a pull-only peer sharing the directory, which no longer sees an
  unread cue for a broadcast another session pulled first.
- `check_inbox` is no longer side-effect free. Forensic tools must not read
  `read` as deliberate acknowledgment; receipts still record
  `pushed (inbox pull)` and `read` per session for finer distinctions.

## Considered Options

### Mark read on channel push

Rejected: the server cannot confirm a push surfaced, and receipts must not
assert more than they know.

### Count a session's own `pushed` receipt as settling its unread view

Rejected: per-session receipts die with the session id, which is minted per
conversation. This fixes the acting session's own counts and leaves the
durable, cross-session backlog — the observed problem — intact.

### Nudge harder: mention `mark_read` in tool output and descriptions

Rejected as the fix (retained as seasoning): the startup instructions already
asked, and compliance was approximately zero. Correctness should not depend on
agents volunteering bookkeeping.

## More Information

- **Builds on**: [0008](0008-hook-reminder-trust-limits.md) — unchanged by
  this record: reminders still write no receipts, and `pushed` still means
  channel delivery or an inbox pull.
