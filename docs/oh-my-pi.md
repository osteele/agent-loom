# Oh My Pi

[Oh My Pi](https://github.com/can1357/oh-my-pi) exposes the exact session ID, custom-message injection, and keyed native status slots needed for agent-mail push delivery.

## Install the extension

Install Oh My Pi, start the agent-mail daemon, and link the bundled extension:

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

Unknown Weft state renders as `unprocessed ?`. A known zero remains `0 unprocessed`. The extension reads these values from the documented `agent-mail status-line --fields` contract and does not inspect agent-mail or Weft private state.

## Session identity

OMP's extension process and its agent-mail MCP process share the launcher identity when `AGENT_SESSION_ID` was minted for the current OMP process. Otherwise, the extension sends OMP's native session ID and the daemon resolves it by the verified host-process join.

The protocol-v2 connection response carries both the requested session ID and the resolved routing ID. Every later mail event must match the resolved project and routing ID. An ambiguous join is rejected instead of guessed.

## Delivery behavior

The extension keeps a loopback NDJSON stream open to the daemon. Incoming mail becomes an OMP custom message with agent attribution and triggers a follow-up turn. The extension acknowledges the delivery only after OMP accepts the custom message; agent-mail then records a `pushed` receipt with detail `oh-my-pi`.

A broken connection changes the native status entry to offline and retries with bounded backoff. Mail remains in the durable project spool while OMP is disconnected.

Mute and inbound `accept`, `hold`, and `refuse` policies apply normally. Muting pauses channel push without advancing the session's spool offset.

## Troubleshooting

```bash
agent-mail status
agent-mail notify --project "$PWD" --message ping
agent-mail inbox --project "$PWD"
omp plugin list --json
```

If the plugin is linked but OMP still runs old behavior, end the OMP session and start another. Restarting only the agent-mail daemon does not reload extension source already held by OMP.
