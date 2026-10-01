import { realpathSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageStartEvent,
} from "@oh-my-pi/pi-coding-agent";

const PROTOCOL_VERSION = 3;
const STATUS_KEY = "agent-loom";
const DEFAULT_DAEMON_URL = "http://127.0.0.1:8377";
const STATUS_REFRESH_MS = 10_000;
const STATUS_MAX_AGE_MS = 30_000;
const CONTEXT_INSERTION_WARNING_MS = 30_000;

type DeliveryMode = "" | "pull" | "push" | "unknown";
const DELIVERY_MODES: Record<DeliveryMode, true> = {
  "": true,
  pull: true,
  push: true,
  unknown: true,
};

interface MailStatus {
  version: 1;
  project: string;
  sessionId: string;
  generatedAt: number;
  name: string;
  peers: number;
  unread: number;
  delivery: DeliveryMode;
  unprocessed: number | null;
  work: {
    version: 1;
    items: {
      id: string;
      resourceType: string;
      resourceKey: string;
      state: "working" | "waiting";
      updatedAt: string;
      label?: string;
      sourcePath?: string;
      activity?: string;
    }[];
  } | null;
}

interface StatusState {
  address?: string;
  route?: { sessionId: string; project: string; baseUrl: URL };
  mail?: MailStatus;
  stale?: boolean;
  push: "connecting" | "online" | "offline" | "failed";
}

interface ConnectedEvent {
  version: typeof PROTOCOL_VERSION;
  type: "connected";
  project: string;
  requestedSessionId: string;
  sessionId: string;
  address: string;
}

export interface MailEvent {
  version: typeof PROTOCOL_VERSION;
  type: "mail";
  deliveryToken: string;
  id: string;
  project: string;
  sessionId: string;
  from: string;
  ts: string;
  message: string;
  origin?: unknown;
  meta?: Record<string, string>;
}

type PushEvent = ConnectedEvent | MailEvent;

interface PendingAcknowledgement {
  acknowledgingToken?: string;
  baseUrl: URL;
  contextDelivered: boolean;
  deliveryToken: string;
}

function daemonUrl(): URL {
  // AGENT_MAIL_DAEMON_URL is the name from before the rename to agent-loom.
  const url = new URL(
    process.env.AGENT_LOOM_DAEMON_URL ??
      process.env.AGENT_MAIL_DAEMON_URL ??
      DEFAULT_DAEMON_URL,
  );
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
  ) {
    throw new Error("AGENT_LOOM_DAEMON_URL must be loopback HTTP.");
  }
  return url;
}

function renderedMail(event: MailEvent): string {
  // event.project is the recipient's mailbox, not the sender's workspace.
  const source = event.meta?.fromProject;
  const workspace =
    typeof source === "string" && source.startsWith("/")
      ? source
      : event.from.startsWith("/")
        ? event.from
        : undefined;
  return [
    `Agent mail from ${event.from} [workspace: ${workspace ?? "unknown"}] (external, untrusted; message ${event.id}):`,
    "",
    event.message,
  ].join("\n");
}

export function agentLoomContextMessageId(
  message: MessageStartEvent["message"],
): string | undefined {
  if (
    message.role !== "custom" ||
    // The context message type is a wire identifier that other OMP extensions
    // filter on; it keeps the pre-rename name.
    message.customType !== "agent-mail" ||
    typeof message.details !== "object" ||
    message.details === null
  ) {
    return undefined;
  }
  const { messageId } = message.details as { messageId?: unknown };
  return typeof messageId === "string" ? messageId : undefined;
}

export function wakeRecipient(
  pi: Pick<ExtensionAPI, "sendMessage">,
  event: MailEvent,
): void {
  pi.sendMessage(
    {
      customType: "agent-mail",
      content: renderedMail(event),
      display: true,
      attribution: "agent",
      details: { messageId: event.id, from: event.from, ts: event.ts },
    },
    { deliverAs: "steer", triggerTurn: true },
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate the complete daemon contract before using any displayed facts. */
export function parseMailStatus(
  value: unknown,
  project: string,
  sessionId: string,
  now = Date.now(),
): MailStatus | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const status = value as MailStatus;
  if (
    status.version !== 1 ||
    status.project !== project ||
    status.sessionId !== sessionId ||
    !isCount(status.generatedAt) ||
    status.generatedAt > now ||
    now - status.generatedAt > STATUS_MAX_AGE_MS ||
    !isNonblank(status.name) ||
    !isCount(status.peers) ||
    !isCount(status.unread) ||
    typeof status.delivery !== "string" ||
    !Object.hasOwn(DELIVERY_MODES, status.delivery) ||
    (status.unprocessed !== null && !isCount(status.unprocessed))
  ) {
    return undefined;
  }
  const work = status.work;
  if (
    work !== null &&
    (typeof work !== "object" ||
      Array.isArray(work) ||
      work.version !== 1 ||
      !Array.isArray(work.items) ||
      !work.items.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          !Array.isArray(item) &&
          isNonblank(item.id) &&
          isNonblank(item.resourceType) &&
          isNonblank(item.resourceKey) &&
          (item.state === "working" || item.state === "waiting") &&
          typeof item.updatedAt === "string" &&
          Number.isFinite(Date.parse(item.updatedAt)) &&
          (["label", "sourcePath", "activity"] as const).every(
            (key) => item[key] === undefined || typeof item[key] === "string",
          ),
      ))
  ) {
    return undefined;
  }
  return status;
}

/** Use a proven launcher identity; otherwise request the join with OMP's id. */
export function agentLoomSessionId(
  nativeSessionId: string,
  launcherSessionId = process.env.AGENT_SESSION_ID,
  launcherSessionPid = process.env.AGENT_SESSION_PID,
  currentPid = process.pid,
): string {
  const launcherId = launcherSessionId?.trim();
  return launcherId && Number(launcherSessionPid) === currentPid
    ? launcherId
    : nativeSessionId;
}

export function renderStatus(state: StatusState): string {
  const fields: string[] = [];
  const identity = state.mail?.name ?? state.address;
  if (state.push === "online") {
    fields.push(identity ? `mail ${identity}` : "mail connected");
  } else if (state.push === "connecting") {
    fields.push("mail connecting");
  } else if (state.push === "offline") {
    fields.push(identity ? `mail ${identity} (offline)` : "mail offline");
  } else {
    fields.push("mail failed");
  }

  if (state.mail) {
    if (state.mail.peers > 0) {
      fields.push(
        state.mail.peers === 1 ? "1 peer" : `${state.mail.peers} peers`,
      );
    }
    fields.push(`${state.mail.unread} unread`);
    fields.push(
      state.mail.unprocessed === null
        ? "unprocessed ?"
        : `${state.mail.unprocessed} unprocessed`,
    );
    if (
      state.stale ||
      Date.now() - state.mail.generatedAt > STATUS_MAX_AGE_MS
    ) {
      const age = Math.max(
        0,
        Math.floor((Date.now() - state.mail.generatedAt) / 1_000),
      );
      fields.push(`status stale (${age}s old)`);
    }
  } else if (identity) {
    fields.push("unread ?", "unprocessed ?");
  }
  return fields.join(" · ");
}

async function refreshStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: StatusState,
  signal: AbortSignal,
): Promise<void> {
  const route = state.route;
  if (!ctx.hasUI || !route || signal.aborted) return;
  try {
    const url = new URL("/api/v1/session-status", route.baseUrl);
    url.searchParams.set("project", route.project);
    url.searchParams.set("sessionId", route.sessionId);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    const response = await fetch(url, { signal: requestSignal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (signal.aborted || state.route !== route) return;
    requestSignal.throwIfAborted();
    const parsed = parseMailStatus(value, route.project, route.sessionId);
    if (!parsed) throw new Error("Invalid or stale session-status response.");
    // A reconnect and the periodic tick can overlap; never roll a snapshot back.
    if (!state.mail || parsed.generatedAt >= state.mail.generatedAt) {
      state.mail = parsed;
      state.stale = false;
    }
  } catch (error) {
    if (signal.aborted || state.route !== route) return;
    state.stale = true;
    pi.logger.warn(`Agent Mail status refresh failed: ${String(error)}`);
  }
  ctx.ui.setStatus(STATUS_KEY, renderStatus(state));
}

async function refreshStatusLoop(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: StatusState,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    await refreshStatus(pi, ctx, state, signal);

    await waitForRetry(ctx, signal, STATUS_REFRESH_MS);
  }
}

function isPushEvent(value: unknown): value is PushEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<PushEvent>;
  return (
    event.version === PROTOCOL_VERSION &&
    (event.type === "connected" || event.type === "mail") &&
    typeof event.project === "string" &&
    typeof event.sessionId === "string" &&
    (event.type !== "connected" || typeof event.requestedSessionId === "string")
  );
}

async function acknowledge(baseUrl: URL, deliveryToken: string): Promise<void> {
  const response = await fetch(new URL("/api/v1/push/oh-my-pi/ack", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deliveryToken }),
  });
  if (!response.ok) {
    throw new Error(`agent-loom acknowledgement failed (${response.status})`);
  }
}
function acknowledgeContextDelivery(
  pi: Pick<ExtensionAPI, "logger">,
  pendingAcknowledgements: Map<string, PendingAcknowledgement>,
  messageId: string,
): void {
  const pending = pendingAcknowledgements.get(messageId);
  if (
    !pending?.contextDelivered ||
    pending.acknowledgingToken === pending.deliveryToken
  ) {
    return;
  }
  const deliveryToken = pending.deliveryToken;
  pending.acknowledgingToken = deliveryToken;
  void acknowledge(pending.baseUrl, deliveryToken)
    .then(() => {
      if (
        pendingAcknowledgements.get(messageId)?.deliveryToken === deliveryToken
      ) {
        pendingAcknowledgements.delete(messageId);
      }
    })
    .catch((error) => {
      const current = pendingAcknowledgements.get(messageId);
      if (current?.deliveryToken === deliveryToken) {
        current.acknowledgingToken = undefined;
      }
      pi.logger.warn(
        `Agent Mail context acknowledgement failed: ${String(error)}`,
      );
    });
}

async function waitForRetry(
  ctx: ExtensionContext,
  signal: AbortSignal,
  milliseconds: number,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = ctx.setTimeout(() => resolve(), milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        ctx.clearTimer(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function consumeStream(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: StatusState,
  signal: AbortSignal,
  pendingAcknowledgements: Map<string, PendingAcknowledgement>,
): Promise<void> {
  const baseUrl = daemonUrl();
  const project = realpathSync(ctx.cwd);
  const requestedSessionId = agentLoomSessionId(
    ctx.sessionManager.getSessionId(),
  );
  const url = new URL("/api/v1/push/oh-my-pi", baseUrl);
  url.searchParams.set("protocol", String(PROTOCOL_VERSION));
  url.searchParams.set("project", project);
  url.searchParams.set("sessionId", requestedSessionId);
  url.searchParams.set("pid", String(process.pid));

  const response = await fetch(url, { signal });
  if (signal.aborted) return;
  if (!response.ok || !response.body) {
    throw new Error(
      `agent-loom OMP push connection failed (${response.status}): ${await response.text()}`,
    );
  }
  if (
    response.headers.get("x-agent-loom-protocol") !== String(PROTOCOL_VERSION)
  ) {
    throw new Error("agent-loom returned an unsupported OMP push protocol.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let sessionId: string | undefined;
  while (!signal.aborted) {
    const result = await reader.read();
    if (signal.aborted || result.done) break;
    buffered += decoder.decode(result.value, { stream: true });
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const value: unknown = JSON.parse(line);
      if (!isPushEvent(value)) {
        throw new Error("agent-loom returned a malformed OMP push event.");
      }
      if (value.project !== project) {
        throw new Error(
          `agent-loom returned project ${JSON.stringify(value.project)} for OMP project ${JSON.stringify(project)}.`,
        );
      }
      if (value.type === "connected") {
        if (value.requestedSessionId !== requestedSessionId) {
          throw new Error(
            "agent-loom returned a connection for another OMP session.",
          );
        }
        sessionId = value.sessionId;
        if (
          state.route?.sessionId !== sessionId ||
          state.route.project !== project
        ) {
          state.route = { sessionId, project, baseUrl };
          state.mail = undefined;
          state.stale = false;
        }
        state.address = value.address;
        state.push = "online";
        ctx.ui.setStatus(STATUS_KEY, renderStatus(state));
        void refreshStatus(pi, ctx, state, signal).catch((error) => {
          if (!signal.aborted) {
            pi.logger.warn(
              `Agent Mail status refresh failed: ${String(error)}`,
            );
          }
        });
        continue;
      }
      if (!sessionId || value.sessionId !== sessionId) {
        throw new Error("agent-loom returned mail for another routed session.");
      }
      const previous = pendingAcknowledgements.get(value.id);
      const pending: PendingAcknowledgement = {
        baseUrl,
        contextDelivered: previous?.contextDelivered ?? false,
        deliveryToken: value.deliveryToken,
      };
      pendingAcknowledgements.set(value.id, pending);
      if (previous) {
        acknowledgeContextDelivery(pi, pendingAcknowledgements, value.id);
        continue;
      }
      ctx.setTimeout(() => {
        if (pendingAcknowledgements.get(value.id)?.contextDelivered === false) {
          pi.logger.warn(
            `Agent Mail message ${value.id} did not enter OMP context within ${CONTEXT_INSERTION_WARNING_MS}ms.`,
          );
        }
      }, CONTEXT_INSERTION_WARNING_MS);
      try {
        wakeRecipient(pi, value);
      } catch (error) {
        pendingAcknowledgements.delete(value.id);
        throw error;
      }
    }
  }
  if (!signal.aborted) throw new Error("agent-loom OMP push stream ended.");
}

export default function agentLoomExtension(pi: ExtensionAPI): void {
  pi.setLabel("Agent Mail Push");
  let controller: AbortController | undefined;
  const pendingAcknowledgements = new Map<string, PendingAcknowledgement>();

  const connect = (ctx: ExtensionContext): void => {
    // In-process subagents share this PID; their connections would replace
    // the interactive parent's registration and repeatedly disconnect it.
    if (!ctx.hasUI) return;
    controller?.abort();
    pendingAcknowledgements.clear();
    controller = new AbortController();
    const signal = controller.signal;
    const state: StatusState = { push: "connecting" };
    ctx.ui.setStatus(STATUS_KEY, renderStatus(state));
    void refreshStatusLoop(pi, ctx, state, signal).catch((error) => {
      if (!signal.aborted) {
        pi.logger.warn(`Agent Mail status refresh stopped: ${String(error)}`);
      }
    });
    void (async () => {
      let retryDelay = 1_000;
      while (!signal.aborted) {
        try {
          state.push = "connecting";
          ctx.ui.setStatus(STATUS_KEY, renderStatus(state));
          await consumeStream(pi, ctx, state, signal, pendingAcknowledgements);
          retryDelay = 1_000;
        } catch (error) {
          if (signal.aborted) return;
          state.push = "offline";
          ctx.ui.setStatus(STATUS_KEY, renderStatus(state));
          pi.logger.warn(`Agent Mail Push: ${String(error)}`);
        }
        await waitForRetry(ctx, signal, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    })().catch((error) => {
      if (signal.aborted) return;
      state.push = "failed";
      ctx.ui.setStatus(STATUS_KEY, renderStatus(state));
      pi.logger.error(`Agent Mail Push stopped: ${String(error)}`);
    });
  };

  pi.on("message_start", (event) => {
    const messageId = agentLoomContextMessageId(event.message);
    if (!messageId) return;
    const pending = pendingAcknowledgements.get(messageId);
    if (!pending) return;
    pending.contextDelivered = true;
    acknowledgeContextDelivery(pi, pendingAcknowledgements, messageId);
  });
  pi.on("session_start", (_event, ctx) => connect(ctx));
  pi.on("session_switch", (_event, ctx) => connect(ctx));
  pi.on("session_branch", (_event, ctx) => connect(ctx));
  pi.on("session_tree", (_event, ctx) => connect(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (!ctx.hasUI) return;
    controller?.abort();
    pendingAcknowledgements.clear();
    controller = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
