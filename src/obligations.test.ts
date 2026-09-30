import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { ClaimStore, claims } from "./claims.ts";
import { resolveObligationRole } from "./obligationResolution.ts";
import {
  type Obligation,
  ObligationAuthorityError,
  ObligationDuplicateError,
  type ObligationKind,
  type ObligationMarker,
  ObligationStateError,
  ObligationStore,
  type ObligationStoreOptions,
  type Party,
  type Role,
  type SessionParty,
  TERMINAL_RETENTION_MS,
  partyKey,
} from "./obligations.ts";
import { register } from "./registry.ts";
import { work } from "./work.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function makeStore(
  live: string[] = [],
  resolveRole?: (role: Role) => string | undefined,
) {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-obligations-"));
  temporaryDirectories.push(root);
  const liveSessions = new Set(live);
  const notifications: Obligation[] = [];
  const notifiedTargets: (Party | undefined)[] = [];
  const options: ObligationStoreOptions = {
    root,
    isLive: (sessionId) => liveSessions.has(sessionId),
    notify: (obligation, resolvedObligor) => {
      notifications.push(obligation);
      notifiedTargets.push(resolvedObligor);
    },
    ...(resolveRole ? { resolveRole } : {}),
  };
  const store = new ObligationStore(options);
  return {
    store,
    notifications,
    notifiedTargets,
    liveSessions,
    options,
    root,
    setLive: (sessionId: string, value: boolean) => {
      if (value) liveSessions.add(sessionId);
      else liveSessions.delete(sessionId);
    },
  };
}

const ALICE: SessionParty = {
  kind: "session",
  sessionId: "alice",
  label: "Alice",
};
const BOB: SessionParty = { kind: "session", sessionId: "bob", label: "Bob" };
const CAROL: SessionParty = {
  kind: "session",
  sessionId: "carol",
  label: "Carol",
};
const DAVE: SessionParty = {
  kind: "session",
  sessionId: "dave",
  label: "Dave",
};
const HUMAN = { kind: "human" as const, label: "user" };
const SESSION_OBLIGOR = {
  kind: "session" as const,
  ...{ sessionId: "bob", label: "Bob" },
};
const WEFT = { kind: "system" as const, system: "weft", label: "weft" };
const ISSUE_LEDGER = {
  kind: "system" as const,
  system: "issue-ledger",
  label: "issue-ledger",
};
const T0 = "2026-09-27T00:00:00.000Z";
const T1 = "2026-09-27T01:00:00.000Z";

function announce(
  store: ObligationStore,
  overrides: {
    obligee?: Party;
    obligor?: Party;
    kind?: ObligationKind;
    subject?: string;
  } = {},
) {
  return store.announce(
    {
      obligee: overrides.obligee ?? ALICE,
      obligor: overrides.obligor ?? HUMAN,
      kind: overrides.kind ?? "decision",
      subject: overrides.subject ?? "pick the model for EXP-042",
    },
    { now: T0 },
  );
}

// ---------------------------------------------------------------------------
// Announce
// ---------------------------------------------------------------------------

test("announce creates an open, uncontested record with provenance fields", () => {
  const { store } = makeStore([ALICE.sessionId]);
  const record = announce(store);
  expect(record.version).toBe(2);
  expect(record.id.startsWith("ob-")).toBe(true);
  expect(record.status).toBe("open");
  expect(record.contested).toBe(false);
  expect(record.createdAt).toBe(T0);
  expect(record.obligee).toEqual(ALICE);
  expect(record.obligor).toEqual(HUMAN);
  expect(record.kind).toBe("decision");
  expect(record.revision).toBe(1);
});

test("announce pushes exactly once for a session obligor and never for the human", () => {
  const { store, notifications } = makeStore([ALICE.sessionId, BOB.sessionId]);
  announce(store, { obligor: HUMAN });
  expect(notifications.length).toBe(0);
  announce(store, { obligor: SESSION_OBLIGOR, subject: "s2" });
  expect(notifications.length).toBe(1);
  expect(notifications[0].obligor).toEqual(SESSION_OBLIGOR);
});

test("announce is refused when the obligee session is not live", () => {
  const { store } = makeStore([]);
  expect(() => announce(store)).toThrow(ObligationAuthorityError);
});

test("announce is refused when a session obligor does not resolve live", () => {
  const { store } = makeStore([ALICE.sessionId]);
  expect(() =>
    announce(store, {
      obligor: { kind: "session", sessionId: "ghost", label: "Ghost" },
    }),
  ).toThrow(ObligationAuthorityError);
});

test("announce is refused for an open duplicate, naming the existing record", () => {
  const { store } = makeStore([ALICE.sessionId, BOB.sessionId]);
  const first = announce(store);
  // The obligor is not part of the duplicate key: only obligee, kind, subject.
  expect(() =>
    announce(store, {
      obligor: { kind: "session", sessionId: "bob", label: "Bob" },
    }),
  ).toThrow(ObligationDuplicateError);
  try {
    announce(store);
    throw new Error("expected duplicate announce to throw");
  } catch (error) {
    expect(error instanceof ObligationDuplicateError).toBe(true);
    expect((error as ObligationDuplicateError).obligation.id).toBe(first.id);
  }
});

test("a satisfied or withdrawn duplicate no longer blocks announce", () => {
  const { store } = makeStore([ALICE.sessionId]);
  const first = announce(store);
  store.close(first.id, ALICE, "chose glm", { now: T1 });
  const second = announce(store, { subject: "pick the model for EXP-042" });
  expect(second.status).toBe("open");
  expect(second.id).not.toBe(first.id);
});

// ---------------------------------------------------------------------------
// Party model: systems and roles
// ---------------------------------------------------------------------------

test("a system obligor announces against a wired settlement hook and an unwired one is refused", () => {
  const { store } = makeStore([ALICE.sessionId]);
  const record = announce(store, {
    kind: "job_completion",
    subject: "job-9",
    obligor: WEFT,
  });
  expect(record.obligor).toEqual(WEFT);
  expect(record.status).toBe("open");
  // A system with no settlement hook in this repo can never settle by
  // evidence, so announcing a wait on it is refused.
  expect(() =>
    announce(store, {
      kind: "job_completion",
      subject: "job-10",
      obligor: { kind: "system", system: "not-a-system", label: "nope" },
    }),
  ).toThrow(ObligationAuthorityError);
});

test("EventSettles settles system and role obligors on a matching event, never belief-settled parties", () => {
  const { store } = makeStore(
    [ALICE.sessionId, BOB.sessionId, CAROL.sessionId, DAVE.sessionId],
    () => "bob",
  );
  const weftWait = announce(store, {
    kind: "job_completion",
    subject: "job-9",
    obligor: WEFT,
  });
  const otherSystemWait = announce(store, {
    kind: "job_completion",
    subject: "job-9",
    obligee: CAROL,
    obligor: ISSUE_LEDGER,
  });
  const roleWait = announce(store, {
    kind: "external_fix",
    subject: "job-9",
    obligor: {
      kind: "role",
      role: { kind: "component_owner", component: "agent-mail" },
      label: "owner of agent-mail",
    },
  });
  const roleOtherSubject = announce(store, {
    kind: "external_fix",
    subject: "am17",
    obligor: {
      kind: "role",
      role: { kind: "component_owner", component: "agent-mail" },
      label: "owner of agent-mail",
    },
  });
  const sessionWait = announce(store, {
    kind: "job_completion",
    subject: "job-9",
    obligee: DAVE,
    obligor: SESSION_OBLIGOR,
  });
  const humanWait = announce(store, {
    kind: "job_completion",
    subject: "job-9",
    obligee: BOB,
  });

  // A role obligor settles on the event whatever system observed it; a
  // system obligor only on its own system's event.
  const settled = store.settleByEvent("weft", "job-9", { now: T1 });
  expect(settled.map((o) => o.id).sort()).toEqual(
    [weftWait.id, roleWait.id].sort(),
  );
  for (const record of settled) {
    expect(record.closedBy).toBe("system");
    expect(record.closedAt).toBe(T1);
    expect(Date.parse(record.retainedUntil ?? "") - Date.parse(T1)).toBe(
      TERMINAL_RETENTION_MS,
    );
  }
  expect(store.get(otherSystemWait.id)?.status).toBe("open");
  // Session and human obligors settle by belief or authority, never by an
  // event about the same subject.
  expect(store.get(sessionWait.id)?.status).toBe("open");
  expect(store.get(humanWait.id)?.status).toBe("open");
  // Idempotent: a second pass settles nothing further.
  expect(store.settleByEvent("weft", "job-9", { now: T1 })).toEqual([]);
  // The other system's event settles its own wait, and a role obligor
  // settles on whatever system observed the event for its subject.
  const settledNow = store.settleByEvent("issue-ledger", "job-9", { now: T1 });
  expect(settledNow.map((o) => o.id)).toEqual([otherSystemWait.id]);
  const settledRole = store.settleByEvent("issue-ledger", "am17", { now: T1 });
  expect(settledRole.map((o) => o.id)).toEqual([roleOtherSubject.id]);
});

test("a role obligor announces when exactly one responsible session holds the role and is refused otherwise", () => {
  const componentOwner = {
    kind: "role" as const,
    role: { kind: "component_owner" as const, component: "agent-mail" },
    label: "owner of agent-mail",
  };
  const resolved = makeStore([ALICE.sessionId, BOB.sessionId], (role) =>
    role.kind === "component_owner" && role.component === "agent-mail"
      ? "bob"
      : undefined,
  );
  const record = announce(resolved.store, {
    kind: "external_fix",
    subject: "am17",
    obligor: componentOwner,
  });
  expect(record.obligor).toEqual(componentOwner);
  // The creation notice rides the role's resolution: the responsible
  // session is notified, not the role.
  expect(resolved.notifications.map((o) => o.id)).toEqual([record.id]);
  expect(resolved.notifiedTargets).toEqual([
    { kind: "session", sessionId: "bob", label: "owner of agent-mail" },
  ]);

  const unresolvable = makeStore([ALICE.sessionId], () => undefined);
  expect(() =>
    announce(unresolvable.store, {
      kind: "external_fix",
      subject: "am17",
      obligor: componentOwner,
    }),
  ).toThrow(ObligationAuthorityError);

  const unwired = makeStore([ALICE.sessionId]);
  expect(() =>
    announce(unwired.store, {
      kind: "external_fix",
      subject: "am17",
      obligor: componentOwner,
    }),
  ).toThrow(ObligationAuthorityError);
});

test("an artifact role obligee announces through its executor and the side constraints hold", () => {
  const planObligee = {
    kind: "role" as const,
    role: {
      kind: "plan_executor" as const,
      plan: "/tmp/loom-plans/reindex",
    },
    label: "executor of /tmp/loom-plans/reindex",
  };
  const { store } = makeStore([ALICE.sessionId], (role) =>
    role.kind === "plan_executor" ? "bob" : undefined,
  );
  const record = announce(store, {
    kind: "review",
    subject: "review the reindex output",
    obligee: planObligee,
  });
  expect(record.obligee).toEqual(planObligee);

  // PartySidesAreConstrained: the human owes and is never the creditor; a
  // component_owner only owes; plan and experiment roles only wait.
  expect(() => announce(store, { obligee: HUMAN, subject: "s1" })).toThrow(
    ObligationStateError,
  );
  expect(() =>
    announce(store, {
      obligee: {
        kind: "role",
        role: { kind: "component_owner", component: "agent-mail" },
        label: "owner of agent-mail",
      },
      subject: "s2",
    }),
  ).toThrow(ObligationStateError);
  expect(() =>
    announce(store, {
      obligor: planObligee,
      subject: "s3",
    }),
  ).toThrow(ObligationStateError);
});

test("OneOpenPerSubject is keyed on the obligee party, kind, and subject", () => {
  const { store } = makeStore([ALICE.sessionId, BOB.sessionId], (role) =>
    role.kind === "plan_executor" ? "bob" : undefined,
  );
  const planObligee = {
    kind: "role" as const,
    role: { kind: "plan_executor" as const, plan: "/tmp/p/reindex" },
    label: "executor of /tmp/p/reindex",
  };
  const first = announce(store, { obligee: planObligee, subject: "same" });
  expect(() =>
    announce(store, { obligee: planObligee, subject: "same" }),
  ).toThrow(ObligationDuplicateError);
  // A different obligee party with the same kind and subject is a different
  // wait, not a duplicate.
  const other = announce(store, { subject: "same", obligee: ALICE });
  expect(other.id).not.toBe(first.id);
  expect(() =>
    announce(store, {
      obligee: { ...planObligee, role: { ...planObligee.role } },
      subject: "same",
    }),
  ).toThrow(ObligationDuplicateError);
  // A different kind on the same party and subject is also a different wait.
  expect(
    announce(store, {
      obligee: ALICE,
      subject: "same",
      kind: "external_fix",
    }).id,
  ).not.toBe(other.id);
});

test("ObligorMayContest: system and role obligors have no contest path", () => {
  const { store } = makeStore([ALICE.sessionId], () => "bob");
  const systemWait = announce(store, {
    obligor: WEFT,
    subject: "job-1",
    kind: "job_completion",
  });
  const roleWait = announce(store, {
    obligor: {
      kind: "role",
      role: { kind: "component_owner", component: "agent-mail" },
      label: "owner of agent-mail",
    },
    subject: "am17",
    kind: "external_fix",
  });
  for (const record of [systemWait, roleWait]) {
    expect(() => store.contest(record.id, "user", "no", { now: T1 })).toThrow(
      ObligationAuthorityError,
    );
    expect(() =>
      store.contest(record.id, { sessionId: ALICE.sessionId }, "no", {
        now: T1,
      }),
    ).toThrow(ObligationAuthorityError);
    expect(store.get(record.id)?.contested).toBe(false);
    // The only paths left are the obligee's withdrawal and authority.
    const cleared = store.authorityClear(record.id, "oliver", "obsolete", {
      now: T1,
    });
    expect(cleared.closedBy).toBe("user_authority");
  }
});

test("role and system ends are never adoption candidates", () => {
  const helper = makeStore(
    [ALICE.sessionId, BOB.sessionId, CAROL.sessionId, DAVE.sessionId],
    () => "bob",
  );
  const store = helper.store;
  const roleObligorParty = {
    kind: "role" as const,
    role: { kind: "component_owner" as const, component: "agent-mail" },
    label: "owner of agent-mail",
  };
  // The predecessor is the session obligee, the obligor a role: the record
  // transfers because Alice is its obligee, but the role END does not move —
  // the responsibility re-resolves on its own.
  const owedViaRole = announce(store, {
    subject: "am17",
    kind: "external_fix",
    obligor: roleObligorParty,
  });
  // Named by the predecessor as session obligor: moves even though the
  // obligee is an artifact role.
  const roleObligee = announce(store, {
    obligee: {
      kind: "role",
      role: { kind: "plan_executor", plan: "/tmp/p/reindex" },
      label: "executor of /tmp/p/reindex",
    },
    obligor: {
      kind: "session",
      sessionId: ALICE.sessionId,
      label: ALICE.label,
    },
    subject: "reindex-review",
  });
  // Neither end names a session: never a candidate, however long it waits.
  const systemEnds = announce(store, {
    obligee: {
      kind: "role",
      role: { kind: "experiment_claimer", experiment: "EXP-042" },
      label: "claimer of EXP-042",
    },
    obligor: WEFT,
    subject: "job-3",
    kind: "job_completion",
  });
  helper.setLive(ALICE.sessionId, false);
  const moved = store.adopt(
    {
      adopter: DAVE,
      predecessorSessionId: ALICE.sessionId,
      succession: { kind: "resume-id", resumeId: ALICE.sessionId },
    },
    { now: T1 },
  );
  expect(moved.map((o) => o.id).sort()).toEqual(
    [owedViaRole.id, roleObligee.id].sort(),
  );
  // The session end moved to the adopter; the role end is untouched.
  expect(store.get(owedViaRole.id)?.obligee).toEqual(DAVE);
  expect(store.get(owedViaRole.id)?.obligor).toEqual(roleObligorParty);
  expect(store.get(roleObligee.id)?.obligor).toEqual({
    kind: "session",
    sessionId: DAVE.sessionId,
    label: DAVE.label,
  });
  // Role and system ends never transfer: adoption transfers debts between
  // sessions, it never re-points a responsibility or an integration.
  expect(store.get(systemEnds.id)?.status).toBe("open");
  expect(store.get(systemEnds.id)?.obligee.kind).toBe("role");
  expect(store.get(systemEnds.id)?.obligor).toEqual(WEFT);
});

test("legacy on-disk records normalize to parties and keep loading", () => {
  const { store, root } = makeStore([ALICE.sessionId]);
  const legacy = {
    version: 1,
    id: "ob-legacy1",
    createdAt: T0,
    obligee: { sessionId: "alice", label: "Alice" },
    obligor: { kind: "human", label: "user" },
    kind: "decision",
    subject: "pick the deploy window",
    status: "open",
    contested: false,
    revision: 3,
  };
  const recordPath = join(root, "ob-legacy1.json");
  writeFileSync(recordPath, `${JSON.stringify(legacy, null, 2)}\n`);
  const loaded = store.get("ob-legacy1");
  expect(loaded?.obligee).toEqual({
    kind: "session",
    sessionId: "alice",
    label: "Alice",
  });
  expect(loaded?.obligor).toEqual({ kind: "human", label: "user" });
  expect(loaded?.description).toBeUndefined();
  const describedLegacy = store.update("ob-legacy1", ALICE, {
    description: "The release freeze prevents a routine deploy.",
  });
  expect(describedLegacy.subject).toBe(legacy.subject);
  expect(store.get("ob-legacy1")?.description).toBe(
    "The release freeze prevents a routine deploy.",
  );
  // The duplicate key sees the normalized party, so re-announcing the same
  // triple is still refused after the migration read.
  expect(() =>
    store.announce(
      {
        obligee: ALICE,
        obligor: HUMAN,
        kind: "decision",
        subject: "pick the deploy window",
      },
      { now: T0 },
    ),
  ).toThrow(ObligationDuplicateError);
  // A legacy session obligor reads as a session party and settles normally.
  const legacySessionObligor = {
    ...legacy,
    id: "ob-legacy2",
    obligor: { kind: "session", sessionId: "bob", label: "Bob" },
  };
  writeFileSync(
    join(root, "ob-legacy2.json"),
    `${JSON.stringify(legacySessionObligor, null, 2)}\n`,
  );
  const rewritten = store.withdraw("ob-legacy2", ALICE, { now: T1 });
  expect(rewritten.status).toBe("withdrawn");
  expect(rewritten.version).toBe(2);
  // The next write persists the current shape.
  const persisted = JSON.parse(
    readFileSync(join(root, "ob-legacy2.json"), "utf8"),
  ) as Obligation;
  expect(persisted.version).toBe(2);
  // Withdrawal is obligee-only: the legacy session obligor survives as a
  // normalized session party, untouched.
  expect(persisted.obligor).toEqual({
    kind: "session",
    sessionId: "bob",
    label: "Bob",
  });
  expect(persisted.obligee).toEqual({
    kind: "session",
    sessionId: ALICE.sessionId,
    label: ALICE.label,
  });
});

test("views render a role obligor's resolution provenance, or unresolvable", () => {
  // The resolver answers at read time: the same record renders resolved
  // while the role has a holder and unresolvable once it does not.
  let holder: string | undefined = "bob";
  const { store } = makeStore([ALICE.sessionId], () => holder);
  const record = announce(store, {
    obligor: {
      kind: "role",
      role: { kind: "component_owner", component: "agent-mail" },
      label: "owner of agent-mail",
    },
    kind: "external_fix",
    subject: "am17",
  });
  expect(store.describeObligor(record)).toBe("owner of agent-mail → bob");
  holder = undefined;
  expect(store.describeObligor(record)).toBe(
    "owner of agent-mail (unresolvable: owner of agent-mail resolves to no single responsible session)",
  );
  // Session and human obligors render as they always did.
  expect(store.describeObligor(announce(store, { subject: "s2" }))).toBe(
    "user",
  );
});

// ---------------------------------------------------------------------------
// ObligeeCloses / ObligeeWithdraws
// ---------------------------------------------------------------------------

test("close satisfies with resolution, closer, timestamps, and retention", () => {
  const { store } = makeStore([ALICE.sessionId]);
  const record = announce(store);
  const closed = store.close(record.id, ALICE, "decided: glm", { now: T1 });
  expect(closed.status).toBe("satisfied");
  expect(closed.resolution).toBe("decided: glm");
  expect(closed.closedBy).toBe("obligee");
  expect(closed.closedAt).toBe(T1);
  expect(closed.retainedUntil).toBeDefined();
  expect(Date.parse(closed.retainedUntil ?? "") - Date.parse(T1)).toBe(
    TERMINAL_RETENTION_MS,
  );
});

test("terminal pruning retains open and unexpired records and removes expired evidence", () => {
  const { store } = makeStore([ALICE.sessionId]);
  const expired = announce(store, {
    kind: "external_fix",
    subject: "issue am22",
  });
  store.observeRef(expired.id, "unresolvable", { now: T0 });
  store.close(expired.id, ALICE, undefined, { now: T1 });
  const open = announce(store, { subject: "still owed" });
  const recent = announce(store, { subject: "recently settled" });
  const expiry = Date.parse(T1) + TERMINAL_RETENTION_MS;
  store.close(recent.id, ALICE, undefined, {
    now: new Date(expiry + 1).toISOString(),
  });

  expect(store.pruneTerminal(expiry - 1)).toBe(0);
  expect(store.get(expired.id)).toBeDefined();
  expect(store.pruneTerminal(expiry)).toBe(1);
  expect(store.get(expired.id)).toBeUndefined();
  expect(store.latestRef(expired.id)).toBeUndefined();
  expect(store.get(open.id)?.status).toBe("open");
  expect(store.get(recent.id)?.status).toBe("satisfied");
  expect(store.pruneTerminal(expiry + 1)).toBe(0);
});

test("withdraw closes without a resolution field", () => {
  const { store } = makeStore([ALICE.sessionId]);
  const record = announce(store);
  const closed = store.withdraw(record.id, ALICE, { now: T1 });
  expect(closed.status).toBe("withdrawn");
  expect(closed.closedBy).toBe("obligee");
  expect("resolution" in closed).toBe(false);
});

test("close is refused for a non-obligee actor, an offline actor, or a closed record", () => {
  const helper = makeStore([ALICE.sessionId, BOB.sessionId]);
  const record = announce(helper.store);
  expect(() =>
    helper.store.close(record.id, BOB, undefined, { now: T1 }),
  ).toThrow(ObligationAuthorityError);
  helper.setLive(ALICE.sessionId, false);
  expect(() =>
    helper.store.close(record.id, ALICE, undefined, { now: T1 }),
  ).toThrow(ObligationAuthorityError);
  helper.setLive(ALICE.sessionId, true);
  const withdrawn = helper.store.withdraw(record.id, ALICE, { now: T1 });
  expect(() =>
    helper.store.close(withdrawn.id, ALICE, undefined, { now: T1 }),
  ).toThrow(ObligationStateError);
});

test("withdraw is refused for a non-obligee actor", () => {
  const { store } = makeStore([ALICE.sessionId, BOB.sessionId]);
  const record = announce(store);
  expect(() => store.withdraw(record.id, BOB, { now: T1 })).toThrow(
    ObligationAuthorityError,
  );
});

// ---------------------------------------------------------------------------
// ClaimReleaseSettles
// ---------------------------------------------------------------------------

test("a claim release settles only open claim-release obligations on that claim", () => {
  const { store } = makeStore([ALICE.sessionId, CAROL.sessionId]);
  const matching = announce(store, {
    kind: "claim_release",
    subject: "am-123",
  });
  const otherClaim = announce(store, {
    kind: "claim_release",
    subject: "am-456",
  });
  // A decision on the same claim is a different triple and is untouched.
  const decision = announce(store, { kind: "decision", subject: "am-123" });

  const settled = store.settleReleasedClaim("am-123", { now: T1 });
  expect(settled.map((o) => o.id)).toEqual([matching.id]);
  expect(settled[0].closedBy).toBe("system");
  expect(settled[0].closedAt).toBe(T1);
  expect(settled[0].retainedUntil).toBeDefined();
  expect(Date.parse(settled[0].retainedUntil ?? "") - Date.parse(T1)).toBe(
    TERMINAL_RETENTION_MS,
  );
  expect(store.get(otherClaim.id)?.status).toBe("open");
  expect(store.get(decision.id)?.status).toBe("open");
  // Settlement is idempotent: a second pass settles nothing further.
  expect(store.settleReleasedClaim("am-123", { now: T1 })).toEqual([]);
});

// ---------------------------------------------------------------------------
// ObligorContests
// ---------------------------------------------------------------------------

test("the named session obligor contests; contest never closes", () => {
  const { store } = makeStore([ALICE.sessionId, BOB.sessionId]);
  const record = announce(store, { obligor: SESSION_OBLIGOR });
  const contested = store.contest(record.id, BOB, "already answered in mail", {
    now: T1,
  });
  expect(contested.contested).toBe(true);
  expect(contested.contestedAt).toBe(T1);
  expect(contested.contestReason).toBe("already answered in mail");
  expect(contested.status).toBe("open");
});

test("the operator contests an obligation naming the human", () => {
  const { store } = makeStore([ALICE.sessionId]);
  const record = announce(store, { obligor: HUMAN });
  const contested = store.contest(record.id, "user", "never asked me", {
    now: T1,
  });
  expect(contested.contested).toBe(true);
});

test("contest is refused for the wrong actor, a closed record, or a second contest", () => {
  const { store } = makeStore([
    ALICE.sessionId,
    BOB.sessionId,
    CAROL.sessionId,
  ]);
  const sessionObligation = announce(store, { obligor: SESSION_OBLIGOR });
  expect(() =>
    store.contest(sessionObligation.id, CAROL, "no", { now: T1 }),
  ).toThrow(ObligationAuthorityError);
  expect(() =>
    store.contest(sessionObligation.id, "user", "no", { now: T1 }),
  ).toThrow(ObligationAuthorityError);
  const humanObligation = announce(store, { subject: "s-human" });
  expect(() =>
    store.contest(humanObligation.id, BOB, "no", { now: T1 }),
  ).toThrow(ObligationAuthorityError);
  store.contest(humanObligation.id, "user", "first", { now: T1 });
  expect(() =>
    store.contest(humanObligation.id, "user", "second", { now: T1 }),
  ).toThrow(ObligationStateError);
  store.withdraw(humanObligation.id, ALICE, { now: T1 });
  expect(() =>
    store.contest(humanObligation.id, "user", "again", { now: T1 }),
  ).toThrow(ObligationStateError);
});

// ---------------------------------------------------------------------------
// AuthorityClears
// ---------------------------------------------------------------------------

test("user authority withdraws with recorded provenance and is refused without authority", () => {
  const { store } = makeStore([ALICE.sessionId]);
  const record = announce(store);
  expect(() =>
    store.authorityClear(record.id, "  ", "reason", { now: T1 }),
  ).toThrow(/authority/);
  const cleared = store.authorityClear(record.id, "oliver", "obsolete ask", {
    now: T1,
  });
  expect(cleared.status).toBe("withdrawn");
  expect(cleared.closedBy).toBe("user_authority");
  // Recorded, never verified: the declaring authority and reason persist.
  expect(cleared.authority).toBe("oliver");
  expect(cleared.authorityReason).toBe("obsolete ask");
  // Terminal: no outbound transitions remain.
  expect(["satisfied", "withdrawn"]).toContain(cleared.status);
});

// ---------------------------------------------------------------------------
// SessionAdoptsObligations — both roles, atomic
// ---------------------------------------------------------------------------

function seedForAdoption(store: ObligationStore) {
  const owed = announce(store, {
    obligor: SESSION_OBLIGOR,
    subject: "owed-decision",
  });
  const debt = store.announce(
    {
      obligee: CAROL,
      obligor: {
        kind: "session",
        sessionId: ALICE.sessionId,
        label: ALICE.label,
      },
      kind: "external_fix",
      subject: "am17",
    },
    { now: T0 },
  );
  const terminal = announce(store, { subject: "already-withdrawn" });
  store.withdraw(terminal.id, ALICE, { now: T0 });
  const unrelated = announce(store, {
    obligee: CAROL,
    subject: "carol-keeps-this",
  });
  return { owed, debt, terminal, unrelated };
}

test("adoption transfers both roles atomically and stamps provenance", () => {
  const helper = makeStore([
    ALICE.sessionId,
    BOB.sessionId,
    CAROL.sessionId,
    DAVE.sessionId,
  ]);
  const store = helper.store;
  const seeded = seedForAdoption(store);
  store.contest(seeded.owed.id, BOB, "disputed", { now: T0 });
  // Succession requires an offline predecessor; seeding needed it live.
  helper.setLive(ALICE.sessionId, false);

  const moved = store.adopt(
    {
      adopter: DAVE,
      predecessorSessionId: ALICE.sessionId,
      succession: { kind: "resume-id", resumeId: ALICE.sessionId },
    },
    { now: T1 },
  );
  expect(moved.length).toBe(2);
  for (const record of moved) {
    expect(record.adoptedFrom).toBe(ALICE.sessionId);
    expect(record.adoptedAt).toBe(T1);
  }
  const adoptedOwed = store.get(seeded.owed.id);
  expect(adoptedOwed?.obligee).toEqual(DAVE);
  expect(adoptedOwed?.contested).toBe(true);
  const adoptedDebt = store.get(seeded.debt.id);
  expect(adoptedDebt?.obligor).toEqual({
    kind: "session",
    sessionId: DAVE.sessionId,
    label: DAVE.label,
  });
  // Terminal records never transfer; unrelated records are untouched.
  expect(store.get(seeded.terminal.id)?.obligee).toEqual(ALICE);
  expect(store.get(seeded.unrelated.id)?.obligee).toEqual(CAROL);
  // AdoptionIsAtomic: no open record still names the predecessor in either role.
  for (const record of store.listOpen()) {
    const namesPredecessor =
      (record.obligee.kind === "session" &&
        record.obligee.sessionId === ALICE.sessionId) ||
      (record.obligor.kind === "session" &&
        record.obligor.sessionId === ALICE.sessionId);
    expect(namesPredecessor).toBe(false);
  }
});

test("adoption succeeds via declared authority when no resume id exists", () => {
  const helper = makeStore([
    ALICE.sessionId,
    BOB.sessionId,
    CAROL.sessionId,
    DAVE.sessionId,
  ]);
  const store = helper.store;
  seedForAdoption(store);
  helper.setLive(ALICE.sessionId, false);
  const moved = store.adopt(
    {
      adopter: DAVE,
      predecessorSessionId: ALICE.sessionId,
      succession: { kind: "authority", authority: "oliver", reason: "resume" },
    },
    { now: T1 },
  );
  expect(moved.length).toBe(2);
  for (const record of moved) {
    expect(record.adoptedAuthority).toBe("oliver");
  }
});

test("adoption is refused without evidence, against a live predecessor, by itself, or by an offline adopter", () => {
  const helper = makeStore([
    ALICE.sessionId,
    BOB.sessionId,
    CAROL.sessionId,
    DAVE.sessionId,
  ]);
  const store = helper.store;
  seedForAdoption(store);
  const adoptArgs = {
    adopter: DAVE,
    predecessorSessionId: ALICE.sessionId,
  };
  // The resume id must name the predecessor: evidence, not assertion.
  expect(() =>
    store.adopt(
      {
        ...adoptArgs,
        succession: { kind: "resume-id", resumeId: "someone-else" },
      },
      { now: T1 },
    ),
  ).toThrow(ObligationAuthorityError);
  // A session cannot adopt its own obligations.
  expect(() =>
    store.adopt(
      {
        ...adoptArgs,
        adopter: ALICE,
        succession: { kind: "resume-id", resumeId: ALICE.sessionId },
      },
      { now: T1 },
    ),
  ).toThrow(ObligationAuthorityError);
  // The predecessor must be offline.
  expect(() =>
    store.adopt(
      {
        ...adoptArgs,
        succession: { kind: "resume-id", resumeId: ALICE.sessionId },
      },
      { now: T1 },
    ),
  ).toThrow(ObligationAuthorityError);
  // The adopter must be live.
  helper.setLive(DAVE.sessionId, false);
  helper.setLive(ALICE.sessionId, false);
  expect(() =>
    store.adopt(
      {
        ...adoptArgs,
        succession: { kind: "resume-id", resumeId: ALICE.sessionId },
      },
      { now: T1 },
    ),
  ).toThrow(ObligationAuthorityError);
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

test("OneOpenPerSubject: no two open records share obligee, kind, and subject", () => {
  const { store } = makeStore([
    ALICE.sessionId,
    BOB.sessionId,
    CAROL.sessionId,
  ]);
  const subjects = ["s-1", "s-2", "s-3", "s-4"];
  for (const subject of subjects) announce(store, { subject });
  const open = store.listOpen();
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const sameSubject =
        partyKey(open[i].obligee) === partyKey(open[j].obligee) &&
        open[i].kind === open[j].kind &&
        open[i].subject === open[j].subject;
      expect(sameSubject).toBe(false);
    }
  }
  fc.assert(
    fc.property(
      fc.constantFrom("decision", "claim_release", "external_fix"),
      fc.constantFrom(...subjects),
      fc.constantFrom("alice", "carol"),
      (kind, subject, obligeeId) => {
        const obligee = obligeeId === "alice" ? ALICE : CAROL;
        // Every open triple admits exactly one record; the second announce
        // must fail rather than grow a duplicate.
        try {
          store.announce(
            { obligee, obligor: HUMAN, kind: kind as never, subject },
            { now: T0 },
          );
          const duplicates = store
            .listOpen()
            .filter(
              (o) =>
                o.obligee.kind === "session" &&
                obligee.kind === "session" &&
                o.obligee.sessionId === obligee.sessionId &&
                o.kind === kind &&
                o.subject === subject,
            );
          expect(duplicates.length).toBe(1);
        } catch (error) {
          expect(error instanceof ObligationDuplicateError).toBe(true);
        }
      },
    ),
    { numRuns: 25 },
  );
});

test("ContestedStaysVisible and HumanOwedIsComplete: listings keep contested and human-owed rows", () => {
  const { store } = makeStore([ALICE.sessionId, BOB.sessionId]);
  const sessionObligation = announce(store, {
    obligor: SESSION_OBLIGOR,
    subject: "s1",
  });
  store.contest(sessionObligation.id, BOB, "already done", { now: T1 });
  const humanObligation = announce(store, { subject: "s2" });
  const open = store.listOpen();
  expect(open.find((o) => o.id === sessionObligation.id)?.contested).toBe(true);
  expect(open.find((o) => o.id === sessionObligation.id)?.contestReason).toBe(
    "already done",
  );
  expect(store.owedToHuman().map((o) => o.id)).toContain(humanObligation.id);
});

test("UnresolvableRefIsVisible: an unresolvable reference is a listed diagnostic", () => {
  const { store } = makeStore([ALICE.sessionId]);
  const record = announce(store, { kind: "external_fix", subject: "am17" });
  expect(store.unresolvableRefs().length).toBe(0);
  store.observeRef(record.id, "unresolvable", { now: T1 });
  const diagnostics = store.unresolvableRefs();
  expect(diagnostics.length).toBe(1);
  expect(diagnostics[0].obligation.id).toBe(record.id);
  expect(diagnostics[0].observation.state).toBe("unresolvable");
  // Observation never mutates the obligation.
  expect(store.get(record.id)?.status).toBe("open");
  // A later observation replaces the latest; resolution clears the diagnostic.
  store.observeRef(record.id, "resolves", { now: T1, issueId: "am17" });
  expect(store.unresolvableRefs().length).toBe(0);
  expect(store.latestRef(record.id)?.state).toBe("resolves");
  expect(store.latestRef(record.id)?.issueId).toBe("am17");
});

test("ref observations are refused on records that are not open external-fix", () => {
  const { store } = makeStore([ALICE.sessionId]);
  const decision = announce(store, { subject: "s1" });
  expect(() => store.observeRef(decision.id, "resolves", { now: T1 })).toThrow(
    ObligationStateError,
  );
  const external = announce(store, { kind: "external_fix", subject: "am17" });
  store.withdraw(external.id, ALICE, { now: T1 });
  expect(() => store.observeRef(external.id, "resolves", { now: T1 })).toThrow(
    ObligationStateError,
  );
});

// ---------------------------------------------------------------------------
// Cross-module: role resolution through the real integrations
// ---------------------------------------------------------------------------

test("the wired resolver resolves component owner, plan executor, and experiment claimer", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-obligations-resolve-"));
  temporaryDirectories.push(root);
  // A component name that cannot collide with a cwd-relative directory:
  // resolution matches it against live registrations by basename.
  const project = join(root, "resolve-component");
  mkdirSync(project, { recursive: true });
  // One live session in the project: the sole live session is the inferred
  // project owner, the plan's executor, and the experiment's claimer.
  register(project, process.ppid, "owner-session");
  const owner = {
    id: "owner-session",
    label: "Owner",
    kind: "session" as const,
    sessionId: "owner-session",
    // Claim release compares owner process identity, not just the id.
    pid: process.ppid,
    procStart: "fixed-for-test",
  };

  expect(
    resolveObligationRole({
      kind: "component_owner",
      component: "resolve-component",
    }),
  ).toBe("owner-session");
  // A component that matches no project resolves to nothing.
  expect(
    resolveObligationRole({
      kind: "component_owner",
      component: "no-such-component",
    }),
  ).toBeUndefined();

  const lease = work.acquire(
    project,
    {
      type: "research-plan",
      key: "reindex",
      label: "reindex",
    },
    owner,
  );
  expect(
    resolveObligationRole({
      kind: "plan_executor",
      plan: `${project}/reindex`,
    }),
  ).toBe("owner-session");
  work.release(project, lease.id, owner.id);

  mkdirSync(join(project, "lab-notebook", "experiments"), {
    recursive: true,
  });
  const claim = claims.claimExperiment(
    project,
    join(project, "lab-notebook"),
    owner,
  );
  expect(
    resolveObligationRole({
      kind: "experiment_claimer",
      experiment: claim.experimentId,
    }),
  ).toBe("owner-session");
  claims.release({ claimId: claim.id, actor: owner });
});

// ---------------------------------------------------------------------------
// Cross-module: a claim release settles its waiters (ClaimReleaseSettles)
// ---------------------------------------------------------------------------

test("releasing a path claim settles the obligation waiting on it", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-obligations-e2e-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const { store } = makeStore([ALICE.sessionId, BOB.sessionId]);
  const claimStore = new ClaimStore(join(root, "claims"), (claimId, at) =>
    store.settleReleasedClaim(claimId, { now: at }),
  );

  const bobOwner = { id: "bob", label: "Bob", sessionId: BOB.sessionId };
  const acquisition = claimStore.claimPaths(
    project,
    [{ path: join(project, "reports"), pathType: "directory" }],
    bobOwner,
  );
  // Alice waits on the claim Bob holds; Bob releases it.
  const waiting = store.announce(
    {
      obligee: ALICE,
      obligor: { kind: "session", sessionId: BOB.sessionId, label: "Bob" },
      kind: "claim_release",
      subject: acquisition.claim.id,
    },
    { now: T0 },
  );
  expect(waiting.status).toBe("open");

  const result = claimStore.release({
    claimId: acquisition.claim.id,
    actor: bobOwner,
    now: new Date(T1),
  });
  expect(result.disposition).toBe("released");

  const settled = store.get(waiting.id);
  expect(settled?.status).toBe("satisfied");
  expect(settled?.closedBy).toBe("system");
  expect(settled?.closedAt).toBe(T1);
});

test("recovering and cleaning up experiment claims settle their waiting obligations", () => {
  const root = mkdtempSync(
    join(tmpdir(), "agent-mail-obligations-experiments-"),
  );
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const notebook = join(project, "lab-notebook");
  mkdirSync(join(notebook, "experiments"), { recursive: true });
  const { store } = makeStore([ALICE.sessionId, BOB.sessionId]);
  const claimStore = new ClaimStore(join(root, "claims"), (claimId, at) =>
    store.settleReleasedClaim(claimId, { now: at }),
  );
  const owner = { id: "bob", label: "Bob", sessionId: BOB.sessionId };
  const recoveredClaim = claimStore.claimExperiment(project, notebook, owner);
  const cleanedClaim = claimStore.claimExperiment(project, notebook, owner);
  const recoveredWait = announce(store, {
    kind: "claim_release",
    subject: recoveredClaim.id,
    obligor: BOB,
  });
  const cleanedWait = announce(store, {
    kind: "claim_release",
    subject: cleanedClaim.id,
    obligor: BOB,
  });

  claimStore.recover(project, recoveredClaim.id, () => false, { at: T1 });
  expect(store.get(recoveredWait.id)).toMatchObject({
    status: "satisfied",
    closedBy: "system",
    closedAt: T1,
  });
  expect(store.get(cleanedWait.id)?.status).toBe("open");

  expect(claimStore.releaseOwner(project, owner.id)).toBe(1);
  expect(store.get(cleanedWait.id)).toMatchObject({
    status: "satisfied",
    closedBy: "system",
  });
  expect(claimStore.list(project)).toEqual([]);
});

// ---------------------------------------------------------------------------
// Options, markers, comments, and in-place amendment
// ---------------------------------------------------------------------------

test("announce stores options and typed markers, canonicalizing paths against the base directory", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-obligations-markers-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  const { store } = makeStore([ALICE.sessionId, BOB.sessionId]);
  const record = store.announce(
    {
      obligee: ALICE,
      obligor: BOB,
      kind: "decision",
      subject: "pick the interval qualifier",
      options: ["alpha-relative", "cluster-aware"],
      markers: [
        { type: "path", value: "docs/notes.md", label: "background" },
        { type: "label", value: "EXP-042:E2" },
      ],
    },
    { now: T0, baseDir: root },
  );
  expect(record.options).toEqual(["alpha-relative", "cluster-aware"]);
  expect(record.markers?.[0].type).toBe("path");
  expect(record.markers?.[0].value).toBe(join(root, "docs", "notes.md"));
  expect(record.markers?.[0].label).toBe("background");
  expect(record.markers?.[1]).toEqual({ type: "label", value: "EXP-042:E2" });
});

test("updating markers refuses unknown types instead of converting them to paths", () => {
  const { store } = makeStore([ALICE.sessionId]);
  const record = announce(store, { subject: "marker type" });
  const invalid = {
    type: "url",
    value: "https://example.com",
  } as unknown as ObligationMarker;
  expect(() => store.update(record.id, ALICE, { markers: [invalid] })).toThrow(
    /marker type must be path or label/,
  );
  expect(store.get(record.id)?.markers).toBeUndefined();
});

test("announce refuses a one-choice options list", () => {
  const { store } = makeStore([ALICE.sessionId]);
  expect(() =>
    store.announce(
      {
        obligee: ALICE,
        obligor: HUMAN,
        kind: "decision",
        subject: "pick",
        options: ["only one"],
      },
      { now: T0 },
    ),
  ).toThrow(/at least two/);
});

test("announce normalizes choices and refuses blank choices", () => {
  const { store } = makeStore([ALICE.sessionId]);
  expect(() =>
    store.announce(
      {
        obligee: ALICE,
        obligor: HUMAN,
        kind: "decision",
        subject: "choose",
        options: ["one", "  "],
      },
      { now: T0 },
    ),
  ).toThrow(/option must not be empty/);
  expect(store.list()).toEqual([]);
  const record = store.announce(
    {
      obligee: ALICE,
      obligor: HUMAN,
      kind: "decision",
      subject: "choose",
      options: [" first ", "second"],
    },
    { now: T0 },
  );
  expect(record.options).toEqual(["first", "second"]);
});

test("update amends options and markers in place, clearing with null; options stay editable", () => {
  const { store } = makeStore([ALICE.sessionId]);
  const record = announce(store, { subject: "amend me" });
  const first = store.update(record.id, ALICE, {
    options: ["option one", "option two"],
  });
  expect(first.options).toEqual(["option one", "option two"]);
  const second = store.update(record.id, ALICE, {
    options: ["option one", "option two", "option three"],
  });
  expect(second.options).toEqual(["option one", "option two", "option three"]);
  const cleared = store.update(record.id, ALICE, { options: null });
  expect(cleared.options).toBeUndefined();
  expect(() => store.update(record.id, ALICE, { options: ["solo"] })).toThrow(
    /at least two/,
  );
  const withMarkers = store.update(record.id, ALICE, {
    markers: [{ type: "label", value: "C041", label: "the claim" }],
  });
  expect(withMarkers.markers).toEqual([
    { type: "label", value: "C041", label: "the claim" },
  ]);
});

test("decision descriptions retain multiline context and amend without changing identity", () => {
  const { store } = makeStore([ALICE.sessionId, BOB.sessionId]);
  const description = `Finding: ${"the evidence differs by condition. ".repeat(20)}\nSettled: the registered claim stays fixed.`;
  expect(description.length).toBeGreaterThan(500);
  const record = store.announce(
    {
      obligee: ALICE,
      obligor: BOB,
      kind: "decision",
      subject: "Disposition of F1834",
      description: `  ${description}  `,
    },
    { now: T0 },
  );
  expect(record.description).toBe(description);
  expect(store.get(record.id)?.description).toBe(description);

  const revised = store.update(record.id, ALICE, {
    description:
      "Finding: corrected evidence.\nSettled: the claim stays fixed.",
  });
  expect(revised.subject).toBe(record.subject);
  expect(revised.id).toBe(record.id);
  expect(store.get(record.id)?.description).toBe(revised.description);
  expect(() =>
    store.update(record.id, BOB, { description: "not the obligee" }),
  ).toThrow(ObligationAuthorityError);
  expect(() => store.update(record.id, ALICE, { description: " \n " })).toThrow(
    /description must not be empty/,
  );
  expect(store.get(record.id)?.description).toBe(revised.description);

  store.update(record.id, ALICE, { description: null });
  expect(store.get(record.id)?.description).toBeUndefined();
});

test("update is obligee-only and refused on terminal records", () => {
  const { store } = makeStore([ALICE.sessionId, BOB.sessionId]);
  const record = announce(store, { subject: "guard" });
  expect(() => store.update(record.id, BOB, { options: ["a", "b"] })).toThrow(
    ObligationAuthorityError,
  );
  store.close(record.id, ALICE, "done", { now: T1 });
  expect(() =>
    store.update(record.id, ALICE, {
      markers: [{ type: "label", value: "C1" }],
    }),
  ).toThrow(ObligationStateError);
});

test("comments append with author and kind, ordered; refused on terminal records", () => {
  const { store } = makeStore([ALICE.sessionId, BOB.sessionId]);
  const record = announce(store, { subject: "notes" });
  const first = store.comment(record.id, ALICE, "recommend option two", {
    now: T0,
  });
  expect(first.comments).toEqual([
    {
      author: "Alice",
      authorKind: "session",
      at: T0,
      text: "recommend option two",
    },
  ]);
  const second = store.comment(record.id, "user", "noted", { now: T1 });
  expect(second.comments?.length).toBe(2);
  expect(second.comments?.[1].authorKind).toBe("human");
  expect(second.status).toBe("open");
  store.close(record.id, ALICE, "done", { now: T1 });
  expect(() => store.comment(record.id, ALICE, "late", { now: T1 })).toThrow(
    ObligationStateError,
  );
});

test("closing with free-text resolution is not bound to the declared options", () => {
  const { store } = makeStore([ALICE.sessionId]);
  const record = announce(store, { subject: "decide" });
  store.update(record.id, ALICE, { options: ["a", "b"] });
  const closed = store.close(record.id, ALICE, "a hybrid of both", { now: T1 });
  expect(closed.resolution).toBe("a hybrid of both");
});

test("comment is refused for a session that is not a party to the record", () => {
  const { store } = makeStore([
    ALICE.sessionId,
    BOB.sessionId,
    CAROL.sessionId,
  ]);
  const record = announce(store, {
    obligor: SESSION_OBLIGOR,
    subject: "notes",
  });
  expect(() =>
    store.comment(record.id, CAROL, "not mine", { now: T0 }),
  ).toThrow(ObligationAuthorityError);
  // The obligee and the obligor may comment.
  store.comment(record.id, ALICE, "obligee note", { now: T0 });
  store.comment(record.id, BOB, "obligor note", { now: T0 });
  const after = store.get(record.id);
  expect(after?.comments?.length).toBe(2);
});

test("a role obligor's current responsible session may comment after handoff", () => {
  let holder: string | undefined = BOB.sessionId;
  const { store } = makeStore(
    [ALICE.sessionId, BOB.sessionId, CAROL.sessionId],
    () => holder,
  );
  const record = announce(store, {
    obligor: {
      kind: "role",
      role: { kind: "component_owner", component: "agent-mail" },
      label: "owner of agent-mail",
    },
    subject: "fix am22",
  });
  expect(() => store.comment(record.id, CAROL, "not the owner")).toThrow(
    ObligationAuthorityError,
  );
  store.comment(record.id, BOB, "investigating");
  holder = CAROL.sessionId;
  expect(() => store.comment(record.id, BOB, "former owner")).toThrow(
    ObligationAuthorityError,
  );
  expect(
    store.comment(record.id, CAROL, "fixed").comments?.at(-1),
  ).toMatchObject({
    author: CAROL.label,
    authorKind: "session",
    text: "fixed",
  });
  holder = undefined;
  expect(() => store.comment(record.id, CAROL, "unassigned")).toThrow(
    ObligationAuthorityError,
  );
});

test("a role obligee's resolved session may comment", () => {
  const { store } = makeStore([ALICE.sessionId], () => ALICE.sessionId);
  const record = store.announce(
    {
      obligee: {
        kind: "role",
        role: { kind: "experiment_claimer", experiment: "EXP-123" },
        label: "claimer of EXP-123",
      },
      obligor: HUMAN,
      kind: "decision",
      subject: "pick a method",
    },
    { now: T0 },
  );
  expect(
    store.comment(record.id, ALICE, "context", { now: T1 }).comments,
  ).toEqual([
    { author: "Alice", authorKind: "session", at: T1, text: "context" },
  ]);
});

test("a tilde path marker expands to the home directory", () => {
  const { store } = makeStore([ALICE.sessionId, BOB.sessionId]);
  const record = store.announce(
    {
      obligee: ALICE,
      obligor: BOB,
      kind: "decision",
      subject: "tilde marker",
      markers: [{ type: "path", value: "~/notes/background.md" }],
    },
    { now: T0 },
  );
  expect(record.markers?.[0].value).toBe(
    join(process.env.HOME ?? "", "notes", "background.md"),
  );
});
