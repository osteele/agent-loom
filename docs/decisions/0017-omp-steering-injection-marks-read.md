---
status: accepted
date: 2026-09-10
---

# 0017. OMP steering injection marks read

## Context and Problem Statement

[0016](0016-an-acknowledged-push-marks-read.md) kept Oh My Pi push acceptance separate from read state because OMP accepted a queued `followUp` without proving that the message entered agent context. The integration now delivers mail as steering input. `pi.sendMessage` itself returns before its asynchronous delivery finishes, so the extension does not acknowledge that call. It waits for OMP's `message_start` event carrying the exact agent-mail custom message, which is the host's signal that the message entered session context.

Leaving these acknowledged steering messages unread creates false delivery reminders. One live session accumulated seven pushed-but-unread messages that it had received and answered in their steering turns. Manual `mark_read` remained the only settlement path, so correct prompt handling produced an inaccurate unread backlog whenever the agent omitted separate bookkeeping.

## Decision Outcome

An acknowledged OMP steering push marks the message read. The daemon records the per-session `pushed` receipt, then writes project-global read state and a per-session `read` receipt for the same message.

This rule applies to the exact-session OMP bridge because its acknowledgement attests context insertion. It does not apply to Claude channel push or another transport whose callback proves only emission or host acceptance. Those paths continue to require `check_inbox` or explicit `mark_read`.

The bridge and extension use protocol v3 for this contract. The client names its
protocol version on connect, and the daemon rejects a mismatch before
registration. An earlier queued-follow-up client therefore cannot issue an
acknowledgement whose meaning is weaker.

Read means that the message entered agent context. It does not claim that the model understood the message, followed it correctly, or completed related work.

### Consequences

- OMP steering messages do not accumulate as pushed-but-unread after entering context.
- Delivery reminders continue to report OMP mail when no steering acknowledgement occurred.
- The receipt log preserves both observations in order: `pushed`, then `read`.
- Project-global read state retains the tradeoff accepted by 0013: one session receiving a broadcast can clear its unread cue for other sessions.
- OMP sessions running extension code from before the steering cutover are rejected by protocol v3 until restarted; their mail stays unread and available through `check_inbox`.

## Considered Options

### Mark read on steering injection

Accepted. It uses the first observation that satisfies the established context-delivery standard and removes bookkeeping that agents demonstrably omit.

### Mark read after the resulting agent turn

Rejected. A completed turn is stronger evidence of processing, but OMP does not provide an unambiguous message-to-turn acknowledgement. Several steering messages, aborted turns, and unrelated steering can break the association. Additional lifecycle state would still not prove that the model acted on a particular message.

### Keep explicit `mark_read`

Rejected. It preserves a distinction between context insertion and deliberate disposition, but makes unread accuracy depend on a manual action that prompt handling does not require. Observed reminders then counted handled mail exactly, training recipients to discount a correct warning mechanism.

## More Information

- **Supersedes**: [0016](0016-an-acknowledged-push-marks-read.md) for OMP steering acknowledgements only. Its rule remains in force for transport or host acceptance that does not attest context insertion.
- **Builds on**: [0013](0013-check-inbox-marks-returned-mail-read.md), which defines verified context delivery as sufficient to mark read.
