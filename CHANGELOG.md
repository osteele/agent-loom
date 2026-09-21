# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Preserve the previous Codex MCP registration when replacement fails, and
  stop treating every failed `codex mcp get` probe as proof that the entry is
  absent.
- Record each live intended recipient when mail enters the spool. Known channel
  setup failures now report `push-unreachable` instead of `pushed`; attached
  recipients that never poll remain visible as `pending`.
- Keep `agent-mail inbox` from acknowledging direct mail addressed to another
  session in the same project.
- Stop giving an OMP session a second mail identity. Its push transport joins
  the session registered under its verified host pid; when no session is
  registered there yet — the ordinary startup order — or several are, the
  daemon refuses the connection and registers nothing instead of falling back to
  the id the extension proposed. A session that held two identities had its
  status line reporting the unread count, and the delivery mode, of a mailbox
  its own agent never read.

### Added

- Accept cross-project MCP path claims when `claim_path` receives the
  destination project's canonical absolute path.
- Add versioned `agent-mail inbox --json` output with structured sender
  project, name, and session fields.
- Include the process ID that establishes liveness in `list_sessions` output.
- Resolve advisory session identity with
  `session-address --project ABS --session RAW --json`, using only the fresh
  listener snapshot and failing closed without registry scans or state writes.
- Inspect exact-session work and full contained plan sources with
  `work tui --session ID --project ABS`, including read-only interactive
  navigation and plain-text `--once` snapshots.
- Report optional structured work positions through CLI step flags and MCP
  `progress` metadata, with explicit clearing and version-1 status projection.
- Address a project's owner through `notify --role owner` or `send_mail role`.
  Inspect, claim, and release ownership with `owner` or `project_owner`; a sole
  live session is inferred when no assignment exists, and ambiguous ownership
  refuses delivery instead of broadcasting.
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

- Make path claims one-record-per-acquisition with exact-repeat idempotence,
  observed target kinds, future-name reservation, one-time release tokens,
  retained release history, session restart grace, and plan ownership tied to
  research-plan work leases.
- Require both declared authority and a reason for forced coordination
  recovery, and record both in the recovery audit log.

- Collect OMP mail status in the daemon and serve it through the versioned
  session-status API instead of launching a status CLI in each session.
  Cached failures display their age; push delivery remains independent.
- Make `notify --reply-to` and `send_mail reply_to` address the original sender
  across projects while preserving the thread. Explicit session addressing
  overrides return routing; unresolved reply recipients fail before sending.
- Keep the Oh My Pi integration in OMP's native status line and limit its
  status fields to agent-mail identity, peers, unread mail, and Weft backlog.

### Fixed

- Route exact session IDs to their registered mailbox across projects in CLI,
  MCP, and HTTP notifications, preserving source-project provenance. CLI and
  MCP resolve unique human names globally and use project to disambiguate name
  collisions. Missing, ambiguous, or refusing recipients fail explicitly.
- Refuse empty, unknown, or ambiguous `notify --session` recipients instead of
  broadcasting job completions to unrelated sessions in the project.
- Keep OMP subagents from replacing their parent's mail connection and causing
  repeated offline indicators or temporary name changes. Status-name lookups
  wait for the resolved routing identity and discard obsolete results.
- Stamp return addresses on CLI mail launched directly by OMP hosts that do not
  export session-ID variables, while refusing ambiguous or indirect hosts.
- Keep OMP push sessions registered when a stale connection closes after a
  reconnect, including reconnects that change the routing identity.
- Preserve verified CLI sender identities across project boundaries and record
  OMP push hosts for CLI attribution so their messages carry reply addresses.
- Interrupt OMP `hub wait` calls when mail arrives by delivering pushed mail as
  steering input instead of a queued follow-up.
- Mark an OMP steering push read when OMP's exact-session `message_start` event
  confirms that the custom message entered context. Protocol v3 is negotiated
  at connect time and rejects older queued-follow-up clients before registration.
- Avoid inserting the same OMP mail into context twice when a stream resumes
  before acknowledgement, and warn when context insertion is not observed.
- Keep OMP push connected when the working directory has a symlink alias, such
  as macOS `/tmp`, by joining on the canonical project path.
- Suppress stale coordination reminders when claims change before admission and
  coalesce sibling claims at each owner-level age milestone.
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
- Keep Oh My Pi host-accepted pushes unread while retaining their `pushed`
  receipt; accepting a queued follow-up does not prove context delivery.
- Split the unread count into pushed-but-unread and never-pushed mail without
  treating either group as handled.
- Remind a session about mail it has not cleared, separating pushed mail from
  mail with no push receipt, and counting never-pushed mail only from when that
  session began and only when that session may see it. Cooldowns and scheduling
  are independent for each project mailbox, even when session IDs match.
- Carry explicit `check_inbox` and `mark_read` guidance on push and reminder
  messages because current push paths do not mark mail read.
- Keep newly generated session nouns distinct from those held by registered
  sessions after the 30-day cooldown pool is exhausted.

## [0.1.0] - 2026-08-19

Initial release.

[Unreleased]: https://github.com/osteele/agent-mail/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/osteele/agent-mail/tree/v0.1.0
