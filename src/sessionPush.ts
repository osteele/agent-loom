/** Versioned push bridge for agent harness extensions.
 *
 * A harness process keeps one NDJSON stream open per session. The daemon tails
 * the ordinary project spool, and the extension acknowledges only after its
 * host has durably accepted the notification. The spool and receipt log remain
 * authoritative; connection state is disposable.
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  decideHeldSettlements,
  decideNewMessageDelivery,
  pendingHeldIds,
} from "./delivery.ts";
import { canonicalProject, spoolPath } from "./paths.ts";
import {
  type InboundPolicy,
  type Registration,
  type SessionCapabilities,
  inboundPolicy,
  isMuted,
  listLiveInProject,
  register,
  scanProcesses,
  unregister,
} from "./registry.ts";
import { readFileSlice } from "./runtime.ts";
import { sessionNames } from "./sessions.ts";
import {
  type DeliveryReceipt,
  type Message,
  type ReceiptTail,
  appendReceipt,
  emptyReceiptTail,
  markMessagesRead,
  readMessages,
  readReceiptTail,
} from "./spool.ts";

export const SESSION_PUSH_PROTOCOL_VERSION = 3;

export interface SessionPushConnectInput {
  project: string;
  protocolVersion: number;
  sessionId: string;
  pid: number;
  defaultInboundPolicy: InboundPolicy;
  heldMessageLimit: number;
}

export type SessionPushEvent =
  | {
      version: typeof SESSION_PUSH_PROTOCOL_VERSION;
      type: "connected";
      project: string;
      requestedSessionId: string;
      sessionId: string;
      address: string;
    }
  | {
      version: typeof SESSION_PUSH_PROTOCOL_VERSION;
      type: "mail";
      deliveryToken: string;
      id: string;
      project: string;
      sessionId: string;
      from: string;
      ts: string;
      message: string;
      origin?: Message["origin"];
      meta?: Record<string, string>;
    };

interface SessionPushConnection {
  id: string;
  key: string;
  project: string;
  sessionId: string;
  pid: number;
  heldMessageLimit: number;
  offset: number;
  controller: ReadableStreamDefaultController<Uint8Array>;
  receiptTail: ReceiptTail;
  pendingByMessage: Map<string, string>;
  lastWriteMs: number;
  closed: boolean;
}

interface PendingDelivery {
  connectionId: string;
  project: string;
  sessionId: string;
  messageId: string;
  message: Message & { id: string };
}

const PUSH_CAPABILITIES: SessionCapabilities = {
  tools: false,
  inboxPoll: false,
  channelPush: true,
  claims: false,
  workLeases: false,
  receipts: true,
  nativePeerMessaging: false,
  channelPushStatus: "authorized",
};

interface SessionPushClient {
  client: string;
  receiptDetail: string;
  processLabel: string;
  acknowledgementAttestsContext: boolean;
}

const OH_MY_PI_CLIENT: SessionPushClient = {
  client: "oh-my-pi",
  receiptDetail: "oh-my-pi",
  processLabel: "OMP session",
  acknowledgementAttestsContext: true,
};

const encoder = new TextEncoder();
const KEEP_ALIVE_INTERVAL_MS = 5_000;

function connectionKey(project: string, sessionId: string): string {
  return `${project}\u0000${sessionId}`;
}

/** The outcome of joining a push transport to its session's identity. */
export type SessionPushJoin =
  | { kind: "joined"; sessionId: string }
  | { kind: "none" }
  | { kind: "ambiguous"; sessionIds: string[] };

/** The routing id this transport attaches to: the one its host's agent-loom MCP
 * component registered.
 *
 * OMP owns a native conversation id but does not export it to MCP subprocesses.
 * The MCP registration does record OMP's exact host pid, which the extension
 * supplies and the daemon verifies. Exactly one distinct registration id under
 * that pid is an exact join.
 *
 * The id the extension asked for is deliberately not a parameter. A transport
 * attaches to an identity; it never creates one, and a function that cannot see
 * the requested id cannot register under it. Zero or several matches is not an
 * identification — 0014 — and there is nothing to fall back to: registering
 * under the proposal would give a session a second identity, leaving its status
 * line watching a mailbox the agent never reads.
 *
 * `none` is the ordinary startup case rather than an error. The extension runs
 * inside the host and connects before the MCP subprocess has finished
 * registering, so the caller refuses and the extension's reconnect finds the
 * registration a moment later. */
export function resolveSessionPushId(
  project: string,
  hostPid: number,
  registrations: Registration[] = listLiveInProject(project),
): SessionPushJoin {
  const ids = new Set(
    registrations
      .filter(
        (registration) =>
          registration.pid !== hostPid &&
          registration.parentPid === hostPid &&
          registration.sessionId,
      )
      .map((registration) => registration.sessionId as string),
  );
  if (ids.size === 1)
    return { kind: "joined", sessionId: [...ids][0] as string };
  if (ids.size === 0) return { kind: "none" };
  return { kind: "ambiguous", sessionIds: [...ids].sort() };
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.includes("\u0000");
}

export type SessionPushProcessVerifier = (pid: number) => string | undefined;

function verifiedProcessStart(pid: number): string | undefined {
  const scan = scanProcesses([pid]);
  if (!scan.reliable) return undefined;
  return scan.processes.get(pid)?.start;
}

/** Long-lived exact-session push connections owned by one daemon process. */
export class SessionPushBridge {
  readonly #connections = new Map<string, SessionPushConnection>();
  readonly #pending = new Map<string, PendingDelivery>();
  readonly #resumeOffsets = new Map<string, number>();
  readonly #resumeMessages = new Map<string, (Message & { id: string })[]>();
  readonly #processVerifier: SessionPushProcessVerifier;
  readonly #client: SessionPushClient;
  readonly #now: () => number;
  #polling: Promise<void> | undefined;
  #pollAgain = false;

  constructor(
    client: SessionPushClient,
    processVerifier: SessionPushProcessVerifier = verifiedProcessStart,
    now: () => number = Date.now,
  ) {
    this.#client = client;
    this.#processVerifier = processVerifier;
    this.#now = now;
  }

  connect(input: SessionPushConnectInput, signal?: AbortSignal): Response {
    if (input.protocolVersion !== SESSION_PUSH_PROTOCOL_VERSION) {
      return Response.json(
        {
          error: `unsupported session push protocol; expected ${SESSION_PUSH_PROTOCOL_VERSION}`,
        },
        {
          status: 409,
          headers: {
            "X-Agent-Loom-Protocol": String(SESSION_PUSH_PROTOCOL_VERSION),
            // Consumers built before the rename read the old header name.
            "X-Agent-Mail-Protocol": String(SESSION_PUSH_PROTOCOL_VERSION),
          },
        },
      );
    }
    if (!validIdentifier(input.sessionId)) {
      return Response.json({ error: "invalid session id" }, { status: 400 });
    }
    if (!Number.isInteger(input.pid) || input.pid <= 0) {
      return Response.json(
        { error: `invalid ${this.#client.processLabel} pid` },
        { status: 400 },
      );
    }
    const project = canonicalProject(input.project);
    if (!existsSync(project) || !statSync(project).isDirectory()) {
      return Response.json(
        { error: "project is not a directory" },
        { status: 400 },
      );
    }
    const processStart = this.#processVerifier(input.pid);
    if (!processStart) {
      return Response.json(
        { error: `${this.#client.processLabel} process could not be verified` },
        { status: 503 },
      );
    }

    const join = resolveSessionPushId(project, input.pid);
    if (join.kind !== "joined") {
      // Refused rather than registered. Retryable on both branches: an
      // ambiguous host resolves when the extra registration is pruned, and the
      // extension reconnects on its own backoff either way.
      return Response.json(
        {
          error:
            join.kind === "none"
              ? `no agent-loom session is registered under ${this.#client.processLabel} pid ${input.pid} yet`
              : `${this.#client.processLabel} pid ${input.pid} has several registered sessions (${join.sessionIds.join(", ")}); cannot tell which one this transport belongs to`,
        },
        { status: 503 },
      );
    }
    const sessionId = join.sessionId;

    const key = connectionKey(project, sessionId);
    const id = randomUUID();
    register(
      project,
      input.pid,
      sessionId,
      undefined,
      this.#client.client,
      PUSH_CAPABILITIES,
      input.defaultInboundPolicy,
      processStart,
      id,
      // This transport lives inside the host, not in an MCP subprocess.
      input.pid,
    );
    // Register first so process-level controls survive the handoff. Retiring
    // an older connection cannot remove the replacement's instance.
    for (const connection of this.#connections.values()) {
      if (
        connection.key === key ||
        (connection.project === project && connection.pid === input.pid)
      ) {
        this.#disconnect(connection);
      }
    }
    const path = spoolPath(project);
    const currentSize = existsSync(path) ? statSync(path).size : 0;
    const offset = this.#resumeOffsets.get(key) ?? currentSize;
    this.#resumeOffsets.delete(key);
    const state: { connection?: SessionPushConnection } = {};
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        streamController = controller;
      },
      cancel: () => this.#disconnect(state.connection),
    });
    if (!streamController) {
      return Response.json(
        { error: "could not open push stream" },
        { status: 500 },
      );
    }
    const connection: SessionPushConnection = {
      id,
      key,
      project,
      sessionId,
      pid: input.pid,
      heldMessageLimit: input.heldMessageLimit,
      offset,
      controller: streamController,
      receiptTail: emptyReceiptTail(),
      pendingByMessage: new Map(),
      lastWriteMs: this.#now(),
      closed: false,
    };
    state.connection = connection;

    this.#connections.set(key, connection);
    this.#enqueue(connection, {
      version: SESSION_PUSH_PROTOCOL_VERSION,
      type: "connected",
      project,
      requestedSessionId: input.sessionId,
      sessionId,
      address: sessionNames(sessionId, undefined, project).fullName,
    });
    const resumeMessages = this.#resumeMessages.get(key) ?? [];
    this.#resumeMessages.delete(key);
    for (const message of resumeMessages) {
      this.#push(connection, message);
    }
    signal?.addEventListener("abort", () => this.#disconnect(connection), {
      once: true,
    });
    queueMicrotask(() => void this.poll());

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Agent-Loom-Protocol": String(SESSION_PUSH_PROTOCOL_VERSION),
        // Consumers built before the rename read the old header name.
        "X-Agent-Mail-Protocol": String(SESSION_PUSH_PROTOCOL_VERSION),
      },
    });
  }

  /** Record delivery only after the client attests exact-session context insertion. */
  acknowledge(token: string): boolean {
    const pending = this.#pending.get(token);
    if (!pending) return false;
    const connection = [...this.#connections.values()].find(
      (candidate) => candidate.id === pending.connectionId,
    );
    if (!connection || connection.closed) return false;
    this.#pending.delete(token);
    connection.pendingByMessage.delete(pending.messageId);
    this.#recordReceipt(
      connection,
      pending.messageId,
      "pushed",
      this.#client.receiptDetail,
    );
    if (this.#client.acknowledgementAttestsContext) {
      // This client acknowledges only after inserting the message into session
      // context. Transport-only clients must opt out and leave read state to
      // check_inbox or an explicit mark_read.
      markMessagesRead(
        connection.project,
        [pending.messageId],
        connection.sessionId,
      );
    }
    return true;
  }

  /** Advance each spool cursor. Concurrent triggers coalesce into one pass. */
  poll(): Promise<void> {
    if (this.#polling) {
      this.#pollAgain = true;
      return this.#polling;
    }
    this.#polling = this.#drainPolls().finally(() => {
      this.#polling = undefined;
    });
    return this.#polling;
  }

  close(): void {
    for (const connection of [...this.#connections.values()]) {
      this.#disconnect(connection);
    }
  }

  async #pollAll(): Promise<void> {
    for (const connection of [...this.#connections.values()]) {
      if (connection.closed) continue;
      await this.#pollConnection(connection);
      this.#keepAlive(connection);
    }
  }

  async #drainPolls(): Promise<void> {
    do {
      this.#pollAgain = false;
      await this.#pollAll();
    } while (this.#pollAgain);
  }

  #receipts(connection: SessionPushConnection): DeliveryReceipt[] {
    return readReceiptTail(connection.project, connection.receiptTail).receipts;
  }

  #recordReceipt(
    connection: SessionPushConnection,
    messageId: string,
    status: DeliveryReceipt["status"],
    detail?: string,
  ): void {
    appendReceipt(connection.project, {
      messageId,
      ts: new Date().toISOString(),
      status,
      sessionId: connection.sessionId,
      ...(detail ? { detail } : {}),
    });
    this.#receipts(connection);
  }

  #push(
    connection: SessionPushConnection,
    msg: Message & { id: string },
  ): void {
    if (connection.pendingByMessage.has(msg.id)) return;
    const deliveryToken = randomUUID();
    connection.pendingByMessage.set(msg.id, deliveryToken);
    this.#pending.set(deliveryToken, {
      connectionId: connection.id,
      project: connection.project,
      sessionId: connection.sessionId,
      messageId: msg.id,
      message: msg,
    });
    this.#enqueue(connection, {
      version: SESSION_PUSH_PROTOCOL_VERSION,
      type: "mail",
      deliveryToken,
      id: msg.id,
      project: connection.project,
      sessionId: connection.sessionId,
      from: msg.from,
      ts: msg.ts,
      message: msg.message,
      ...(msg.origin ? { origin: msg.origin } : {}),
      ...(msg.meta ? { meta: msg.meta } : {}),
    });
  }

  async #pollConnection(connection: SessionPushConnection): Promise<void> {
    const receipts = this.#receipts(connection);
    const policy = inboundPolicy(connection.project, connection.pid);
    const muted = isMuted(connection.project, connection.pid);

    if (pendingHeldIds(receipts, connection.sessionId).length > 0) {
      const byId = new Map(
        readMessages(connection.project, { limit: 0 }).map((message) => [
          message.id,
          message,
        ]),
      );
      for (const action of decideHeldSettlements(
        connection.sessionId,
        policy,
        muted,
        true,
        byId,
        receipts,
        this.#now(),
      )) {
        if (action.type === "push") {
          const message = byId.get(action.messageId);
          if (message) this.#push(connection, message);
        } else if (action.type === "expired") {
          this.#recordReceipt(connection, action.messageId, "expired");
        } else {
          this.#recordReceipt(
            connection,
            action.messageId,
            "refused",
            action.detail,
          );
        }
      }
    }

    const path = spoolPath(connection.project);
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < connection.offset) connection.offset = 0;
    if (size === connection.offset) return;
    const chunk = await readFileSlice(path, connection.offset, size);
    for (const line of chunk.split("\n").filter(Boolean)) {
      let message: Message & { id?: string };
      try {
        message = JSON.parse(line) as Message & { id?: string };
      } catch {
        continue;
      }
      if (!message.id || message.delivery === "audit") continue;
      const { action, overflowHeldId } = decideNewMessageDelivery(
        message as Message & { id: string },
        connection.sessionId,
        policy,
        muted,
        true,
        connection.heldMessageLimit,
        receipts,
        this.#now(),
      );
      if (overflowHeldId) {
        this.#recordReceipt(
          connection,
          overflowHeldId,
          "refused",
          "held queue full",
        );
      }
      if (action.type === "push") {
        this.#push(connection, message as Message & { id: string });
      } else if (action.type === "hold") {
        this.#recordReceipt(connection, message.id, "held");
      } else if (action.type === "expired") {
        this.#recordReceipt(connection, message.id, "expired");
      } else if (action.type === "refuse") {
        this.#recordReceipt(connection, message.id, "refused", action.detail);
      }
    }
    connection.offset = size;
  }

  #enqueue(connection: SessionPushConnection, event: SessionPushEvent): void {
    if (connection.closed) return;
    try {
      connection.controller.enqueue(
        encoder.encode(`${JSON.stringify(event)}\n`),
      );
      connection.lastWriteMs = this.#now();
    } catch {
      this.#disconnect(connection);
    }
  }

  /** Keep Bun's HTTP idle timeout from terminating a quiet push stream.
   *
   * Blank NDJSON lines carry no protocol event, and clients are required to
   * ignore them. This keeps connection liveness separate from delivery state:
   * a heartbeat creates neither a message nor a receipt. */
  #keepAlive(connection: SessionPushConnection): void {
    if (
      connection.closed ||
      this.#now() - connection.lastWriteMs < KEEP_ALIVE_INTERVAL_MS
    ) {
      return;
    }
    try {
      connection.controller.enqueue(encoder.encode("\n"));
      connection.lastWriteMs = this.#now();
    } catch {
      this.#disconnect(connection);
    }
  }

  #disconnect(connection: SessionPushConnection | undefined): void {
    if (!connection || connection.closed) return;
    connection.closed = true;
    if (this.#connections.get(connection.key)?.id === connection.id) {
      this.#connections.delete(connection.key);
      this.#resumeOffsets.set(connection.key, connection.offset);
      unregister(connection.project, connection.pid, connection.id);
    }
    const resumeMessages: (Message & { id: string })[] = [];
    for (const token of connection.pendingByMessage.values()) {
      const pending = this.#pending.get(token);
      if (pending) resumeMessages.push(pending.message);
      this.#pending.delete(token);
    }
    if (resumeMessages.length > 0) {
      this.#resumeMessages.set(connection.key, resumeMessages);
    }
    connection.pendingByMessage.clear();
    try {
      connection.controller.close();
    } catch {
      // The peer may already have canceled the stream.
    }
  }
}

/** OMP extensions run in the verified process that owns their exact session. */
export class OhMyPiPushBridge extends SessionPushBridge {
  constructor(
    processVerifier: SessionPushProcessVerifier = verifiedProcessStart,
    now: () => number = Date.now,
  ) {
    super(OH_MY_PI_CLIENT, processVerifier, now);
  }
}
