import type { Key } from "node:readline";
import {
  type SessionMailHistory,
  type SessionMailMessage,
  readSessionMailHistory,
} from "./mailHistory.ts";
import {
  type WorkTuiOptions,
  runReadOnlyTerminal,
  scrollTuiOffset,
  terminalText,
  wrapWorkLines,
} from "./workTui.ts";

function messageLines(
  message: SessionMailMessage,
  expanded: boolean,
): string[] {
  const participants = `${terminalText(message.sender)} -> ${message.recipients.map((id) => terminalText(id)).join(", ") || "no recorded recipient"}`;
  const lines = [
    `${message.direction === "incoming" ? "IN" : "OUT"} ${terminalText(message.timestamp)} ${participants}${message.broadcast ? " [broadcast]" : ""}`,
    `Message: ${terminalText(message.id)}${message.replyTo ? ` | Reply to: ${terminalText(message.replyTo)}` : ""}`,
  ];
  if (message.threadId && message.threadId !== message.id)
    lines.push(`Thread: ${terminalText(message.threadId)}`);
  if (message.direction === "outgoing")
    lines.push(`To project: ${terminalText(message.project)}`);
  const body = terminalText(message.body, true).split("\n");
  if (expanded) lines.push(...body);
  else
    lines.push(
      `${body[0]}${body.length > 1 ? ` [+${body.length - 1} lines; Enter to expand]` : ""}`,
    );
  lines.push("");
  return lines;
}

export function formatMailHistory(history: SessionMailHistory): string {
  const lines = [
    `Session: ${terminalText(history.sessionId)}`,
    `Project: ${terminalText(history.project)}`,
    `Snapshot: ${new Date(history.generatedAt).toISOString()}`,
    "Read-only mail history; viewing does not acknowledge delivery or mark mail read.",
    "",
  ];
  if (!history.messages.length)
    lines.push("No attributable mail for this exact session and project.");
  for (const message of history.messages)
    lines.push(...messageLines(message, true));
  return lines.join("\n");
}

interface MailRow {
  key: string;
  offset: number;
  text: string;
}

/** The viewport is anchored to a message and its wrapped-line offset, not an index. */
export class MailTimeline {
  history: SessionMailHistory;
  offset = 0;
  rows: MailRow[] = [];
  readonly expanded = new Set<string>();

  constructor(history: SessionMailHistory) {
    this.history = history;
  }

  replace(history: SessionMailHistory): void {
    if (
      history.project !== this.history.project ||
      history.sessionId !== this.history.sessionId
    )
      throw new Error("Mail timeline binding changed");
    this.history = history;
  }

  render(columns: number, height: number): { lines: string[]; footer: string } {
    const anchor = this.offset > 0 ? this.rows[this.offset] : undefined;
    const rows: MailRow[] = [];
    for (const message of this.history.messages) {
      const lines = wrapWorkLines(
        messageLines(message, this.expanded.has(message.key)),
        columns,
      );
      for (let offset = 0; offset < lines.length; offset++)
        rows.push({ key: message.key, offset, text: lines[offset] });
    }
    if (anchor) {
      const retained = rows.findIndex(
        (row) => row.key === anchor.key && row.offset === anchor.offset,
      );
      if (retained >= 0) this.offset = retained;
      else {
        const start = rows.findIndex((row) => row.key === anchor.key);
        if (start >= 0) this.offset = start;
      }
    }
    this.rows = rows;
    this.offset = Math.max(
      0,
      Math.min(this.offset, Math.max(0, rows.length - height)),
    );
    return {
      lines: rows.length
        ? rows.slice(this.offset, this.offset + height).map((row) => row.text)
        : ["No attributable mail for this exact session and project."],
      footer: `Mail ${this.history.messages.length} | ${this.offset === 0 ? "following" : "anchored"} | ${terminalText(this.history.sessionId)} | Enter expand n/p message j/k PgUp/PgDn g/G r q`,
    };
  }

  key(key: Key, height: number): void {
    const current = this.rows[this.offset]?.key;
    if (key.name === "return") {
      if (current) {
        if (this.expanded.has(current)) this.expanded.delete(current);
        else this.expanded.add(current);
      }
    } else if (["n", "p", "tab", "left", "right"].includes(key.name ?? "")) {
      const index = this.history.messages.findIndex(
        (message) => message.key === current,
      );
      const backwards = key.name === "p" || key.name === "left" || key.shift;
      const next =
        this.history.messages[
          Math.max(
            0,
            Math.min(
              index + (backwards ? -1 : 1),
              this.history.messages.length - 1,
            ),
          )
        ];
      if (next)
        this.offset = Math.max(
          0,
          this.rows.findIndex((row) => row.key === next.key),
        );
    } else
      this.offset = scrollTuiOffset(key, this.offset, this.rows.length, height);
  }
}

export function runMailTui(options: WorkTuiOptions): void {
  const history = readSessionMailHistory(options.project, options.sessionId);
  if (options.once || !process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(`${formatMailHistory(history)}\n`);
    return;
  }
  const timeline = new MailTimeline(history);
  runReadOnlyTerminal({
    label: "mail tui",
    refresh() {
      timeline.replace(
        readSessionMailHistory(options.project, options.sessionId),
      );
    },
    render: (columns, height) => timeline.render(columns, height),
    key: (key, height) => timeline.key(key, height),
  });
}
