import { canonicalProject } from "./paths.ts";
import { coalesceRegistrations, listLive } from "./registry.ts";
import { claudeSessions, matchSessions, sessionNames } from "./sessions.ts";

export class RecipientError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(`${message}. Nothing was sent.`);
    this.name = "RecipientError";
  }
}

/** Exact opaque IDs and unique human names select a live mailbox globally.
 * Project disambiguates name collisions, never duplicate IDs. Multiple transport
 * components in one mailbox are one recipient. HTTP accepts only exact IDs. */
export function resolveRecipient(
  project: string,
  query: string,
  exactOnly = false,
): { project: string; sessionId: string } {
  if (!query.trim())
    throw new RecipientError("session requires a nonempty name or ID", 400);
  const live = coalesceRegistrations(listLive());
  let matches = live.filter((registration) => registration.sessionId === query);
  if (matches.length === 0 && !exactOnly) {
    const metadata = claudeSessions();
    const candidates = live
      .filter((registration) => registration.sessionId)
      .map((registration) => ({
        ...registration,
        sessionId: registration.sessionId as string,
        ...sessionNames(
          registration.sessionId as string,
          metadata.get(registration.sessionId as string),
          canonicalProject(registration.cwd),
        ),
      }));
    matches = matchSessions(candidates, query);
    if (matches.length > 1) {
      const local = matches.filter(
        (registration) => canonicalProject(registration.cwd) === project,
      );
      if (local.length === 1) matches = local;
    }
  }
  if (matches.length === 0)
    throw new RecipientError(
      `no live recipient "${query}" (use an exact session ID, full name, or display name)`,
      404,
    );
  if (matches.length === 1) {
    // A name cannot make a session with multiple live mailboxes unambiguous.
    matches = live.filter(
      (registration) => registration.sessionId === matches[0].sessionId,
    );
  }
  if (matches.length !== 1)
    throw new RecipientError(
      `"${query}" is ambiguous; live mailbox candidates:\n${matches.map((registration) => `  ${registration.sessionId} in ${canonicalProject(registration.cwd)}`).join("\n")}`,
      409,
    );
  const recipient = matches[0];
  if (recipient.inboundPolicy === "refuse")
    throw new RecipientError(`recipient "${query}" refuses incoming mail`, 403);
  return {
    project: canonicalProject(recipient.cwd),
    sessionId: recipient.sessionId as string,
  };
}
