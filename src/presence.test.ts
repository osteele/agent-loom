import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalProject } from "./paths.ts";
import {
  type PresenceSnapshot,
  liveInProject,
  peersInProject,
  readListenerSnapshot,
  readPresenceSnapshot,
  resolveSelf,
  sessionAddress,
  statusLineName,
  unaddressedCause,
  writePresenceSnapshot,
} from "./presence.ts";
import type { Registration } from "./registry.ts";
import type { ClaudeSessionMeta } from "./sessions.ts";

const HOUR = 3600_000;
const NOW = Date.parse("2026-08-10T12:00:00.000Z");

function scratch(): string {
  // realpath first: macOS mkdtemp returns /var/folders/… which canonicalizes to
  // /private/var/folders/…, so a raw comparison would fail for the wrong reason.
  return realpathSync(mkdtempSync(join(tmpdir(), "agent-loom-presence-")));
}

function reg(over: Partial<Registration> & { pid: number }): Registration {
  return {
    cwd: "/proj",
    started: new Date(NOW - HOUR).toISOString(),
    ...over,
  };
}

/** A session whose last sign of life was `idleHours` ago. Both `started` and
 * `lastSeen` have to move: `lastActivityMs` takes the max of the two, so a
 * recent `started` would mask an old `lastSeen`. */
function peer(sessionId: string, idleHours: number, pid: number): Registration {
  const at = new Date(NOW - idleHours * HOUR).toISOString();
  return { cwd: "/proj", pid, sessionId, started: at, lastSeen: at };
}

function metaMap(
  entries: Record<string, ClaudeSessionMeta>,
): Map<string, ClaudeSessionMeta> {
  return new Map(Object.entries(entries));
}

function snapshotFile(dir: string, body: unknown): string {
  const path = join(dir, "presence.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

// --- snapshot freshness ------------------------------------------------------

test("readPresenceSnapshot accepts a snapshot inside the TTL", () => {
  const dir = scratch();
  const path = snapshotFile(dir, {
    version: 1,
    generatedAt: NOW - 5_000,
    generatedBy: 1,
    sessions: [reg({ pid: 1, sessionId: "a" })],
  } satisfies PresenceSnapshot);
  expect(readPresenceSnapshot(NOW, 30_000, path)?.sessions).toHaveLength(1);
});

test("readPresenceSnapshot rejects a snapshot past the TTL", () => {
  const dir = scratch();
  const path = snapshotFile(dir, {
    version: 1,
    generatedAt: NOW - 45_000,
    generatedBy: 1,
    sessions: [reg({ pid: 1 })],
  } satisfies PresenceSnapshot);
  expect(readPresenceSnapshot(NOW, 30_000, path)).toBeUndefined();
});

test("readPresenceSnapshot returns undefined rather than throwing on junk", () => {
  const dir = scratch();
  // A status line that crashes is worse than one that falls back, so every
  // malformed shape must degrade quietly.
  expect(
    readPresenceSnapshot(NOW, 30_000, join(dir, "missing.json")),
  ).toBeUndefined();
  expect(
    readPresenceSnapshot(NOW, 30_000, snapshotFile(dir, "{")),
  ).toBeUndefined();
  expect(
    readPresenceSnapshot(NOW, 30_000, snapshotFile(dir, { version: 2 })),
  ).toBeUndefined();
  expect(
    readPresenceSnapshot(
      NOW,
      30_000,
      snapshotFile(dir, { version: 1, generatedAt: NOW, sessions: "nope" }),
    ),
  ).toBeUndefined();
  expect(
    readPresenceSnapshot(
      NOW,
      30_000,
      snapshotFile(dir, { version: 1, generatedAt: "soon", sessions: [] }),
    ),
  ).toBeUndefined();
});

test("readListenerSnapshot fails closed without scanning or stale sessions", () => {
  const dir = scratch();
  const path = snapshotFile(dir, {
    version: 1,
    generatedAt: NOW - 45_000,
    generatedBy: 1,
    sessions: [reg({ pid: 1, sessionId: "stale" })],
  } satisfies PresenceSnapshot);
  expect(readListenerSnapshot(undefined, NOW, path)).toEqual({
    version: 1,
    source: "presence-snapshot",
    fresh: false,
    generatedAt: null,
    sessions: [],
  });
});

test("readListenerSnapshot filters a fresh snapshot by canonical project", () => {
  const dir = scratch();
  const other = scratch();
  const path = snapshotFile(dir, {
    version: 1,
    generatedAt: NOW - 5_000,
    generatedBy: 1,
    sessions: [
      reg({ cwd: dir, pid: 1, sessionId: "same-project" }),
      reg({ cwd: other, pid: 2, sessionId: "other-project" }),
    ],
  } satisfies PresenceSnapshot);
  const report = readListenerSnapshot(dir, NOW, path);
  expect(report.fresh).toBeTrue();
  expect(report.generatedAt).toBe(NOW - 5_000);
  expect(report.sessions.map((session) => session.sessionId)).toEqual([
    "same-project",
  ]);
});

test("writePresenceSnapshot round-trips and leaves no temp file behind", () => {
  const dir = scratch();
  const path = join(dir, "presence.json");
  const written = writePresenceSnapshot(NOW, path, []);
  const read = readPresenceSnapshot(NOW, 30_000, path);
  expect(read?.generatedAt).toBe(written.generatedAt);
  expect(read?.sessions.length).toBe(written.sessions.length);
  expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("liveInProject falls back to a scan when no snapshot exists", () => {
  // Empty project, no snapshot at the default path in this scratch dir: the
  // fallback must run and simply find nobody, not throw.
  const dir = scratch();
  expect(liveInProject(dir, NOW)).toEqual([]);
});

// --- peer count and name -----------------------------------------------------

test("stale peers are excluded from the peer count", () => {
  const sessions = [
    reg({ pid: 1, sessionId: "self" }),
    peer("fresh", 20, 2),
    peer("stale", 25, 3),
  ];
  const meta = metaMap({ self: { status: "busy", name: "Self Name" } });
  const peers = peersInProject(sessions, "self", meta, NOW);
  expect(peers.map((p) => p.sessionId)).toEqual(["fresh"]);
  expect(statusLineName("/proj", "self", meta, sessions, [], NOW)).toBe(
    "Self Name",
  );
});

test("a session alone in its project still renders its name", () => {
  // The name is identity, not disambiguation: sessions in other projects
  // address this one by it, so it does not depend on who is standing nearby.
  const sessions = [reg({ pid: 1, sessionId: "self" })];
  const meta = metaMap({ self: { status: "busy", name: "Self Name" } });
  expect(peersInProject(sessions, "self", meta, NOW)).toHaveLength(0);
  expect(statusLineName("/proj", "self", meta, sessions, [], NOW)).toBe(
    "Self Name",
  );
});

test("an abandoned peer is not counted as a peer", () => {
  // The regression that matters: one long-dead session sharing the directory
  // must not be reported as company indefinitely.
  const sessions = [
    reg({ pid: 1, sessionId: "self" }),
    peer("abandoned", 40, 2),
  ];
  const meta = metaMap({ self: { status: "busy", name: "Self Name" } });
  expect(peersInProject(sessions, "self", meta, NOW)).toHaveLength(0);
});

test("a busy peer counts however old its last activity looks", () => {
  const sessions = [reg({ pid: 1, sessionId: "self" }), peer("working", 30, 2)];
  const meta = metaMap({
    self: { status: "busy", name: "Self Name" },
    working: { status: "busy" },
  });
  expect(
    peersInProject(sessions, "self", meta, NOW).map((p) => p.sessionId),
  ).toEqual(["working"]);
});

test("self is excluded by session id, not by pid", () => {
  // A re-register leaves two entries for one session under different pids;
  // both are us, so neither is a peer.
  const sessions = [
    reg({ pid: 1, sessionId: "self" }),
    reg({ pid: 2, sessionId: "self" }),
  ];
  const meta = metaMap({ self: { status: "busy", name: "Self Name" } });
  expect(peersInProject(sessions, "self", meta, NOW)).toHaveLength(0);
  expect(statusLineName("/proj", "self", meta, sessions, [], NOW)).toBe(
    "Self Name",
  );
});

test("an unidentifiable self discounts one live entry", () => {
  // After /clear, Claude mints a new session id without respawning MCP servers,
  // so the payload id matches nothing in the registry.
  const one = [reg({ pid: 1, sessionId: "other" })];
  const two = [
    reg({ pid: 1, sessionId: "a" }),
    reg({ pid: 2, sessionId: "b" }),
  ];
  const meta = metaMap({});
  expect(peersInProject(one, "unknown", meta, NOW)).toHaveLength(0);
  expect(peersInProject(two, "unknown", meta, NOW)).toHaveLength(1);
});

test("legacy and canonical spellings of one directory collapse to one project", () => {
  const root = scratch();
  const real = join(root, "real");
  mkdirSync(real);
  const link = join(root, "link");
  symlinkSync(real, link);
  expect(canonicalProject(link)).toBe(canonicalProject(real));

  // Entries written before a directory move carry the old spelling; both must
  // land in the same bucket or one project silently reads as two.
  const sessions = [
    reg({ pid: 1, sessionId: "self", cwd: real }),
    reg({ pid: 2, sessionId: "peer", cwd: link }),
  ];
  const canon = canonicalProject(real);
  const scoped = sessions.filter((r) => canonicalProject(r.cwd) === canon);
  expect(scoped).toHaveLength(2);

  const meta = metaMap({ self: { status: "busy", name: "Self Name" } });
  expect(statusLineName(canon, "self", meta, scoped, [], NOW)).toBe(
    "Self Name",
  );
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

// --- identity after the host rotates its session id --------------------------
//
// Claude Code mints a new session id on `/clear` but does not respawn MCP
// servers, so the channel server stays registered under the id it was spawned
// with. The session's full name IS its address, so naming the rotated id would
// advertise an identity no peer can route to — the failure that sent mail to a
// "Glad Badger" that existed in the name store and in no registry.

test("a rotated session id still resolves to the registered identity", () => {
  const sessions = [reg({ pid: 10, sessionId: "spawned", parentPid: 99 })];
  const meta = metaMap({
    spawned: { status: "busy", name: "Registered Name" },
    rotated: { status: "busy", name: "Rotated Name" },
  });
  // Same host process, different session id: this is us.
  const { self } = resolveSelf(sessions, "rotated", meta, NOW, [50, 99]);
  expect(self?.sessionId).toBe("spawned");
  expect(sessionAddress(sessions, "rotated", meta, NOW, [99])).toBe("spawned");
  expect(statusLineName("/proj", "rotated", meta, sessions, [99], NOW)).toBe(
    "Registered Name",
  );
});

test("a rotated session id is not counted as its own peer", () => {
  const sessions = [
    reg({ pid: 10, sessionId: "spawned", parentPid: 99 }),
    peer("other", 0, 11),
  ];
  const meta = metaMap({ spawned: { status: "busy", name: "Registered" } });
  // Identified, so the peer list is exact rather than the discount guess.
  const peers = peersInProject(sessions, "rotated", meta, NOW, [99]);
  expect(peers.map((p) => p.sessionId)).toEqual(["other"]);
});

test("an unidentifiable session shows no name rather than an unroutable one", () => {
  // Registrations exist but none is attributable to this caller: there is no
  // address to show, and a name peers reject is worse than no name.
  const sessions = [
    reg({ pid: 10, sessionId: "a", parentPid: 1 }),
    reg({ pid: 11, sessionId: "b", parentPid: 2 }),
  ];
  const meta = metaMap({ rotated: { status: "busy", name: "Rotated Name" } });
  expect(sessionAddress(sessions, "rotated", meta, NOW, [77])).toBeUndefined();
  expect(statusLineName("/proj", "rotated", meta, sessions, [77], NOW)).toBe(
    "",
  );
});

test("two registrations under one host pid is not an identification", () => {
  // Guessing between them would be guessing an address, which is the bug.
  const sessions = [
    reg({ pid: 10, sessionId: "a", parentPid: 99 }),
    reg({ pid: 11, sessionId: "b", parentPid: 99 }),
  ];
  const meta = metaMap({});
  expect(
    resolveSelf(sessions, "rotated", meta, NOW, [99]).self,
  ).toBeUndefined();
});

test("a session with no channel server has no address and no name", () => {
  // The regression: a Claude session whose channel server had exited kept
  // showing its generated name, alone in its project. A peer that read the
  // name off the pane and sent to it got "no live recipient", and concluded
  // agent-loom's liveness check was wrong — the status line was the part lying.
  const meta = metaMap({ orphan: { status: "busy", name: "Orphan Name" } });
  expect(sessionAddress([], "orphan", meta, NOW, [99])).toBeUndefined();
  expect(statusLineName("/proj", "orphan", meta, [], [99], NOW)).toBe("");

  // A peer's registration elsewhere in the project changes nothing.
  const others = [reg({ pid: 10, sessionId: "peer", parentPid: 7 })];
  expect(sessionAddress(others, "orphan", meta, NOW, [99])).toBeUndefined();
  expect(unaddressedCause(others, "orphan", meta, NOW, [99])).toBe(
    "unregistered",
  );
});

test("an unaddressed session's cause uses the resolver's staleness filter", () => {
  // The regression: `status-line --debug` counted this session's own
  // registration without the staleness filter `resolveSelf` applies, so a
  // stale match was diagnosed as a rotated session id.
  const meta = metaMap({});
  const stale = { ...peer("spawned", 48, 10), parentPid: 99 };
  expect(sessionAddress([stale], "rotated", meta, NOW, [99])).toBeUndefined();
  expect(unaddressedCause([stale], "rotated", meta, NOW, [99])).toBe("stale");
  // The same holds for a stale exact-id match with no host-pid evidence.
  const byId = peer("mine", 48, 11);
  expect(unaddressedCause([byId], "mine", meta, NOW, [])).toBe("stale");

  const shared = [
    reg({ pid: 10, sessionId: "a", parentPid: 99 }),
    reg({ pid: 11, sessionId: "b", parentPid: 99 }),
  ];
  expect(unaddressedCause(shared, "rotated", meta, NOW, [99])).toBe(
    "ambiguous",
  );
});

test("an exact session-id match wins without consulting ancestry", () => {
  const sessions = [reg({ pid: 10, sessionId: "self", parentPid: 42 })];
  const meta = metaMap({ self: { status: "busy", name: "Self Name" } });
  expect(sessionAddress(sessions, "self", meta, NOW, [])).toBe("self");
});
