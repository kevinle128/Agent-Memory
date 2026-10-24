#!/usr/bin/env bash
# skill-project-read-e2e.sh: end-to-end check that a session sees only global
# skills and skills of its own project, over HTTP against a running local Core,
# and through the local proxy with a real Claude Code session.
#
# Usage:
#   TOKEN_FILE=~/.cache/am-e2e/service_token TEAM=team-x AGENT=agt-x USER_ID=usr-x \
#   PROXY_LOG=~/.cache/am-e2e/logs/proxy.log MemoryCore/scripts/qa/skill-project-read-e2e.sh
#
# Tokens are read from files and never printed.
#
# Checks (Core):
#   R1  listing with project A has the global skill and the A skill, not the B skill
#   R2  listing with scope_filter global_only has only the global skill
#   R3  listing without project or filter has all three (Hub view, unchanged)
#   R4  get of the B skill with project A answers not found
#   R5  search with project A does not return the B skill
# Checks (proxy, real Claude Code):
#   R6  a session in a repo of project A injects the global and A skills only
#   R7  a session outside git injects the global skill only

set -uo pipefail

CORE="${CORE:-http://127.0.0.1:8420}"
PROXY="${PROXY:-http://127.0.0.1:8096}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.cache/am-e2e/service_token}"
USER_KEY_FILE="${USER_KEY_FILE:-$HOME/.cache/am-e2e/user_key}"
PROXY_LOG="${PROXY_LOG:-$HOME/.cache/am-e2e/logs/proxy.log}"
TEAM="${TEAM:?TEAM required}"
AGENT="${AGENT:?AGENT required}"
USER_ID="${USER_ID:?USER_ID required}"
SUFFIX="$(date +%s)"
REMOTE_A="https://git.oceanlabs.dev/vtc/3q-chess/3q-game-api"
HASH_A="ad58481031f5b554"
HASH_B="db73c988534bc1c8"

TOKEN="$(cat "$TOKEN_FILE")"
pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
call() {
  curl -sS -X POST "$CORE/v3/skill/$1" \
    -H "authorization: Bearer $TOKEN" -H "x-tdai-service-id: ${SERVICE_ID:-default}" \
    -H 'content-type: application/json' -d "$2"
}
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
ids="\"team_id\":\"$TEAM\",\"agent_id\":\"$AGENT\",\"user_id\":\"$USER_ID\""
md() { printf -- '---\\nname: %s\\ndescription: %s\\n---\\nUse the deploy checklist for %s.' "$1" "$2" "$1"; }

G="e2e-read-global-$SUFFIX"; A="e2e-read-a-$SUFFIX"; B="e2e-read-b-$SUFFIX"
call create "{$ids,\"name\":\"$G\",\"content\":\"$(md "$G" 'deploy checklist global')\"}" >/dev/null
call create "{$ids,\"name\":\"$A\",\"content\":\"$(md "$A" 'deploy checklist project a')\",\"scope\":\"project\",\"project_hash\":\"$HASH_A\",\"project_name\":\"vtc/3q-chess/3q-game-api\"}" >/dev/null
BID="$(call create "{$ids,\"name\":\"$B\",\"content\":\"$(md "$B" 'deploy checklist project b')\",\"scope\":\"project\",\"project_hash\":\"$HASH_B\",\"project_name\":\"kevinle128/agent-memory\"}" | jget 'd["data"]["skill_id"]')"

names() { jget '" ".join(sorted(h["name"] for h in d["data"].get("hits") or d["data"].get("items") or []))'; }
has()   { [[ " $1 " == *" $2 "* ]]; }

L="$(call listing "{$ids,\"project_hash\":\"$HASH_A\"}" | names)"
has "$L" "$G" && has "$L" "$A" && ! has "$L" "$B" && ok "R1 project A listing" || bad "R1 got: $L"

L="$(call listing "{$ids,\"scope_filter\":\"global_only\"}" | names)"
has "$L" "$G" && ! has "$L" "$A" && ! has "$L" "$B" && ok "R2 global-only listing" || bad "R2 got: $L"

L="$(call list "{$ids,\"pagination\":{\"limit\":200}}" | names)"
has "$L" "$G" && has "$L" "$A" && has "$L" "$B" && ok "R3 unfiltered list keeps every skill" || bad "R3 got: $L"

C="$(call get "{$ids,\"skill_id\":\"$BID\",\"project_hash\":\"$HASH_A\"}" | jget 'd["code"]')"
[[ "$C" == "40401" ]] && ok "R4 other-project get is not found" || bad "R4 code=$C"

L="$(call search "{$ids,\"query\":\"deploy checklist\",\"project_hash\":\"$HASH_A\"}" | names)"
! has "$L" "$B" && ok "R5 search hides the other project" || bad "R5 got: $L"

# Proxy with a real Claude Code session and a temporary HOME.
WORK="$(mktemp -d /tmp/am-e2e.XXXXXX)"; trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"; mkdir -p "$HOME/.claude" "$WORK/repo" "$WORK/plain"
python3 - "$USER_KEY_FILE" "$PROXY/claude-code/default" "$HOME/.claude/settings.json" <<'PY'
import json, sys
json.dump({"env": {"ANTHROPIC_BASE_URL": sys.argv[2], "ANTHROPIC_AUTH_TOKEN": open(sys.argv[1]).read().strip()}}, open(sys.argv[3], "w"))
PY
curl -fsSL "$PROXY/setup/hooks.sh" | bash -s -- --client claude-code >/dev/null
git -C "$WORK/repo" init -q && git -C "$WORK/repo" remote add origin "$REMOTE_A"

injected_for() {
  local dir="$1" sid; sid="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  local before; before="$(wc -l < "$PROXY_LOG")"
  (cd "$dir" && claude -p --session-id "$sid" "Reply with the single word OK." >/dev/null 2>&1)
  tail -n +"$((before + 1))" "$PROXY_LOG" | grep "\[skill-injector\]" | grep "names=" | tail -1
}

LINE="$(injected_for "$WORK/repo")"
if [[ "$LINE" == *"$G"* && "$LINE" == *"$A"* && "$LINE" != *"$B"* ]]; then ok "R6 repo session injects global + project A"; else bad "R6 $LINE"; fi
LINE="$(injected_for "$WORK/plain")"
if [[ "$LINE" == *"$G"* && "$LINE" != *"$A"* && "$LINE" != *"$B"* ]]; then ok "R7 non-git session injects global only"; else bad "R7 $LINE"; fi

echo "== $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
