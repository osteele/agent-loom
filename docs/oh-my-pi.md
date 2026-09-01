# Oh My Pi

[Oh My Pi](https://github.com/can1357/oh-my-pi) can run alongside Codex while
using an OpenAI Codex subscription login. Its extension API provides the exact
session ID, message injection, and a keyed status slot, so agent-mail can push
new mail without polling or inferring which session should receive it.

Install OMP with mise and verify the released binary:

```bash
mise use -g github:can1357/oh-my-pi
omp --version
```

If mise reports GitHub authentication failure because a stale `GITHUB_TOKEN`
overrides the public release download, retry the first command as
`env -u GITHUB_TOKEN mise use -g github:can1357/oh-my-pi`. This does not change
OMP provider authentication. The integration is tested with OMP 18.1.1.

Link the bundled extension at user scope:

```bash
omp plugin link --scope user "$(agent-mail oh-my-pi-plugin-path)"
omp plugin doctor
```

Start `omp` in a real terminal. Run `/login`, choose `openai-codex`, and finish
the browser login. Then use `/model` to assign the GPT model you want to the
`default` role (or rerun `omp setup` and choose it in the default-model step).
OMP stores its own login and does not give the agent-mail extension access to
provider credentials.

The plugin does not install an OMP-specific `AGENTS.md`. OMP's context
discovery can therefore continue to import the existing Codex and
agent-neutral instructions, skills, and MCP configuration instead of shadowing
them with a second configuration tree.

The status line keeps `mail <name>` after the daemon accepts the connection and
adds the session's unread-message count, unprocessed terminal Weft-job count,
and nearest ancestor jj bookmark when the project is a jj workspace:

```
mail Quiet Lantern · 2 unread · 3 unprocessed · jj main
```

The human-facing display name comes from the same registered, routable
agent-mail address used for delivery; until that status snapshot resolves, the
extension falls back to the full address supplied by the push connection.
Unknown counts render as `?` rather than as zero, and a failed jj query is
independent of mail status. Status refreshes use the documented
`agent-mail status-line --fields` contract and `jj log --ignore-working-copy`,
so the extension does not parse either tool's private state or snapshot the jj
working copy merely to render a footer.
Incoming messages use OMP custom messages with agent attribution, carry an
explicit external/untrusted envelope, and are queued after an active turn or
start a turn when the session is idle.

The extension uses OMP's public, versioned extension API and the daemon's
versioned loopback NDJSON endpoint. It verifies the event protocol, project,
and exact OMP session ID before injecting a message. Acknowledgement happens
only after OMP accepts the custom message; only then does agent-mail write a
`pushed` receipt with detail `oh-my-pi`.

## Non-default daemon port

The extension connects to `http://127.0.0.1:8377` by default. Set
`AGENT_MAIL_DAEMON_URL` before starting OMP when the daemon uses another port:

```bash
AGENT_MAIL_DAEMON_URL=http://127.0.0.1:9000 omp
```

Only loopback HTTP URLs are accepted.

## Delivery behavior

- The project spool and receipt log remain authoritative.
- A first connection begins at the current spool end. Reconnects resume from
  the last offset and replay messages still awaiting acknowledgement.
- A lost acknowledgement can produce a duplicate after reconnect; the visible
  message ID identifies it.
- Mute and inbound `accept`, `hold`, and `refuse` policies apply normally.
- A broken daemon connection is visible as `mail <name> (offline)` in OMP's
  status line and reconnects with bounded backoff.
