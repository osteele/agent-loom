import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./lock.ts";
import { ensureDirs, projectSlug, receiptPath, spoolPath } from "./paths.ts";
import { processInfo, register, unregister } from "./registry.ts";
import { sleepSync } from "./runtime.ts";
import {
  type AdmissionOptions,
  type DeliveryReceipt,
  type Message,
  admissionDecision,
  appendMessage,
  type appendMessageGuarded,
  appendReceipt,
  emptyReceiptTail,
  intendedDeliveryReceipts,
  isExpired,
  messageVisibleToSession,
  readReceiptTail,
  readReceipts,
  shouldEchoMessageToSlack,
} from "./spool.ts";

const base: Message = {
  ts: "2026-07-22T00:00:00.000Z",
  from: "/project/a",
  project: "/project/b",
  message: "hello",
};

test("messageVisibleToSession hides self-authored shared-spool mail", () => {
  expect(
    messageVisibleToSession(
      { ...base, meta: { sessionId: "sender" } },
      "sender",
    ),
  ).toBe(false);
});

test("messageVisibleToSession shows mail from other sessions", () => {
  expect(
    messageVisibleToSession(
      { ...base, meta: { sessionId: "sender" } },
      "recipient",
    ),
  ).toBe(true);
});

const PUSH_CAPABLE = {
  tools: true,
  inboxPoll: true,
  channelPush: true,
  claims: true,
  workLeases: true,
  receipts: true,
  nativePeerMessaging: false,
};

test("spooling records each intended live recipient before its transport polls", () => {
  const receipts = intendedDeliveryReceipts(
    {
      ...base,
      id: "mail-1",
      meta: { sessionId: "sender", toSession: "target" },
    },
    [
      { sessionId: "sender", capabilities: PUSH_CAPABLE },
      { sessionId: "target", capabilities: PUSH_CAPABLE },
      { sessionId: "other", capabilities: PUSH_CAPABLE },
    ],
    Date.parse(base.ts),
  );
  expect(receipts).toEqual([
    {
      messageId: "mail-1",
      project: base.project,
      ts: base.ts,
      status: "pending",
      sessionId: "target",
      senderSessionId: "sender",
      detail: "intended live recipient",
    },
  ]);
});

test("intended-recipient receipts carry the canonical origin session id", () => {
  // `origin.sessionId` is the envelope's canonical sender field; a message
  // stamped only there (no legacy `meta.sessionId`) must still attribute its
  // receipts, or receipts answer "who sent this" only for old-format mail.
  const receipts = intendedDeliveryReceipts(
    {
      ...base,
      id: "mail-1b",
      origin: {
        kind: "agent",
        transport: "mcp",
        sessionId: "origin-sender",
        authority: "untrusted",
      },
    },
    [{ sessionId: "target", capabilities: PUSH_CAPABLE }],
    Date.parse(base.ts),
  );
  expect(receipts).toEqual([
    {
      messageId: "mail-1b",
      project: base.project,
      ts: base.ts,
      status: "pending",
      sessionId: "target",
      senderSessionId: "origin-sender",
      detail: "intended live recipient",
    },
  ]);
});

test("known broken channel setup records an unreachable attempt, not a push", () => {
  const receipts = intendedDeliveryReceipts(
    { ...base, id: "mail-2" },
    [
      {
        sessionId: "target",
        capabilities: {
          ...PUSH_CAPABLE,
          channelPushStatus: "host-not-loaded",
        },
      },
    ],
    Date.parse(base.ts),
  );
  expect(receipts).toEqual([
    {
      messageId: "mail-2",
      project: base.project,
      ts: base.ts,
      status: "push-unreachable",
      sessionId: "target",
      detail: "channel:host-not-loaded",
    },
  ]);
});

test("appendMessage persists intended-recipient evidence without a receiver poll", () => {
  const project = mkdtempSync(join(tmpdir(), "agent-mail-intent-"));
  const instanceId = "intent-test-instance";
  const procStart = processInfo([process.pid]).get(process.pid)?.start;
  if (!procStart) throw new Error("test process liveness unavailable");
  try {
    register(
      project,
      process.pid,
      "intent-recipient",
      undefined,
      "claude-code",
      PUSH_CAPABLE,
      "accept",
      procStart,
      instanceId,
    );
    appendMessage({
      ...base,
      id: "mail-3",
      project,
    });
    expect(readReceipts(project, "mail-3")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: "mail-3",
          status: "pending",
          sessionId: "intent-recipient",
          detail: "intended live recipient",
        }),
      ]),
    );
  } finally {
    unregister(project, process.pid, instanceId);
    rmSync(project, { recursive: true, force: true });
  }
});

test("appendMessage stamps the spooled receipt with the sender session", () => {
  const project = mkdtempSync(join(tmpdir(), "agent-mail-sender-"));
  try {
    appendMessage({
      ...base,
      id: "mail-4",
      project,
      origin: {
        kind: "agent",
        transport: "mcp",
        sessionId: "sender-session-7",
        authority: "untrusted",
      },
    });
    expect(readReceipts(project, "mail-4")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: "mail-4",
          status: "spooled",
          senderSessionId: "sender-session-7",
        }),
      ]),
    );
    // An unattributed message (decision 0014: no verified session) must not
    // grow a sender field out of the free-form `from` label.
    appendMessage({ ...base, id: "mail-5", project });
    for (const receipt of readReceipts(project, "mail-5")) {
      expect(receipt.senderSessionId).toBeUndefined();
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("messageVisibleToSession honors direct session targets", () => {
  expect(
    messageVisibleToSession(
      { ...base, meta: { sessionId: "sender", toSession: "recipient" } },
      "bystander",
    ),
  ).toBe(false);
  expect(
    messageVisibleToSession(
      { ...base, meta: { sessionId: "sender", toSession: "recipient" } },
      "recipient",
    ),
  ).toBe(true);
});

test("messageVisibleToSession shows explicitly self-targeted mail", () => {
  expect(
    messageVisibleToSession(
      { ...base, meta: { sessionId: "sender", toSession: "sender" } },
      "sender",
    ),
  ).toBe(true);
});

const admission: AdmissionOptions = {
  duplicateWindowSeconds: 10,
  messageRateLimitPerMinute: 2,
  defaultMessageTtlSeconds: null,
};

test("admission deduplicates retry keys and recent identical bodies", () => {
  const now = Date.parse("2026-07-22T00:00:10.000Z");
  const prior: Message = {
    ...base,
    id: "prior",
    ts: "2026-07-22T00:00:05.000Z",
    idempotencyKey: "job-42",
  };
  expect(
    admissionDecision(
      [prior],
      { ...base, idempotencyKey: "job-42" },
      admission,
      now,
    ),
  ).toEqual({ status: "duplicate", id: "prior", reason: "idempotency-key" });
  // Same text, no key: caught by the signature window instead. The reason has
  // to distinguish the two — a sender that generated a one-off key reads a
  // key collision as its own message having already landed, and must not read
  // a signature collision the same way.
  expect(admissionDecision([prior], { ...base }, admission, now)).toEqual({
    status: "duplicate",
    id: "prior",
    reason: "signature",
  });
});

test("admission rate-limits one sender without blocking another", () => {
  const now = Date.parse("2026-07-22T00:01:00.000Z");
  const recent = [
    { ...base, id: "one", ts: "2026-07-22T00:00:30.000Z", message: "one" },
    { ...base, id: "two", ts: "2026-07-22T00:00:45.000Z", message: "two" },
  ];
  expect(
    admissionDecision(recent, { ...base, message: "three" }, admission, now),
  ).toEqual({ status: "rate_limited", retryAfterSeconds: 30 });
  expect(
    admissionDecision(
      recent,
      { ...base, from: "/project/c", message: "three" },
      admission,
      now,
    ),
  ).toEqual({ status: "accept" });
});

test("zero disables body deduplication and rate limiting", () => {
  const now = Date.parse("2026-07-22T00:01:00.000Z");
  const prior = {
    ...base,
    id: "prior",
    ts: "2026-07-22T00:00:59.000Z",
  };
  expect(
    admissionDecision(
      [prior],
      base,
      {
        ...admission,
        duplicateWindowSeconds: 0,
        messageRateLimitPerMinute: 0,
      },
      now,
    ),
  ).toEqual({ status: "accept" });
});

test("guarded admission serializes a daemon and direct fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-spool-race-"));
  const project = join(root, "project");
  const marker = join(root, "child-started");
  const script = join(root, "append.ts");
  mkdirSync(project);
  const msg: Message = {
    ...base,
    ts: new Date().toISOString(),
    project,
    attemptKey: "same-delivery-attempt",
  };
  const spoolModule = join(import.meta.dir, "spool.ts");
  writeFileSync(
    script,
    `
      import { writeFileSync } from "node:fs";
      import { appendMessageGuarded } from ${JSON.stringify(spoolModule)};
      writeFileSync(${JSON.stringify(marker)}, "ready");
      const result = appendMessageGuarded(
        ${JSON.stringify(msg)},
        ${JSON.stringify(admission)},
      );
      console.log(JSON.stringify(result));
    `,
  );

  const lockPath = `${spoolPath(project)}.lock`;
  try {
    const child = withFileLock(lockPath, () => {
      const subprocess = Bun.spawn([process.execPath, script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const deadline = Date.now() + 2_000;
      while (!existsSync(marker) && Date.now() < deadline) sleepSync(10);
      expect(existsSync(marker)).toBe(true);
      // The child writes the marker immediately before guarded admission. Give
      // it time to reach the held lock, then let the daemon-side append win.
      sleepSync(50);
      appendMessage({ ...msg, id: "daemon-copy" });
      return subprocess;
    });

    expect(await child.exited).toBe(0);
    const result = JSON.parse(
      await new Response(child.stdout).text(),
    ) as ReturnType<typeof appendMessageGuarded>;
    expect(result).toEqual({
      status: "duplicate",
      id: "daemon-copy",
      reason: "attempt-key",
    });
    expect(
      readFileSync(spoolPath(project), "utf8").trim().split("\n"),
    ).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit and expired messages are not visible to a receiving session", () => {
  const now = Date.parse("2026-07-22T00:00:10.000Z");
  expect(
    messageVisibleToSession({ ...base, delivery: "audit" }, "receiver"),
  ).toBe(false);
  const expired = { ...base, expiresAt: "2026-07-22T00:00:09.000Z" };
  expect(isExpired(expired, now)).toBe(true);
});

test("Slack echo defaults on and can be suppressed per message", () => {
  expect(shouldEchoMessageToSlack(base)).toBe(true);
  expect(shouldEchoMessageToSlack({ ...base, slackEcho: true })).toBe(true);
  expect(shouldEchoMessageToSlack({ ...base, slackEcho: false })).toBe(false);
});

test("findReceipts locates a sent message's receipts in the recipient's project", async () => {
  // The defect this guards: receipts are keyed to the recipient's project, so a
  // sender querying its own project always saw nothing, and an empty result
  // reads as "dropped". Three sessions acted on that in one day. STATE_DIR is
  // resolved at module load from HOME, so this runs in a subprocess.
  const root = mkdtempSync(join(tmpdir(), "agent-mail-findreceipts-"));
  const receiptsDir = join(root, ".claude", "agent-mail", "receipts");
  const inboxDir = join(root, ".claude", "agent-mail", "inbox");
  mkdirSync(receiptsDir, { recursive: true });
  mkdirSync(inboxDir, { recursive: true });
  const sender = "/projects/sender";
  const recipient = "/projects/recipient";
  // knownProjects() discovers projects from each spool's first line, and both
  // spool and receipt files are named by projectSlug — not by any name we pick.
  for (const project of [sender, recipient]) {
    writeFileSync(
      join(inboxDir, `${projectSlug(project)}.jsonl`),
      `${JSON.stringify({ id: `seed-${projectSlug(project)}`, ts: "2026-08-17T00:00:00.000Z", from: "x", project, message: "seed" })}\n`,
    );
  }
  writeFileSync(
    join(receiptsDir, `${projectSlug(recipient)}.jsonl`),
    `${JSON.stringify({ messageId: "m-1", project: recipient, ts: "2026-08-17T06:00:00.000Z", status: "spooled" })}\n${JSON.stringify({ messageId: "m-1", project: recipient, ts: "2026-08-17T06:00:01.000Z", status: "pushed", sessionId: "s-1" })}\n`,
  );

  const script = join(root, "probe.ts");
  writeFileSync(
    script,
    [
      `import { findReceipts, readReceipts } from ${JSON.stringify(join(import.meta.dir, "spool.ts"))};`,
      `const own = readReceipts(${JSON.stringify(sender)}, "m-1").length;`,
      `const found = findReceipts("m-1", ${JSON.stringify(sender)});`,
      `const missing = findReceipts("absent", ${JSON.stringify(sender)});`,
      "console.log(JSON.stringify({ own, project: found?.project ?? null, count: found?.receipts.length ?? 0, missing: missing === undefined }));",
    ].join("\n"),
  );
  try {
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env, HOME: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    const out = JSON.parse(await new Response(child.stdout).text()) as {
      own: number;
      project: string | null;
      count: number;
      missing: boolean;
    };
    expect(out.own).toBe(0); // the old, misleading answer
    expect(out.project).toBe(recipient); // found where they actually live
    expect(out.count).toBe(2);
    expect(out.missing).toBe(true); // a genuinely unknown id still reports nothing
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

// --- receipt cursor -------------------------------------------------------
// These pin incrementality by object identity rather than by timing. A full
// re-read produces fresh objects for lines already ingested, so an accidental
// return to readReceipts() in the poll path fails these deterministically,
// where a duration threshold would only flake.

let receiptProjectCounter = 0;
function receiptProject(): string {
  ensureDirs();
  receiptProjectCounter += 1;
  const project = `/tmp/agent-mail-receipt-tail-${receiptProjectCounter}`;
  rmSync(receiptPath(project), { force: true });
  return project;
}

function receipt(messageId: string, sessionId = "session-1"): DeliveryReceipt {
  return {
    messageId,
    project: "unused",
    ts: "2026-08-24T00:00:00.000Z",
    status: "pushed",
    sessionId,
  };
}

test("the receipt cursor parses each appended line exactly once", () => {
  const project = receiptProject();
  const tail = emptyReceiptTail();
  for (const id of ["a", "b", "c"]) appendReceipt(project, receipt(id));

  const first = readReceiptTail(project, tail).receipts;
  expect(first.map((r) => r.messageId)).toEqual(["a", "b", "c"]);
  const alreadyParsed = first[0];
  const offsetAfterFirst = tail.offset;

  appendReceipt(project, receipt("d"));
  const second = readReceiptTail(project, tail).receipts;

  expect(second.map((r) => r.messageId)).toEqual(["a", "b", "c", "d"]);
  // The identity check is the regression guard: re-reading the file whole would
  // replace this object, which is exactly the cost the cursor exists to avoid.
  expect(second[0]).toBe(alreadyParsed);
  expect(tail.offset).toBeGreaterThan(offsetAfterFirst);
});

test("a cursor read with nothing appended does no work", () => {
  const project = receiptProject();
  const tail = emptyReceiptTail();
  appendReceipt(project, receipt("a"));

  const parsed = readReceiptTail(project, tail).receipts[0];
  const offset = tail.offset;
  const again = readReceiptTail(project, tail);

  expect(again.receipts).toHaveLength(1);
  expect(again.receipts[0]).toBe(parsed);
  expect(again.offset).toBe(offset);
});

test("the cursor picks up receipts appended by another listener", () => {
  // One receipt log per project, shared by every listener in it. A cursor that
  // only accounted for its own writes would silently lose peers' transitions.
  const project = receiptProject();
  const tail = emptyReceiptTail();
  appendReceipt(project, receipt("a", "session-1"));
  readReceiptTail(project, tail);

  appendReceipt(project, receipt("b", "session-2"));

  expect(
    readReceiptTail(project, tail).receipts.map((r) => r.sessionId),
  ).toEqual(["session-1", "session-2"]);
});

test("a truncated or rotated log restarts the cursor", () => {
  // Forward compatibility with pruning: rotation shrinks the file under a live
  // reader, whose offset then points past the end. Reading from there would
  // return nothing forever.
  const project = receiptProject();
  const tail = emptyReceiptTail();
  for (const id of ["a", "b", "c"]) appendReceipt(project, receipt(id));
  readReceiptTail(project, tail);

  writeFileSync(
    receiptPath(project),
    `${JSON.stringify(receipt("kept"))}\n`,
    "utf8",
  );

  expect(
    readReceiptTail(project, tail).receipts.map((r) => r.messageId),
  ).toEqual(["kept"]);
});

test("a torn final append is left for the next read", () => {
  // Consuming a partial line would advance the offset past bytes that never
  // formed a record, dropping the receipt permanently once its newline landed.
  const project = receiptProject();
  const tail = emptyReceiptTail();
  appendReceipt(project, receipt("whole"));
  readReceiptTail(project, tail);

  const partial = JSON.stringify(receipt("torn"));
  writeFileSync(
    receiptPath(project),
    `${JSON.stringify(receipt("whole"))}\n${partial.slice(0, 20)}`,
    "utf8",
  );
  expect(
    readReceiptTail(project, tail).receipts.map((r) => r.messageId),
  ).toEqual(["whole"]);

  writeFileSync(
    receiptPath(project),
    `${JSON.stringify(receipt("whole"))}\n${partial}\n`,
    "utf8",
  );
  expect(
    readReceiptTail(project, tail).receipts.map((r) => r.messageId),
  ).toEqual(["whole", "torn"]);
});
