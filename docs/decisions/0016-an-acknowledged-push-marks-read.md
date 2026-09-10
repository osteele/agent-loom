---
status: accepted; its OMP host-acceptance clause is superseded by [0017](0017-omp-steering-injection-marks-read.md)
date: 2026-09-08
---

# 0016. Host acceptance records push, not read

## Context and Problem Statement

[0013](0013-check-inbox-marks-returned-mail-read.md) made a pull the
acknowledgement because agents rarely called `mark_read` after handling pushed
mail. The Oh My Pi bridge later added a callback that runs after
`pi.sendMessage` accepts a custom message. That callback was treated as proof
that the message reached agent context and marked it read.

The extension calls the callback immediately after OMP accepts a queued
`followUp`. It receives no signal that OMP inserted that follow-up into a model
turn. Host acceptance is useful delivery evidence, but it does not satisfy
0013's standard that the server observed the message entering agent context.

## Decision Outcome

Receipt state follows what each observation proves:

- Host or transport acceptance records a per-session `pushed` receipt.
- `check_inbox` marks the messages it returns read because those messages enter
  the calling agent's context.
- `mark_read` records an explicit disposition after an agent handles pushed
  mail.
- A future push acknowledgement may mark read only if its contract specifically
  attests context injection rather than queue or transport acceptance.

The current Oh My Pi and Claude channel push paths leave project-global read
state unchanged. Unread reporting distinguishes `pushed but unread` messages
from messages with no push receipt; the distinction must not suppress either
group.

### Consequences

- A successful Oh My Pi push can remain unread until `check_inbox` retrieves it
  or the agent calls `mark_read`.
- A `pushed` receipt remains durable evidence that the receiving host accepted
  the message without overstating what happened afterward.
- Unread counts can include mail that an agent handled from a push but did not
  explicitly mark. This preserves uncertain work instead of silently losing
  mail that may still be queued or unseen.
- Push transports use one receipt contract. Their host APIs do not define read
  state unless they expose an explicit context-delivery acknowledgement.

## Considered Options

### Treat durable host acceptance as read

Rejected: it avoids reliance on `mark_read`, but OMP accepts a queued follow-up
before the server can know whether it entered agent context. Marking read would
turn a successful handoff into a stronger claim the observation cannot support.

### Keep host acceptance and read as separate evidence

Accepted: `pushed` records the successful handoff, while `check_inbox` or
`mark_read` records the stronger disposition. This can retain already-handled
mail as unread when an agent omits `mark_read`, but it cannot erase unseen mail.

### Infer read from a reply

Rejected: replies carry an optional `reply_to`, and handled mail does not always
receive a reply. The inference would remain incomplete and dependent on caller
discipline.

## More Information

- **Clarifies**: [0013](0013-check-inbox-marks-returned-mail-read.md). A push
  transport may attest context delivery, but current host-acceptance callbacks
  do not.
