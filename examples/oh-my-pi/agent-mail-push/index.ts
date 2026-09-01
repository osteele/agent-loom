import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const PROTOCOL_VERSION = 1;
const STATUS_KEY = "agent-mail";
const DEFAULT_DAEMON_URL = "http://127.0.0.1:8377";
const STATUS_REFRESH_MS = 10_000;

interface MailStatus {
  name: string;
  unread: number;
  unprocessed: number | undefined;
}

interface StatusState {
  address?: string;
  mail?: MailStatus;
  jj?: string;
  jjFailed: boolean;
  push: "connecting" | "online" | "offline" | "failed";
}

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

/** Parse agent-mail's documented append-only status-line field contract. */
export function parseMailStatus(row: string): MailStatus | undefined {
  const line = row.endsWith("\n") ? row.slice(0, -1) : row;
  const fields = (line.endsWith("\r") ? line.slice(0, -1) : line).split("\t");
  if (fields.length < 5 || fields[0] === "") return undefined;
  const unread = Number(fields[2]);
  const unprocessed = fields[4] === "" ? undefined : Number(fields[4]);
  if (
    !Number.isSafeInteger(unread) ||
    unread < 0 ||
    (unprocessed !== undefined &&
      (!Number.isSafeInteger(unprocessed) || unprocessed < 0))
  ) {
    return undefined;
  }
  return { name: fields[0], unread, unprocessed };
}

function findJjRoot(cwd: string): string | undefined {
  let candidate = cwd;
  while (true) {
    if (existsSync(join(candidate, ".jj"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

function renderStatus(state: StatusState): string {
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
    fields.push(`${state.mail.unread} unread`);
    fields.push(
      state.mail.unprocessed === undefined
        ? "unprocessed ?"
        : `${state.mail.unprocessed} unprocessed`,
    );
  } else if (identity) {
    fields.push("unread ?", "unprocessed ?");
  }
  if (state.jj) fields.push(`jj ${state.jj}`);
  else if (state.jjFailed) fields.push("jj ?");
  return fields.join(" · ");
}

async function refreshStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: StatusState,
): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  const mailCommand = process.env.AGENT_MAIL_BIN || "agent-mail";
  const mailPromise = pi
    .exec(
      mailCommand,
      ["status-line", "--fields", "--project", ctx.cwd, "--session", sessionId],
      { timeout: 5_000 },
    )
    .then((result) => parseMailStatus(result.stdout));

  const jjRoot = findJjRoot(ctx.cwd);
  const jjPromise = jjRoot
    ? pi
        .exec(
          "jj",
          [
            "log",
            "--ignore-working-copy",
            "--no-graph",
            "-r",
            "heads(::@ & bookmarks())",
            "-T",
            'bookmarks ++ "\\n"',
          ],
          { cwd: jjRoot, timeout: 5_000 },
        )
        .then((result) =>
          result.code === 0
            ? result.stdout
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .join(",") || "@"
            : undefined,
        )
    : Promise.resolve(null);

  const [mailResult, jjResult] = await Promise.allSettled([
    mailPromise,
    jjPromise,
  ]);
  state.mail = mailResult.status === "fulfilled" ? mailResult.value : undefined;
  if (jjResult.status === "fulfilled" && jjResult.value === null) {
    state.jj = undefined;
    state.jjFailed = false;
  } else if (jjResult.status === "fulfilled" && jjResult.value !== undefined) {
    state.jj = jjResult.value;
    state.jjFailed = false;
  } else {
    state.jj = undefined;
    state.jjFailed = true;
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
  state: StatusState,
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
        state.address = value.address;
        state.push = "online";
        ctx.ui.setStatus(STATUS_KEY, renderStatus(state));
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
    const state: StatusState = {
      jjFailed: false,
      push: "connecting",
    };
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
          await consumeStream(pi, ctx, state, signal);
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
