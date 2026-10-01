import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnnouncedState,
  announcedPath,
  readAnnouncedState,
  writeAnnouncedState,
} from "./announced.ts";
import { canonicalProject } from "./paths.ts";

function makeDirs(): { project: string; dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "agent-loom-announced-"));
  return {
    project: canonicalProject(root),
    dir: join(root, "announced"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const state: AnnouncedState = {
  version: 1,
  sessionId: "s1",
  project: "/placeholder",
  lastNewestId: "m-7",
  lastUnread: 3,
  announcedAt: 1_000_000,
  remindCount: 2,
  lastDiagAt: 900_000,
};

test("announced state round-trips", () => {
  const { project, dir, cleanup } = makeDirs();
  try {
    writeAnnouncedState({ ...state, project }, dir);
    expect(readAnnouncedState(project, "s1", dir)).toEqual({
      ...state,
      project,
    });
  } finally {
    cleanup();
  }
});

test("missing, corrupt, or wrong-version state reads as undefined", () => {
  const { project, dir, cleanup } = makeDirs();
  try {
    expect(readAnnouncedState(project, "s1", dir)).toBe(undefined);
    writeAnnouncedState({ ...state, project }, dir);
    const path = announcedPath(project, "s1", dir);
    writeFileSync(path, "{ not json");
    expect(readAnnouncedState(project, "s1", dir)).toBe(undefined);
    writeFileSync(path, JSON.stringify({ version: 99, sessionId: "s1" }));
    expect(readAnnouncedState(project, "s1", dir)).toBe(undefined);
  } finally {
    cleanup();
  }
});
