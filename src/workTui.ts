/** Session-scoped, read-only work inspection. Never consults the live registry. */
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { type Key, emitKeypressEvents } from "node:readline";
import {
  type PlanListing,
  planListingLines,
  readPlanListing,
} from "./planListing.ts";
import {
  type WorkLease,
  type WorkStore,
  validateWorkProgress,
  work,
} from "./work.ts";

export interface WorkTuiOptions {
  sessionId: string;
  project: string;
  once: boolean;
}

/** Parse separately from permissive general CLI flags: no implicit selectors. */
export function workTuiOptions(
  args: string[],
  command = "work tui",
): WorkTuiOptions {
  let sessionId: string | undefined;
  let project: string | undefined;
  let once = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (
      !["--session", "--project", "--once"].includes(flag) ||
      seen.has(flag)
    ) {
      throw new Error(
        `${command} accepts only --session ID --project ABS [--once], each once`,
      );
    }
    seen.add(flag);
    if (flag === "--once") {
      once = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--") || !value.trim()) {
      throw new Error(
        `${command} requires nonempty --session ID and --project ABS`,
      );
    }
    if (flag === "--session") sessionId = value;
    else project = value;
  }
  if (!sessionId || !project || !isAbsolute(project)) {
    throw new Error(
      `${command} requires explicit --session ID and absolute existing --project ABS`,
    );
  }
  const canonical = realpathSync(project);
  if (!statSync(canonical).isDirectory())
    throw new Error(`${command} project must be a directory`);
  return { sessionId, project: canonical, once };
}

/** Escape terminal controls, including C1 OSC/CSI and Unicode direction controls. */
export function terminalText(value: string, multiline = false): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
    if (multiline && character === "\n") return "\n";
    if (multiline && character === "\t") return "    ";
    return `\\u{${character.codePointAt(0)?.toString(16)}}`;
  });
}

export const MAX_PLAN_BYTES = 1024 * 1024;

export interface WorkViewItem {
  lease: WorkLease;
  content: string;
}

export interface WorkSnapshot {
  project: string;
  sessionId: string;
  capturedAt: number;
  items: WorkViewItem[];
  unavailable?: string;
  /** The project's plans, read only when this session has no claimed work. */
  plans?: PlanListing;
}

function inside(project: string, path: string): boolean {
  const rel = relative(project, path);
  return (
    rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))
  );
}

/** A contained, regular, bounded file could not be read; the message says why. */
export class SourceUnavailable extends Error {}

/** Open nonblocking, refuse special files, verify containment and inode before reading.
 * A bounded descriptor read also limits files that grow after fstat.
 * Throws SourceUnavailable for a refused read and the filesystem error otherwise. */
export function readContainedFile(project: string, sourcePath: string): string {
  let fd: number | undefined;
  try {
    const candidate = realpathSync(resolve(project, sourcePath));
    if (!inside(project, candidate))
      throw new SourceUnavailable("path escapes project");
    if (!statSync(candidate).isFile())
      throw new SourceUnavailable("not a regular file");
    fd = openSync(
      candidate,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new SourceUnavailable("not a regular file");
    // Recheck after open: an ancestor may have changed while resolving the path.
    const current = realpathSync(candidate);
    const verified = statSync(current);
    if (
      !inside(project, current) ||
      opened.dev !== verified.dev ||
      opened.ino !== verified.ino
    ) {
      throw new SourceUnavailable("path changed while opening");
    }
    if (opened.size > MAX_PLAN_BYTES) {
      throw new SourceUnavailable(
        `unsupported size ${opened.size} bytes (limit ${MAX_PLAN_BYTES}); content not shown`,
      );
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const bytes = readSync(fd, buffer, count, buffer.length - count, count);
      if (bytes === 0) break;
      count += bytes;
    }
    if (count > opened.size || fstatSync(fd).mtimeMs !== opened.mtimeMs) {
      throw new SourceUnavailable(
        "file changed while reading; refresh to retry",
      );
    }
    return buffer.toString("utf8", 0, count).replace(/\r\n/g, "\n");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readWorkSource(project: string, sourcePath?: string): string {
  if (!sourcePath) return "Plan/source: unreported (no source path)";
  try {
    return `Plan/source content (read at refresh):\n${terminalText(readContainedFile(project, sourcePath), true)}`;
  } catch (error) {
    if (error instanceof SourceUnavailable)
      return `Plan/source unavailable: ${terminalText(error.message)}`;
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? "Plan/source missing"
      : `Plan/source unavailable: ${terminalText(String(error))}`;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Old version-1 records need no progress; malformed records are never empty work. */
function assertLease(value: unknown): asserts value is WorkLease {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    typeof value.project !== "string" ||
    !record(value.owner) ||
    typeof value.owner.id !== "string" ||
    typeof value.owner.label !== "string" ||
    (value.owner.sessionId !== undefined &&
      typeof value.owner.sessionId !== "string") ||
    !record(value.resource) ||
    typeof value.resource.type !== "string" ||
    typeof value.resource.key !== "string" ||
    (value.resource.label !== undefined &&
      typeof value.resource.label !== "string") ||
    (value.resource.sourcePath !== undefined &&
      typeof value.resource.sourcePath !== "string") ||
    (value.state !== "working" && value.state !== "waiting") ||
    (value.activity !== undefined && typeof value.activity !== "string") ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new Error("malformed version-1 work lease");
  }
  if (value.progress !== undefined) {
    if (
      !record(value.progress) ||
      typeof value.progress.current !== "number" ||
      (value.progress.total !== undefined &&
        typeof value.progress.total !== "number") ||
      (value.progress.label !== undefined &&
        typeof value.progress.label !== "string")
    ) {
      throw new Error("malformed work progress");
    }
    validateWorkProgress({
      current: value.progress.current,
      ...(value.progress.total !== undefined
        ? { total: value.progress.total }
        : {}),
      ...(value.progress.label !== undefined
        ? { label: value.progress.label }
        : {}),
    });
  }
}

export function readWorkSnapshot(
  options: WorkTuiOptions,
  store: Pick<WorkStore, "list"> = work,
  capturedAt = Date.now(),
): WorkSnapshot {
  const snapshot: WorkSnapshot = {
    project: options.project,
    sessionId: options.sessionId,
    capturedAt,
    items: [],
  };
  try {
    if (!options.sessionId.trim() || !isAbsolute(options.project)) {
      throw new Error("explicit session and absolute project required");
    }
    const project = realpathSync(options.project);
    if (!statSync(project).isDirectory())
      throw new Error("project is not a directory");
    snapshot.project = project;
    const leases = store.list(project);
    for (const lease of leases) assertLease(lease);
    snapshot.items = leases
      .filter(
        (lease) =>
          lease.owner.sessionId === options.sessionId &&
          isAbsolute(lease.project) &&
          realpathSync(lease.project) === project,
      )
      .map((lease) => ({
        lease,
        content: readWorkSource(project, lease.resource.sourcePath),
      }));
    if (!snapshot.items.length)
      snapshot.plans = readPlanListing(project, leases);
  } catch (error) {
    snapshot.unavailable = terminalText(String(error));
  }
  return snapshot;
}

export function age(timestamp: string, now: number): string {
  const seconds = Math.floor((now - Date.parse(timestamp)) / 1000);
  if (seconds < 0) return "in the future (clock skew)";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function workItemLines(item: WorkViewItem, now: number): string[] {
  const { lease } = item;
  const progress = lease.progress;
  return [
    `Resource: ${terminalText(lease.resource.type)}:${terminalText(lease.resource.key)}`,
    `Lease: ${terminalText(lease.id)}`,
    `Label: ${terminalText(lease.resource.label ?? "unreported")}`,
    `State (last reported): ${terminalText(lease.state)}`,
    `Current activity: ${terminalText(lease.activity || "unreported")}`,
    `Current position: ${progress ? `${progress.current}${progress.total === undefined ? " (total unreported)" : ` / ${progress.total}`}${progress.label ? `: ${terminalText(progress.label)}` : ""}` : "unreported"}`,
    `Created: ${terminalText(lease.createdAt)} (${age(lease.createdAt, now)})`,
    `Updated: ${terminalText(lease.updatedAt)} (${age(lease.updatedAt, now)}; last lease report, not proof of liveness)`,
    `Source path: ${terminalText(lease.resource.sourcePath ?? "unreported")}`,
    ...item.content.split("\n"),
  ];
}

function emptySnapshotLines(snapshot: WorkSnapshot): string[] {
  return snapshot.plans
    ? planListingLines(snapshot.plans, snapshot.capturedAt)
    : ["No claimed work for this exact session and project."];
}

function snapshotHeader(snapshot: WorkSnapshot): string[] {
  return [
    `Session: ${terminalText(snapshot.sessionId)}`,
    `Project: ${terminalText(snapshot.project)}`,
    `Snapshot: ${new Date(snapshot.capturedAt).toISOString()}`,
    "Activity may be stale; age does not establish whether an owner is alive.",
  ];
}

export function formatWorkSnapshot(snapshot: WorkSnapshot): string {
  const lines = snapshotHeader(snapshot);
  if (snapshot.unavailable)
    lines.push(`Work store unavailable: ${snapshot.unavailable}`);
  else if (!snapshot.items.length) lines.push(...emptySnapshotLines(snapshot));
  else
    for (const item of snapshot.items) {
      lines.push("");
      for (const line of workItemLines(item, snapshot.capturedAt))
        lines.push(line);
    }
  return lines.join("\n");
}

/** Conservative cell accounting keeps wide Unicode glyphs inside the viewport.
 * Combining marks may wrap early; no character is dropped or horizontally clipped. */
export function wrapWorkLines(lines: string[], columns: number): string[] {
  const width = Math.max(2, columns - 1);
  const wrapped: string[] = [];
  for (const line of lines) {
    let row = "";
    let cells = 0;
    for (const character of line) {
      const size = (character.codePointAt(0) ?? 0) > 127 ? 2 : 1;
      if (cells + size > width) {
        wrapped.push(row);
        row = "";
        cells = 0;
      }
      row += character;
      cells += size;
    }
    wrapped.push(row);
  }
  return wrapped;
}

/** Shared read-only terminal lifecycle. Views own their projection and viewport. */
export function runReadOnlyTerminal(view: {
  label: string;
  /** Returns false when nothing changed, so the timer skips the redraw. */
  refresh: () => boolean;
  render: (
    columns: number,
    height: number,
  ) => { lines: string[]; footer: string };
  key: (key: Key, height: number) => void;
}): void {
  let cleaned = false;
  let timer: NodeJS.Timeout | undefined;
  const wasRaw = process.stdin.isRaw;
  const signals = [
    "SIGINT",
    "SIGTERM",
    "SIGHUP",
    "SIGQUIT",
    "SIGTSTP",
  ] as const;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(timer);
    process.stdin.off("keypress", onKey);
    process.stdin.off("end", quit);
    process.stdin.off("error", fail);
    process.stdout.off("error", fail);
    process.stdout.off("resize", redraw);
    process.off("exit", cleanup);
    process.off("uncaughtExceptionMonitor", cleanup);
    for (const signal of signals) process.off(signal, quit);
    try {
      process.stdin.setRawMode(wasRaw);
    } finally {
      process.stdin.pause();
      process.stdout.write("\x1b[?25h\x1b[?1049l");
    }
  };
  const quit = (): void => {
    cleanup();
    process.exit(0);
  };
  const fail = (error: unknown): void => {
    cleanup();
    console.error(`${view.label} unavailable: ${terminalText(String(error))}`);
    process.exitCode = 1;
  };
  function redraw(): void {
    try {
      const columns = process.stdout.columns || 80;
      const height = Math.max(1, (process.stdout.rows || 24) - 1);
      if (columns < 3 || (process.stdout.rows || 24) < 2) {
        process.stdout.write("\x1b[H\x1b[2J");
        return;
      }
      const frame = view.render(columns, height);
      const visible = frame.lines.slice(0, height);
      while (visible.length < height) visible.push("");
      process.stdout.write(
        `\x1b[H\x1b[2J${visible.join("\r\n")}\r\n${frame.footer.slice(0, columns - 1)}`,
      );
    } catch (error) {
      fail(error);
    }
  }
  function onKey(_text: string, key: Key): void {
    try {
      if (key.name === "q" || (key.ctrl && key.name === "c")) {
        quit();
        return;
      }
      if (key.name === "r") view.refresh();
      else view.key(key, Math.max(1, (process.stdout.rows || 24) - 1));
      redraw();
    } catch (error) {
      fail(error);
    }
  }
  process.on("exit", cleanup);
  process.on("uncaughtExceptionMonitor", cleanup);
  for (const signal of signals) process.on(signal, quit);
  process.stdin.on("end", quit);
  process.stdin.on("error", fail);
  process.stdout.on("error", fail);
  process.stdout.on("resize", redraw);
  try {
    emitKeypressEvents(process.stdin);
    process.stdin.on("keypress", onKey);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    redraw();
    if (cleaned) return;
    timer = setInterval(() => {
      try {
        if (!view.refresh()) return;
        redraw();
      } catch (error) {
        fail(error);
      }
    }, 2000);
  } catch (error) {
    fail(error);
  }
}

export function scrollTuiOffset(
  key: Key,
  currentOffset: number,
  length: number,
  height: number,
): number {
  let offset = currentOffset;
  const page = Math.max(1, height - 1);
  if (key.name === "down" || key.name === "j") offset++;
  else if (key.name === "up" || key.name === "k") offset--;
  else if (key.name === "pagedown" || key.name === "space") offset += page;
  else if (key.name === "pageup") offset -= page;
  else if (key.name === "end" || (key.name === "g" && key.shift))
    offset = length;
  else if (key.name === "home" || key.name === "g") offset = 0;
  return Math.max(0, Math.min(offset, Math.max(0, length - height)));
}

export function runWorkTui(options: WorkTuiOptions): void {
  if (options.once || !process.stdin.isTTY || !process.stdout.isTTY) {
    const snapshot = readWorkSnapshot(options);
    process.stdout.write(`${formatWorkSnapshot(snapshot)}\n`);
    if (snapshot.unavailable) process.exitCode = 1;
    return;
  }
  let snapshot = readWorkSnapshot(options);
  let selected = 0;
  let offset = 0;
  let lines: string[] = [];
  runReadOnlyTerminal({
    label: "work tui",
    refresh() {
      const id = snapshot.items[selected]?.lease.id;
      snapshot = readWorkSnapshot(options);
      const retained = snapshot.items.findIndex((item) => item.lease.id === id);
      selected =
        retained < 0
          ? Math.min(selected, Math.max(0, snapshot.items.length - 1))
          : retained;
      if (snapshot.items[selected]?.lease.id !== id) offset = 0;
      return true;
    },
    render(columns, height) {
      const content = snapshotHeader(snapshot);
      if (snapshot.unavailable)
        content.push(`Work store unavailable: ${snapshot.unavailable}`);
      else if (!snapshot.items.length)
        content.push(...emptySnapshotLines(snapshot));
      else
        content.push(
          "",
          ...workItemLines(snapshot.items[selected], snapshot.capturedAt),
        );
      lines = wrapWorkLines(content, columns);
      offset = Math.max(
        0,
        Math.min(offset, Math.max(0, lines.length - height)),
      );
      return {
        lines: lines.slice(offset, offset + height),
        footer: `Work ${snapshot.items.length ? selected + 1 : 0}/${snapshot.items.length} | lines ${offset + 1}-${Math.min(lines.length, offset + height)}/${lines.length} | n/p lease j/k scroll PgUp/PgDn g/G r q`,
      };
    },
    key(key, height) {
      if (["n", "p", "tab", "left", "right"].includes(key.name ?? "")) {
        const backwards = key.name === "p" || key.name === "left" || key.shift;
        const count = snapshot.items.length;
        if (count) selected = (selected + (backwards ? -1 : 1) + count) % count;
        offset = 0;
      } else offset = scrollTuiOffset(key, offset, lines.length, height);
    },
  });
}
