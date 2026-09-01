---
status: accepted
date: 2026-08-31
---

# 0015. Stop hooks continue once per new mail edge

## Context and Problem Statement

Codex and Kimi Code are pull-only agent-mail clients. Turn-activity hooks can
tell them that mail arrived, but mail arriving after their last tool call and
before they stop is not announced until somebody starts another turn. This is
particularly costly for delegated work: the sender believes it handed work to
a live agent while the recipient has already exited without seeing it.

[0008](0008-hook-reminder-trust-limits.md) rejected Stop-blocking because any
peer could keep a recipient alive and burning tokens by sending mail. That
threat remains real. The original decision treated "continue while unread" as
the available design, however. The daemon's unread-summary snapshot and the
separate announced-state store now provide a narrower signal: whether this
session has already been told about the newest visible message id.

Codex and Kimi both define a blocking Stop-hook response. This makes it
possible to request one additional turn for a new announcement edge without
polling, looping merely because mail remains unread, or exposing any
peer-authored text.

## Decision Outcome

Install synchronous Stop reminder hooks for Codex and Kimi. When a fresh
unread-summary snapshot contains unread mail whose newest message id has not
already been announced to the session, `agent-mail remind`:

1. writes that newest id to the separate announced-state store;
2. emits the same fixed count-and-timestamp reminder used by ordinary hooks;
3. requests one continuation through the harness's Stop-hook protocol.

The state write happens before the continuation response. If the harness
immediately reaches Stop again, the same newest id is already announced and
the hook allows the session to stop. The 15-minute time-based re-reminder used
by activity hooks is disabled at Stop; only a different newest message id can
request another continuation.

The Stop payload remains an unread count, newest timestamp, and fixed
instruction. It contains no sender, subject, topic, preview, or message body.
It writes no receipt and does not mark mail read. A missing or stale snapshot,
an unknown or muted session, an empty inbox, and every hook failure all fail
open and allow Stop.

Gemini has no corresponding Stop integration here. OpenCode remains pull-only
until it has a reliable pre-stop contract. DeepSeek Harness can consume the
Codex hook configuration through its first-party Codex hook bridge. A Pi
extension may map the same edge-triggered result to one follow-up turn; it is
an adapter, not a polling loop.

### Consequences

- A peer can cause at most one recipient continuation per newly observed
  newest-message id. A peer that sends another message after every turn can
  still cause repeated continuations. This bounded but nonzero token-burn risk
  is accepted in exchange for delegated agents noticing late mail.
- If an ordinary activity hook already announced the newest message, Stop does
  not continue for it. Announcement means only that the reminder entered the
  harness context, not that the model read or acted on the mail.
- The reminder still does not establish delivery. `announced/` remains
  presentation bookkeeping; only channel delivery or an inbox pull writes a
  `pushed` receipt.
- No timer, background polling loop, or terminal-control path is introduced.
- Muting a session suppresses both ordinary reminders and Stop continuation.

## Considered Options

### Keep Stop hooks disabled

Rejected: mail arriving at the end of a delegated turn remains invisible until
some unrelated action starts another turn, defeating the notification for the
case where it matters most.

### Continue whenever the inbox is nonempty

Rejected: an unread message would re-trigger every Stop and form an unbounded
loop. The persisted newest-id edge is the bound.

### Continue again on the 15-minute re-reminder interval

Rejected: elapsed time is useful for adding context to an active session but
is not new work. It must not manufacture another continuation for unchanged
mail.

### Include a subject, sender, or short topic

Rejected: those fields are peer-controlled and would give untrusted text a
direct path into continuation context. The fixed reminder is enough to prompt
an authenticated inbox read.

### Poll or schedule periodic inbox checks

Rejected: polling spends resources while nothing is happening and adds a
second lifecycle to supervise. Stop is already the exact boundary at which the
harness can cheaply make the decision once.

## More Information

- **Partially supersedes**: [0008](0008-hook-reminder-trust-limits.md), only its
  prohibition on Stop-blocking. Its no-receipt and no-peer-text decisions
  remain in force.
- **Builds on**: [0013](0013-check-inbox-marks-returned-mail-read.md). A
  continuation is still not a read; only `check_inbox` or an explicit
  mark-read operation acknowledges mail.
