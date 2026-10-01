import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processInfo } from "./registry.ts";

test("CLI and HTTP route global IDs and names, disambiguate by project, and reject unavailable recipients", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "agent-loom-recipients-")),
  );
  const home = join(root, "home");
  const source = join(root, "scratch");
  const target = join(root, "mailbox");
  const registry = join(home, ".claude", "agent-loom", "registry");
  const metadata = join(home, ".claude", "sessions");
  for (const path of [source, target, registry, metadata])
    mkdirSync(path, { recursive: true });
  const self = processInfo([process.pid]).get(process.pid);
  if (!self) throw new Error("test process identity unavailable");
  const registration = (
    file: string,
    project: string,
    sessionId: string,
    inboundPolicy = "accept",
  ) => {
    writeFileSync(
      join(registry, `${file}.json`),
      JSON.stringify({
        cwd: project,
        sessionId,
        pid: process.pid,
        procStart: self.start,
        started: new Date().toISOString(),
        inboundPolicy,
      }),
    );
    writeFileSync(
      join(metadata, `${file}.json`),
      JSON.stringify({
        sessionId,
        name: "Shared Name",
        nameSource: "user",
      }),
    );
  };
  registration("target", target, "opaque-submitter");
  registration("source", source, "source-session");
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    AGENT_LOOM_PORT: String(port),
  };
  const state = join(home, ".claude", "agent-loom");
  const watcher = watch(state);
  const ready = new Promise<void>((resolve, reject) => {
    watcher.on("change", () => {
      if (existsSync(join(state, "daemon.pid"))) resolve();
    });
    watcher.on("error", reject);
  });
  const daemon = Bun.spawn(
    [process.execPath, join(import.meta.dir, "daemon.ts")],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const stderr = new Response(daemon.stderr).text();
  const url = `http://127.0.0.1:${port}`;
  const post = (body: object) =>
    fetch(`${url}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const messages = async (project: string) => {
    const response = await fetch(
      `${url}/inbox?project=${encodeURIComponent(project)}&limit=0`,
    );
    return JSON.stringify(await response.json());
  };
  const notify = async (project: string, session: string, message: string) => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "cli.ts"),
        "notify",
        "--project",
        project,
        "--session",
        session,
        "--message",
        message,
        "--no-slack",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const diagnostic = await new Response(child.stderr).text();
    return { code: await child.exited, diagnostic };
  };
  try {
    await Promise.race([
      ready,
      daemon.exited.then(async () => {
        throw new Error((await stderr) || "daemon exited before readiness");
      }),
    ]);
    watcher.close();
    expect((await fetch(`${url}/health`)).ok).toBe(true);
    const cli = await notify(
      source,
      "opaque-submitter",
      "CLI cross-project delivery",
    );
    expect(cli.code, cli.diagnostic).toBe(0);
    expect(await messages(target)).toContain("CLI cross-project delivery");
    expect(await messages(source)).not.toContain("CLI cross-project delivery");
    expect(await messages(target)).toContain(
      `"sourceProject":${JSON.stringify(source)}`,
    );

    const http = await post({
      project: source,
      message: "HTTP cross-project delivery",
      meta: { toSession: "opaque-submitter", fromCwd: source },
      slackEcho: false,
    });
    expect(http.status).toBe(200);
    expect(await messages(target)).toContain("HTTP cross-project delivery");
    expect(await messages(source)).not.toContain("HTTP cross-project delivery");
    rmSync(join(registry, "source.json"));
    const globalName = await notify(
      source,
      "Shared Name",
      "global unique name",
    );
    expect(globalName.code, globalName.diagnostic).toBe(0);
    expect(await messages(target)).toContain("global unique name");
    expect(await messages(source)).not.toContain("global unique name");
    registration("source", source, "source-session");

    const localName = await notify(source, "Shared Name", "local shared name");
    expect(localName.code, localName.diagnostic).toBe(0);
    expect(await messages(source)).toContain("local shared name");
    expect(await messages(target)).not.toContain("local shared name");
    const remoteName = await notify(
      target,
      "shared name",
      "remote shared name",
    );
    expect(remoteName.code, remoteName.diagnostic).toBe(0);
    expect(await messages(target)).toContain("remote shared name");
    expect(await messages(source)).not.toContain("remote shared name");

    registration("same-name", source, "another-source-session");
    expect(
      (await notify(source, "Shared Name", "ambiguous name forbidden")).code,
    ).toBe(1);
    rmSync(join(registry, "same-name.json"));
    for (const session of ["", "opaque-submit", "absent-session"]) {
      expect((await notify(source, session, "unresolved forbidden")).code).toBe(
        1,
      );
      expect(
        (
          await post({
            project: source,
            message: "HTTP unresolved forbidden",
            meta: { toSession: session },
          })
        ).status,
      ).toBe(session ? 404 : 400);
    }
    registration("duplicate", source, "opaque-submitter");
    expect(
      (await notify(source, "opaque-submitter", "ambiguous ID forbidden")).code,
    ).toBe(1);
    expect(
      (
        await post({
          project: source,
          message: "HTTP ambiguous forbidden",
          meta: { toSession: "opaque-submitter" },
        })
      ).status,
    ).toBe(409);
    rmSync(join(registry, "duplicate.json"));

    registration("target", target, "opaque-submitter", "hold");
    expect(
      (await notify(source, "opaque-submitter", "held delivery")).code,
    ).toBe(0);
    expect(await messages(target)).toContain("held delivery");
    registration("target", target, "opaque-submitter", "refuse");
    expect(
      (await notify(source, "opaque-submitter", "refused forbidden")).code,
    ).toBe(1);
    expect(
      (
        await post({
          project: source,
          message: "HTTP refused forbidden",
          meta: { toSession: "opaque-submitter" },
        })
      ).status,
    ).toBe(403);
    expect(await messages(source)).not.toContain("forbidden");
    expect(await messages(target)).not.toContain("forbidden");

    expect(
      (
        await post({
          project: source,
          message: "intentional broadcast",
          slackEcho: false,
        })
      ).status,
    ).toBe(200);
    expect(await messages(source)).toContain("intentional broadcast");
    expect(await messages(target)).not.toContain("intentional broadcast");
  } finally {
    watcher.close();
    daemon.kill();
    await daemon.exited;
    await stderr;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
