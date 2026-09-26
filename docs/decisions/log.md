# Decision log

Smaller decisions that foreclosed something without earning a full record —
reversible in an afternoon, but still choices a reader could undo by mistake.
Y-statements, append-only, newest last. An entry is written and left alone; a
later change is a later entry, or a record that supersedes it.

*In the context of X, facing Y, we decided for Z, and neglected W, to achieve
Q, accepting D.*

- **2026-09-08** — In the context of the delivery reminder for mail a session
  has not cleared, facing a condition that is true on most sweeps for a busy
  push client, we decided to bound it to one reminder per session per two
  hours after a thirty-minute grace, and neglected reminding on every
  five-minute sweep while the condition holds, so the reminder stays a signal
  rather than background noise, accepting that a session which clears its
  backlog just after being reminded goes unreminded for two hours while new
  mail accumulates.

- **2026-09-08** — In the context of telling an agent to `mark_read` mail a
  fire-and-forget push cannot acknowledge, facing an instruction at startup
  that arrives hours before the moment it applies, we decided to carry it on
  the push itself where the message id is in front of the reader, and
  neglected the `check_inbox` response, which is seen only by the pull path
  that has already marked the mail read, accepting one extra line on every
  pushed message for clients whose transport cannot acknowledge.

- **2026-09-11** — In the context of cross-project replies, facing a sender who
  does not listen in the question's destination project, we decided to route
  replies to the stamped sender's live mailbox. We neglected the broadcast
  fallback in [0003](0003-addressing-automation-notifications.md) for
  `notify --reply-to`, to reach the question's author, accepting refusal when
  its return address cannot be resolved. Automation notifications without
  `--reply-to` retain their broadcast fallback.

- **2026-09-11** — In the context of OMP tool shells without session-ID
  environment variables, facing sends with no usable return address, we
  decided to adopt the unique live mailbox owned by the CLI's immediate
  in-process host. We neglected searching more distant ancestors, to avoid
  attributing a nested agent to its outer host, accepting unattributed sends
  from wrapped shells or hosts with multiple mailboxes. This extends the
  proof of identity in
  [0014](0014-cli-identity-requires-a-host-process-match.md).

- **2026-09-11** — In the context of project-owner addressing, facing projects
  with one or several attached sessions, we decided to prefer an explicit
  assignment and otherwise infer only a sole live logical session. We
  neglected mandatory assignment for every send, to make single-session
  projects addressable without setup, accepting ambiguity when another session
  joins. Resolution pins the recipient at send time rather than retargeting
  queued mail during a handoff.

- **2026-09-12** — In the context of automation completion mail, facing jobs
  with no recorded submitter or an unavailable recipient, we decided to refuse
  an empty, unknown, or ambiguous explicit `--session`, and neglected the
  broadcast fallback in [0003](0003-addressing-automation-notifications.md), to
  keep another session from receiving work it did not request. We accept that
  a completion whose owner cannot be identified needs triage from the job
  system's record. Omitting `--session` remains an intentional broadcast.
- **2026-09-12** — In the context of quit-and-resume orphaning a logical session's plan rows in the status projection, and coordination CLIs run from dispatched executors whose inherited `AGENT_SESSION_ID` names the launching agent, we decided to join the work projection on the session id alone (with the session live) and to resolve the acquiring shell's session from the registered process tree before falling back to manual label ownership, neglecting the per-instance join in [0012](0012-allow-friendly-session-names-to-recycle.md)'s shadow, so a resumed session keeps its leases and claims and new acquisitions attribute to the shell's own session. We accept that a retired instance's lease rows render until the session releases or recovers them; `coordination recover` and displacement rules are unchanged.

- **2026-09-18** — In the context of session-id resolution, facing a flat
  precedence chain in which the launcher's `AGENT_SESSION_ID` preempted OMP's
  own conversation id — leaving OMP sessions named after an id OMP cannot
  resume — we decided to group the sources, consulting every native id source
  before any launcher one, and neglected persisting `cwd` and `client` into the
  session-name record so callers could join a launcher id back to a native
  session, to extend
  [0011](0011-prefer-a-resume-id-from-the-host-command-line.md)'s "a
  conversation id outranks a launch id" to sources outside the environment. We
  accept that the 869 existing launcher-keyed names are not migrated: measured
  2026-09-18, none of the 869 names an id any harness store can open, so they
  address launches that were never resumable and there is no continuity to
  carry. A launch id is minted fresh per launch, so an OMP conversation was
  renamed every time it was reopened by `--continue`, the picker, or a name; it
  now keeps one name across resumes. The grouping is the enforcement: a new
  native source appended to a flat chain would have sorted below the launcher
  id and silently done nothing, which is how this arose.

- **2026-09-22** — In the context of acquiring a path claim, facing targets
  that do not exist yet, we decided to accept a nonexistent target with a
  declared kind defaulting to file, and neglected requiring the target to
  exist, to let an agent reserve a name before creating the file, accepting
  that a declared kind can disagree with what is later created. WebDAV's
  locked-empty resources are the precedent.

- **2026-09-22** — In the context of a session-owned claim whose session has
  no process, facing a resumed session that returns under the same logical
  id, we decided to hold the claim for a fifteen-minute restart grace measured
  from the first observed absence, and neglected releasing at once as
  [0007](0007-manual-owner-expiry.md)'s asymmetry argument would, to let a
  resume continue behind its own claims, accepting that every crashed session
  blocks peers for up to the grace plus observation latency, and that
  harnesses which mint a new id on resume gain nothing from it.

- **2026-09-22** — In the context of releasing a claim, facing manual owners
  identified only by a typed label that two agents can share, we decided to
  issue an unguessable release token at acquisition and to make the token, a
  proven session id, or a plan's current executor the only release authority,
  and neglected label equality, to stop one label's holders releasing each
  other's claims, accepting that a caller which loses its token waits for
  expiry or supplies user authority.

- **2026-09-22** — In the context of a claim whose deadline has passed, facing
  either the daemon or an acquiring transaction noticing first, we decided to
  record the reason and time the deadline implies, and neglected a separate
  `stale_reclamation` reason for acquisition-time settlement, so provenance
  does not depend on which observer ran, accepting that the two paths share
  one release routine.

- **2026-09-22** — In the context of releasing a claim twice, facing ids that
  vanish on release, we decided to retain released claims for thirty days so
  a repeated release answers `already_released`, and neglected retaining them
  forever, to keep release idempotent for as long as a caller plausibly
  retries, accepting that an older id answers `unknown` and that history reads
  are excluded from the hot path.

- **2026-09-26** — In the context of cross-session mail attribution, facing a
  mis-attribution chain where receipts identified the receiving session but
  never the sender, and the sender id lived in `origin.sessionId` on MCP sends
  but only in `meta.sessionId` on CLI sends, we decided to stamp
  `origin.sessionId` on every verified send and echo a distinct
  `senderSessionId` onto delivery receipts and every rendering surface, and
  neglected joining receipts against the spool archive at read time, to keep
  "who sent this" answerable from the receipt log alone and from one
  derivation (`senderSessionIdOf`) everywhere, accepting duplicate identity
  across the two receipt fields and `meta.sessionId` remaining only as the
  legacy fallback for lines written before the canonical field existed.
