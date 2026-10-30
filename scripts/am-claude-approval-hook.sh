#!/bin/sh
# Blocking Claude Code hook: asks Agent Manager for a chat decision on a
# permission dialog or an AskUserQuestion. Any guard failure or error exits 0
# with nothing on stdout, which leaves Claude's normal terminal dialog in place.

[ -n "$AM_ID" ] || exit 0
case "$AM_ID" in *[!a-zA-Z0-9_-]*) exit 0 ;; esac
[ -n "$AM_RUN_ID" ] || exit 0
case "$AM_RUN_ID" in *[!a-zA-Z0-9_-]*) exit 0 ;; esac
case "$AM_PANE_PID" in '' | *[!0-9]*) exit 0 ;; esac
case "$AM_PORT" in '' | *[!0-9]*) exit 0 ;; esac
[ "$AM_CLI" = "claude" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

# Only this pane's own claude process: the guard filters other claude processes
# that inherit the global config. In-process background subagents share
# CLAUDE_PID, so they pass it and do reach chat (docs/messengers.md).
[ "$CLAUDE_CODE_ENTRYPOINT" = "cli" ] || exit 0
case "$CLAUDE_PID" in '' | *[!0-9]*) exit 0 ;; esac
if [ "$CLAUDE_PID" != "$AM_PANE_PID" ]; then
  stat=$(cat "/proc/$CLAUDE_PID/stat" 2>/dev/null) || exit 0
  rest=${stat##*) }
  rest=${rest#* }
  [ "${rest%% *}" = "$AM_PANE_PID" ] || exit 0
fi

payload=$(mktemp "${TMPDIR:-/tmp}/am-approval-hook.XXXXXX") || exit 0
response=$(mktemp "${TMPDIR:-/tmp}/am-approval-resp.XXXXXX") || { rm -f "$payload"; exit 0; }
trap 'rm -f "$payload" "$response"' EXIT HUP INT TERM
cat > "$payload" || exit 0

case "$(jq -r '.hook_event_name // empty' "$payload" 2>/dev/null)" in
  PermissionRequest) ;;
  PreToolUse) [ "$(jq -r '.tool_name // empty' "$payload" 2>/dev/null)" = "AskUserQuestion" ] || exit 0 ;;
  *) exit 0 ;;
esac

# A failure is reported on stderr, which Claude shows only in verbose mode, so
# the terminal dialog is unaffected; stdout stays empty.
code=$(jq -n --arg runId "$AM_RUN_ID" --slurpfile payload "$payload" \
  '{runId:$runId,payload:$payload[0]}' 2>/dev/null \
  | curl -s --max-time 135 -X POST \
      -H 'X-AM-Request: 1' -H 'content-type: application/json' \
      --data-binary @- -o "$response" -w '%{http_code}' \
      "http://${AM_HOST:-127.0.0.1}:$AM_PORT/api/messengers/claude-hook?from=$AM_ID")
rc=$?
if [ "$rc" -ne 0 ] || [ "$code" != 200 ]; then
  echo "am-claude-approval-hook: no chat decision (curl exit $rc, HTTP $code); answer in the terminal" >&2
  exit 0
fi

jq -e '.output | type == "object"' "$response" >/dev/null 2>&1 || exit 0
jq -c .output "$response" 2>/dev/null
exit 0
