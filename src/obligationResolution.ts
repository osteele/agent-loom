/** Default party-model role resolution for the obligation store.
 *
 * This module exists for one import-cycle reason: it imports the resolution
 * sources — work.ts (plan executors), claims.ts (experiment claimers), and
 * workspaceOwner.ts (project ownership) — and all of them import (directly
 * or transitively) obligations.ts. Wiring these resolvers from inside
 * obligations.ts would close the cycle at module evaluation, so obligations.ts
 * stays import-free of them and this module calls wireObligationRoleResolver
 * after both sides have fully loaded. Every entry point that can announce or
 * render an obligation (cli.ts, channel.ts, daemon.ts) imports this module so
 * the process-wide store always resolves roles; stores built by tests inject
 * their own resolver through ObligationStoreOptions instead. */

import { existsSync } from "node:fs";
import { claims } from "./claims.ts";
import {
  type ObligationRoleResolver,
  type Party,
  type PartyKind,
  type Role,
  systemWired,
  wireObligationRoleResolver,
} from "./obligations.ts";
import { canonicalProject } from "./paths.ts";
import { listLive, registeredProjectFor } from "./registry.ts";
import { knownProjects } from "./spool.ts";
import { work } from "./work.ts";
import { resolveWorkspaceOwner } from "./workspaceOwner.ts";

/** Resolves a component name to its project directory: an existing path as
 * given, otherwise the name matched by basename against live listeners and
 * known projects — the same resolution `--project` gets. No match or an
 * ambiguous match yields undefined: the role then renders unresolvable and
 * is never guessed onto the wrong project. */
export function componentProject(component: string): string | undefined {
  const direct = canonicalProject(component);
  if (existsSync(direct)) return direct;
  const name = component.split("/").filter(Boolean).pop() ?? component;
  const candidates = new Set<string>();
  for (const registration of listLive()) {
    const cwd = canonicalProject(registration.cwd);
    if (cwd.split("/").pop() === name) candidates.add(cwd);
  }
  for (const project of knownProjects()) {
    if (project.split("/").pop() === name) candidates.add(project);
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

/** The one distinct session id currently responsible for a role, or
 * undefined when the role is held by nobody or contested between claimants. */
function soleSessionId(
  sessionIds: Iterable<string | undefined>,
): string | undefined {
  const distinct = new Set<string>();
  for (const sessionId of sessionIds) {
    if (sessionId) distinct.add(sessionId);
  }
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

function resolvePlanExecutor(plan: string): string | undefined {
  // Role.plan is "<project>/<stem>": the stem is the plan's stable filename
  // key (ADR 0019), the project everything before the final separator.
  const separator = plan.lastIndexOf("/");
  if (separator <= 0) return undefined;
  const project = plan.slice(0, separator);
  const stem = plan.slice(separator + 1);
  if (!stem) return undefined;
  return soleSessionId(
    work
      .list(canonicalProject(project))
      .filter(
        (lease) =>
          lease.resource.type === "research-plan" &&
          lease.resource.key === stem,
      )
      .map((lease) => lease.owner.sessionId),
  );
}

function resolveExperimentClaimer(experiment: string): string | undefined {
  return soleSessionId(
    claims
      .peekAll()
      .filter(
        (claim) =>
          claim.type === "experiment" && claim.experimentId === experiment,
      )
      .map((claim) => claim.owner.sessionId),
  );
}

export const resolveObligationRole: ObligationRoleResolver = (
  role: Role,
): string | undefined => {
  switch (role.kind) {
    case "component_owner": {
      const project = componentProject(role.component);
      if (!project) return undefined;
      const owner = resolveWorkspaceOwner(project);
      return owner.status === "resolved" ? owner.sessionId : undefined;
    }
    case "plan_executor":
      return resolvePlanExecutor(role.plan);
    case "experiment_claimer":
      return resolveExperimentClaimer(role.experiment);
  }
};

wireObligationRoleResolver(resolveObligationRole);

export interface PartyView {
  label: string;
  partyKind: PartyKind;
  roleKind?: Role["kind"];
  /** Whether the party can currently be held to account. A session or role
   * resolves by its process identity, the human always, a system by its
   * wired integration. */
  resolution: "resolves" | "unresolvable";
  reason?: string;
  sessionId?: string;
  live?: boolean;
  /** The party's project, when it has one — a session's registered project,
   * a role's artifact project (component directory, plan root, experiment
   * claim project). Human and system parties have none. */
  project?: string;
  projectBasis: "registered" | "plan" | "ownership" | "claim" | "none";
}

export interface PartyViewDeps {
  isLive(sessionId: string): boolean;
  roleSessionId(role: Role): string | undefined;
}

/** Flat, consumer-ready projection of one obligation end for state and
 * dashboard consumers: grouping by project is the consumer's job; this
 * supplies the authoritative resolution and its provenance. */
export function partyView(party: Party, deps: PartyViewDeps): PartyView {
  switch (party.kind) {
    case "session": {
      const live = deps.isLive(party.sessionId);
      return {
        label: party.label,
        partyKind: "session",
        resolution: live ? "resolves" : "unresolvable",
        ...(live ? {} : { reason: "session offline" }),
        sessionId: party.sessionId,
        live,
        project: registeredProjectFor(party.sessionId),
        projectBasis: "registered",
      };
    }
    case "human":
      return {
        label: party.label,
        partyKind: "human",
        resolution: "resolves",
        projectBasis: "none",
      };
    case "system": {
      const wired = systemWired(party.system);
      return {
        label: party.label,
        partyKind: "system",
        resolution: wired ? "resolves" : "unresolvable",
        ...(wired ? {} : { reason: "integration not wired" }),
        projectBasis: "none",
      };
    }
    case "role": {
      const sessionId = deps.roleSessionId(party.role);
      const project =
        party.role.kind === "component_owner"
          ? componentProject(party.role.component)
          : party.role.kind === "plan_executor"
            ? projectOfPlan(party.role.plan)
            : experimentProject(party.role.experiment);
      return {
        label: party.label,
        partyKind: "role",
        roleKind: party.role.kind,
        resolution: sessionId ? "resolves" : "unresolvable",
        ...(sessionId ? {} : { reason: roleUnresolvedReason(party.role.kind) }),
        ...(sessionId ? { sessionId, live: deps.isLive(sessionId) } : {}),
        ...(project ? { project } : {}),
        projectBasis:
          party.role.kind === "component_owner"
            ? "ownership"
            : party.role.kind === "plan_executor"
              ? "plan"
              : "claim",
      };
    }
  }
}

function projectOfPlan(plan: string): string | undefined {
  const separator = plan.lastIndexOf("/");
  if (separator <= 0) return undefined;
  return plan.slice(0, separator) || undefined;
}

function experimentProject(experiment: string): string | undefined {
  return claims
    .peekAll()
    .find(
      (claim) =>
        claim.type === "experiment" && claim.experimentId === experiment,
    )?.project;
}

function roleUnresolvedReason(kind: Role["kind"]): string {
  switch (kind) {
    case "component_owner":
      return "no resolvable component owner";
    case "plan_executor":
      return "plan lease not held";
    case "experiment_claimer":
      return "experiment claim not found";
  }
}
