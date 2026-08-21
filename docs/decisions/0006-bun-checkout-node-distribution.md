---
status: accepted
date: 2026-08-21
---

# 0006. Use Bun for checkout sources and Node for distributions

## Context and Problem Statement

Development benefits from Bun executing the TypeScript sources directly. A
package installed from GitHub or npm must work on machines that have Node but
not Bun, and Node refuses to strip types from TypeScript under `node_modules`.
The installer also persists commands for the daemon, MCP servers, and audit
hook, so the runtime and entry-point format chosen at installation must agree.

## Decision Outcome

Run checkout development explicitly as `bun src/cli.ts <command>`. Build the
distributed package to JavaScript, point its `agent-mail` bin at `dist/cli.js`,
and run that bin under Node.

Installer commands derive the runtime from `process.execPath` and sibling entry
points from the extension of the running CLI. A Bun source install therefore
records Bun with `.ts` entries; a package install records Node with `.js`
entries. Installed-package CI exercises the public bin under supported Node
versions and inspects the install plan.

### Consequences

- Package consumers need a supported Node version but do not need Bun.
- `bun link` exercises the package-style Node bin; developers must use the
  explicit source command when they intend to run under Bun.
- Source-under-Bun and distribution-under-Node are separate execution paths,
  and both require tests.
- Switching an existing MCP registration between runtimes requires the
  installer's explicit replacement flags; it never silently takes over a
  different registration.

## Considered Options

### Ship TypeScript and require Bun

Rejected: it imposes an additional runtime on package consumers and produces a
package that Node can install but cannot execute from `node_modules`.

### Run development and distributions under Node

Rejected: it gives up Bun's direct TypeScript development path without making
the distribution more portable than the chosen split.

### Hardcode one runtime in installer output

Rejected: hardcoding Bun breaks Node-only installations, while hardcoding Node
discards the checkout's intended Bun runtime and can pair Node with `.ts`
entries.
