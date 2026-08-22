---
status: accepted
date: 2026-08-21
---

# 0007. Manual coordination owners expire after 24 hours

## Context and Problem Statement

A manual owner — `cli:<label>`, created by a `--owner` acquisition outside a
registered agent session — records no process. Nothing about it can be checked:
the label is a string the caller typed, and `ownerStatus` has no identity to
test, so such a record can never be proven dead.

[0004](0004-authority-forced-recovery.md) gave these records an escape hatch: an
operator who knows the owner is gone declares an authority and forces the
release. That works, but every release still depends on a human noticing. The
records accumulate in the meantime, and they accumulate structurally rather than
occasionally — a containerized agent that claims this way leaves its claims
behind when the container exits, and the label it registered under identifies
nothing that outlives it.

The scale is observable. Six records in one research project were held for nine
days by two labels (`codex-root` and `/root`) that no process on the machine had
ever answered to. They were released only because an operator went looking for
them. The same project's work had long since moved past the experiment numbers
they reserved.

Left alone, this erodes the control 0004 established. Force-releasing is
friction only while it is rare; an operator who must pass `--authority` every
week to clear predictable debris learns to pass it by reflex, which is precisely
the habit the friction exists to prevent.

## Decision Outcome

A manual owner whose record has gone 24 hours without an update classifies as
`expired`. `isDisplaceable()` — the single predicate every acquisition,
recovery, and display path consults — treats `expired` like `offline`, so the
next conflicting acquisition takes the resource and `recover_coordination`
releases it without a declared authority.

The clock runs from the record's last update rather than its creation, so an
owner that is still working renews by working: `update_work` restarts it.

The bound applies only to owners with no recorded process. A session-owned lease
is classified by process identity however long it has been held.

### Why this reverses 0004's rejection

0004 rejected auto-expiry on the grounds that a timer guesses at intent, and
that a long-running deliberate hold is indistinguishable from an abandoned one.

Renewal answers the second objection in part: an owner that updates its record
is distinguishable, and the operator now has a way to signal intent that the
timer reads. It does not answer it fully — a deliberate hold that never updates
is still displaced.

That residue is accepted because the two failure modes are not symmetric. An
expired-but-still-wanted lock costs one re-acquisition by a caller who is
present and can notice. An abandoned lock blocks indefinitely, and its cost is
paid by whoever arrives next, who cannot tell it from a live one. Twenty-four
hours is far past any interactive edit set, so expiry means abandoned rather
than slow.

### Consequences

- A deliberate manual hold longer than 24 hours is displaced unless it renews.
  Operators who want an indefinite hold must update the record, or take the
  lease from inside a registered session where process identity governs instead.
- Expiry is an inference from elapsed time, not a proof of death: a manual owner
  that is genuinely still running can lose its record. Tolerable because claims
  are advisory ([0002](0002-no-fencing-tokens.md)) — losing one costs
  coordination, not correctness.
- Manual records already older than 24 hours become displaceable the first time
  anything evaluates them, including records created before this decision.
- Liveness now has two grounds — process identity and elapsed time — and only
  one of them is proof. `isDisplaceable()` exists so that distinction is made in
  one place rather than re-derived at each of the fourteen sites that previously
  compared against `"offline"` directly.

## Considered Options

### Keep authority-only recovery

Rejected: it is the status quo 0004 adopted, and the accumulation above is what
it produces. It leaves the only bound on an unverifiable record's lifetime as
"until a human notices", which is unbounded in practice.

### Record a pid for CLI owners so they can be checked

Rejected: this existed and was removed. `cliOwner()` once stored
`pid: process.pid`, but the `agent-mail` CLI process exits milliseconds after
writing the record, so the pid is dead on arrival and will eventually be
recycled by an unrelated process — at which point the record reads as *live*
forever. A pid that cannot be trusted is worse than no pid, because it defeats
the check rather than declining it.

### A shorter window

Rejected: an hour or two would displace legitimate slow work, and the cost of
expiring a wanted lock is borne by someone who has to notice and recover. The
window should be long enough that expiry is unambiguous.

## More Information

- **Supersedes**: [0004](0004-authority-forced-recovery.md)'s rejection of
  auto-expiring manual claims. The mechanism 0004 adopted remains in force and
  is still the only path for live owners, unverifiable owners, and manual owners
  inside their window.
- **Builds on**: [0002](0002-no-fencing-tokens.md)
- **References**: `MANUAL_OWNER_TTL_MS` and `isDisplaceable()` in
  `src/coordination.ts`; "Manual owner expiry" in `docs/architecture.md`
