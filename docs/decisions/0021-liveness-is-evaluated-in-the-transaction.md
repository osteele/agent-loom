---
status: accepted
date: 2026-09-22
---

# 0021. A transaction observes session liveness itself; it never waits for an observer

## Context and Problem Statement

A session-owned claim stops blocking after the owning session has had no
process for the restart grace period. Something has to notice that the
processes are gone and start the clock.

The elicited contract made that an external event: a presence observer
reported the last process gone, the claim entered grace, and a later deadline
event released it. If no observer ran, the claim blocked forever, and the
contract said explicitly that a missing observation was not proof of
staleness. The daemon is that observer, and the daemon can be down while
sessions and CLI calls continue.

## Decision Outcome

Any transaction that must classify a session-owned claim takes its own
presence observation of that session from the process table, inside its
serialized scope, and applies the absence or return transition before
deciding. The daemon's periodic tick is one more caller of the same
observation, not the source of it. A cached presence snapshot is never an
input to classification.

The grace deadline still runs from the first observation of absence, whichever
transaction takes it, and is not backdated to an inferred exit time.

### Consequences

- An acquisition that touches a session-owned claim pays a process-table scan.
  On this machine that is one `ps -A` at roughly 24 ms, and it happens only
  when a conflicting claim is in the candidate set.
- A dead session's claim held while nothing ran now blocks for one grace
  period after the next transaction, not forever.
- The rule that `presence.json` is a presentation cache and never a routing
  input, already stated for mail delivery, now covers claims too.
- The contract depends on the single-machine assumption in
  [0001](0001-single-machine-coordination-identity.md): the process table a
  transaction reads must be the one the owner runs in.

## Considered Options

### Daemon-only observation

Rejected: it makes claim liveness depend on a process that is not part of the
claim transaction, and a claim system whose correctness depends on a daemon
being up contradicts the invariant that claims are filesystem transactions
independent of daemon state.

### Read the presence snapshot instead of the process table

Rejected: the snapshot freezes a liveness verdict for its TTL, so an
acquisition could see a session as live after it died or as dead after it
returned. The cost it saves is one scan per conflicting acquisition, which is
rare.

## More Information

- **Builds on**: [0001](0001-single-machine-coordination-identity.md)
- **References**: `specs/path-claims.allium`, invariant
  `LivenessIsEvaluatedInTheTransaction`; the presence-snapshot rule in
  `docs/architecture.md`
