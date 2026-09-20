---
status: accepted
date: 2026-09-20
---

# 0018. A transport attaches to a session's identity; it never creates one

## Context and Problem Statement

A session is the thing that has a mailbox. Around it sit components that carry
its mail without being it: the OMP extension's push transport, status lines,
dashboards, subagents. None of them is a correspondent. They display a session's
mail, deliver into it, or run inside it.

The push bridge did not hold that line. `resolveSessionPushId` joined the
transport to its host's MCP registration by verified host pid, and when the join
found zero or several candidates it registered under the id the extension had
*asked* for. That fallback reads as conservative — keep the caller's own value
rather than guess — but registering under an id is not keeping it. It creates a
session: a registry entry, a routing id, and a generated name that peers can
address.

Zero matches was not an edge case. The extension runs inside the OMP host and
connects before the MCP subprocess finishes registering — measured at 234 ms and
147 ms on two live sessions. The join ran once, at connect, with no retry, so
the miss was permanent for the life of the session. Every OMP session therefore
held two identities: one for its MCP component, carrying OMP's native
conversation id, and one for its transport, carrying the launcher-minted
`AGENT_SESSION_ID` the extension proposed.

The damage is not that a listing shows two rows. `coalesceRegistrations` already
expects several registrations per host and merges them — *when they share a
routing id*. Two ids defeat that, and directed mail is visible only to its
recipient. So mail addressed to the identity the agent gives its peers was
invisible to the unread count its own status line displayed, and the two
registrations disagreed about delivery: the transport advertised `push` while
the session that actually received mail was `pull`.

[0014](0014-cli-identity-requires-a-host-process-match.md) had already settled
the principle for the CLI — an id in the environment is inherited, not proved —
and its closing note names this exact shape: two registrations under one host
pid are not an identification. The bridge was the one place still resolving a
disagreement by writing one of the answers down.

## Decision Outcome

A transport attaches to an identity that already exists. When it cannot name
that identity, it registers nothing and refuses the connection.

`resolveSessionPushId` no longer takes the requested session id as a parameter.
This is the substance of the change rather than tidiness: a function that cannot
see the proposal cannot register under it, so the failure mode is unreachable
rather than merely unchosen. It returns the join outcome — `joined`, `none`, or
`ambiguous` — and `connect` turns the latter two into a retryable `503` naming
which case occurred.

The requested id survives only as a diagnostic, echoed back in the `connected`
event as `requestedSessionId` beside the resolved `sessionId`, so a client can
see that its proposal was not its identity.

`none` is the ordinary startup order, not an error. The extension's reconnect
loop backs off from one second, and the MCP registration appears well inside
that, so the first retry joins.

The general rule this record fixes, of which the bridge is one instance: **only
a session has a mail identity.** Transports, status lines, and dashboards attach
to one or display one. Subagents do not participate in mail at all — a Claude
Code subagent shares its parent's process and MCP server and cannot produce a
registry entry, and the OMP extension is gated on `ctx.hasUI` for the same
reason. That is today's behaviour; it is written down here so it is not later
mistaken for an oversight and "fixed".

### Consequences

- An OMP session has no push for roughly its first reconnect interval. It polls
  in the meantime, and the indicator reports the truth during the gap.
- A host whose agent-mail MCP component never registers never gets push. This is
  the correct report rather than a regression: there is no mailbox to push into,
  and the previous behaviour's "working" push delivered to a mailbox its own
  agent could not read.
- A host with several registered sessions gets no push until the extra
  registration is pruned. Rare, and the refusal names the candidates.
- The transport can no longer be exercised in isolation: every connect test now
  needs a live MCP-side registration. That cost is real and was paid in
  `src/sessionPush.test.ts`; it is also the point, since a transport that could
  stand alone in a test was a transport that could stand alone in production.
- A later reader may see the refusal as an unfinished feature — a connection
  that could obviously have succeeded with a value already in hand. Restoring
  the fallback does not fail loudly. It silently gives one session two mailboxes
  and a status line that watches the wrong one.

## Considered Options

### Keep the fallback and register under the requested id

Rejected: this is the behaviour being removed. It is what a caller would
reasonably write — prefer the value you were given over inventing one — and it
is wrong because the choice is not between two values but between attaching and
minting. The requested id is a proposal from a component that is not entitled to
an identity.

### Make the MCP component accept its host's `AGENT_SESSION_ID` instead

Rejected, though it would also produce one id per session, and from the other
end. The MCP subprocess already holds that value and rejects it because
`mintedForHost` compares the marker against its own pid rather than its host's.
Loosening that would make the launcher id the session identity for OMP — but the
launcher mints a fresh id on every launch that is not an explicit
`-r <uuid>`, while OMP's native conversation id survives `--continue` and the
interactive picker. Adopting the launch id renames a session on every resume,
which [0011](0011-prefer-a-resume-id-from-the-host-command-line.md) already
weighed when it ruled that a conversation id outranks a launch id.

### Wait inside `connect` for the session to register

Rejected: it blocks a request handler on another process's startup, and the
client already implements the wait. The extension's reconnect loop is the right
home for it — it is observable, bounded, and the place a user can see that the
transport is offline.

### Register the transport with no session id

Rejected: an entry with no routing id cannot receive directed mail, yet appears
in listings as a session. That is the same confusion this record removes, in a
shape that is harder to notice.

## More Information

- **Builds on**: [0010](0010-adopt-the-host-agent-session-id.md),
  [0014](0014-cli-identity-requires-a-host-process-match.md)
- The resume-stability argument against the second option is
  [0011](0011-prefer-a-resume-id-from-the-host-command-line.md)'s, applied to a
  different component.
- `docs/oh-my-pi.md` describes the join from the extension's side.
