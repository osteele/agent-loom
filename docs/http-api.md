# HTTP API

The daemon serves a small HTTP API on 127.0.0.1, on `port` from
[configuration.md](configuration.md) (8377 by default). It exists for
automations that should not shell out to the CLI. Agents talking to each
other use the MCP tools, and people use the CLI or the dashboards.

| Endpoint | Description |
|---|---|
| `GET /` | persistent read-only web dashboard |
| `GET /api/v1/state?project=<path>` | schema-v1 aggregate state; preserves mail and coordination while updating a disposable message index; project is optional |
| `GET /api/state` | compatibility alias for `/api/v1/state` |
| `GET /api/v1/state/revision` | `{kind:"agent_mail_state_revision", version:1, digest, generatedAt}`; the digest changes when an input of aggregate state changes. Served whether or not the dashboard is enabled. |
| `POST /notify` | `{project, message, from?, meta?, idempotencyKey?, ttlSeconds?, slackEcho?}` → guarded spool + optional Slack echo |
| `POST /api/v1/ledger-issues/refresh` | Request an early `issues list --json` snapshot tick; responds immediately, does not wait for the subprocess. Concurrent refreshes coalesce. |
| `POST /read` | `{project, ids}` or `{project, all:true}` → mark messages read |
| `GET /health` | liveness + config summary |
| `GET /registry` | live channel-server registrations |
| `GET /inbox?project=<path>&limit=N&unread=1` | read a project's spool |
| `GET /receipts?project=<path>&message=<id>` | read delivery state changes |
| `GET /api/v1/push/oh-my-pi?project=<path>&sessionId=<id>&pid=<pid>&protocol=3` | protocol-v3 NDJSON mail stream for the bundled OMP extension |
| `GET /api/v1/session-status?project=<path>&sessionId=<id>` | cached schema-v1 presentation status for an exact project and routing session |
| `POST /api/v1/push/oh-my-pi/ack` | `{deliveryToken}` → record an OMP push and mark it read after exact-session context insertion |

Automation that wants presence or aggregate state should consume
`agent-loom listeners --no-sync --json`, `agent-loom state --no-sync --json`,
or `GET /api/v1/state`, never agent-loom's files.
[automation.md](automation.md) specifies the outputs, their freshness
semantics, and what presence and receipts do and do not prove.

The daemon binds 127.0.0.1, so any process running as the local user can
submit text. The README's [security section](../README.md#security) covers
what that exposes and the inbound policies that contain it.

For addressed notifications, set `meta.toSession` to an exact opaque session ID.
The daemon resolves it globally and stores the message in that session's
registered mailbox. Human names and ID prefixes are not accepted by this field.
Omit it for an intentional broadcast to `project`. Empty or non-string IDs
return 400, missing IDs 404, multiple live mailboxes 409, and refusing recipients
403. Held recipients accept durable mail without authorizing push.

On cross-project routing, `meta.sourceProject` and `meta.fromProject` default
to the supplied `project`; explicit provenance values are preserved.
The stored top-level `project` is the destination mailbox. Local provenance
remains descriptive and cannot grant push authorization or user authority.

The OMP stream verifies the exact protocol version and that `pid` names a
current process before adding a listener. A protocol mismatch returns 409 with
the required version in `X-Agent-Loom-Protocol`. The first stream event echoes
the requested native OMP id and reports the routing id resolved by an exact
host-pid join to the MCP registration. Each mail event carries an opaque
acknowledgement token valid only for its negotiated live stream generation.
After OMP emits `message_start` for the exact agent-loom custom message, the
extension acknowledges; the daemon creates a `pushed` receipt, marks the message
read, and creates a per-session `read` receipt. Consumers must validate the
`X-Agent-Loom-Protocol: 3` response header, each event's `version`, the echoed
request id, and the exact project and resolved routing-id join. Unknown versions
are incompatible, not partial data to guess through. The read
semantics are specified by
[decision 0017](decisions/0017-omp-steering-injection-marks-read.md).

## Session status

Long-running clients use `GET /api/v1/session-status` instead of repeatedly
launching `agent-loom status-line`. OMP supplies the canonical project and
resolved routing session ID from its push handshake. The daemon collects status
on its 10-second presence tick, sharing unread collection with reminders and
reading work once per project. Requests only read the cache; they do not launch
processes or scan spools.

A successful response has `Cache-Control: no-store` and this shape:

```json
{
  "version": 1,
  "project": "/absolute/canonical/project",
  "sessionId": "resolved-routing-id",
  "generatedAt": 1789162967260,
  "name": "Excellent Otter",
  "nameNoun": "Otter",
  "peers": 0,
  "unread": 0,
  "delivery": "push",
  "unprocessed": null,
  "running": null,
  "work": {"version": 1, "items": []}
}
```

`generatedAt` is the collection time in epoch milliseconds. Counts are
nonnegative integers. `delivery` is `push`, `pull`, `unknown`, or an empty
string when registration capabilities are unavailable. `nameNoun` is the intact
noun from a generated adjective-noun name; custom and legacy names keep the
full display name. It is nullable for consumers that cannot obtain this field.
`unprocessed` counts terminal jobs awaiting processing; `running` counts actual
running jobs. Both require exact submitter-session and canonical project-root
attribution. Null means that count's Weft snapshot is unavailable or a job's
project cannot be attributed. Zero means a usable snapshot reports no matching
jobs. The snapshots refresh independently, so either count can be unavailable.

`work: null` means work collection failed. Otherwise, each item has `id`,
`resourceType`, `resourceKey`, `state` (`working` or `waiting`), and an ISO
`updatedAt` timestamp, with optional string `label`, `sourcePath`, and
`activity` fields. Optional `progress` is an object with positive safe integer
`current`, optional positive safe integer `total >= current`, and optional string
`label`. Missing progress means position is unreported; clearing removes the
field. This remains a version-1 contract. A work lease matches the logical
session ID of a live registration, including across process restarts.
Muted sessions still receive unread status counts;
muting suppresses their reminders, not their status lookup.

Missing query fields return 400. Unknown project/session pairs return 404.
Collection failures, an uninitialized cache, and snapshots older than
30 seconds return 503. A newly connected session may wait until the next tick
for its first status. Clients validate the version, exact identity, field
types, and age; a failed refresh retains only the same session's cached status,
marked stale with its age. The cache is presentation-only, never a delivery,
liveness, or coordination authority.
