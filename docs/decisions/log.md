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
