---
status: accepted
date: 2026-09-08
---

# 0016. An acknowledged push marks read; a fire-and-forget push does not

## Context and Problem Statement

[0013](0013-check-inbox-marks-returned-mail-read.md) made a pull the
acknowledgement, because the instruction asking agents to `mark_read`
push-handled mail had approximately zero compliance. It left push clients on
that instruction, where compliance is still approximately zero — two sessions
answered peer mail from pushes for hours without sending it, and neither
noticed until a human read a status line. A pull client cannot skip
acknowledging, since reading is the acknowledgement; a push client's is a
separate act with no visible consequence when omitted, so the count degrades
for the clients least able to notice.

0013 rejected marking on push because the server cannot confirm a push
surfaced. That held for every push transport then existing. The oh-my-pi bridge
(`sessionPush.ts`) arrived five days later and acknowledges only after its host
durably accepts the notification.

## Decision Outcome

Read-marking follows the transport's ability to observe delivery, not the
distinction between push and pull.

A transport that acknowledges marks read on its acknowledgement: the host has
reported durable acceptance, so the message reached the agent's context, the
standard 0013 set for a pull. Claude's channel push marks nothing — no ack, no
way to distinguish delivered from dropped, and marking would assert more than
the server knows.

Separately, and requiring acknowledgement from no one, the unread count reports
its composition: how many unread messages carry a `pushed` receipt for this
session, and how many never reached it.

### Consequences

- An ack means the *host* accepted, not that the agent read; a harness that
  acks then discards marks unseen mail read. Weaker than a pull.
- Read state depends on transport capability, so two sessions in one project
  legitimately differ, and every future transport must answer whether it
  observes delivery. One that acks unreliably marks mail nobody saw.
- The composition split is per-session, and those receipts die with the session
  id: a fresh session sees the whole backlog as "never delivered", the flaw
  0013 named. The split labels; it must never suppress.

## Considered Options

### Keep 0013 intact and fix only the count's composition

Rejected: honest, but it changes no state, so the durable read flag still rests
on an instruction measured at approximately zero compliance.

### Mark read on any push, acknowledged or not

Rejected for 0013's own reason, undisturbed. Four sessions were pushed to in
one night over hosts that had never loaded the channel; marking would have
recorded every one as read.

### Mark read when a session replies to a pushed message

Rejected: a reply is a fresh `send_mail` linked by the optional `reply_to`, so
the server still depends on a volunteered field, and it misses handled mail
never replied to.

## More Information

- **Supersedes in part**: [0013](0013-check-inbox-marks-returned-mail-read.md)
  — "channel push still never marks read" narrows to transports that cannot
  observe delivery. The rest of 0013 stands.
