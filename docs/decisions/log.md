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
