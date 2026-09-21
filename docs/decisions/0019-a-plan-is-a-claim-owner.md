---
status: accepted
date: 2026-09-22
---

# 0019. An execution plan is a claim owner, not a link on a manual claim

## Context and Problem Statement

A path claim made on behalf of an execution plan should live as long as the
plan is being executed and no longer. The plan's executor changes across
handoffs, dies with its session, and finishes or abandons the plan, and the
claim should follow those events rather than a clock or a label.

The elicited contract expressed this as an optional plan link on a manual
claim. That shape gave the plan's current executor the power to renew the
claim through step transitions but not to release it, since release authority
was the manual label; it left a dead executor's claims held for up to 24 hours
after its work lease had already become displaceable; and it denied the
linkage to session owners executing the same plan.

## Decision Outcome

`OwnerKind` gains a third value, `plan`. A plan-owned claim's identity is the
plan (project plus stable filename stem). Its liveness is the plan's execution
lease: the claim is released when the lease is released, displaced, or
expired, or when the plan completes or is abandoned. A lease transfer keeps
the claim and moves release authority to the new executor. Only the current
executor may acquire a plan-owned claim.

Manual claims carry no plan link. A caller that wants plan lifetime says so by
choosing the plan as owner.

### Consequences

- The claim store consumes lease events from the work-lease system, not only
  plan-state events. That coupling is one-way and is the point: the claim's
  clock is the lease.
- A plan-owned claim has no inactivity clock. If the lease system leaves a
  lease held by a dead session until the next acquisition displaces it, the
  claim is held that long too.
- Three owner kinds instead of two, each with its own release-authority rule.
- Existing manual claims made on a plan's behalf gain nothing until re-acquired
  as plan-owned.

## Considered Options

### A plan link on manual claims

Rejected: it names the plan as the reason for the claim while keeping a label
as its owner, so authority and liveness disagree. The executor can extend the
claim and cannot end it, and the claim outlives the lease it was meant to
track.

### A plan link on any owner kind

Rejected: a session-owned claim with a plan link would have two liveness
sources, the session and the lease, and the contract would have to say which
wins when they disagree. Making the plan the owner leaves one.

## More Information

- **Builds on**: [0007](0007-manual-owner-expiry.md), which established that
  liveness follows the owner's kind
- **References**: `specs/path-claims.allium`, section "Plan-owner lifecycle"
