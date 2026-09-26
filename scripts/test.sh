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
# Point test children away from any daemon the developer has running. Without
# this, a child that does not set AGENT_MAIL_PORT itself reads the default port
# and POSTs its /notify to the live daemon — which spools the message under the
# REAL ~/.claude/agent-mail and answers success, so the test's own receipts
# never appear and the test stalls to its timeout. Port 0 sends every sender
# straight to its direct-append fallback.
AGENT_MAIL_PORT=0
export AGENT_MAIL_PORT
# Integration tests spawn real bun processes per client; the 5s default killed
# children mid-run (exit 143) whenever a spawn was slow. Per-test timeouts
# still override this.
HOME="$HOME_DIR" bun test --timeout 20000 "$@"
