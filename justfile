# agent-loom — local install and checks.
#
# The installed CLI is this checkout, installed as a package into the
# bun-global environment (bun add --force from this directory; bins land in
# ~/.bun/bin) with ~/.local/bin/agent-loom symlinked onto PATH. The dist
# runs under Bun, not the Node runtime the published package's shebang
# selects — see docs/decisions/log.md for the runtime decision. `just
# install` is the reproducible path: build, install, restart the daemon so
# code changes go live. Run it after pulling or before expecting new
# subcommands to exist in the installed CLI.

default:
    @just --list

# Build dist/ from source.
build:
    bun run build

# Build, install this checkout into the bun-global environment, restart.
install:
    bun run build
    cd ~/.bun/install/global && bun add --force {{justfile_directory()}}
    rm -f ~/.bun/bin/agent-loom ~/.bun/bin/agent-mail
    printf '#!/bin/sh\nexec %s %s "$@"\n' "$(\command -v bun)" "$HOME/.bun/install/global/node_modules/agent-loom/dist/cli.js" > ~/.bun/bin/agent-loom
    chmod +x ~/.bun/bin/agent-loom
    ln -sfn ~/.bun/bin/agent-loom ~/.local/bin/agent-loom
    # The pre-rename command name, kept for configs and scripts not yet updated.
    ln -sfn ~/.bun/bin/agent-loom ~/.bun/bin/agent-mail
    ln -sfn ~/.bun/bin/agent-loom ~/.local/bin/agent-mail
    agent-loom restart
    @echo "installed; daemon restarted"

# Format, typecheck, and run the suite under a throwaway HOME.
check:
    bun run check
    bun run test
