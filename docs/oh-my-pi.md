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

The extension replaces OMP's native status row with a responsive two-row widget.
To remove the native duplicate, configure an empty custom status line:

```yaml
statusLine:
  preset: custom
  separator: none
  showHookStatus: false
  leftSegments: []
  rightSegments: []
```

The first widget row carries the former native status information: the
model/effort pair, project (`📁`), revision, pending terminal Weft jobs (`⚙️`),
and context-window bar. The second row groups the routable agent-mail display
name, peer count, and unread messages (`✉️`), followed by the active Python
environment, JavaScript runtime, development-server ports, and weekly
subscription use. Zero mail and job counts are omitted; an unavailable count
renders as `?`, never as zero.
Both rows use `·` separators and independently drop lower-priority fields to fit
a narrow pane. Available progress bars are the final fields, expand through the
remaining width, and use right-aligned `ctx` and `wk` labels. Both meters use
the same shorter block and green for healthy headroom; the lower row's top gap
separates the bars, and empty cells are dimmed. The aligned meter begins after
whitespace rather than a `·`, so the final ordinary field does not carry a
dangling separator.

In a jj workspace the revision comes from a tagged `jj log` template and Git is
not queried or shown. A dirty working copy adds `*`; `ⅉ` identifies Jujutsu and
`⎇` identifies Git, matching gitsync's repository symbols. Outside jj, Git state
comes from porcelain v2. Revision colors distinguish clean and dirty state.

For an OAuth subscription, the weekly meter uses OMP's public normalized
`authStorage.fetchUsageReports()` API and renders a bar plus percent used. An
ambiguous or unavailable provider/account join renders `wk ?`. When OMP reports
that the current model uses an API key, config override, environment key, or
other non-OAuth credential, the same high-priority field turns red and shows
session cost, hourly run rate, and token count instead.

The human-facing mail name comes from the same registered, routable address
used for delivery; until that status snapshot resolves, the extension falls
back to the full address supplied by the push connection. Unknown counts render
as `?` rather than zero. The daemon joins OMP's extension to its agent-mail MCP
registration only by the verified OMP host pid recorded by that subprocess; one
exact match supplies the routing id, while zero or several matches retain the
extension's requested id rather than guessing. When a launcher-minted identity
is available, its process marker must name this OMP process, which rejects an id
inherited from an outer agent. Push, tools, status, policies, and receipts then
describe one logical mailbox even though the MCP and push components retain
separate process-liveness records. Unread counts are the current session's
visible unread mail rather than a project total: self-sent mail, messages
directed to a different session, and refused or expired deliveries do not
count.

Development ports come from `lsof`'s field output joined to a `ps` parent table.
Only common listening ports owned by OMP or one of its descendants are shown;
an unrelated server elsewhere on the machine cannot produce `:3000`. Other
status refreshes consume the documented
`agent-mail status-line --fields`, Git porcelain v2, jj template output, and OMP
extension APIs instead of reading another tool's private state.

Incoming messages use OMP custom messages with agent attribution, carry an
explicit external/untrusted envelope, and are queued after an active turn or
start a turn when the session is idle.

The extension uses OMP's public, versioned extension API and the daemon's
versioned loopback NDJSON endpoint. The connection response echoes the native
requested id and reports the resolved routing id; later events must carry that
exact project and routing id before the extension injects them. Acknowledgement
happens only after OMP accepts the custom message; only then does agent-mail
write a `pushed` receipt with detail `oh-my-pi`.

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
- A broken daemon connection is visible as `<name> (offline)` in the widget and
  reconnects with bounded backoff.
