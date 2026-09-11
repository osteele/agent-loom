import {
  isDisplaceable,
  ownerRegistration,
  ownerStatus,
} from "./coordination.ts";
import { canonicalProject, displayName } from "./paths.ts";
import { coalesceRegistrations, listLive } from "./registry.ts";
import type { Registration } from "./registry.ts";
import { claudeSessions, sessionNames } from "./sessions.ts";
import { work } from "./work.ts";
import type { WorkLease, WorkOwner, WorkResource, WorkStore } from "./work.ts";

// An owner is a contact for one project, not permission to edit files or run work.
const RESOURCE = { type: "project-owner", key: "owner" };

export type WorkspaceOwner = {
  project: string;
  address: string;
} & (
  | {
      status: "resolved";
      source: "assigned" | "inferred";
      sessionId: string;
      leaseId?: string;
    }
  | { status: "unavailable" | "ambiguous"; reason: string }
);

function ownerLeases(project: string, store: WorkStore): WorkLease[] {
  return store
    .list(project)
    .filter(
      (lease) =>
        lease.resource.type === RESOURCE.type &&
        lease.resource.key === RESOURCE.key,
    );
}

export function resolveWorkspaceOwner(
  project: string,
  registrations: Registration[] = listLive(),
  store: WorkStore = work,
): WorkspaceOwner {
  const canonical = canonicalProject(project);
  const base = {
    project: canonical,
    address: `${displayName(canonical)} Owner`,
  };
  const local = registrations.filter(
    (registration) => canonicalProject(registration.cwd) === canonical,
  );
  const assigned = ownerLeases(canonical, store).filter(
    (lease) =>
      !isDisplaceable(
        ownerStatus(
          lease.owner,
          registrations,
          lease.createdAt,
          undefined,
          true,
          lease.updatedAt,
        ),
      ),
  );
  if (assigned.length > 1)
    return {
      ...base,
      status: "ambiguous",
      reason: "multiple owner assignments; resolve the conflicting leases",
    };
  if (assigned.length === 1) {
    const lease = assigned[0];
    const registration = ownerRegistration(lease.owner, local);
    if (!registration?.sessionId)
      return {
        ...base,
        status: "unavailable",
        reason: "the assigned owner has no verified live mailbox",
      };
    return {
      ...base,
      status: "resolved",
      source: "assigned",
      sessionId: registration.sessionId,
      leaseId: lease.id,
    };
  }
  const sessions = coalesceRegistrations(local).filter(
    (registration) => registration.sessionId,
  );
  const soleSessionId = sessions[0]?.sessionId;
  if (sessions.length === 1 && soleSessionId)
    return {
      ...base,
      status: "resolved",
      source: "inferred",
      sessionId: soleSessionId,
    };
  return {
    ...base,
    status: sessions.length ? "ambiguous" : "unavailable",
    reason: sessions.length
      ? "multiple live sessions and no assigned owner"
      : "no live sessions in this project",
  };
}

export function describeWorkspaceOwner(owner: WorkspaceOwner): string {
  if (owner.status !== "resolved")
    return `${owner.address}: ${owner.status} (${owner.reason})`;
  const name = sessionNames(
    owner.sessionId,
    claudeSessions().get(owner.sessionId),
    owner.project,
  ).fullName;
  return `${owner.address}: ${name} (${owner.source})${owner.leaseId ? ` [${owner.leaseId}]` : ""}`;
}
export function workspaceOwnerIdentity(
  project: string,
  sessionId: string,
  registrations = listLive(),
  store: WorkStore = work,
): WorkOwner {
  const local = registrations.filter(
    (registration) =>
      canonicalProject(registration.cwd) === canonicalProject(project),
  );
  // A CLI and its MCP sibling may act for the same session. Use the existing
  // lease's live process credential so either can release its own assignment.
  for (const lease of ownerLeases(project, store)) {
    if (
      lease.owner.sessionId === sessionId &&
      ownerRegistration(lease.owner, local)
    )
      return lease.owner;
  }
  const candidates = local.filter(
    (registration) => registration.sessionId === sessionId,
  );
  const registration =
    candidates.find((candidate) => candidate.capabilities?.tools) ??
    candidates[0];
  if (!registration?.procStart)
    throw new Error(
      "owner assignment requires a registered session with a verified process identity",
    );
  return {
    id: sessionId,
    label: sessionNames(sessionId, claudeSessions().get(sessionId), project)
      .fullName,
    sessionId,
    pid: registration.pid,
    // Process identity survives an in-process push reconnect; connection ids do not.
    procStart: registration.procStart,
  };
}

export function claimWorkspaceOwner(
  project: string,
  sessionId: string,
  registrations = listLive(),
  store: WorkStore = work,
): WorkLease {
  const identity = workspaceOwnerIdentity(
    project,
    sessionId,
    registrations,
    store,
  );
  return store.acquire(project, RESOURCE, identity, {
    ownerIsLive: (owner, lease) =>
      !isDisplaceable(
        ownerStatus(
          owner,
          registrations,
          lease.createdAt,
          undefined,
          true,
          lease.updatedAt,
        ),
      ),
  });
}

export function releaseWorkspaceOwner(
  project: string,
  sessionId: string,
  registrations = listLive(),
  store: WorkStore = work,
): WorkLease {
  const identity = workspaceOwnerIdentity(
    project,
    sessionId,
    registrations,
    store,
  );
  const lease = ownerLeases(project, store).find(
    (candidate) => candidate.owner.sessionId === sessionId,
  );
  if (!lease) throw new Error("this session has no explicit owner assignment");
  return store.release(project, lease.id, identity);
}

export function isWorkspaceOwnerResource(resource: WorkResource): boolean {
  return (
    resource.type.trim() === RESOURCE.type &&
    resource.key.trim() === RESOURCE.key
  );
}

export function assertGenericWorkResource(resource: WorkResource): void {
  if (isWorkspaceOwnerResource(resource))
    throw new Error(
      "project-owner:owner is reserved; use the owner commands or verified owner transfers",
    );
}
