---
status: accepted
date: 2026-08-31
---

# 0014. A CLI session id is adopted only with a host-process match

## Context and Problem Statement

The CLI reads and sends mail but had no identity, so it left none of the traces
its MCP twins leave. A message read with `agent-mail inbox` recorded no receipt
and no read mark, leaving it `spooled` forever — indistinguishable from one
nobody collected. A message sent with `agent-mail notify` carried a free-form
`--from` label and no session, so the sender name the recipient saw could never
resolve as a reply address. Peers read that silence as a negative fact and
concluded mail had been dropped.

Both gaps close by resolving the calling agent through `sessionIdFromEnv()`,
which a CLI subprocess can read because Claude and Codex export their ids into
the shells they spawn.

That resolution is the hazard. **A session id in the environment is inherited,
not proved.** A script, a daemon, or a nested agent launched from an agent shell
carries that shell's id unchanged, and every id in `SESSION_ID_ENV_VARS` is
exported to descendants. Adopting one unconditionally would attribute this
process's work to a live peer that did none of it: marking that peer's mail read
when it never saw the messages, and stamping its address on a message it never
sent, so replies route confidently to the wrong agent.

[0003](0003-addressing-automation-notifications.md) already judged this class of
error on the recipient side — a specific wrong answer is worse than a broadcast,
or than none — and named the daemon case exactly: a notifier started from an
agent shell would stamp every job with its one inherited id.

## Decision Outcome

The CLI adopts an environment session id only when the matching live
registration's host process is an ancestor of the CLI process. `callingSession()`
in `src/cli.ts` is the single predicate; `cmdInbox` and `cmdNotify` both consult
it, so attribution cannot drift between reading and sending.

The ancestry test is against the registration's `parentPid`, not its `pid`. The
`pid` is the channel server, which is a *sibling* of the CLI process under the
host agent, never its ancestor — testing against it would reject every genuine
caller. A registration carrying no `parentPid` cannot be proved and is not
adopted.

Failing the test is not an error. `inbox` still prints the mail and says on
stderr that the read is unattributed; `notify` still sends, keeping its
free-form label and stamping no identity. The reader is told the label is not an
address rather than being left to discover it by replying.

### Consequences

- A session whose registration predates `parentPid` cannot be proved, so its CLI
  reads stay unattributed until it re-registers. Silent, and correct: an
  unattributed read is the state the CLI had before this record.
- Attribution costs a process-ancestry walk (`hostAncestorPids`) per CLI mail
  command — several single-pid `ps` queries, bounded by depth.
- A CLI read now marks mail read for the session it runs inside, which a human
  running `agent-mail inbox` at a terminal inside an agent session will also
  trigger. `--peek` is the opt-out, matching `check_inbox`.
- weft's `notify` hook stamps no sender identity, since it does not run under the
  submitting session's host process. Its recipient addressing via `--session` is
  unaffected — that path never consulted the environment.
- The guard looks redundant next to the live-registration check and is the kind
  of line a later reader deletes as a simplification. Deleting it does not fail
  loudly; it produces confidently misrouted replies.

## Considered Options

### Adopt any resolvable session id

Rejected: this is the inherited-id failure above. It is worse than the identity
gap it closes, because a wrong address is acted on while a missing one is not.

### Match on the registration's `pid`

Rejected: the channel server is a sibling of the CLI process, not an ancestor,
so this rejects every real caller and silently restores the old behaviour.

### Require an explicit `--session` on every CLI mail command

Rejected: it moves the burden to callers that mostly cannot supply it, and an
agent free-typing its own session id can assert any peer's — the same wrong
answer this record exists to prevent, minus the environment's evidence.

## More Information

- **Builds on**: [0003](0003-addressing-automation-notifications.md),
  [0010](0010-adopt-the-host-agent-session-id.md),
  [0013](0013-check-inbox-marks-returned-mail-read.md)
- The `resolveSelf` helper in `src/presence.ts` applies the same host-pid
  reasoning to the status line, and carries the related rule that two
  registrations under one host pid are not an identification.
