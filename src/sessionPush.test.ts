import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMuted, listLiveInProject, setMuted } from "./registry.ts";
import { replyRecipient } from "./replies.ts";
import {
  OhMyPiPushBridge,
  SESSION_PUSH_PROTOCOL_VERSION,
  type SessionPushConnectInput,
  type SessionPushEvent,
  resolveSessionPushId,
} from "./sessionPush.ts";
import { appendMessage, readMessages, readReceipts } from "./spool.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function projectDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-mail-session-push-"));
  temporaryDirectories.push(directory);
  return realpathSync(directory);
}

async function nextEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: { text: string },
): Promise<SessionPushEvent> {
  while (true) {
    const newline = buffered.text.indexOf("\n");
    if (newline >= 0) {
      const line = buffered.text.slice(0, newline);
      buffered.text = buffered.text.slice(newline + 1);
      if (line === "") continue;
      return JSON.parse(line) as SessionPushEvent;
    }
    const result = await reader.read();
    if (result.done)
      throw new Error("Session push stream ended before an event");
    buffered.text += new TextDecoder().decode(result.value);
  }
}

test("Oh My Pi push uses its exact session without another routing id", async () => {
  const project = projectDirectory();
  let now = Date.parse("2026-09-01T13:00:00.000Z");
  const bridge = new OhMyPiPushBridge(
    () => "test process start",
    () => now,
  );
  const response = bridge.connect({
    project,
    protocolVersion: SESSION_PUSH_PROTOCOL_VERSION,
    sessionId: "omp-session",
    pid: process.pid,
    defaultInboundPolicy: "accept",
    heldMessageLimit: 100,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-agent-mail-protocol")).toBe(
    String(SESSION_PUSH_PROTOCOL_VERSION),
  );
  if (!response.body) throw new Error("OMP push response has no body");
  const reader = response.body.getReader();
  const buffered = { text: "" };
  expect(await nextEvent(reader, buffered)).toMatchObject({
    version: SESSION_PUSH_PROTOCOL_VERSION,
    type: "connected",
    project,
    requestedSessionId: "omp-session",
    sessionId: "omp-session",
    address: expect.any(String),
  });

  now += 5_000;
  await bridge.poll();
  const heartbeat = await reader.read();
  expect(new TextDecoder().decode(heartbeat.value)).toBe("\n");

  appendMessage({
    id: "omp-mail-1",
    ts: "2026-09-01T13:00:00.000Z",
    from: "Red Rain",
    project,
    message: "OMP review is ready.",
  });
  await bridge.poll();
  const event = await nextEvent(reader, buffered);
  expect(event).toMatchObject({
    type: "mail",
    id: "omp-mail-1",
    sessionId: "omp-session",
    from: "Red Rain",
    message: "OMP review is ready.",
  });
  expect(
    bridge.acknowledge(
      (event as Extract<SessionPushEvent, { type: "mail" }>).deliveryToken,
    ),
  ).toBe(true);
  expect(readReceipts(project, "omp-mail-1")).toContainEqual(
    expect.objectContaining({
      status: "pushed",
      sessionId: "omp-session",
      detail: "oh-my-pi",
    }),
  );
  // Steering acceptance attests that OMP inserted the message into session
  // context, so the exact-session acknowledgement settles unread state.
  expect(readReceipts(project, "omp-mail-1")).toContainEqual(
    expect.objectContaining({
      status: "read",
      sessionId: "omp-session",
    }),
  );
  expect(
    readMessages(project, { limit: 0 }).find((m) => m.id === "omp-mail-1")
      ?.read,
  ).toBe(true);

  await reader.cancel();
  bridge.close();
});

test("OMP tool shells without session variables carry a working reply address", async () => {
  const project = projectDirectory();
  const destination = projectDirectory();
  const bridge = new OhMyPiPushBridge();
  const response = bridge.connect({
    project,
    protocolVersion: SESSION_PUSH_PROTOCOL_VERSION,
    sessionId: "omp-reply-host",
    pid: process.pid,
    defaultInboundPolicy: "accept",
    heldMessageLimit: 100,
  });
  expect(response.status).toBe(200);
  async function notify(project: string, extra: string[]) {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "cli.ts"),
        "notify",
        "--project",
        project,
        ...extra,
      ],
      {
        env: {
          ...process.env,
          AGENT_MAIL_PORT: "0",
          CLAUDE_CODE_SESSION_ID: "",
          CODEX_THREAD_ID: "",
          AGENT_SESSION_ID: "",
          AGENT_SESSION_PID: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
  }
  try {
    await notify(destination, ["--message", "OMP question"]);
    const question = readMessages(destination, 0)[0];
    await notify(destination, [
      "--message",
      "OMP answer",
      "--reply-to",
      question.id,
    ]);
    expect(readMessages(project, 0).map((m) => m.message)).toContain(
      "OMP answer",
    );
    expect(readMessages(destination, 0).map((m) => m.message)).not.toContain(
      "OMP answer",
    );

    // Two mailboxes under one host are not a unique return address.
    const other = bridge.connect({
      project: destination,
      protocolVersion: SESSION_PUSH_PROTOCOL_VERSION,
      sessionId: "other-host-mailbox",
      pid: process.pid,
      defaultInboundPolicy: "accept",
      heldMessageLimit: 100,
    });
    try {
      await notify(destination, ["--message", "ambiguous sender"]);
      const ambiguous = readMessages(destination, 0).find(
        (m) => m.message === "ambiguous sender",
      );
      expect(ambiguous).toBeDefined();
      expect(
        replyRecipient(ambiguous, [
          ...listLiveInProject(project),
          ...listLiveInProject(destination),
        ]).ok,
      ).toBe(false);
    } finally {
      await other.body?.cancel();
    }
  } finally {
    await response.body?.cancel();
    bridge.close();
  }
});

test("an identity-changing reconnect retires only the same project's host connection", async () => {
  const project = projectDirectory();
  const otherProject = projectDirectory();
  const bridge = new OhMyPiPushBridge();
  const abort = new AbortController();
  const input: SessionPushConnectInput = {
    project,
    protocolVersion: SESSION_PUSH_PROTOCOL_VERSION,
    sessionId: "before-reconnect",
    pid: process.pid,
    defaultInboundPolicy: "accept",
    heldMessageLimit: 100,
  };
  try {
    const previous = bridge.connect(input, abort.signal);
    if (!previous.body) throw new Error("OMP push response has no body");
    const reader = previous.body.getReader();
    await nextEvent(reader, { text: "" });
    const other = bridge.connect({ ...input, project: otherProject });
    if (!other.body) throw new Error("OMP push response has no body");
    const otherReader = other.body.getReader();
    const otherBuffer = { text: "" };
    await nextEvent(otherReader, otherBuffer);
    setMuted(project, process.pid, true);

    const replacement = bridge.connect({
      ...input,
      sessionId: "after-reconnect",
    });
    if (!replacement.body) throw new Error("OMP push response has no body");
    const replacementReader = replacement.body.getReader();
    const replacementBuffer = { text: "" };
    await nextEvent(replacementReader, replacementBuffer);
    expect(isMuted(project, process.pid)).toBe(true);
    setMuted(project, process.pid, false);
    appendMessage({
      id: "retired-mail",
      ts: new Date().toISOString(),
      from: "peer",
      project,
      message: "for the retired identity",
      meta: { toSession: input.sessionId },
    });
    await bridge.poll();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    // The old request may observe its abort only after the replacement connects.
    abort.abort();
    expect(listLiveInProject(project).map((r) => r.sessionId)).toEqual([
      "after-reconnect",
    ]);
    expect(listLiveInProject(otherProject).map((r) => r.sessionId)).toEqual([
      "before-reconnect",
    ]);

    for (const [destination, sessionId] of [
      [project, "after-reconnect"],
      [otherProject, "before-reconnect"],
    ]) {
      appendMessage({
        id: `mail-for-${sessionId}`,
        ts: new Date().toISOString(),
        from: "peer",
        project: destination,
        message: "still reachable",
        meta: { toSession: sessionId },
      });
    }
    await bridge.poll();
    expect(await nextEvent(replacementReader, replacementBuffer)).toMatchObject(
      {
        type: "mail",
        id: "mail-for-after-reconnect",
      },
    );
    expect(await nextEvent(otherReader, otherBuffer)).toMatchObject({
      type: "mail",
      id: "mail-for-before-reconnect",
    });
    await replacementReader.cancel();
    expect(listLiveInProject(project)).toEqual([]);
    expect(listLiveInProject(otherProject).map((r) => r.sessionId)).toEqual([
      "before-reconnect",
    ]);
  } finally {
    bridge.close();
  }
});

test("a stale bridge cannot unregister a replacement owned by another bridge", async () => {
  const project = projectDirectory();
  const oldBridge = new OhMyPiPushBridge();
  const newBridge = new OhMyPiPushBridge();
  const input: SessionPushConnectInput = {
    project,
    protocolVersion: SESSION_PUSH_PROTOCOL_VERSION,
    sessionId: "reconnected-session",
    pid: process.pid,
    defaultInboundPolicy: "accept",
    heldMessageLimit: 100,
  };
  try {
    oldBridge.connect(input);
    const replacement = newBridge.connect(input);
    if (!replacement.body) throw new Error("OMP push response has no body");
    const reader = replacement.body.getReader();
    const buffered = { text: "" };
    await nextEvent(reader, buffered);
    expect(listLiveInProject(project).map((r) => r.sessionId)).toEqual([
      input.sessionId,
    ]);
    oldBridge.close();
    expect(listLiveInProject(project).map((r) => r.sessionId)).toEqual([
      input.sessionId,
    ]);
    appendMessage({
      id: "replacement-mail",
      ts: new Date().toISOString(),
      from: "peer",
      project,
      message: "replacement remains reachable",
      meta: { toSession: input.sessionId },
    });
    await newBridge.poll();
    expect(await nextEvent(reader, buffered)).toMatchObject({
      type: "mail",
      id: "replacement-mail",
    });
    await reader.cancel();
    expect(listLiveInProject(project)).toEqual([]);
  } finally {
    oldBridge.close();
    newBridge.close();
  }
});

test("Oh My Pi push rejects an incompatible protocol before registering", async () => {
  const project = projectDirectory();
  const bridge = new OhMyPiPushBridge(() => "test process start");
  const input: SessionPushConnectInput = {
    project,
    protocolVersion: SESSION_PUSH_PROTOCOL_VERSION - 1,
    sessionId: "old-omp-session",
    pid: process.pid,
    defaultInboundPolicy: "accept",
    heldMessageLimit: 100,
  };

  const rejected = bridge.connect(input);
  expect(rejected.status).toBe(409);
  expect(rejected.headers.get("x-agent-mail-protocol")).toBe(
    String(SESSION_PUSH_PROTOCOL_VERSION),
  );
  await expect(rejected.json()).resolves.toEqual({
    error: `unsupported session push protocol; expected ${SESSION_PUSH_PROTOCOL_VERSION}`,
  });

  const accepted = bridge.connect({
    ...input,
    protocolVersion: SESSION_PUSH_PROTOCOL_VERSION,
  });
  expect(accepted.status).toBe(200);
  await accepted.body?.cancel();
  bridge.close();
});

test("Oh My Pi push adopts the one MCP identity registered under its host", () => {
  const project = "/project";
  const registration = (sessionId: string, parentPid: number, pid: number) => ({
    cwd: project,
    pid,
    parentPid,
    sessionId,
    started: "2026-09-01T13:00:00.000Z",
  });
  expect(
    resolveSessionPushId(project, 42, "omp-native", [
      registration("mcp-shared", 42, 101),
      registration("previous-push-session", 42, 42),
    ]),
  ).toBe("mcp-shared");
  expect(
    resolveSessionPushId(project, 42, "omp-native", [
      registration("mcp-shared", 42, 101),
      registration("mcp-shared", 42, 102),
    ]),
  ).toBe("mcp-shared");
  expect(
    resolveSessionPushId(project, 42, "omp-native", [
      registration("one", 42, 101),
      registration("two", 42, 102),
    ]),
  ).toBe("omp-native");
  expect(
    resolveSessionPushId(project, 42, "omp-native", [
      registration("other-host", 41, 101),
      registration("previous-push-session", 42, 42),
    ]),
  ).toBe("omp-native");
});
