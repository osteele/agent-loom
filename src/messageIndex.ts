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

function schema(db: DatabaseSync): void {
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

type MessageStatements = {
  position: StatementSync;
  project: StatementSync;
  scope: StatementSync;
  thread: StatementSync;
  addThread: StatementSync;
  route: StatementSync;
  hour: StatementSync;
};

function addMessage(
  statements: MessageStatements,
  source: string,
  offset: number,
  length: number,
  line: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return; // A torn line does not hide later messages.
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
    return;
  const msg = parsed as Message;
  const id = msg.id ?? fallbackMessageId(line);
  const thread = msg.threadId ?? id;
  const recipient = messageRecipient(msg);
  if (typeof recipient !== "string") return;
  const sender = displayName(msg.from);
  statements.position.run(source, offset, length, msg.project, id, msg.ts);
  statements.project.run(msg.project);
  const time = Date.parse(msg.ts);
  const bucket = Number.isFinite(time) ? new Date(time) : undefined;
  bucket?.setMinutes(0, 0, 0);
  for (const scope of [GLOBAL, msg.project]) {
    statements.scope.run(scope);
    if (statements.thread.run(scope, thread).changes > 0)
      statements.addThread.run(scope);
    statements.route.run(scope, sender, recipient);
    if (bucket) statements.hour.run(scope, bucket.getTime());
  }
}

function ingestSpools(db: DatabaseSync): void {
  const statements: MessageStatements = {
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
  const updateSource = db.prepare(
    "INSERT INTO source(name, dev, ino, offset) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET dev = excluded.dev, ino = excluded.ino, offset = excluded.offset",
  );
  const names = existsSync(INBOX_DIR)
    ? readdirSync(INBOX_DIR).filter((name) => name.endsWith(".jsonl"))
    : [];
  const prior = new Map(
    (
      db.prepare("SELECT name, dev, ino, offset FROM source").all() as Source[]
    ).map((source) => [source.name, source]),
  );
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
  if (rebuild) {
    resetMessages(db);
    prior.clear();
  }
  for (const name of names) {
    const path = join(INBOX_DIR, name);
    const stat = statSync(path);
    const previous = prior.get(name);
    const start = previous?.offset ?? 0;
    if (stat.size === start) continue;
    const chunk = fileWindow(path, start, stat.size);
    let from = 0;
    for (
      let end = chunk.indexOf(10);
      end !== -1;
      end = chunk.indexOf(10, from)
    ) {
      if (end > from)
        addMessage(
          statements,
          name,
          start + from,
          end - from,
          chunk.toString("utf8", from, end),
        );
      from = end + 1;
    }
    if (from === 0) continue;
    const current = statSync(path);
    if (
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      current.size < stat.size
    )
      throw new Error(`message index source changed: ${path}`);
    updateSource.run(name, String(stat.dev), String(stat.ino), start + from);
  }
}

function ingestReads(db: DatabaseSync): void {
  const projects = db.prepare("SELECT name FROM project").all() as {
    name: string;
  }[];
  const findSource = db.prepare(
    "SELECT dev, ino, offset FROM read_source WHERE project = ?",
  );
  const removeSource = db.prepare("DELETE FROM read_source WHERE project = ?");
  const removeIds = db.prepare("DELETE FROM read_id WHERE project = ?");
  const addId = db.prepare(
    "INSERT OR IGNORE INTO read_id(project, id) VALUES (?, ?)",
  );
  const updateSource = db.prepare(
    "INSERT INTO read_source(project, dev, ino, offset) VALUES (?, ?, ?, ?) ON CONFLICT(project) DO UPDATE SET dev = excluded.dev, ino = excluded.ino, offset = excluded.offset",
  );
  for (const { name: project } of projects) {
    const path = readStatePath(project);
    const previous = findSource.get(project) as
      | Omit<Source, "name">
      | undefined;
    if (!existsSync(path)) {
      if (previous) {
        removeSource.run(project);
        removeIds.run(project);
      }
      continue;
    }
    const stat = statSync(path);
    const replaced =
      previous &&
      (previous.dev !== String(stat.dev) ||
        previous.ino !== String(stat.ino) ||
        stat.size < previous.offset);
    if (replaced) {
      removeIds.run(project);
      updateSource.run(project, String(stat.dev), String(stat.ino), 0);
    }
    const start = replaced ? 0 : (previous?.offset ?? 0);
    if (stat.size === start) continue;
    const chunk = fileWindow(path, start, stat.size);
    let from = 0;
    for (
      let end = chunk.indexOf(10);
      end !== -1;
      end = chunk.indexOf(10, from)
    ) {
      const id = chunk.toString("utf8", from, end).trim();
      if (id) addId.run(project, id);
      from = end + 1;
    }
    if (from === 0) continue;
    const offset = start + from;
    const current = statSync(path);
    if (
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      current.size < stat.size
    )
      throw new Error(`message index read log changed: ${path}`);
    updateSource.run(project, String(stat.dev), String(stat.ino), offset);
  }
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

/** Refresh all append-only cursors, then answer from the committed projection. */
export function indexedMessages(
  project: string | undefined,
  limit: number,
  now: Date,
): IndexedMessages {
  mkdirSync(STATE_DIR, { recursive: true });
  const db = new DatabaseSync(MESSAGE_INDEX_PATH);
  try {
    schema(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      ingestSpools(db);
      ingestReads(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
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
  } finally {
    db.close();
  }
}
