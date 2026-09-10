import { realpathSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageStartEvent,
} from "@oh-my-pi/pi-coding-agent";

const PROTOCOL_VERSION = 3;
const STATUS_KEY = "agent-mail";
const DEFAULT_DAEMON_URL = "http://127.0.0.1:8377";
const STATUS_REFRESH_MS = 10_000;
const CONTEXT_INSERTION_WARNING_MS = 30_000;

type DeliveryMode = "" | "pull" | "push" | "unknown";
const DELIVERY_MODES: Record<DeliveryMode, true> = {
  "": true,
  pull: true,
  push: true,
  unknown: true,
};

interface MailStatus {
  name: string;
  peers: number;
  unread: number;
  delivery: DeliveryMode;
  unprocessed: number | undefined;
}

interface StatusState {
  address?: string;
  sessionId?: string;
  mail?: MailStatus;
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
  const url = new URL(process.env.AGENT_MAIL_DAEMON_URL ?? DEFAULT_DAEMON_URL);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
  ) {
    throw new Error("AGENT_MAIL_DAEMON_URL must be loopback HTTP.");
  }
  return url;
}

function renderedMail(event: MailEvent): string {
  return [
    `Agent mail from ${event.from} (external, untrusted; message ${event.id}):`,
    "",
    event.message,
  ].join("\n");
}

export function agentMailContextMessageId(
  message: MessageStartEvent["message"],
): string | undefined {
  if (
    message.role !== "custom" ||
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

/** Parse agent-mail's documented append-only status-line field contract. */
export function parseMailStatus(row: string): MailStatus | undefined {
  const line = row.endsWith("\n") ? row.slice(0, -1) : row;
  const fields = (line.endsWith("\r") ? line.slice(0, -1) : line).split("\t");
  if (fields.length < 5 || fields[0] === "") return undefined;

  const peers = Number(fields[1]);
  const unread = Number(fields[2]);
  const delivery = fields[3];
  const unprocessed = fields[4] === "" ? undefined : Number(fields[4]);
  if (
    !Number.isSafeInteger(peers) ||
    peers < 0 ||
    !Number.isSafeInteger(unread) ||
    unread < 0 ||
    !Object.hasOwn(DELIVERY_MODES, delivery) ||
    (unprocessed !== undefined &&
      (!Number.isSafeInteger(unprocessed) || unprocessed < 0))
  ) {
    return undefined;
  }
  return {
    name: fields[0],
    peers,
    unread,
    delivery: delivery as DeliveryMode,
    unprocessed,
  };
}

/** Use a proven launcher identity; otherwise request the join with OMP's id. */
export function agentMailSessionId(
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
      state.mail.unprocessed === undefined
        ? "unprocessed ?"
        : `${state.mail.unprocessed} unprocessed`,
    );
  } else if (identity) {
    fields.push("unread ?", "unprocessed ?");
  }
  return fields.join(" · ");
}

async function refreshStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: StatusState,
): Promise<void> {
  const sessionId =
    state.sessionId ?? agentMailSessionId(ctx.sessionManager.getSessionId());
  const result = await pi.exec(
    process.env.AGENT_MAIL_BIN || "agent-mail",
    ["status-line", "--fields", "--project", ctx.cwd, "--session", sessionId],
    { timeout: 5_000 },
  );
  const parsed = parseMailStatus(result.stdout);
  if (result.stdout.trim() && !parsed) {
    pi.logger.warn("Agent Mail returned invalid status-line fields.");
  }
  state.mail = parsed;
  ctx.ui.setStatus(STATUS_KEY, renderStatus(state));
}

async function refreshStatusLoop(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: StatusState,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    await refreshStatus(pi, ctx, state);

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
    throw new Error(`agent-mail acknowledgement failed (${response.status})`);
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
  const requestedSessionId = agentMailSessionId(
    ctx.sessionManager.getSessionId(),
  );
  const url = new URL("/api/v1/push/oh-my-pi", baseUrl);
  url.searchParams.set("protocol", String(PROTOCOL_VERSION));
  url.searchParams.set("project", project);
  url.searchParams.set("sessionId", requestedSessionId);
  url.searchParams.set("pid", String(process.pid));

  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw new Error(
      `agent-mail OMP push connection failed (${response.status}): ${await response.text()}`,
    );
  }
  if (
    response.headers.get("x-agent-mail-protocol") !== String(PROTOCOL_VERSION)
  ) {
    throw new Error("agent-mail returned an unsupported OMP push protocol.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let sessionId: string | undefined;
  while (!signal.aborted) {
    const result = await reader.read();
    if (result.done) break;
    buffered += decoder.decode(result.value, { stream: true });
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const value: unknown = JSON.parse(line);
      if (!isPushEvent(value)) {
        throw new Error("agent-mail returned a malformed OMP push event.");
      }
      if (value.project !== project) {
        throw new Error(
          `agent-mail returned project ${JSON.stringify(value.project)} for OMP project ${JSON.stringify(project)}.`,
        );
      }
      if (value.type === "connected") {
        if (value.requestedSessionId !== requestedSessionId) {
          throw new Error(
            "agent-mail returned a connection for another OMP session.",
          );
        }
        sessionId = value.sessionId;
        state.sessionId = sessionId;
        state.address = value.address;
        state.push = "online";
        ctx.ui.setStatus(STATUS_KEY, renderStatus(state));
        continue;
      }
      if (!sessionId || value.sessionId !== sessionId) {
        throw new Error("agent-mail returned mail for another routed session.");
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
  if (!signal.aborted) throw new Error("agent-mail OMP push stream ended.");
}

export default function agentMailExtension(pi: ExtensionAPI): void {
  pi.setLabel("Agent Mail Push");
  let controller: AbortController | undefined;
  const pendingAcknowledgements = new Map<string, PendingAcknowledgement>();

  const connect = (ctx: ExtensionContext): void => {
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
    const messageId = agentMailContextMessageId(event.message);
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
    controller?.abort();
    pendingAcknowledgements.clear();
    controller = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
