import { expect, spyOn, test } from "bun:test";
import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import agentMailExtension, {
  agentMailContextMessageId,
  agentMailSessionId,
  parseMailStatus,
  renderStatus,
  wakeRecipient,
} from "./index.ts";

function statusPayload(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    project: "/project",
    sessionId: "route-a",
    generatedAt: Date.now(),
    name: "Quiet Lantern",
    peers: 2,
    unread: 1,
    delivery: "push",
    unprocessed: 3,
    work: null,
    ...overrides,
  };
}

test("OMP accepts unknown work and Weft counts without fabricating zero", () => {
  const payload = statusPayload({ unprocessed: null });
  const mail = parseMailStatus(payload, "/project", "route-a");
  expect<unknown>(mail).toEqual(payload);
  expect(renderStatus({ mail, push: "online" })).toContain("unprocessed ?");
});

test("OMP rejects inexact identity, stale snapshots, and invalid counts", () => {
  const now = Date.now();
  for (const overrides of [
    { version: 2 },
    { project: "/other" },
    { sessionId: "route-b" },
    { generatedAt: now - 30_001 },
    { generatedAt: now + 1 },
    { generatedAt: "123" },
    { generatedAt: Number.NaN },
    { name: " " },
    { peers: "2" },
    { peers: -1 },
    { unread: 0.5 },
    { unread: Number.MAX_SAFE_INTEGER + 1 },
    { delivery: "direct" },
    { unprocessed: -1 },
    { unprocessed: undefined },
  ]) {
    expect(
      parseMailStatus(
        statusPayload({ generatedAt: now, ...overrides }),
        "/project",
        "route-a",
        now,
      ),
    ).toBeUndefined();
  }
  for (const value of [null, [], "Quiet Lantern\t2\t1\tpush\t3", {}]) {
    expect(parseMailStatus(value, "/project", "route-a", now)).toBeUndefined();
  }
  expect(
    parseMailStatus(
      statusPayload({ generatedAt: now - 30_000 }),
      "/project",
      "route-a",
      now,
    ),
  ).toBeDefined();
});

test("OMP validates work data even though its bundled renderer does not display it", () => {
  const item = {
    id: "work-id",
    resourceType: "plan",
    resourceKey: "PLAN-001",
    state: "working",
    updatedAt: "2026-09-12T12:00:00.000Z",
    label: "Plan",
    sourcePath: "/project/plan",
    activity: "Implementing",
  };
  for (const state of ["working", "waiting"]) {
    const payload = statusPayload({
      work: { version: 1, items: [{ ...item, state }] },
    });
    expect<unknown>(parseMailStatus(payload, "/project", "route-a")).toEqual(
      payload,
    );
  }
  for (const work of [
    undefined,
    [],
    { version: 2, items: [] },
    { version: 1, items: {} },
    ...[
      null,
      {},
      { ...item, id: "" },
      { ...item, resourceType: 1 },
      { ...item, resourceKey: " " },
      { ...item, state: "complete" },
      { ...item, updatedAt: 123 },
      { ...item, updatedAt: "not-a-date" },
      { ...item, label: null },
      { ...item, sourcePath: [] },
      { ...item, activity: false },
    ].map((invalid) => ({ version: 1, items: [invalid] })),
  ]) {
    expect(
      parseMailStatus(statusPayload({ work }), "/project", "route-a"),
    ).toBeUndefined();
  }
});

test("OMP shares a launcher identity only when minted for this process", () => {
  expect(agentMailSessionId("omp-native", "launcher-shared", "42", 42)).toBe(
    "launcher-shared",
  );
  expect(agentMailSessionId("omp-native", "parent-agent", "41", 42)).toBe(
    "omp-native",
  );
  expect(agentMailSessionId("omp-native", "  ", "42", 42)).toBe("omp-native");
});

test("OMP mail interrupts an interruptible wait", () => {
  const deliveries: Parameters<ExtensionAPI["sendMessage"]>[] = [];
  const pi = {
    sendMessage(...args: Parameters<ExtensionAPI["sendMessage"]>): void {
      deliveries.push(args);
    },
  };

  wakeRecipient(pi, {
    version: 3,
    type: "mail",
    deliveryToken: "delivery-token",
    id: "message-id",
    project: "/project",
    sessionId: "omp-session",
    from: "Quiet Lantern",
    ts: "2026-09-02T12:00:00.000Z",
    message: "Review is ready.",
  });

  expect(deliveries).toEqual([
    [
      {
        customType: "agent-mail",
        content:
          "Agent mail from Quiet Lantern (external, untrusted; message message-id):\n\nReview is ready.",
        display: true,
        attribution: "agent",
        details: {
          messageId: "message-id",
          from: "Quiet Lantern",
          ts: "2026-09-02T12:00:00.000Z",
        },
      },
      { deliverAs: "steer", triggerTurn: true },
    ],
  ]);
});

test("OMP recognizes its typed agent-mail context event", () => {
  const message = {
    role: "custom" as const,
    customType: "agent-mail",
    content: "Review is ready.",
    display: true,
    attribution: "agent" as const,
    timestamp: Date.parse("2026-09-02T12:00:00.000Z"),
    details: { messageId: "message-id" },
  };
  expect(agentMailContextMessageId(message)).toBe("message-id");
  expect(
    agentMailContextMessageId({
      ...message,
      customType: "another-extension",
    }),
  ).toBeUndefined();
  expect(
    agentMailContextMessageId({
      ...message,
      details: {},
    }),
  ).toBeUndefined();
});

test("OMP uses its native status slot for agent-mail and Weft state", () => {
  expect(
    renderStatus({
      mail: parseMailStatus(statusPayload(), "/project", "route-a"),
      push: "online",
    }),
  ).toBe("mail Quiet Lantern · 2 peers · 1 unread · 3 unprocessed");
});

function statusHarness() {
  const callbacks = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => void
  >();
  const statuses: (string | undefined)[] = [];
  const queries: {
    sessionId: string;
    project: string;
    signal: AbortSignal;
    finish: (name: string) => void;
    respond: (response: Response) => void;
    reject: (error: Error) => void;
  }[] = [];
  const executions: string[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const openStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const connections: {
    connect: (sessionId: string, address: string) => void;
    close: () => void;
  }[] = [];
  let nextTimer = 0;
  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "omp-native" },
    ui: {
      setStatus: (_key: string, value: string | undefined) =>
        statuses.push(value),
    },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer: (id: number) => timers.delete(id),
  } as unknown as ExtensionContext;
  const pi = {
    setLabel: () => {},
    on: (
      event: string,
      callback: (event: unknown, ctx: ExtensionContext) => void,
    ) => callbacks.set(event, callback),
    logger: { warn: () => {}, error: () => {} },
    exec: (command: string) => {
      executions.push(command);
      throw new Error("The bundled client must not execute subprocesses.");
    },
  } as unknown as ExtensionAPI;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/session-status") {
      const { promise, resolve, reject } = Promise.withResolvers<Response>();
      const project = url.searchParams.get("project");
      const sessionId = url.searchParams.get("sessionId");
      if (!project || !sessionId)
        throw new Error("Missing status query identity");
      queries.push({
        project,
        sessionId,
        signal: init?.signal as AbortSignal,
        finish: (name) =>
          resolve(Response.json(statusPayload({ project, sessionId, name }))),
        respond: resolve,
        reject,
      });
      return promise;
    }
    if (
      url.pathname !== "/api/v1/push/oh-my-pi" ||
      url.searchParams.get("protocol") !== "3"
    ) {
      throw new Error(`Unexpected network route: ${url}`);
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        openStreams.add(controller);
        connections.push({
          connect: (sessionId, address) =>
            controller.enqueue(
              new TextEncoder().encode(
                `${JSON.stringify({
                  version: 3,
                  type: "connected",
                  project: url.searchParams.get("project"),
                  requestedSessionId: url.searchParams.get("sessionId"),
                  sessionId,
                  address,
                })}\n`,
              ),
            ),
          close: () => {
            openStreams.delete(controller);
            controller.close();
          },
        });
      },
    });
    return new Response(body, { headers: { "x-agent-mail-protocol": "3" } });
  }) as typeof fetch);
  agentMailExtension(pi);
  const childCallbacks = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => void
  >();
  agentMailExtension({
    ...pi,
    on: (
      event: string,
      callback: (event: unknown, ctx: ExtensionContext) => void,
    ) => childCallbacks.set(event, callback),
  } as unknown as ExtensionAPI);
  const emit = (event: string, hasUI = true) => {
    const callback = (hasUI ? callbacks : childCallbacks).get(event);
    if (!callback) throw new Error(`Missing extension callback: ${event}`);
    callback({}, hasUI ? ctx : { ...ctx, hasUI: false });
  };
  return {
    queries,
    connections,
    statuses,
    executions,
    emit,
    current: () => statuses.at(-1),
    tick: (delay: number) => {
      const pending = [...timers].filter(([, timer]) => timer.delay === delay);
      if (pending.length === 0) throw new Error(`No pending ${delay}ms timer`);
      for (const [id, timer] of pending) {
        timers.delete(id);
        timer.callback();
      }
    },
    stop: () => {
      emit("session_shutdown");
      for (const controller of openStreams) controller.close();
      fetchMock.mockRestore();
    },
  };
}

function settleStatus(): Promise<void> {
  // Advance one event-loop turn so stream and HTTP microtasks finish; no timed delay.
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

test("OMP waits for its routing handshake and retains matching status on reconnect", async () => {
  const host = statusHarness();
  try {
    host.emit("session_start");
    await settleStatus();
    host.tick(10_000);
    await settleStatus();
    expect(host.queries).toEqual([]);
    expect(host.executions).toEqual([]);

    host.connections[0].connect("route-a", "project-quiet-lantern");
    await settleStatus();
    expect(host.queries.map((query) => query.sessionId)).toEqual(["route-a"]);
    expect(host.queries[0].project).toBe(realpathSync(process.cwd()));
    host.queries[0].finish("Quiet Lantern");
    await settleStatus();
    expect(host.current()).toContain("Quiet Lantern");

    host.connections[0].close();
    await settleStatus();
    host.tick(1_000);
    await settleStatus();
    host.connections[1].connect("route-a", "project-quiet-lantern");
    await settleStatus();
    expect(host.current()).toContain("Quiet Lantern");
    expect(host.executions).toEqual([]);
    expect(host.current()).toContain("1 unread");
    expect(host.queries.map((query) => query.sessionId)).toEqual([
      "route-a",
      "route-a",
    ]);
  } finally {
    host.stop();
  }
});

test("OMP invalidates a changed route and rejects status from an earlier visit to it", async () => {
  const host = statusHarness();
  try {
    host.emit("session_start");
    await settleStatus();
    host.connections[0].connect("route-a", "project-quiet-lantern");
    await settleStatus();
    host.connections[0].close();
    await settleStatus();
    host.tick(1_000);
    await settleStatus();
    host.connections[1].connect("route-b", "project-bright-heron");
    await settleStatus();
    host.queries[1].finish("Bright Heron");
    await settleStatus();
    expect(host.current()).toContain("Bright Heron");

    host.connections[1].close();
    await settleStatus();
    host.tick(2_000);
    await settleStatus();
    host.connections[2].connect("route-a", "project-quiet-lantern");
    await settleStatus();
    expect(host.current()).toContain("project-quiet-lantern");
    expect(host.current()).not.toContain("Bright Heron");
    expect(host.current()).toContain("unread ?");
    host.queries[2].finish("Quiet Lantern");
    await settleStatus();
    const current = host.current();
    host.queries[0].finish("Obsolete Name");
    await settleStatus();
    expect(host.current()).toBe(current);
    expect(host.current()).toContain("Quiet Lantern");
    expect(host.queries.map((query) => query.sessionId)).toEqual([
      "route-a",
      "route-b",
      "route-a",
    ]);
  } finally {
    host.stop();
  }
});

test("OMP ignores old lifecycle status and stream callbacks after switching or shutdown", async () => {
  const host = statusHarness();
  try {
    host.emit("session_start");
    await settleStatus();
    host.connections[0].connect("route-a", "project-quiet-lantern");
    await settleStatus();
    host.emit("session_switch");
    await settleStatus();
    expect(host.queries[0].signal.aborted).toBe(true);
    host.connections[1].connect("route-b", "project-bright-heron");
    await settleStatus();
    host.queries[1].finish("Bright Heron");
    await settleStatus();
    const count = host.statuses.length;
    host.queries[0].finish("Obsolete Name");
    host.connections[0].connect("route-a", "obsolete-address");
    await settleStatus();
    expect(host.statuses.length).toBe(count);
    expect(host.current()).toContain("Bright Heron");

    host.tick(10_000);
    await settleStatus();
    host.emit("session_shutdown");
    expect(host.queries[2].signal.aborted).toBe(true);
    host.queries[2].finish("Late Name");
    host.connections[1].connect("route-b", "late-address");
    await settleStatus();
    expect(host.current()).toBeUndefined();
  } finally {
    host.stop();
  }
});

test("OMP headless child lifecycles leave the interactive parent's transport and status alone", async () => {
  const host = statusHarness();
  try {
    for (const event of [
      "session_start",
      "session_switch",
      "session_branch",
      "session_tree",
      "session_shutdown",
    ]) {
      host.emit(event, false);
    }
    await settleStatus();
    expect(host.connections).toEqual([]);
    expect(host.queries).toEqual([]);
    expect(host.statuses).toEqual([]);

    host.emit("session_start");
    await settleStatus();
    host.connections[0].connect("route-a", "project-quiet-lantern");
    await settleStatus();
    host.queries[0].finish("Quiet Lantern");
    await settleStatus();
    const current = host.current();

    host.emit("session_start", false);
    host.emit("session_shutdown", false);
    await settleStatus();
    expect(host.connections).toHaveLength(1);
    expect(host.queries).toHaveLength(1);
    expect(host.current()).toBe(current);

    host.tick(10_000);
    await settleStatus();
    host.queries[1].finish("Renamed Lantern");
    await settleStatus();
    expect(host.current()).toContain("Renamed Lantern");
    expect(host.queries[1].sessionId).toBe("route-a");
  } finally {
    host.stop();
  }
});

test("OMP retains matching status visibly stale after HTTP, network, or payload failure", async () => {
  const host = statusHarness();
  try {
    host.emit("session_start");
    await settleStatus();
    host.connections[0].connect("route-a", "project-quiet-lantern");
    await settleStatus();
    host.queries[0].finish("Quiet Lantern");
    await settleStatus();
    const project = host.queries[0].project;
    for (const failure of [
      new Response("unavailable", { status: 503 }),
      new Response("unknown session", { status: 404 }),
      new Response("{invalid json"),
      Response.json(statusPayload({ project, peers: "2" })),
      Response.json(statusPayload({ project, sessionId: "route-b" })),
      Response.json(statusPayload({ project: "/wrong-project" })),
      Response.json(
        statusPayload({ project, generatedAt: Date.now() - 30_001 }),
      ),
      Response.json(
        statusPayload({ project, work: { version: 1, items: [{}] } }),
      ),
      new Error("network unavailable"),
    ]) {
      host.tick(10_000);
      await settleStatus();
      const query = host.queries.at(-1);
      if (!query) throw new Error("No status request");
      if (failure instanceof Error) query.reject(failure);
      else query.respond(failure);
      await settleStatus();
      expect(host.current()).toContain("Quiet Lantern");
      expect(host.current()).toContain("1 unread");
      expect(host.current()).toContain("3 unprocessed");
      expect(host.current()).toContain("status stale (");
    }
    host.tick(10_000);
    await settleStatus();
    const recovery = host.queries.at(-1);
    if (!recovery) throw new Error("No recovery status request");
    recovery.finish("Renamed Lantern");
    await settleStatus();
    expect(host.current()).toContain("Renamed Lantern");
    expect(host.current()).not.toContain("stale");
    expect(host.executions).toEqual([]);
  } finally {
    host.stop();
  }
});
