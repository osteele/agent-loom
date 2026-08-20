#!/bin/sh
# Run the suite under a throwaway HOME.
#
# paths.ts resolves STATE_DIR from homedir() once at module load, so any suite
# that writes a spool writes it under the real ~/.claude/agent-mail unless HOME
# is already redirected. Isolating the project directory is not enough: the
# project path decides the spool's slug, not which state root it lands in.
#
# It has to happen before bun starts. Bun captures HOME at process start and
# ignores later mutation of process.env.HOME (Node honours it), so a preload
# that sets it runs too late to matter.
set -eu
HOME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-mail-test-home-XXXXXX")
trap 'rm -rf "$HOME_DIR"' EXIT INT TERM
HOME="$HOME_DIR" bun test "$@"
