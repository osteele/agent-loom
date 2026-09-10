import { canonicalProject } from "./paths.ts";
import type { Registration } from "./registry.ts";
import type { Message } from "./spool.ts";

/** A reply uses a stamped identity, never the sender's free-form label. */
export function replyRecipient(
  parent: Message | undefined,
  registrations: Pick<Registration, "sessionId" | "cwd">[],
):
  | { ok: true; project: string; sessionId: string }
  | { ok: false; error: string } {
  if (!parent) {
    return {
      ok: false,
      error: "reply parent was not found in the selected inbox",
    };
  }
  const sessionId = parent.meta?.sessionId ?? parent.origin?.sessionId;
  if (!sessionId) {
    return {
      ok: false,
      error:
        "reply parent has no stamped sender session; its from label is not an address",
    };
  }
  const projects = new Set(
    registrations
      .filter((registration) => registration.sessionId === sessionId)
      .map((registration) => canonicalProject(registration.cwd)),
  );
  if (projects.size !== 1) {
    return {
      ok: false,
      error:
        projects.size === 0
          ? `reply sender ${sessionId} has no live mailbox`
          : `reply sender ${sessionId} has multiple live mailboxes`,
    };
  }
  return { ok: true, project: [...projects][0], sessionId };
}
