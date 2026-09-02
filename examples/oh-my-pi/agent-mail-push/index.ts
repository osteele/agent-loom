import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const PROTOCOL_VERSION = 2;
const STATUS_KEY = "agent-mail";
const WIDGET_KEY = "agent-mail-status";
const DEFAULT_DAEMON_URL = "http://127.0.0.1:8377";
const STATUS_REFRESH_MS = 10_000;
const USAGE_REFRESH_MS = 60_000;
const WEEK_MIN_MS = 6 * 24 * 60 * 60_000;
const WEEK_MAX_MS = 8 * 24 * 60 * 60_000;
const DEV_PORTS = new Set([3000, 3001, 4000, 8000, 8001, 8080, 9000]);
const FIELD_SEPARATOR = " · ";
const GIT_ICON = "⎇";
const JJ_ICON = "ⅉ";
const DIRECTORY_ICON = "📁";
const MAIL_ICON = "✉️";
const JOB_ICON = "⚙️";

interface MailStatus {
  name: string;
  peers: number;
  unread: number;
  unprocessed: number | undefined;
  work?: ExecutionWorkSnapshot;
}

export interface ExecutionWorkItem {
  id: string;
  resourceType: string;
  resourceKey: string;
  label?: string;
  sourcePath?: string;
  state: "working" | "waiting";
  activity?: string;
  updatedAt: string;
}

export interface ExecutionWorkSnapshot {
  version: 1;
  items: ExecutionWorkItem[];
}

interface StatusState {
  address?: string;
  sessionId?: string;
  billing?: BillingStatus;
  billingRefreshedAt?: number;
  devPorts?: number[];
  devPortsFailed: boolean;
  mail?: MailStatus;
  nodeRuntime?: string;
  git?: string;
  gitFailed: boolean;
  jj?: string;
  jjFailed: boolean;
  push: "connecting" | "online" | "offline" | "failed";
  requestWidgetRender?: () => void;
}

export interface StatusWidgetState {
  address?: string;
  billing?: BillingStatus;
  contextPercent?: number;
  effort?: string;
  git?: string;
  gitFailed?: boolean;
  jj?: string;
  jjFailed?: boolean;
  mail?: MailStatus;
  modelName?: string;
  path?: string;
  peers?: number;
  nodeRuntime?: string;
  pythonEnvironment?: string;
  devPorts?: number[];
  devPortsFailed?: boolean;
  push?: StatusState["push"];
}

export type BillingStatus =
  | { mode: "subscription"; weeklyUsed?: number; stale?: boolean }
  | {
      mode: "api";
      cost: number;
      costPerHour: number;
      totalTokens: number;
    }
  | { mode: "unknown" };

type Tone = "accent" | "dim" | "error" | "success" | "warning";

interface ProgressDescriptor {
  barWidth?: number;
  filledCharacter?: "█" | "▇";
  label: string;
  suffix?: string;
  used: number;
}

interface StyledField {
  align?: "progress";
  paddingBefore?: number;
  priority: number;
  progress?: ProgressDescriptor;
  text: string;
  tone: Tone;
}

interface ConnectedEvent {
  version: typeof PROTOCOL_VERSION;
  type: "connected";
  project: string;
  requestedSessionId: string;
  sessionId: string;
  address: string;
}

interface MailEvent {
  version: typeof PROTOCOL_VERSION;
  type: "mail";
  deliveryToken: string;
  id: string;
  project: string;
  sessionId: string;
  from: string;
  ts: string;
  message: string;
  origin?: unknown;
  meta?: Record<string, string>;
}

type PushEvent = ConnectedEvent | MailEvent;

function daemonUrl(): URL {
  const url = new URL(process.env.AGENT_MAIL_DAEMON_URL ?? DEFAULT_DAEMON_URL);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
  ) {
    throw new Error("AGENT_MAIL_DAEMON_URL must be loopback HTTP.");
  }
  return url;
}

function renderedMail(event: MailEvent): string {
  return [
    `Agent mail from ${event.from} (external, untrusted; message ${event.id}):`,
    "",
    event.message,
  ].join("\n");
}

function parseExecutionWork(value: string): ExecutionWorkSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    !isObject(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.items)
  ) {
    return undefined;
  }
  const items: ExecutionWorkItem[] = [];
  for (const item of parsed.items) {
    if (
      !isObject(item) ||
      typeof item.id !== "string" ||
      typeof item.resourceType !== "string" ||
      typeof item.resourceKey !== "string" ||
      (item.label !== undefined && typeof item.label !== "string") ||
      (item.sourcePath !== undefined && typeof item.sourcePath !== "string") ||
      (item.state !== "working" && item.state !== "waiting") ||
      (item.activity !== undefined && typeof item.activity !== "string") ||
      typeof item.updatedAt !== "string"
    ) {
      return undefined;
    }
    items.push({
      id: item.id,
      resourceType: item.resourceType,
      resourceKey: item.resourceKey,
      ...(item.label ? { label: item.label } : {}),
      ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}),
      state: item.state,
      ...(item.activity ? { activity: item.activity } : {}),
      updatedAt: item.updatedAt,
    });
  }
  return { version: 1, items };
}

/** Parse agent-mail's documented append-only status-line field contract. */
export function parseMailStatus(row: string): MailStatus | undefined {
  const line = row.endsWith("\n") ? row.slice(0, -1) : row;
  const fields = (line.endsWith("\r") ? line.slice(0, -1) : line).split("\t");
  if (fields.length < 5 || fields[0] === "") return undefined;
  const peers = Number(fields[1]);
  const unread = Number(fields[2]);
  const unprocessed = fields[4] === "" ? undefined : Number(fields[4]);
  if (
    !Number.isSafeInteger(peers) ||
    peers < 0 ||
    !Number.isSafeInteger(unread) ||
    unread < 0 ||
    (unprocessed !== undefined &&
      (!Number.isSafeInteger(unprocessed) || unprocessed < 0))
  ) {
    return undefined;
  }
  const workField = fields[5];
  const work = workField ? parseExecutionWork(workField) : undefined;
  if (workField && !work) return undefined;
  return {
    name: fields[0],
    peers,
    unread,
    unprocessed,
    ...(work ? { work } : {}),
  };
}

/** Use a proven launcher identity; otherwise request the join with OMP's id. */
export function agentMailSessionId(
  nativeSessionId: string,
  launcherSessionId = process.env.AGENT_SESSION_ID,
  launcherSessionPid = process.env.AGENT_SESSION_PID,
  currentPid = process.pid,
): string {
  const launcherId = launcherSessionId?.trim();
  if (launcherId && Number(launcherSessionPid) === currentPid)
    return launcherId;
  return nativeSessionId;
}

/** Parse a portable `ps -axo pid=,ppid=` table into the host's descendants. */
export function descendantProcessIds(
  output: string,
  rootPid: number,
): Set<number> {
  const children = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }
  const descendants = new Set([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.pop();
    if (parent === undefined) break;
    for (const child of children.get(parent) ?? []) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      pending.push(child);
    }
  }
  return descendants;
}

/** Parse lsof's stable field output, keeping listeners owned by this agent. */
export function parseListeningDevPorts(
  output: string,
  processIds: ReadonlySet<number>,
): number[] {
  const ports = new Set<number>();
  let processId: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      processId = Number.isSafeInteger(parsed) ? parsed : undefined;
      continue;
    }
    if (!line.startsWith("n") || !processId || !processIds.has(processId)) {
      continue;
    }
    const match = line.slice(1).match(/:(\d+)$/);
    if (!match) continue;
    const port = Number(match[1]);
    if (DEV_PORTS.has(port)) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

/** Parse Git's documented porcelain-v2 branch header and dirty records. */
export function parseGitStatus(output: string): string | undefined {
  let branch: string | undefined;
  let oid: string | undefined;
  let dirty = false;
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      if (head && head !== "(detached)") branch = head;
    } else if (line.startsWith("# branch.oid ")) {
      const value = line.slice("# branch.oid ".length).trim();
      if (/^[0-9a-f]+$/i.test(value)) oid = value.slice(0, 8);
    } else if (line && !line.startsWith("# ")) {
      dirty = true;
    }
  }
  const revision = branch ?? oid;
  return revision ? `${revision}${dirty ? "*" : ""}` : undefined;
}

/** Parse the tagged output emitted by the extension's jj template. */
export function parseJjStatus(output: string): string {
  const rows = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const bookmarks = rows
    .filter((line) => line.startsWith("bookmark="))
    // jj uses a presentation `*` for bookmark tracking state; this widget's
    // single trailing `*` is reserved for a dirty working copy.
    .map((line) => line.slice("bookmark=".length).replace(/\*$/, ""))
    .filter(Boolean)
    .join(",");
  const change = rows
    .find((line) => line.startsWith("change="))
    ?.slice("change=".length);
  return `${bookmarks || change || "@"}${rows.includes("dirty=1") ? "*" : ""}`;
}

function nodeRuntime(cwd: string): string | undefined {
  if (!existsSync(join(cwd, "package.json"))) return undefined;
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) {
    return "bun";
  }
  if (existsSync(join(cwd, "package-lock.json"))) return "npm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "node";
}

function truncateToCells(text: string, width: number): string {
  if (width <= 0) return "";
  if (Bun.stringWidth(text) <= width) return text;
  if (width === 1) return "…";
  let result = "";
  for (const character of text) {
    if (Bun.stringWidth(`${result}${character}…`) > width) break;
    result += character;
  }
  return `${result}…`;
}

function fitStyledFields(fields: StyledField[], width: number): StyledField[] {
  const fitted = [...fields];
  while (
    fitted.length > 1 &&
    Bun.stringWidth(fitted.map((field) => field.text).join(FIELD_SEPARATOR)) >
      width
  ) {
    let dropIndex = 0;
    for (let index = 1; index < fitted.length; index += 1) {
      const candidate = fitted[index];
      const current = fitted[dropIndex];
      if (
        candidate &&
        current &&
        (candidate.priority < current.priority ||
          (candidate.priority === current.priority && index > dropIndex))
      ) {
        dropIndex = index;
      }
    }
    fitted.splice(dropIndex, 1);
  }
  if (fitted.length === 1 && fitted[0]) {
    fitted[0] = {
      ...fitted[0],
      text: truncateToCells(fitted[0].text, width),
    };
  }
  return fitted;
}

function progressStart(fields: StyledField[]): number | undefined {
  const last = fields.at(-1);
  if (!last || last.align !== "progress") return undefined;
  if (fields.length === 1) return 0;
  return (
    Bun.stringWidth(
      fields
        .slice(0, -1)
        .map((field) => field.text)
        .join(FIELD_SEPARATOR),
    ) + Bun.stringWidth(FIELD_SEPARATOR)
  );
}

function alignTrailingProgress(
  rows: StyledField[][],
  width: number,
): StyledField[][] {
  const starts = rows.map(progressStart);
  const progressStarts = starts.filter(
    (start): start is number => start !== undefined,
  );
  if (progressStarts.length === 0) return rows;
  const target = Math.max(...progressStarts);
  if (
    rows.some((fields, rowIndex) => {
      const last = fields.at(-1);
      if (starts[rowIndex] === undefined || !last?.progress) return false;
      return target + Bun.stringWidth(progressText(last.progress, 1)) > width;
    })
  ) {
    return rows;
  }
  return rows.map((fields, rowIndex) => {
    const last = fields.at(-1);
    const start = starts[rowIndex];
    if (!last?.progress || start === undefined) return fields;
    const fixedWidth = Bun.stringWidth(progressText(last.progress, 0));
    const barWidth = Math.max(1, width - target - fixedWidth);
    return [
      ...fields.slice(0, -1),
      {
        ...last,
        paddingBefore: target - start,
        progress: { ...last.progress, barWidth },
        text: progressText(last.progress, barWidth),
      },
    ];
  });
}

function statusFields(state: StatusWidgetState): StyledField[] {
  const fields: StyledField[] = [];
  const modelName = state.modelName ?? "model ?";
  fields.push({
    priority: 100,
    text: state.effort ? `${modelName}/${state.effort}` : modelName,
    tone: state.modelName ? "accent" : "dim",
  });
  if (state.path) {
    fields.push({
      priority: 70,
      text: `${DIRECTORY_ICON} ${state.path}`,
      tone: "dim",
    });
  }
  const revision = state.jj ?? state.git;
  if (revision) {
    fields.push({
      priority: 80,
      text: `${state.jj ? JJ_ICON : GIT_ICON} ${revision}`,
      tone: revision.endsWith("*") ? "warning" : "success",
    });
  } else if (state.jjFailed || state.gitFailed) {
    fields.push({ priority: 80, text: "revision ?", tone: "dim" });
  }
  const identity = state.mail?.name ?? state.address;
  if (state.mail?.unprocessed === undefined) {
    if (identity) {
      fields.push({ priority: 60, text: `${JOB_ICON} ?`, tone: "dim" });
    }
  } else if (state.mail.unprocessed > 0) {
    fields.push({
      priority: 60,
      text: `${JOB_ICON} ${state.mail.unprocessed}`,
      tone: "warning",
    });
  }
  if (state.contextPercent !== undefined) {
    const used = Math.round(state.contextPercent);
    const progress: ProgressDescriptor = {
      filledCharacter: "▇",
      label: "ctx",
      used,
    };
    fields.push({
      align: "progress",
      priority: 90,
      progress,
      text: progressText(progress, 1),
      tone: used >= 80 ? "error" : used >= 50 ? "warning" : "success",
    });
  } else {
    fields.push({ priority: 90, text: "ctx ?", tone: "dim" });
  }
  return fields;
}

function mailFields(state: StatusWidgetState): StyledField[] {
  const fields: StyledField[] = [];
  const identity = state.mail?.name ?? state.address;
  const push = state.push ?? "connecting";
  if (push === "online") {
    fields.push({
      priority: 100,
      text: identity ?? "connected",
      tone: identity ? "accent" : "success",
    });
  } else if (push === "connecting") {
    fields.push({ priority: 100, text: "connecting", tone: "dim" });
  } else if (push === "offline") {
    fields.push({
      priority: 100,
      text: identity ? `${identity} (offline)` : "offline",
      tone: "warning",
    });
  } else {
    fields.push({
      priority: 100,
      text: "Agent Mail failed",
      tone: "error",
    });
  }

  if (state.peers !== undefined) {
    fields.push({
      priority: 90,
      text: `${state.peers} ${state.peers === 1 ? "peer" : "peers"}`,
      tone: "accent",
    });
  }
  if (state.mail) {
    if (state.mail.unread > 0) {
      fields.push({
        priority: 80,
        text: `${MAIL_ICON} ${state.mail.unread}`,
        tone: "warning",
      });
    }
  } else if (identity) {
    fields.push({ priority: 80, text: `${MAIL_ICON} ?`, tone: "dim" });
  }
  if (state.pythonEnvironment) {
    fields.push({
      priority: 15,
      text: `py ${state.pythonEnvironment}`,
      tone: "dim",
    });
  }
  if (state.nodeRuntime) {
    fields.push({ priority: 15, text: state.nodeRuntime, tone: "dim" });
  }
  if (state.devPortsFailed) {
    fields.push({ priority: 10, text: "ports ?", tone: "dim" });
  } else if (state.devPorts && state.devPorts.length > 0) {
    fields.push({
      priority: 10,
      text: `:${state.devPorts.join(",")}`,
      tone: "dim",
    });
  }
  fields.push(billingField(state.billing));
  return fields;
}

function executionFields(state: StatusWidgetState): StyledField[] {
  const items = (state.mail?.work?.items ?? []).filter(
    (item) =>
      item.resourceType === "research-plan" ||
      item.resourceType === "autonomous-loop",
  );
  return items.map((item) => {
    const name =
      item.resourceType === "research-plan"
        ? item.resourceKey
        : (item.label ?? "Autonomous Research Loop");
    const details = [
      item.state === "waiting" ? "waiting" : undefined,
      item.activity,
    ].filter((value): value is string => Boolean(value));
    return {
      priority: 100,
      text: `▶ ${name}${details.length ? ` · ${details.join(" · ")}` : ""}`,
      tone: item.state === "waiting" ? "warning" : "accent",
    };
  });
}

function usageBarParts(
  usedPercent: number,
  width: number,
  filledCharacter: "█" | "▇" = "█",
): { empty: string; filled: string } {
  const percent = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round((percent / 100) * width);
  return {
    empty: "░".repeat(width - filled),
    filled: filledCharacter.repeat(filled),
  };
}

function usageBar(
  usedPercent: number,
  width: number,
  filledCharacter: "█" | "▇" = "█",
): string {
  const parts = usageBarParts(usedPercent, width, filledCharacter);
  return `${parts.filled}${parts.empty}`;
}

function progressText(progress: ProgressDescriptor, barWidth: number): string {
  const label = progress.label.padStart(3);
  return `${label} ${usageBar(progress.used, barWidth, progress.filledCharacter)} ${String(progress.used).padStart(3)}%${progress.suffix ?? ""}`;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

function billingField(billing: BillingStatus | undefined): StyledField {
  if (!billing || billing.mode === "unknown") {
    return { priority: 95, text: "wk ?", tone: "dim" };
  }
  if (billing.mode === "api") {
    return {
      priority: 95,
      text: `API $${billing.cost.toFixed(2)} · $${billing.costPerHour.toFixed(2)}/h · ${compactNumber(billing.totalTokens)} tok`,
      tone: "error",
    };
  }
  if (billing.weeklyUsed === undefined) {
    return {
      priority: 95,
      text: billing.stale ? "wk ? (stale)" : "wk ?",
      tone: "dim",
    };
  }
  const used = Math.round(billing.weeklyUsed);
  const progress: ProgressDescriptor = {
    filledCharacter: "▇",
    label: "wk",
    suffix: billing.stale ? " ~" : undefined,
    used,
  };
  return {
    align: "progress",
    priority: 95,
    progress,
    text: progressText(progress, 1),
    tone: billing.stale
      ? "dim"
      : used >= 80
        ? "error"
        : used >= 50
          ? "warning"
          : "success",
  };
}

/** Render the moved mail status and comparison fields at the live OMP pane width. */
export function renderResidualWidget(
  state: StatusWidgetState,
  width: number,
): string[] {
  return alignTrailingProgress(
    [statusFields(state), mailFields(state), executionFields(state)].map(
      (fields) => fitStyledFields(fields, width),
    ),
    width,
  )
    .filter((fields) => fields.length > 0)
    .map((fields) =>
      fields
        .map((field, index) => {
          const separator =
            index === 0
              ? ""
              : field.progress
                ? " ".repeat(Bun.stringWidth(FIELD_SEPARATOR))
                : FIELD_SEPARATOR;
          return `${separator}${" ".repeat(field.paddingBefore ?? 0)}${field.text}`;
        })
        .join(""),
    );
}

export function renderStyledResidualWidget(
  state: StatusWidgetState,
  width: number,
  theme: { fg(color: string, text: string): string },
): string[] {
  return alignTrailingProgress(
    [statusFields(state), mailFields(state), executionFields(state)].map(
      (fields) => fitStyledFields(fields, width),
    ),
    width,
  )
    .filter((fields) => fields.length > 0)
    .map((fields) =>
      fields
        .map((field, index) => {
          const separator =
            index === 0
              ? ""
              : field.progress
                ? " ".repeat(Bun.stringWidth(FIELD_SEPARATOR))
                : FIELD_SEPARATOR;
          const padding = " ".repeat(field.paddingBefore ?? 0);
          if (field.progress) {
            const progress = field.progress;
            const parts = usageBarParts(
              progress.used,
              progress.barWidth ?? 1,
              progress.filledCharacter,
            );
            const label = progress.label.padStart(3);
            const percent = String(progress.used).padStart(3);
            return (
              (separator || padding
                ? theme.fg("dim", `${separator}${padding}`)
                : "") +
              theme.fg(field.tone, `${label} ${parts.filled}`) +
              theme.fg("dim", parts.empty) +
              theme.fg(field.tone, ` ${percent}%${progress.suffix ?? ""}`)
            );
          }
          return (
            (separator || padding
              ? theme.fg("dim", `${separator}${padding}`)
              : "") + theme.fg(field.tone, field.text)
          );
        })
        .join(""),
    );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWeeklyLimit(limit: Record<string, unknown>): boolean {
  const window = isObject(limit.window) ? limit.window : undefined;
  const duration = window?.durationMs;
  if (typeof duration === "number" && Number.isFinite(duration)) {
    return duration >= WEEK_MIN_MS && duration <= WEEK_MAX_MS;
  }
  const scope = isObject(limit.scope) ? limit.scope : undefined;
  const text = [
    limit.id,
    limit.label,
    window?.id,
    window?.label,
    scope?.windowId,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLocaleLowerCase();
  return /\b(?:7\s*d|7-?day|week(?:ly)?|wk)\b/.test(text);
}

/** Read one unambiguous provider-wide weekly bucket for the active provider. */
export function weeklyUsageForProvider(
  reports: unknown,
  provider: string,
): number | undefined {
  if (!Array.isArray(reports)) return undefined;
  const candidates: Array<{ scopedToModel: boolean; used: number }> = [];
  for (const report of reports) {
    if (!isObject(report) || report.provider !== provider) continue;
    if (!Array.isArray(report.limits)) continue;
    for (const value of report.limits) {
      if (!isObject(value) || !isWeeklyLimit(value)) continue;
      const amount = isObject(value.amount) ? value.amount : undefined;
      const fraction = amount?.usedFraction;
      if (typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
      const scope = isObject(value.scope) ? value.scope : undefined;
      candidates.push({
        scopedToModel:
          typeof scope?.modelId === "string" || typeof scope?.tier === "string",
        used: Math.max(0, Math.min(1, fraction)) * 100,
      });
    }
  }
  const providerWide = candidates.filter(
    (candidate) => !candidate.scopedToModel,
  );
  if (providerWide.length === 1) return providerWide[0]?.used;
  if (providerWide.length > 1) return undefined;
  return candidates.length === 1 ? candidates[0]?.used : undefined;
}

function findJjRoot(cwd: string): string | undefined {
  let candidate = cwd;
  while (true) {
    if (existsSync(join(candidate, ".jj"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

function billingStatus(ctx: ExtensionContext): BillingStatus | undefined {
  const model = ctx.models?.current?.() ?? ctx.model;
  if (!model) return { mode: "unknown" };
  const origin = ctx.modelRegistry.authStorage.getCredentialOrigin(
    model.provider,
  );
  if (!origin) return { mode: "unknown" };
  if (origin.kind === "oauth") return undefined;

  const usage = ctx.sessionManager.getUsageStatistics();
  const startedAt = Date.parse(ctx.sessionManager.getHeader()?.timestamp ?? "");
  const elapsedHours = Number.isFinite(startedAt)
    ? Math.max((Date.now() - startedAt) / 3_600_000, 1 / 60)
    : 1;
  return {
    mode: "api",
    cost: usage.cost,
    costPerHour: usage.cost / elapsedHours,
    totalTokens: usage.totalTokens,
  };
}

async function subscriptionBillingStatus(
  ctx: ExtensionContext,
): Promise<BillingStatus> {
  const model = ctx.models?.current?.() ?? ctx.model;
  if (!model) return { mode: "unknown" };
  const reports = await ctx.modelRegistry.authStorage.fetchUsageReports({
    baseUrlResolver: (provider) =>
      ctx.modelRegistry.getProviderBaseUrl(provider),
  });
  return {
    mode: "subscription",
    weeklyUsed: weeklyUsageForProvider(reports, model.provider),
  };
}

async function refreshStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: StatusState,
): Promise<void> {
  const sessionId =
    state.sessionId ?? agentMailSessionId(ctx.sessionManager.getSessionId());
  const mailCommand = process.env.AGENT_MAIL_BIN || "agent-mail";
  const mailPromise = pi
    .exec(
      mailCommand,
      [
        "status-line",
        "--fields",
        "--work",
        "--project",
        ctx.cwd,
        "--session",
        sessionId,
      ],
      { timeout: 5_000 },
    )
    .then((result) => {
      const parsed = parseMailStatus(result.stdout);
      if (result.stdout.trim() && !parsed) {
        pi.logger.warn("Agent Mail returned an invalid status-line document.");
      }
      return parsed;
    });

  const jjRoot = findJjRoot(ctx.cwd);
  const jjPromise = jjRoot
    ? pi
        .exec(
          "jj",
          [
            "log",
            "--no-graph",
            "-r",
            "heads(::@ & bookmarks()) | @",
            "-T",
            'if(bookmarks, "bookmark=" ++ bookmarks ++ "\\n", "") ++ if(current_working_copy, "change=" ++ change_id.shortest(8) ++ "\\n" ++ "dirty=" ++ if(empty, "0", "1") ++ "\\n", "")',
          ],
          { cwd: jjRoot, timeout: 5_000 },
        )
        .then((result) =>
          result.code === 0 ? parseJjStatus(result.stdout) : undefined,
        )
    : Promise.resolve(null);

  const gitPromise = jjRoot
    ? Promise.resolve(null)
    : pi
        .exec(
          "git",
          ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
          { cwd: ctx.cwd, timeout: 5_000 },
        )
        .then((result) =>
          result.code === 0 ? parseGitStatus(result.stdout) : undefined,
        );

  const serverPortsPromise = Promise.all([
    pi.exec("ps", ["-axo", "pid=,ppid="], { timeout: 5_000 }),
    pi.exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], {
      timeout: 5_000,
    }),
  ]).then(([processes, listeners]) => {
    if (processes.code !== 0 || listeners.code !== 0) return undefined;
    return parseListeningDevPorts(
      listeners.stdout,
      descendantProcessIds(processes.stdout, process.pid),
    );
  });

  const immediateBilling = billingStatus(ctx);
  const shouldRefreshSubscription =
    immediateBilling === undefined &&
    (state.billingRefreshedAt === undefined ||
      Date.now() - state.billingRefreshedAt >= USAGE_REFRESH_MS);
  const billingPromise = shouldRefreshSubscription
    ? subscriptionBillingStatus(ctx)
    : Promise.resolve(immediateBilling ?? state.billing);

  const [mailResult, jjResult, gitResult, serverPortsResult, billingResult] =
    await Promise.allSettled([
      mailPromise,
      jjPromise,
      gitPromise,
      serverPortsPromise,
      billingPromise,
    ]);
  state.mail = mailResult.status === "fulfilled" ? mailResult.value : undefined;
  state.nodeRuntime = nodeRuntime(ctx.cwd);
  if (jjResult.status === "fulfilled" && jjResult.value === null) {
    state.jj = undefined;
    state.jjFailed = false;
  } else if (jjResult.status === "fulfilled" && jjResult.value !== undefined) {
    state.jj = jjResult.value;
    state.jjFailed = false;
  } else {
    state.jj = undefined;
    state.jjFailed = true;
  }
  if (gitResult.status === "fulfilled" && gitResult.value === null) {
    state.git = undefined;
    state.gitFailed = false;
  } else if (
    gitResult.status === "fulfilled" &&
    gitResult.value !== undefined
  ) {
    state.git = gitResult.value;
    state.gitFailed = false;
  } else {
    state.git = undefined;
    state.gitFailed = true;
  }
  if (
    serverPortsResult.status === "fulfilled" &&
    serverPortsResult.value !== undefined
  ) {
    state.devPorts = serverPortsResult.value;
    state.devPortsFailed = false;
  } else {
    state.devPorts = undefined;
    state.devPortsFailed = true;
  }
  if (billingResult.status === "fulfilled" && billingResult.value) {
    state.billing = billingResult.value;
    if (shouldRefreshSubscription) state.billingRefreshedAt = Date.now();
  } else if (state.billing?.mode === "subscription") {
    state.billing = { ...state.billing, stale: true };
  } else {
    state.billing = { mode: "unknown" };
  }
  state.requestWidgetRender?.();
}

async function refreshStatusLoop(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: StatusState,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    await refreshStatus(pi, ctx, state);
    await waitForRetry(ctx, signal, STATUS_REFRESH_MS);
  }
}

function isPushEvent(value: unknown): value is PushEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<PushEvent>;
  return (
    event.version === PROTOCOL_VERSION &&
    (event.type === "connected" || event.type === "mail") &&
    typeof event.project === "string" &&
    typeof event.sessionId === "string" &&
    (event.type !== "connected" || typeof event.requestedSessionId === "string")
  );
}

async function acknowledge(baseUrl: URL, deliveryToken: string): Promise<void> {
  const response = await fetch(new URL("/api/v1/push/oh-my-pi/ack", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deliveryToken }),
  });
  if (!response.ok) {
    throw new Error(`agent-mail acknowledgement failed (${response.status})`);
  }
}

async function waitForRetry(
  ctx: ExtensionContext,
  signal: AbortSignal,
  milliseconds: number,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = ctx.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        ctx.clearTimer(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function consumeStream(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: StatusState,
  signal: AbortSignal,
): Promise<void> {
  const baseUrl = daemonUrl();
  const requestedSessionId = agentMailSessionId(
    ctx.sessionManager.getSessionId(),
  );
  const url = new URL("/api/v1/push/oh-my-pi", baseUrl);
  url.searchParams.set("project", ctx.cwd);
  url.searchParams.set("sessionId", requestedSessionId);
  url.searchParams.set("pid", String(process.pid));

  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw new Error(
      `agent-mail OMP push connection failed (${response.status}): ${await response.text()}`,
    );
  }
  if (
    response.headers.get("x-agent-mail-protocol") !== String(PROTOCOL_VERSION)
  ) {
    throw new Error("agent-mail returned an unsupported OMP push protocol.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let sessionId: string | undefined;
  while (!signal.aborted) {
    const result = await reader.read();
    if (result.done) break;
    buffered += decoder.decode(result.value, { stream: true });
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const value: unknown = JSON.parse(line);
      if (!isPushEvent(value)) {
        throw new Error("agent-mail returned a malformed OMP push event.");
      }
      if (value.project !== ctx.cwd) {
        throw new Error(
          "agent-mail returned an event whose exact OMP session join failed.",
        );
      }
      if (value.type === "connected") {
        if (value.requestedSessionId !== requestedSessionId) {
          throw new Error(
            "agent-mail returned a connection for another OMP session.",
          );
        }
        sessionId = value.sessionId;
        state.sessionId = sessionId;
        state.address = value.address;
        state.push = "online";
        state.requestWidgetRender?.();
        continue;
      }
      if (!sessionId || value.sessionId !== sessionId) {
        throw new Error("agent-mail returned mail for another routed session.");
      }
      pi.sendMessage(
        {
          customType: "agent-mail",
          content: renderedMail(value),
          display: true,
          attribution: "agent",
          details: { messageId: value.id, from: value.from, ts: value.ts },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      await acknowledge(baseUrl, value.deliveryToken);
    }
  }
  if (!signal.aborted) throw new Error("agent-mail OMP push stream ended.");
}

export default function agentMailExtension(pi: ExtensionAPI): void {
  pi.setLabel("Agent Mail Push");
  let controller: AbortController | undefined;

  const connect = (ctx: ExtensionContext): void => {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const state: StatusState = {
      devPortsFailed: false,
      gitFailed: false,
      jjFailed: false,
      push: "connecting",
    };
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        state.requestWidgetRender = () => tui.requestRender();
        return {
          render: (width: number) =>
            renderStyledResidualWidget(
              {
                address: state.address,
                billing: state.billing,
                contextPercent: ctx.getContextUsage()?.percent,
                effort: pi.getThinkingLevel(),
                git: state.git,
                gitFailed: state.gitFailed,
                jj: state.jj,
                jjFailed: state.jjFailed,
                mail: state.mail,
                modelName: (ctx.models?.current?.() ?? ctx.model)?.name,
                peers: state.mail?.peers,
                path: basename(ctx.cwd),
                nodeRuntime: state.nodeRuntime,
                pythonEnvironment: process.env.VIRTUAL_ENV
                  ? basename(process.env.VIRTUAL_ENV)
                  : undefined,
                devPorts: state.devPorts,
                devPortsFailed: state.devPortsFailed,
                push: state.push,
              },
              width,
              theme,
            ),
        };
      },
      { placement: "belowEditor" },
    );
    void refreshStatusLoop(pi, ctx, state, signal).catch((error) => {
      if (!signal.aborted) {
        pi.logger.warn(`Agent Mail status refresh stopped: ${String(error)}`);
      }
    });
    void (async () => {
      let retryDelay = 1_000;
      while (!signal.aborted) {
        try {
          state.push = "connecting";
          state.requestWidgetRender?.();
          await consumeStream(pi, ctx, state, signal);
          retryDelay = 1_000;
        } catch (error) {
          if (signal.aborted) return;
          state.push = "offline";
          state.requestWidgetRender?.();
          pi.logger.warn(`Agent Mail Push: ${String(error)}`);
        }
        await waitForRetry(ctx, signal, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    })().catch((error) => {
      if (signal.aborted) return;
      state.push = "failed";
      state.requestWidgetRender?.();
      pi.logger.error(`Agent Mail Push stopped: ${String(error)}`);
    });
  };

  pi.on("session_start", (_event, ctx) => connect(ctx));
  pi.on("session_switch", (_event, ctx) => connect(ctx));
  pi.on("session_branch", (_event, ctx) => connect(ctx));
  pi.on("session_tree", (_event, ctx) => connect(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    controller?.abort();
    controller = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  });
}
