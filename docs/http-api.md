# HTTP API

The daemon serves a small HTTP API on 127.0.0.1, on `port` from
[configuration.md](configuration.md) (8377 by default). It exists for
automations that should not shell out to the CLI. Agents talking to each
other use the MCP tools, and people use the CLI or the dashboards.

| Endpoint | Description |
|---|---|
| `GET /` | persistent read-only web dashboard |
| `GET /api/v1/state?project=<path>` | schema-v1 non-mutating aggregate state; project is optional |
| `GET /api/state` | compatibility alias for `/api/v1/state` |
| `POST /notify` | `{project, message, from?, meta?, idempotencyKey?, ttlSeconds?, slackEcho?}` → guarded spool + optional Slack echo |
| `POST /read` | `{project, ids}` or `{project, all:true}` → mark messages read |
| `GET /health` | liveness + config summary |
| `GET /registry` | live channel-server registrations |
| `GET /inbox?project=<path>&limit=N&unread=1` | read a project's spool |
| `GET /receipts?project=<path>&message=<id>` | read delivery state changes |
| `GET /api/v1/push/oh-my-pi?project=<path>&sessionId=<id>&pid=<pid>&protocol=3` | protocol-v3 NDJSON mail stream for the bundled OMP extension |
| `POST /api/v1/push/oh-my-pi/ack` | `{deliveryToken}` → record an OMP push and mark it read after exact-session context insertion |

Automation that wants presence or aggregate state should consume
`agent-mail listeners --no-sync --json`, `agent-mail state --no-sync --json`,
or `GET /api/v1/state`, never agent-mail's files.
[automation.md](automation.md) specifies the outputs, their freshness
semantics, and what presence and receipts do and do not prove.

The daemon binds 127.0.0.1, so any process running as the local user can
submit text. The README's [security section](../README.md#security) covers
what that exposes and the inbound policies that contain it.

The OMP stream verifies the exact protocol version and that `pid` names a
current process before adding a listener. A protocol mismatch returns 409 with
the required version in `X-Agent-Mail-Protocol`. The first stream event echoes
the requested native OMP id and reports the routing id resolved by an exact
host-pid join to the MCP registration. Each mail event carries an opaque
acknowledgement token valid only for its negotiated live stream generation.
After OMP emits `message_start` for the exact agent-mail custom message, the
extension acknowledges; the daemon creates a `pushed` receipt, marks the message
read, and creates a per-session `read` receipt. Consumers must validate the
`X-Agent-Mail-Protocol: 3` response header, each event's `version`, the echoed
request id, and the exact project and resolved routing-id join. Unknown versions
are incompatible, not partial data to guess through. The read
semantics are specified by
[decision 0017](decisions/0017-omp-steering-injection-marks-read.md).
