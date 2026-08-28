---
status: accepted
date: 2026-08-28
---

# 0012. Allow friendly session names to recycle

## Context and Problem Statement

Generated session addresses need to be memorable enough for a human to use in
conversation. The original 64 adjectives and 64 nouns produced 4,096 pairs,
but deterministic hashing made noun repetitions noticeable much sooner than
the pair count suggested. A repeated noun is especially costly: the human can
no longer use that noun alone to distinguish two agents in conversation.

An identity assignment is already persisted by session ID. The generated name
is a human address, not the durable identity authority; session ID remains that
authority. Requiring every friendly name to be globally unique forever would
therefore impose an unbounded history requirement on a convenience namespace.

## Decision Outcome

Use curated 256-word adjective and noun lists from
[Glitch friendly-words](https://github.com/glitchdotcom/friendly-words/tree/f94b4639c71c26875f7684fa86a214c7f30deaad/words),
whose license and exact revision are recorded in
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md). This provides 65,536
possible adjective–noun pairs. Existing persisted assignments remain
unchanged.

Serialize new assignments through one filesystem lock. When minting a name:

1. Never choose a noun held by a currently registered session.
2. Prefer a noun that has not been minted in the preceding 30 days.
3. If every noun not currently held was used within that window, reuse the
   least-recently minted available noun.
4. If all 256 nouns are currently held, fail instead of creating an ambiguous
   current name.

It is acceptable for a noun, and eventually an exact adjective–noun pair, to
recycle. Persistence prevents an existing session from being renamed; the
allocation policy only reduces how quickly a new session repeats a name.

### Consequences

- A human can use a noun alone while the relevant agents are registered,
  because current generated names have distinct nouns.
- Normal operation has a 30-day noun cooldown. Heavy churn can exhaust that
  preference, at which point allocation degrades explicitly to least-recent
  reuse instead of failing.
- The namespace supports at most 256 simultaneously registered generated
  nouns. This is an intentional limit; silently adding a suffix would defeat
  noun-only reference.
- The selected pair is no longer solely a function of the session ID. The hash
  supplies the preferred starting point, while persisted assignment history
  and current registrations decide which available noun is selected.
- Assignment history remains bounded by session count, as before. No permanent
  tombstone store is required solely to prohibit reuse.
- A malformed assignment file blocks minting. Silently skipping one would hide
  provenance and could weaken the current/recent-use guarantee.

## Considered Options

### Keep deterministic hashing over a larger vocabulary

Rejected as the only policy. It lowers pair collisions, but independent hashes
can still repeat a noun immediately and make noun-only reference ambiguous.

### Never recycle a generated name

Rejected. It requires permanent global tombstones, makes a finite friendly
vocabulary an eventual hard failure, and provides little identity benefit when
the session ID is already authoritative.

### Add a third word or a numeric suffix

Rejected. It expands the namespace but makes spoken names longer and does not
preserve the ability to distinguish current agents by one noun.

### Enforce noun uniqueness only within a project

Rejected. Sessions from several projects appear together in global status,
Slack, and coordination surfaces, so a per-project policy would still be
ambiguous in ordinary conversation.

## More Information

- **Source and license**:
  [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md)
- **Implementation**: `src/nameWords.ts`, `src/sessions.ts`, and
  `src/registry.ts`
