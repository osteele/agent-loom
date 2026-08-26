---
status: accepted
date: 2026-08-25
---

# 0011. Prefer a resume id from the host's command line

## Context and Problem Statement

[0010](0010-adopt-the-host-agent-session-id.md) gave a Codex session an
identity, but a launch-scoped one: `AGENT_SESSION_ID` is minted per launcher
invocation, so the same conversation resumed later is a different session as far
as agent-mail is concerned.

The conversation's own identity is Codex's thread id, and it is the right one on
every count. It survives a resume. It is what weft records as
`submitter_session` — verified: weft's submitter ids are exactly the names of
Codex's rollout files, so `CODEX_THREAD_ID`, the session id in
`~/.codex/sessions/`, and the argument `codex resume` takes are one identifier.

It is unreachable from the MCP child, because Codex injects it into tool-call
environments only. But when a session is started as `codex resume <id>`, that id
is on the host's command line, which the child can read.

## Decision Outcome

Consult the host agent's command line for a resume id, between the process's own
environment and the host's `AGENT_SESSION_ID`.

After the environment, because that is what the harness actually set for this
process — Claude Code already puts the resumed id there, so argv adds nothing
and must not override it. Before the launcher id, because a conversation id
outranks a launch id.

Only a UUID-shaped token following `--resume`, `-r`, or `resume` is taken.

### Consequences

- A resumed Codex session adopts the conversation id, so weft's record of the
  *whole* conversation joins to it — including jobs submitted before the resume,
  which weft recorded under the same thread id all along.
- A fresh Codex launch is unchanged and still does not join. The thread id does
  not exist anywhere the child can read at spawn time: the environment is empty
  and the command line carries no id, because Codex mints the id after starting.
  So one conversation can hold two agent-mail identities across its first
  resume — the second one being the correct one.
- The session's name and address change at that boundary, and a peer holding
  the old address cannot reach it. This is not new; every relaunch already
  changed identity.
- Nothing covers `--continue`, `codex resume --last`, or an in-session
  `/resume`. None carries an id, so none is recoverable this way.
- **argv records intent, not outcome.** A resume that failed, or whose picker
  the user overrode, still leaves the requested id on the command line, and
  nothing observable from outside the process distinguishes that. This is why
  it ranks below the environment rather than above it.
- Startup now makes up to two single-pid `ps` reads rather than one, taken only
  when the earlier source yielded nothing.

## Considered Options

### Take whatever token follows the flag

Rejected, with a live counterexample: a running process on this machine is
`codex exec --skip-git-repo-check resume --last`. Taking the next token
unconditionally adopts `--last` as a session identity — stable, plausible, and
wrong, which is worse than having none.

### Read the thread id from Codex's session store

`~/.codex/sessions/` names each rollout file after the thread id, so a fresh
session's id is discoverable there. Rejected: it is another tool's private
state, with no contract and no version, and the file need not exist yet when the
MCP server starts. It would also be ambiguous when two Codex sessions start
together. Consuming a tool's storage rather than its interface is the coupling
this project avoids everywhere else.

### Wait for Codex to expose the thread id to MCP children

Still the clean fix, and it would make both this record and 0010 unnecessary for
Codex. Not ours to change, and a static `~/.codex/config.toml` entry cannot
carry a per-session value.

## More Information

- **Builds on**: [0010](0010-adopt-the-host-agent-session-id.md), whose
  host-environment read remains the fallback when no resume id is present.
