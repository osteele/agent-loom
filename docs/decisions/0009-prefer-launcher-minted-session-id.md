---
status: accepted
date: 2026-08-25
---

# 0009. Prefer the launcher-minted session id over native ids

## Context and Problem Statement

A session's id is the routing key. Every addressed message, every coordination
lease, and every join between agent-mail and another tool depends on two
processes independently deriving the same string for the same session.

`sessionIdFromEnv()` resolved that id from the first non-empty of
`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `AGENT_SESSION_ID` — native ids
first, on the reasoning that an agent minting its own per-session id knows more
about that session than a launcher wrapping it does.

That reasoning holds only where the native id is *reachable*. Codex injects
`CODEX_THREAD_ID` into the environment of tool-call subprocesses, not into its
own process environment and not into the environment of the MCP servers it
spawns at startup. The consequences compound:

- agent-mail's channel server, spawned by Codex, sees no session variable at
  all and falls through to a `randomUUID()` minted inside itself — an id no
  other process can learn, so the session is addressable by nothing.
- weft, invoked as a tool call in the same shell, sees `CODEX_THREAD_ID` and
  records it as the job's submitter.

One session, two identities, derived by two processes that both followed the
documented order. Measured across the 1402 session ids agent-mail has ever
named: not one matches a weft `submitter_session`. Any feature joining a job to
the session that submitted it is therefore inert, and a feature that reports
what it cannot find — jobs whose submitter is gone — reports everything.

`AGENT_SESSION_ID` is the one identifier both processes can see. The launcher
exports it into the shell environment before `exec`, so it reaches the agent,
every tool call, and every MCP server the agent spawns.

## Decision Outcome

`SESSION_ID_ENV_VARS` resolves `AGENT_SESSION_ID` first, ahead of both native
ids. Reachability beats provenance: an id only one process can read is worth
less as a routing key than a slightly less authoritative id every process in
the session can read.

A launcher-minted id is accepted only when it was minted for *this* agent. The
launcher exports `AGENT_SESSION_PID` naming the process it `exec`s into, and a
consumer that knows its host agent's pid rejects an id whose marker names a
different process. Without the marker the two cases are indistinguishable: an
agent started outside the launcher inherits its parent agent's
`AGENT_SESSION_ID` from the environment, and adopting it files this session's
work under a different, live session — a specific wrong answer, which is worse
than having none.

An absent marker is trusted rather than refused, so launchers predating it keep
working.

### Consequences

- The order now lives in three places that must change together:
  `SESSION_ID_ENV_VARS` here, the launcher's unset-and-mint, and weft's
  `defaultSubmitterSessionEnvVars`. A change to one silently re-splits the
  namespace, and the symptom — a join that matches nothing — is
  indistinguishable from a feature with nothing to report.
- The launcher becomes load-bearing for identity rather than a convenience for
  agents that lack a native id. An agent started without it falls back to the
  native ids and remains subject to the original problem.
- A native id remains authoritative for the agent that mints it, and agent-mail
  now prefers a different string. Where a native id is genuinely the better
  identifier and is reachable — Claude Code injects
  `CLAUDE_CODE_SESSION_ID` into MCP spawn environments — the launcher unsets it
  before minting, so the two never compete.
- Marker verification only works for consumers that know their host agent's
  pid. An MCP server does: its parent is the agent. A tool-call CLI does not
  reliably, since the agent is an ancestor rather than the parent, and its
  inherited-id case stays open.

## Considered Options

### Keep native ids first and get `CODEX_THREAD_ID` into the MCP child

Rejected: not ours to change. Codex decides what environment its MCP servers
are spawned with, and a static `~/.codex/config.toml` entry cannot carry a
per-session value.

### Have agent-mail read the session id out of its parent process's environment

Rejected: it does not solve the problem it appears to. The parent Codex process
holds `AGENT_SESSION_ID`, not `CODEX_THREAD_ID`, so reading it yields the
launcher id anyway — the same value this decision adopts, reached by a syscall
and a `ps` parse instead of an environment lookup. Reading native ids from a
parent would additionally reintroduce the nesting bug the launcher's `unset`
exists to prevent.

### Have both tools mint independently and reconcile afterwards

Rejected: reconciliation needs a shared key, which is the thing being
established. Any mapping table becomes a third identity to keep in sync.

## More Information

- **Supersedes**: the native-ids-first rule, previously stated only as an
  invariant in `CLAUDE.md`.
- **Builds on**: [0003](0003-addressing-automation-notifications.md), which
  makes automation notifications session-addressed and therefore depends on
  both tools agreeing on the id.
