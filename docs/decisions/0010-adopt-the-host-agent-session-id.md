---
status: accepted
date: 2026-08-25
---

# 0010. Adopt the host agent's session id when spawned without one

## Context and Problem Statement

[0009](0009-prefer-launcher-minted-session-id.md) reordered session-id
resolution to prefer `AGENT_SESSION_ID`, reasoning that a launcher id every
process in the shell can read beats a native id only the agent can read.

The reasoning was sound and the change was inert. It rested on an assumption
that was never measured: that a child lacking a native id would nonetheless
have `AGENT_SESSION_ID` in its own environment, so that reordering would reach
it.

It does not. Every harness constructs a filtered environment for the MCP
servers it spawns, and what each one puts there decides the outcome:

| harness       | MCP child gets      | resolves to  | weft records |
|---------------|---------------------|--------------|--------------|
| Claude Code   | the native id       | native id    | native id    |
| kimi/opencode | `AGENT_SESSION_ID`  | launcher id  | launcher id  |
| Codex         | nothing at all      | minted UUID  | thread id    |

Measured over all 6363 jobs weft holds: fourteen sessions have a recorded
submitter and agent-mail has registered five of them — three launcher-id
sessions and two Claude sessions. Both of those harnesses already join
correctly, and have for a week. All seven Codex sessions are unmatched, and
they are the only unmatched ones.

So the problem is not which id is preferred, and it is not general. Codex hands
its MCP child nothing, so the child mints a `randomUUID()` no sibling process
can learn. No ordering reaches a child holding nothing, and reordering is inert
even where a child holds something — a Claude MCP child has no
`AGENT_SESSION_ID` to promote, and a kimi child has no native id to demote.

## Decision Outcome

Native ids come first again, restoring the order 0009 reversed.

When our own environment yields nothing, adopt `AGENT_SESSION_ID` from the host
agent's process environment — the parent, for an MCP server — and accept it
only when `AGENT_SESSION_PID` names that exact process.

Only the launcher id is adopted this way, never a native id. A native id in a
parent's environment may have been inherited from an outer agent, and answering
to it would file this session's work under a different, live session.

The marker is **required** here, where an absent marker in our own environment
is trusted. A variable in our own environment is at least weak evidence it was
meant for us. A value read out of another process has no such standing, so it
is adopted only on proof that the launcher minted it for that process.

### Consequences

- A session started by a launcher that predates `AGENT_SESSION_PID` keeps
  minting an unaddressable id, because its host carries the id but no proof.
  Those sessions become addressable when next relaunched, and not before.
- Startup does one single-pid `ps` read. That is the fast path (see the note in
  `registry.ts` on multi-row `-p`), but it is a subprocess on the path to a
  session's first turn, taken only when the environment yielded nothing.
- The host's environment routinely contains API keys. Two variables are
  extracted and the rest discarded; it must never be logged, stored, or
  returned.
- weft needs no reorder, and its `config.go` nesting rationale stands as
  written. A join still requires weft to record an id agent-mail also holds,
  which is a separate decision and not settled here.
- Claude Code sessions are unaffected: they already resolve natively and
  already join.
- **The adopted id identifies a launch, not a conversation.**
  `AGENT_SESSION_ID` is minted unconditionally on every launcher invocation, so
  a session resumed later is a different identity: its agent-mail address
  changes, peers holding the old one cannot reach it, and jobs it submitted
  before the resume stay attributed to the id it had then. Native ids do not
  have this property — they identify the conversation and survive a resume — so
  the cost falls only on the harnesses that need the host read at all, which
  today means Codex.

## Considered Options

### Reorder to prefer `AGENT_SESSION_ID` (0009)

Rejected: measured as a no-op in every observed configuration, though not for
one uniform reason. A Claude child has no `AGENT_SESSION_ID` to promote; a
kimi child has one but no native id to demote, so it already wins by
fall-through; a Codex child has neither. It also asked weft to reverse a
documented nesting protection in exchange for nothing.

### Adopt an unmarked launcher id from the host

Rejected: it cannot distinguish an id minted for this agent from one inherited
by an agent started outside the launcher, which is exactly the nesting failure
the launcher's `unset` exists to prevent. Silence is better than a specific
wrong session.

### Wait for Codex to inject a session variable into MCP spawn environments

Rejected: not ours to change, and a static `~/.codex/config.toml` entry cannot
carry a per-session value. Worth revisiting if Codex adopts the behaviour Claude
Code already has.

## More Information

- **Supersedes**: [0009](0009-prefer-launcher-minted-session-id.md)
- **Builds on**: [0003](0003-addressing-automation-notifications.md)
