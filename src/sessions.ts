/** Claude Code per-session metadata (~/.claude/sessions/<pid>.json).
 *
 * Undocumented Claude Code internal state: each interactive session writes a
 * file mapping {sessionId, cwd, name, status, ...}. We read it only to attach a
 * human-readable name (set via `/rename`) to a sessionId. Read defensively —
 * the format may change between Claude Code versions, or be absent on older
 * ones, in which case names are simply unavailable and callers use a
 * generated alias.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSessionAliases } from "./config.ts";
import { withFileLock } from "./lock.ts";
import { ADJECTIVES, NOUNS } from "./nameWords.ts";
import { REGISTRY_DIR, SESSION_NAMES_DIR, canonicalProject } from "./paths.ts";

const SESSIONS_DIR = join(
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  "sessions",
);

export interface ClaudeSessionMeta {
  name?: string;
  status?: string;
  /** Claude Code's provenance for `name`: "derived" = auto-generated
   * `<project>-<hex>`; anything else (or a `/rename`) is a deliberate label. */
  nameSource?: string;
  /** Epoch ms of the session's most recent update (max of the file's
   * `updatedAt` / `statusUpdatedAt`) — the activity signal for idle times. */
  updatedAt?: number;
}

const ONSETS = [
  "b",
  "br",
  "d",
  "f",
  "fl",
  "g",
  "h",
  "j",
  "k",
  "l",
  "m",
  "n",
  "p",
  "r",
  "s",
  "t",
  "v",
  "w",
  "z",
];
const VOWELS = ["a", "e", "i", "o", "u", "ai", "ia"];
const CODAS = ["", "", "", "l", "m", "n", "r", "s"];

export interface GeneratedSessionName {
  scheme: "legacy-syllable" | "adjective-noun";
  slug: string;
  displayName: string;
}

export interface SessionNames {
  /** Stable address shown in global lists and accepted by --session. */
  fullName: string;
  /** Human-facing name used where the project is already evident. */
  displayName: string;
  generated: boolean;
}

function syllable(bytes: Buffer, offset: number): string {
  return (
    ONSETS[bytes[offset] % ONSETS.length] +
    VOWELS[bytes[offset + 1] % VOWELS.length] +
    CODAS[bytes[offset + 2] % CODAS.length]
  );
}

/** Map of sessionId -> {name, status} for every recorded Claude Code session.
 *
 * Files are keyed by the Claude Code REPL pid, not the sessionId, so we read
 * each file and index by its `sessionId` field. Live-ness is not checked here;
 * cross-reference the agent-mail registry (which is pid-pruned) for that. */
export function claudeSessions(): Map<string, ClaudeSessionMeta> {
  const map = new Map<string, ClaudeSessionMeta>();
  if (!existsSync(SESSIONS_DIR)) return map;
  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const doc = JSON.parse(
        readFileSync(join(SESSIONS_DIR, file), "utf8"),
      ) as {
        sessionId?: unknown;
        name?: unknown;
        status?: unknown;
        nameSource?: unknown;
        updatedAt?: unknown;
        statusUpdatedAt?: unknown;
      };
      if (typeof doc.sessionId !== "string") continue;
      const stamps = [doc.updatedAt, doc.statusUpdatedAt].filter(
        (v): v is number => typeof v === "number" && Number.isFinite(v),
      );
      map.set(doc.sessionId, {
        name: typeof doc.name === "string" ? doc.name : undefined,
        status: typeof doc.status === "string" ? doc.status : undefined,
        nameSource:
          typeof doc.nameSource === "string" ? doc.nameSource : undefined,
        updatedAt: stamps.length ? Math.max(...stamps) : undefined,
      });
    } catch {
      // partially-written or malformed session file; skip
    }
  }
  return map;
}

/** One short, pronounceable syllable off the session id — the readable stand-in
 * for Claude's `-7a`/`-43` hex suffix. Low entropy is fine: a handful of
 * sessions per project. */
function readableSuffix(sessionId: string): string {
  return syllable(createHash("sha256").update(sessionId).digest(), 0);
}

export function legacyGeneratedSessionName(
  sessionId: string,
): GeneratedSessionName {
  const slug = readableSuffix(sessionId);
  return { scheme: "legacy-syllable", slug, displayName: slug };
}

export function adjectiveNounSessionName(
  sessionId: string,
): GeneratedSessionName {
  const bytes = createHash("sha256").update(sessionId).digest();
  const adjective = ADJECTIVES[bytes[0] % ADJECTIVES.length];
  const noun = NOUNS[bytes[1] % NOUNS.length];
  return adjectiveNounName(adjective, noun);
}

function adjectiveNounName(
  adjective: (typeof ADJECTIVES)[number],
  noun: (typeof NOUNS)[number],
): GeneratedSessionName {
  return {
    scheme: "adjective-noun",
    slug: `${adjective}-${noun}`,
    displayName: `${adjective[0].toUpperCase()}${adjective.slice(1)} ${noun[0].toUpperCase()}${noun.slice(1)}`,
  };
}

function assignmentPath(sessionId: string, directory: string): string {
  const id = createHash("sha256").update(sessionId).digest("hex");
  return join(directory, `${id}.json`);
}

interface StoredGeneratedSessionName extends GeneratedSessionName {
  sessionId?: string;
  assignedAt?: string;
}

function readGeneratedSessionNameFile(
  path: string,
): StoredGeneratedSessionName {
  const value = JSON.parse(
    readFileSync(path, "utf8"),
  ) as StoredGeneratedSessionName;
  if (
    (value.scheme !== "legacy-syllable" && value.scheme !== "adjective-noun") ||
    typeof value.slug !== "string" ||
    typeof value.displayName !== "string" ||
    (value.sessionId !== undefined && typeof value.sessionId !== "string") ||
    (value.assignedAt !== undefined &&
      (typeof value.assignedAt !== "string" ||
        !Number.isFinite(Date.parse(value.assignedAt))))
  ) {
    throw new Error(`invalid session-name assignment: ${path}`);
  }
  return value;
}

function readGeneratedSessionName(
  sessionId: string,
  directory: string,
): GeneratedSessionName | undefined {
  const path = assignmentPath(sessionId, directory);
  if (!existsSync(path)) return undefined;
  const value = readGeneratedSessionNameFile(path);
  return {
    scheme: value.scheme,
    slug: value.slug,
    displayName: value.displayName,
  };
}
/** Nouns already assigned to sessions represented in the registry.
 *
 * Registry entries are written only after their name assignment, so a missing
 * assignment is a legacy registration rather than an in-flight generated
 * name. Malformed registry entries are left for the registry's liveness sweep;
 * malformed assignments remain fatal because they weaken name provenance. */
function registeredGeneratedNameNouns(
  assignmentDirectory: string,
  registryDirectory: string,
): Set<string> {
  const nouns = new Set<string>();
  if (!existsSync(registryDirectory)) return nouns;
  for (const file of readdirSync(registryDirectory)) {
    if (!file.endsWith(".json")) continue;
    let sessionId: string | undefined;
    try {
      const value = JSON.parse(
        readFileSync(join(registryDirectory, file), "utf8"),
      ) as { sessionId?: unknown };
      sessionId =
        typeof value.sessionId === "string" ? value.sessionId : undefined;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    if (!sessionId) continue;
    const path = assignmentPath(sessionId, assignmentDirectory);
    if (!existsSync(path)) continue;
    const noun = generatedNameNoun(readGeneratedSessionNameFile(path));
    if (noun) nouns.add(noun);
  }
  return nouns;
}

/** Noun portion of a generated adjective–noun identity. */
export function generatedNameNoun(
  name: GeneratedSessionName,
): string | undefined {
  if (name.scheme !== "adjective-noun") return undefined;
  const separator = name.slug.lastIndexOf("-");
  return separator >= 0 ? name.slug.slice(separator + 1) : undefined;
}

export const RECENT_NOUN_USE_MS = 30 * 24 * 60 * 60 * 1_000;
/** Name selection scans the persisted assignment history while holding its
 * global lock. OMP starts its MCP and push components together, and with a
 * large history the winner can legitimately hold the lock longer than the
 * generic transaction wait. This remains below MCP clients' 60 s startup
 * timeout and applies only to the once-per-session name mint. */
export const SESSION_NAME_LOCK_WAIT_MS = 30_000;

export interface NameAssignmentOptions {
  /** Additional nouns that must not be selected. */
  unavailableNouns?: ReadonlySet<string>;
  /** Dependency injection for deterministic recency tests. */
  nowMs?: number;
}

function recentNounUse(directory: string): Map<string, number> {
  const use = new Map<string, number>();
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".json")) continue;
    const path = join(directory, file);
    const stored = readGeneratedSessionNameFile(path);
    const noun = generatedNameNoun(stored);
    if (!noun || !NOUNS.includes(noun as (typeof NOUNS)[number])) continue;
    const assignedAt = stored.assignedAt
      ? Date.parse(stored.assignedAt)
      : statSync(path).mtimeMs;
    use.set(noun, Math.max(use.get(noun) ?? 0, assignedAt));
  }
  return use;
}

function selectedAdjectiveNounName(
  sessionId: string,
  directory: string,
  unavailableNouns: ReadonlySet<string>,
  nowMs: number,
): GeneratedSessionName {
  const bytes = createHash("sha256").update(sessionId).digest();
  const adjective = ADJECTIVES[bytes[0]];
  const firstNoun = bytes[1];
  const use = recentNounUse(directory);
  const cutoff = nowMs - RECENT_NOUN_USE_MS;

  for (let offset = 0; offset < NOUNS.length; offset += 1) {
    const noun = NOUNS[(firstNoun + offset) % NOUNS.length];
    if (!unavailableNouns.has(noun) && (use.get(noun) ?? 0) <= cutoff) {
      return adjectiveNounName(adjective, noun);
    }
  }

  let oldestNoun: (typeof NOUNS)[number] | undefined;
  let oldestUse = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < NOUNS.length; offset += 1) {
    const noun = NOUNS[(firstNoun + offset) % NOUNS.length];
    if (unavailableNouns.has(noun)) continue;
    const usedAt = use.get(noun) ?? 0;
    if (usedAt < oldestUse) {
      oldestNoun = noun;
      oldestUse = usedAt;
    }
  }
  if (!oldestNoun) {
    throw new Error("all friendly session-name nouns are currently in use");
  }
  return adjectiveNounName(adjective, oldestNoun);
}

/** Whether agent-mail has ever registered a session under this id.
 *
 * Read-only: unlike `assignedGeneratedSessionName` it never mints an
 * assignment, so asking the question cannot create the evidence that answers
 * it. The name store is the durable record — registry entries are pruned when
 * a process exits, so they answer "live now", not "ever existed".
 *
 * This is what separates "the submitter is gone" from "the submitter was never
 * ours". Agents whose channel server is spawned without a session env var mint
 * an id no sibling process can learn, so their weft jobs carry a submitter id
 * agent-mail has never seen — and treating that as an absent owner would
 * report every such job as unowned. */
export function hasSeenSession(
  sessionId: string,
  directory = SESSION_NAMES_DIR,
): boolean {
  if (!sessionId) return false;
  return existsSync(assignmentPath(sessionId, directory));
}

/** Return the session's persisted generated name, selecting one only once.
 * `legacy` is used by the upgrade migration for sessions that were already
 * registered; all genuinely new session ids use adjective–noun names. */
export function assignedGeneratedSessionName(
  sessionId: string,
  legacy = false,
  directory = SESSION_NAMES_DIR,
  options: NameAssignmentOptions = {},
): GeneratedSessionName {
  const existing = readGeneratedSessionName(sessionId, directory);
  if (existing) return existing;
  const nowMs = options.nowMs ?? Date.now();
  return withFileLock(
    join(directory, ".mint.lock"),
    () => {
      const lockedExisting = readGeneratedSessionName(sessionId, directory);
      if (lockedExisting) return lockedExisting;
      const unavailableNouns = new Set(options.unavailableNouns);
      const registryDirectory =
        directory === SESSION_NAMES_DIR ? REGISTRY_DIR : false;
      if (!legacy && registryDirectory) {
        for (const noun of registeredGeneratedNameNouns(
          directory,
          registryDirectory,
        )) {
          unavailableNouns.add(noun);
        }
      }
      const selected = legacy
        ? legacyGeneratedSessionName(sessionId)
        : selectedAdjectiveNounName(
            sessionId,
            directory,
            unavailableNouns,
            nowMs,
          );
      mkdirSync(directory, { recursive: true });
      const path = assignmentPath(sessionId, directory);
      try {
        writeFileSync(
          path,
          JSON.stringify(
            {
              sessionId,
              assignedAt: new Date(nowMs).toISOString(),
              ...selected,
            },
            null,
            1,
          ),
          { flag: "wx" },
        );
        return selected;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const raced = readGeneratedSessionName(sessionId, directory);
        if (!raced) throw error;
        return raced;
      }
    },
    { waitMs: SESSION_NAME_LOCK_WAIT_MS },
  );
}

/** Project base (directory basename) for a session's label, mapped through the
 * short-alias table, e.g. `llm-performance-models` -> `augur`. */
function projectBase(cwd: string, aliases: Map<string, string>): string {
  const base = cwd.split("/").filter(Boolean).pop() ?? "root";
  return aliases.get(base) ?? base;
}

let aliasCache: Map<string, string> | undefined;
/** Reload the memoized session-alias table (call after a config change). */
export function resetSessionAliasCache(): void {
  aliasCache = undefined;
}
function sessionAliases(): Map<string, string> {
  aliasCache ??= loadSessionAliases();
  return aliasCache;
}

/** Whether a Claude session name is auto-derived (`<base>-<hex>`) rather than a
 * deliberate `/rename`. Trusts `nameSource` when present; otherwise falls back
 * to the `<basename>-<2 alnum>` shape. */
function isDerivedName(
  name: string,
  nameSource: string | undefined,
  cwd?: string,
): boolean {
  if (nameSource) return nameSource === "derived";
  const base = cwd?.split("/").filter(Boolean).pop();
  return base ? new RegExp(`^${base}-[0-9a-z]{2}$`).test(name) : false;
}

/** Full and display names for a session.
 *
 * - A deliberate `/rename` (non-derived Claude name) is kept verbatim.
 * - Otherwise the persisted generated name supplies a kebab-case slug for the
 *   full name and a human-facing display name.
 * - The full name includes the aliased project base when cwd is available. */
export function sessionNames(
  sessionId: string,
  meta?: { name?: string; nameSource?: string },
  cwd?: string,
  generatedName?: GeneratedSessionName,
): SessionNames {
  const name = meta?.name?.trim();
  if (name && !isDerivedName(name, meta?.nameSource, cwd)) {
    return { fullName: name, displayName: name, generated: false };
  }
  const generated =
    generatedName ?? assignedGeneratedSessionName(sessionId, false);
  return {
    fullName: cwd
      ? `${projectBase(cwd, sessionAliases())}-${generated.slug}`
      : generated.slug,
    displayName: generated.displayName,
    generated: true,
  };
}

/** Stable address: `<project>-<adjective>-<noun>` for new generated names. */
export function sessionFullName(
  sessionId: string,
  meta?: { name?: string; nameSource?: string },
  cwd?: string,
  generatedName?: GeneratedSessionName,
): string {
  return sessionNames(sessionId, meta, cwd, generatedName).fullName;
}

/** Human-facing name used in routes and other project-labelled contexts. */
export function sessionDisplayName(
  sessionId: string,
  meta?: { name?: string; nameSource?: string },
  cwd?: string,
  generatedName?: GeneratedSessionName,
): string {
  return sessionNames(sessionId, meta, cwd, generatedName).displayName;
}

// --- Session identity from the environment -----------------------------------

/** Env vars that carry a per-session agent id, in resolution order.
 *
 * Native ids come first: an agent that mints its own per-session id knows more
 * than a launcher wrapping it does. `AGENT_SESSION_ID` is the generic fallback
 * for agents that export nothing of their own (kimi and opencode export only
 * process-level or workspace-level ids, neither of which separates two sessions
 * in one directory). The guard launcher mints it and unsets the native ids
 * first, so a nested agent cannot be mistaken for the parent that launched it —
 * plain inheritance would otherwise hand a nested kimi its parent's
 * CLAUDE_CODE_SESSION_ID. */
/** Resolution order for the calling agent's session id.
 *
 * Native ids come first: an agent that mints its own per-session id knows more
 * about that session than a launcher wrapping it does. Reordering this to put
 * the launcher id first buys nothing — the children that lack a native id lack
 * `AGENT_SESSION_ID` too, so no order reaches them. Those are served by
 * `sessionIdFromHostEnviron` instead. See
 * `docs/decisions/0010-adopt-the-host-agent-session-id.md`.
 *
 * Mirrored in weft's `defaultSubmitterSessionEnvVars`; the two move together. */
export const SESSION_ID_ENV_VARS = [
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "AGENT_SESSION_ID",
] as const;

/** Process the launcher minted `AGENT_SESSION_ID` for. */
export const AGENT_SESSION_PID_ENV_VAR = "AGENT_SESSION_PID";

/** Resolve the calling agent's session id from the environment.
 *
 * Empty values are skipped rather than winning the chain: an `export X=""`
 * upstream would otherwise mask a real id further down it.
 *
 * `hostPid` is the agent process this caller belongs to — for an MCP server,
 * its parent. When supplied, a launcher-minted id is accepted only if
 * `AGENT_SESSION_PID` names that same process. An agent started *outside* the
 * launcher inherits its parent agent's `AGENT_SESSION_ID` from the environment,
 * and answering to it would file this session's work under a different, live
 * session — a specific wrong answer, which is worse than having none. The
 * marker is what distinguishes minted-for-me from inherited, since the id
 * itself looks identical either way.
 *
 * A missing marker is trusted: launchers predating it export no such variable,
 * and refusing those would strand every session started by one. */
export function sessionIdFromEnv(
  env: Record<string, string | undefined> = process.env,
  hostPid?: number,
): string | undefined {
  for (const name of SESSION_ID_ENV_VARS) {
    const value = env[name];
    if (!value) continue;
    if (name === "AGENT_SESSION_ID" && !mintedForHost(env, hostPid)) continue;
    return value;
  }
  return undefined;
}

const RESUME_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The conversation id a host agent was resumed with, from its command line.
 *
 * Covers `claude --resume <id>` / `-r <id>` and `codex resume <id>`. It exists
 * for Codex, whose thread id is the resume-stable identity weft records but is
 * reachable only from tool-call environments — never from the MCP child. On the
 * command line it is readable.
 *
 * What it does NOT cover, and cannot: `--continue`, `codex resume --last`, and
 * an in-session `/resume` all carry no id. Only a UUID-shaped token is taken,
 * so a bare `--resume` that opens a picker is ignored rather than swallowing
 * the next flag.
 *
 * The load-bearing caveat: **argv records intent, not outcome.** A resume that
 * failed, or one whose picker the user overrode, still leaves the requested id
 * on the command line. Nothing observable from outside the process
 * distinguishes that from a resume that took, so this is trusted only where
 * there is no better answer — after the process's own environment, which is
 * what the harness actually set. */
export function resumeIdFromCommand(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const token = tokens[i];
    if (token !== "--resume" && token !== "-r" && token !== "resume") continue;
    const candidate = tokens[i + 1];
    if (RESUME_UUID.test(candidate)) return candidate;
  }
  return undefined;
}

/** The host agent's session id, read from that process's environment.
 *
 * For children spawned without one. Codex gives its MCP servers no session
 * variable at all — measured across three sessions, zero of the four names are
 * present — while the codex process itself holds `AGENT_SESSION_ID`. Such a
 * child otherwise mints a `randomUUID()` that no sibling can learn, so the
 * session is addressable by nothing and no tool can join a job back to it.
 *
 * Only `AGENT_SESSION_ID` is adopted this way, never a native id. A native id
 * in a parent's environment may have been inherited from an outer agent, and
 * answering to it would file this session's work under a different, live one.
 *
 * The marker is REQUIRED here, unlike in our own environment. A variable in our
 * own environment is at least weak evidence it was meant for us; a value read
 * out of another process has no such standing, so it is adopted only on proof
 * that the launcher minted it for that exact process.
 *
 * `environ` is the parent's full environment and routinely contains API keys.
 * Extract the two variables and never log, store, or return the rest. */
export function sessionIdFromHostEnviron(
  environ: string,
  hostPid: number,
): string | undefined {
  const idPrefix = "AGENT_SESSION_ID=";
  const pidPrefix = `${AGENT_SESSION_PID_ENV_VAR}=`;
  let id: string | undefined;
  let marker: string | undefined;
  // Whitespace splitting is safe for these two specifically — a minted id is a
  // UUID and the marker is a pid, neither of which can contain a space. It is
  // not safe in general, which is why nothing else is read from here.
  for (const token of environ.split(/\s+/)) {
    if (token.startsWith(idPrefix)) id = token.slice(idPrefix.length);
    else if (token.startsWith(pidPrefix))
      marker = token.slice(pidPrefix.length);
  }
  if (!id || !marker) return undefined;
  return Number(marker) === hostPid ? id : undefined;
}

function mintedForHost(
  env: Record<string, string | undefined>,
  hostPid: number | undefined,
): boolean {
  const marker = env[AGENT_SESSION_PID_ENV_VAR];
  if (!marker || hostPid === undefined) return true; // unverifiable, so trusted
  return Number(marker) === hostPid;
}

/** Where OMP (oh-my-pi) records, per terminal, the session it is writing. */
export const OMP_TERMINAL_SESSIONS_DIR = join(
  homedir(),
  ".omp",
  "agent",
  "terminal-sessions",
);

/** The uuid ending an OMP session file name. */
const OMP_SESSION_FILE_ID =
  /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function hostIsOmp(command: string): boolean {
  const first = command.trim().split(/\s+/)[0];
  if (!first) return false;
  return (first.split("/").pop() ?? first) === "omp";
}

/** `<cwd>\n<session file path>` — the two lines OMP writes. Later lines are a
 * status word we have no use for. */
function ompRecord(
  path: string,
): { cwd: string; sessionId: string } | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined; // absent, or being rewritten as we read
  }
  const [recordedCwd, sessionFile] = text.split("\n");
  if (!recordedCwd || !sessionFile) return undefined;
  const id = OMP_SESSION_FILE_ID.exec(sessionFile.trim());
  if (!id) return undefined;
  return { cwd: canonicalProject(recordedCwd.trim()), sessionId: id[1] };
}

/** OMP's session id for the terminal this process is attached to.
 *
 * OMP exports no session id: not in its own environment, and not in the `env`
 * block of the agent-mail entry in its mcp.json. So every earlier step of the
 * chain finds nothing and the id would be minted at random, giving one session
 * a different name on every launch — including each time it is resumed.
 *
 * What OMP does keep is a per-terminal pointer at the session file it is
 * appending to: ~/.omp/agent/terminal-sessions/<key>, holding the working
 * directory on one line and the session file path on the next. The uuid ending
 * that file name is OMP's session id, it is what OMP's own `--resume` takes,
 * and it survives a resume because OMP appends to the same file rather than
 * opening a new one.
 *
 * `resumeIdFromCommand` already covers `omp --resume <full-uuid>`. This covers
 * what it cannot see: a session started fresh, whose id appears nowhere on the
 * command line; `--continue`; the interactive picker; and the id *prefixes*
 * OMP accepts but the uuid pattern rejects.
 *
 * OMP keys the file by tty for most terminals and by `apple-$TERM_SESSION_ID`
 * for some. Neither is guaranteed, so a directory scan matched on the recorded
 * working directory is the last resort.
 */
export function sessionIdFromOmpTerminal(
  hostCommand: string,
  cwd: string,
  tty?: string,
  env: Record<string, string | undefined> = process.env,
  directory = OMP_TERMINAL_SESSIONS_DIR,
): string | undefined {
  // Only when the host really is OMP. These files outlive the run that wrote
  // them, so a different agent started later in the same terminal would
  // otherwise answer to a finished OMP session's id — a specific wrong
  // answer, and worse than having none.
  if (!hostIsOmp(hostCommand)) return undefined;

  const keys: string[] = [];
  if (tty) keys.push(tty);
  const termSession = env.TERM_SESSION_ID;
  if (termSession) keys.push(`apple-${termSession}`, termSession);
  for (const key of keys) {
    // The tty identifies the terminal exactly, so its record is taken as
    // current without comparing directories: OMP rewrites the file when it
    // opens a session, and requiring a match here would only add a way to
    // fail when the two sides spell the same directory differently.
    const record = ompRecord(join(directory, key));
    if (record) return record.sessionId;
  }

  // Both sides are canonicalised: the caller may pass a raw `process.cwd()`
  // while OMP recorded a path through a symlink, or the reverse.
  const wanted = canonicalProject(cwd);
  let newest: { mtimeMs: number; sessionId: string } | undefined;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    const record = ompRecord(path);
    if (!record || record.cwd !== wanted) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mtimeMs > newest.mtimeMs)
      newest = { mtimeMs, sessionId: record.sessionId };
  }
  return newest?.sessionId;
}

/** The subset of a session's identity that `--session` can be matched against. */
export interface SessionAddress {
  sessionId: string;
  fullName: string;
  displayName: string;
}

/** Sessions a `--session` argument names: exact id, exact full name, or
 * case-insensitive display name. Returning every match lets each caller decide
 * what an ambiguous name means — send_mail refuses, notify broadcasts. */
export function matchSessions<T extends SessionAddress>(
  candidates: T[],
  query: string,
): T[] {
  const normalized = query.toLocaleLowerCase();
  const matches = new Map<string, T>();
  for (const candidate of candidates) {
    if (
      candidate.sessionId === query ||
      candidate.fullName === query ||
      candidate.displayName.toLocaleLowerCase() === normalized
    ) {
      matches.set(candidate.sessionId, candidate);
    }
  }
  return [...matches.values()];
}

export type SessionQueryResult<T> =
  | { kind: "unique"; session: T }
  | { kind: "none" }
  | { kind: "ambiguous"; matches: T[] };

/** `matchSessions` reduced to the three cases callers actually branch on.
 *
 * Whether "none" and "ambiguous" are errors is the caller's policy, not this
 * function's: an agent calling send_mail is present to read an error and retry,
 * while an automation reporting a finished job is not, and refusing there would
 * discard the message. */
export function resolveSessionQuery<T extends SessionAddress>(
  candidates: T[],
  query: string,
): SessionQueryResult<T> {
  const matches = matchSessions(candidates, query);
  if (matches.length === 1) return { kind: "unique", session: matches[0] };
  if (matches.length === 0) return { kind: "none" };
  return { kind: "ambiguous", matches };
}

// --- Session recency ---------------------------------------------------------
//
// "Attached" (channel server alive, will receive push) and "present" (the agent
// has done anything recently) diverge exactly when a session sits idle for a
// long time — which misleads peers into overcounting active agents. These
// helpers turn the available signals into an idle-time tag every surface shows.

/** Most recent sign of life, epoch ms: Claude's session-meta update time, the
 * registry `lastSeen` (stamped on tool calls), or the registration time. */
export function lastActivityMs(
  reg: { started: string; lastSeen?: string },
  meta?: ClaudeSessionMeta,
): number {
  const candidates = [
    Date.parse(reg.started),
    reg.lastSeen ? Date.parse(reg.lastSeen) : Number.NaN,
    meta?.updatedAt ?? Number.NaN,
  ].filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : 0;
}

/** Compact age: "<1m", "12m", "26h", "3d". Hours run to 47h so day-old
 * sessions still read in hours. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const ACTIVE_MS = 2 * 60_000;
const STALE_MS = 24 * 3600_000;

/** Presence tag: "busy" (Claude reports it mid-turn), "active" (signs of life
 * within the last two minutes), else "idle <age>" — flagged "stale?" once
 * nothing has happened for a day, so peers discount attached-but-vacant
 * sessions instead of counting them as active agents. */
export function activityTag(
  status: string | undefined,
  lastActiveMs: number,
  nowMs = Date.now(),
): string {
  if (status === "busy") return "busy";
  const age = nowMs - lastActiveMs;
  if (age < ACTIVE_MS) return "active";
  const tag = `idle ${formatAge(age)}`;
  return isStaleSession(status, lastActiveMs, nowMs) ? `${tag} — stale?` : tag;
}

/** Whether a session has shown no sign of life for long enough that peers
 * should discount it rather than count it as another working agent. Shares one
 * threshold and one precedence rule with `activityTag` (a session Claude
 * reports as mid-turn is never stale), so callers can ask the question directly
 * instead of matching "stale?" against a rendered tag. */
export function isStaleSession(
  status: string | undefined,
  lastActiveMs: number,
  nowMs = Date.now(),
): boolean {
  if (status === "busy") return false;
  return nowMs - lastActiveMs >= STALE_MS;
}
