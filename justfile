# agent-mail — local install and checks.
#
# The installed CLI is this checkout, installed as a package into the
# bun-global environment (bun add --force from this directory; bins land in
# ~/.bun/bin) with ~/.local/bin/agent-mail symlinked onto PATH. The dist
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
    rm -f ~/.bun/bin/agent-mail
    printf '#!/bin/sh\nexec %s %s "$@"\n' "$(\command -v bun)" "$HOME/.bun/install/global/node_modules/agent-mail/dist/cli.js" > ~/.bun/bin/agent-mail
    chmod +x ~/.bun/bin/agent-mail
    ln -sfn ~/.bun/bin/agent-mail ~/.local/bin/agent-mail
    agent-mail restart
    @echo "installed; daemon restarted"

# Format, typecheck, and run the suite under a throwaway HOME.
check:
    bun run check
    bun run test
