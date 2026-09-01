# Decision records

Engineering decisions that constrain agent-mail, with the alternatives that
were rejected and the consequences that follow. The format matches
`../../../cross-agent-review/docs/decisions/`.

A record belongs here when a future reader could reasonably undo the decision
by mistake — because the rule looks arbitrary, looks like an unfinished
feature, or looks like a safe simplification.

A change of position is a new record that names the one it supersedes. The
superseded record's `status` is updated to name its successor — lifecycle
metadata, not a revision: its body still states what was decided when it was
decided. A record that states something untrue is corrected in place instead.

| # | Decision | Adopted |
|---|---|---|
| [0001](0001-single-machine-coordination-identity.md) | Coordination owner identity assumes a single machine | 2026-08-15 |
| [0002](0002-no-fencing-tokens.md) | Claims stay advisory; no fencing tokens | 2026-08-15 |
| [0003](0003-addressing-automation-notifications.md) | Automation notifications are addressed to the submitting session | 2026-08-16 |
| [0004](0004-authority-forced-recovery.md) | A declared authority can force recovery; it is recorded, not verified — auto-expiry rejection superseded by [0007](0007-manual-owner-expiry.md) | 2026-08-16 |
| [0005](0005-no-windows-support.md) | Windows is unsupported, and stays out of CI | 2026-08-19 |
| [0006](0006-bun-checkout-node-distribution.md) | Use Bun for checkout sources and Node for distributions | 2026-08-21 |
| [0007](0007-manual-owner-expiry.md) | Manual coordination owners expire after 24 hours | 2026-08-21 |
| [0008](0008-hook-reminder-trust-limits.md) | Hook reminders announce only: no receipts, no peer text — Stop-blocking rejection superseded by [0015](0015-stop-hooks-continue-once-per-new-mail-edge.md) | 2026-08-22 |
| [0009](0009-prefer-launcher-minted-session-id.md) | Prefer the launcher-minted session id over native ids — superseded by [0010](0010-adopt-the-host-agent-session-id.md) | 2026-08-25 |
| [0010](0010-adopt-the-host-agent-session-id.md) | Adopt the host agent's session id when spawned without one | 2026-08-25 |
| [0011](0011-prefer-a-resume-id-from-the-host-command-line.md) | Prefer a resume id from the host's command line | 2026-08-25 |
| [0012](0012-allow-friendly-session-names-to-recycle.md) | Allow friendly session names to recycle | 2026-08-28 |
| [0013](0013-check-inbox-marks-returned-mail-read.md) | Reading marks read: check_inbox acknowledges the mail it returns | 2026-08-28 |
| [0014](0014-cli-identity-requires-a-host-process-match.md) | A CLI session id is adopted only with a host-process match | 2026-08-31 |
| [0015](0015-stop-hooks-continue-once-per-new-mail-edge.md) | Stop hooks continue once per new mail edge | 2026-08-31 |
