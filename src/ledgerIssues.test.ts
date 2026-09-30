import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEDGER_ISSUES_SNAPSHOT_TTL_MS,
  type LedgerIssuesSnapshot,
  currentLedgerObligations,
  describeLedgerObligation,
  ledgerObligationRefusal,
  ledgerObligationsDiagnostic,
  parseLedgerIssueRows,
  projectLedgerObligations,
  readLedgerIssuesSnapshot,
  writeLedgerIssuesSnapshot,
} from "./ledgerIssues.ts";
import type { Role } from "./obligations.ts";
import { summarizeObligations } from "./sessionStatus.ts";

function tempSnapshotPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), "agent-mail-ledger-")),
    "ledger-issues.json",
  );
}

function snapshot(
  issues: LedgerIssuesSnapshot["issues"],
  observedAt = 1_000,
): LedgerIssuesSnapshot {
  return { version: 1, observedAt, observedBy: 1234, issues };
}

const AM17 = {
  id: "am17",
  title: "fix the retry loop",
  component: "agent-mail",
  watchers: [] as string[],
};

// --- snapshot file -----------------------------------------------------------

test("a published snapshot round-trips", () => {
  const path = tempSnapshotPath();
  try {
    const written = writeLedgerIssuesSnapshot({ issues: [AM17] }, 1000, path);
    expect(written.observedAt).toBe(1000);
    const read = readLedgerIssuesSnapshot(path);
    expect(read?.issues).toEqual([AM17]);
    expect(read?.lastError).toBeUndefined();
  } finally {
    rmSync(path, { force: true });
  }
});

test("a missing or malformed snapshot reads as absent, never throws", () => {
  const path = tempSnapshotPath();
  try {
    expect(readLedgerIssuesSnapshot(path)).toBeUndefined();
    writeFileSync(path, "{ not json");
    expect(readLedgerIssuesSnapshot(path)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ version: 99, observedAt: 1000 }));
    expect(readLedgerIssuesSnapshot(path)).toBeUndefined();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, observedAt: 1000, issues: [{ id: 7 }] }),
    );
    expect(readLedgerIssuesSnapshot(path)).toBeUndefined();
  } finally {
    rmSync(path, { force: true });
  }
});

test("a failed refresh keeps the previous rows and records the error", () => {
  const path = tempSnapshotPath();
  try {
    writeLedgerIssuesSnapshot({ issues: [AM17] }, 1000, path);
    const failed = writeLedgerIssuesSnapshot(
      { error: "issues exited 1" },
      1_060_000,
      path,
    );
    expect(failed.issues).toEqual([AM17]);
    expect(failed.observedAt).toBe(1000);
    expect(failed.lastError).toBe("issues exited 1");
    expect(failed.lastErrorAt).toBe(1_060_000);
    // The failure persists through the read.
    const read = readLedgerIssuesSnapshot(path);
    expect(read?.issues).toEqual([AM17]);
    expect(read?.lastError).toBe("issues exited 1");
    // The next good read clears the error.
    const recovered = writeLedgerIssuesSnapshot(
      { issues: [] },
      1_120_000,
      path,
    );
    expect(recovered.lastError).toBeUndefined();
    expect(recovered.observedAt).toBe(1_120_000);
  } finally {
    rmSync(path, { force: true });
  }
});

test("a failed first refresh records the error over empty rows", () => {
  const path = tempSnapshotPath();
  try {
    const failed = writeLedgerIssuesSnapshot(
      { error: "spawn ENOENT" },
      2000,
      path,
    );
    expect(failed.issues).toEqual([]);
    expect(failed.lastError).toBe("spawn ENOENT");
    expect(readLedgerIssuesSnapshot(path)?.lastError).toBe("spawn ENOENT");
  } finally {
    rmSync(path, { force: true });
  }
});

// --- parsing the ledger's rows ------------------------------------------------

test("open rows parse; closed rows and malformed documents do not project", () => {
  const rows = parseLedgerIssueRows([
    {
      id: "am17",
      title: "open one",
      component: "agent-mail",
      status: "open",
    },
    {
      id: "am18",
      title: "closed one",
      component: "agent-mail",
      status: "closed",
    },
    { id: "am19", title: "no status field", component: "agent-mail" },
  ]);
  expect(rows?.map((row) => row.id)).toEqual(["am17", "am19"]);
  // A document this build does not recognise is refused whole: a partially
  // parsed listing would read as settled.
  expect(parseLedgerIssueRows({ issues: [] })).toBeUndefined();
  expect(parseLedgerIssueRows([{ id: "am17" }])).toBeUndefined();
  expect(
    parseLedgerIssueRows([
      {
        id: "am17",
        title: "t",
        component: "c",
        watchers: ["agent-mail:x", 7],
      },
    ]),
  ).toBeUndefined();
});

test("rows from the current ledger output parse with defaults", () => {
  // `watchers` and `component_path` postdate the first consumers: a row that
  // omits them parses with [] and unknown respectively.
  const rows = parseLedgerIssueRows([
    { id: "am17", title: "fix the retry loop", component: "agent-mail" },
  ]);
  expect(rows).toEqual([AM17]);
});

// --- the projection -----------------------------------------------------------

test("watcher tokens map to obligees; foreign prefixes are ignored", () => {
  const projected = projectLedgerObligations(
    snapshot([
      {
        id: "am17",
        title: "fix the retry loop",
        component: "agent-mail",
        watchers: [
          "agent-mail:sess-t",
          // Longer than the agent-mail: prefix, so dropping the prefix check
          // would leave a non-empty suffix rather than filtering it by luck.
          "other-tool:session-0123456789",
          "agent-mail:sess-t",
          "agent-mail:",
        ],
      },
      { id: "am18", title: "unwatched", component: "agent-mail", watchers: [] },
    ]),
    1_000,
    () => "sess-s",
  );
  expect(projected.length).toBe(2);
  const [watched, unwatched] = projected;
  expect(watched.id).toBe("issue:am17");
  expect(watched.kind).toBe("external_fix");
  expect(watched.subject).toBe("am17: fix the retry loop");
  expect(watched.obligees).toEqual(["sess-t"]);
  expect(watched.ownerSessionId).toBe("sess-s");
  expect(watched.source).toBe("issue-ledger");
  expect(watched.observedAt).toBe(1_000);
  expect(watched.stale).toBe(false);
  // An issue with no agent-mail watcher still appears — the owner owes the
  // fix — with no obligee.
  expect(unwatched.obligees).toEqual([]);
});

test("the obligor role takes component_path when present, the name otherwise", () => {
  const seen: Role[] = [];
  const projected = projectLedgerObligations(
    snapshot([
      {
        id: "am17",
        title: "pathed",
        component: "agent-mail",
        componentPath: "/code/agent-mail",
        watchers: [],
      },
      { id: "am18", title: "named", component: "weft", watchers: [] },
    ]),
    1_000,
    (role) => {
      seen.push(role);
      return undefined;
    },
  );
  expect(seen).toEqual([
    { kind: "component_owner", component: "/code/agent-mail" },
    { kind: "component_owner", component: "weft" },
  ]);
  // An unmatched or ambiguous component leaves the obligor unresolved — the
  // projection never guesses.
  expect(projected.map((o) => o.ownerSessionId)).toEqual([
    undefined,
    undefined,
  ]);
});

test("a snapshot past its TTL projects rows marked stale", () => {
  const issues = [{ id: "am17", title: "t", component: "c", watchers: [] }];
  const staleAt = 1_000 + LEDGER_ISSUES_SNAPSHOT_TTL_MS + 1;
  const projected = projectLedgerObligations(
    snapshot(issues),
    staleAt,
    () => undefined,
  );
  expect(projected[0].stale).toBe(true);
  const fresh = projectLedgerObligations(
    snapshot(issues),
    1_000 + LEDGER_ISSUES_SNAPSHOT_TTL_MS,
    () => undefined,
  );
  expect(fresh[0].stale).toBe(false);
});

test("renderings tag the source and a stale snapshot's age", () => {
  const watched = {
    id: "am17",
    title: "fix the retry loop",
    component: "agent-mail",
    watchers: ["agent-mail:sess-t"],
  };
  const [row] = projectLedgerObligations(
    snapshot([watched]),
    1_000,
    () => "sess-s",
  );
  const text = describeLedgerObligation(row, 1_000);
  expect(text).toContain("issue:am17 external_fix am17: fix the retry loop");
  expect(text).toContain("owed to sess-t by owner of agent-mail → sess-s");
  expect(text).toContain("[issue-ledger]");
  expect(text).not.toContain("stale");
  const staleAt = 1_000 + LEDGER_ISSUES_SNAPSHOT_TTL_MS + 30 * 60_000;
  const [staleRow] = projectLedgerObligations(
    snapshot([watched]),
    staleAt,
    () => "sess-s",
  );
  expect(describeLedgerObligation(staleRow, staleAt)).toContain(
    "[stale: snapshot 33m old]",
  );
  // An unresolved owner renders as such, never guessed.
  const [unresolved] = projectLedgerObligations(
    snapshot([{ id: "am18", title: "t", component: "ghost", watchers: [] }]),
    1_000,
    () => undefined,
  );
  const unresolvedText = describeLedgerObligation(unresolved, 1_000);
  expect(unresolvedText).toContain("owed to no watcher");
  expect(unresolvedText).toContain("owner of ghost (unresolvable:");
});

test("a missing or failed snapshot yields its diagnostic", () => {
  expect(ledgerObligationsDiagnostic(undefined, 1_000)).toContain(
    "ledger obligations unavailable",
  );
  const failed = {
    ...snapshot([{ id: "am17", title: "t", component: "c", watchers: [] }]),
    lastError: "issues exited 1",
    lastErrorAt: 1_000,
  };
  const diagnostic = ledgerObligationsDiagnostic(failed, 1_000 + 10 * 60_000);
  expect(diagnostic).toContain("issues exited 1");
  expect(diagnostic).toContain("10m ago");
  // A healthy snapshot has no diagnostic.
  expect(
    ledgerObligationsDiagnostic(
      snapshot([{ id: "am17", title: "t", component: "c", watchers: [] }]),
      1_000,
    ),
  ).toBeUndefined();
});

test("currentLedgerObligations reads only the snapshot file", () => {
  const path = tempSnapshotPath();
  try {
    // No snapshot: absent rows with the explanation, never silence.
    const missing = currentLedgerObligations(() => undefined, 1_000, path);
    expect(missing.obligations).toEqual([]);
    expect(missing.diagnostic).toContain("ledger obligations unavailable");
    writeLedgerIssuesSnapshot(
      { issues: [{ ...AM17, watchers: ["agent-mail:sess-t"] }] },
      1_000,
      path,
    );
    const view = currentLedgerObligations(() => "sess-s", 1_000, path);
    expect(view.diagnostic).toBeUndefined();
    expect(view.obligations.map((o) => o.id)).toEqual(["issue:am17"]);
    expect(view.obligations[0].ownerSessionId).toBe("sess-s");
  } finally {
    rmSync(path, { force: true });
  }
});

// --- counts -------------------------------------------------------------------

test("an issue adds to its owner's owed and each watcher's waiting", () => {
  const projected = projectLedgerObligations(
    snapshot([
      {
        id: "am17",
        title: "fix the retry loop",
        component: "agent-mail",
        watchers: ["agent-mail:sess-t"],
      },
    ]),
    1_000,
    () => "sess-s",
  );
  // The resolved component owner owes the fix.
  expect(summarizeObligations([], "sess-s", undefined, projected)).toEqual({
    waiting: 0,
    owed: 1,
    humanOwed: 0,
    roleOwed: 1,
    unresolvedOwed: 0,
  });
  // The watcher session waits on it.
  expect(summarizeObligations([], "sess-t", undefined, projected)).toEqual({
    waiting: 1,
    owed: 0,
    humanOwed: 0,
    roleOwed: 1,
    unresolvedOwed: 0,
  });
  // An uninvolved session sees only the machine-global role counts.
  expect(summarizeObligations([], "sess-u", undefined, projected)).toEqual({
    waiting: 0,
    owed: 0,
    humanOwed: 0,
    roleOwed: 1,
    unresolvedOwed: 0,
  });
  // An unresolved owner counts as unresolved everywhere, owed by nobody.
  const unresolved = projectLedgerObligations(
    snapshot([{ id: "am18", title: "t", component: "ghost", watchers: [] }]),
    1_000,
    () => undefined,
  );
  expect(summarizeObligations([], "sess-s", undefined, unresolved)).toEqual({
    waiting: 0,
    owed: 0,
    humanOwed: 0,
    roleOwed: 1,
    unresolvedOwed: 1,
  });
  // The machine-global summary counts the projection once per record.
  expect(
    summarizeObligations([], undefined, undefined, projected).waiting,
  ).toBe(1);
});

// --- read-only refusals ---------------------------------------------------------

test("a mutating verb on an issue: id refuses with the ledger's command", () => {
  // Stored obligation ids pass through.
  expect(ledgerObligationRefusal("ob-1234abcd", "close")).toBeUndefined();
  expect(ledgerObligationRefusal("issue:am17", "close")).toBe(
    "issue:am17 is a ledger obligation, projected read-only from the issue ledger; use `issues close am17` instead",
  );
  expect(ledgerObligationRefusal("issue:am17", "clear")).toContain(
    "issues close am17",
  );
  expect(ledgerObligationRefusal("issue:am17", "withdraw")).toContain(
    "issues unwatch am17",
  );
  expect(ledgerObligationRefusal("issue:am17", "contest")).toContain(
    "issues note am17",
  );
  expect(ledgerObligationRefusal("issue:am17", "update")).toContain(
    "issues note am17",
  );
  expect(ledgerObligationRefusal("issue:am17", "comment")).toContain(
    "issues note am17",
  );
});
