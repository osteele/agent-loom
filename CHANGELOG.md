# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add `agent-mail triage-candidates` for unread broadcasts, direct mail without
  a live recipient, and direct mail its live recipient refused.
- Accept repeated `--id` flags on `agent-mail mark-read` so triage can settle an
  exact message set without consuming other sessions' direct mail.
- Notify pull-only clients such as Codex, Kimi Code, and Gemini CLI about new
  mail through installable reminder hooks.
- Report a session's unread backlog when its MCP server starts.
- Remind live sessions about retained path and experiment claims at bounded
  condition and age milestones.
- Format agent-mail status information for Kimi Code status lines.

### Changed

- Keep the Oh My Pi integration in OMP's native status line and limit its
  status fields to agent-mail identity, peers, unread mail, and Weft backlog.

### Fixed

- Render message Markdown as Slack `mrkdwn` in per-message echoes and escape
  Slack control characters in message bodies.
- Keep session addresses routable after Claude Code rotates its session ID, and
  expire abandoned coordination records owned outside a live agent session.
- Prevent duplicate sends when a slow daemon request races its direct fallback.
- Keep Claude Code session IDs distinct from agent-mail display names when
  routing messages.
- Install the correct runtime and entry-point format for package installations
  and development checkouts.
- Prevent stale daemon pidfiles from reporting a running daemon as stopped.
- Restore a live session's registry entry automatically if a liveness sweep
  removes it while its channel server is still running.
- Confirm a pid individually before treating its absence from a whole-table
  process scan as proof that the session exited.
- Annotate every push receipt with its channel status, so a healthy-looking
  bare `pushed` no longer reads as proof a notification was received.
- Report what `check_inbox` returned and what it is a page of, so a page can
  be told from a whole inbox and each unread count names its own scope.
- Rewrite a session's registration when its stored client or capabilities no
  longer match what the running process would write.
- Print help for `<command> --help` instead of running the command.
- Name the scope of the unread count `agent-mail inbox` reports, so a
  project-wide total is not read as one session's mail.
- Add `agent-mail unregistered`, which names sessions that recorded delivery
  with no live registration — the shape of a session the registry has lost.
- Mark a message read when a transport that acknowledges delivery reports the
  host durably accepted it; fire-and-forget channel push still marks nothing.
- Split the unread count into delivered-but-unacknowledged and never delivered,
  so handled mail is not reported as outstanding work.
- Remind a session about mail it has not cleared, separating what was pushed
  and never acknowledged from what never reached it, and counting undelivered
  mail only from when that session began, and only mail that session may see.
  Cooldowns and scheduling are independent for each project mailbox, even when
  session IDs match.
- Carry the acknowledgement instruction on the push itself, for transports that
  cannot mark read on their own.

## [0.1.0] - 2026-08-19

Initial release.

[Unreleased]: https://github.com/osteele/agent-mail/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/osteele/agent-mail/tree/v0.1.0
