import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveInstalledTool } from "./installedTools.ts";

// Under launchd the daemon's PATH lacks ~/go/bin, where `go install` puts
// both weft and issues. The test HOME is a throwaway directory, so a tool
// placed in its go/bin is reachable only through the fallback.
test("a tool off PATH is found in ~/go/bin", () => {
  const bin = join(homedir(), "go", "bin");
  const tool = join(bin, "agent-mail-fixture-tool");
  mkdirSync(bin, { recursive: true });
  writeFileSync(tool, "#!/bin/sh\n");
  chmodSync(tool, 0o755);
  try {
    expect(resolveInstalledTool("agent-mail-fixture-tool", undefined)).toBe(
      tool,
    );
  } finally {
    rmSync(tool);
  }
});

test("an override is used exactly, and a missing one is not searched past", () => {
  const bin = join(homedir(), "go", "bin");
  const tool = join(bin, "agent-mail-fixture-tool-2");
  mkdirSync(bin, { recursive: true });
  writeFileSync(tool, "#!/bin/sh\n");
  chmodSync(tool, 0o755);
  try {
    expect(resolveInstalledTool("agent-mail-fixture-tool-2", tool)).toBe(tool);
    expect(
      resolveInstalledTool(
        "agent-mail-fixture-tool-2",
        join(homedir(), "nowhere", "tool"),
      ),
    ).toBeUndefined();
  } finally {
    rmSync(tool);
  }
});
