# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

## [0.1.0] - 2026-08-19

Initial release.

[Unreleased]: https://github.com/osteele/agent-mail/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/osteele/agent-mail/tree/v0.1.0
