---
status: accepted
date: 2026-09-22
---

# 0020. One claim per acquisition; same-owner claims are never merged

## Context and Problem Statement

An owner often acquires overlapping paths in separate calls: a directory and
later a file inside it, or the same file twice from two tasks. The contract
has to say what the second acquisition produces and what releasing either
handle does.

The elicited contract merged overlapping same-owner claims into one union,
carried every prior id forward as an alias of the union, and released the
whole union from any alias. That removed partial release: an owner that
claimed one file, later claimed that file plus another, and released the first
handle lost both. It also required alias bookkeeping, a cross-plan merge
refusal that told the caller to ask itself to release, and an ambiguity between
the expand rule and the new-claim rule when no overlap existed.

## Decision Outcome

Every acquisition that is not an exact repeat of an existing same-owner claim
creates one claim with one public id and one release token. Same-owner overlap
is permitted and is never a conflict; conflict detection considers only claims
held by other owners. Releasing a claim releases that claim's targets and no
others. Claims are never merged, expanded, or split.

An acquisition whose normalized target set equals an existing same-owner
claim's returns that claim as `existing`, refreshing a manual owner's activity
and minting nothing.

### Consequences

- An owner can hold several claims covering the same path. Listings show each;
  a peer asking the owner to release may have to name more than one.
- Release granularity is the acquisition. An owner wanting a finer split
  acquires in smaller sets.
- No alias table, no merge transaction, and no cross-plan merge rule.
- `existing` is the only same-owner shortcut. A request that covers an
  existing claim plus more creates a second claim rather than expanding the
  first.

## Considered Options

### Merge overlapping same-owner claims into a union with aliases

Rejected: merge without split destroys partial release, and the alias table
exists only to make the merge survivable. POSIX record locks, the nearest
precedent for coalescing, also split on unlock; the elicited design took half
of that model.

### Refuse a second overlapping claim from the same owner

Rejected: WebDAV does this and has the caller refresh instead. Here the second
acquisition usually comes from a caller that does not know the first exists,
so a refusal would send it looking for its own id. Permitting the overlap costs
nothing, because same-owner claims do not conflict.

## More Information

- **Builds on**: [0002](0002-no-fencing-tokens.md), which makes a claim
  advisory and therefore cheap to hold twice
- **References**: `specs/path-claims.allium`, invariants
  `SameOwnerOverlapIsNotAConflict` and `OneClaimPerAcquisition`
