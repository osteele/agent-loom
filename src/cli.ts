#!/usr/bin/env node
/** agent-loom CLI.
 *
 * Messaging:
 *   agent-loom notify --project <dir> --message <text> [--from <label>] [--session <name-or-id> | --role owner] [--no-slack]
 *   agent-loom inbox [--project <dir>] [--limit N] [--unread] [--peek]
 *   agent-loom triage-candidates [--project <dir>] [--limit N]
 *   agent-loom mark-read [--project <dir>] (--id <message-id>... | --all)
 *   agent-loom listeners [--project <dir>] [--json] [--no-sync]
 *   agent-loom session-address --project <absolute-dir> --session <raw-id> --json
 *   agent-loom mute|unmute (--session <name-or-id> | --project <dir>)
 *   agent-loom claim-experiment [--project <dir>] [--notebook <dir>] [--owner <label>]
 *   agent-loom claim-path --path <path> [--path <path> ...] [--directory] [--project <dir>] [--owner <label>] [--plan <stem> [--plan-project <dir>]]
 *   agent-loom claims [--project <dir> | --all] [--history]
 *   agent-loom release-claim (--id <claim-id> | --token <release-token>) [--project <dir>]
 *   agent-loom work list [--project <dir> | --all]
 *   agent-loom work acquire --type <type> --key <key> [--project <dir>] [--owner <label>]
 *   agent-loom work update --id <work-id> [--state working|waiting]
 *   agent-loom work release --id <work-id> [--project <dir>] [--outcome completed|abandoned]
 *   agent-loom coordination list [--project <dir> | --all]
 *   agent-loom coordination recover --id <coordination-id> [--authority <text> --reason <text>]
 *   agent-loom obligations announce (--obligor <name-or-id> | --user |
 *                                  --system <name> | --component <name>)
 *                                  --kind <kind> --subject <text>
 *                                  [--description <text>]
 *                                  [--option <text> ...]
 *                                  [--marker <value> [--marker-kind path|label] [--marker-label <text>] ...]
 *   agent-loom obligations update --id <obligation-id>
 *                                  [--description <text> | --clear-description]
 *                                  [--option <text> ... | --clear-options]
 *                                  [--marker <value> ... | --clear-markers]
 *   agent-loom obligations comment --id <obligation-id> --text <text> [--user]
 *   agent-loom obligations close|withdraw --id <obligation-id>
 *   agent-loom obligations contest --id <obligation-id> --reason <text> [--user]
 *   agent-loom obligations adopt --predecessor <id> (--resume-id <id> | --authority <text> --reason <text>)
 *   agent-loom obligations owed
 *   agent-loom issues watcher-token | event
 *
 * Dashboards:
 *   agent-loom dashboard [--port N] [--open] [--no-tui]
 *   agent-loom slack-dashboard [--watch <seconds>]
 *
 * Status line:
 *   agent-loom status-line [--project <dir>] [--session <id>] [--fields] [--work] [--debug]
 *
 * Reminders (hook-driven, for pull-only harnesses):
 *   agent-loom remind --format agy|codex|kimi|gemini|pi [--event <name>] [--session <id>] [--project <dir>]
 *   agent-loom hooks install|uninstall|status [--agy] [--codex] [--kimi] [--gemini] [--gemini-after-tool]
 *
 * Daemon management (launchd-aware: uses launchctl when the LaunchAgent is
 * installed, bare pidfile mode otherwise):
 *   agent-loom start | stop | restart | graceful | status | logs [-f]
 *
 * Setup:
 *   agent-loom install     LaunchAgent (boot start) + installed-client MCP entries
 *   agent-loom uninstall
 */

// First: adopts agent-mail's environment names and state directories (legacyName.ts).
import "./legacyName.ts";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ParseError,
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
} from "jsonc-parser";
import { readAnnouncedState, writeAnnouncedState } from "./announced.ts";
import { describeChannelSetup, inspectChannelSetup } from "./channelSetup.ts";
import {
  type Claim,
  ClaimConflictError,
  type ClaimOwner,
  type PlanClaimIdentity,
  claimOwnerKind,
  claims,
  pathClaimOwnerCondition,
  pathClaimTargets,
} from "./claims.ts";
import { loadConfig } from "./config.ts";
import {
  coordinationConflictAdvice,
  ownerStatus as coordinationOwnerStatus,
  describeCoordination,
  isDisplaceable,
  listCoordination,
  recoverCoordination,
} from "./coordination.ts";
import { openBrowser, serveDashboard } from "./dashboard.ts";
import { buildReadOnlyState } from "./dashboardData.ts";
import { classifyFallback, settled, withAttemptKey } from "./delivery.ts";
import {
  type CodexRegistrationProbe,
  addNativeAuditHook,
  addReminderHookAgy,
  addReminderHookCodex,
  addReminderHookGemini,
  addReminderHookKimi,
  agyReminderHookEvents,
  classifyCodexRegistrationProbe,
  claudeRegistrationMatches,
  codexEntrySubTables,
  codexRegistrationMatches,
  codexReminderHookEvents,
  enabledAgentLoomPlugin,
  geminiReminderHookEvents,
  kimiReminderHookEvents,
  removeNativeAuditHook,
  removeOpenCodeMcpRegistration,
  removeReminderHookAgy,
  removeReminderHookCodex,
  removeReminderHookGemini,
  removeReminderHookKimi,
  removeStdioMcpRegistration,
  replaceCodexRegistrationTransaction,
  restoreCodexEntrySubTables,
  upsertOpenCodeMcpRegistration,
  upsertStdioMcpRegistration,
} from "./integrations.ts";
import { issueWatcherSessions, parseIssueLedgerEvent } from "./issueEvents.ts";
import {
  AGENT_LOOM_WATCHER_PREFIX,
  currentLedgerObligations,
  describeLedgerObligation,
  ledgerIssueOwnerRole,
  ledgerObligationRefusal,
} from "./ledgerIssues.ts";
import {
  LEGACY_LAUNCHD_LABEL,
  migrateLegacyDirectories,
} from "./legacyName.ts";
import { readSessionMailHistory } from "./mailHistory.ts";
import { selectTriageCandidates } from "./mailTriage.ts";
import { runMailTui } from "./mailTui.ts";
import { installMcpStartupDiagnostics } from "./mcpDiagnostics.ts";
// Late-bound role resolution for the process-wide store, plus
// componentProject for creation-notice delivery. Importing this module is
// what wires the singleton in the CLI process; see its own comment for the
// import-cycle reasoning.
import {
  componentProject,
  resolveObligationRole,
} from "./obligationResolution.ts";
import {
  type Obligation,
  ObligationDuplicateError,
  type ObligationKind,
  type ObligationMarker,
  type Party,
  type SessionParty,
  type Succession,
  obligations,
} from "./obligations.ts";
import {
  CHANNEL_LIFECYCLE_LOG_PATH,
  CONFIG_PATH,
  LAUNCHD_LABEL,
  LOG_PATH,
  MCP_STARTUP_FAILURES_PATH,
  PID_PATH,
  RECEIPTS_DIR,
  REMIND_DIAGNOSTICS_PATH,
  canonicalProject,
  displayName,
  ensureDirs,
} from "./paths.ts";
import {
  hostAncestorPids,
  liveInProject,
  peersInProject,
  readListenerSnapshot,
  resolveSelf,
  sessionAddress,
  statusLineName,
  unaddressedCause,
} from "./presence.ts";
import { RecipientError, resolveRecipient } from "./recipients.ts";
import {
  type InboundPolicy,
  type Registration,
  capabilityLabels,
  coalesceRegistrations,
  listLive,
  listLiveInProject,
  processCommand,
  processInfo,
  setInboundPolicy,
  setMuted,
  signalPid,
  touchInboxPoll,
} from "./registry.ts";
import {
  decideReminder,
  diagnosticDue,
  nextAnnouncedState,
  reminderHookResponse,
  reminderText,
} from "./remind.ts";
import { replyRecipient } from "./replies.ts";
import { readFileSliceSync, readStdinText, sleepSync } from "./runtime.ts";
import {
  makeSessionStatus,
  pushDeliveryFor,
  statusWorkForSession,
} from "./sessionStatus.ts";
import {
  type ClaudeSessionMeta,
  activityTag,
  claudeSessions,
  lastActivityMs,
  registrationForCallingProcess,
  resumeIdFromCommand,
  sessionIdFromEnv,
  sessionNames,
} from "./sessions.ts";
import {
  SlackDashboardUnconfigured,
  refreshSlackDashboard,
} from "./slackDashboard.ts";
import {
  type AdmissionResult,
  type DeliveryReceipt,
  type Message,
  appendMessage,
  appendMessageGuarded,
  appendReceipt,
  knownProjects,
  markAllMessagesRead,
  markMessagesRead,
  messageVisibleToSession,
  readMessages,
  readReceipts,
  senderSessionIdOf,
} from "./spool.ts";
import { stateRevision } from "./stateRevision.ts";
import {
  findWorkLease,
  flushTransferNotifications,
  transfers,
} from "./transfers.ts";
import { unreadVisibleForSession } from "./unread.ts";
import { readUnreadSummarySnapshot } from "./unreadSummary.ts";
import { unregisteredActiveSessions } from "./unregistered.ts";
import {
  readRunningJobsSnapshot,
  readWeftJobsSnapshot,
  weftJobsForSession,
} from "./weftJobs.ts";
import {
  WorkConflictError,
  type WorkLease,
  type WorkProgress,
  type WorkReleaseOutcome,
  type WorkState,
  sameWorkOwner,
  validateWorkProgress,
  work,
} from "./work.ts";
import { runWorkTui, terminalText, workTuiOptions } from "./workTui.ts";
import {
  assertGenericWorkResource,
  claimWorkspaceOwner,
  describeWorkspaceOwner,
  isWorkspaceOwnerResource,
  releaseWorkspaceOwner,
  resolveWorkspaceOwner,
  workspaceOwnerIdentity,
} from "./workspaceOwner.ts";

function capabilityTag(r: Registration): string {
  const capabilities = r.capabilities;
  if (!capabilities) return "";
  const labels = capabilityLabels(capabilities);
  return labels.length ? ` {${labels.join(",")}}` : "";
}

/** Human-facing display name followed by the stable full-name address. */
function sessionLabel(
  r: { sessionId?: string; client?: string; cwd: string },
  names = claudeSessions(),
): string {
  if (!r.sessionId) return r.client ?? "unnamed";
  const identity = sessionNames(r.sessionId, names.get(r.sessionId), r.cwd);
  return identity.displayName === identity.fullName
    ? identity.fullName
    : `${identity.displayName} (${identity.fullName})`;
}

function matchesSessionName(
  registration: Registration,
  query: string,
  names = claudeSessions(),
): boolean {
  if (registration.sessionId === query) return true;
  if (!registration.sessionId) return false;
  const identity = sessionNames(
    registration.sessionId,
    names.get(registration.sessionId),
    registration.cwd,
  );
  return (
    identity.fullName === query ||
    identity.displayName.toLocaleLowerCase() === query.toLocaleLowerCase()
  );
}

/** Recency tag ("busy" / "active" / "idle 26h — stale?") for a registry entry. */
function sessionActivity(r: Registration, names = claudeSessions()): string {
  const meta = r.sessionId ? names.get(r.sessionId) : undefined;
  return activityTag(meta?.status, lastActivityMs(r, meta));
}

const SELF = fileURLToPath(import.meta.url);
const SRC_DIR = dirname(SELF);
// ".ts" in a checkout, ".js" in a published package: the sibling entry points
// are whatever this module itself is, since the publish build emits JS and
// rewrites the imports. Hardcoding ".ts" made every registration the installer
// wrote point at a file that a package install does not contain.
const ENTRY_EXT = extname(SELF);
const DAEMON_ENTRY = join(SRC_DIR, `daemon${ENTRY_EXT}`);
// Detection accepts either installation form: a packaged CLI can manage a
// source-running daemon, and a source CLI can manage a packaged daemon.
const DAEMON_ENTRY_NAMES = ["daemon.ts", "daemon.js"];
const CHANNEL_ENTRY = join(SRC_DIR, `channel${ENTRY_EXT}`);
const NATIVE_AUDIT_ENTRY = join(SRC_DIR, `nativeAudit${ENTRY_EXT}`);
const OH_MY_PI_PLUGIN_DIR = join(
  dirname(SRC_DIR),
  "examples",
  "oh-my-pi",
  "agent-loom-push",
);
/** The Claude Code plugin directory shipped inside this installation.
 *
 * Its `.mcp.json` names an absolute interpreter and an absolute entry point,
 * so it describes one installation and cannot be shipped: a checked-in copy
 * sends an npm install's plugin at the author's working tree. `install`
 * generates it here instead, the same way every other registration is
 * generated from `runtimePath()` and the sibling entry points. */
const CLAUDE_PLUGIN_DIR = join(dirname(SRC_DIR), "plugins", "agent-loom");
const CLAUDE_PLUGIN_MCP = join(CLAUDE_PLUGIN_DIR, ".mcp.json");
const PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);
const CLAUDE_JSON = join(homedir(), ".claude.json");
const CLAUDE_SETTINGS = join(
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  "settings.json",
);
const CODEX_HOOKS_PATH = join(homedir(), ".codex", "hooks.json");
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");
const KIMI_CONFIG_PATH = join(homedir(), ".kimi-code", "config.toml");
const KIMI_MCP_PATH = join(homedir(), ".kimi-code", "mcp.json");
const GEMINI_SETTINGS_PATH = join(homedir(), ".gemini", "settings.json");
const AGY_HOOKS_PATH = join(homedir(), ".gemini", "config", "hooks.json");
const AGY_MCP_PATH = join(homedir(), ".gemini", "config", "mcp_config.json");
const OPENCODE_CONFIG_DIR = join(homedir(), ".config", "opencode");

function openCodeConfigPath(): string {
  const jsonc = join(OPENCODE_CONFIG_DIR, "opencode.jsonc");
  if (existsSync(jsonc)) return jsonc;
  const json = join(OPENCODE_CONFIG_DIR, "opencode.json");
  return existsSync(json) ? json : jsonc;
}

/** The runtime binary to launch agent-loom's other entry points with.
 *
 * Whichever interpreter is running this CLI: `node` for an npm install, `bun`
 * in a Bun checkout. Registrations and the launchd plist are written with it,
 * so an install never hardcodes a runtime the user may not have. */
function runtimePath(): string {
  return process.execPath;
}

function cmdOhMyPiPluginPath(): void {
  if (!existsSync(join(OH_MY_PI_PLUGIN_DIR, "package.json"))) {
    throw new Error(
      `Oh My Pi plugin is missing from this installation: ${OH_MY_PI_PLUGIN_DIR}`,
    );
  }
  console.log(OH_MY_PI_PLUGIN_DIR);
}

interface InstallPlan {
  schemaVersion: 1;
  runtime: string;
  entries: {
    daemon: string;
    mcp: string;
    nativeAudit: string;
  };
  launchAgent: string;
  claudePluginMcp: string;
}

/** Paths and runtime that a real install will persist. */
function installPlan(): InstallPlan {
  return {
    schemaVersion: 1,
    runtime: runtimePath(),
    entries: {
      daemon: DAEMON_ENTRY,
      mcp: CHANNEL_ENTRY,
      nativeAudit: NATIVE_AUDIT_ENTRY,
    },
    launchAgent: PLIST_PATH,
    claudePluginMcp: CLAUDE_PLUGIN_MCP,
  };
}

/** Point this installation's Claude Code plugin at this installation.
 *
 * Skipped rather than failed when the plugin directory is absent: a package
 * built without `plugins/` is still a working CLI and daemon. */
function writeClaudePluginMcp(): void {
  if (!existsSync(CLAUDE_PLUGIN_DIR)) {
    console.log(
      `no Claude Code plugin directory at ${CLAUDE_PLUGIN_DIR}; skipping its .mcp.json`,
    );
    return;
  }
  const contents = {
    mcpServers: {
      "agent-loom": {
        command: runtimePath(),
        args: [CHANNEL_ENTRY],
        env: {},
      },
    },
  };
  writeFileSync(CLAUDE_PLUGIN_MCP, `${JSON.stringify(contents, null, 2)}\n`);
  console.log(`wrote ${CLAUDE_PLUGIN_MCP}`);
}

// --- argument parsing --------------------------------------------------------

function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/** All string values of one repeatable flag, preserving command-line order. */
function repeatedFlagValues(args: string[], name: string): string[] {
  const flag = `--${name}`;
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    const value = args[i + 1];
    if (value !== undefined && !value.startsWith("--")) values.push(value);
  }
  return values;
}

// --- daemon process management ----------------------------------------------

/** The running daemon's pid, or null.
 *
 * Liveness needs identity, the same rule the registry follows: pids are
 * recycled, so `process.kill(pid, 0)` on a stale pidfile can report a daemon
 * that exited days ago and whose number now belongs to something unrelated.
 * The command column settles it -- only the daemon entry point counts. */
function daemonPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  const pid = Number(readFileSync(PID_PATH, "utf8").trim());
  if (!Number.isFinite(pid)) return null;
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  const info = processInfo([pid]).get(pid);
  // No scan is not a negative: `ps` can fail, and reporting "stopped" for a
  // daemon that is serving would send the reader to restart it for nothing.
  if (!info) return pid;
  return DAEMON_ENTRY_NAMES.some((entry) => info.command.includes(entry))
    ? pid
    : null;
}

function launchdInstalled(): boolean {
  return existsSync(PLIST_PATH);
}

function launchctl(...args: string[]): string {
  // stderr piped rather than inherited: a failure here is not always a
  // failure to the caller (an already-bootstrapped service is the normal way
  // `start` finds a running daemon), and launchd's own complaint printing
  // underneath a "daemon already running" line reads as a contradiction.
  // Node folds the captured stderr into the thrown error's message, so a
  // genuine failure still says why.
  return execFileSync("launchctl", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function guiDomain(): string {
  const uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
  return `gui/${uid}`;
}

/** Whether a daemon answers on the configured port, whatever the pidfile says.
 * The authority for "is one already running" when the pidfile is untrustworthy. */
async function daemonServing(): Promise<boolean> {
  const config = loadConfig();
  try {
    const resp = await fetch(`http://127.0.0.1:${config.port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function cmdStart(): Promise<void> {
  if (daemonPid() !== null) {
    console.log(`daemon already running (pid ${daemonPid()})`);
    return;
  }
  if (launchdInstalled()) {
    try {
      launchctl("bootstrap", guiDomain(), PLIST_PATH);
    } catch (error) {
      // Already bootstrapped is the common case here, and launchd reports it
      // as an errno rather than anything parseable. Ask the daemon itself
      // instead of the pidfile: a stale pidfile is exactly how someone ends up
      // running `start` against a daemon that is already serving.
      if (await daemonServing()) {
        console.log("daemon already running (launchd)");
        return;
      }
      throw error;
    }
    console.log("daemon started via launchd");
  } else {
    ensureDirs();
    const child = spawn(runtimePath(), [DAEMON_ENTRY], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    console.log(`daemon started (pid ${child.pid}, bare mode)`);
  }
}

function cmdStop(): void {
  const pid = daemonPid();
  if (launchdInstalled()) {
    try {
      launchctl("bootout", `${guiDomain()}/${LAUNCHD_LABEL}`);
      console.log("daemon stopped (launchd bootout)");
      return;
    } catch {
      // not bootstrapped; fall through to pid kill
    }
  }
  if (pid === null) {
    console.log("daemon not running");
    return;
  }
  if (!signalPid(pid, "SIGTERM")) {
    console.log("daemon not running");
    return;
  }
  console.log(`daemon stopped (pid ${pid})`);
}

async function cmdRestart(): Promise<void> {
  if (launchdInstalled() && daemonPid() !== null) {
    launchctl("kickstart", "-k", `${guiDomain()}/${LAUNCHD_LABEL}`);
    console.log("daemon restarted (launchd kickstart)");
    return;
  }
  cmdStop();
  // brief pause for the port to free
  sleepSync(500);
  await cmdStart();
}

function cmdGraceful(): void {
  const pid = daemonPid();
  if (pid === null) {
    console.log("daemon not running");
    return;
  }
  if (!signalPid(pid, "SIGHUP")) {
    console.log("daemon not running");
    return;
  }
  console.log(`daemon reloaded config (SIGHUP to pid ${pid})`);
}

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  const pid = daemonPid();
  console.log(`daemon: ${pid === null ? "stopped" : `running (pid ${pid})`}`);
  console.log(`launchd: ${launchdInstalled() ? "installed" : "not installed"}`);
  console.log(`port: ${config.port}`);
  console.log(`dashboard: http://127.0.0.1:${config.port}/`);
  console.log(
    `slack echo: ${config.slackWebhook ? config.slackEcho : "unconfigured"}`,
  );
  if (pid !== null) {
    try {
      const resp = await fetch(`http://127.0.0.1:${config.port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      console.log(`health: ${resp.ok ? "ok" : `HTTP ${resp.status}`}`);
    } catch {
      console.log("health: NOT RESPONDING (pid alive but port dead)");
    }
  }
  const live = listLive();
  const names = claudeSessions();
  console.log(`listening sessions: ${live.length}`);
  for (const r of live)
    console.log(
      `  ${sessionLabel(r, names)}${capabilityTag(r)} — ${r.cwd} (pid ${r.pid}) [${sessionActivity(r, names)}] [inbound:${r.inboundPolicy ?? "accept"}]${r.muted ? " [muted]" : ""}`,
    );
  // Observed state, not instructions; ~2s (`claude plugin list`), so explicit
  // commands only — never the status line or other latency-bound surfaces.
  for (const line of describeChannelSetup(
    inspectChannelSetup(CHANNEL_ENTRY),
    dirname(SRC_DIR),
  ))
    console.log(line);
}

const LOGS_ARGS = new Set(["-f", "--follow", "--mcp", "--lifecycle"]);

/** `logs` selects among three files by flag. An argument it does not know —
 * say, a flag from a newer CLI run against an older install — must fail
 * rather than fall through to the daemon log, which would print a plausible
 * answer to a different question. */
function cmdLogs(args: string[]): void {
  const unknown = args.filter((arg) => !LOGS_ARGS.has(arg));
  if (unknown.length > 0) {
    console.error(`logs: unrecognized argument: ${unknown.join(" ")}`);
    console.error("usage: agent-loom logs [-f] [--mcp|--lifecycle]");
    process.exit(1);
  }
  if (args.includes("--mcp") && args.includes("--lifecycle")) {
    console.error(
      "logs: --mcp and --lifecycle select different logs; pick one",
    );
    process.exit(1);
  }
  const follow = args.includes("-f") || args.includes("--follow");
  const path = args.includes("--mcp")
    ? MCP_STARTUP_FAILURES_PATH
    : args.includes("--lifecycle")
      ? CHANNEL_LIFECYCLE_LOG_PATH
      : LOG_PATH;
  if (!existsSync(path)) {
    console.log(`no log file yet: ${path}`);
    return;
  }
  if (follow) {
    const child = spawn("tail", ["-f", path], { stdio: "inherit" });
    process.on("SIGINT", () => child.kill());
  } else {
    const lines = readFileSync(path, "utf8").split("\n");
    console.log(lines.slice(-50).join("\n"));
  }
}

// --- messaging ----------------------------------------------------------------

/** Resolve a --project argument to an existing project directory.
 *
 * An existing path resolves directly. A bare name (or nonexistent path) is
 * matched by basename against live listeners and projects that have received
 * mail before — this catches the footgun where a relative path silently
 * resolves against the terminal's cwd and spools to a phantom project.
 */
function resolveProjectArg(arg: string): string {
  const direct = canonicalProject(arg);
  if (existsSync(direct)) return direct;

  const name = arg.split("/").filter(Boolean).pop() ?? arg;
  const candidates = new Set<string>();
  for (const r of listLive()) {
    const cwd = canonicalProject(r.cwd);
    if (cwd.split("/").pop() === name) candidates.add(cwd);
  }
  for (const project of knownProjects()) {
    if (project.split("/").pop() === name) candidates.add(project);
  }

  if (candidates.size === 1) {
    const resolved = [...candidates][0];
    console.error(`resolved project "${arg}" -> ${resolved}`);
    return resolved;
  }
  if (candidates.size > 1) {
    console.error(`project "${arg}" is ambiguous; use a full path:`);
    for (const c of candidates) console.error(`  ${c}`);
  } else {
    console.error(
      `project "${arg}" does not exist (resolved to ${direct}) and matches no live listener or known project. Use an absolute path.`,
    );
  }
  process.exit(1);
}

/** Live registrations, optionally scoped to one project, with the names each
 * session id resolves to. The one place that combines the live listing with
 * `sessionNames`, so every sender/recipient lookup sees the same names. */
type NamedSession = {
  sessionId: string;
  fullName: string;
  displayName: string;
  pid: number;
  cwd: string;
  parentPid?: number;
};

function liveNamedSessions(project?: string): NamedSession[] {
  const meta = claudeSessions();
  return (project ? listLiveInProject(project) : listLive())
    .filter((r) => r.sessionId)
    .map((r) => {
      const sid = r.sessionId as string;
      const cwd = canonicalProject(r.cwd);
      const names = sessionNames(sid, meta.get(sid), cwd);
      return {
        sessionId: sid,
        fullName: names.fullName,
        displayName: names.displayName,
        pid: r.pid,
        cwd,
        ...(r.parentPid !== undefined ? { parentPid: r.parentPid } : {}),
      };
    });
}

/** The calling agent's session, when this process provably runs inside it.
 *
 * A session id in the environment is inherited, not proved: a script or daemon
 * launched from an agent shell carries that shell's id unchanged. Adopting it
 * would attribute this process's reads and sends to a live peer that performed
 * neither — marking its mail read, or putting its address on a message it never
 * sent, so replies route confidently to the wrong agent. That is a specific
 * wrong answer, which ADR 0003 already judged worse than having none.
 *
 * The channel server is a sibling of this process under the host agent, not an
 * ancestor of it, so the registration's `parentPid` is the pid that must appear
 * in our own ancestor chain. A registration without one cannot be proved and is
 * therefore not adopted. */
function callingSession(project?: string): NamedSession | undefined {
  const sessionId = sessionIdFromEnv();
  const sessions = liveNamedSessions(project);
  if (!sessionId) {
    // In-process hosts can launch tools without exporting a session id. An
    // exact registered parent identifies that caller; walking farther would
    // attribute an unregistered nested agent to its outer host.
    const hosts = sessions.filter(
      (s) => s.pid === process.ppid && s.parentPid === process.ppid,
    );
    return hosts.length === 1 ? hosts[0] : undefined;
  }
  const candidate = sessions.find((s) => s.sessionId === sessionId);
  if (candidate?.parentPid === undefined) return undefined;
  return hostAncestorPids().includes(candidate.parentPid)
    ? candidate
    : undefined;
}

async function cmdNotify(
  flags: Record<string, string | boolean>,
): Promise<void> {
  // EventSettles (specs/obligations.allium): weft's configured notification
  // command runs once per finished job with the WEFT_JOB_* variables
  // exported. That command running IS the completion event, so the wait
  // settles here — deterministically, before anything about mail delivery
  // can fail, and without trusting the job's exit status: a job that
  // finished unsuccessfully still completed, and the wait was for the
  // event, not for a good outcome.
  const weftJobId = process.env.WEFT_JOB_ID?.trim();
  if (weftJobId) {
    const settled = obligations.settleByEvent("weft", weftJobId);
    if (settled.length > 0) {
      console.error(
        `settled ${settled.length} job_completion obligation(s) on weft job ${weftJobId}`,
      );
    }
  }
  const project = flags.project;
  const message = flags.message;
  if (typeof project !== "string" || typeof message !== "string") {
    console.error(
      "usage: agent-loom notify --project <dir> --message <text> [--from <label>] [--session <name-or-id> | --role owner] [--reply-to <id>] [--idempotency-key <key>] [--ttl <seconds>] [--no-slack]",
    );
    process.exit(1);
  }
  if (
    flags.session !== undefined &&
    (typeof flags.session !== "string" || flags.session.trim() === "")
  ) {
    console.error(
      "--session requires a nonempty name or ID. Nothing was sent.",
    );
    process.exit(1);
  }
  const config = loadConfig();
  const sourceProject = resolveProjectArg(project);
  let resolvedProject = sourceProject;
  if (flags.role !== undefined && flags.role !== "owner")
    throw new Error("--role supports only owner");
  if (flags.role && flags.session !== undefined)
    throw new Error("select --role owner or --session, not both");
  const replyTo =
    typeof flags["reply-to"] === "string" ? flags["reply-to"] : undefined;
  const idempotencyKey =
    typeof flags["idempotency-key"] === "string"
      ? flags["idempotency-key"]
      : undefined;
  const ttlSeconds =
    typeof flags.ttl === "string" ? Number(flags.ttl) : undefined;
  if (
    ttlSeconds !== undefined &&
    (!Number.isFinite(ttlSeconds) || ttlSeconds < 0)
  ) {
    console.error("--ttl must be a non-negative number of seconds");
    process.exit(1);
  }
  // The sender is addressable only when its own registration is live and this
  // process runs inside it: stamping a dead, invented, or inherited id would
  // put a name on the message that either resolves to nobody or resolves to the
  // wrong agent. With one, `fromName` carries the full name (the address form)
  // and an unpassed --from defaults to the display name.
  // Sending carries our return address across projects. Inbox reads remain
  // project-scoped because attribution there also marks the messages read.
  const sender = callingSession();
  const from =
    typeof flags.from === "string"
      ? flags.from
      : (sender?.displayName ?? "cli");
  const suppressSlack = flags["no-slack"] === true;
  // An addressed message is hidden from every other session in the project
  // (spool.ts `messageVisibleToSession`), so resolving here is the whole of
  // the fan-out fix — no delivery-path change is needed.
  let toSession: string | undefined;
  let ownerSource: "assigned" | "inferred" | undefined;
  const parent = replyTo
    ? (readMessages(resolvedProject, 0).find((m) => m.id === replyTo) ??
      (sender && sender.cwd !== resolvedProject
        ? readMessages(sender.cwd, 0).find((m) => m.id === replyTo)
        : undefined))
    : undefined;
  if (replyTo && !parent) {
    console.error(`reply parent "${replyTo}" was not found. Nothing was sent.`);
    process.exit(1);
  }
  if (
    replyTo &&
    !flags.role &&
    !(typeof flags.session === "string" && flags.session !== "")
  ) {
    const recipient = replyRecipient(parent, listLive());
    if (!recipient.ok) {
      console.error(
        `${recipient.error}; select the recipient's --project and --session explicitly. Nothing was sent.`,
      );
      process.exit(1);
    }
    if (recipient.project !== resolvedProject) {
      console.error(
        `replying to ${recipient.sessionId} in ${recipient.project}`,
      );
    }
    resolvedProject = recipient.project;
    toSession = recipient.sessionId;
  }
  if (typeof flags.session === "string") {
    const recipient = resolveRecipient(sourceProject, flags.session);
    resolvedProject = recipient.project;
    toSession = recipient.sessionId;
  }
  if (flags.role === "owner") {
    const owner = resolveWorkspaceOwner(resolvedProject);
    if (owner.status !== "resolved")
      throw new Error(`${describeWorkspaceOwner(owner)}. Nothing was sent.`);
    toSession = owner.sessionId;
    ownerSource = owner.source;
    console.error(`sending to ${describeWorkspaceOwner(owner)}`);
  }
  const meta: Record<string, string> = {
    fromProject: sender?.cwd ?? sourceProject,
    sourceProject,
    fromCwd: canonicalProject(process.cwd()),
  };
  if (toSession) meta.toSession = toSession;
  if (ownerSource) {
    meta.toRole = "owner";
    meta.ownerSource = ownerSource;
  }
  if (sender) {
    meta.sessionId = sender.sessionId;
    meta.fromName = sender.fullName;
  }
  const hasMeta = Object.keys(meta).length > 0;
  // One message, used for both the daemon POST and the fallback append. The
  // attempt key is what lets the fallback recognise a message the daemon had
  // already stored before its reply went missing.
  const attempt = withAttemptKey({
    ts: new Date().toISOString(),
    from,
    project: resolvedProject,
    message,
    origin: {
      kind: "automation",
      transport: "cli",
      authority: "untrusted",
      // Same proof that stamps meta.sessionId: only a verified live
      // registration whose host process is an ancestor of this process
      // (decision 0014) may put its id on the envelope. The id lives in
      // `origin` too so every reader needs one canonical field, not a
      // per-transport private convention.
      ...(sender ? { sessionId: sender.sessionId } : {}),
    },
    ...(hasMeta ? { meta } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(parent ? { threadId: parent.threadId ?? parent.id } : {}),
    ...(suppressSlack ? { slackEcho: false } : {}),
  });
  const body = JSON.stringify({
    ...attempt,
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
  });
  try {
    const resp = await fetch(`http://127.0.0.1:${config.port}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      // The daemon's verdict carries a reason, and reading it as `{status, id}`
      // discarded the one distinction that matters: a sender meeting its own
      // retried attempt has succeeded, and was being told it sent a duplicate.
      const outcome = classifyFallback((await resp.json()) as AdmissionResult);
      switch (outcome.kind) {
        case "rate_limited":
          console.error(`rate limited; retry in ${outcome.retryAfterSeconds}s`);
          process.exit(1);
          break;
        case "already-delivered":
          console.log(
            `spooled ${outcome.id} via daemon (an earlier attempt of this send reached the spool; its reply never arrived)`,
          );
          break;
        case "duplicate":
          console.log(
            `already sent as ${outcome.id}; this duplicate was not spooled again`,
          );
          break;
        case "spooled":
          console.log(`spooled ${outcome.id} via daemon`);
          break;
      }
      return;
    }
    console.error(`daemon error: HTTP ${resp.status} ${await resp.text()}`);
    process.exit(1);
  } catch {
    // The daemon gave no usable answer. It may still have appended the message
    // and lost only the reply, so the outcome below distinguishes that from a
    // genuine duplicate rather than reporting both as suppressed.
    const outcome = classifyFallback(
      appendMessageGuarded(
        {
          ...attempt,
          ...(ttlSeconds !== undefined
            ? {
                expiresAt: new Date(
                  Date.now() + ttlSeconds * 1000,
                ).toISOString(),
              }
            : {}),
        },
        {
          duplicateWindowSeconds: config.duplicateWindowSeconds,
          messageRateLimitPerMinute: config.messageRateLimitPerMinute,
          defaultMessageTtlSeconds: config.defaultMessageTtlSeconds,
        },
      ),
    );
    switch (outcome.kind) {
      case "rate_limited":
        console.error(`rate limited; retry in ${outcome.retryAfterSeconds}s`);
        process.exit(1);
        break;
      case "already-delivered":
        console.log(
          `spooled ${outcome.id} via daemon (an earlier attempt of this send reached the spool; its reply never arrived)`,
        );
        break;
      case "duplicate":
        console.log(
          `already sent as ${outcome.id}; this duplicate was not spooled again`,
        );
        break;
      case "spooled":
        console.log(
          `daemon unreachable; spooled ${outcome.id} directly (no Slack echo)`,
        );
        break;
    }
  }
}

/** The watcher command runs under issues' shell, not under a daemon identity.
 * Only the CLI host-process proof can mint a token for that shell. */
function cmdIssuesWatcherToken(): void {
  const caller = callingSession();
  if (caller) console.log(`${AGENT_LOOM_WATCHER_PREFIX}${caller.sessionId}`);
}

/** Keep issue-ledger messages on the same guarded daemon/direct-spool delivery
 * path as notify. Resolve an exact live mailbox before either route: unlike a
 * general notify, losing this recipient must never become a broadcast. */
async function sendIssueNotice(
  sessionId: string,
  message: string,
): Promise<void> {
  let recipient: ReturnType<typeof resolveRecipient>;
  try {
    recipient = resolveRecipient(process.cwd(), sessionId, true);
  } catch (error) {
    console.error(
      `issue-ledger: watcher/owner session ${sessionId} skipped: ${String(error)}`,
    );
    return;
  }
  const config = loadConfig();
  const attempt = withAttemptKey({
    ts: new Date().toISOString(),
    from: "issue-ledger",
    project: recipient.project,
    message,
    origin: { kind: "automation", transport: "cli", authority: "untrusted" },
    meta: {
      toSession: sessionId,
      sourceProject: recipient.project,
      fromProject: recipient.project,
      fromCwd: canonicalProject(process.cwd()),
    },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attempt),
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      const outcome = classifyFallback(
        (await response.json()) as AdmissionResult,
      );
      if (outcome.kind === "rate_limited")
        console.error(`issue-ledger: notice to ${sessionId} rate limited`);
      return;
    }
    // A live recipient can go away between local resolution and daemon
    // admission. Never fall back after the daemon has refused that address.
    if (response.status < 500) {
      console.error(
        `issue-ledger: notice to ${sessionId} skipped: HTTP ${response.status}`,
      );
      return;
    }
  } catch {
    // No usable daemon answer; the attempt key deduplicates a lost reply.
  }
  try {
    const stillLive = resolveRecipient(process.cwd(), sessionId, true);
    if (stillLive.project !== recipient.project) {
      console.error(
        `issue-ledger: session ${sessionId} moved mailboxes; notice skipped`,
      );
      return;
    }
    const outcome = classifyFallback(
      appendMessageGuarded(attempt, {
        duplicateWindowSeconds: config.duplicateWindowSeconds,
        messageRateLimitPerMinute: config.messageRateLimitPerMinute,
        defaultMessageTtlSeconds: config.defaultMessageTtlSeconds,
      }),
    );
    if (outcome.kind === "rate_limited")
      console.error(`issue-ledger: notice to ${sessionId} rate limited`);
  } catch (error) {
    console.error(
      `issue-ledger: session ${sessionId} skipped: ${String(error)}`,
    );
  }
}

async function cmdIssuesEvent(): Promise<void> {
  let event: ReturnType<typeof parseIssueLedgerEvent>;
  try {
    event = parseIssueLedgerEvent(await readStdinText());
  } catch (error) {
    console.error(`issue-ledger: ${String(error)}`);
    process.exitCode = 2;
    return;
  }
  const { issue } = event;
  const ownerEvents = ["reported", "recurred", "reopened"];
  if (ownerEvents.includes(event.event)) {
    const role = ledgerIssueOwnerRole({
      component: issue.component,
      componentPath: issue.component_path,
    });
    const owner = resolveObligationRole(role);
    if (owner) {
      await sendIssueNotice(
        owner,
        `Issue ${issue.id}: ${issue.title} (severity: ${issue.severity ?? "unspecified"}). Fix needed; see issues show ${issue.id}`,
      );
    } else {
      const project = componentProject(role.component);
      const reason = project
        ? describeWorkspaceOwner(resolveWorkspaceOwner(project))
        : issue.component_path
          ? `no resolvable project for component path ${issue.component_path}`
          : `no component path and component "${issue.component}" has no unique project (missing or ambiguous)`;
      console.error(
        `issue-ledger: issue ${issue.id} owner unresolved: ${reason}`,
      );
    }
  }
  if (["closed", "recurred", "reopened"].includes(event.event)) {
    const reason = issue.close_reason ?? "unspecified";
    for (const sessionId of issueWatcherSessions(issue.watchers)) {
      await sendIssueNotice(
        sessionId,
        event.event === "closed"
          ? `Issue ${issue.id}: ${issue.title} closed (reason: ${reason}). See issues show ${issue.id}`
          : `Issue ${issue.id}: ${issue.title} ${event.event}. See issues show ${issue.id}`,
      );
    }
  }
  // Event changes are committed before this hook. The daemon owns the snapshot
  // writer; request an early tick without delaying or failing an offline hook.
  try {
    await fetch(
      `http://127.0.0.1:${loadConfig().port}/api/v1/ledger-issues/refresh`,
      {
        method: "POST",
        signal: AbortSignal.timeout(500),
      },
    );
  } catch {
    // The daemon is optional; the periodic refresh will cover a later start.
  }
}

function cmdInbox(flags: Record<string, string | boolean>): void {
  const project =
    typeof flags.project === "string"
      ? resolveProjectArg(flags.project)
      : canonicalProject(process.cwd());
  const limit = typeof flags.limit === "string" ? Number(flags.limit) : 20;
  const peek = flags.peek === true;
  const json = flags.json === true;
  // A CLI inbox read is an explicit inbox check, so it stamps the same signal
  // the MCP check_inbox tool does; without it a CLI-only session reads as idle
  // while it works. Attribution is what needs proving, not the read itself.
  const self = callingSession(project);
  const sessionId = self?.sessionId;
  if (self) {
    touchInboxPoll(project, self.pid);
  }
  const matched = readMessages(project, {
    limit: 0,
    unreadOnly: flags.unread === true,
  });
  const messages = limit > 0 ? matched.slice(-limit) : matched;
  // This reads the whole project inbox across every session, which is a
  // different question from the one `status-line` and the check_inbox tool
  // answer — they report the subset one session may see. All three rendered a
  // bare integer, and a reader compared them as though they measured the same
  // thing. Say which question this number answers.
  const projectUnread = readMessages(project, {
    limit: 0,
    unreadOnly: true,
  }).length;
  const scope = (returned: number): string => {
    const omitted = matched.length - returned;
    const more =
      omitted > 0
        ? `; ${omitted} older match not shown — raise \`--limit\` to see them`
        : "";
    return `[returned ${returned} of ${matched.length} matching in this project across all sessions; ${projectUnread} unread in this project${more}; not scoped to a session — status-line and check_inbox report one session's subset]`;
  };

  const acknowledged =
    sessionId === undefined
      ? []
      : messages.filter((message) =>
          messageVisibleToSession(message, sessionId),
        );
  let marked = 0;
  if (sessionId && !peek) {
    const receipts = readReceipts(project);
    for (const message of acknowledged) {
      if (settled(receipts, message.id, sessionId)) continue;
      appendReceipt(project, {
        messageId: message.id,
        ts: new Date().toISOString(),
        status: "pushed",
        sessionId,
        detail: "cli inbox",
      });
    }
    marked = markMessagesRead(
      project,
      acknowledged
        .filter((message) => !message.read)
        .map((message) => message.id),
      sessionId,
    );
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          project,
          scope: "project",
          generatedAt: new Date().toISOString(),
          readerSessionId: sessionId ?? null,
          peek,
          counts: {
            matching: matched.length,
            returned: messages.length,
            omitted: matched.length - messages.length,
            projectUnread,
            readerVisible: acknowledged.length,
            markedRead: marked,
          },
          messages: messages.map((message) => ({
            id: message.id,
            ts: message.ts,
            read: message.read,
            message: message.message,
            sender: {
              project: message.from,
              name: message.meta?.fromName ?? null,
              sessionId: senderSessionIdOf(message),
            },
            toSession: message.meta?.toSession ?? null,
            replyTo: message.replyTo ?? null,
            threadId: message.threadId ?? null,
            origin: message.origin ?? null,
          })),
        },
        null,
        2,
      ),
    );
  } else if (messages.length === 0) {
    console.log(`inbox empty ${scope(0)}`);
  } else {
    for (const message of messages) {
      const reply = message.replyTo ? ` ↩${message.replyTo.slice(0, 8)}` : "";
      const senderName =
        message.meta?.fromName ?? message.meta?.sessionId?.slice(0, 8);
      const sender = senderName
        ? `${displayName(message.from)} (${senderName})`
        : displayName(message.from);
      console.log(
        `${message.id} ${message.read ? "read" : "unread"} [${message.ts}] from ${sender}${reply}: ${message.message}`,
      );
    }
    console.log(scope(messages.length));
    if (marked > 0) {
      console.log(`marked ${marked} message(s) read`);
    }
  }

  if (!sessionId && messages.length > 0) {
    console.error(
      "note: no verified agent session for this process; this read is unattributed and leaves the messages spooled",
    );
  }
}

function cmdTriageCandidates(flags: Record<string, string | boolean>): void {
  const project =
    typeof flags.project === "string"
      ? resolveProjectArg(flags.project)
      : canonicalProject(process.cwd());
  const limit = typeof flags.limit === "string" ? Number(flags.limit) : 20;
  if (!Number.isInteger(limit) || limit < 0) {
    console.error("agent-loom: --limit must be a non-negative integer");
    process.exit(1);
  }
  const generatedAt = new Date();
  const receipts = readReceipts(project);
  const liveSessionIds = [
    ...new Set(
      listLiveInProject(project)
        .map((entry) => entry.sessionId)
        .filter((id): id is string => Boolean(id)),
    ),
  ].sort();
  const recentlyActiveUnregisteredSessions = unregisteredActiveSessions(
    receipts,
    new Set(liveSessionIds),
    generatedAt.getTime(),
    60 * 60_000,
  ).filter((session) => session.project === project);
  const protectedRecipientSessionIds = [
    ...new Set([
      ...liveSessionIds,
      ...recentlyActiveUnregisteredSessions.map((session) => session.sessionId),
    ]),
  ].sort();
  const selection = selectTriageCandidates(
    readMessages(project, { limit: 0, unreadOnly: true }),
    receipts,
    protectedRecipientSessionIds,
    generatedAt.getTime(),
  );
  const messages =
    limit > 0 ? selection.messages.slice(0, limit) : selection.messages;
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        project,
        generatedAt: generatedAt.toISOString(),
        liveSessionIds,
        recentlyActiveUnregisteredSessions,
        protectedRecipientSessionIds,
        counts: selection.counts,
        limit,
        returned: messages.length,
        truncated: messages.length < selection.messages.length,
        messages,
      },
      null,
      2,
    ),
  );
}

function cmdMarkRead(
  flags: Record<string, string | boolean>,
  args: string[],
): void {
  const project =
    typeof flags.project === "string"
      ? resolveProjectArg(flags.project)
      : canonicalProject(process.cwd());
  const ids = repeatedFlagValues(args, "id");
  const idFlagCount = args.filter((arg) => arg === "--id").length;
  if (flags.all === true && idFlagCount > 0) {
    console.error("agent-loom: --all cannot be combined with --id");
    process.exit(1);
  }
  if (ids.length !== idFlagCount) {
    console.error("agent-loom: --id requires a message id");
    process.exit(1);
  }
  if (flags.all === true) {
    console.log(`marked ${markAllMessagesRead(project)} message(s) read`);
    return;
  }
  if (ids.length === 0) {
    console.error(
      "usage: agent-loom mark-read [--project <dir>] (--id <message-id>... | --all)",
    );
    process.exit(1);
  }
  console.log(`marked ${markMessagesRead(project, ids)} message(s) read`);
}

function cmdReceipts(flags: Record<string, string | boolean>): void {
  const project =
    typeof flags.project === "string"
      ? resolveProjectArg(flags.project)
      : canonicalProject(process.cwd());
  const messageId = typeof flags.id === "string" ? flags.id : undefined;
  const limit = typeof flags.limit === "string" ? Number(flags.limit) : 50;
  const receipts = readReceipts(project, messageId).slice(-limit);
  if (receipts.length === 0) {
    console.log("no delivery receipts");
    return;
  }
  for (const receipt of receipts) {
    console.log(
      `${receipt.messageId} ${receipt.status} [${receipt.ts}]${receipt.sessionId ? ` session=${receipt.sessionId}` : ""}${receipt.detail ? ` (${receipt.detail})` : ""}`,
    );
  }
}

/** Advisory identity from the supported snapshot, never a registry scan. */
function cmdSessionAddress(flags: Record<string, string | boolean>): void {
  if (
    typeof flags.project !== "string" ||
    !isAbsolute(flags.project) ||
    !existsSync(flags.project) ||
    !statSync(flags.project).isDirectory()
  ) {
    console.error(
      "agent-loom: --project must be an explicit absolute existing directory",
    );
    process.exit(1);
  }
  if (typeof flags.session !== "string" || !flags.session.trim()) {
    console.error(
      "agent-loom: --session must be an explicit nonempty raw session ID",
    );
    process.exit(1);
  }
  if (flags.json !== true) {
    console.error("agent-loom: session-address requires --json");
    process.exit(1);
  }
  const project = canonicalProject(flags.project);
  const now = Date.now();
  const snapshot = readListenerSnapshot(project, now);
  // Validate only identity/activity fields consumed here. Do not join metadata
  // or names: the snapshot is the sole source of registration evidence.
  const valid = snapshot.sessions.every(
    (r) =>
      (r.sessionId === undefined || typeof r.sessionId === "string") &&
      typeof r.started === "string" &&
      (r.lastSeen === undefined || typeof r.lastSeen === "string"),
  );
  // A malformed candidate must not turn an ambiguous host into a unique one.
  const sessions = valid ? snapshot.sessions : [];
  const meta = new Map<string, ClaudeSessionMeta>();
  const exact = resolveSelf(sessions, flags.session, meta, now).self;
  const self =
    exact ??
    (sessions.length > 0
      ? resolveSelf(sessions, flags.session, meta, now, hostAncestorPids()).self
      : undefined);
  const sessionId = self?.sessionId?.trim() ? self.sessionId : null;
  console.log(
    JSON.stringify({
      version: 1,
      project,
      requestedSessionId: flags.session,
      sessionId,
      parentPid:
        sessionId !== null &&
        Number.isSafeInteger(self?.parentPid) &&
        (self?.parentPid ?? 0) > 0
          ? self?.parentPid
          : null,
      // Registration.procStart identifies the MCP sibling, not its host.
      procStart: null,
    }),
  );
}

function cmdListeners(flags: Record<string, string | boolean>): void {
  const project =
    typeof flags.project === "string"
      ? flags["no-sync"] === true
        ? canonicalProject(flags.project)
        : resolveProjectArg(flags.project)
      : undefined;
  const snapshot =
    flags["no-sync"] === true ? readListenerSnapshot(project) : undefined;
  const live = coalesceRegistrations(
    snapshot
      ? snapshot.sessions
      : listLive().filter(
          (registration) =>
            project === undefined ||
            canonicalProject(registration.cwd) === project,
        ),
  );
  if (flags.json === true) {
    console.log(
      JSON.stringify(
        snapshot
          ? { ...snapshot, sessions: live }
          : {
              version: 1,
              source: "live-registry",
              fresh: true,
              generatedAt: Date.now(),
              sessions: live,
            },
        null,
        2,
      ),
    );
    return;
  }
  if (snapshot && !snapshot.fresh) {
    console.log("no fresh presence snapshot; no sessions reported");
    return;
  }
  if (live.length === 0) {
    console.log("no sessions listening");
    return;
  }
  const names = claudeSessions();
  for (const r of live) {
    console.log(
      `${sessionLabel(r, names)}${capabilityTag(r)} — ${r.cwd} (pid ${r.pid}, since ${r.started}) [${sessionActivity(r, names)}] [inbound:${r.inboundPolicy ?? "accept"}]${r.muted ? " [muted]" : ""}`,
    );
  }
}

// --- status line -------------------------------------------------------------

/** Status-line and hook payload fields this command consumes.
 *
 * Claude Code supplies session_id plus workspace paths. Kimi supplies cwd;
 * its agent-loom identity comes from the launcher-minted AGENT_SESSION_ID,
 * because Kimi's payload sessionId belongs to a different namespace. Agy
 * supplies workspacePaths and inherits the launcher identity in hook commands. */
interface StatusLinePayload {
  session_id?: string;
  cwd?: string;
  workspace?: { current_dir?: string; project_dir?: string };
  workspacePaths?: string[];
}

/** Read a client status-line payload from stdin when there is one.
 *
 * The tty guard matters: supported clients pipe the payload in, but someone
 * running this by hand has an interactive stdin and would otherwise hang
 * waiting for input that never comes. */
async function readStatusLinePayload(): Promise<StatusLinePayload | undefined> {
  if (process.stdin.isTTY) return undefined;
  try {
    const text = await readStdinText();
    return text.trim() ? (JSON.parse(text) as StatusLinePayload) : undefined;
  } catch {
    // Not JSON, or nothing arrived. Fall through to the flags rather than
    // failing — this command's job is to stay out of the way.
    return undefined;
  }
}

/** Print the resolved session's display name or structured status.
 *
 * Name and TSV modes always exit 0, including on error, for existing shell
 * substitutions. JSON mode reports unresolved identity as null and fails
 * explicitly on collection errors so structured clients can retain stale data.
 *
 * Resolves the project with `canonicalProject` rather than `resolveProjectArg`:
 * this addresses no mailbox, and `resolveProjectArg` both rejects unknown
 * directories and runs a full process scan, neither of which belongs on a path
 * that re-runs several times a second. */
/** Messages this session has not read, counting only those it can see: a
 * project spool is shared, and read state with it, but a session does not see
 * its own sends or another session's directed mail, and a message it refused
 * or let expire no longer counts. */
function unreadForSession(project: string, sessionId: string): number {
  return unreadVisibleForSession(project, sessionId).length;
}

/** Unprocessed weft jobs submitted by this session, or "" when nobody knows.
 *
 * The empty string covers a stopped daemon, a snapshot past its TTL, and a
 * weft that never ran, all of which are the same thing to a reader: no claim
 * is being made. A count of 0 is a different statement, and says weft was
 * asked. Never runs weft here — the query takes seconds and Claude Code drops
 * the entire status line when the script overruns its budget. */
function weftJobsField(sessionId: string | undefined): string {
  const count = weftJobsForSession(sessionId);
  return count === undefined ? "" : String(count);
}

/** Versioned execution-work document for status clients that opt into it.
 *
 * Work is read from agent-loom's own supported store here, not by the display
 * scraping `work list` output or opening the store itself. An empty field means
 * the source could not be read; a successful read with no work is the explicit
 * `{version: 1, items: []}` document. */
function statusLineWorkField(
  project: string,
  sessionId: string | undefined,
  sessions: Registration[],
  debug: boolean,
): string {
  if (!sessionId) return "";
  try {
    return JSON.stringify(
      statusWorkForSession(work.list(project), sessionId, sessions),
    );
  } catch (error) {
    if (debug) console.error(`status-line work failed: ${error}`);
    return "";
  }
}

async function cmdStatusLine(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const debug = flags.debug === true;
  try {
    const payload = await readStatusLinePayload();
    const project = canonicalProject(
      typeof flags.project === "string"
        ? flags.project
        : (payload?.workspace?.project_dir ??
            payload?.workspace?.current_dir ??
            payload?.cwd ??
            process.cwd()),
    );
    const sessionId =
      typeof flags.session === "string"
        ? flags.session
        : (payload?.session_id ?? sessionIdFromEnv());
    const sessions = liveInProject(project);
    const names = claudeSessions();
    // Claude mints a new session id on `/clear` without respawning MCP servers,
    // so the payload id can differ from the one this session is registered and
    // addressable under. Resolve the routable identity once and key every field
    // off it — a name, unread count, or job list attached to an unreachable id
    // describes a session that, as far as every peer is concerned, is not there.
    const hostPids = hostAncestorPids();
    const now = Date.now();
    // Deliberately not falling back to the payload id: a session that cannot
    // identify its own registration has no address, and every field below
    // already reports nothing rather than guessing. Falling back would let it
    // claim counts belonging to an id no peer can reach.
    const address = sessionAddress(sessions, sessionId, names, now, hostPids);
    if (flags.json === true) {
      if (!address) {
        console.log("null");
        return;
      }
      console.log(
        JSON.stringify(
          makeSessionStatus({
            project,
            sessionId: address,
            sessions: coalesceRegistrations(sessions),
            meta: names,
            unread: unreadForSession(project, address),
            leases: work.list(project),
            jobs: readWeftJobsSnapshot(now),
            running: readRunningJobsSnapshot(now),
            openObligations: obligations.listOpen(),
            // One file read — the status line never spawns `issues`.
            ledgerObligations: currentLedgerObligations((role) =>
              obligations.sessionResponsibleFor(role),
            ).obligations,
            nowMs: now,
          }),
        ),
      );
      return;
    }
    const name = statusLineName(
      project,
      sessionId,
      names,
      sessions,
      hostPids,
      now,
    );
    if (flags.fields === true) {
      // One spawn, every field the status line wants. A shell script that
      // wanted these separately would have to either call this command four
      // times or reimplement agent-loom's semantics against the registry and
      // spool — the second is how a display layer starts owning facts it does
      // not compute.
      const peers = peersInProject(sessions, sessionId, names, now, hostPids);
      const fields = [
        name,
        peers.length,
        address ? unreadForSession(project, address) : 0,
        pushDeliveryFor(sessions, address),
        // Appended, never inserted: the consuming shell script splits
        // positionally and lives outside this repo, so reordering silently
        // mislabels every field after the one that moved.
        weftJobsField(address),
      ];
      if (flags.work === true) {
        fields.push(statusLineWorkField(project, address, sessions, debug));
      }
      console.log(fields.join("\t"));
      return;
    }
    if (debug) {
      console.error(`project: ${project}`);
      console.error(`session: ${sessionId ?? "(no session id)"}`);
      // A restart reattaches the session in every case below; the cause says
      // what to look for first.
      if (!address) {
        const cause = unaddressedCause(
          sessions,
          sessionId,
          names,
          now,
          hostPids,
        );
        console.error(
          cause === "unregistered"
            ? "address: (none) — no channel server is registered for this session, so mail cannot reach it; restart the session to reattach (see agent-loom logs --lifecycle)"
            : cause === "stale"
              ? "address: (none) — this session's registration has been idle past the staleness threshold and is not counted as present; restart the session to reattach"
              : "address: (none) — several registrations share this session's host process, so none can be identified as this session's; restart the session to reattach",
        );
      } else if (address !== sessionId) {
        console.error(
          `address: ${address} — host reports a different session id than this session is registered under; restart it to re-sync`,
        );
      }
      for (const r of sessions) {
        const self = address !== undefined && r.sessionId === address;
        console.error(
          `  ${r.sessionId ?? "-"} pid ${r.pid} [${sessionActivity(r, names)}]${self ? " <- this session" : ""}`,
        );
      }
    }
    if (name) console.log(name);
  } catch (error) {
    if (debug || flags.json === true)
      console.error(`status-line failed: ${error}`);
    if (flags.json === true) process.exitCode = 1;
  }
}

// --- reminders (hook-driven, pull-only harnesses) ----------------------------

/** Print an unread-mail reminder for a harness hook, or a no-op response.
 *
 * Pull-only harnesses never learn about unread mail unless they ask, so their
 * hooks run this command on harness events and inject whatever it prints into
 * the model's context. The answer comes from the daemon's unread-summary
 * snapshot; a hook fires per turn and cannot afford a spool scan per event.
 *
 * Ordinary events and every failure exit 0. Agy receives JSON on every path.
 * A new Codex/Kimi Stop edge exits 2 with fixed text on stderr. Agy requests
 * the same follow-up through its JSON Stop response. The announced edge is
 * written first so the same unread state cannot create a Stop loop. */
async function cmdRemind(
  flags: Record<string, string | boolean>,
): Promise<void> {
  try {
    const format = flags.format;
    if (
      format !== "agy" &&
      format !== "codex" &&
      format !== "kimi" &&
      format !== "gemini" &&
      format !== "pi"
    ) {
      // Operator error, not a hook event: stderr is safe, stdout stays clean.
      console.error(
        "agent-loom remind: --format agy|codex|kimi|gemini|pi required",
      );
      return;
    }
    const payload = await readStatusLinePayload();
    const project = canonicalProject(
      typeof flags.project === "string"
        ? flags.project
        : (payload?.workspace?.project_dir ??
            payload?.workspace?.current_dir ??
            payload?.cwd ??
            (Array.isArray(payload?.workspacePaths) &&
            typeof payload.workspacePaths[0] === "string"
              ? payload.workspacePaths[0]
              : undefined) ??
            process.cwd()),
    );
    // Session id resolution order: explicit flag, the hook payload, Gemini's
    // exported env var, then the usual chain (AGENT_SESSION_ID covers Agy and
    // Kimi).
    const sessionId =
      typeof flags.session === "string"
        ? flags.session
        : (payload?.session_id ??
          (process.env.GEMINI_SESSION_ID || undefined) ??
          sessionIdFromEnv());
    const nowMs = Date.now();
    const snapshot = readUnreadSummarySnapshot(nowMs);
    const entry = sessionId ? snapshot?.bySession[sessionId] : undefined;
    const announced = sessionId
      ? readAnnouncedState(project, sessionId)
      : undefined;
    const event = typeof flags.event === "string" ? flags.event : undefined;
    const decision = decideReminder({
      sessionId,
      entry,
      snapshotStale: snapshot === undefined,
      announced,
      nowMs,
      // Time-based re-reminders may add context to an active turn, but must
      // never manufacture another Stop continuation for the same mail edge.
      reReminderMs: event === "Stop" ? null : undefined,
    });
    if (decision === "remind" && entry && sessionId) {
      const text = reminderText(entry.unread, entry.newestTs ?? "");
      const response = reminderHookResponse(format, text, event);
      // Commit the edge before asking a Stop hook to continue. If the harness
      // immediately re-enters Stop, this edge is already silent.
      writeAnnouncedState(
        nextAnnouncedState(announced, entry, sessionId, project, nowMs),
      );
      if (response.stdout) console.log(response.stdout);
      if (response.stderr) console.error(response.stderr);
      process.exitCode = response.exitCode;
    } else if (decision === "stale" && sessionId) {
      if (diagnosticDue(announced?.lastDiagAt, nowMs)) {
        // State first: its write creates the state root the log lives under.
        writeAnnouncedState({
          ...(announced ?? {
            version: 1 as const,
            sessionId,
            project,
            lastUnread: 0,
            announcedAt: 0,
            remindCount: 0,
          }),
          lastDiagAt: nowMs,
        });
        appendFileSync(
          REMIND_DIAGNOSTICS_PATH,
          `[${new Date(nowMs).toISOString()}] unread summary missing or stale (session ${sessionId}, project ${project}); daemon not ticking?\n`,
        );
      }
    }
    if (decision !== "remind" && format === "agy") console.log("{}");
  } catch {
    // Fail open. Agy still needs valid no-op JSON; other harnesses need clean
    // stdout. Only a fully computed, persisted edge may request continuation.
    if (flags.format === "agy") console.log("{}");
    process.exitCode = 0;
  }
}

// --- harness hook installation (agent-loom hooks) ------------------------------

type HookHarness = "agy" | "codex" | "kimi" | "gemini";

const HOOK_CONFIG_PATHS: Record<HookHarness, string> = {
  agy: AGY_HOOKS_PATH,
  codex: CODEX_HOOKS_PATH,
  kimi: KIMI_CONFIG_PATH,
  gemini: GEMINI_SETTINGS_PATH,
};

/** The command a harness hook runs. Same entry-path pattern as installPlan:
 * the current runtime plus this module, so the installed hook works from a
 * checkout (.ts) and from the published package (.js) alike. */
function remindCommandBase(format: HookHarness): string {
  return `${runtimePath()} ${SELF} remind --format ${format}`;
}

function readJsonDocument(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Harnesses the command targets: the ones flagged, or — with no flag — every
 * harness whose config directory exists. The directory is the signal that the
 * harness is in use; a config file is only ever created inside an existing
 * directory, never a directory itself. */
function hookTargets(flags: Record<string, string | boolean>): HookHarness[] {
  const all: HookHarness[] = ["agy", "codex", "kimi", "gemini"];
  const flagged = all.filter((harness) => flags[harness] === true);
  if (flagged.length > 0) return flagged;
  return all.filter((harness) =>
    existsSync(dirname(HOOK_CONFIG_PATHS[harness])),
  );
}

function hookEventsInstalled(harness: HookHarness, path: string): string[] {
  if (harness === "kimi") {
    if (!existsSync(path)) return [];
    return kimiReminderHookEvents(readFileSync(path, "utf8"));
  }
  const document = readJsonDocument(path);
  if (harness === "agy") {
    return agyReminderHookEvents(document, remindCommandBase("agy"));
  }
  if (harness === "codex") {
    return codexReminderHookEvents(document, remindCommandBase("codex"));
  }
  return geminiReminderHookEvents(document, remindCommandBase("gemini"));
}

function installHooks(harness: HookHarness, geminiAfterTool: boolean): void {
  const path = HOOK_CONFIG_PATHS[harness];
  if (!existsSync(dirname(path))) {
    console.log(`${harness}: skipped (no ${dirname(path)} directory)`);
    return;
  }
  if (harness === "kimi") {
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const result = addReminderHookKimi(text, remindCommandBase("kimi"));
    if (!result.changed) {
      console.log("kimi: reminder hook already installed");
      return;
    }
    writeFileSync(path, result.document);
    console.log(`kimi: installed UserPromptSubmit + Stop hooks in ${path}`);
    return;
  }
  const document = readJsonDocument(path);
  if (harness === "agy") {
    const result = addReminderHookAgy(document, remindCommandBase("agy"));
    if (!result.changed) {
      console.log("agy: reminder hooks already installed");
      return;
    }
    writeFileSync(path, `${JSON.stringify(result.document, null, 2)}\n`);
    console.log(`agy: installed PreInvocation + Stop hooks in ${path}`);
    return;
  }
  if (harness === "codex") {
    const result = addReminderHookCodex(document, remindCommandBase("codex"));
    if (!result.changed) {
      console.log("codex: reminder hooks already installed");
      return;
    }
    writeFileSync(path, `${JSON.stringify(result.document, null, 2)}\n`);
    console.log(
      `codex: installed UserPromptSubmit + PostToolUse + Stop hooks in ${path}`,
    );
    return;
  }
  const result = addReminderHookGemini(document, remindCommandBase("gemini"), {
    afterTool: geminiAfterTool,
  });
  if (!result.changed) {
    console.log("gemini: reminder hook already installed");
    return;
  }
  writeFileSync(path, `${JSON.stringify(result.document, null, 2)}\n`);
  console.log(
    `gemini: installed BeforeAgent${geminiAfterTool ? " + AfterTool" : ""} hook in ${path}`,
  );
}

function uninstallHooks(harness: HookHarness): void {
  const path = HOOK_CONFIG_PATHS[harness];
  if (!existsSync(path)) {
    console.log(`${harness}: nothing to remove (no ${path})`);
    return;
  }
  if (harness === "kimi") {
    const result = removeReminderHookKimi(readFileSync(path, "utf8"));
    if (!result.changed) {
      console.log("kimi: no reminder hook installed");
      return;
    }
    writeFileSync(path, result.document);
    console.log(`kimi: removed reminder hook from ${path}`);
    return;
  }
  const document = readJsonDocument(path);
  let result: { document: Record<string, unknown>; changed: boolean };
  if (harness === "agy") {
    result = removeReminderHookAgy(document, remindCommandBase("agy"));
  } else if (harness === "codex") {
    result = removeReminderHookCodex(document, remindCommandBase("codex"));
  } else {
    result = removeReminderHookGemini(document, remindCommandBase("gemini"));
  }
  if (!result.changed) {
    console.log(`${harness}: no reminder hook installed`);
    return;
  }
  writeFileSync(path, `${JSON.stringify(result.document, null, 2)}\n`);
  console.log(`${harness}: removed reminder hooks from ${path}`);
}

/** agent-loom hooks install|uninstall|status — register the hook commands
 * that make pull-only harnesses run `agent-loom remind` per turn. */
function cmdHooks(
  flags: Record<string, string | boolean>,
  args: string[],
): void {
  const subcommand = args[0];
  const targets = hookTargets(flags);
  if (subcommand === "status") {
    for (const harness of targets) {
      const events = hookEventsInstalled(harness, HOOK_CONFIG_PATHS[harness]);
      console.log(
        events.length > 0
          ? `${harness}: installed (${events.join(", ")})`
          : `${harness}: not installed`,
      );
    }
    if (targets.length === 0) {
      console.log("no harness config directories found");
    }
    return;
  }
  if (subcommand === "install" || subcommand === "uninstall") {
    if (targets.length === 0) {
      console.log(
        "no harness config directories found (~/.gemini/config, ~/.codex, ~/.kimi-code, ~/.gemini)",
      );
      return;
    }
    for (const harness of targets) {
      if (subcommand === "install") {
        installHooks(harness, flags["gemini-after-tool"] === true);
      } else {
        uninstallHooks(harness);
      }
    }
    return;
  }
  throw new Error(
    "usage: agent-loom hooks install|uninstall|status [--agy] [--codex] [--kimi] [--gemini] [--gemini-after-tool]",
  );
}

// --- coordination claims -----------------------------------------------------

function claimProject(flags: Record<string, string | boolean>): string {
  return typeof flags.project === "string"
    ? resolveProjectArg(flags.project)
    : canonicalProject(process.cwd());
}

function resolvedCliOwner(
  flags: Record<string, string | boolean>,
  project: string,
  required: boolean,
): ClaimOwner | undefined {
  const label = typeof flags.owner === "string" ? flags.owner : undefined;
  const live = listLive();
  const sessionId = sessionIdFromEnv(process.env, process.pid);
  const registration =
    (sessionId
      ? (live.find((entry) => entry.sessionId === sessionId) as
          | (Registration & { sessionId: string })
          | undefined)
      : undefined) ??
    registrationForCallingProcess(
      live,
      canonicalProject(process.cwd()),
      parentPidViaPs,
    );
  if (registration) {
    const { sessionId: boundSessionId } = registration;
    const identity = sessionNames(
      boundSessionId,
      claudeSessions().get(boundSessionId),
      registration.cwd,
    );
    return {
      id: boundSessionId,
      label: label ?? identity.displayName,
      kind: "session",
      sessionId: boundSessionId,
      pid: registration.pid,
      ...(registration.procStart ? { procStart: registration.procStart } : {}),
      ...(registration.instanceId
        ? { instanceId: registration.instanceId }
        : {}),
    };
  }
  if (!label) {
    if (!required) return undefined;
    throw new Error(
      "coordination acquisition outside a registered agent session requires --owner <label>",
    );
  }
  return {
    id: `cli:${label}`,
    label,
    kind: "manual",
  };
}

function cliOwner(
  flags: Record<string, string | boolean>,
  project: string,
): ClaimOwner {
  return resolvedCliOwner(flags, project, true) as ClaimOwner;
}

function currentCliPlanExecutor(
  plan: PlanClaimIdentity,
): ClaimOwner | undefined {
  return work
    .list(plan.project)
    .find(
      (lease) =>
        lease.resource.type === "research-plan" &&
        lease.resource.key === plan.stem,
    )?.owner;
}

function cliPathClaimOwner(
  flags: Record<string, string | boolean>,
  project: string,
): ClaimOwner {
  const planStem = typeof flags.plan === "string" ? flags.plan : undefined;
  const planProjectFlag =
    typeof flags["plan-project"] === "string"
      ? flags["plan-project"]
      : undefined;
  if (planProjectFlag && !planStem) {
    throw new Error("--plan-project requires --plan <stem>");
  }
  const caller = cliOwner(flags, project);
  if (!planStem) return caller;
  const planProject = planProjectFlag
    ? resolveProjectArg(planProjectFlag)
    : canonicalProject(process.cwd());
  const plan = { project: planProject, stem: planStem };
  const executor = currentCliPlanExecutor(plan);
  if (!executor) {
    throw new Error(
      `research plan is not currently held: ${planProject}/${planStem}`,
    );
  }
  if (!sameWorkOwner(executor, caller)) {
    throw new Error(
      `only the current executor may acquire a claim for ${planProject}/${planStem}`,
    );
  }
  return {
    id: `plan:${planProject}:${planStem}`,
    label: `plan ${planStem}`,
    kind: "plan",
    plan,
  };
}

function parentPidViaPs(pid: number): number | undefined {
  const result = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]);
  if (result.exitCode !== 0) return undefined;
  const ppid = Number.parseInt(result.stdout.toString().trim(), 10);
  return Number.isInteger(ppid) ? ppid : undefined;
}

function describeClaim(claim: Claim): string {
  const resource =
    claim.type === "experiment"
      ? `${claim.experimentId} (${claim.notebook})`
      : pathClaimTargets(claim)
          .map((target) => `${target.pathType} ${target.path}`)
          .join(", ");
  if (claim.type === "experiment") {
    return `${claim.id} ${claim.project} ${resource} — ${claim.owner.label} [created ${claim.createdAt}]`;
  }
  const activity =
    "lastActivityAt" in claim && claim.lastActivityAt
      ? ` [activity ${claim.lastActivityAt}]`
      : "";
  const lifecycle =
    "state" in claim && claim.state === "released"
      ? ` [state released; reason ${claim.releaseReason}; released ${claim.releasedAt}]`
      : "state" in claim && claim.state === "restart-grace"
        ? ` [state restart-grace; deadline ${claim.graceDeadline}]`
        : " [state active]";
  return `${claim.id} ${claim.project} ${resource} — ${claim.owner.label} [owner ${claimOwnerKind(claim.owner)}; ${pathClaimOwnerCondition(claim)}] [created ${claim.createdAt}]${activity}${lifecycle}`;
}

function withConflictGuidance<T>(project: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    const recordId =
      error instanceof WorkConflictError
        ? error.lease.id
        : error instanceof ClaimConflictError
          ? error.claimId
          : undefined;
    if (!recordId) throw error;
    const entry = listCoordination({ project }).find(
      (candidate) => candidate.id === recordId,
    );
    if (!entry) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const owner =
      error instanceof ClaimConflictError
        ? (() => {
            const claim = claims
              .peek(project)
              .find((candidate) => candidate.id === error.claimId);
            const condition =
              claim?.type === "path"
                ? pathClaimOwnerCondition(claim)
                : entry.condition;
            return `blocking owner ${claimOwnerKind(entry.owner as ClaimOwner)}; condition ${condition}; `;
          })()
        : "";
    throw new Error(`${message}; ${owner}${coordinationConflictAdvice(entry)}`);
  }
}

function cmdClaimExperiment(flags: Record<string, string | boolean>): void {
  const project = claimProject(flags);
  const notebook =
    typeof flags.notebook === "string"
      ? resolve(project, flags.notebook)
      : existsSync(join(project, "lab-notebook"))
        ? join(project, "lab-notebook")
        : project;
  const claim = claims.claimExperiment(
    project,
    notebook,
    cliOwner(flags, project),
  );
  console.log(`${claim.experimentId} ${claim.id}`);
}

function cmdClaimPath(
  flags: Record<string, string | boolean>,
  args: string[],
): void {
  const paths = repeatedFlagValues(args, "path");
  if (paths.length === 0) {
    console.error(
      "usage: agent-loom claim-path --path <path> [--path <path> ...] [--directory] [--project <dir>] [--owner <label>] [--plan <stem> [--plan-project <dir>]]",
    );
    process.exit(1);
  }
  const project = claimProject(flags);
  const pathType = flags.directory === true ? "directory" : undefined;
  const acquisition = withConflictGuidance(project, () =>
    claims.claimPaths(
      project,
      paths.map((path) => ({ path: resolve(project, path), pathType })),
      cliPathClaimOwner(flags, project),
      {
        sessionIsLive: (id) =>
          listLive().some((registration) => registration.sessionId === id),
        planExecutor: currentCliPlanExecutor,
        actor: resolvedCliOwner(flags, project, false),
      },
    ),
  );
  console.log(
    acquisition.disposition === "acquired"
      ? `${acquisition.claim.id} ${acquisition.releaseToken}`
      : `${acquisition.claim.id} existing`,
  );
  for (const target of pathClaimTargets(acquisition.claim)) {
    console.log(`  ${target.pathType} ${target.path}`);
  }
}

function cmdClaims(flags: Record<string, string | boolean>): void {
  if (flags.all && typeof flags.project === "string") {
    throw new Error("claims accepts --project or --all, not both");
  }
  const project = flags.all ? undefined : claimProject(flags);
  const claimOptions = {
    sessionIsLive: (id: string) =>
      listLive().some((registration) => registration.sessionId === id),
    planExecutor: currentCliPlanExecutor,
  };
  const active = project
    ? claims.list(project, Date.now(), claimOptions)
    : claims.listAll(Date.now(), claimOptions);
  const history =
    flags.history === true
      ? project
        ? claims.listReleased(project)
        : claims.listAllReleased()
      : [];
  const visible = [...active, ...history];
  if (visible.length === 0) {
    console.log(flags.history === true ? "no claims" : "no active claims");
    return;
  }
  for (const claim of visible) console.log(describeClaim(claim));
}

function cmdReleaseClaim(flags: Record<string, string | boolean>): void {
  const claimId = typeof flags.id === "string" ? flags.id : undefined;
  const releaseToken =
    typeof flags.token === "string" ? flags.token : undefined;
  if ((claimId === undefined) === (releaseToken === undefined)) {
    console.error(
      "usage: agent-loom release-claim (--id <claim-id> | --token <release-token>) [--project <dir>]",
    );
    process.exit(1);
  }
  const project =
    typeof flags.project === "string"
      ? resolveProjectArg(flags.project)
      : undefined;
  const actor = releaseToken
    ? undefined
    : resolvedCliOwner(
        flags,
        project ?? canonicalProject(process.cwd()),
        false,
      );
  const result = claims.release({
    claimId,
    releaseToken,
    project,
    actor,
    sessionIsLive: (id) =>
      listLive().some((registration) => registration.sessionId === id),
    planExecutor: currentCliPlanExecutor,
  });
  const prefix =
    result.disposition === "released" ? "released" : "already released";
  console.log(`${prefix} ${describeClaim(result.claim)}`);
}

function cmdCoordination(
  flags: Record<string, string | boolean>,
  args: string[],
): void {
  const subcommand = args[0] ?? "list";
  if (subcommand === "list") {
    if (flags.all && typeof flags.project === "string") {
      throw new Error("coordination list accepts --project or --all, not both");
    }
    let entries = listCoordination(
      flags.all ? { allProjects: true } : { project: claimProject(flags) },
    );
    if (typeof flags.kind === "string") {
      entries = entries.filter((entry) => entry.kind === flags.kind);
    }
    if (typeof flags.owner === "string") {
      const owner = flags.owner.toLocaleLowerCase();
      entries = entries.filter(
        (entry) =>
          entry.owner.id === flags.owner ||
          entry.owner.sessionId === flags.owner ||
          entry.owner.label.toLocaleLowerCase() === owner,
      );
    }
    if (typeof flags.condition === "string") {
      entries = entries.filter((entry) => entry.condition === flags.condition);
    }
    if (flags.json === true) {
      console.log(JSON.stringify({ schemaVersion: 1, entries }, null, 2));
      return;
    }
    // The cross-project view joins projected ledger obligations; a missing
    // or failed issues snapshot says so rather than omitting them silently.
    const ledgerDiagnostic =
      flags.all === true
        ? currentLedgerObligations((role) =>
            obligations.sessionResponsibleFor(role),
          ).diagnostic
        : undefined;
    if (entries.length === 0) {
      console.log("no active coordination");
      if (ledgerDiagnostic) console.log(ledgerDiagnostic);
      return;
    }
    for (const entry of entries) console.log(describeCoordination(entry));
    if (ledgerDiagnostic) console.log(ledgerDiagnostic);
    return;
  }
  if (subcommand === "recover") {
    if (typeof flags.id !== "string") {
      throw new Error(
        "usage: agent-loom coordination recover --id <coordination-id> [--authority <text> --reason <text>]",
      );
    }
    const authority =
      typeof flags.authority === "string" ? flags.authority : undefined;
    const reason = typeof flags.reason === "string" ? flags.reason : undefined;
    const entry = recoverCoordination(flags.id, undefined, {
      authority,
      reason,
      recoveredBy: typeof flags.owner === "string" ? flags.owner : "cli",
    });
    console.log(
      (authority ?? "").trim().length > 0
        ? `force-released ${describeCoordination(entry)} on declared authority (recorded, not verified)`
        : `recovered ${describeCoordination(entry)}; the offline owner's record was released`,
    );
    return;
  }
  if (subcommand === "request-transfer") {
    if (typeof flags.id !== "string") {
      throw new Error(
        "usage: agent-loom coordination request-transfer --id <work-id> [--reason <text>] [--timeout <seconds>] [--owner <label>]",
      );
    }
    const lease = findWorkLease(flags.id);
    const timeoutSeconds =
      typeof flags.timeout === "string" ? Number(flags.timeout) : undefined;
    const requester = isWorkspaceOwnerResource(lease.resource)
      ? workspaceOwnerIdentity(
          lease.project,
          verifiedOwnerSession(flags, lease.project),
        )
      : cliOwner(flags, lease.project);
    const result = transfers.request(lease, requester, {
      reason: typeof flags.reason === "string" ? flags.reason : undefined,
      timeoutSeconds,
    });
    flushTransferNotifications();
    console.log(JSON.stringify(result.request, null, 2));
    return;
  }
  if (subcommand === "respond-transfer") {
    if (
      typeof flags.id !== "string" ||
      (flags.decision !== "accept" && flags.decision !== "decline")
    ) {
      throw new Error(
        "usage: agent-loom coordination respond-transfer --id <request-id> --decision accept|decline [--message <text>] [--owner <label>]",
      );
    }
    const request = transfers.get(flags.id);
    if (!request) throw new Error(`transfer request not found: ${flags.id}`);
    const result = transfers.respond(
      request.id,
      isWorkspaceOwnerResource({
        type: request.resourceType,
        key: request.resourceKey,
      })
        ? workspaceOwnerIdentity(
            request.project,
            verifiedOwnerSession(flags, request.project),
          )
        : cliOwner(flags, request.project),
      flags.decision,
      typeof flags.message === "string" ? flags.message : undefined,
    );
    flushTransferNotifications();
    console.log(JSON.stringify(result.request, null, 2));
    return;
  }
  if (subcommand === "transfers") {
    transfers.settleExpired();
    flushTransferNotifications();
    const requests = flags.all
      ? transfers.list()
      : transfers.list(claimProject(flags));
    if (flags.json === true) {
      console.log(JSON.stringify({ schemaVersion: 1, requests }, null, 2));
    } else if (requests.length === 0) {
      console.log("no coordination transfers");
    } else {
      for (const request of requests) {
        console.log(
          `${request.id} ${displayName(request.project)}/${request.resourceType}:${request.resourceKey} — ${request.requester.label} requests from ${request.expectedOwner.label} [${request.status}] [deadline ${request.deadline}]`,
        );
      }
    }
    return;
  }
  throw new Error(
    "usage: agent-loom coordination list|recover|request-transfer|respond-transfer|transfers [options]",
  );
}

const OBLIGATION_KINDS: readonly ObligationKind[] = [
  "claim_release",
  "decision",
  "external_fix",
  "job_completion",
  "review",
];

const SESSION_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function describeObligation(obligation: Obligation): string {
  // Role obligors render their resolution provenance ("owner of agent-loom
  // → <session>"); an unresolvable role renders as unresolvable, and a
  // session or human obligor renders as its label as before.
  const obligor = obligations.describeObligor(obligation);
  const lifecycle =
    obligation.status === "open"
      ? ""
      : ` [${obligation.closedBy}; closed ${obligation.closedAt}]`;
  const contested = obligation.contested
    ? ` [contested ${obligation.contestedAt}; ${obligation.contestReason}]`
    : "";
  const resolution =
    obligation.resolution !== undefined
      ? ` [resolution ${obligation.resolution}]`
      : "";
  const adopted = obligation.adoptedFrom
    ? ` [adopted from ${obligation.adoptedFrom}]`
    : "";
  const presentation =
    (obligation.description ? " [description]" : "") +
    (obligation.options
      ? ` [options: ${obligation.options.join(" | ")}]`
      : "") +
    (obligation.markers ? ` [${obligation.markers.length} marker(s)]` : "") +
    (obligation.comments?.length
      ? ` [${obligation.comments.length} comment(s)]`
      : "");
  return `${obligation.id} ${obligation.kind} ${obligation.subject} — owed to ${obligation.obligee.label} by ${obligor} [${obligation.status}]${lifecycle}${contested}${resolution}${adopted}${presentation} [created ${obligation.createdAt}]`;
}

/** The one creation notice a session obligor gets (CreationNoticePushed in
 * specs/obligations.allium): ordinary mail appended directly to the obligor's
 * spool, the way transfer notices travel; the recipient's channel poll turns
 * it into the ordinary push. A human or system obligor gets none — the owed
 * view and the system's own event feed are theirs. Role obligors push to the
 * one responsible session, passed as `toSession`. Kept text-identical with
 * channel.ts's obligationNotice. */
function obligationNotice(
  obligation: Obligation,
  project: string,
  toSession?: string,
): Message {
  return {
    ts: new Date().toISOString(),
    from: "agent-loom-obligations",
    project,
    message: `${obligation.obligee.label} announced obligation ${obligation.id}: you owe a ${obligation.kind} outcome — ${obligation.subject}. Contest it with obligations_contest if it is wrong; the obligee closes it.`,
    origin: {
      kind: "automation",
      transport: "internal",
      authority: "untrusted",
    },
    meta: {
      toSession:
        toSession ??
        (obligation.obligor.kind === "session"
          ? obligation.obligor.sessionId
          : ""),
      obligationId: obligation.id,
      fromName: obligation.obligee.label,
    },
  };
}

/** Obligations act for a live registered session — the same identity
 * claim_path and work acquisitions use. A manual --owner label cannot act:
 * the store proves the obligee's and contesting obligor's liveness against
 * the registry, and a label has no process to prove. */
function obligationActor(
  flags: Record<string, string | boolean>,
): SessionParty {
  const owner = resolvedCliOwner(flags, canonicalProject(process.cwd()), false);
  if (!owner || owner.kind !== "session" || !owner.sessionId) {
    throw new Error(
      "obligations act for a registered live session; run from inside an agent session (contest --user is the operator's form)",
    );
  }
  return {
    kind: "session",
    sessionId: owner.sessionId,
    label: sessionNames(
      owner.sessionId,
      claudeSessions().get(owner.sessionId),
      canonicalProject(process.cwd()),
    ).fullName,
  };
}

/** Pairs --marker <value> with --marker-kind <path|label> and --marker-label
 * <text>, each applying to the most recent --marker. Kind defaults to path
 * when the value looks like a path, else label; the record always carries
 * the explicit type either way. Used by announce and update. */
function parseObligationMarkers(args: string[]): ObligationMarker[] {
  const markers: ObligationMarker[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--marker") {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        markers.push({
          type:
            value.startsWith("/") ||
            value.startsWith("~") ||
            value.includes("/")
              ? "path"
              : "label",
          value,
        });
      }
    } else if (args[i] === "--marker-kind") {
      const kind = args[i + 1];
      const last = markers.at(-1);
      if (last && (kind === "path" || kind === "label")) last.type = kind;
    } else if (args[i] === "--marker-label") {
      const label = args[i + 1];
      const last = markers.at(-1);
      if (last && label !== undefined && !label.startsWith("--")) {
        last.label = label;
      }
    }
  }
  return markers;
}

/** Adoption names an offline session, which live-recipient resolution cannot
 * see. A live name or id resolves; otherwise only an exact UUID-shaped
 * session id is accepted, because anything else is a typo that would adopt
 * nothing and report success. */
function resolveObligationPredecessor(project: string, query: string): string {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("predecessor must not be empty");
  try {
    return resolveRecipient(project, trimmed).sessionId;
  } catch (error) {
    if (!(error instanceof RecipientError)) throw error;
  }
  if (!SESSION_ID_SHAPE.test(trimmed)) {
    throw new Error(
      `predecessor "${trimmed}" does not resolve; adoption names an offline session by its exact session id`,
    );
  }
  return trimmed;
}

function cmdObligations(
  flags: Record<string, string | boolean>,
  args: string[],
): void {
  const subcommand = args[0];
  if (subcommand === "announce") {
    const kind = flags.kind as ObligationKind;
    if (!kind || !OBLIGATION_KINDS.includes(kind)) {
      throw new Error(
        "obligations announce requires --kind claim_release|decision|external_fix|job_completion|review",
      );
    }
    if (typeof flags.subject !== "string" || !flags.subject.trim()) {
      throw new Error("obligations announce requires --subject <text>");
    }
    if (
      flags.description !== undefined &&
      typeof flags.description !== "string"
    ) {
      throw new Error("--description requires text");
    }
    const obligorForms = [
      flags.obligor !== undefined,
      flags.user === true,
      flags.system !== undefined,
      flags.component !== undefined,
    ].filter(Boolean).length;
    if (obligorForms !== 1) {
      throw new Error(
        "obligations announce requires exactly one of --obligor <name-or-id>, --user, --system <name>, or --component <name>",
      );
    }
    const actor = obligationActor(flags);
    let obligor: Party;
    let obligorProject: string | undefined;
    if (flags.user === true) {
      obligor = { kind: "human", label: "user" };
    } else if (flags.system !== undefined) {
      if (typeof flags.system !== "string" || !flags.system.trim()) {
        throw new Error("--system requires the integration's name, e.g. weft");
      }
      const system = flags.system.trim();
      // Issue-ledger is not a wired system: every open issue is already an
      // obligation by projection, so there is nothing to announce.
      if (system === "issue-ledger") {
        throw new Error(
          "issue-ledger issues are already obligations: the open issues appear in obligations list as `issue:<id>` rows owed by each component's owner — file, note, or watch the issue with `issues` instead",
        );
      }
      obligor = { kind: "system", system, label: system };
    } else if (flags.component !== undefined) {
      if (typeof flags.component !== "string" || !flags.component.trim()) {
        throw new Error(
          "--component requires the component's name, e.g. agent-loom",
        );
      }
      const component = flags.component.trim();
      obligor = {
        kind: "role",
        role: { kind: "component_owner", component },
        label: `owner of ${component}`,
      };
    } else {
      if (typeof flags.obligor !== "string" || !flags.obligor.trim()) {
        throw new Error("--obligor requires a session name or ID");
      }
      const recipient = resolveRecipient(claimProject(flags), flags.obligor);
      obligorProject = recipient.project;
      obligor = {
        kind: "session",
        sessionId: recipient.sessionId,
        label: sessionNames(
          recipient.sessionId,
          claudeSessions().get(recipient.sessionId),
          recipient.project,
        ).fullName,
      };
    }
    let record: Obligation;
    try {
      const parsedOptions = repeatedFlagValues(args, "option");
      const parsedMarkers = parseObligationMarkers(args);
      record = obligations.announce({
        obligee: actor,
        obligor,
        kind,
        subject: flags.subject.trim(),
        ...(typeof flags.description === "string"
          ? { description: flags.description }
          : {}),
        ...(parsedOptions.length ? { options: parsedOptions } : {}),
        ...(parsedMarkers.length ? { markers: parsedMarkers } : {}),
      });
    } catch (error) {
      if (!(error instanceof ObligationDuplicateError)) throw error;
      console.error(
        `${error.message}; close or withdraw ${error.obligation.id} before announcing the same subject again`,
      );
      process.exit(1);
    }
    let notified = "";
    if (record.obligor.kind === "session" && obligorProject !== undefined) {
      appendMessage(obligationNotice(record, obligorProject));
      notified = `; notified ${record.obligor.label}`;
    } else if (record.obligor.kind === "role") {
      // CreationNoticePushed for a role obligor: one notice, to the
      // resolved session, in the component's project.
      const resolution = obligations.resolveParty(record.obligor);
      const roleProject =
        record.obligor.role.kind === "component_owner"
          ? componentProject(record.obligor.role.component)
          : undefined;
      if (
        resolution.state === "resolves" &&
        resolution.sessionId &&
        roleProject
      ) {
        appendMessage(
          obligationNotice(record, roleProject, resolution.sessionId),
        );
        notified = `; notified ${record.obligor.label} (${resolution.sessionId})`;
      }
    }
    console.log(
      `announced ${record.id} — ${record.kind} ${record.subject}${notified}`,
    );
    return;
  }
  if (subcommand === "update") {
    if (typeof flags.id !== "string" || !flags.id.trim()) {
      throw new Error(
        "usage: agent-loom obligations update --id <obligation-id> [--description <text> | --clear-description] [--option <text> ... | --clear-options] [--marker <value> [--marker-kind path|label] [--marker-label <text>] ... | --clear-markers]",
      );
    }
    if (
      flags.description !== undefined &&
      typeof flags.description !== "string"
    ) {
      throw new Error("--description requires text");
    }
    const parsedOptions = repeatedFlagValues(args, "option");
    const parsedMarkers = parseObligationMarkers(args);
    const fields: {
      description?: string | null;
      options?: string[] | null;
      markers?: ObligationMarker[] | null;
    } = {
      ...(flags["clear-description"] === true || flags.description !== undefined
        ? {
            description:
              flags["clear-description"] === true
                ? null
                : (flags.description as string),
          }
        : {}),
      ...(flags["clear-options"] === true || parsedOptions.length
        ? { options: flags["clear-options"] === true ? null : parsedOptions }
        : {}),
      ...(flags["clear-markers"] === true || parsedMarkers.length
        ? { markers: flags["clear-markers"] === true ? null : parsedMarkers }
        : {}),
    };
    if (
      !("description" in fields) &&
      !("options" in fields) &&
      !("markers" in fields)
    ) {
      throw new Error(
        "obligations update requires --description, --clear-description, --option, --marker, --clear-options, or --clear-markers",
      );
    }
    const updateRefusal = ledgerObligationRefusal(flags.id.trim(), "update");
    if (updateRefusal) throw new Error(updateRefusal);
    const record = obligations.update(
      flags.id.trim(),
      obligationActor(flags),
      fields,
    );
    console.log(`updated ${describeObligation(record)}`);
    return;
  }
  if (subcommand === "comment") {
    if (
      typeof flags.id !== "string" ||
      !flags.id.trim() ||
      typeof flags.text !== "string" ||
      !flags.text.trim()
    ) {
      throw new Error(
        "usage: agent-loom obligations comment --id <obligation-id> --text <text> [--user]",
      );
    }
    const actor =
      flags.user === true ? ("user" as const) : obligationActor(flags);
    const commentRefusal = ledgerObligationRefusal(flags.id.trim(), "comment");
    if (commentRefusal) throw new Error(commentRefusal);
    const record = obligations.comment(
      flags.id.trim(),
      actor,
      flags.text.trim(),
    );
    console.log(`commented on ${describeObligation(record)}`);
    return;
  }
  if (subcommand === "close") {
    if (typeof flags.id !== "string" || !flags.id.trim()) {
      throw new Error(
        "usage: agent-loom obligations close --id <obligation-id> [--resolution <text>]",
      );
    }
    const closeRefusal = ledgerObligationRefusal(flags.id.trim(), "close");
    if (closeRefusal) throw new Error(closeRefusal);
    const record = obligations.close(
      flags.id.trim(),
      obligationActor(flags),
      typeof flags.resolution === "string" && flags.resolution.trim()
        ? flags.resolution.trim()
        : undefined,
    );
    console.log(`closed ${describeObligation(record)}`);
    return;
  }
  if (subcommand === "withdraw") {
    if (typeof flags.id !== "string" || !flags.id.trim()) {
      throw new Error(
        "usage: agent-loom obligations withdraw --id <obligation-id>",
      );
    }
    const withdrawRefusal = ledgerObligationRefusal(
      flags.id.trim(),
      "withdraw",
    );
    if (withdrawRefusal) throw new Error(withdrawRefusal);
    const record = obligations.withdraw(
      flags.id.trim(),
      obligationActor(flags),
    );
    console.log(`withdrew ${describeObligation(record)}`);
    return;
  }
  if (subcommand === "contest") {
    if (typeof flags.id !== "string" || !flags.id.trim()) {
      throw new Error(
        "usage: agent-loom obligations contest --id <obligation-id> --reason <text> [--user]",
      );
    }
    if (typeof flags.reason !== "string" || !flags.reason.trim()) {
      throw new Error("obligations contest requires --reason <text>");
    }
    const contestRefusal = ledgerObligationRefusal(flags.id.trim(), "contest");
    if (contestRefusal) throw new Error(contestRefusal);
    if (flags.user === true) {
      const record = obligations.contest(
        flags.id.trim(),
        "user",
        flags.reason.trim(),
      );
      console.log(`contested ${describeObligation(record)}`);
      return;
    }
    const existing = obligations.get(flags.id.trim());
    if (existing?.obligor.kind === "human") {
      throw new Error(
        `obligation ${existing.id} names you, the operator, as obligor; contest it with --user`,
      );
    }
    const record = obligations.contest(
      flags.id.trim(),
      { sessionId: obligationActor(flags).sessionId },
      flags.reason.trim(),
    );
    console.log(`contested ${describeObligation(record)}`);
    return;
  }
  if (subcommand === "adopt") {
    const resumeId =
      typeof flags["resume-id"] === "string" ? flags["resume-id"] : undefined;
    const authority =
      typeof flags.authority === "string" ? flags.authority : undefined;
    const reason = typeof flags.reason === "string" ? flags.reason : undefined;
    if ((resumeId !== undefined) === (authority !== undefined)) {
      throw new Error(
        "obligations adopt requires exactly one of --resume-id <id> or --authority <text> --reason <text>",
      );
    }
    if (authority !== undefined && !reason?.trim()) {
      throw new Error("obligations adopt --authority requires --reason <text>");
    }
    const predecessorFlag =
      typeof flags.predecessor === "string" ? flags.predecessor : undefined;
    if (predecessorFlag === undefined && resumeId === undefined) {
      throw new Error("obligations adopt requires --predecessor <id>");
    }
    const predecessorId = resolveObligationPredecessor(
      claimProject(flags),
      (predecessorFlag ?? resumeId) as string,
    );
    let succession: Succession;
    if (resumeId !== undefined) {
      // ADR 0011: a resume id is succession evidence only when it is the one
      // the resolved session's HOST process command line carried — the CLI's
      // own parent is the shell, which carries nothing. A typed string
      // proves nothing; authority is the other route.
      const actor = obligationActor(flags);
      const registration = listLive().find(
        (entry) => entry.sessionId === actor.sessionId,
      );
      const hostPid = registration?.parentPid ?? registration?.pid;
      const observed =
        hostPid !== undefined
          ? resumeIdFromCommand(processCommand(hostPid))
          : undefined;
      if (observed === undefined || observed !== predecessorId) {
        throw new Error(
          "adoption by --resume-id requires the session's host command line to carry the predecessor's id (launch with --resume <id>); adopt by --authority with --reason instead",
        );
      }
      succession = { kind: "resume-id", resumeId: predecessorId };
    } else {
      succession = {
        kind: "authority",
        authority: authority?.trim() ?? "",
        reason: reason?.trim() ?? "",
      };
    }
    const moved = obligations.adopt({
      adopter: obligationActor(flags),
      predecessorSessionId: predecessorId,
      succession,
    });
    console.log(
      moved.length
        ? `adopted ${moved.length} obligation(s) from ${predecessorId}\n${moved.map(describeObligation).join("\n")}`
        : `adopted 0 obligations from ${predecessorId}; the predecessor had no open obligations`,
    );
    return;
  }
  if (subcommand === "clear") {
    if (
      typeof flags.id !== "string" ||
      !flags.id.trim() ||
      typeof flags.authority !== "string" ||
      !flags.authority.trim() ||
      typeof flags.reason !== "string" ||
      !flags.reason.trim()
    ) {
      throw new Error(
        "usage: agent-loom obligations clear --id <obligation-id> --authority <text> --reason <text>",
      );
    }
    const clearRefusal = ledgerObligationRefusal(flags.id.trim(), "clear");
    if (clearRefusal) throw new Error(clearRefusal);
    const record = obligations.authorityClear(
      flags.id.trim(),
      flags.authority.trim(),
      flags.reason.trim(),
    );
    console.log(
      `cleared ${describeObligation(record)} on declared authority (recorded, not verified)`,
    );
    return;
  }
  if (subcommand === "list" || subcommand === "owed") {
    const owed = subcommand === "owed" || flags.owed === true;
    const scopeAll = subcommand !== "owed" && flags.all === true;
    if (typeof flags.project === "string") {
      throw new Error(
        "obligations are machine-global; list and owed take no --project",
      );
    }
    if (subcommand === "list" && flags.all && flags.owed === true) {
      throw new Error("obligations list accepts --all or --owed, not both");
    }
    const records = owed
      ? obligations.owedToHuman()
      : scopeAll
        ? obligations.list()
        : obligations.listOpen();
    // Ledger obligations project from the daemon's issues snapshot, read here
    // as a file — never a spawn. They join the open listings (not the
    // operator's owed view, whose obligor is the human), and a missing or
    // failed snapshot explains itself in one line rather than vanishing.
    const ledger = currentLedgerObligations((role) =>
      obligations.sessionResponsibleFor(role),
    );
    const ledgerRows = owed ? [] : ledger.obligations;
    if (records.length === 0 && ledgerRows.length === 0) {
      console.log(
        owed
          ? "no open obligations owed by you"
          : scopeAll
            ? "no obligations"
            : "no open obligations",
      );
      if (ledger.diagnostic) console.log(ledger.diagnostic);
      return;
    }
    for (const record of records) console.log(describeObligation(record));
    const nowMs = Date.now();
    for (const obligation of ledgerRows) {
      console.log(describeLedgerObligation(obligation, nowMs));
    }
    if (ledger.diagnostic) console.log(ledger.diagnostic);
    return;
  }
  throw new Error(
    "usage: agent-loom obligations announce|close|withdraw|contest|adopt|clear|list|owed [options]",
  );
}

function parseWorkState(
  value: string | boolean | undefined,
): WorkState | undefined {
  if (value === undefined) return undefined;
  if (value === "working" || value === "waiting") return value;
  throw new Error("work state must be working or waiting");
}

function describeWork(lease: WorkLease, live = listLive()): string {
  const label = lease.resource.label
    ? `${lease.resource.label} (${lease.resource.type}:${lease.resource.key})`
    : `${lease.resource.type}:${lease.resource.key}`;
  const activity = lease.activity ? ` — ${lease.activity}` : "";
  const status = coordinationOwnerStatus(
    lease.owner,
    live,
    lease.createdAt,
    undefined,
    true,
    lease.updatedAt,
  );
  const ownerStatus = !isDisplaceable(status)
    ? ""
    : status === "expired"
      ? " [owner expired]"
      : " [owner offline]";
  return `${lease.id} ${displayName(lease.project)}/${label} — ${lease.owner.label} [${lease.state}]${activity} [updated ${lease.updatedAt}]${ownerStatus}`;
}

function verifiedOwnerSession(
  flags: Record<string, string | boolean>,
  project: string,
): string {
  if (flags.session !== undefined || flags.owner !== undefined)
    throw new Error("owner changes act only for the verified calling session");
  const caller = callingSession(project);
  if (!caller)
    throw new Error(
      "owner changes require a verified live session in this project",
    );
  return caller.sessionId;
}

function cmdOwner(
  flags: Record<string, string | boolean>,
  args: string[],
): void {
  const action = args[0]?.startsWith("-") ? "show" : (args[0] ?? "show");
  if (!["show", "claim", "release"].includes(action))
    throw new Error(
      "usage: agent-loom owner [show|claim|release] [--project <dir>] [--json]",
    );
  const project = claimProject(flags);
  if (action !== "show") {
    const sessionId = verifiedOwnerSession(flags, project);
    if (action === "claim") claimWorkspaceOwner(project, sessionId);
    else releaseWorkspaceOwner(project, sessionId);
  }
  const owner = resolveWorkspaceOwner(project);
  console.log(
    flags.json
      ? JSON.stringify({ schemaVersion: 1, ...owner })
      : describeWorkspaceOwner(owner),
  );
}

function parseWorkProgress(
  flags: Record<string, string | boolean>,
): WorkProgress | null | undefined {
  const current = flags.step;
  const total = flags.steps;
  const label = flags["step-label"];
  if (flags["clear-progress"] !== undefined) {
    if (
      flags["clear-progress"] !== true ||
      current !== undefined ||
      total !== undefined ||
      label !== undefined
    ) {
      throw new Error(
        "--clear-progress takes no value and cannot accompany step flags",
      );
    }
    return null;
  }
  if (current === undefined && total === undefined && label === undefined)
    return undefined;
  if (
    typeof current !== "string" ||
    !/^[1-9]\d*$/.test(current) ||
    (total !== undefined &&
      (typeof total !== "string" || !/^[1-9]\d*$/.test(total))) ||
    (label !== undefined && typeof label !== "string")
  ) {
    throw new Error(
      "--step requires a positive integer; --steps and --step-label require --step",
    );
  }
  return validateWorkProgress({
    current: Number(current),
    ...(total !== undefined ? { total: Number(total) } : {}),
    ...(typeof label === "string" ? { label } : {}),
  });
}

function cmdMail(args: string[]): void {
  try {
    const command = args[0];
    if (command !== "history" && command !== "tui")
      throw new Error(
        "usage: agent-loom mail history|tui --session ID --project ABS [--once]",
      );
    const options = workTuiOptions(args.slice(1), `mail ${command}`);
    if (command === "history") {
      if (options.once) throw new Error("mail history does not accept --once");
      console.log(
        JSON.stringify(
          readSessionMailHistory(options.project, options.sessionId),
        ),
      );
    } else runMailTui(options);
  } catch (error) {
    console.error(`mail: ${terminalText(String(error))}`);
    process.exitCode = 1;
  }
}

function cmdWork(
  flags: Record<string, string | boolean>,
  args: string[],
): void {
  const subcommand = args[0];
  if (subcommand === "tui") {
    try {
      runWorkTui(workTuiOptions(args.slice(1)));
    } catch (error) {
      console.error(`work tui: ${terminalText(String(error))}`);
      process.exitCode = 1;
    }
    return;
  }
  if (subcommand === "list") {
    if (flags.all && typeof flags.project === "string") {
      throw new Error("work list accepts --project or --all, not both");
    }
    let leases = flags.all ? work.listAll() : work.list(claimProject(flags));
    if (typeof flags.type === "string") {
      leases = leases.filter((lease) => lease.resource.type === flags.type);
    }
    if (typeof flags.owner === "string") {
      const owner = flags.owner.toLocaleLowerCase();
      leases = leases.filter(
        (lease) =>
          lease.owner.id === flags.owner ||
          lease.owner.sessionId === flags.owner ||
          lease.owner.label.toLocaleLowerCase() === owner,
      );
    }
    if (leases.length === 0) {
      console.log("no active work");
      return;
    }
    const live = listLive();
    for (const lease of leases) console.log(describeWork(lease, live));
    return;
  }

  if (subcommand === "acquire") {
    if (typeof flags.type !== "string" || typeof flags.key !== "string") {
      throw new Error(
        "usage: agent-loom work acquire --type <type> --key <key> [--label <label>] [--source <path>] [--state working|waiting] [--activity <text>] [--project <dir>] [--owner <label>]",
      );
    }
    const project = claimProject(flags);
    const owner = cliOwner(flags, project);
    const resourceType = flags.type;
    const resourceKey = flags.key;
    assertGenericWorkResource({ type: resourceType, key: resourceKey });
    const lease = withConflictGuidance(project, () =>
      work.acquire(
        project,
        {
          type: resourceType,
          key: resourceKey,
          ...(typeof flags.label === "string" ? { label: flags.label } : {}),
          ...(typeof flags.source === "string"
            ? { sourcePath: resolve(project, flags.source) }
            : {}),
        },
        owner,
        {
          state: parseWorkState(flags.state),
          activity:
            typeof flags.activity === "string" ? flags.activity : undefined,
          progress: parseWorkProgress(flags),
          ownerIsLive: (candidate, existing) =>
            !isDisplaceable(
              coordinationOwnerStatus(
                candidate,
                listLive(),
                existing.createdAt,
                undefined,
                true,
                existing.updatedAt,
              ),
            ),
        },
      ),
    );
    console.log(describeWork(lease));
    return;
  }

  if (subcommand === "update") {
    if (typeof flags.id !== "string") {
      throw new Error(
        "usage: agent-loom work update --id <work-id> [--state working|waiting] [--activity <text>] [--project <dir>]",
      );
    }
    const project = claimProject(flags);
    const lease = work.list(project).find((item) => item.id === flags.id);
    if (!lease) throw new Error(`work lease not found: ${flags.id}`);
    assertGenericWorkResource(lease.resource);
    const state = parseWorkState(flags.state);
    const activity =
      typeof flags.activity === "string" ? flags.activity : undefined;
    const progress = parseWorkProgress(flags);
    if (
      state === undefined &&
      activity === undefined &&
      progress === undefined
    ) {
      throw new Error(
        "work update requires --state, --activity, --step, or --clear-progress",
      );
    }
    console.log(
      describeWork(
        work.update(project, lease.id, lease.owner.id, {
          state,
          activity,
          progress,
        }),
      ),
    );
    return;
  }

  if (subcommand === "release") {
    if (typeof flags.id !== "string") {
      throw new Error(
        "usage: agent-loom work release --id <work-id> [--project <dir>] [--outcome completed|abandoned]",
      );
    }
    const outcome =
      typeof flags.outcome === "string"
        ? (flags.outcome as WorkReleaseOutcome)
        : undefined;
    if (
      outcome !== undefined &&
      !["completed", "abandoned"].includes(outcome)
    ) {
      throw new Error("--outcome must be completed or abandoned");
    }
    const project = claimProject(flags);
    const lease = work.list(project).find((item) => item.id === flags.id);
    if (!lease) throw new Error(`work lease not found: ${flags.id}`);
    assertGenericWorkResource(lease.resource);
    console.log(
      `released ${describeWork(work.release(project, flags.id, undefined, outcome))}`,
    );
    return;
  }

  throw new Error(
    "usage: agent-loom work list|tui|acquire|update|release [options]",
  );
}

// --- mute / unmute ------------------------------------------------------------

/** Live sessions selected by --session (name or id) and/or --project. Requires
 * at least one selector so `mute` never silently targets every session. */
function resolveSessionTargets(
  flags: Record<string, string | boolean>,
  usage: string,
): Registration[] {
  const session = typeof flags.session === "string" ? flags.session : undefined;
  const project =
    typeof flags.project === "string"
      ? resolveProjectArg(flags.project)
      : undefined;
  if (!session && !project) {
    console.error(usage);
    process.exit(1);
  }
  const names = claudeSessions();
  return listLive().filter((r) => {
    if (project && canonicalProject(r.cwd) !== project) return false;
    if (session && !matchesSessionName(r, session, names)) return false;
    return true;
  });
}

function cmdSetMuted(
  flags: Record<string, string | boolean>,
  muted: boolean,
): void {
  const targets = resolveSessionTargets(
    flags,
    "usage: agent-loom mute|unmute (--session <name-or-id> | --project <dir>)",
  );
  const names = claudeSessions();
  if (targets.length === 0) {
    console.error("no matching live session");
    const live = listLive();
    if (live.length) {
      console.error("live sessions:");
      for (const r of live)
        console.error(`  ${sessionLabel(r, names)} — ${r.cwd} (pid ${r.pid})`);
    }
    process.exit(1);
  }
  const verb = muted ? "muted" : "unmuted";
  for (const r of targets) {
    setMuted(r.cwd, r.pid, muted);
    console.log(`${verb} ${sessionLabel(r, names)} — ${r.cwd} (pid ${r.pid})`);
  }
}

function cmdSetInboundPolicy(flags: Record<string, string | boolean>): void {
  const policy = typeof flags.policy === "string" ? flags.policy : undefined;
  if (policy !== "accept" && policy !== "hold" && policy !== "refuse") {
    console.error(
      "usage: agent-loom inbound --policy accept|hold|refuse (--session <name-or-id> | --project <dir>)",
    );
    process.exit(1);
  }
  const targets = resolveSessionTargets(
    flags,
    "usage: agent-loom inbound --policy accept|hold|refuse (--session <name-or-id> | --project <dir>)",
  );
  if (targets.length === 0) {
    console.error("no matching live session");
    process.exit(1);
  }
  const names = claudeSessions();
  for (const target of targets) {
    setInboundPolicy(target.cwd, target.pid, policy as InboundPolicy);
    console.log(`${sessionLabel(target, names)} — inbound policy ${policy}`);
  }
}

// --- install -------------------------------------------------------------------

function plistContents(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>ProgramArguments</key>
  <array>
    <string>${runtimePath()}</string>
    <string>${DAEMON_ENTRY}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardErrorPath</key><string>${LOG_PATH}</string>
</dict>
</plist>
`;
}

function registerMcpServer(replace: boolean): void {
  if (!existsSync(CLAUDE_JSON)) {
    console.error(`${CLAUDE_JSON} not found; skipping mcpServers registration`);
    return;
  }
  const doc = JSON.parse(readFileSync(CLAUDE_JSON, "utf8")) as Record<
    string,
    unknown
  >;
  const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
  const existing = servers["agent-loom"];
  // The plugin already provides this server. Adding a user-scope entry under
  // the same name wins Claude's dedup and demotes the channel identity from
  // plugin:agent-loom@<marketplace> to server:agent-loom, which the channels
  // allowlist does not cover — push then fails silently. Withdraw instead, and
  // take our own stale entry with us.
  const plugin = enabledAgentLoomPlugin(readClaudeSettings());
  if (plugin) {
    if (!existing) {
      console.log(
        `plugin ${plugin} is enabled and provides agent-loom; skipping user-scope mcpServers entry`,
      );
      return;
    }
    if (claudeRegistrationMatches(existing, runtimePath(), CHANNEL_ENTRY)) {
      const { "agent-loom": _removed, ...rest } = servers;
      doc.mcpServers = rest;
      writeFileSync(CLAUDE_JSON, JSON.stringify(doc, null, 2));
      console.log(
        `plugin ${plugin} is enabled; removed the redundant user-scope agent-loom entry (it shadowed the plugin and silently broke channel push). Restart Claude sessions to pick this up.`,
      );
      return;
    }
    console.error(
      `plugin ${plugin} is enabled, but ${CLAUDE_JSON} has a different agent-loom mcpServers entry that shadows it and silently breaks channel push. Remove that entry by hand, or run \`claude mcp remove agent-loom\`.`,
    );
    return;
  }
  if (existing) {
    if (claudeRegistrationMatches(existing, runtimePath(), CHANNEL_ENTRY)) {
      console.log("Claude MCP registration already matches this checkout");
      return;
    }
    if (!replace) {
      console.error(
        "Claude already has a different agent-loom MCP entry; leaving it unchanged " +
          "(pass --replace-claude to replace it)",
      );
      return;
    }
  }
  servers["agent-loom"] = {
    type: "stdio",
    command: runtimePath(),
    args: [CHANNEL_ENTRY],
    env: {},
  };
  doc.mcpServers = servers;
  writeFileSync(CLAUDE_JSON, JSON.stringify(doc, null, 2));
  console.log(`registered agent-loom in ${CLAUDE_JSON} mcpServers`);
}

function codexRegistration(): CodexRegistrationProbe {
  const result = spawnSync("codex", ["mcp", "get", "agent-loom", "--json"], {
    encoding: "utf8",
  });
  return classifyCodexRegistrationProbe(
    {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error } : {}),
    },
    "agent-loom",
  );
}

function runCodexMcp(args: string[]): boolean {
  const result = spawnSync("codex", ["mcp", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    console.error(`codex unavailable: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(result.stderr.trim() || `codex mcp ${args[0]} failed`);
    return false;
  }
  return true;
}

function registerCodex(replace: boolean): void {
  let preserved: string[] = [];
  const registration = codexRegistration();
  if (registration.status === "unavailable") {
    console.error(
      `codex not found; skipping Codex MCP registration: ${registration.detail}`,
    );
    return;
  }
  if (registration.status === "invalid" || registration.status === "failed") {
    console.error(
      `could not inspect the Codex agent-loom entry: ${registration.detail}`,
    );
    return;
  }
  if (registration.status === "present") {
    if (
      codexRegistrationMatches(registration.value, runtimePath(), CHANNEL_ENTRY)
    ) {
      console.log("Codex MCP registration already matches this checkout");
      return;
    }
    if (!replace) {
      console.error(
        "Codex already has a different agent-loom MCP entry; leaving it unchanged " +
          "(pass --replace-codex to replace it)",
      );
      return;
    }
    if (!existsSync(CODEX_CONFIG_PATH)) {
      console.error(
        `cannot safely replace the Codex agent-loom entry: ${CODEX_CONFIG_PATH} is unavailable for rollback`,
      );
      return;
    }
    const configSnapshot = readFileSync(CODEX_CONFIG_PATH, "utf8");
    preserved = codexEntrySubTables(configSnapshot);
    const replacement = replaceCodexRegistrationTransaction(
      configSnapshot,
      () => runCodexMcp(["remove", "agent-loom"]),
      () =>
        runCodexMcp(["add", "agent-loom", "--", runtimePath(), CHANNEL_ENTRY]),
      (snapshot) => writeFileSync(CODEX_CONFIG_PATH, snapshot),
    );
    if (replacement !== "replaced") {
      if (replacement === "add-failed-restored") {
        console.error(
          "Codex MCP replacement failed; restored the previous agent-loom registration",
        );
      }
      return;
    }
  } else if (
    !runCodexMcp(["add", "agent-loom", "--", runtimePath(), CHANNEL_ENTRY])
  ) {
    return;
  }
  console.log("registered agent-loom with Codex");
  restoreCodexSubTables(preserved);
}

/** Codex's agent-loom sub-tables as they stand on disk, or none. */
function readCodexEntrySubTables(): string[] {
  if (!existsSync(CODEX_CONFIG_PATH)) return [];
  return codexEntrySubTables(readFileSync(CODEX_CONFIG_PATH, "utf8"));
}

/** Put back what `codex mcp remove` took with the entry. */
function restoreCodexSubTables(blocks: string[]): void {
  if (blocks.length === 0) return;
  if (!existsSync(CODEX_CONFIG_PATH)) return;
  const { document, restored } = restoreCodexEntrySubTables(
    readFileSync(CODEX_CONFIG_PATH, "utf8"),
    blocks,
  );
  if (restored.length === 0) return;
  writeFileSync(CODEX_CONFIG_PATH, document);
  console.log(
    `restored ${restored.length} Codex agent-loom sub-table(s) that the rewrite dropped`,
  );
}

function unregisterCodex(): void {
  const registration = codexRegistration();
  if (registration.status === "unavailable") return;
  if (registration.status === "invalid" || registration.status === "failed") {
    console.error(
      `could not inspect the Codex agent-loom entry: ${registration.detail}`,
    );
    return;
  }
  if (registration.status !== "present") return;
  if (
    !codexRegistrationMatches(registration.value, runtimePath(), CHANNEL_ENTRY)
  ) {
    console.error(
      "Codex agent-loom entry belongs to a different checkout; leaving it unchanged",
    );
    return;
  }
  if (runCodexMcp(["remove", "agent-loom"])) {
    console.log("removed agent-loom from Codex MCP servers");
  }
}

type JsonMcpClient = "Agy" | "Kimi" | "Gemini";

/** Warn when Gemini's global MCP policy would hide a successfully registered
 * server. Registration does not broaden an explicit user allowlist or override
 * an exclusion. */
function diagnoseGeminiMcpPolicy(document: Record<string, unknown>): void {
  if (document.mcp === undefined) return;
  if (
    typeof document.mcp !== "object" ||
    document.mcp === null ||
    Array.isArray(document.mcp)
  ) {
    console.error(
      `${GEMINI_SETTINGS_PATH} has a non-object mcp setting; Gemini may reject it`,
    );
    return;
  }
  const mcp = document.mcp as Record<string, unknown>;
  if (Array.isArray(mcp.allowed) && !mcp.allowed.includes("agent-loom")) {
    console.error(
      `Gemini MCP registration is present, but mcp.allowed in ${GEMINI_SETTINGS_PATH} does not include agent-loom`,
    );
  }
  if (Array.isArray(mcp.excluded) && mcp.excluded.includes("agent-loom")) {
    console.error(
      `Gemini MCP registration is present, but mcp.excluded in ${GEMINI_SETTINGS_PATH} contains agent-loom`,
    );
  }
}

/** Register a stdio server in clients that use a top-level JSON mcpServers
 * map. The config directory is the presence signal, matching hooks install. */
function registerJsonMcpClient(
  client: JsonMcpClient,
  path: string,
  replace: boolean,
): void {
  if (!existsSync(dirname(path))) return;
  let result: ReturnType<typeof upsertStdioMcpRegistration>;
  try {
    result = upsertStdioMcpRegistration(
      readJsonDocument(path),
      runtimePath(),
      CHANNEL_ENTRY,
      replace,
    );
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) {
      throw error;
    }
    console.error(
      `could not inspect ${client} MCP config ${path}: ${error.message}`,
    );
    return;
  }
  if (result.status === "conflict") {
    console.error(
      `${client} already has a different agent-loom MCP entry; leaving it unchanged ` +
        `(pass --replace-${client.toLocaleLowerCase()} to replace it)`,
    );
    return;
  }
  if (result.status === "matching") {
    console.log(`${client} MCP registration already matches this checkout`);
  } else {
    writeFileSync(path, `${JSON.stringify(result.document, null, 2)}\n`);
    console.log(`registered agent-loom in ${path} mcpServers`);
  }
  if (client === "Gemini") diagnoseGeminiMcpPolicy(result.document);
}

function unregisterJsonMcpClient(client: JsonMcpClient, path: string): void {
  if (!existsSync(path)) return;
  let result: ReturnType<typeof removeStdioMcpRegistration>;
  try {
    result = removeStdioMcpRegistration(
      readJsonDocument(path),
      runtimePath(),
      CHANNEL_ENTRY,
    );
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) {
      throw error;
    }
    console.error(
      `could not inspect ${client} MCP config ${path}: ${error.message}`,
    );
    return;
  }
  if (result.status === "foreign") {
    console.error(
      `${client} agent-loom entry belongs to a different checkout; leaving it unchanged`,
    );
    return;
  }
  if (result.status !== "removed") return;
  writeFileSync(path, `${JSON.stringify(result.document, null, 2)}\n`);
  console.log(`removed agent-loom from ${client} MCP servers`);
}

function readJsoncDocument(path: string): {
  document: Record<string, unknown>;
  text: string;
} {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "{}\n";
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (errors.length > 0) {
    const detail = errors
      .map(
        (error) =>
          `${printParseErrorCode(error.error)} at offset ${error.offset}`,
      )
      .join(", ");
    throw new SyntaxError(detail);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${path} must contain a JSON object`);
  }
  return { document: parsed as Record<string, unknown>, text };
}

function registerOpenCode(replace: boolean): void {
  if (!existsSync(OPENCODE_CONFIG_DIR)) return;
  const configPath = openCodeConfigPath();
  try {
    const { document, text } = readJsoncDocument(configPath);
    const result = upsertOpenCodeMcpRegistration(
      document,
      runtimePath(),
      CHANNEL_ENTRY,
      replace,
    );
    if (result.status === "conflict") {
      console.error(
        "OpenCode already has a different agent-loom MCP entry; leaving it unchanged " +
          "(pass --replace-opencode to replace it)",
      );
      return;
    }
    if (result.status === "matching") {
      console.log("OpenCode MCP registration already matches this checkout");
      return;
    }
    const edits = modify(text, [...result.path], result.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    });
    writeFileSync(configPath, applyEdits(text, edits));
    console.log(`registered agent-loom in ${configPath}`);
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) {
      throw error;
    }
    console.error(
      `could not inspect OpenCode MCP config ${configPath}: ${error.message}`,
    );
  }
}

function unregisterOpenCode(): void {
  const configPath = openCodeConfigPath();
  if (!existsSync(configPath)) return;
  try {
    const { document, text } = readJsoncDocument(configPath);
    const result = removeOpenCodeMcpRegistration(
      document,
      runtimePath(),
      CHANNEL_ENTRY,
    );
    if (result.status === "foreign") {
      console.error(
        "OpenCode agent-loom entry belongs to a different checkout; leaving it unchanged",
      );
      return;
    }
    if (result.status !== "removed") return;
    const edits = modify(text, [...result.path], undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    });
    writeFileSync(configPath, applyEdits(text, edits));
    console.log("removed agent-loom from OpenCode MCP servers");
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) {
      throw error;
    }
    console.error(
      `could not inspect OpenCode MCP config ${configPath}: ${error.message}`,
    );
  }
}

function readClaudeSettings(): Record<string, unknown> {
  if (!existsSync(CLAUDE_SETTINGS)) return {};
  const parsed = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${CLAUDE_SETTINGS} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function installNativeAuditHook(): void {
  const result = addNativeAuditHook(
    readClaudeSettings(),
    runtimePath(),
    NATIVE_AUDIT_ENTRY,
  );
  if (!result.changed) {
    console.log("Claude native SendMessage audit hook already installed");
    return;
  }
  mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true });
  writeFileSync(
    CLAUDE_SETTINGS,
    `${JSON.stringify(result.document, null, 2)}\n`,
  );
  console.log(`installed native SendMessage audit hook in ${CLAUDE_SETTINGS}`);
}

function uninstallNativeAuditHook(): void {
  if (!existsSync(CLAUDE_SETTINGS)) return;
  const result = removeNativeAuditHook(
    readClaudeSettings(),
    NATIVE_AUDIT_ENTRY,
  );
  if (!result.changed) return;
  writeFileSync(
    CLAUDE_SETTINGS,
    `${JSON.stringify(result.document, null, 2)}\n`,
  );
  console.log(`removed native SendMessage audit hook from ${CLAUDE_SETTINGS}`);
}

/** Unload and remove the LaunchAgent installed under the pre-rename label, so
 * two daemons never contend for one port. */
function retireLegacyLaunchAgent(): void {
  const legacyPlist = join(
    homedir(),
    "Library",
    "LaunchAgents",
    `${LEGACY_LAUNCHD_LABEL}.plist`,
  );
  if (!existsSync(legacyPlist)) return;
  try {
    launchctl("bootout", `${guiDomain()}/${LEGACY_LAUNCHD_LABEL}`);
  } catch {
    // not loaded
  }
  rmSync(legacyPlist);
  console.log(`removed ${legacyPlist}`);
}

function cmdInstall(flags: Record<string, string | boolean>): void {
  if (flags["dry-run"] === true) {
    console.log(JSON.stringify(installPlan(), null, 2));
    return;
  }
  // Platform-neutral: a Linux upgrade must adopt the old store too.
  for (const migration of migrateLegacyDirectories()) {
    if (migration.outcome === "moved") {
      console.log(
        `moved ${migration.from} to ${migration.to} (old path is a symlink)`,
      );
    } else if (migration.outcome === "conflict") {
      console.error(
        `both ${migration.from} and ${migration.to} exist; merge them by hand, then remove ${migration.from}`,
      );
      process.exit(1);
    }
  }
  if (process.platform !== "darwin") {
    console.error(
      "agent-loom install configures a macOS launchd service. On Linux, register the MCP server as shown in the README and run `agent-loom start` for a bare daemon.",
    );
    process.exit(1);
  }
  ensureDirs();
  if (!existsSync(CONFIG_PATH)) {
    const configTemplate = [
      "# agent-loom config",
      `port = ${loadConfig().port}`,
      '# slack_webhook = "https://hooks.slack.com/services/..."',
      '# slack_echo = "all"  # or "none"',
      "# Short aliases for long project bases in session labels (comma list):",
      '# session_aliases = "llm-performance-models=augur, dependency-routing=deproute"',
      '# inbound_policy = "accept"  # accept, hold, or refuse',
      "# duplicate_window_seconds = 10",
      "# message_rate_limit_per_minute = 60",
      "# default_message_ttl_seconds = 0  # 0 means no default expiry",
      "# held_message_limit = 100",
      "# Serve the HTTP dashboard. Off by default: it renders every project's",
      "# sessions, and the daemon port is reachable by any local process.",
      "# dashboard = true",
      "# Editable Slack dashboard (agent-loom slack-dashboard) needs a bot token:",
      '# slack_bot_token = "xoxb-..."  # chat:write scope; invite the bot to the channel',
      '# slack_channel = "C0123ABCD"',
      "",
    ].join("\n");
    writeFileSync(CONFIG_PATH, configTemplate);
    console.log(`wrote ${CONFIG_PATH}`);
  }
  retireLegacyLaunchAgent();
  writeFileSync(PLIST_PATH, plistContents());
  console.log(`wrote ${PLIST_PATH}`);
  writeClaudePluginMcp();
  try {
    launchctl("bootout", `${guiDomain()}/${LAUNCHD_LABEL}`);
  } catch {
    // not previously loaded
  }
  // Stop any bare-mode daemon so launchd can own the port.
  const pid = daemonPid();
  if (pid !== null && signalPid(pid, "SIGTERM")) {
    sleepSync(500);
  }
  launchctl("bootstrap", guiDomain(), PLIST_PATH);
  console.log("daemon bootstrapped via launchd (starts at boot)");
  registerMcpServer(flags["replace-claude"] === true);
  if (flags["no-codex"] !== true) {
    registerCodex(flags["replace-codex"] === true);
  }
  registerJsonMcpClient("Agy", AGY_MCP_PATH, flags["replace-agy"] === true);
  registerJsonMcpClient("Kimi", KIMI_MCP_PATH, flags["replace-kimi"] === true);
  registerJsonMcpClient(
    "Gemini",
    GEMINI_SETTINGS_PATH,
    flags["replace-gemini"] === true,
  );
  registerOpenCode(flags["replace-opencode"] === true);
  if (flags["native-audit"] === true) installNativeAuditHook();
  // Post-check: report the observed channel opt-in state. Instructions printed
  // here go stale; the state cannot (see channelSetup.ts).
  console.log("");
  for (const line of describeChannelSetup(
    inspectChannelSetup(CHANNEL_ENTRY),
    dirname(SRC_DIR),
  ))
    console.log(line);
}

function cmdUninstall(): void {
  try {
    launchctl("bootout", `${guiDomain()}/${LAUNCHD_LABEL}`);
  } catch {
    // not loaded
  }
  if (existsSync(PLIST_PATH)) {
    rmSync(PLIST_PATH);
    console.log(`removed ${PLIST_PATH}`);
  }
  if (existsSync(CLAUDE_JSON)) {
    const doc = JSON.parse(readFileSync(CLAUDE_JSON, "utf8")) as Record<
      string,
      unknown
    >;
    const servers = doc.mcpServers as Record<string, unknown> | undefined;
    if (
      servers &&
      claudeRegistrationMatches(
        servers["agent-loom"],
        runtimePath(),
        CHANNEL_ENTRY,
      )
    ) {
      const { "agent-loom": _removed, ...rest } = servers;
      doc.mcpServers = rest;
      writeFileSync(CLAUDE_JSON, JSON.stringify(doc, null, 2));
      console.log("removed agent-loom from mcpServers");
    } else if (servers && "agent-loom" in servers) {
      console.error(
        "Claude agent-loom entry belongs to a different checkout; leaving it unchanged",
      );
    }
  }
  unregisterCodex();
  unregisterJsonMcpClient("Agy", AGY_MCP_PATH);
  unregisterJsonMcpClient("Kimi", KIMI_MCP_PATH);
  unregisterJsonMcpClient("Gemini", GEMINI_SETTINGS_PATH);
  unregisterOpenCode();
  uninstallNativeAuditHook();
}

async function cmdDashboard(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const config = loadConfig();
  if (!config.dashboard) {
    // Refused rather than treated as its own opt-in: "off by default" has to
    // mean the same thing to the person typing this and to the daemon, or the
    // setting only documents half the feature. The env form turns it on for
    // one invocation without editing config.
    console.error(
      `agent-loom dashboard is off. Enable it with \`dashboard = true\` in ${CONFIG_PATH}, or for this run only:\n  AGENT_LOOM_DASHBOARD=1 agent-loom dashboard`,
    );
    process.exitCode = 1;
    return;
  }
  if (typeof flags.port !== "string") {
    const url = `http://127.0.0.1:${config.port}/`;
    try {
      const response = await fetch(`${url}health`, {
        signal: AbortSignal.timeout(750),
      });
      if (response.ok) {
        console.log(`agent-loom dashboard → ${url} (persistent daemon)`);
        if (flags.open === true) openBrowser(url);
        return;
      }
    } catch {
      // The direct-filesystem standalone server below remains available when
      // launchd is stopped or the configured daemon port is unreachable.
    }
  }
  const port =
    typeof flags.port === "string" ? Number(flags.port) : config.port + 1;
  const server = await serveDashboard(port);
  const url = `http://127.0.0.1:${server.port}/`;
  console.log(`agent-loom dashboard → ${url}`);
  if (flags.open === true) openBrowser(url);

  // Single cleanup, idempotent, run on every exit path so the terminal never
  // stays in raw mode.
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    server.stop(true);
  };
  process.on("exit", cleanup);

  if (!process.stdin.isTTY || flags["no-tui"] === true) {
    console.log("serving; press Ctrl-C to stop");
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(sig, () => {
        cleanup();
        process.exit(0);
      });
    }
    return; // keep-alive: the open server handle keeps the event loop running
  }

  console.log("press o to open in browser, q to quit");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (key: string) => {
    // Raw mode suppresses SIGINT, so Ctrl-C (0x03) arrives as data.
    if (key === "q" || key === "\u0003") {
      cleanup();
      process.stdout.write("\n");
      process.exit(0);
    } else if (key === "o") {
      openBrowser(url);
    }
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }
}

async function cmdState(
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (flags.revision === true) {
    console.log(JSON.stringify(stateRevision()));
    return;
  }
  const project =
    typeof flags.project === "string"
      ? canonicalProject(flags.project)
      : undefined;
  if (flags["no-sync"] !== true) {
    const config = loadConfig();
    const query = project ? `?project=${encodeURIComponent(project)}` : "";
    try {
      const response = await fetch(
        `http://127.0.0.1:${config.port}/api/v1/state${query}`,
        { signal: AbortSignal.timeout(750) },
      );
      if (response.ok) {
        console.log(await response.text());
        return;
      }
    } catch {
      // The filesystem fallback updates only the disposable message index.
    }
  }
  console.log(JSON.stringify(buildReadOnlyState({ project }), null, 2));
}

async function cmdSlackDashboard(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const config = loadConfig();
  const watch = typeof flags.watch === "string" ? Number(flags.watch) : 0;
  try {
    console.log(await refreshSlackDashboard(config));
  } catch (err) {
    if (err instanceof SlackDashboardUnconfigured) {
      console.error(`${err.message}

Set up a Slack app with a bot token (chat:write scope), invite it to the
channel, then add to ${CONFIG_PATH}:
  slack_bot_token = "xoxb-..."
  slack_channel = "C0123ABCD"`);
      process.exit(1);
    }
    throw err;
  }
  if (watch > 0) {
    console.log(`refreshing every ${watch}s; press Ctrl-C to stop`);
    setInterval(() => {
      refreshSlackDashboard(config)
        .then((s) => console.log(s))
        .catch((e) => console.error(`refresh failed: ${e.message}`));
    }, watch * 1000);
  }
}

const HELP = `agent-loom — durable coordination between coding-agent sessions

Usage: agent-loom <command> [options]

Messaging:
  notify --project <dir> --message <text> [--from <label>] [--reply-to <id>]
         [--session <name-or-id> | --role owner] [--idempotency-key <key>] [--ttl <seconds>]
         [--no-slack]
                        Send a message to a project's inbox. --session
                        addresses one live session instead of broadcasting.
                        Exact IDs and unique human names resolve globally.
                        --project disambiguates name collisions, never IDs.
                        Empty, unknown, or ambiguous targets are errors.
                        --reply-to addresses the original sender in their live
                        mailbox and inherits the thread; --session overrides it.
                        An unresolved reply recipient is an error, not a broadcast.
                        --role owner selects the project's owner instead of a
                        session. Unknown or ambiguous owners never broadcast.
  inbox [--project <dir>] [--limit N] [--unread] [--peek]
                        Read a project's spool (defaults to cwd). A read with a
                        session id in the environment records a pushed receipt
                        per message and marks them read; --peek leaves them
                        unread, and a read with no session id stays
                        unattributed.
  triage-candidates [--project <dir>] [--limit N]
                        Return bounded, versioned JSON containing unread
                        broadcasts and direct mail with no accepting recipient.
  mark-read [--project <dir>] (--id <message-id>... | --all)
                        Mark one or more messages read
  receipts [--project <dir>] [--id <message-id>] [--limit N]
                        Show append-only delivery state changes
  listeners [--project <dir>] [--json] [--no-sync]
                        List sessions. --no-sync reads only the daemon's fresh
                        snapshot and never scans or prunes the registry.
  session-address --project <absolute-dir> --session <raw-id> --json
                        Resolve advisory identity from the fresh snapshot only.
                        No environment selectors, registry scans, or writes.
  unregistered [--window <minutes>]
                        Name sessions that recorded delivery with no live
                        registration — a session the registry has lost is
                        still consuming mail but cannot be addressed. Exits 1
                        when any are found. Default window 60 minutes.
  mute | unmute (--session <name-or-id> | --project <dir>)
                        Pause / resume channel push for matching sessions
  inbound --policy accept|hold|refuse (--session <name-or-id> | --project <dir>)
                        Set inbound treatment for matching sessions

Coordination:
  owner [show|claim|release] [--project <dir>] [--json]
                        Inspect the project owner, or claim/release your explicit
                        assignment. With no assignment, the sole live session is
                        the inferred owner; multiple sessions require a claim.
  claim-experiment [--project <dir>] [--notebook <dir>] [--owner <label>]
                        Atomically reserve the next EXP-NNN number
  claim-path --path <path> [--path <path> ...] [--directory]
             [--project <dir>] [--owner <label>]
             [--plan <stem> [--plan-project <dir>]]
                        Claim an edit set; prints a one-time release token
  claims [--project <dir> | --all] [--history]
                        List active claims, optionally retained history
  release-claim (--id <claim-id> | --token <release-token>)
                [--project <dir>]
                        Release by token, session identity, or plan executor
  mail history --session <id> --project <absolute-dir>
                        Version-1 JSON incoming/outgoing history, read-only
  mail tui --session <id> --project <absolute-dir> [--once]
                        Read-only timeline; Enter expands, j/k scroll, g follows
  work list [--project <dir> | --all] [--type <type>] [--owner <owner>]
                        List exclusive logical-work leases
  work tui --session <id> --project <absolute-dir> [--once]
                        Read-only plans for one exact session and project
  work acquire --type <type> --key <key> [--label <label>] [--source <path>]
               [--state working|waiting] [--activity <text>] [--project <dir>]
               [--owner <label>]
               [--step <n> [--steps <n>] [--step-label <text>] | --clear-progress]
                        Acquire exclusive responsibility for logical work
  work update --id <work-id> [--state working|waiting] [--activity <text>]
              [--step <n> [--steps <n>] [--step-label <text>] | --clear-progress]
                        Update a work lease
  work release --id <work-id> [--project <dir>]
               [--outcome completed|abandoned]
                        Release work and any plan-owned claims
  coordination list [--project <dir> | --all] [--kind <kind>]
                    [--owner <owner>] [--condition <condition>] [--json]
                        List work and claims with recovery conditions
  coordination recover --id <coordination-id>
                       [--authority <text> --reason <text>]
                        Release a record only when its owner is proven offline.
                        Forced recovery requires authority and reason; both are
                        recorded in the append-only forced-recoveries log
  coordination request-transfer --id <work-id> [--reason <text>]
                    [--timeout <seconds>] [--owner <label>]
                        Request an auditable asynchronous work handoff
  coordination respond-transfer --id <request-id>
                    --decision accept|decline [--message <text>]
                        Answer a transfer request as the exact lease owner
  coordination transfers [--project <dir> | --all] [--json]
                        List transfer requests and dispositions
  obligations announce (--obligor <name-or-id> | --user |
                        --system <name> | --component <name>)
                       --kind claim_release|decision|external_fix|
                              job_completion|review
                       --subject <text> [--description <text>]
                        Announce that another session, the operator, a
                        system, or a component's owner owes
                        your session an outcome. Announced, not negotiated:
                        you create and close the record; the obligor may
                        contest but never confirms. A session obligor is
                        resolved like --session recipients and gets one
                        notice; --system names a wired integration (claims,
                        weft) and settles by its own events;
                        --component names the component whose owner owes
                        the repair, and its notice goes to the resolved
                        owner. A role or system obligor cannot contest.
                        Open issue-ledger issues are already obligations —
                        they list as read-only issue:<id> rows with no
                        announce.
                        Keep the subject a short plain-text decision name; put
                        findings, settled constraints, and consequences in
                        description. Description accepts multiline Markdown;
                        each option accepts inline Markdown and Unicode math
                        (one line, up to 500 characters).
  obligations update --id <obligation-id>
                       [--description <text> | --clear-description]
                       [--option <text> ... | --clear-options]
                       [--marker <value> [--marker-kind path|label]
                        [--marker-label <text>] ... | --clear-markers]
                        Amend an open record's presentation fields in place.
                        Obligee-only. Description accepts multiline Markdown;
                        options accept inline Markdown and Unicode math (one
                        line each, up to 500 characters). Markers are typed
                        (path or label) and canonicalized at write time.
                        Subject, kind, and obligor never edit.
  obligations comment --id <obligation-id> --text <text> [--user]
                        Append a note to an open record. Either end or the
                        operator may comment; comments are append-only and
                        never move the status.
  obligations close --id <obligation-id> [--resolution <text>]
                        Close your record as satisfied; only the obligee
                        session closes. claim_release records settle on their
                        own when the claim releases; job_completion, review,
                        and role-obligor records settle on their system's
                        events.
  obligations withdraw --id <obligation-id>
                        Retract your record without claiming satisfaction
  obligations contest --id <obligation-id> --reason <text> [--user]
                        Mark the record disputed; it stays visible and tagged.
                        --user contests as the operator on records naming you.
  obligations adopt (--predecessor <id> --resume-id <id> |
                     --predecessor <id> --authority <text> --reason <text>)
                        Inherit an offline session's open obligations, in both
                        roles; exactly one succession proof is required
  obligations clear --id <obligation-id> --authority <text> --reason <text>
                        Withdraw on declared operator authority (recorded,
                        never verified)
  obligations list [--all] [--owed]
  obligations owed      Open records naming the operator as obligor, across
                        every project — what you owe, in one place

Issue-ledger hooks:
  issues watcher-token    Print the caller's agent-loom: watcher token, or
                          nothing without a proved host-process match
  issues event            Read one issue-ledger-event/v1 JSON document from
                          stdin, notify exact recipients, and refresh the daemon

Dashboards:
  state [--project <dir>] [--no-sync] [--json]
                        Versioned aggregate state; does not change mail or
                        coordination. Uses the daemon when available; --no-sync
                        reads snapshots and updates the disposable message index.
  state --revision      Digest of the files state is built from; poll it and
                        read state only when it changes.
  dashboard [--port N] [--open] [--no-tui]
                        Show the persistent daemon dashboard, or serve a
                        direct-filesystem fallback when the daemon is down.
                        Off unless dashboard = true is set in config.
  slack-dashboard [--watch <seconds>]
                        Post / refresh the editable Slack dashboard

Status line:
  status-line [--project <dir>] [--session <id>] [--json | --fields] [--work] [--debug]
                        Print this session's display name, SessionStatus v1 JSON,
                        or tab-separated fields. JSON always includes work;
                        unresolved identity is null and collection errors fail.
                        --work appends versioned logical-work JSON to --fields.

Reminders (hook-driven, for pull-only harnesses):
  remind --format agy|codex|kimi|gemini|pi [--event <name>] [--session <id>]
         [--project <dir>]
                        Print an unread-mail reminder for a harness hook, or
                        a no-op response when there is nothing new to say.
                        Reads the daemon's unread summary. A new Codex/Kimi
                        Stop edge exits 2 on stderr; Agy continues through its
                        JSON Stop response. Failures exit 0.
  hooks install [--agy] [--codex] [--kimi] [--gemini] [--gemini-after-tool]
  hooks uninstall [--agy] [--codex] [--kimi] [--gemini]
  hooks status [--agy] [--codex] [--kimi] [--gemini]
                        Register, remove, or inspect the harness hooks that
                        run "agent-loom remind". With no harness flag, targets
                        every harness whose config directory exists
                        (~/.gemini/config, ~/.codex, ~/.kimi-code, ~/.gemini).
                        Gemini's AfterTool hook is synchronous, so it installs
                        only with --gemini-after-tool.

Daemon (launchd-aware):
  start | stop | restart   Manage the daemon process
  graceful                 Reload config (SIGHUP) without a restart
  status                   Daemon health + listening sessions
  logs [-f] [--mcp|--lifecycle]
                           Show, or follow, the daemon log; --mcp selects
                           sanitized pre-handshake MCP failures, --lifecycle
                           channel-server attach, exit, and prune records

Setup:
  mcp                   Run the MCP server on stdio. This is what an agent's
                        config launches; you do not run it by hand.
  oh-my-pi-plugin-path  Print the bundled OMP push plugin directory for
                        "omp plugin link".
  install [--dry-run] [--native-audit] [--no-codex]
          [--replace-claude] [--replace-agy] [--replace-codex]
          [--replace-kimi] [--replace-gemini] [--replace-opencode]
                        Install daemon and MCP entries for Claude, Agy, Codex,
                        and installed Kimi, Gemini, and OpenCode clients;
                        optionally audit native Claude SendMessage traffic.
                        macOS only;
                        --dry-run prints the versioned install plan anywhere.
  uninstall             Remove integrations owned by this checkout

Config: ~/.config/agent-loom/config.toml  (port, Slack webhook/bot token)`;

function printHelp(stream: "out" | "err" = "out"): void {
  (stream === "err" ? console.error : console.log)(HELP);
}

/** Report live sessions the registry has lost.
 *
 * Delivery is recipient-driven and never reads the registry, so a session
 * whose entry was deleted keeps consuming mail and stamping receipts while no
 * sender can address it. Comparing recent receipts against live registrations
 * names that session directly, instead of waiting for a peer to hit a refusal.
 *
 * Reads the tail of each receipt log rather than the whole file: the logs are
 * append-only and never pruned, so a full read grows without bound while only
 * the recent window can carry a live fault. */
function cmdUnregistered(flags: Record<string, string | boolean>): void {
  const windowMinutes =
    typeof flags.window === "string" ? Number(flags.window) : 60;
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    console.error("agent-loom: --window must be a positive number of minutes");
    process.exit(1);
  }
  const live = new Set(
    listLive()
      .map((entry) => entry.sessionId)
      .filter((id): id is string => Boolean(id)),
  );
  const receipts: DeliveryReceipt[] = [];
  const TAIL_BYTES = 512 * 1024;
  if (existsSync(RECEIPTS_DIR)) {
    for (const name of readdirSync(RECEIPTS_DIR)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(RECEIPTS_DIR, name);
      const size = statSync(path).size;
      const text = readFileSliceSync(
        path,
        Math.max(0, size - TAIL_BYTES),
        size,
      );
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          receipts.push(JSON.parse(line) as DeliveryReceipt);
        } catch {
          // A torn or partly-sliced line is not evidence either way.
        }
      }
    }
  }
  const found = unregisteredActiveSessions(
    receipts,
    live,
    Date.now(),
    windowMinutes * 60_000,
  );
  if (found.length === 0) {
    console.log(
      `no unregistered active sessions in the last ${windowMinutes}m`,
    );
    return;
  }
  // A session that exited cleanly also unregisters, and its receipts stay in
  // the log — so a row here is "recorded activity with no live registration",
  // which is the fault when the session is still running and merely history
  // when it is not. Say that rather than let the reader assume the first.
  console.log(
    `${found.length} session(s) recorded delivery in the last ${windowMinutes}m with no live registration.`,
  );
  console.log(
    "A session still running is unaddressable: senders will be told it is not listening.",
  );
  for (const session of found) {
    console.log(
      `${session.sessionId}  ${session.project}  last ${session.lastActivity}  ${session.receipts} receipt(s)`,
    );
  }
  process.exit(1);
}

// --- dispatch -------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

// `--help` after a subcommand asks the command to explain itself, and every
// command below acts instead: `inbox --help` printed an inbox, and `notify
// --help` would have sent a message. A flag meaning "explain yourself" must
// never be the one that performs the action, so intercept it before dispatch.
if (rest.includes("--help") || rest.includes("-h")) {
  printHelp();
  process.exit(0);
}

switch (cmd) {
  case "notify":
    await cmdNotify(flags);
    break;
  case "mail":
    cmdMail(rest);
    break;
  case "inbox":
    cmdInbox(flags);
    break;
  case "triage-candidates":
    cmdTriageCandidates(flags);
    break;
  case "mark-read":
    cmdMarkRead(flags, rest);
    break;
  case "receipts":
    cmdReceipts(flags);
    break;
  case "listeners":
    cmdListeners(flags);
    break;
  case "session-address":
    cmdSessionAddress(flags);
    break;
  case "status-line":
    await cmdStatusLine(flags);
    break;
  case "remind":
    await cmdRemind(flags);
    break;
  case "hooks":
    cmdHooks(flags, rest);
    break;
  case "oh-my-pi-plugin-path":
    cmdOhMyPiPluginPath();
    break;
  case "mute":
    cmdSetMuted(flags, true);
    break;
  case "unmute":
    cmdSetMuted(flags, false);
    break;
  case "inbound":
    cmdSetInboundPolicy(flags);
    break;
  case "claim-experiment":
    cmdClaimExperiment(flags);
    break;
  case "claim-path":
    cmdClaimPath(flags, rest);
    break;
  case "unregistered":
    cmdUnregistered(flags);
    break;
  case "claims":
    cmdClaims(flags);
    break;
  case "release-claim":
    cmdReleaseClaim(flags);
    break;
  case "owner":
    cmdOwner(flags, rest);
    break;
  case "work":
    cmdWork(flags, rest);
    break;
  case "coordination":
    cmdCoordination(flags, rest);
    break;
  case "obligations":
    cmdObligations(flags, rest);
    break;
  case "issues":
    if (rest.length === 1 && rest[0] === "watcher-token") {
      cmdIssuesWatcherToken();
    } else if (rest.length === 1 && rest[0] === "event") {
      await cmdIssuesEvent();
    } else {
      console.error("usage: agent-loom issues watcher-token | event");
      process.exitCode = 1;
    }
    break;
  case "start":
    await cmdStart();
    break;
  case "stop":
    cmdStop();
    break;
  case "restart":
    await cmdRestart();
    break;
  case "graceful":
  case "reload":
    cmdGraceful();
    break;
  case "status":
    await cmdStatus();
    break;
  case "logs":
    cmdLogs(rest);
    break;
  case "dashboard":
    await cmdDashboard(flags);
    break;
  case "state":
    await cmdState(flags);
    break;
  case "slack-dashboard":
    await cmdSlackDashboard(flags);
    break;
  case "mcp":
    // Run the MCP server in this process. Importing it starts it; it owns
    // stdio from here, so nothing below may read stdin or write stdout.
    //
    // This exists so one command can both register and be the server, which is
    // what lets a client be configured in a single line without a prior global
    // install. The daemon is a separate, optional step: sending falls back to
    // appending to the spool directly when no daemon answers.
    installMcpStartupDiagnostics();
    await import("./channel.ts");
    break;
  case "install":
    cmdInstall(flags);
    break;
  case "uninstall":
    cmdUninstall();
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  default:
    console.error(`agent-loom: unknown command "${cmd}"\n`);
    printHelp("err");
    process.exit(1);
}
