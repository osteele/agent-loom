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

It does not. Codex spawns its MCP servers with **no session variable at all** —
measured across three live sessions, none of the four candidate names present —
while the codex process itself holds `AGENT_SESSION_ID`. There is no order that
reaches a child holding nothing.

The wider measurement says the same. Of the nine sessions weft has ever
recorded a submitter for, agent-mail has registered exactly one: the Claude
Code session, whose native id Claude injects into both MCP spawn environments
and tool-call environments, and which therefore already joins correctly today.
The seven Codex sessions and the one launcher-id session were never seen here.
That last case is decisive on its own — even where a launcher id was reachable
by the CLI that recorded it, it did not reach agent-mail's channel server.

So the problem is not which id is preferred. It is that the child is given no
id to prefer, and mints a `randomUUID()` no sibling process can learn.

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

## Considered Options

### Reorder to prefer `AGENT_SESSION_ID` (0009)

Rejected: measured as a no-op in every observed configuration. Children with a
native id already resolve correctly; children without one have no
`AGENT_SESSION_ID` either. It also asked weft to reverse a documented nesting
protection in exchange for nothing.

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
