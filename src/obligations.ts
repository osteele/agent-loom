/** Filesystem-backed obligations: a party announcing that another party owes
 * it a specific outcome. The contract is specs/obligations.allium; the model
 * is announced, not negotiated — the obligee creates the record and closes
 * it, the obligor can contest but never confirm, and deterministic evidence
 * (a claim release, a system event) settles waits without belief. Parties
 * are sessions, the human operator, systems, and roles. Records are
 * machine-global (they span projects), under one lock, and there is no
 * time-based expiry: liveness and reference health are conditions on open
 * records, never status. */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withFileLock } from "./lock.ts";
import { OBLIGATIONS_DIR } from "./paths.ts";
import { listLive } from "./registry.ts";

/** Marker shape validation plus canonicalization: a path marker resolves
 * against the announce/update base directory (the caller's project) to an
 * absolute path, resolving symlinks when the target exists; a label marker
 * keeps its reference text verbatim. Shape only — a missing path is a
 * display concern, never an announce error. */
function canonicalMarker(
  marker: ObligationMarker,
  baseDir: string,
): ObligationMarker {
  const label =
    marker.label !== undefined
      ? { label: validateText(marker.label, "marker label") }
      : {};
  if (marker.type === "label") {
    return {
      type: "label",
      value: validateText(marker.value, "marker reference text"),
      ...label,
    };
  }
  if (marker.type !== "path") {
    throw new Error("marker type must be path or label");
  }
  const expanded =
    marker.value === "~" || marker.value.startsWith("~/")
      ? join(homedir(), marker.value.slice(2))
      : marker.value;
  const absolute = expanded.startsWith("/")
    ? expanded
    : resolve(baseDir, expanded);
  return {
    type: "path",
    value: existsSync(absolute) ? realpathSync(absolute) : absolute,
    ...label,
  };
}

export type PartyKind = "session" | "human" | "system" | "role";
export type RoleKind =
  | "component_owner"
  | "plan_executor"
  | "experiment_claimer";
export type ObligationKind =
  | "claim_release"
  | "decision"
  | "external_fix"
  | "job_completion"
  | "review";
export type ObligationStatus = "open" | "satisfied" | "withdrawn";
export type ClosedBy = "obligee" | "system" | "user_authority";
export type RefState = "unverified" | "resolves" | "unresolvable";

export interface SessionRef {
  sessionId: string;
  label: string;
}

/** A session end with its party kind attached — the actor shape for
 * close/withdraw and the adopter, so call sites cannot drop the kind. */
export type SessionParty = SessionRef & { kind: "session" };

/** A named responsibility, resolved exactly at read and act time:
 * component_owner via project ownership, plan_executor via the plan's
 * current work-lease executor (ADR 0019), experiment_claimer via the
 * experiment's claimer of record. */
export type Role =
  | { kind: "component_owner"; component: string }
  | { kind: "plan_executor"; plan: string }
  | { kind: "experiment_claimer"; experiment: string };

/** An obligation end. `session` is structurally a SessionRef, so existing
 * call sites that name a session keep working. The human is a single
 * principal on this machine (ADR 0001); a system is a local integration
 * with a versioned event or CLI surface ("weft", "agent-issues", ...); a
 * role names a responsibility rather than a process. */
export type Party =
  | SessionParty
  | { kind: "human"; label: string }
  | { kind: "system"; system: string; label: string }
  | { kind: "role"; role: Role; label: string };

/** How a party resolves right now. A session resolves to its live process;
 * the human always resolves; a system resolves when its integration's
 * settlement hook is configured; a role resolves when exactly one
 * responsible session holds it. A party that resolves to nobody carries the
 * reason — it renders as unresolvable, never guessed. */
export type PartyResolution =
  | { state: "resolves"; sessionId?: string }
  | { state: "unresolvable"; reason: string };

/** The one responsible session for a role, or undefined when the role is
 * held by nobody or contested between claimants. Injected, never imported:
 * the resolution sources (work leases, claims, project ownership) import
 * this module, so an eager import here would close an evaluation cycle. */
export type ObligationRoleResolver = (role: Role) => string | undefined;

export interface Obligation {
  version: 2;
  id: string;
  createdAt: string;
  obligee: Party;
  obligor: Party;
  kind: ObligationKind;
  subject: string;
  /** Decision context and evidence, separate from the short identifying subject. */
  description?: string;
  status: ObligationStatus;
  contested: boolean;
  contestedAt?: string;
  contestReason?: string;
  resolution?: string;
  closedBy?: ClosedBy;
  closedAt?: string;
  retainedUntil?: string;
  adoptedFrom?: string;
  adoptedAt?: string;
  /** For an authority-based adoption: who declared it. Recorded, never
   * verified (ADR 0004). */
  adoptedAuthority?: string;
  /** For a user-authority clear: who declared it and why. Recorded, never
   * verified. */
  authority?: string;
  authorityReason?: string;
  /** Declared choices for a decision the obligor may pick from; presentation
   * only — closure stays free-text belief, so membership is never enforced.
   * A recommendation is a comment, never a privileged option index. */
  options?: string[];
  /** Background documentation for the ask: an absolute path marker, or a
   * label marker whose reference text resolves against the obligee's lab
   * notebook. Validated for shape, never dereferenced by the store. */
  markers?: ObligationMarker[];
  /** Append-only commentary from either end or the operator — never a
   * lifecycle event. */
  comments?: ObligationComment[];
  revision: number;
}

export interface ObligationMarker {
  type: "path" | "label";
  /** Canonical absolute path (path markers) or the reference text (label
   * markers). */
  value: string;
  /** Free-form display label; the UI shows the value when absent. */
  label?: string;
}

export interface ObligationComment {
  author: string;
  authorKind: PartyKind;
  at: string;
  text: string;
}

export interface RefObservation {
  version: 1;
  obligationId: string;
  state: RefState;
  issueId?: string;
  observedAt: string;
}

/** The retained lifetime of a terminal record: thirty days, matching the
 * claims system's released_claim_retention. */
export const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ObligationLiveness = (sessionId: string) => boolean;

/** Called once after a successful announce whose obligor can receive a
 * push: a session obligor resolves to itself, a role obligor to the one
 * responsible session. The delivery layer turns this into the ordinary
 * push contract; human and system obligors are never notified (their
 * surfaces are the owed view and their own event feeds). The label is the
 * obligor party's, not the resolved session's minted name — the delivery
 * layer resolves names itself. */
export type ObligationNotify = (
  obligation: Obligation,
  resolvedObligor?: SessionParty,
) => void;

export class ObligationDuplicateError extends Error {
  readonly obligation: Obligation;

  constructor(obligation: Obligation) {
    super(
      `an open obligation for this subject already exists: ${obligation.id}`,
    );
    this.name = "ObligationDuplicateError";
    this.obligation = obligation;
  }
}

export class ObligationAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObligationAuthorityError";
  }
}

export class ObligationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObligationStateError";
  }
}

export type ObligationNow = { now?: string };

export type Succession =
  | { kind: "resume-id"; resumeId: string }
  | { kind: "authority"; authority: string; reason: string };

const KINDS: readonly ObligationKind[] = [
  "claim_release",
  "decision",
  "external_fix",
  "job_completion",
  "review",
];

/** Systems whose settlement hook this repo configures, and therefore the
 * system names a `system` party may use: claims settles in the release
 * transaction, weft through the notify command, agent-issues through the
 * daemon's ref observer. A system outside this set has no wired settlement
 * hook, so a record waiting on it could never settle by evidence — announce
 * refuses it rather than minting a wait nothing can satisfy. */
const WIRED_SYSTEMS: readonly string[] = ["claims", "weft", "agent-issues"];

/** Whether the named system's settlement hook is one this build configures —
 * the PartyResolves answer for a system party. */
export function systemWired(system: string): boolean {
  return WIRED_SYSTEMS.includes(system);
}

export interface ObligationStoreOptions {
  root?: string;
  /** Verifies a session's registered process identity is alive. Required:
   * a default that answered "live" for everything would silently violate
   * the announce and adoption rules when left unwired. */
  isLive: ObligationLiveness;
  notify?: ObligationNotify;
  /** Resolves a role to its one responsible session. Optional only for
   * stores that never see role parties; an announce naming a role without
   * one is refused rather than guessed. The process-wide store is wired by
   * obligationResolution.ts, late-bound to keep the import cycle one-way. */
  resolveRole?: ObligationRoleResolver;
}

function validateText(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty`);
  if (trimmed.length > 500) throw new Error(`${name} is too long`);
  if ([...trimmed].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return trimmed;
}

function validateDescription(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("description must not be empty");
  if (trimmed.length > 10_000) throw new Error("description is too long");
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10) {
      throw new Error("description must not contain control characters");
    }
  }
  return trimmed;
}

/** The role's display name: "owner of agent-mail", "executor of
 * <project>/<stem>", "claimer of EXP-042". */
export function describeRole(role: Role): string {
  switch (role.kind) {
    case "component_owner":
      return `owner of ${role.component}`;
    case "plan_executor":
      return `executor of ${role.plan}`;
    case "experiment_claimer":
      return `claimer of ${role.experiment}`;
  }
}

/** Stable identity of a party for the OneOpenPerSubject key (obligee party,
 * kind, subject) and for comparing parties across records. */
export function partyKey(party: Party): string {
  switch (party.kind) {
    case "session":
      return `session:${party.sessionId}`;
    case "human":
      return "human";
    case "system":
      return `system:${party.system}`;
    case "role": {
      const role = party.role;
      const detail =
        role.kind === "component_owner"
          ? role.component
          : role.kind === "plan_executor"
            ? role.plan
            : role.experiment;
      return `role:${role.kind}:${detail}`;
    }
  }
}

/** Validate and normalize a party carried by an announce. Labels fall back
 * to the identity that already names the party, so a role or system party
 * never needs a hand-written label to be addressable. */
function normalizePartyInput(party: Party, side: string): Party {
  switch (party.kind) {
    case "session":
      return {
        kind: "session",
        sessionId: validateText(party.sessionId, `${side} session id`),
        label: validateText(party.label, `${side} label`),
      };
    case "human":
      return {
        kind: "human",
        label: validateText(party.label, `${side} label`),
      };
    case "system":
      return {
        kind: "system",
        system: validateText(party.system, `${side} system name`),
        label: validateText(party.label, `${side} label`),
      };
    case "role": {
      const role = party.role;
      if (role.kind === "component_owner") {
        return {
          kind: "role",
          role: {
            kind: "component_owner",
            component: validateText(role.component, `${side} component`),
          },
          label: validateText(party.label, `${side} label`),
        };
      }
      if (role.kind === "plan_executor") {
        return {
          kind: "role",
          role: {
            kind: "plan_executor",
            plan: validateText(role.plan, `${side} plan`),
          },
          label: validateText(party.label, `${side} label`),
        };
      }
      return {
        kind: "role",
        role: {
          kind: "experiment_claimer",
          experiment: validateText(role.experiment, `${side} experiment`),
        },
        label: validateText(party.label, `${side} label`),
      };
    }
  }
}

/** Legacy records on disk predate the party model: the obligee was a bare
 * `{sessionId, label}` and the obligor a two-shape union without an
 * explicit `kind: "session"` discrimination on the session arm. Normalized
 * on read so real state keeps loading; the next write persists version 2. */
function normalizeStoredParty(value: unknown, side: string): Party {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${side} is not a party: ${JSON.stringify(value)}`);
  }
  const raw = value as {
    kind?: string;
    sessionId?: unknown;
    label?: unknown;
    system?: unknown;
    role?: {
      kind?: string;
      component?: unknown;
      plan?: unknown;
      experiment?: unknown;
    };
  };
  const label = typeof raw.label === "string" ? raw.label : "";
  switch (raw.kind) {
    case "session":
    case undefined: {
      // A missing kind is the legacy obligee shape: a bare session ref.
      if (typeof raw.sessionId !== "string" || !raw.sessionId) {
        throw new Error(`${side} has no session id`);
      }
      return {
        kind: "session",
        sessionId: raw.sessionId,
        label: label || raw.sessionId,
      };
    }
    case "human":
      return { kind: "human", label: label || "user" };
    case "system":
      if (typeof raw.system !== "string" || !raw.system) {
        throw new Error(`${side} has no system name`);
      }
      return { kind: "system", system: raw.system, label: label || raw.system };
    case "role": {
      const role = raw.role;
      if (
        typeof role !== "object" ||
        role === null ||
        typeof role.kind !== "string"
      ) {
        throw new Error(`${side} has no role`);
      }
      if (
        role.kind === "component_owner" &&
        typeof role.component === "string"
      ) {
        return {
          kind: "role",
          role: { kind: "component_owner", component: role.component },
          label:
            label ||
            describeRole({
              kind: "component_owner",
              component: role.component,
            }),
        };
      }
      if (role.kind === "plan_executor" && typeof role.plan === "string") {
        return {
          kind: "role",
          role: { kind: "plan_executor", plan: role.plan },
          label:
            label || describeRole({ kind: "plan_executor", plan: role.plan }),
        };
      }
      if (
        role.kind === "experiment_claimer" &&
        typeof role.experiment === "string"
      ) {
        return {
          kind: "role",
          role: { kind: "experiment_claimer", experiment: role.experiment },
          label:
            label ||
            describeRole({
              kind: "experiment_claimer",
              experiment: role.experiment,
            }),
        };
      }
      throw new Error(`${side} has an unknown role kind: ${role.kind}`);
    }
    default:
      throw new Error(`${side} has an unknown party kind: ${String(raw.kind)}`);
  }
}

function normalizeStoredObligation(raw: unknown): Obligation {
  const record = raw as Record<string, unknown>;
  return {
    ...(record as unknown as Obligation),
    version: 2,
    obligee: normalizeStoredParty(record.obligee, "obligee"),
    obligor: normalizeStoredParty(record.obligor, "obligor"),
  };
}

export class ObligationStore {
  private readonly root: string;
  private readonly isLive: ObligationLiveness;
  private readonly notify: ObligationNotify;
  private resolveRoleImpl: ObligationRoleResolver | undefined;

  constructor(options: ObligationStoreOptions) {
    this.root = options.root ?? OBLIGATIONS_DIR;
    this.isLive = options.isLive;
    this.notify = options.notify ?? (() => {});
    this.resolveRoleImpl = options.resolveRole;
  }

  /** Late-bound role resolution for the process-wide store. A setter rather
   * than a constructor option because the resolution sources (work, claims,
   * workspace ownership) import this module; wiring them here would close
   * the module-evaluation cycle. See obligationResolution.ts. */
  attachRoleResolver(resolver: ObligationRoleResolver): void {
    this.resolveRoleImpl = resolver;
  }

  private withLock<T>(fn: () => T): T {
    return withFileLock(join(this.root, "obligations.lock"), fn);
  }

  private readRecord(id: string): Obligation | undefined {
    const path = join(this.root, `${id}.json`);
    if (!existsSync(path)) return undefined;
    return normalizeStoredObligation(JSON.parse(readFileSync(path, "utf8")));
  }

  private readAll(): Obligation[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((name) => name.endsWith(".json"))
      .map((name) =>
        normalizeStoredObligation(
          JSON.parse(readFileSync(join(this.root, name), "utf8")),
        ),
      );
  }

  private write(record: Obligation): Obligation {
    mkdirSync(this.root, { recursive: true });
    const path = join(this.root, `${record.id}.json`);
    const priorRevision = existsSync(path)
      ? ((JSON.parse(readFileSync(path, "utf8")) as Obligation).revision ?? 0)
      : 0;
    const withRevision = { ...record, revision: priorRevision + 1 };
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(withRevision, null, 2)}\n`);
    renameSync(temporary, path);
    return withRevision;
  }

  /** How a party resolves right now, evaluated inside whichever transaction
   * needs it (ADR 0021): a session against live process identity, the human
   * always, a system against the wired settlement hooks, a role against its
   * injected resolver. */
  resolveParty(party: Party): PartyResolution {
    switch (party.kind) {
      case "session":
        return this.isLive(party.sessionId)
          ? { state: "resolves", sessionId: party.sessionId }
          : {
              state: "unresolvable",
              reason: `session ${party.sessionId} is not live`,
            };
      case "human":
        // ADR 0001: the operator is a single principal and always resolves.
        return { state: "resolves" };
      case "system":
        return WIRED_SYSTEMS.includes(party.system)
          ? { state: "resolves" }
          : {
              state: "unresolvable",
              reason: `system "${party.system}" has no wired settlement hook`,
            };
      case "role": {
        if (!this.resolveRoleImpl) {
          return {
            state: "unresolvable",
            reason: `no role resolver is wired, so ${describeRole(party.role)} cannot be resolved`,
          };
        }
        const sessionId = this.resolveRoleImpl(party.role);
        return sessionId
          ? { state: "resolves", sessionId }
          : {
              state: "unresolvable",
              reason: `${describeRole(party.role)} resolves to no single responsible session`,
            };
      }
    }
  }

  /** The one responsible session for a role, or undefined when the role is
   * unresolvable — the read-time resolution views render provenance from. */
  sessionResponsibleFor(role: Role): string | undefined {
    return this.resolveRoleImpl?.(role);
  }

  /** The obligor end rendered for views: the label for parties that name
   * themselves, and the role's resolution provenance for a role — an
   * unresolvable role renders its reason, never a guess. */
  describeObligor(obligation: Obligation): string {
    const party = obligation.obligor;
    if (party.kind === "session" || party.kind === "human") return party.label;
    if (party.kind === "system") return party.label;
    const resolution = this.resolveParty(party);
    return resolution.state === "resolves"
      ? `${party.label} → ${resolution.sessionId}`
      : `${party.label} (unresolvable: ${resolution.reason})`;
  }

  /** The obligee announces that the obligor owes it a specific outcome.
   * Announced, not negotiated: the obligor can contest later but is not
   * asked first — both ends must merely resolve (PartyResolves), the sides
   * must respect the accountability constraints, and no open record with
   * the same obligee party, kind, and subject may exist. */
  announce(
    input: {
      obligee: Party;
      obligor: Party;
      kind: ObligationKind;
      subject: string;
      description?: string;
      markers?: ObligationMarker[];
      options?: string[];
    },
    options: ObligationNow & { baseDir?: string } = {},
  ): Obligation {
    if (!KINDS.includes(input.kind)) {
      throw new Error(`unknown obligation kind: ${String(input.kind)}`);
    }
    const subject = validateText(input.subject, "subject");
    const description =
      input.description === undefined
        ? undefined
        : validateDescription(input.description);
    if (input.options !== undefined && input.options.length < 2) {
      throw new Error("options requires at least two choices");
    }
    const choices = input.options?.map((choice) =>
      validateText(choice, "option"),
    );
    const baseDir = options.baseDir ?? process.cwd();
    const markers = input.markers?.map((marker) =>
      canonicalMarker(marker, baseDir),
    );
    // PartySidesAreConstrained: the human owes but is never the recorded
    // creditor; a component_owner role owes the repair; plan and experiment
    // roles are the artifact creditors. Anything else makes the arc's
    // accountability meaningless, so it is refused at creation.
    if (input.obligee.kind === "human") {
      throw new ObligationStateError(
        "the operator is never the obligee of a wait",
      );
    }
    if (
      input.obligee.kind === "role" &&
      input.obligee.role.kind === "component_owner"
    ) {
      throw new ObligationStateError(
        "a component_owner role can only owe a repair, not wait for one",
      );
    }
    if (
      input.obligor.kind === "role" &&
      input.obligor.role.kind !== "component_owner"
    ) {
      throw new ObligationStateError(
        "only a component_owner role can be an obligor; plan and experiment roles are creditors",
      );
    }
    const obligee = normalizePartyInput(input.obligee, "obligee");
    const obligor = normalizePartyInput(input.obligor, "obligor");
    const obligeeResolution = this.resolveParty(obligee);
    if (obligeeResolution.state === "unresolvable") {
      throw new ObligationAuthorityError(
        `obligee does not resolve: ${obligeeResolution.reason}`,
      );
    }
    const obligorResolution = this.resolveParty(obligor);
    if (obligorResolution.state === "unresolvable") {
      throw new ObligationAuthorityError(
        `obligor does not resolve: ${obligorResolution.reason}`,
      );
    }
    const at = options.now ?? new Date().toISOString();
    return this.withLock(() => {
      const duplicate = this.readAll().find(
        (o) =>
          o.status === "open" &&
          partyKey(o.obligee) === partyKey(obligee) &&
          o.kind === input.kind &&
          o.subject === subject,
      );
      if (duplicate) throw new ObligationDuplicateError(duplicate);
      const record: Obligation = {
        version: 2,
        id: `ob-${randomUUID().slice(0, 8)}`,
        createdAt: at,
        obligee,
        obligor,
        kind: input.kind,
        subject,
        ...(description ? { description } : {}),
        status: "open",
        contested: false,
        revision: 0,
        ...(choices ? { options: choices } : {}),
        ...(markers?.length ? { markers } : {}),
      };
      const written = this.write(record);
      // CreationNoticePushed: exactly one push, and only for an obligor
      // that can receive one — a session party is its own address, a role
      // party pushes to the resolved session. Human and system obligors
      // are reached through the owed view and their own event feeds.
      if (obligorResolution.sessionId) {
        this.notify(written, {
          kind: "session",
          sessionId: obligorResolution.sessionId,
          label: obligor.label,
        });
      }
      return written;
    });
  }

  /** Close an open record as a proven obligee. Callers hold the lock and
   * have already proven identity. */
  private closeLocked(
    id: string,
    status: "satisfied" | "withdrawn",
    closedBy: ClosedBy,
    options: ObligationNow & { resolution?: string },
  ): Obligation {
    const at = options.now ?? new Date().toISOString();
    const record = this.readRecord(id);
    if (!record) throw new ObligationStateError(`no such obligation: ${id}`);
    if (record.status !== "open") {
      throw new ObligationStateError(
        `obligation ${id} is already ${record.status}`,
      );
    }
    return this.write({
      ...record,
      status,
      closedBy,
      closedAt: at,
      retainedUntil: new Date(
        Date.parse(at) + TERMINAL_RETENTION_MS,
      ).toISOString(),
      ...(status === "satisfied" && options.resolution !== undefined
        ? { resolution: options.resolution }
        : {}),
    });
  }

  close(
    id: string,
    actor: SessionParty,
    resolution?: string,
    options: ObligationNow = {},
  ): Obligation {
    return this.withLock(() => {
      const record = this.readRecord(id);
      if (!record) throw new ObligationStateError(`no such obligation: ${id}`);
      this.requireObligee(record, actor);
      return this.closeLocked(id, "satisfied", "obligee", {
        ...options,
        resolution,
      });
    });
  }

  withdraw(id: string, actor: SessionParty, options: ObligationNow = {}) {
    return this.withLock(() => {
      const record = this.readRecord(id);
      if (!record) throw new ObligationStateError(`no such obligation: ${id}`);
      this.requireObligee(record, actor);
      return this.closeLocked(id, "withdrawn", "obligee", options);
    });
  }

  private requireObligee(obligation: Obligation, actor: SessionParty): void {
    if (!this.isLive(actor.sessionId)) {
      throw new ObligationAuthorityError(
        `acting session is not live: ${actor.sessionId}`,
      );
    }
    // ObligeeIdentified: a session obligee proves itself by its own
    // identity. A role or system obligee never closes by belief — its
    // records settle by evidence only — so no actor can close them here.
    if (
      obligation.obligee.kind !== "session" ||
      actor.sessionId !== obligation.obligee.sessionId
    ) {
      throw new ObligationAuthorityError(
        `only the obligee session may close ${obligation.id}`,
      );
    }
  }

  /** Obligee-only in-place amendment of the presentation fields. Subject,
   * kind, and obligor are the identity of the ask and never edit; changing
   * them is a withdraw-and-re-announce. */
  update(
    id: string,
    actor: SessionParty,
    fields: {
      description?: string | null;
      options?: string[] | null;
      markers?: ObligationMarker[] | null;
    },
    options: ObligationNow & { baseDir?: string } = {},
  ): Obligation {
    const baseDir = options.baseDir ?? process.cwd();
    return this.withLock(() => {
      const record = this.readRecord(id);
      if (!record) throw new ObligationStateError(`no such obligation: ${id}`);
      this.requireObligee(record, actor);
      if (record.status !== "open") {
        throw new ObligationStateError(
          `obligation ${id} is already ${record.status}`,
        );
      }
      const next: Obligation = { ...record };
      if (fields.description !== undefined) {
        next.description =
          fields.description === null
            ? undefined
            : validateDescription(fields.description);
      }
      if (fields.options !== undefined) {
        if (fields.options === null) next.options = undefined;
        else if (fields.options.length < 2) {
          throw new Error("options requires at least two choices");
        } else {
          next.options = fields.options.map((choice) =>
            validateText(choice, "option"),
          );
        }
      }
      if (fields.markers !== undefined) {
        if (fields.markers === null) next.markers = undefined;
        else {
          next.markers = fields.markers.map((marker) =>
            canonicalMarker(marker, baseDir),
          );
        }
      }
      return this.write(next);
    });
  }

  /** Append-only commentary from either end or the operator. Comments are
   * notes, not lifecycle events: they never move the status. */
  comment(
    id: string,
    actor: SessionParty | "user",
    text: string,
    options: ObligationNow = {},
  ): Obligation {
    const at = options.now ?? new Date().toISOString();
    return this.withLock(() => {
      const record = this.readRecord(id);
      if (!record) throw new ObligationStateError(`no such obligation: ${id}`);
      if (record.status !== "open") {
        throw new ObligationStateError(
          `obligation ${id} is already ${record.status}`,
        );
      }
      // Only a named session, the session currently responsible for a role,
      // or the operator may add a comment to the record's evidence.
      if (actor !== "user") {
        const isParty =
          (record.obligee.kind === "session" &&
            record.obligee.sessionId === actor.sessionId) ||
          (record.obligor.kind === "session" &&
            record.obligor.sessionId === actor.sessionId) ||
          (record.obligee.kind === "role" &&
            this.sessionResponsibleFor(record.obligee.role) ===
              actor.sessionId) ||
          (record.obligor.kind === "role" &&
            this.sessionResponsibleFor(record.obligor.role) ===
              actor.sessionId);
        if (!isParty) {
          throw new ObligationAuthorityError(
            `only a party to the record may comment on ${id}`,
          );
        }
      }
      const author: { label: string; kind: PartyKind } =
        actor === "user"
          ? { label: "user", kind: "human" }
          : {
              label: actor.label,
              kind: "session",
            };
      const comments = [
        ...(record.comments ?? []),
        {
          author: author.label,
          authorKind: author.kind,
          at,
          text: validateText(text, "comment"),
        },
      ];
      return this.write({ ...record, comments });
    });
  }

  /** Shared settlement tail: satisfied by deterministic evidence, inside
   * the caller's lock. */
  private settleLocked(
    matches: (record: Obligation) => boolean,
    at: string,
  ): Obligation[] {
    const settled: Obligation[] = [];
    for (const record of this.readAll()) {
      if (record.status !== "open" || !matches(record)) continue;
      settled.push(
        this.write({
          ...record,
          status: "satisfied",
          closedBy: "system",
          closedAt: at,
          retainedUntil: new Date(
            Date.parse(at) + TERMINAL_RETENTION_MS,
          ).toISOString(),
        }),
      );
    }
    return settled;
  }

  /** A claim release settles open claim-release obligations on that claim —
   * deterministic evidence, invoked by the release transaction's caller
   * (ClaimReleaseSettles). */
  settleReleasedClaim(
    claimId: string,
    options: ObligationNow = {},
  ): Obligation[] {
    const at = options.now ?? new Date().toISOString();
    return this.withLock(() =>
      this.settleLocked(
        (record) =>
          record.kind === "claim_release" && record.subject === claimId,
        at,
      ),
    );
  }

  /** A system event settles the open records waiting on it (EventSettles):
   * a weft job completion, an issue reaching its fixed state, a review
   * finishing. Only obligors that cannot close by belief settle this way —
   * a system party matching the event's system, or a role party (whose
   * repair the event reports), whatever system observed it. Session and
   * human obligors settle by belief or authority, never by an event. */
  settleByEvent(
    system: string,
    subject: string,
    options: ObligationNow = {},
  ): Obligation[] {
    const wired = validateText(system, "system name");
    const event = validateText(subject, "subject");
    const at = options.now ?? new Date().toISOString();
    return this.withLock(() =>
      this.settleLocked(
        (record) =>
          record.subject === event &&
          (record.obligor.kind === "role" ||
            (record.obligor.kind === "system" &&
              record.obligor.system === wired)),
        at,
      ),
    );
  }

  contest(
    id: string,
    actor: { sessionId: string } | "user",
    reason: string,
    options: ObligationNow = {},
  ): Obligation {
    const at = options.now ?? new Date().toISOString();
    const contestReason = validateText(reason, "contest reason");
    return this.withLock(() => {
      const record = this.readRecord(id);
      if (!record) throw new ObligationStateError(`no such obligation: ${id}`);
      if (record.status !== "open") {
        throw new ObligationStateError(
          `obligation ${id} is already ${record.status}`,
        );
      }
      if (record.contested) {
        throw new ObligationStateError(`obligation ${id} is already contested`);
      }
      // ObligorMayContest: a system or role obligor cannot act, so
      // event-settled records have no contest path — only authority
      // clearing, or the obligee's own withdrawal.
      if (record.obligor.kind === "system" || record.obligor.kind === "role") {
        throw new ObligationAuthorityError(
          `obligation ${id} names ${record.obligor.label}, a ${record.obligor.kind} obligor that cannot contest; it settles by its own evidence or clears by authority`,
        );
      }
      if (actor === "user") {
        if (record.obligor.kind !== "human") {
          throw new ObligationAuthorityError(
            `obligation ${id} names a session obligor, not the operator`,
          );
        }
      } else {
        if (record.obligor.kind !== "session") {
          throw new ObligationAuthorityError(
            `obligation ${id} names the operator, not a session`,
          );
        }
        if (!this.isLive(actor.sessionId)) {
          throw new ObligationAuthorityError(
            `acting session is not live: ${actor.sessionId}`,
          );
        }
        if (actor.sessionId !== record.obligor.sessionId) {
          throw new ObligationAuthorityError(
            `only the named obligor session may contest ${id}`,
          );
        }
      }
      return this.write({
        ...record,
        contested: true,
        contestedAt: at,
        contestReason,
      });
    });
  }

  /** User authority clears an open obligation — recorded, never verified
   * (ADR 0004). */
  authorityClear(
    id: string,
    authority: string,
    reason: string,
    options: ObligationNow = {},
  ): Obligation {
    const trimmedAuthority = validateText(authority, "authority");
    const clearedReason = validateText(reason, "authority reason");
    const at = options.now ?? new Date().toISOString();
    return this.withLock(() => {
      const record = this.readRecord(id);
      if (!record) throw new ObligationStateError(`no such obligation: ${id}`);
      if (record.status !== "open") {
        throw new ObligationStateError(
          `obligation ${id} is already ${record.status}`,
        );
      }
      return this.write({
        ...record,
        status: "withdrawn",
        closedBy: "user_authority",
        closedAt: at,
        retainedUntil: new Date(
          Date.parse(at) + TERMINAL_RETENTION_MS,
        ).toISOString(),
        authority: trimmedAuthority,
        authorityReason: clearedReason,
      });
    });
  }

  /** A successor session adopts every open obligation of an offline
   * predecessor — in both roles: what the predecessor was owed, and what it
   * owed. The transfer is atomic (all candidates or none). */
  adopt(
    input: {
      adopter: SessionParty;
      predecessorSessionId: string;
      succession: Succession;
    },
    options: ObligationNow = {},
  ): Obligation[] {
    const at = options.now ?? new Date().toISOString();
    const adopter: SessionParty = {
      kind: "session",
      sessionId: validateText(input.adopter.sessionId, "adopter session id"),
      label: validateText(input.adopter.label, "adopter label"),
    };
    const predecessor = validateText(
      input.predecessorSessionId,
      "predecessor session id",
    );
    if (!this.isLive(adopter.sessionId)) {
      throw new ObligationAuthorityError(
        `adopting session is not live: ${adopter.sessionId}`,
      );
    }
    if (this.isLive(predecessor)) {
      throw new ObligationAuthorityError(
        `predecessor session is still live: ${predecessor}`,
      );
    }
    if (adopter.sessionId === predecessor) {
      throw new ObligationAuthorityError(
        "a session cannot adopt its own obligations",
      );
    }
    if (
      input.succession.kind === "resume-id" &&
      input.succession.resumeId !== predecessor
    ) {
      throw new ObligationAuthorityError(
        `resume id names ${input.succession.resumeId}, not ${predecessor}`,
      );
    }
    return this.withLock(() => {
      // SessionNamedCandidates: every open record that names the
      // predecessor as its session obligee or its session obligor. Records
      // whose ends are roles or systems never name a session, so they are
      // never candidates — roles re-resolve on their own, and no act of
      // adoption may re-point a responsibility or an integration.
      const candidates = this.readAll().filter(
        (o) =>
          o.status === "open" &&
          ((o.obligee.kind === "session" &&
            o.obligee.sessionId === predecessor) ||
            (o.obligor.kind === "session" &&
              o.obligor.sessionId === predecessor)),
      );
      // All or none: compute every successor first, then write.
      const adoptedAuthority =
        input.succession.kind === "authority"
          ? input.succession.authority
          : undefined;
      const moved = candidates.map((record) => {
        // Both ends may name the predecessor in a degenerate self-arc;
        // each end transfers independently into the same successor.
        const successor = {
          kind: "session" as const,
          sessionId: adopter.sessionId,
          label: adopter.label,
        };
        return {
          ...record,
          ...(record.obligee.kind === "session" &&
          record.obligee.sessionId === predecessor
            ? { obligee: successor }
            : {}),
          ...(record.obligor.kind === "session" &&
          record.obligor.sessionId === predecessor
            ? { obligor: successor }
            : {}),
          adoptedFrom: predecessor,
          adoptedAt: at,
          ...(adoptedAuthority ? { adoptedAuthority } : {}),
        };
      });
      for (const record of moved) this.write(record);
      return moved;
    });
  }

  list(): Obligation[] {
    return this.readAll().sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  listOpen(): Obligation[] {
    return this.list().filter((o) => o.status === "open");
  }

  /** Every open obligation naming the human as obligor, across all projects
   * — the operator's owed view. */
  owedToHuman(): Obligation[] {
    return this.listOpen().filter((o) => o.obligor.kind === "human");
  }

  get(id: string): Obligation | undefined {
    return this.readRecord(id);
  }

  /** The daemon re-observes the referenced issue of every open external_fix
   * obligation; observation never mutates the obligation. */
  observeRef(
    obligationId: string,
    state: RefState,
    options: ObligationNow & { issueId?: string } = {},
  ): RefObservation {
    const record = this.readRecord(obligationId);

    if (!record) {
      throw new ObligationStateError(`no such obligation: ${obligationId}`);
    }
    if (record.status !== "open" || record.kind !== "external_fix") {
      throw new ObligationStateError(
        `only open external_fix obligations take ref observations: ${obligationId}`,
      );
    }
    const observation: RefObservation = {
      version: 1,
      obligationId,
      state,
      ...(options.issueId ? { issueId: options.issueId } : {}),
      observedAt: options.now ?? new Date().toISOString(),
    };
    mkdirSync(join(this.root, "refs"), { recursive: true });
    const path = join(this.root, "refs", `${obligationId}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(observation, null, 2)}\n`);
    renameSync(temporary, path);
    return observation;
  }

  /** Remove expired terminal records without racing with a record update. */
  pruneTerminal(nowMs = Date.now()): number {
    if (!existsSync(this.root)) return 0;
    return this.withLock(() => {
      let removed = 0;
      for (const record of this.readAll()) {
        if (
          record.status === "open" ||
          !record.retainedUntil ||
          !(Date.parse(record.retainedUntil) <= nowMs)
        ) {
          continue;
        }
        unlinkSync(join(this.root, `${record.id}.json`));
        const ref = join(this.root, "refs", `${record.id}.json`);
        if (existsSync(ref)) unlinkSync(ref);
        removed += 1;
      }
      return removed;
    });
  }

  latestRef(obligationId: string): RefObservation | undefined {
    const path = join(this.root, "refs", `${obligationId}.json`);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as RefObservation;
  }

  /** Open external_fix obligations whose latest observation is unresolvable
   * — a diagnostic that must surface, never a silent skip. */
  unresolvableRefs(): {
    obligation: Obligation;
    observation: RefObservation;
  }[] {
    return this.listOpen()
      .filter((o) => o.kind === "external_fix")
      .map((o) => ({ obligation: o, observation: this.latestRef(o.id) }))
      .filter((entry) => entry.observation?.state === "unresolvable") as {
      obligation: Obligation;
      observation: RefObservation;
    }[];
  }
}

/** Process-wide store. The transaction observes liveness itself (ADR 0021):
 * the registry-backed predicate runs the pid/procStart-verified scan rather
 * than trusting any caller's claim. Tests construct their own store with an
 * injected predicate. Role resolution is wired late by
 * obligationResolution.ts — the resolution sources import this module, so
 * this module must never import them back. */
export const obligations = new ObligationStore({
  isLive: (sessionId) =>
    listLive().some((registration) => registration.sessionId === sessionId),
});

/** Wires the default role resolution into the process-wide store. Called
 * once from obligationResolution.ts, which owns the imports that would
 * close a cycle if this module made them. */
export function wireObligationRoleResolver(
  resolver: ObligationRoleResolver,
): void {
  obligations.attachRoleResolver(resolver);
}
