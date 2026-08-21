# Development

Development runs from a checkout under [Bun](https://bun.com/docs/installation),
which executes the TypeScript sources directly:

```bash
git clone https://github.com/osteele/agent-mail
cd agent-mail
bun install
bun src/cli.ts install --replace-claude --replace-codex
```

Run checkout commands as `bun src/cli.ts <command>`. The installer records the
runtime that invoked it, so the command above registers the TypeScript entry
points with Bun and runs the development daemon under Bun. The replacement
flags matter when a package-style Node registration already exists.

`bun link` is still useful for exercising the package command from a checkout,
but it does not select Bun as the runtime: the package's `agent-mail` bin points
at built `dist/cli.js`, whose shebang selects Node. Use the explicit source
command when the Bun development path is what you intend to test.

```bash
bun run check    # biome + tsc --noEmit
bun run test     # isolated HOME; do not invoke the Bun test runner directly
bun run build    # emit dist/, as the published package ships
```

The code runs under both Bun and Node. Everything that differs between them
(subprocesses, the HTTP server, synchronous sleeps, reading a slice of a file)
goes through `src/runtime.ts`, which dispatches on the host; no other module
tests which runtime it is on. Under Bun each function delegates to the Bun API
it replaced, so the runtime used in development stays the fast path.

The published package ships JavaScript rather than the TypeScript sources
because Node refuses to strip types for files under `node_modules`, so a
package shipping `.ts` installs but cannot run. `bun run
build` is what `npm` runs through `prepare` on a GitHub install.

The test suite uses `bun:test` and is not part of the published package.

Further reading: [docs/architecture.md](docs/architecture.md) covers how
agent-mail works underneath, [docs/http-api.md](docs/http-api.md) lists the
daemon's HTTP endpoints, and [docs/automation.md](docs/automation.md) specifies
the machine-readable state outputs.
