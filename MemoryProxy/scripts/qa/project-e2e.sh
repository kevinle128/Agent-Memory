#!/usr/bin/env bash
# project-e2e.sh: end-to-end check of project-scoped memory with a real
# Claude Code client, the local proxy, and the local Core.
#
# Prerequisites: the local stack from docs/local-development.md is running
# (Mongo in Docker, Core on :8420, proxy on :8096), and `claude` is on PATH.
#
# Usage:
#   USER_KEY_FILE=~/.cache/am-e2e/user_key MemoryProxy/scripts/qa/project-e2e.sh
#
# The script uses a temporary HOME, so it never touches the real
# ~/.claude/settings.json. It reads the user key from a file and never prints it.
#
# Checks:
#   P1  a repo with a nested GitLab remote gets the project name
#       `vtc/3q-chess/3q-game-api` on its L0 rows
#   P2  a folder outside git gets no project on its L0 rows

set -uo pipefail

PROXY="${PROXY:-http://127.0.0.1:8096}"
SPACE="${SPACE:-default}"
USER_KEY_FILE="${USER_KEY_FILE:-$HOME/.cache/am-e2e/user_key}"
MONGO_CONTAINER="${MONGO_CONTAINER:-memorycore-mongo-search-1}"
REMOTE="https://git.oceanlabs.dev/vtc/3q-chess/3q-game-api"
EXPECTED_NAME="vtc/3q-chess/3q-game-api"

[[ -r "$USER_KEY_FILE" ]] || { echo "FAIL: user key file $USER_KEY_FILE is not readable"; exit 1; }
command -v claude >/dev/null || { echo "FAIL: claude is not on PATH"; exit 1; }
curl -fsS "$PROXY/health" >/dev/null || { echo "FAIL: proxy $PROXY is not healthy"; exit 1; }

WORK="$(mktemp -d /tmp/am-e2e.XXXXXX)"
export HOME="$WORK/home"
mkdir -p "$HOME/.claude" "$WORK/repo" "$WORK/plain"
trap 'rm -rf "$WORK"' EXIT

# Settings for the temporary HOME. The key goes through a file, not argv.
python3 - "$USER_KEY_FILE" "$PROXY/claude-code/$SPACE" "$HOME/.claude/settings.json" <<'PY'
import json, sys
key = open(sys.argv[1]).read().strip()
json.dump({"env": {"ANTHROPIC_BASE_URL": sys.argv[2], "ANTHROPIC_AUTH_TOKEN": key}}, open(sys.argv[3], "w"))
PY

curl -fsSL "$PROXY/setup/hooks.sh" | bash -s -- --client claude-code >/dev/null \
  || { echo "FAIL: hook install"; exit 1; }

git -C "$WORK/repo" init -q && git -C "$WORK/repo" remote add origin "$REMOTE"

pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }

# Run one prompt and print the session id that Claude Code used.
run_prompt() {
  local dir="$1" sid
  sid="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  (cd "$dir" && claude -p --session-id "$sid" "Reply with the single word OK." >/dev/null 2>&1)
  echo "$sid"
}

# L0 project fields for one session, as JSON lines.
l0_project() {
  docker exec "$MONGO_CONTAINER" mongosh --quiet tdai_memory --eval \
    "db.l0_conversations.find({session_id: '$1'}, {_id:0, project_hash:1, project_name:1}).forEach(d => print(JSON.stringify(d)))"
}

# L0 is written after the reply; give the proxy a short time.
wait_l0() {
  local sid="$1" out=""
  for _ in $(seq 1 30); do
    out="$(l0_project "$sid")"
    [[ -n "$out" ]] && { echo "$out"; return; }
    sleep 1
  done
}

echo "== P1: repo with remote $REMOTE"
SID1="$(run_prompt "$WORK/repo")"
ROWS1="$(wait_l0 "$SID1")"
if [[ -z "$ROWS1" ]]; then
  bad "P1 no L0 rows for session $SID1"
elif echo "$ROWS1" | grep -q "\"project_name\":\"$EXPECTED_NAME\""; then
  ok "P1 L0 project_name=$EXPECTED_NAME"
else
  bad "P1 L0 rows: $ROWS1"
fi

echo "== P2: folder outside git"
SID2="$(run_prompt "$WORK/plain")"
ROWS2="$(wait_l0 "$SID2")"
if [[ -z "$ROWS2" ]]; then
  bad "P2 no L0 rows for session $SID2"
elif echo "$ROWS2" | grep -q '"project_name":"[^"]'; then
  bad "P2 L0 rows have a project: $ROWS2"
else
  ok "P2 L0 rows have no project"
fi

echo "== $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
