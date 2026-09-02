import { beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOUNS } from "./nameWords.ts";
import {
  RECENT_NOUN_USE_MS,
  SESSION_NAME_LOCK_WAIT_MS,
  activityTag,
  adjectiveNounSessionName,
  assignedGeneratedSessionName,
  formatAge,
  generatedNameNoun,
  isStaleSession,
  lastActivityMs,
  legacyGeneratedSessionName,
  matchSessions,
  resetSessionAliasCache,
  resolveSessionQuery,
  resumeIdFromCommand,
  sessionDisplayName,
  sessionFullName,
  sessionIdFromEnv,
  sessionIdFromHostEnviron,
  sessionNames,
} from "./sessions.ts";

const SID = "1ed87600-aaaa-bbbb-cccc-000000000000";
const CWD = "/Users/x/code/mental-spaces";
const LEGACY = legacyGeneratedSessionName(SID);

beforeEach(() => {
  process.env.AGENT_MAIL_SESSION_ALIASES = "";
  resetSessionAliasCache();
});

test("a deliberate /rename is kept verbatim", () => {
  expect(
    sessionFullName(SID, { name: "fix-auth-flow", nameSource: "user" }, CWD),
  ).toBe("fix-auth-flow");
});

test("a derived <base>-<hex> name becomes <base>-<readable-suffix>", () => {
  const label = sessionFullName(
    SID,
    { name: "mental-spaces-b4", nameSource: "derived" },
    CWD,
    LEGACY,
  );
  expect(label).toMatch(/^mental-spaces-[a-z]+$/);
  expect(label).not.toBe("mental-spaces-b4"); // hex suffix replaced
});

test("no Claude name still yields <base>-<readable-suffix>", () => {
  expect(sessionFullName(SID, undefined, CWD, LEGACY)).toMatch(
    /^mental-spaces-[a-z]+$/,
  );
});

test("absent nameSource: <base>-<2hex> shape is treated as derived", () => {
  // No nameSource, but the name matches Claude's auto pattern → transform.
  expect(
    sessionFullName(SID, { name: "mental-spaces-b4" }, CWD, LEGACY),
  ).not.toBe("mental-spaces-b4");
  // A name that does NOT match the auto pattern is kept as a rename.
  expect(sessionFullName(SID, { name: "my-custom-name" }, CWD)).toBe(
    "my-custom-name",
  );
});

test("explicit non-derived nameSource overrides the auto-pattern fallback", () => {
  // Even though "mental-spaces-b4" matches the pattern, a user source keeps it.
  expect(
    sessionFullName(SID, { name: "mental-spaces-b4", nameSource: "user" }, CWD),
  ).toBe("mental-spaces-b4");
});

test("the project base is mapped through the alias table", () => {
  process.env.AGENT_MAIL_SESSION_ALIASES = "mental-spaces=ms";
  resetSessionAliasCache();
  expect(sessionFullName(SID, undefined, CWD, LEGACY)).toMatch(/^ms-[a-z]+$/);
});

test("distinct sessions in one project get distinct suffixes", () => {
  const a = sessionFullName(
    "sid-aaaa",
    undefined,
    CWD,
    legacyGeneratedSessionName("sid-aaaa"),
  );
  const b = sessionFullName(
    "sid-bbbb",
    undefined,
    CWD,
    legacyGeneratedSessionName("sid-bbbb"),
  );
  expect(a).not.toBe(b);
});

test("legacy display names keep the current compact label", () => {
  const generated = sessionDisplayName(
    SID,
    { name: "mental-spaces-b4", nameSource: "derived" },
    CWD,
    LEGACY,
  );
  expect(sessionFullName(SID, undefined, CWD, LEGACY)).toBe(
    `mental-spaces-${generated}`,
  );
  expect(
    sessionDisplayName(SID, { name: "fix-auth-flow", nameSource: "user" }, CWD),
  ).toBe("fix-auth-flow");
});

test("new sessions get adjective-noun full and display names", () => {
  const generated = adjectiveNounSessionName(SID);
  const names = sessionNames(SID, undefined, CWD, generated);
  expect(names.fullName).toMatch(/^mental-spaces-[a-z]+-[a-z]+$/);
  expect(names.displayName).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  expect(names.fullName.endsWith(generated.slug)).toBe(true);
  expect(names.displayName).toBe(generated.displayName);
});

test("a persisted selection wins over a later requested scheme", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-mail-names-"));
  try {
    const legacy = assignedGeneratedSessionName(SID, true, directory);
    expect(assignedGeneratedSessionName(SID, false, directory)).toEqual(legacy);
    const [file] = readdirSync(directory);
    const stored = readFileSync(join(directory, file), "utf8");
    expect(stored).toContain('"scheme": "legacy-syllable"');
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("name minting outwaits the generic two-second transaction budget", async () => {
  expect(SESSION_NAME_LOCK_WAIT_MS).toBeGreaterThan(2_000);
  const root = mkdtempSync(join(tmpdir(), "agent-mail-name-lock-wait-"));
  const lockPath = join(root, ".mint.lock");
  const scriptPath = join(root, "holder.ts");
  const lockModule = join(process.cwd(), "src", "lock.ts");
  writeFileSync(
    scriptPath,
    `
      import { withFileLock } from ${JSON.stringify(lockModule)};
      withFileLock(process.argv[2], () => Bun.sleepSync(2100));
    `,
  );
  const holder = Bun.spawn(["bun", scriptPath, lockPath], {
    cwd: process.cwd(),
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    while (!existsSync(lockPath)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(
      assignedGeneratedSessionName("waited-for-peer", false, root),
    ).toMatchObject({ scheme: "adjective-noun" });
    await holder.exited;
  } finally {
    holder.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

function sessionWithPreferredNoun(noun: string, prefix: string): string {
  for (let index = 0; index < 10_000; index += 1) {
    const sessionId = `${prefix}-${index}`;
    if (generatedNameNoun(adjectiveNounSessionName(sessionId)) === noun) {
      return sessionId;
    }
  }
  throw new Error(`could not find a session id that prefers ${noun}`);
}

test("a newly minted name avoids a recently used noun", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-mail-names-"));
  const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
  try {
    const first = assignedGeneratedSessionName("first", false, directory, {
      nowMs,
    });
    const firstNoun = generatedNameNoun(first);
    if (!firstNoun) throw new Error("expected an adjective-noun name");
    const second = assignedGeneratedSessionName(
      sessionWithPreferredNoun(firstNoun, "second"),
      false,
      directory,
      { nowMs: nowMs + 1 },
    );
    expect(generatedNameNoun(second)).not.toBe(firstNoun);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("a newly minted name never takes a noun held by a current session", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-mail-names-"));
  try {
    const preferred = generatedNameNoun(adjectiveNounSessionName("current"));
    if (!preferred) throw new Error("expected an adjective-noun name");
    const assigned = assignedGeneratedSessionName("current", false, directory, {
      unavailableNouns: new Set([preferred]),
    });
    expect(generatedNameNoun(assigned)).not.toBe(preferred);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("an exhausted recent pool recycles its least-recently minted noun", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-mail-names-"));
  const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
  try {
    const assignedNouns: string[] = [];
    for (let index = 0; index < NOUNS.length; index += 1) {
      const assigned = assignedGeneratedSessionName(
        `fill-${index}`,
        false,
        directory,
        { nowMs: nowMs + index },
      );
      const noun = generatedNameNoun(assigned);
      if (!noun) throw new Error("expected an adjective-noun name");
      assignedNouns.push(noun);
    }
    expect(new Set(assignedNouns)).toHaveLength(256);

    const recycled = assignedGeneratedSessionName(
      "after-exhaustion",
      false,
      directory,
      { nowMs: nowMs + NOUNS.length },
    );
    expect(generatedNameNoun(recycled)).toBe(assignedNouns[0]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("a noun becomes normally eligible after the recency window", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-mail-names-"));
  const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
  try {
    const first = assignedGeneratedSessionName("old", false, directory, {
      nowMs,
    });
    const noun = generatedNameNoun(first);
    if (!noun) throw new Error("expected an adjective-noun name");
    const reused = assignedGeneratedSessionName(
      sessionWithPreferredNoun(noun, "later"),
      false,
      directory,
      { nowMs: nowMs + RECENT_NOUN_USE_MS + 1 },
    );
    expect(generatedNameNoun(reused)).toBe(noun);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("a malformed assignment blocks minting instead of silently weakening recency", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-mail-names-"));
  try {
    writeFileSync(join(directory, "corrupt.json"), "not json");
    expect(() =>
      assignedGeneratedSessionName("new", false, directory),
    ).toThrow();
  } finally {
    rmSync(directory, { recursive: true });
  }
});

// --- recency helpers ---------------------------------------------------------

test("formatAge buckets: minutes, hours to 47h, then days", () => {
  expect(formatAge(30_000)).toBe("<1m");
  expect(formatAge(12 * 60_000)).toBe("12m");
  expect(formatAge(26 * 3600_000)).toBe("26h"); // day-old still reads in hours
  expect(formatAge(49 * 3600_000)).toBe("2d");
});

test("lastActivityMs takes the most recent of started/lastSeen/meta", () => {
  const started = "2026-08-01T00:00:00.000Z";
  const lastSeen = "2026-08-01T12:00:00.000Z";
  const metaMs = Date.parse("2026-08-01T18:00:00.000Z");
  expect(lastActivityMs({ started })).toBe(Date.parse(started));
  expect(lastActivityMs({ started, lastSeen })).toBe(Date.parse(lastSeen));
  expect(lastActivityMs({ started, lastSeen }, { updatedAt: metaMs })).toBe(
    metaMs,
  );
});

test("activityTag: busy wins; recent is active; old idle is flagged stale", () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");
  expect(activityTag("busy", now - 26 * 3600_000, now)).toBe("busy");
  expect(activityTag(undefined, now - 30_000, now)).toBe("active");
  expect(activityTag("idle", now - 3 * 3600_000, now)).toBe("idle 3h");
  expect(activityTag("idle", now - 26 * 3600_000, now)).toBe(
    "idle 26h — stale?",
  );
});

test("isStaleSession agrees with the tag activityTag renders", () => {
  // The gate asks the predicate directly instead of matching "stale?" against a
  // rendered string; this pins the two to one threshold and one precedence rule.
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  const ages = [
    0,
    60_000,
    3600_000,
    23 * 3600_000,
    24 * 3600_000,
    72 * 3600_000,
  ];
  for (const status of [undefined, "busy", "idle"]) {
    for (const age of ages) {
      const lastActive = now - age;
      expect(isStaleSession(status, lastActive, now)).toBe(
        activityTag(status, lastActive, now).endsWith("stale?"),
      );
    }
  }
});

// --- session identity from the environment -----------------------------------

test("a native session id wins over a launcher-minted one", () => {
  // Order matters only when both are present, which is the nested case: an
  // agent started inside another agent's shell inherits AGENT_SESSION_ID, then
  // sets its own native id. The native id is the more specific of the two.
  //
  // Preferring the launcher id here was tried and reverted: the children that
  // lack a native id lack AGENT_SESSION_ID too, so no reordering reaches them.
  // They are served by sessionIdFromHostEnviron instead.
  expect(
    sessionIdFromEnv({
      AGENT_SESSION_ID: "launcher-minted",
      CLAUDE_CODE_SESSION_ID: "claude-native",
    }),
  ).toBe("claude-native");
  expect(
    sessionIdFromEnv({
      AGENT_SESSION_ID: "launcher-minted",
      CODEX_THREAD_ID: "codex-native",
    }),
  ).toBe("codex-native");
});

test("a launcher id minted for another process is not adopted", () => {
  // An agent started outside the launcher inherits AGENT_SESSION_ID from its
  // parent agent's environment, where it is indistinguishable from one minted
  // for itself. Answering to it files this session's work under a different,
  // live session — a specific wrong answer, worse than having none. The marker
  // names the process the id was minted for.
  // The marker is consulted only where the launcher id would otherwise be
  // selected — with no native id present, which is the case it exists for.
  const inherited = {
    AGENT_SESSION_ID: "parent-agents-id",
    AGENT_SESSION_PID: "4242",
  };
  expect(sessionIdFromEnv(inherited, 9999)).toBeUndefined();
  // Same environment, and this really is the process it was minted for.
  expect(sessionIdFromEnv(inherited, 4242)).toBe("parent-agents-id");
  // A native id outranks it either way, so the marker never has to arbitrate.
  expect(
    sessionIdFromEnv({ ...inherited, CODEX_THREAD_ID: "mine" }, 9999),
  ).toBe("mine");
});

test("an unverifiable launcher id is trusted rather than discarded", () => {
  // A launcher predating the marker exports no such variable, and a caller may
  // not know its host agent's pid. Refusing in either case would strand every
  // session those launchers start, which is the failure this ordering exists
  // to fix.
  expect(sessionIdFromEnv({ AGENT_SESSION_ID: "no-marker" }, 9999)).toBe(
    "no-marker",
  );
  expect(
    sessionIdFromEnv({ AGENT_SESSION_ID: "id", AGENT_SESSION_PID: "4242" }),
  ).toBe("id");
});

test("AGENT_SESSION_ID identifies agents that export no native id", () => {
  // kimi and opencode export nothing per-session; without this the id falls
  // through to a UUID minted inside the MCP server, which no sibling
  // subprocess can learn, leaving the session unaddressable.
  expect(sessionIdFromEnv({ AGENT_SESSION_ID: "launcher-minted" })).toBe(
    "launcher-minted",
  );
  expect(sessionIdFromEnv({})).toBeUndefined();
});

test("an empty session id does not mask a real one further down the chain", () => {
  expect(
    sessionIdFromEnv({
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      AGENT_SESSION_ID: "launcher-minted",
    }),
  ).toBe("launcher-minted");
  expect(sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: "" })).toBeUndefined();
});

// --- matching a --session argument -------------------------------------------

const ADDRESSES = [
  {
    sessionId: SID,
    fullName: "augur-quiet-lantern",
    displayName: "Quiet Lantern",
  },
  {
    sessionId: "other",
    fullName: "augur-steady-star",
    displayName: "Steady Star",
  },
];

test("a session matches by id, full name, or display name", () => {
  for (const query of [
    SID,
    "augur-quiet-lantern",
    "Quiet Lantern",
    "quiet lantern",
  ]) {
    expect(matchSessions(ADDRESSES, query).map((m) => m.sessionId)).toEqual([
      SID,
    ]);
  }
});

test("a name that fits nothing matches nothing", () => {
  expect(matchSessions(ADDRESSES, "augur-absent-moon")).toEqual([]);
  // Partial names are not prefixes: addressing is exact, so a truncated id
  // must fail rather than silently pick a session.
  expect(matchSessions(ADDRESSES, SID.slice(0, 8))).toEqual([]);
});

test("every match is returned so callers can decide what ambiguity means", () => {
  const twins = [
    { sessionId: "a", fullName: "p-twin", displayName: "Twin" },
    { sessionId: "b", fullName: "p-twin-2", displayName: "Twin" },
  ];
  expect(matchSessions(twins, "Twin").map((m) => m.sessionId)).toEqual([
    "a",
    "b",
  ]);
});

test("multiple components under one session id resolve as one address", () => {
  const components = [
    { sessionId: "same", fullName: "p-same", displayName: "Same" },
    { sessionId: "same", fullName: "p-same", displayName: "Same" },
  ];
  expect(matchSessions(components, "Same")).toEqual([components[1]]);
  expect(resolveSessionQuery(components, "Same").kind).toBe("unique");
});

test("resolveSessionQuery separates unique, absent, and ambiguous names", () => {
  // The three cases callers branch on. Which of them count as errors is the
  // caller's policy: send_mail refuses on none/ambiguous because an agent is
  // there to retry, while notify broadcasts because an automation's addressee
  // may have exited mid-job and refusing would discard the message entirely.
  const unique = resolveSessionQuery(ADDRESSES, "Quiet Lantern");
  expect(unique.kind).toBe("unique");
  expect(unique.kind === "unique" && unique.session.sessionId).toBe(SID);

  expect(resolveSessionQuery(ADDRESSES, "augur-absent-moon").kind).toBe("none");
  expect(resolveSessionQuery([], "anything").kind).toBe("none");

  const twins = [
    { sessionId: "a", fullName: "p-twin", displayName: "Twin" },
    { sessionId: "b", fullName: "p-twin-2", displayName: "Twin" },
  ];
  const ambiguous = resolveSessionQuery(twins, "Twin");
  expect(ambiguous.kind).toBe("ambiguous");
  expect(ambiguous.kind === "ambiguous" && ambiguous.matches).toHaveLength(2);
});

// --- adopting the host agent's id ---------------------------------------

const HOST_ENV = [
  "/opt/homebrew/bin/codex",
  "STARSHIP_SHELL=zsh",
  "SOME_API_KEY=not-a-session-id",
  "AGENT_SESSION_ID=host-minted",
  "AGENT_SESSION_PID=44822",
  "CLAUDE_CODE_SESSION_ID=an-outer-agents-native-id",
].join(" ");

test("the host's launcher id is adopted when minted for that host", () => {
  // Codex spawns its MCP servers with no session variable at all, so without
  // this the child mints a UUID no sibling can learn and the session is
  // addressable by nothing.
  expect(sessionIdFromHostEnviron(HOST_ENV, 44822)).toBe("host-minted");
});

test("a host id minted for a different process is not adopted", () => {
  expect(sessionIdFromHostEnviron(HOST_ENV, 99999)).toBeUndefined();
});

test("an unmarked host id is refused, unlike an unmarked id of our own", () => {
  // The asymmetry is deliberate. A variable in our OWN environment is at least
  // weak evidence it was meant for us, so an absent marker there is trusted. A
  // value read out of another process has no such standing and is adopted only
  // on proof.
  const unmarked = "AGENT_SESSION_ID=host-minted OTHER=x";
  expect(sessionIdFromHostEnviron(unmarked, 44822)).toBeUndefined();
  expect(sessionIdFromEnv({ AGENT_SESSION_ID: "ours" }, 44822)).toBe("ours");
});

test("a native id is never adopted out of the host's environment", () => {
  // A native id in a parent's environment may have been inherited from an outer
  // agent; answering to it files this session's work under a different, live
  // session. Only the marked launcher id is trustworthy at one hop.
  const nativeOnly =
    "CLAUDE_CODE_SESSION_ID=an-outer-agents-native-id AGENT_SESSION_PID=44822";
  expect(sessionIdFromHostEnviron(nativeOnly, 44822)).toBeUndefined();
});

// --- resume ids from the host's command line ------------------------------

const RESUMED = "004a30c3-6144-4e8a-8f47-c0ace144c8f4";

test("a resume id is taken from either harness's command line", () => {
  // Codex is why this exists: its thread id is the resume-stable identity weft
  // records, and it is unreachable from the MCP child except here.
  expect(resumeIdFromCommand(`/opt/homebrew/bin/codex resume ${RESUMED}`)).toBe(
    RESUMED,
  );
  expect(
    resumeIdFromCommand(`/bin/claude --channels=plugin:x --resume ${RESUMED}`),
  ).toBe(RESUMED);
  expect(resumeIdFromCommand(`/bin/claude -r ${RESUMED}`)).toBe(RESUMED);
});

test("a resume that names no id yields none rather than the next token", () => {
  // `--resume` with no value opens a picker, and `--continue` and `--last`
  // carry no id at all. Taking the following token would adopt a flag as an
  // identity — worse than having none, because it would be stable and wrong.
  expect(
    resumeIdFromCommand("/bin/claude --resume --model fable"),
  ).toBeUndefined();
  expect(resumeIdFromCommand("/bin/claude --continue")).toBeUndefined();
  expect(
    resumeIdFromCommand("/opt/homebrew/bin/codex resume --last"),
  ).toBeUndefined();
  expect(resumeIdFromCommand("/opt/homebrew/bin/codex")).toBeUndefined();
  expect(resumeIdFromCommand("")).toBeUndefined();
});

test("a non-uuid after the flag is not adopted", () => {
  // codex resume also accepts a session NAME. A name is not what weft records,
  // so matching one would produce an id that joins to nothing while looking
  // like it should.
  expect(
    resumeIdFromCommand("/opt/homebrew/bin/codex resume my-saved-session"),
  ).toBeUndefined();
});

test("the harness's own environment outranks the command line", () => {
  // Claude sets CLAUDE_CODE_SESSION_ID to the resumed id, so argv adds nothing
  // there. Where they could differ, the environment is what the harness
  // actually adopted; argv is only what was requested of it.
  expect(sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: "from-env" })).toBe(
    "from-env",
  );
});
