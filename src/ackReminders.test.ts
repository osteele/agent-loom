import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACK_GRACE_MS,
  ACK_REMINDER_INTERVAL_MS,
  ackReminderMailboxKey,
  outstandingMail,
  prepareAckReminder,
  pruneAckReminderState,
  readAckReminderState,
  recordAckReminder,
  writeAckReminderState,
} from "./ackReminders.ts";
import { projectSlug } from "./paths.ts";
import { processInfo } from "./registry.ts";
import type { DeliveryReceipt, StoredMessage } from "./spool.ts";

const NOW = Date.parse("2026-09-08T06:00:00.000Z");
const HOUR = 3_600_000;
const SESSION = "me";

function message(over: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: "m1",
    ts: "2026-09-08T04:00:00.000Z",
    from: "peer",
    project: "/p",
    message: "body",
    read: false,
    ...over,
  } as StoredMessage;
}

function pushed(
  messageId: string,
  ts: string,
  sessionId = SESSION,
): DeliveryReceipt {
  return { messageId, project: "/p", ts, status: "pushed", sessionId };
}

const EMPTY = { version: 2 as const, sessions: {} };

test("a pushed message that stayed unread is delivered-but-unacknowledged", () => {
  const out = outstandingMail(
    [message()],
    [pushed("m1", "2026-09-08T04:00:01.000Z")],
    SESSION,
    NOW,
  );
  expect(out).toMatchObject({ delivered: 1, undelivered: 0 });
});

test("an unread message never pushed to this session counts as never delivered", () => {
  // The user's case: mail that has not reached the session at all is still
  // outstanding, and needs pulling rather than acknowledging.
  const out = outstandingMail([message()], [], SESSION, NOW);
  expect(out).toMatchObject({ delivered: 0, undelivered: 1 });
});

test("a push to another session does not make it delivered to this one", () => {
  const out = outstandingMail(
    [message()],
    [pushed("m1", "2026-09-08T04:00:01.000Z", "someone-else")],
    SESSION,
    NOW,
  );
  expect(out).toMatchObject({ delivered: 0, undelivered: 1 });
});

test("mail inside the grace period is not yet outstanding", () => {
  // Both halves must respect it: an undelivered message is dated from itself,
  // and dating it from now would leave it permanently too young to report.
  const fresh = "2026-09-08T05:59:00.000Z";
  expect(
    outstandingMail([message({ ts: fresh })], [], SESSION, NOW),
  ).toMatchObject({ delivered: 0, undelivered: 0 });
  expect(
    outstandingMail([message()], [pushed("m1", fresh)], SESSION, NOW),
  ).toMatchObject({ delivered: 0, undelivered: 0 });
});

test("read mail and agent-mail's own reminders are never counted", () => {
  // A reminder is itself pushed and unacknowledged. Counting it would make the
  // condition self-sustaining: the reminder becomes the backlog it reports.
  expect(
    outstandingMail(
      [
        message({ id: "read-one", read: true }),
        message({ id: "reminder", meta: { ackReminder: "true" } }),
        message({ id: "coord", meta: { coordinationReminder: "true" } }),
      ],
      [],
      SESSION,
      NOW,
    ),
  ).toMatchObject({ delivered: 0, undelivered: 0 });
});

test("mail spooled before the session began is not its backlog", () => {
  // A project inbox outlives its sessions. On its first real run this reported
  // 48 undelivered, oldest 22 days, to a session hours old — a shared archive
  // rendered as one session's outstanding work.
  const began = Date.parse("2026-09-08T05:00:00.000Z");
  const old = message({ id: "ancient", ts: "2026-08-17T00:00:00.000Z" });
  const mine = message({ id: "mine", ts: "2026-09-08T05:10:00.000Z" });
  expect(
    outstandingMail([old, mine], [], SESSION, NOW, ACK_GRACE_MS, began),
  ).toMatchObject({ delivered: 0, undelivered: 1 });
});

test("a push proves arrival, so the delivered half ignores the session bound", () => {
  // Being pushed to is itself evidence the session existed to receive it; the
  // bound exists only for mail that has no delivery to date from. The push
  // here predates `began`, which is ordinary: a session re-registers on resume
  // and on the poll's self-heal, so `started` moves forward under pushes that
  // already happened. Bounding the delivered half would erase them.
  const began = Date.parse("2026-09-08T05:00:00.000Z");
  const old = message({ id: "ancient", ts: "2026-08-17T00:00:00.000Z" });
  expect(
    outstandingMail(
      [old],
      [pushed("ancient", "2026-09-08T04:00:00.000Z")],
      SESSION,
      NOW,
      ACK_GRACE_MS,
      began,
    ),
  ).toMatchObject({ delivered: 1, undelivered: 0 });
});

test("mail addressed to another session is not this session's backlog", () => {
  // Reported by a peer: the reminder said 79 outstanding when its reachable
  // set was 7, because it counted the project spool while check_inbox filters.
  // The remedy it named could not have reached the difference.
  const forSomeoneElse = message({
    id: "theirs",
    meta: { toSession: "another-session" },
  });
  expect(outstandingMail([forSomeoneElse], [], SESSION, NOW)).toMatchObject({
    delivered: 0,
    undelivered: 0,
  });
});

test("mail this session sent is not mail it is waiting on", () => {
  const mine = message({ id: "sent", meta: { sessionId: SESSION } });
  expect(outstandingMail([mine], [], SESSION, NOW)).toMatchObject({
    delivered: 0,
    undelivered: 0,
  });
});

test("the reminder names both halves and their different remedies", () => {
  const reminder = prepareAckReminder(
    SESSION,
    "/p",
    [message({ id: "a" }), message({ id: "b" })],
    [pushed("a", "2026-09-08T04:00:01.000Z")],
    EMPTY,
    NOW,
  );
  expect(reminder?.message).toContain("2 messages outstanding");
  expect(reminder?.message).toContain("1 delivered but unacknowledged");
  expect(reminder?.message).toContain("1 never delivered");
  expect(reminder?.message).toContain("mark_read");
  expect(reminder?.message).toContain("check_inbox");
});

test("a session is not reminded again inside the interval", () => {
  // A signal that fires every sweep is one a reader learns to ignore, which is
  // the failure the startup instruction already demonstrates.
  const first = prepareAckReminder(SESSION, "/p", [message()], [], EMPTY, NOW);
  expect(first).toBeDefined();
  if (!first) throw new Error("expected a reminder");
  const after = recordAckReminder(EMPTY, first, NOW);
  expect(
    prepareAckReminder(SESSION, "/p", [message()], [], after, NOW + HOUR),
  ).toBeUndefined();
  expect(
    prepareAckReminder(
      SESSION,
      "/p",
      [message()],
      [],
      after,
      NOW + ACK_REMINDER_INTERVAL_MS + 1,
    ),
  ).toBeDefined();
});

test("reminder cooldowns persist per canonical project mailbox", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-ack-mailbox-"));
  const project = join(root, "one");
  const otherProject = join(root, "two");
  const alias = join(root, "alias");
  mkdirSync(project);
  mkdirSync(otherProject);
  symlinkSync(project, alias);
  try {
    const first = prepareAckReminder(
      SESSION,
      project,
      [message({ project })],
      [],
      EMPTY,
      NOW,
    );
    if (!first) throw new Error("first mailbox must be due");
    const path = join(root, "state.json");
    writeAckReminderState(recordAckReminder(EMPTY, first, NOW), path);
    const state = readAckReminderState(path);
    const other = prepareAckReminder(
      SESSION,
      otherProject,
      [message({ project: otherProject })],
      [],
      state,
      NOW,
    );
    expect(other).toBeDefined();
    if (!other) throw new Error("second mailbox must be independently due");
    expect(other.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(
      prepareAckReminder(
        SESSION,
        alias,
        [message({ project: alias })],
        [],
        state,
        NOW,
      ),
    ).toBeUndefined();
    const pruned = pruneAckReminderState(
      recordAckReminder(state, other, NOW),
      new Set([ackReminderMailboxKey(otherProject, SESSION)]),
    );
    expect(
      prepareAckReminder(
        SESSION,
        project,
        [message({ project })],
        [],
        pruned,
        NOW,
      ),
    ).toBeDefined();
    expect(
      prepareAckReminder(
        SESSION,
        otherProject,
        [message({ project: otherProject })],
        [],
        pruned,
        NOW,
      ),
    ).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy session-only cooldowns cannot suppress a project mailbox", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-ack-upgrade-"));
  try {
    const path = join(root, "state.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, sessions: { [SESSION]: NOW } }),
    );
    const state = readAckReminderState(path);
    expect(
      prepareAckReminder(SESSION, "/p", [message()], [], state, NOW),
    ).toBeDefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the daemon reminds both project mailboxes sharing a session id", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-ack-sweep-"));
  const home = join(root, "home");
  const state = join(home, ".claude", "agent-mail");
  const inbox = join(state, "inbox");
  const registry = join(state, "registry");
  mkdirSync(inbox, { recursive: true });
  mkdirSync(registry);
  const now = Date.now();
  const procStart = processInfo([process.pid]).get(process.pid)?.start;
  if (!procStart) throw new Error("test process identity unavailable");
  const spools: string[] = [];
  for (const name of ["one", "two"]) {
    const directory = join(root, name);
    mkdirSync(directory);
    const project = realpathSync(directory);
    const slug = projectSlug(project);
    writeFileSync(
      join(registry, `${slug}-${process.pid}.json`),
      JSON.stringify({
        cwd: project,
        pid: process.pid,
        procStart,
        sessionId: SESSION,
        started: new Date(now - 2 * HOUR).toISOString(),
      }),
    );
    const spool = join(inbox, `${slug}.jsonl`);
    spools.push(spool);
    writeFileSync(
      spool,
      `${JSON.stringify(
        message({
          id: name,
          project,
          ts: new Date(now - HOUR).toISOString(),
        }),
      )}\n`,
    );
  }
  // Module initialization runs the real startup sweep before emitting this signal.
  const boot = join(root, "boot.ts");
  writeFileSync(
    boot,
    `import ${JSON.stringify(join(import.meta.dir, "daemon.ts"))}; console.log("reminder-sweep-ready");\n`,
  );
  const daemon = Bun.spawn([process.execPath, boot], {
    env: {
      ...process.env,
      HOME: home,
      AGENT_MAIL_PORT: "0",
      AGENT_MAIL_SLACK_WEBHOOK: "",
      AGENT_MAIL_SLACK_BOT_TOKEN: "",
      AGENT_MAIL_SLACK_CHANNEL: "",
      AGENT_MAIL_WEFT_BIN: join(root, "no-weft"),
      AGENT_MAIL_DEFAULT_TTL_SECONDS: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = daemon.stdout.getReader();
    let output = "";
    while (!output.includes("reminder-sweep-ready\n")) {
      const chunk = await reader.read();
      if (chunk.done)
        throw new Error("daemon exited before its startup sweep finished");
      output += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    for (const spool of spools) {
      const messages = readFileSync(spool, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as StoredMessage);
      expect(
        messages
          .filter((m) => m.meta?.ackReminder === "true")
          .map((m) => m.meta?.toSession),
      ).toEqual([SESSION]);
    }
  } finally {
    daemon.kill();
    await daemon.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("nothing outstanding produces no reminder", () => {
  expect(
    prepareAckReminder(
      SESSION,
      "/p",
      [message({ read: true })],
      [],
      EMPTY,
      NOW,
    ),
  ).toBeUndefined();
});
