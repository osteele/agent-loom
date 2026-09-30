/** Disposable dashboard projection of the append-only message and read logs.
 * The spool remains authoritative; the SQLite cursor and its aggregates commit
 * together, so a crash after a spool append replays the unindexed suffix. */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  INBOX_DIR,
  MESSAGE_INDEX_PATH,
  STATE_DIR,
  displayName,
  legacyReadStatePath,
  readStatePath,
} from "./paths.ts";
import {
  type Message,
  type StoredMessage,
  fallbackMessageId,
} from "./spool.ts";

const GLOBAL = ""; // A project is an absolute path, so it cannot collide.
const VERSION = 1;

export interface IndexedMessages {
  /** False when the answer is the last committed projection because another
   * process held the write lock (see indexedMessages). */
  current: boolean;
  messages: StoredMessage[];
  totals: { messages: number; projects: number; threads: number };
  routes: { from: string; to: string; count: number }[];
  volume: { hour: string; count: number }[];
}

type Source = { name: string; dev: string; ino: string; offset: number };
type Position = {
  source: string;
  offset: number;
  length: number;
  project: string;
  id: string;
};

export function messageRecipient(msg: Message): string {
  return msg.delivery === "audit" && msg.meta?.nativeRecipient
    ? msg.meta.nativeRecipient
    : displayName(msg.project);
}

/** Read exactly the statted bytes, or refuse an inconsistent file snapshot. */
function fileWindow(path: string, start: number, end: number): Buffer {
  const size = end - start;
  if (size <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(size);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < size) {
      const count = readSync(fd, buffer, read, size - read, start + read);
      if (count === 0) throw new Error(`message index source changed: ${path}`);
      read += count;
    }
    return buffer;
  } finally {
    closeSync(fd);
  }
}

export function schema(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 30000");
  const versionRow = db.prepare("PRAGMA user_version").get();
  if (!versionRow || typeof versionRow.user_version !== "number")
    throw new Error("invalid message index version");
  const version = versionRow.user_version;
  if (version === VERSION) return;
  if (version !== 0)
    throw new Error(`unsupported message index version ${version}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS source (
      name TEXT PRIMARY KEY, dev TEXT NOT NULL, ino TEXT NOT NULL,
      offset INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS position (
      source TEXT NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL,
      project TEXT NOT NULL, id TEXT NOT NULL, ts TEXT NOT NULL,
      PRIMARY KEY (source, offset)
    );
    CREATE INDEX IF NOT EXISTS position_recent ON position(ts DESC, source DESC, offset DESC);
    CREATE INDEX IF NOT EXISTS position_project_recent
      ON position(project, ts DESC, source DESC, offset DESC);
    CREATE TABLE IF NOT EXISTS scope (
      name TEXT PRIMARY KEY, messages INTEGER NOT NULL, threads INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project (name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS thread (
      scope TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (scope, id)
    );
    CREATE TABLE IF NOT EXISTS route (
      scope TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
      count INTEGER NOT NULL, PRIMARY KEY (scope, sender, recipient)
    );
    CREATE TABLE IF NOT EXISTS hour (
      scope TEXT NOT NULL, start_ms INTEGER NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY (scope, start_ms)
    );
    CREATE TABLE IF NOT EXISTS read_source (
      project TEXT PRIMARY KEY, dev TEXT NOT NULL, ino TEXT NOT NULL,
      offset INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS read_id (
      project TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (project, id)
    );
    PRAGMA user_version = 1;
  `);
}

function resetMessages(db: DatabaseSync): void {
  db.exec(
    "DELETE FROM source; DELETE FROM position; DELETE FROM scope; DELETE FROM project; DELETE FROM thread; DELETE FROM route; DELETE FROM hour; DELETE FROM read_source; DELETE FROM read_id",
  );
}

/** A validated spool line, parsed before the write lock is taken. */
type ParsedLine = {
  offset: number;
  length: number;
  project: string;
  id: string;
  ts: string;
  thread: string;
  sender: string;
  recipient: string;
  hour: number | undefined;
};

/** New bytes of one spool, read against the cursor observed before locking. */
type SpoolDelta = {
  name: string;
  dev: string;
  ino: string;
  /** The cursor this delta extends; applied only if it is still current. */
  start: number;
  end: number;
  lines: ParsedLine[];
};

type ReadDelta = {
  project: string;
  /** The cursor row observed before locking, or undefined when there was none. */
  previous: Omit<Source, "name"> | undefined;
  /** Drop the project's read ids: the log was removed or replaced. */
  reset: boolean;
  /** The new cursor, or undefined when the log no longer exists. */
  next: Omit<Source, "name"> | undefined;
  ids: string[];
};

type IngestPlan = {
  /** Both cursor tables as read in one snapshot; the plan applies only if
   * they are unchanged when the write lock is held. */
  cursors: string;
  rebuild: boolean;
  spools: SpoolDelta[];
  reads: ReadDelta[];
};

function parseLine(
  offset: number,
  length: number,
  line: string,
): ParsedLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined; // A torn line does not hide later messages.
    throw error;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("project" in parsed) ||
    typeof parsed.project !== "string" ||
    !("ts" in parsed) ||
    typeof parsed.ts !== "string" ||
    !("from" in parsed) ||
    typeof parsed.from !== "string" ||
    !("message" in parsed) ||
    typeof parsed.message !== "string" ||
    ("id" in parsed && parsed.id != null && typeof parsed.id !== "string") ||
    ("threadId" in parsed &&
      parsed.threadId != null &&
      typeof parsed.threadId !== "string")
  )
    return undefined;
  const msg = parsed as Message;
  const id = msg.id ?? fallbackMessageId(line);
  const recipient = messageRecipient(msg);
  if (typeof recipient !== "string") return undefined;
  const time = Date.parse(msg.ts);
  const bucket = Number.isFinite(time) ? new Date(time) : undefined;
  bucket?.setMinutes(0, 0, 0);
  return {
    offset,
    length,
    project: msg.project,
    id,
    ts: msg.ts,
    thread: msg.threadId ?? id,
    sender: displayName(msg.from),
    recipient,
    hour: bucket?.getTime(),
  };
}

/** Split a chunk at newlines; returns the complete lines and the consumed length. */
function chunkLines(chunk: Buffer): {
  lines: [number, number, string][];
  consumed: number;
} {
  const lines: [number, number, string][] = [];
  let from = 0;
  for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, from)) {
    if (end > from)
      lines.push([from, end - from, chunk.toString("utf8", from, end)]);
    from = end + 1;
  }
  return { lines, consumed: from };
}

function sameFile(
  path: string,
  before: { dev: number; ino: number; size: number },
  what: string,
): void {
  const current = statSync(path);
  if (
    current.dev !== before.dev ||
    current.ino !== before.ino ||
    current.size < before.size
  )
    throw new Error(`message index ${what} changed: ${path}`);
}

type Cursors = {
  spools: Source[];
  reads: (Omit<Source, "name"> & { project: string })[];
  projects: string[];
};

function readCursors(db: DatabaseSync): Cursors {
  return {
    spools: db
      .prepare("SELECT name, dev, ino, offset FROM source ORDER BY name")
      .all() as Source[],
    reads: db
      .prepare(
        "SELECT project, dev, ino, offset FROM read_source ORDER BY project",
      )
      .all() as Cursors["reads"],
    projects: (
      db.prepare("SELECT name FROM project ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  };
}

function cursorKey(cursors: Cursors): string {
  return JSON.stringify([cursors.spools, cursors.reads]);
}

/** Everything that touches the filesystem: stats, reads, parsing and project
 * path resolution (a realpath, which can block on a File Provider volume).
 * None of it holds the write lock, so a slow or throttled caller delays only
 * itself. */
export function planIngest(db: DatabaseSync): IngestPlan {
  const names = existsSync(INBOX_DIR)
    ? readdirSync(INBOX_DIR).filter((name) => name.endsWith(".jsonl"))
    : [];
  db.exec("BEGIN");
  let cursors: Cursors;
  try {
    cursors = readCursors(db);
  } finally {
    db.exec("COMMIT");
  }
  const prior = new Map(cursors.spools.map((source) => [source.name, source]));
  // Truncation, replacement or deletion invalidates the rollups. A full rebuild
  // is rare and simpler than subtracting historical thread and route counts.
  const present = new Set(names);
  const rebuild =
    [...prior.keys()].some((name) => !present.has(name)) ||
    names.some((name) => {
      const previous = prior.get(name);
      if (!previous) return false;
      const stat = statSync(join(INBOX_DIR, name));
      return (
        previous.dev !== String(stat.dev) ||
        previous.ino !== String(stat.ino) ||
        stat.size < previous.offset
      );
    });
  if (rebuild) prior.clear();
  const spools: SpoolDelta[] = [];
  const projects = new Set(cursors.projects);
  if (rebuild) projects.clear();
  for (const name of names) {
    const path = join(INBOX_DIR, name);
    const stat = statSync(path);
    const start = prior.get(name)?.offset ?? 0;
    if (stat.size === start) continue;
    const { lines, consumed } = chunkLines(fileWindow(path, start, stat.size));
    if (consumed === 0) continue;
    sameFile(path, stat, "source");
    const parsed: ParsedLine[] = [];
    for (const [offset, length, line] of lines) {
      const entry = parseLine(start + offset, length, line);
      if (!entry) continue;
      parsed.push(entry);
      projects.add(entry.project);
    }
    spools.push({
      name,
      dev: String(stat.dev),
      ino: String(stat.ino),
      start,
      end: start + consumed,
      lines: parsed,
    });
  }
  const priorReads = new Map(
    cursors.reads.map(({ project, ...cursor }) => [project, cursor]),
  );
  const reads: ReadDelta[] = [];
  for (const project of projects) {
    const path = readStatePath(project);
    const previous = rebuild ? undefined : priorReads.get(project);
    if (!existsSync(path)) {
      if (previous)
        reads.push({
          project,
          previous,
          reset: true,
          next: undefined,
          ids: [],
        });
      continue;
    }
    const stat = statSync(path);
    const replaced = Boolean(
      previous &&
        (previous.dev !== String(stat.dev) ||
          previous.ino !== String(stat.ino) ||
          stat.size < previous.offset),
    );
    const start = replaced ? 0 : (previous?.offset ?? 0);
    const cursor = { dev: String(stat.dev), ino: String(stat.ino) };
    if (stat.size === start) {
      if (replaced)
        reads.push({
          project,
          previous,
          reset: true,
          next: { ...cursor, offset: 0 },
          ids: [],
        });
      continue;
    }
    const { lines, consumed } = chunkLines(fileWindow(path, start, stat.size));
    if (consumed === 0) {
      if (replaced)
        reads.push({
          project,
          previous,
          reset: true,
          next: { ...cursor, offset: 0 },
          ids: [],
        });
      continue;
    }
    sameFile(path, stat, "read log");
    reads.push({
      project,
      previous,
      reset: replaced,
      next: { ...cursor, offset: start + consumed },
      ids: lines.map(([, , line]) => line.trim()).filter(Boolean),
    });
  }
  return { cursors: cursorKey(cursors), rebuild, spools, reads };
}

/** Apply a plan under the write lock, all or nothing. A plan is valid only
 * against the cursors it was read from: if another process committed since,
 * this one might repeat that work, or (for a rebuild) erase it. Returns false
 * without writing, and the caller plans again. */
export function applyIngest(db: DatabaseSync, plan: IngestPlan): boolean {
  if (cursorKey(readCursors(db)) !== plan.cursors) return false;
  if (plan.rebuild) resetMessages(db);
  const statements = {
    position: db.prepare(
      "INSERT INTO position(source, offset, length, project, id, ts) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    project: db.prepare("INSERT OR IGNORE INTO project(name) VALUES (?)"),
    scope: db.prepare(
      "INSERT INTO scope(name, messages, threads) VALUES (?, 1, 0) ON CONFLICT(name) DO UPDATE SET messages = messages + 1",
    ),
    thread: db.prepare("INSERT OR IGNORE INTO thread(scope, id) VALUES (?, ?)"),
    addThread: db.prepare(
      "UPDATE scope SET threads = threads + 1 WHERE name = ?",
    ),
    route: db.prepare(
      "INSERT INTO route(scope, sender, recipient, count) VALUES (?, ?, ?, 1) ON CONFLICT(scope, sender, recipient) DO UPDATE SET count = count + 1",
    ),
    hour: db.prepare(
      "INSERT INTO hour(scope, start_ms, count) VALUES (?, ?, 1) ON CONFLICT(scope, start_ms) DO UPDATE SET count = count + 1",
    ),
  };
  const updateSpool = db.prepare(
    "INSERT INTO source(name, dev, ino, offset) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET dev = excluded.dev, ino = excluded.ino, offset = excluded.offset",
  );
  for (const delta of plan.spools) {
    for (const line of delta.lines) {
      statements.position.run(
        delta.name,
        line.offset,
        line.length,
        line.project,
        line.id,
        line.ts,
      );
      statements.project.run(line.project);
      for (const scope of [GLOBAL, line.project]) {
        statements.scope.run(scope);
        if (statements.thread.run(scope, line.thread).changes > 0)
          statements.addThread.run(scope);
        statements.route.run(scope, line.sender, line.recipient);
        if (line.hour !== undefined) statements.hour.run(scope, line.hour);
      }
    }
    updateSpool.run(delta.name, delta.dev, delta.ino, delta.end);
  }
  const removeSource = db.prepare("DELETE FROM read_source WHERE project = ?");
  const removeIds = db.prepare("DELETE FROM read_id WHERE project = ?");
  const addId = db.prepare(
    "INSERT OR IGNORE INTO read_id(project, id) VALUES (?, ?)",
  );
  const updateRead = db.prepare(
    "INSERT INTO read_source(project, dev, ino, offset) VALUES (?, ?, ?, ?) ON CONFLICT(project) DO UPDATE SET dev = excluded.dev, ino = excluded.ino, offset = excluded.offset",
  );
  for (const delta of plan.reads) {
    if (delta.reset) removeIds.run(delta.project);
    if (!delta.next) {
      removeSource.run(delta.project);
      continue;
    }
    for (const id of delta.ids) addId.run(delta.project, id);
    updateRead.run(
      delta.project,
      delta.next.dev,
      delta.next.ino,
      delta.next.offset,
    );
  }
  return true;
}

function legacyReadIds(project: string): Set<string> {
  const path = legacyReadStatePath(project);
  if (!existsSync(path)) return new Set();
  try {
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !doc ||
      typeof doc !== "object" ||
      !("read" in doc) ||
      !Array.isArray(doc.read)
    )
      return new Set();
    return new Set(
      doc.read.filter((id): id is string => typeof id === "string"),
    );
  } catch (error) {
    if (error instanceof SyntaxError) return new Set();
    throw error;
  }
}

/** How long a reader waits for another process's ingest to commit before
 * answering from the last committed projection instead. The locked section is
 * inserts only, so this bounds a peer that is starved, not one that is busy. */
const INGEST_LOCK_WAIT_MS = 5000;
const SQLITE_BUSY = 5;
/** Each lost race means another process just committed, so a replan reads
 * only what arrived since; three rounds losing in a row means sustained
 * contention, answered as not current rather than spinning. */
const INGEST_ATTEMPTS = 3;

function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "errcode" in error &&
    typeof error.errcode === "number" &&
    (error.errcode & 0xff) === SQLITE_BUSY
  );
}

/** Refresh all append-only cursors, then answer from the committed projection.
 * `current` is false when another process held the write lock past
 * INGEST_LOCK_WAIT_MS, or kept committing ahead of every replan: the answer is
 * then the last committed projection, which may omit the newest lines. */
export function indexedMessages(
  project: string | undefined,
  limit: number,
  now: Date,
): IndexedMessages {
  mkdirSync(STATE_DIR, { recursive: true });
  const db = new DatabaseSync(MESSAGE_INDEX_PATH);
  try {
    schema(db);
    // Plan without the lock, then apply under it. A plan that lost a race to
    // another process's commit is replanned from the new cursors.
    let current = false;
    db.exec(`PRAGMA busy_timeout = ${INGEST_LOCK_WAIT_MS}`);
    for (let attempt = 0; attempt < INGEST_ATTEMPTS && !current; attempt++) {
      const plan = planIngest(db);
      if (!plan.rebuild && !plan.spools.length && !plan.reads.length) {
        current = true;
        break;
      }
      try {
        db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        if (!isBusy(error)) throw error;
        break;
      }
      try {
        current = applyIngest(db, plan);
        db.exec(current ? "COMMIT" : "ROLLBACK");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    // One read transaction, so counts, positions and rollups agree.
    db.exec("BEGIN");
    try {
      return { ...answer(db, project, limit, now), current };
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
}

function answer(
  db: DatabaseSync,
  project: string | undefined,
  limit: number,
  now: Date,
): Omit<IndexedMessages, "current"> {
  const scope = project ?? GLOBAL;
  const counts = db
    .prepare("SELECT messages, threads FROM scope WHERE name = ?")
    .get(scope) as { messages: number; threads: number } | undefined;
  let projects: number;
  if (project) {
    projects = counts ? 1 : 0;
  } else {
    const row = db.prepare("SELECT count(*) AS total FROM project").get();
    if (!row || typeof row.total !== "number")
      throw new Error("invalid message index project count");
    projects = row.total;
  }
  const positions = project
    ? (db
        .prepare(
          "SELECT source, offset, length, project, id FROM position WHERE project = ? ORDER BY ts DESC, source DESC, offset DESC LIMIT ?",
        )
        .all(project, limit === 0 ? -1 : limit) as Position[])
    : (db
        .prepare(
          "SELECT source, offset, length, project, id FROM position ORDER BY ts DESC, source DESC, offset DESC LIMIT ?",
        )
        .all(limit === 0 ? -1 : limit) as Position[]);
  const legacy = new Map<string, Set<string>>();
  const marked = db.prepare(
    "SELECT 1 FROM read_id WHERE project = ? AND id = ?",
  );
  const messages = positions.map((position) => {
    const path = join(INBOX_DIR, position.source);
    const msg = JSON.parse(
      fileWindow(
        path,
        position.offset,
        position.offset + position.length,
      ).toString("utf8"),
    ) as Message;
    if (
      (msg.id !== undefined && msg.id !== position.id) ||
      msg.project !== position.project
    )
      throw new Error(`message index source changed: ${path}`);
    let old = legacy.get(position.project);
    if (!old) {
      old = legacyReadIds(position.project);
      legacy.set(position.project, old);
    }
    return {
      ...msg,
      id: position.id,
      read:
        Boolean(marked.get(position.project, position.id)) ||
        old.has(position.id),
    };
  });
  const routes = db
    .prepare(
      "SELECT sender AS `from`, recipient AS `to`, count FROM route WHERE scope = ? ORDER BY count DESC, sender, recipient",
    )
    .all(scope) as IndexedMessages["routes"];
  const top = new Date(now);
  top.setMinutes(0, 0, 0);
  const start = top.getTime() - 23 * 3_600_000;
  const hours = db
    .prepare(
      "SELECT start_ms, count FROM hour WHERE scope = ? AND start_ms BETWEEN ? AND ?",
    )
    .all(scope, start, top.getTime()) as {
    start_ms: number;
    count: number;
  }[];
  const byHour = new Map(hours.map((hour) => [hour.start_ms, hour.count]));
  const volume = Array.from({ length: 24 }, (_, i) => {
    const time = start + i * 3_600_000;
    return {
      hour: new Date(time).toISOString(),
      count: byHour.get(time) ?? 0,
    };
  });
  return {
    messages,
    totals: {
      messages: counts?.messages ?? 0,
      projects,
      threads: counts?.threads ?? 0,
    },
    routes,
    volume,
  };
}
