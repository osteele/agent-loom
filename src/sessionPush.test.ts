import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OhMyPiPushBridge,
  SESSION_PUSH_PROTOCOL_VERSION,
  type SessionPushEvent,
  resolveSessionPushId,
} from "./sessionPush.ts";
import { appendMessage, readReceipts } from "./spool.ts";

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

  await reader.cancel();
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
    ]),
  ).toBe("omp-native");
});
