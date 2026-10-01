#!/bin/bash

# Kimi renders the first stdout line and falls back to its built-in footer when
# this command fails or exceeds 300 ms. Keep the path to one agent-loom process.
input=""
if [ ! -t 0 ]; then
    IFS= read -r -d '' input || true
fi
[ -n "$input" ] || exit 0

# The launcher-minted id is the identity registered by Kimi's agent-loom MCP
# process. Kimi's native sessionId belongs to a different namespace.
[ -n "${AGENT_SESSION_ID:-}" ] || exit 0
command -v agent-loom >/dev/null 2>&1 || exit 0

mail_fields=$(printf '%s' "$input" | agent-loom status-line --fields 2>/dev/null)
[ -n "$mail_fields" ] || exit 0

# A non-whitespace separator preserves empty fields when Bash splits the row.
mail_fields="${mail_fields//$'\t'/$'\x1f'}"
IFS=$'\x1f' read -r session_name peer_count unread_count push_status weft_count <<<"$mail_fields"
[ -n "$session_name" ] || exit 0

case "$push_status" in
    push) session_name="$session_name ⇣" ;;
    pull) session_name="$session_name ↻" ;;
    unknown) session_name="$session_name ?" ;;
esac

fields=("$session_name")
if [ "${unread_count:-0}" -gt 0 ] 2>/dev/null; then
    fields+=("$unread_count unread")
fi
if [ "${weft_count:-0}" -gt 0 ] 2>/dev/null; then
    fields+=("$weft_count unprocessed")
fi
if [ "${peer_count:-0}" -gt 0 ] 2>/dev/null; then
    if [ "$peer_count" -eq 1 ]; then
        fields+=("1 peer")
    else
        fields+=("$peer_count peers")
    fi
fi

output=""
for field in "${fields[@]}"; do
    if [ -z "$output" ]; then
        output="$field"
    else
        output="$output · $field"
    fi
done
printf '%s\n' "$output"
