# Oh My Pi

[Oh My Pi](https://github.com/can1357/oh-my-pi) exposes the exact session ID, custom-message injection, and keyed native status slots needed for agent-mail push delivery.

## Install the extension

Install Oh My Pi 18.1.10 or newer, start the agent-mail daemon, and link the
bundled extension:

```bash
cd /path/to/agent-mail
bun install
agent-mail start
omp plugin link --scope user ./examples/oh-my-pi/agent-mail-push
```

`omp plugin list` should show `agent-mail-oh-my-pi` as enabled. Restart OMP after linking or changing the extension. OMP loads extension source once per session.

Set `AGENT_MAIL_DAEMON_URL` when the daemon uses a non-default loopback port:

```bash
export AGENT_MAIL_DAEMON_URL=http://127.0.0.1:9123
```

The extension rejects non-loopback daemon URLs.

## Native status line

The extension writes one keyed entry through OMP's native `ctx.ui.setStatus` API. It does not replace the native footer or define a custom status widget.

The entry contains agent-mail state only:

- routable agent-mail identity and push connection state;
- active peer count;
- unread message count;
- unprocessed Weft jobs submitted by the session, when agent-mail's snapshot has a usable value.

Unknown Weft state renders as `unprocessed ?`. A known zero remains `0 unprocessed`. The extension polls the daemon's versioned [session-status API](http-api.md#session-status), not a CLI subprocess or agent-mail's private files. The daemon collects status every 10 seconds. A failed refresh keeps matching cached values and displays their stale age.

## Session identity

The extension runs only in interactive contexts (`ctx.hasUI`). In-process
subagents share their parent's PID, and they do not participate in mail: a
subagent's mail is its parent's, so it opens no push connection and polls no
status line of its own. Headless contexts leave this extension inactive.

The session's identity is the one its agent-mail MCP component registered. The
extension does not supply it — it cannot; OMP owns a native conversation id but
does not export it to MCP subprocesses, and the id the extension can reach is a
launcher value that names a launch rather than a conversation. What the
extension supplies is its host pid, which the daemon verifies, and the daemon
joins the transport to the one session registered under that pid.

The session id in the connect request is therefore a proposal, echoed back as
`requestedSessionId` for diagnosis and never registered under. When the join
names no session — the ordinary case at startup, since the extension connects
from inside the host before the MCP subprocess has registered — or names
several, the daemon refuses with `503` and registers nothing, and the
extension's reconnect joins a moment later. A transport attaches to an identity;
it never creates one
([0018](decisions/0018-a-transport-attaches-to-an-identity.md)).

The protocol-v3 connection response carries both the requested session ID and the resolved routing ID. Every later mail event must match the resolved project and routing ID. The daemon rejects a protocol mismatch before registering the listener; protocol v3 identifies steering-capable clients whose acknowledgement follows exact-session context insertion.

Status-name lookups wait for that routing ID. A reconnect to the same ID keeps
the cached name; a changed ID clears the previous session's status. Results
from an obsolete identity or ended lifecycle cannot replace the current name.

## Delivery behavior

The extension keeps a loopback NDJSON stream open to the daemon. Incoming mail becomes OMP steering input with agent attribution. An idle recipient starts a turn; a busy recipient sees the message at the next agent step, and an interruptible tool such as `hub wait` stops promptly so that step can run. Non-interruptible tools finish normally. The extension acknowledges only after OMP emits `message_start` for the exact agent-mail custom message; agent-mail then records both a `pushed` receipt with detail `oh-my-pi` and a `read` receipt.

Mail headers show the sender label and source workspace path, so a role such as
`Main` remains distinguishable across projects. CLI and MCP sends record this
path with the message. Legacy messages use an absolute sender path when available;
otherwise the workspace is shown as `unknown`. The recipient mailbox is never
used as a substitute for the sender's workspace.

A broken connection changes the native status entry to offline and retries with bounded backoff. A resumed delivery refreshes its acknowledgement token without inserting the same mail into context again. Mail remains in the durable project spool while OMP is disconnected. The extension logs a warning when OMP does not emit the matching `message_start` within 30 seconds.

A reconnect replaces the previous push connection for the same project and host
process, even when its routing ID changes. Mute and inbound policy settings
survive the handoff. Closing an old connection cannot remove its replacement's
registration; connections for other projects remain independent.

Mute and inbound `accept`, `hold`, and `refuse` policies apply normally. Muting pauses channel push without advancing the session's spool offset.

## Troubleshooting

```bash
agent-mail status
agent-mail notify --project "$PWD" --message ping
agent-mail inbox --project "$PWD"
omp plugin list --json
```

If the plugin is linked but OMP still runs old behavior, end the OMP session and start another. Restarting only the agent-mail daemon does not reload extension source already held by OMP.
