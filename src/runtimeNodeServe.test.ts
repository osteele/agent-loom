import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

// The suite runs under Bun, where serve() delegates to Bun.serve. Node is what
// the published CLI runs on, so drive the Node adapter in a real Node process.
test("Node serve() streams a body that stays open", async () => {
  const runtime = JSON.stringify(join(import.meta.dir, "runtime.ts"));
  const script = `
    const { serve } = await import(${runtime});
    const server = await serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first\\n"));
            },
          }),
        ),
    });
    const response = await fetch("http://127.0.0.1:" + server.port + "/");
    const { value } = await response.body.getReader().read();
    process.stdout.write(new TextDecoder().decode(value));
    process.exit(0);
  `;
  const child = spawn("node", ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const timer = setTimeout(() => child.kill(), 5_000);
  const code = await new Promise((resolve) => child.on("exit", resolve));
  clearTimeout(timer);
  expect(stdout).toBe("first\n");
  expect(code).toBe(0);
}, 10_000);
