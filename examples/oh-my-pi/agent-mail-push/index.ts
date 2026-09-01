import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

const PROTOCOL_VERSION = 1;
const STATUS_KEY = "agent-mail";
const DEFAULT_DAEMON_URL = "http://127.0.0.1:8377";

interface ConnectedEvent {
  version: typeof PROTOCOL_VERSION;
  type: "connected";
  project: string;
  sessionId: string;
  address: string;
}

interface MailEvent {
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

function daemonUrl(): URL {
  const url = new URL(
    process.env.AGENT_MAIL_DAEMON_URL ?? DEFAULT_DAEMON_URL,
  );
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

function isPushEvent(value: unknown): value is PushEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<PushEvent>;
  return (
    event.version === PROTOCOL_VERSION &&
    (event.type === "connected" || event.type === "mail") &&
    typeof event.project === "string" &&
    typeof event.sessionId === "string"
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

async function waitForRetry(
  ctx: ExtensionContext,
  signal: AbortSignal,
  milliseconds: number,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = ctx.setTimeout(resolve, milliseconds);
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
  signal: AbortSignal,
): Promise<void> {
  const baseUrl = daemonUrl();
  const sessionId = ctx.sessionManager.getSessionId();
  const url = new URL("/api/v1/push/oh-my-pi", baseUrl);
  url.searchParams.set("project", ctx.cwd);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("pid", String(process.pid));

  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw new Error(
      `agent-mail OMP push connection failed (${response.status}): ${await response.text()}`,
    );
  }
  if (response.headers.get("x-agent-mail-protocol") !== "1") {
    throw new Error("agent-mail returned an unsupported OMP push protocol.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
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
      if (value.sessionId !== sessionId || value.project !== ctx.cwd) {
        throw new Error(
          "agent-mail returned an event whose exact OMP session join failed.",
        );
      }
      if (value.type === "connected") {
        ctx.ui.setStatus(STATUS_KEY, `mail ${value.address}`);
        continue;
      }
      pi.sendMessage(
        {
          customType: "agent-mail",
          content: renderedMail(value),
          display: true,
          attribution: "agent",
          details: { messageId: value.id, from: value.from, ts: value.ts },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      await acknowledge(baseUrl, value.deliveryToken);
    }
  }
  if (!signal.aborted) throw new Error("agent-mail OMP push stream ended.");
}

export default function agentMailExtension(pi: ExtensionAPI): void {
  pi.setLabel("Agent Mail Push");
  let controller: AbortController | undefined;

  const connect = (ctx: ExtensionContext): void => {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    void (async () => {
      let retryDelay = 1_000;
      while (!signal.aborted) {
        try {
          ctx.ui.setStatus(STATUS_KEY, "mail connecting");
          await consumeStream(pi, ctx, signal);
          retryDelay = 1_000;
        } catch (error) {
          if (signal.aborted) return;
          ctx.ui.setStatus(STATUS_KEY, "mail offline · retrying");
          pi.logger.warn(`Agent Mail Push: ${String(error)}`);
        }
        await waitForRetry(ctx, signal, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    })().catch((error) => {
      if (signal.aborted) return;
      ctx.ui.setStatus(STATUS_KEY, "mail failed");
      pi.logger.error(`Agent Mail Push stopped: ${String(error)}`);
    });
  };

  pi.on("session_start", (_event, ctx) => connect(ctx));
  pi.on("session_switch", (_event, ctx) => connect(ctx));
  pi.on("session_branch", (_event, ctx) => connect(ctx));
  pi.on("session_tree", (_event, ctx) => connect(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    controller?.abort();
    controller = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
