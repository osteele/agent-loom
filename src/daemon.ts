#!/usr/bin/env node
/** agent-mail daemon: localhost HTTP ingress + Slack echo.
 *
 * Endpoints (127.0.0.1 only):
 *   POST /notify   {project, from, message, meta?} -> append spool, echo Slack
 *   POST /read     {project, ids?} or {project, all:true} -> mark read
 *   GET  /health   daemon liveness + config summary
 *   GET  /          persistent read-only dashboard
 *   GET  /api/state dashboard JSON
 *   GET  /registry live channel-server registrations
 *   GET  /inbox?project=<path>&limit=N&unread=1  read a project's spool
 *   GET  /api/v1/push/oh-my-pi  versioned OMP NDJSON push stream
 *   POST /api/v1/push/oh-my-pi/ack  acknowledge exact-session OMP delivery
 *   GET  /api/v1/session-status  cached status for an exact project/session
 *
 * SIGTERM: graceful stop. SIGHUP: reload config (Slack webhook, echo mode).
 */

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ackReminderMailboxKey,
  ackReminderStatesEqual,
  prepareAckReminder,
  pruneAckReminderState,
  readAckReminderState,
  recordAckReminder,
  writeAckReminderState,
} from "./ackReminders.ts";
import {
  CLAIM_REMINDER_SWEEP_MS,
  claimReminderStatesEqual,
  claimReminderStillCurrent,
  prepareClaimReminderSweep,
  readClaimReminderState,
  recordClaimReminder,
  writeClaimReminderState,
} from "./claimReminders.ts";
import { claims } from "./claims.ts";
import { type Config, loadConfig } from "./config.ts";
import { listCoordination } from "./coordination.ts";
import { dashboardResponse } from "./dashboard.ts";
import { LOG_PATH, PID_PATH, canonicalProject, ensureDirs } from "./paths.ts";
import { writePresenceSnapshot } from "./presence.ts";
import { writeProcessSnapshot } from "./processSnapshot.ts";
import { RecipientError, resolveRecipient } from "./recipients.ts";
import { listLive } from "./registry.ts";
import { serve, spawnCapture, which } from "./runtime.ts";
import { OhMyPiPushBridge } from "./sessionPush.ts";
import { SessionStatusCache } from "./sessionStatus.ts";
import { claudeSessions, resetSessionAliasCache } from "./sessions.ts";
import { formatSlackEcho } from "./slackEcho.ts";
import {
  type AdmissionOptions,
  type Message,
  appendMessageGuarded,
  markAllMessagesRead,
  markMessagesRead,
  readMessages,
  readReceipts,
  shouldEchoMessageToSlack,
} from "./spool.ts";
import { flushTransferNotifications, transfers } from "./transfers.ts";
import { writeUnreadSummarySnapshot } from "./unreadSummary.ts";
import {
  WEFT_JOBS_REFRESH_MS,
  parseUnprocessedGroups,
  writeWeftJobsSnapshot,
} from "./weftJobs.ts";

let config: Config = loadConfig();
const ohMyPiPush = new OhMyPiPushBridge();
const sessionStatus = new SessionStatusCache();

function tickSessionPush(): void {
  void ohMyPiPush
    .poll()
    .catch((error) => log(`session push delivery failed: ${error}`));
}

function admissionOptions(): AdmissionOptions {
  return {
    duplicateWindowSeconds: config.duplicateWindowSeconds,
    messageRateLimitPerMinute: config.messageRateLimitPerMinute,
    defaultMessageTtlSeconds: config.defaultMessageTtlSeconds,
  };
}

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  appendFileSync(LOG_PATH, stamped);
}

async function echoToSlack(msg: Message): Promise<void> {
  if (
    config.slackEcho === "none" ||
    !config.slackWebhook ||
    !shouldEchoMessageToSlack(msg)
  )
    return;
  const formatted = formatSlackEcho(msg, listLive(), claudeSessions());
  const blocks: object[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: formatted.sectionText },
    },
  ];
  if (!formatted.listening) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "_no session listening; spooled_" }],
    });
  }

  const resp = await fetch(config.slackWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // `text` is the notification/preview fallback when blocks can't render.
    body: JSON.stringify({
      text: formatted.fallbackText,
      blocks,
    }),
  });
  if (!resp.ok) {
    log(`slack echo failed: ${resp.status} ${await resp.text()}`);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 1), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

ensureDirs();

const server = await serve({
  port: config.port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    // Gated on config, not on the route table: when the dashboard is off the
    // daemon serves only its JSON API, and a dashboard URL is a 404 like any
    // other unknown path rather than a 403 that advertises the feature.
    if (req.method === "GET" && config.dashboard) {
      const dashboard = dashboardResponse(req);
      if (dashboard) return dashboard;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        pid: process.pid,
        port: config.port,
        slack: config.slackWebhook ? config.slackEcho : "unconfigured",
      });
    }

    if (req.method === "GET" && url.pathname === "/registry") {
      return json(listLive());
    }

    if (req.method === "GET" && url.pathname === "/inbox") {
      const project = url.searchParams.get("project");
      if (!project) return json({ error: "missing ?project=" }, 400);
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const unread = url.searchParams.get("unread") === "1";
      return json(
        readMessages(canonicalProject(project), { limit, unreadOnly: unread }),
      );
    }

    if (req.method === "GET" && url.pathname === "/receipts") {
      const project = url.searchParams.get("project");
      if (!project) return json({ error: "missing ?project=" }, 400);
      const messageId = url.searchParams.get("message") ?? undefined;
      return json(readReceipts(canonicalProject(project), messageId));
    }

    if (req.method === "GET" && url.pathname === "/api/v1/session-status") {
      const project = url.searchParams.get("project");
      const sessionId = url.searchParams.get("sessionId");
      if (!project || !sessionId) {
        return json(
          { error: "required query fields: project, sessionId" },
          400,
        );
      }
      return sessionStatus.response(project, sessionId);
    }

    if (req.method === "GET" && url.pathname === "/api/v1/push/oh-my-pi") {
      const project = url.searchParams.get("project");
      const sessionId = url.searchParams.get("sessionId");
      const protocolVersion = Number(url.searchParams.get("protocol"));
      const pid = Number(url.searchParams.get("pid"));
      if (!project || !sessionId || !url.searchParams.has("protocol")) {
        return json(
          { error: "required query fields: project, sessionId, pid, protocol" },
          400,
        );
      }
      return ohMyPiPush.connect(
        {
          project,
          sessionId,
          pid,
          protocolVersion,
          defaultInboundPolicy: config.inboundPolicy,
          heldMessageLimit: config.heldMessageLimit,
        },
        req.signal,
      );
    }

    if (req.method === "POST" && url.pathname === "/api/v1/push/oh-my-pi/ack") {
      let body: { deliveryToken?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (typeof body.deliveryToken !== "string") {
        return json({ error: "required field: deliveryToken" }, 400);
      }
      if (!ohMyPiPush.acknowledge(body.deliveryToken)) {
        return json({ error: "unknown or stale delivery token" }, 409);
      }
      return json({ ok: true });
    }

    if (req.method === "POST" && url.pathname === "/notify") {
      let body: Partial<Message> & { ttlSeconds?: unknown };
      try {
        body = (await req.json()) as Partial<Message>;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (!body.project || !body.message) {
        return json({ error: "required fields: project, message" }, 400);
      }
      if (Buffer.byteLength(body.message, "utf8") > 65_536) {
        return json({ error: "message exceeds 64 KiB" }, 413);
      }
      const now = Date.now();
      const ttlSeconds =
        typeof body.ttlSeconds === "number" && body.ttlSeconds >= 0
          ? body.ttlSeconds
          : undefined;
      const msg: Message = {
        ts: new Date(now).toISOString(),
        from: body.from ?? "unknown",
        project: canonicalProject(body.project),
        message: body.message,
        delivery: body.delivery === "audit" ? "audit" : "mail",
        origin: {
          kind: body.origin?.kind ?? "automation",
          transport: body.origin?.transport ?? "http",
          ...(body.origin?.client ? { client: body.origin.client } : {}),
          ...(body.origin?.sessionId
            ? { sessionId: body.origin.sessionId }
            : {}),
          // Local callers may describe provenance, but cannot grant authority.
          authority: "untrusted",
        },
        ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
        // Stored verbatim: the sender matches against it if it has to fall back
        // to a direct append after losing this response.
        ...(body.attemptKey ? { attemptKey: body.attemptKey } : {}),
        ...(ttlSeconds !== undefined
          ? { expiresAt: new Date(now + ttlSeconds * 1000).toISOString() }
          : body.expiresAt
            ? { expiresAt: body.expiresAt }
            : {}),
        ...(body.replyTo ? { replyTo: body.replyTo } : {}),
        ...(body.threadId ? { threadId: body.threadId } : {}),
        ...(body.slackEcho === false ? { slackEcho: false } : {}),
        ...(body.meta ? { meta: body.meta } : {}),
      };
      if (msg.meta?.toSession !== undefined) {
        if (typeof msg.meta.toSession !== "string")
          return json(
            { error: "meta.toSession must be an exact session ID" },
            400,
          );
        try {
          const recipient = resolveRecipient(
            msg.project,
            msg.meta.toSession,
            true,
          );
          if (recipient.project !== msg.project) {
            msg.meta = {
              ...msg.meta,
              sourceProject: msg.meta.sourceProject ?? msg.project,
              fromProject: msg.meta.fromProject ?? msg.project,
            };
          }
          msg.project = recipient.project;
        } catch (error) {
          if (!(error instanceof RecipientError)) throw error;
          return json({ error: error.message }, error.status);
        }
      }
      const result = appendMessageGuarded(msg, admissionOptions(), now);
      if (result.status === "rate_limited") {
        return json(result, 429);
      }
      if (result.status === "duplicate") return json(result);
      log(`notify from=${msg.from} project=${msg.project}`);
      // Fire-and-forget: the spool append is the durable commitment; a slow
      // Slack POST must not delay the response (a timed-out client would
      // fall back to a direct spool append and double-deliver).
      echoToSlack(msg).catch((err) => log(`slack echo error: ${err}`));
      tickSessionPush();
      return json({ ok: true, ...result });
    }

    if (req.method === "POST" && url.pathname === "/read") {
      let body: { project?: string; ids?: unknown; all?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (!body.project) return json({ error: "required field: project" }, 400);
      const project = canonicalProject(body.project);
      if (body.all === true) {
        return json({ ok: true, marked: markAllMessagesRead(project) });
      }
      if (!Array.isArray(body.ids)) {
        return json({ error: "required field: ids array or all=true" }, 400);
      }
      const ids = body.ids.filter((id): id is string => typeof id === "string");
      return json({ ok: true, marked: markMessagesRead(project, ids) });
    }

    return json({ error: "not found" }, 404);
  },
});

// Claimed only once the port is ours. Written before the bind, a second
// daemon losing the race for the port would overwrite the pidfile with its own
// pid and then exit, leaving the file pointing at a dead process while the
// real daemon kept running -- which reads downstream as "daemon: stopped".
writeFileSync(PID_PATH, String(process.pid));

log(`daemon started pid=${process.pid} port=${config.port}`);

/** Periodic liveness sweep.
 *
 * Two jobs. It publishes the snapshot that latency-bound readers (the status
 * line) use instead of running their own process scan. And because `listLive()`
 * prunes as a side effect, this is the only thing that removes dead
 * registrations without a human happening to run `listeners` or open a
 * dashboard.
 *
 * No SIGHUP coupling is needed because the snapshot stores raw registrations —
 * nothing in it derives from config. If it ever starts carrying names or
 * aliases, it must be invalidated in the SIGHUP handler too. */
const PRESENCE_TICK_MS = 10_000;
let lastLiveCount = -1;

function tickPresence(): void {
  try {
    const snapshot = writePresenceSnapshot();
    writeProcessSnapshot();
    claims.observeSessions(
      new Set(
        snapshot.sessions
          .map((registration) => registration.sessionId)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    // Status and reminders share one project-grouped unread collection.
    // Muted sessions still get status counts, but no reminder entry.
    const status = sessionStatus.refresh(snapshot.sessions);
    for (const error of status.errors) log(error);
    writeUnreadSummarySnapshot(status.unreadSummary);
    flushTransferNotifications();
    for (const request of transfers.settleExpired()) {
      log(`coordination transfer ${request.id}: ${request.status}`);
    }
    flushTransferNotifications();
    // Log only on change: this fires every 10s and daemon.log is long-lived.
    if (snapshot.sessions.length !== lastLiveCount) {
      lastLiveCount = snapshot.sessions.length;
      log(`presence snapshot: ${lastLiveCount} live`);
    }
  } catch (error) {
    // An interval callback that throws takes the daemon down with it.
    log(`presence snapshot failed: ${error}`);
  }
}

/** Notify live owners at sparse age and condition milestones.
 *
 * This timer is independent of presence publication: a corrupt reminder state
 * or an unwritable spool must not stop liveness snapshots or mail delivery. */
/** Remind live sessions about mail they have not cleared.
 *
 * Two kinds, reported separately because they need different actions: mail
 * pushed to the session and never acknowledged, which a channel push cannot
 * clear on its own, and mail that never reached the session at all. Bounded
 * per project mailbox, because a reminder that fires every sweep is one a reader
 * learns to ignore — the failure the startup instruction already demonstrates.
 */
function tickAckReminders(): void {
  try {
    const nowMs = Date.now();
    const registrations = listLive();
    const stored = readAckReminderState();
    let nextState = stored;
    const seen = new Set<string>();
    for (const registration of registrations) {
      const sessionId = registration.sessionId;
      if (!sessionId) continue;
      const project = registration.cwd;
      const mailboxKey = ackReminderMailboxKey(project, sessionId);
      if (seen.has(mailboxKey)) continue;
      seen.add(mailboxKey);
      const reminder = prepareAckReminder(
        sessionId,
        project,
        readMessages(project, { limit: 0 }),
        readReceipts(project),
        nextState,
        nowMs,
        Date.parse(registration.started),
      );
      if (!reminder) continue;
      const result = appendMessageGuarded(
        {
          ts: new Date(nowMs).toISOString(),
          from: "agent-mail-delivery",
          project: reminder.project,
          message: reminder.message,
          origin: {
            kind: "automation",
            transport: "internal",
            authority: "untrusted",
          },
          idempotencyKey: reminder.idempotencyKey,
          slackEcho: false,
          meta: { toSession: reminder.sessionId, ackReminder: "true" },
        },
        admissionOptions(),
        nowMs,
      );
      if (result.status === "rate_limited") {
        log(
          `delivery reminder rate limited for session ${reminder.sessionId}; retrying next sweep`,
        );
        continue;
      }
      nextState = recordAckReminder(nextState, reminder, nowMs);
    }
    nextState = pruneAckReminderState(nextState, seen);
    if (!ackReminderStatesEqual(stored, nextState)) {
      writeAckReminderState(nextState);
    }
  } catch (error) {
    log(`delivery reminder sweep failed: ${error}`);
  }
}

function tickClaimReminders(): void {
  try {
    const nowMs = Date.now();
    const registrations = listLive();
    const storedState = readClaimReminderState();
    const prepared = prepareClaimReminderSweep(
      listCoordination({
        allProjects: true,
        registrations,
        registrationsReliable: true,
      }),
      registrations,
      storedState,
      nowMs,
    );
    let nextState = prepared.state;
    for (const reminder of prepared.reminders) {
      const currentRegistrations = listLive();
      const currentCoordination = listCoordination({
        allProjects: true,
        registrations: currentRegistrations,
        registrationsReliable: true,
      });
      if (
        !claimReminderStillCurrent(
          reminder,
          currentCoordination,
          currentRegistrations,
        )
      ) {
        log(
          `stale claim reminder suppressed for session ${reminder.sessionId}`,
        );
        continue;
      }
      const result = appendMessageGuarded(
        {
          ts: new Date(nowMs).toISOString(),
          from: "agent-mail-coordination",
          project: reminder.project,
          message: reminder.message,
          origin: {
            kind: "automation",
            transport: "internal",
            authority: "untrusted",
          },
          idempotencyKey: reminder.idempotencyKey,
          slackEcho: false,
          meta: {
            toSession: reminder.sessionId,
            coordinationReminder: "true",
            coordinationClaimIds: reminder.claimIds.join(","),
          },
        },
        admissionOptions(),
        nowMs,
      );
      if (result.status === "rate_limited") {
        log(
          `claim reminder rate limited for session ${reminder.sessionId}; retrying next sweep`,
        );
        continue;
      }
      nextState = recordClaimReminder(nextState, reminder);
    }
    if (!claimReminderStatesEqual(storedState, nextState)) {
      writeClaimReminderState(nextState);
    }
  } catch (error) {
    log(`claim reminder sweep failed: ${error}`);
  }
}

/** Refresh the weft unprocessed-jobs snapshot.
 *
 * Deliberately on its own slow timer rather than the 10s presence tick: the
 * query starts a Go binary and takes seconds, so running it every tick would
 * occupy a core continuously. `refreshing` skips a cycle whose predecessor is
 * still running, which matters most exactly when the machine is loaded enough
 * for the query to outlast the interval.
 *
 * A failure logs and leaves the previous snapshot in place. Readers judge it
 * by its own `generatedAt`, so an unrefreshed file ages out of validity on its
 * own rather than needing to be deleted. */
let refreshing = false;
let missingWeftLogged = false;

/** Absolute path to weft, or undefined when it cannot be found.
 *
 * The daemon runs under launchd with a minimal PATH, so a bare name resolves
 * in an interactive shell and not here. Probing the usual install locations
 * keeps the refresher working without making the daemon depend on a login
 * environment it does not have. */
function resolveWeft(): string | undefined {
  const configured = process.env.AGENT_MAIL_WEFT_BIN;
  if (configured) return existsSync(configured) ? configured : undefined;
  const found = which("weft");
  if (found) return found;
  for (const candidate of [
    join(homedir(), "go", "bin", "weft"),
    "/opt/homebrew/bin/weft",
    "/usr/local/bin/weft",
    join(homedir(), ".local", "bin", "weft"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function tickWeftJobs(): void {
  if (refreshing) return;
  const weft = resolveWeft();
  if (!weft) {
    if (!missingWeftLogged) {
      missingWeftLogged = true;
      log("weft jobs snapshot: weft not found, field stays empty");
    }
    return;
  }
  refreshing = true;
  // A missing executable is reported through the returned promises, never as
  // a synchronous throw — the asymmetry that once took the daemon down under
  // launchd, whose PATH omits weft, is absorbed in runtime.ts.
  // The grouped session-inbox surface, not `list jobs --unprocessed`. The two
  // disagree about what "unprocessed" means — the inbox excludes canceled and
  // killed jobs, which need no action and only ever diluted the count — and
  // this one is versioned, aggregates in SQL rather than shipping every row,
  // and carries the canonical project root the per-project join needs.
  const proc = spawnCapture([
    weft,
    "session",
    "unprocessed",
    "--group-by",
    "project,session",
  ]);
  proc.stdout
    .then(async (out) => {
      const code = await proc.exited;
      if (code !== 0) throw new Error(`weft exited ${code}`);
      const groups = parseUnprocessedGroups(JSON.parse(out));
      if (!groups) {
        // A shape this build does not recognise. Publishing a partial parse
        // would undercount, and an undercount here reads as good news.
        throw new Error("unrecognised weft grouped-inbox document");
      }
      const bySession: Record<string, number> = {};
      let total = 0;
      for (const group of groups) {
        const key = group.unattributedSession
          ? ""
          : (group.submitterSession ?? "");
        bySession[key] = (bySession[key] ?? 0) + group.total;
        total += group.total;
      }
      writeWeftJobsSnapshot({ bySession, total, groups });
      if (total !== lastWeftTotal) {
        lastWeftTotal = total;
        log(
          `weft jobs snapshot: ${total} unprocessed, ${groups.length} groups`,
        );
      }
    })
    .catch((error) => {
      // weft absent, slow, or unparseable output. The stale snapshot stands
      // and expires on its own.
      log(`weft jobs snapshot failed: ${error}`);
    })
    .finally(() => {
      refreshing = false;
    });
}

let lastWeftTotal = -1;

// Publish once synchronously so the first readers aren't left without a
// snapshot for a whole tick.
tickPresence();
const presenceTimer = setInterval(tickPresence, PRESENCE_TICK_MS);
const sessionPushTimer = setInterval(tickSessionPush, 1000);
tickClaimReminders();
const claimReminderTimer = setInterval(
  tickClaimReminders,
  CLAIM_REMINDER_SWEEP_MS,
);
tickAckReminders();
const ackReminderTimer = setInterval(tickAckReminders, CLAIM_REMINDER_SWEEP_MS);
tickWeftJobs();
const weftJobsTimer = setInterval(tickWeftJobs, WEFT_JOBS_REFRESH_MS);

process.on("SIGHUP", () => {
  config = loadConfig();
  resetSessionAliasCache();
  // Session status contains names derived from aliases; republish on reload.
  tickPresence();
  log(
    `config reloaded (slack: ${config.slackWebhook ? config.slackEcho : "unconfigured"})`,
  );
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log(`${sig} received, stopping`);
    clearInterval(presenceTimer);
    clearInterval(sessionPushTimer);
    clearInterval(claimReminderTimer);
    clearInterval(weftJobsTimer);
    ohMyPiPush.close();
    server.stop();
    process.exit(0);
  });
}
