/** Filesystem-backed coordination claims for agents sharing a project. */

import { randomBytes, randomUUID } from "node:crypto";
import {
  type Stats,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { type LockOwner, withFileLock } from "./lock.ts";
import { obligations } from "./obligations.ts";
import { CLAIMS_DIR, canonicalProject, projectSlug } from "./paths.ts";

export const PATH_CLAIM_SESSION_GRACE_MS = 15 * 60 * 1000;
export const PATH_CLAIM_MANUAL_TTL_MS = 24 * 60 * 60 * 1000;
export const PATH_CLAIM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ClaimOwnerKind = "session" | "manual" | "plan";

export interface PlanClaimIdentity {
  project: string;
  stem: string;
}

export interface ClaimOwner {
  id: string;
  label: string;
  kind?: ClaimOwnerKind;
  sessionId?: string;
  plan?: PlanClaimIdentity;
  pid?: number;
  procStart?: string;
  instanceId?: string;
}

interface ClaimBase {
  id: string;
  project: string;
  owner: ClaimOwner;
  createdAt: string;
}

export interface PathClaimTarget {
  path: string;
  pathType: "file" | "directory";
}

export interface PathClaimRequestTarget {
  path: string;
  pathType?: PathClaimTarget["pathType"];
}

export type PathClaimState = "active" | "restart-grace" | "released";
export type PathClaimReleaseReason =
  | "owner-request"
  | "forced-recovery"
  | "session-absence"
  | "manual-expiry"
  | "plan-completed"
  | "plan-abandoned"
  | "plan-lease-lost";

/** Current path-claim shape. The singular path/pathType projection keeps
 * already-running pre-group readers conservative for grouped claims. */
export interface PathClaim extends ClaimBase {
  type: "path";
  paths: PathClaimTarget[];
  path: string;
  pathType: PathClaimTarget["pathType"];
  releaseToken: string;
  state: PathClaimState;
  lastActivityAt: string;
  graceDeadline?: string;
  releasedAt?: string;
  releaseReason?: PathClaimReleaseReason;
  retainedUntil?: string;
}

/** Records written before grouped claims and release tokens remain readable. */
export interface LegacyPathClaim extends ClaimBase {
  type: "path";
  path: string;
  pathType: PathClaimTarget["pathType"];
  paths?: undefined;
  releaseToken?: undefined;
  state?: undefined;
  lastActivityAt?: undefined;
  graceDeadline?: undefined;
  releasedAt?: undefined;
  releaseReason?: undefined;
  retainedUntil?: undefined;
}

export interface ExperimentClaim extends ClaimBase {
  type: "experiment";
  notebook: string;
  experimentId: string;
  number: number;
}

export type AnyPathClaim = PathClaim | LegacyPathClaim;
export type Claim = AnyPathClaim | ExperimentClaim;

export interface PathClaimAcquisition {
  claim: AnyPathClaim;
  disposition: "acquired" | "existing";
  /** Issued only for a newly acquired claim. */
  releaseToken?: string;
}

export interface ClaimReleaseResult {
  claim: Claim;
  disposition: "released" | "already-released";
}

export interface PathClaimStoreOptions {
  /** Fresh session liveness observation made while the project lock is held. */
  sessionIsLive?: (sessionId: string) => boolean | undefined;
  /** Current executor for a plan, or undefined when its lease is not held. */
  planExecutor?: (plan: PlanClaimIdentity) => ClaimOwner | undefined;
  /** Calling process that must match the current executor for a plan claim. */
  actor?: ClaimOwner;
  now?: () => Date;
}

export function pathClaimTargets(claim: AnyPathClaim): PathClaimTarget[] {
  return "paths" in claim && claim.paths
    ? claim.paths
    : [{ path: claim.path, pathType: claim.pathType }];
}

export function claimOwnerKind(owner: ClaimOwner): ClaimOwnerKind {
  if (owner.kind) return owner.kind;
  return owner.sessionId ? "session" : "manual";
}

export function sameClaimOwner(a: ClaimOwner, b: ClaimOwner): boolean {
  const aKind = claimOwnerKind(a);
  if (aKind !== claimOwnerKind(b)) return false;
  if (aKind === "session") {
    return Boolean(a.sessionId) && a.sessionId === b.sessionId;
  }
  if (aKind === "plan") {
    return (
      a.plan !== undefined &&
      b.plan !== undefined &&
      a.plan.project === b.plan.project &&
      a.plan.stem === b.plan.stem
    );
  }
  return a.label === b.label;
}

function sameOwnerProcess(a: ClaimOwner, b: ClaimOwner): boolean {
  if (a.id !== b.id) return false;
  if (a.instanceId || b.instanceId) {
    return a.instanceId !== undefined && a.instanceId === b.instanceId;
  }
  if (a.procStart || b.procStart) {
    return (
      a.pid !== undefined &&
      a.pid === b.pid &&
      a.procStart !== undefined &&
      a.procStart === b.procStart
    );
  }
  return (
    a.pid === undefined && b.pid === undefined && !a.sessionId && !b.sessionId
  );
}

function experimentOwnerMatches(
  owner: ClaimOwner,
  credential: string | ClaimOwner,
): boolean {
  return typeof credential === "string"
    ? owner.id === credential
    : sameOwnerProcess(owner, credential);
}

export function pathClaimIsOverdue(
  claim: AnyPathClaim,
  nowMs = Date.now(),
): boolean {
  if (!("state" in claim) || claim.state === undefined) return false;
  if (claim.state === "released") return true;
  if (claim.state === "restart-grace") {
    return Date.parse(claim.graceDeadline ?? "") <= nowMs;
  }
  return (
    claimOwnerKind(claim.owner) === "manual" &&
    nowMs - Date.parse(claim.lastActivityAt) >= PATH_CLAIM_MANUAL_TTL_MS
  );
}

export type PathClaimOwnerCondition =
  | "session-live"
  | "session-restart-grace"
  | "manual-fresh"
  | "plan-held"
  | "released";

export function pathClaimOwnerCondition(
  claim: AnyPathClaim,
): PathClaimOwnerCondition {
  if ("state" in claim && claim.state === "released") return "released";
  if ("state" in claim && claim.state === "restart-grace") {
    return "session-restart-grace";
  }
  const kind = claimOwnerKind(claim.owner);
  if (kind === "manual") return "manual-fresh";
  if (kind === "plan") return "plan-held";
  return "session-live";
}

/** Text identifying what a claim is on, used for deterministic display order. */
function claimSortKey(claim: Claim): string {
  return claim.type === "path"
    ? pathClaimTargets(claim)
        .map((target) => target.path)
        .sort()
        .join("\u0000")
    : `${claim.notebook}\u0000${claim.experimentId}`;
}

export function compareClaims(a: Claim, b: Claim): number {
  return (
    a.createdAt.localeCompare(b.createdAt) ||
    claimSortKey(a).localeCompare(claimSortKey(b)) ||
    a.id.localeCompare(b.id)
  );
}

export class ClaimConflictError extends Error {
  readonly claimId: string;
  readonly overlappingPaths: string[];

  constructor(claim: Claim, overlappingPaths: string[] = []) {
    const resource =
      claim.type === "path"
        ? overlappingPaths.length > 0
          ? `overlapping targets ${[...new Set(overlappingPaths)].join(" and ")}`
          : pathClaimTargets(claim)
              .map((target) => target.path)
              .join(", ")
        : `${claim.experimentId} in ${claim.notebook}`;
    super(
      `${resource} ${claim.type === "path" ? "are" : "is"} claimed by ${claim.owner.label} (${claim.id})`,
    );
    this.name = "ClaimConflictError";
    this.claimId = claim.id;
    this.overlappingPaths = [...new Set(overlappingPaths)];
  }
}

export function canonicalPath(path: string, symlinkDepth = 0): string {
  if (symlinkDepth > 40) {
    throw new Error(`too many symbolic links while resolving ${path}`);
  }
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    const candidate = resolve(cursor, parts[index]);
    let stat: Stats;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      return resolve(candidate, ...parts.slice(index + 1));
    }
    if (stat.isSymbolicLink()) {
      const destination = resolve(
        dirname(candidate),
        readlinkSync(candidate),
        ...parts.slice(index + 1),
      );
      return canonicalPath(destination, symlinkDepth + 1);
    }
    cursor = candidate;
  }
  return realpathSync(cursor);
}

function isWithin(project: string, path: string): boolean {
  const rel = relative(project, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathsConflict(a: PathClaimTarget, b: PathClaimTarget): boolean {
  if (a.path === b.path) return true;
  if (a.pathType === "directory" && isWithin(a.path, b.path)) return true;
  return b.pathType === "directory" && isWithin(b.path, a.path);
}

function sameTargets(a: PathClaimTarget[], b: PathClaimTarget[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (target, index) =>
        target.path === b[index].path && target.pathType === b[index].pathType,
    )
  );
}

function normalizedTargets(
  project: string,
  targets: PathClaimRequestTarget[],
): PathClaimTarget[] {
  if (targets.length === 0)
    throw new Error("at least one claim path is required");
  const byPath = new Map<string, PathClaimTarget["pathType"]>();
  for (const target of targets) {
    const path = canonicalPath(target.path);
    if (!isWithin(project, path)) {
      throw new Error(
        `claim target must be inside project ${project}: ${path}`,
      );
    }
    let pathType = target.pathType ?? "file";
    if (existsSync(path)) {
      const stat = statSync(path);
      const observed = stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : undefined;
      if (!observed)
        throw new Error(`claim target is not a file or directory: ${path}`);
      if (target.pathType && target.pathType !== observed) {
        throw new Error(`${path} is a ${observed}, not a ${target.pathType}`);
      }
      pathType = observed;
    }
    const previous = byPath.get(path);
    if (previous && previous !== pathType) {
      throw new Error(
        `${path} cannot be claimed as both a ${previous} and a ${pathType}`,
      );
    }
    byPath.set(path, pathType);
  }

  const candidates = [...byPath.entries()]
    .map(([path, pathType]) => ({ path, pathType }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other !== candidate &&
          other.pathType === "directory" &&
          isWithin(other.path, candidate.path),
      ),
  );
}

function requireValidOwner(owner: ClaimOwner): void {
  const kind = claimOwnerKind(owner);
  if (kind === "session" && !owner.sessionId) {
    throw new Error("session claim owner requires a session id");
  }
  if (kind !== "session" && owner.sessionId) {
    throw new Error(`a ${kind} claim owner cannot carry a session id`);
  }
  if (kind === "plan") {
    if (!owner.plan?.stem) {
      throw new Error("plan claim owner requires a plan project and stem");
    }
    if (canonicalProject(owner.plan.project) !== owner.plan.project) {
      throw new Error("plan claim owner project must be canonical");
    }
    return;
  }
  if (owner.plan) {
    throw new Error("only a plan claim owner may carry a plan identity");
  }
}

function releaseToken(): string {
  return randomBytes(32).toString("base64url");
}

export class ClaimStore {
  private readonly root: string;
  private readonly onReleased: (claimId: string, releasedAt: string) => void;

  constructor(
    root = CLAIMS_DIR,
    onReleased: (claimId: string, releasedAt: string) => void = (
      claimId,
      releasedAt,
    ) => obligations.settleReleasedClaim(claimId, { now: releasedAt }),
  ) {
    this.root = root;
    this.onReleased = onReleased;
  }

  private projectDir(project: string): string {
    return join(this.root, projectSlug(project));
  }

  private releasedDir(project: string): string {
    return join(this.projectDir(project), "released");
  }

  private lockPath(project: string): string {
    return join(this.root, `${projectSlug(project)}.lock`);
  }

  private withLock<T>(project: string, fn: () => T, owner?: LockOwner): T {
    return withFileLock(this.lockPath(project), fn, { owner });
  }

  private readDirectory(dir: string): Claim[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Claim)
      .sort(compareClaims);
  }

  private readReleasedDirectory(dir: string, nowMs: number): PathClaim[] {
    const retained: PathClaim[] = [];
    for (const claim of this.readDirectory(dir)) {
      if (claim.type !== "path" || claim.state !== "released") continue;
      if (Date.parse(claim.retainedUntil ?? "") <= nowMs) continue;
      retained.push(claim);
    }
    return retained;
  }

  private listStored(project: string): Claim[] {
    return this.readDirectory(this.projectDir(canonicalProject(project)));
  }

  /** Raw active records for read-only status surfaces; performs no lifecycle transitions. */
  peek(project: string): Claim[] {
    return this.listStored(project);
  }
  list(
    project: string,
    nowMs = Date.now(),
    options: PathClaimStoreOptions = {},
  ): Claim[] {
    const canonical = canonicalProject(project);
    if (!existsSync(this.projectDir(canonical))) return [];
    return this.withLock(canonical, () => {
      const now = new Date(nowMs);
      for (const stored of this.listStored(canonical)) {
        if (stored.type !== "path") continue;
        const claim = this.refreshClaim(stored, options, now);
        if (!claim || !pathClaimIsOverdue(claim, nowMs)) continue;
        const reason =
          claimOwnerKind(claim.owner) === "manual"
            ? "manual-expiry"
            : "session-absence";
        const releasedAt =
          reason === "manual-expiry"
            ? new Date(
                Date.parse(claim.lastActivityAt ?? claim.createdAt) +
                  PATH_CLAIM_MANUAL_TTL_MS,
              ).toISOString()
            : (claim.graceDeadline ?? now.toISOString());
        this.releasePathClaim(claim, reason, releasedAt);
      }
      return this.listStored(canonical);
    });
  }

  listReleased(project: string, nowMs = Date.now()): PathClaim[] {
    const canonical = canonicalProject(project);
    return this.readReleasedDirectory(this.releasedDir(canonical), nowMs);
  }

  private projectDirectories(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".lock"))
      .map((entry) => join(this.root, entry.name));
  }

  private listAllStored(): Claim[] {
    return this.projectDirectories()
      .flatMap((dir) => this.readDirectory(dir))
      .sort(
        (a, b) => a.project.localeCompare(b.project) || compareClaims(a, b),
      );
  }

  /** Raw active records across projects; performs no lifecycle transitions. */
  peekAll(): Claim[] {
    return this.listAllStored();
  }

  listAll(nowMs = Date.now(), options: PathClaimStoreOptions = {}): Claim[] {
    const projects = new Set(
      this.listAllStored().map((claim) => claim.project),
    );
    return [...projects]
      .flatMap((project) => this.list(project, nowMs, options))
      .sort(
        (a, b) => a.project.localeCompare(b.project) || compareClaims(a, b),
      );
  }

  listAllReleased(nowMs = Date.now()): PathClaim[] {
    return this.projectDirectories()
      .flatMap((dir) =>
        this.readReleasedDirectory(join(dir, "released"), nowMs),
      )
      .sort(
        (a, b) => a.project.localeCompare(b.project) || compareClaims(a, b),
      );
  }

  pruneReleased(nowMs = Date.now()): number {
    let removed = 0;
    for (const projectDir of this.projectDirectories()) {
      const releasedDir = join(projectDir, "released");
      for (const claim of this.readDirectory(releasedDir)) {
        if (
          claim.type !== "path" ||
          claim.state !== "released" ||
          Date.parse(claim.retainedUntil ?? "") > nowMs
        ) {
          continue;
        }
        const path = join(releasedDir, `${claim.id}.json`);
        if (!existsSync(path)) continue;
        unlinkSync(path);
        removed += 1;
      }
    }
    return removed;
  }

  private write(claim: Claim, replace = false): void {
    const dir = this.projectDir(claim.project);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${claim.id}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(claim, null, 2)}\n`, {
      flag: "wx",
    });
    if (!replace && existsSync(path)) {
      unlinkSync(temporary);
      throw new Error(`claim already exists: ${claim.id}`);
    }
    renameSync(temporary, path);
  }

  private releasePathClaim(
    claim: AnyPathClaim,
    reason: PathClaimReleaseReason,
    releasedAt: string,
  ): PathClaim {
    const released: PathClaim = {
      ...claim,
      paths: pathClaimTargets(claim),
      releaseToken: claim.releaseToken ?? "",
      state: "released",
      lastActivityAt: claim.lastActivityAt ?? claim.createdAt,
      releasedAt,
      releaseReason: reason,
      retainedUntil: new Date(
        Date.parse(releasedAt) + PATH_CLAIM_RETENTION_MS,
      ).toISOString(),
    };
    released.graceDeadline = undefined;
    const dir = this.releasedDir(claim.project);
    mkdirSync(dir, { recursive: true });
    const destination = join(dir, `${claim.id}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(released, null, 2)}\n`, {
      flag: "wx",
    });
    renameSync(temporary, destination);
    const activePath = join(this.projectDir(claim.project), `${claim.id}.json`);
    if (existsSync(activePath)) unlinkSync(activePath);
    // A release settles open claim-release obligations on this claim inside
    // the releasing transaction (specs/obligations.allium; ADR 0021). Every
    // release reason funnels through here, so settlement covers owner
    // requests, forced recovery, expiry, and lost plan leases alike.
    this.onReleased(claim.id, releasedAt);
    return released;
  }

  private refreshClaim(
    claim: AnyPathClaim,
    options: PathClaimStoreOptions,
    now: Date,
  ): PathClaim | undefined {
    let current: PathClaim;
    if (!("state" in claim) || claim.state === undefined) {
      current = {
        ...claim,
        paths: pathClaimTargets(claim),
        releaseToken: releaseToken(),
        state: "active",
        lastActivityAt: claim.createdAt,
      };
      this.write(current, true);
    } else {
      current = claim;
    }
    const kind = claimOwnerKind(current.owner);
    if (kind === "manual") {
      if (pathClaimIsOverdue(current, now.getTime())) {
        this.releasePathClaim(
          current,
          "manual-expiry",
          new Date(
            Date.parse(current.lastActivityAt) + PATH_CLAIM_MANUAL_TTL_MS,
          ).toISOString(),
        );
        return undefined;
      }
      return current;
    }
    if (kind === "plan") {
      if (!options.planExecutor || !current.owner.plan) return current;
      if (!options.planExecutor(current.owner.plan)) {
        this.releasePathClaim(current, "plan-lease-lost", now.toISOString());
        return undefined;
      }
      return current;
    }
    if (!current.owner.sessionId || !options.sessionIsLive) return current;
    const live = options.sessionIsLive(current.owner.sessionId);
    if (live === undefined) return current;
    if (
      current.state === "restart-grace" &&
      pathClaimIsOverdue(current, now.getTime())
    ) {
      this.releasePathClaim(
        current,
        "session-absence",
        current.graceDeadline ?? now.toISOString(),
      );
      return undefined;
    }
    if (live) {
      if (current.state === "restart-grace") {
        const active: PathClaim = { ...current, state: "active" };
        active.graceDeadline = undefined;
        this.write(active, true);
        return active;
      }
      return current;
    }
    if (current.state === "active") {
      const grace: PathClaim = {
        ...current,
        state: "restart-grace",
        graceDeadline: new Date(
          now.getTime() + PATH_CLAIM_SESSION_GRACE_MS,
        ).toISOString(),
      };
      this.write(grace, true);
      return grace;
    }
    return current;
  }

  claimPath(
    project: string,
    target: string,
    pathType: PathClaimTarget["pathType"] | undefined,
    owner: ClaimOwner,
    options: PathClaimStoreOptions = {},
  ): PathClaimAcquisition {
    return this.claimPaths(
      project,
      [{ path: target, pathType }],
      owner,
      options,
    );
  }

  claimPaths(
    project: string,
    targets: PathClaimRequestTarget[],
    owner: ClaimOwner,
    options: PathClaimStoreOptions = {},
  ): PathClaimAcquisition {
    requireValidOwner(owner);
    if (claimOwnerKind(owner) === "plan") {
      const executor = owner.plan && options.planExecutor?.(owner.plan);
      if (
        !executor ||
        !options.actor ||
        !sameOwnerProcess(executor, options.actor)
      ) {
        throw new Error(
          `only the current executor may acquire claims for plan ${owner.plan?.stem ?? "<unknown>"}`,
        );
      }
    }
    const canonical = canonicalProject(project);
    const requested = normalizedTargets(canonical, targets);
    return this.withLock(
      canonical,
      () => {
        const now = options.now?.() ?? new Date();
        const active: AnyPathClaim[] = [];
        for (const candidate of this.listStored(canonical)) {
          if (candidate.type !== "path") continue;
          const refreshed = this.refreshClaim(candidate, options, now);
          if (refreshed) active.push(refreshed);
        }
        const existing = active.find(
          (claim) =>
            sameClaimOwner(claim.owner, owner) &&
            sameTargets(pathClaimTargets(claim), requested),
        );
        if (existing) {
          if (
            claimOwnerKind(existing.owner) === "manual" &&
            "state" in existing &&
            existing.state !== undefined
          ) {
            const renewed: PathClaim = {
              ...existing,
              lastActivityAt: now.toISOString(),
            };
            this.write(renewed, true);
            return { claim: renewed, disposition: "existing" };
          }
          return { claim: existing, disposition: "existing" };
        }
        for (const claim of active) {
          if (sameClaimOwner(claim.owner, owner)) continue;
          const heldTargets = pathClaimTargets(claim);
          for (const held of heldTargets) {
            const requestedTarget = requested.find((target) =>
              pathsConflict(held, target),
            );
            if (requestedTarget) {
              throw new ClaimConflictError(claim, [
                held.path,
                requestedTarget.path,
              ]);
            }
          }
        }
        const token = releaseToken();
        const claim: PathClaim = {
          id: randomUUID(),
          type: "path",
          project: canonical,
          paths: requested,
          path: requested.length === 1 ? requested[0].path : canonical,
          pathType:
            requested.length === 1 ? requested[0].pathType : "directory",
          releaseToken: token,
          state: "active",
          owner: { ...owner, kind: claimOwnerKind(owner) },
          createdAt: now.toISOString(),
          lastActivityAt: now.toISOString(),
        };
        this.write(claim);
        return { claim, disposition: "acquired", releaseToken: token };
      },
      owner,
    );
  }

  claimExperiment(
    project: string,
    notebook: string,
    owner: ClaimOwner,
  ): ExperimentClaim {
    const canonical = canonicalProject(project);
    const notebookPath = canonicalPath(notebook);
    if (!isWithin(canonical, notebookPath)) {
      throw new Error(
        `notebook must be inside project ${canonical}: ${notebookPath}`,
      );
    }
    const experiments = join(notebookPath, "experiments");
    if (!existsSync(experiments) || !statSync(experiments).isDirectory()) {
      throw new Error(`experiments directory does not exist: ${experiments}`);
    }
    return this.withLock(
      canonical,
      () => {
        const fileNumbers = readdirSync(experiments, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map(
            (entry) => /^EXP-(\d+)(?:\.md|-[^/]+\.md)$/.exec(entry.name)?.[1],
          )
          .filter((value): value is string => value !== undefined)
          .map(Number);
        const claimedNumbers = this.listStored(canonical)
          .filter(
            (claim): claim is ExperimentClaim =>
              claim.type === "experiment" && claim.notebook === notebookPath,
          )
          .map((claim) => claim.number);
        const number = Math.max(0, ...fileNumbers, ...claimedNumbers) + 1;
        const experimentId = `EXP-${String(number).padStart(3, "0")}`;
        const claim: ExperimentClaim = {
          id: randomUUID(),
          type: "experiment",
          project: canonical,
          notebook: notebookPath,
          experimentId,
          number,
          owner,
          createdAt: new Date().toISOString(),
        };
        this.write(claim);
        return claim;
      },
      owner,
    );
  }

  release(request: {
    claimId?: string;
    releaseToken?: string;
    project?: string;
    actor?: ClaimOwner;
    sessionIsLive?: (sessionId: string) => boolean | undefined;
    planExecutor?: (plan: PlanClaimIdentity) => ClaimOwner | undefined;
    now?: Date;
  }): ClaimReleaseResult {
    if (
      (request.claimId === undefined) ===
      (request.releaseToken === undefined)
    ) {
      throw new Error("release requires exactly one claim id or release token");
    }
    if (request.claimId?.trim() === "" || request.releaseToken?.trim() === "") {
      throw new Error("claim id and release token must not be empty");
    }
    const requestNow = request.now ?? new Date();
    const project = request.project
      ? canonicalProject(request.project)
      : undefined;
    const active = project ? this.listStored(project) : this.listAllStored();
    const released = project
      ? this.listReleased(project, requestNow.getTime())
      : this.listAllReleased(requestNow.getTime());
    const matches = (claim: Claim): boolean =>
      request.releaseToken !== undefined
        ? claim.type === "path" &&
          "releaseToken" in claim &&
          claim.releaseToken === request.releaseToken
        : claim.id === request.claimId;
    const liveClaim = active.find(matches);
    if (!liveClaim) {
      const prior = released.find(matches);
      if (prior) return { claim: prior, disposition: "already-released" };
      throw new Error("unknown claim");
    }

    return this.withLock(
      liveClaim.project,
      () => {
        let current = this.listStored(liveClaim.project).find(matches);
        if (!current) {
          const prior = this.listReleased(
            liveClaim.project,
            requestNow.getTime(),
          ).find(matches);
          if (prior) return { claim: prior, disposition: "already-released" };
          throw new Error("unknown claim");
        }
        if (current.type === "path") {
          const refreshed = this.refreshClaim(
            current,
            {
              sessionIsLive: request.sessionIsLive,
              planExecutor: request.planExecutor,
            },
            requestNow,
          );
          if (!refreshed) {
            const prior = this.listReleased(
              liveClaim.project,
              requestNow.getTime(),
            ).find(matches);
            if (prior) {
              return { claim: prior, disposition: "already-released" };
            }
            throw new Error("unknown claim");
          }
          current = refreshed;
        }
        if (current.type === "experiment") {
          if (
            !request.actor ||
            !experimentOwnerMatches(current.owner, request.actor)
          ) {
            throw new Error(
              `claim ${current.id} belongs to ${current.owner.label}; only its owner can release it`,
            );
          }
          unlinkSync(
            join(this.projectDir(current.project), `${current.id}.json`),
          );
          this.onReleased(current.id, requestNow.toISOString());
          return { claim: current, disposition: "released" };
        }

        const byToken =
          request.releaseToken !== undefined &&
          "releaseToken" in current &&
          current.releaseToken === request.releaseToken;
        let byIdentity = false;
        if (request.actor) {
          const kind = claimOwnerKind(current.owner);
          if (kind === "session") {
            byIdentity =
              claimOwnerKind(request.actor) === "session" &&
              Boolean(current.owner.sessionId) &&
              current.owner.sessionId === request.actor.sessionId;
          } else if (
            kind === "plan" &&
            current.owner.plan &&
            request.planExecutor
          ) {
            const executor = request.planExecutor(current.owner.plan);
            byIdentity =
              executor !== undefined &&
              sameOwnerProcess(executor, request.actor);
          }
        }
        if (!byToken && !byIdentity) {
          throw new Error(
            `claim ${current.id} belongs to ${current.owner.label}; release requires its token or proven owner identity`,
          );
        }
        const releasedClaim = this.releasePathClaim(
          current,
          "owner-request",
          requestNow.toISOString(),
        );
        return { claim: releasedClaim, disposition: "released" };
      },
      request.actor,
    );
  }

  recover(
    project: string,
    claimId: string,
    ownerIsLive: (owner: ClaimOwner, claim: Claim) => boolean,
    options: {
      reason?: PathClaimReleaseReason;
      at?: string;
    } = {},
  ): Claim {
    const canonical = canonicalProject(project);
    return this.withLock(canonical, () => {
      const claim = this.listStored(canonical).find(
        (item) => item.id === claimId,
      );
      if (!claim) throw new Error(`claim not found: ${claimId}`);
      const reason = options.reason ?? "forced-recovery";
      const now = options.at ? new Date(options.at) : new Date();
      if (
        claim.type === "path" &&
        reason === "session-absence" &&
        claimOwnerKind(claim.owner) === "session"
      ) {
        const current: PathClaim =
          "state" in claim && claim.state
            ? claim
            : {
                ...claim,
                paths: pathClaimTargets(claim),
                releaseToken: releaseToken(),
                state: "active",
                lastActivityAt: claim.createdAt,
              };
        if (current !== claim) this.write(current, true);
        const live = ownerIsLive(current.owner, current);
        if (
          current.state === "restart-grace" &&
          pathClaimIsOverdue(current, now.getTime())
        ) {
          return this.releasePathClaim(
            current,
            "session-absence",
            current.graceDeadline ?? now.toISOString(),
          );
        }
        if (live) {
          if (current.state === "restart-grace") {
            const active: PathClaim = { ...current, state: "active" };
            active.graceDeadline = undefined;
            this.write(active, true);
          }
          throw new Error(
            `claim ${claimId} belongs to ${current.owner.label}; its owner is live or cannot be verified offline`,
          );
        }
        if (current.state === "active") {
          const grace: PathClaim = {
            ...current,
            state: "restart-grace",
            graceDeadline: new Date(
              now.getTime() + PATH_CLAIM_SESSION_GRACE_MS,
            ).toISOString(),
          };
          this.write(grace, true);
          throw new Error(
            `claim ${claimId} is in restart grace until ${grace.graceDeadline}`,
          );
        }
        throw new Error(
          `claim ${claimId} is in restart grace until ${current.graceDeadline}`,
        );
      }
      if (ownerIsLive(claim.owner, claim)) {
        throw new Error(
          `claim ${claimId} belongs to ${claim.owner.label}; its owner is live or cannot be verified offline`,
        );
      }
      if (claim.type === "experiment") {
        unlinkSync(join(this.projectDir(canonical), `${claim.id}.json`));
        return claim;
      }
      if (
        reason === "manual-expiry" &&
        !pathClaimIsOverdue(claim, now.getTime())
      ) {
        throw new Error(`claim ${claimId} has not reached its manual expiry`);
      }
      const releasedAt =
        options.at ??
        (reason === "manual-expiry" && claim.lastActivityAt
          ? new Date(
              Date.parse(claim.lastActivityAt) + PATH_CLAIM_MANUAL_TTL_MS,
            ).toISOString()
          : new Date().toISOString());
      return this.releasePathClaim(claim, reason, releasedAt);
    });
  }

  observeSessions(liveSessionIds: ReadonlySet<string>, now = new Date()): void {
    const projects = new Set(
      this.listAllStored()
        .filter(
          (claim): claim is AnyPathClaim =>
            claim.type === "path" &&
            claimOwnerKind(claim.owner) === "session" &&
            Boolean(claim.owner.sessionId),
        )
        .map((claim) => claim.project),
    );
    for (const project of projects) {
      this.withLock(project, () => {
        for (const claim of this.listStored(project)) {
          if (
            claim.type !== "path" ||
            claimOwnerKind(claim.owner) !== "session" ||
            !claim.owner.sessionId
          ) {
            continue;
          }
          this.refreshClaim(
            claim,
            { sessionIsLive: (id) => liveSessionIds.has(id) },
            now,
          );
        }
      });
    }
  }

  releasePlanOwner(
    plan: PlanClaimIdentity,
    reason: Extract<
      PathClaimReleaseReason,
      "plan-completed" | "plan-abandoned" | "plan-lease-lost"
    >,
    at = new Date().toISOString(),
  ): number {
    let count = 0;
    const projects = new Set(
      this.listAllStored()
        .filter(
          (claim): claim is AnyPathClaim =>
            claim.type === "path" &&
            claimOwnerKind(claim.owner) === "plan" &&
            claim.owner.plan?.project === plan.project &&
            claim.owner.plan.stem === plan.stem,
        )
        .map((claim) => claim.project),
    );
    for (const project of projects) {
      this.withLock(project, () => {
        for (const claim of this.listStored(project)) {
          if (
            claim.type === "path" &&
            claimOwnerKind(claim.owner) === "plan" &&
            claim.owner.plan?.project === plan.project &&
            claim.owner.plan.stem === plan.stem
          ) {
            this.releasePathClaim(claim, reason, at);
            count += 1;
          }
        }
      });
    }
    return count;
  }

  /** Session path claims enter restart grace instead of being deleted. */
  releaseOwner(project: string, ownerId: string, ownerPid?: number): number {
    const canonical = canonicalProject(project);
    return this.withLock(canonical, () => {
      const releasable = this.listStored(canonical).filter(
        (claim) =>
          claim.type === "experiment" &&
          claim.owner.id === ownerId &&
          (ownerPid === undefined || claim.owner.pid === ownerPid),
      );
      for (const claim of releasable) {
        unlinkSync(join(this.projectDir(canonical), `${claim.id}.json`));
      }
      return releasable.length;
    });
  }
}

export const claims = new ClaimStore();
