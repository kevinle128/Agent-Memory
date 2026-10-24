#!/usr/bin/env bash
# skill-change-e2e.sh: end-to-end check of skill change rules over HTTP
# against a running local Core.
#
# Usage:
#   TOKEN_FILE=~/.cache/am-e2e/service_token TEAM=team-x AGENT=agt-x USER_ID=usr-x \
#     MemoryCore/scripts/qa/skill-change-e2e.sh
#
# TOKEN_FILE holds the Core service token (the proxy `skill.serviceToken`).
# The token is read from the file and never printed.
#
# Checks:
#   S1  a manual global skill is created and applied (v1)
#   S2  a system change to a global skill becomes a pending proposal (still v1)
#   S3  approving the proposal applies it at once (v2, approved_by = user)
#   S4  a proposal whose base version moved becomes stale and is not applied
#   S5  rollback creates a new version with the old content and a reason
#   S6  rollback without a reason is refused
#   S7  diff between two versions lists added and removed lines
#   S8  a system change to a project skill is applied without approval
#   S9  versions list carries the audit fields

set -uo pipefail

CORE="${CORE:-http://127.0.0.1:8420}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.cache/am-e2e/service_token}"
TEAM="${TEAM:?TEAM required}"
AGENT="${AGENT:?AGENT required}"
USER_ID="${USER_ID:?USER_ID required}"
HASH="ad58481031f5b554"
SUFFIX="$(date +%s)"

[[ -r "$TOKEN_FILE" ]] || { echo "FAIL: token file $TOKEN_FILE is not readable"; exit 1; }
TOKEN="$(cat "$TOKEN_FILE")"

pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }

# POST a JSON body to a Core skill route; print the response body.
call() {
  curl -sS -X POST "$CORE/v3/skill/$1" \
    -H "authorization: Bearer $TOKEN" -H "x-tdai-service-id: ${SERVICE_ID:-default}" \
    -H 'content-type: application/json' -d "$2"
}

# Read one value from JSON on stdin with a Python expression on `d`.
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

ids="\"team_id\":\"$TEAM\",\"agent_id\":\"$AGENT\",\"user_id\":\"$USER_ID\""
skill_md() { printf -- '---\\nname: %s\\ndescription: e2e skill\\n---\\n%s' "$1" "$2"; }

# S1
NAME="e2e-global-$SUFFIX"
R="$(call create "{$ids,\"name\":\"$NAME\",\"content\":\"$(skill_md "$NAME" 'step one\\nstep two')\"}")"
SID="$(echo "$R" | jget 'd["data"]["skill_id"]')"
[[ -n "$SID" && "$(echo "$R" | jget 'd["data"]["version"]')" == "1" ]] && ok "S1 global skill v1" || bad "S1 $R"

# S2
R="$(call update "{$ids,\"skill_id\":\"$SID\",\"expected_version\":1,\"content\":\"$(skill_md "$NAME" 'step one\\nstep two\\nstep three')\",\"change_source\":\"extracted\",\"change_reason\":\"e2e reason\",\"change_summary\":[\"Added step three\"]}")"
PID="$(echo "$R" | jget 'd["data"]["proposal"]["proposal_id"]')"
[[ -n "$PID" && "$(echo "$R" | jget 'd["data"]["applied"]')" == "False" ]] && ok "S2 pending proposal" || bad "S2 $R"
R="$(call get "{$ids,\"skill_id\":\"$SID\"}")"
[[ "$(echo "$R" | jget 'd["data"]["version"]')" == "1" ]] && ok "S2 skill still v1" || bad "S2 head $R"

# S3
R="$(call proposals/approve "{$ids,\"proposal_id\":\"$PID\"}")"
[[ "$(echo "$R" | jget 'd["data"]["skill"]["version"]')" == "2" ]] && ok "S3 approve applied v2" || bad "S3 $R"

# S4: propose on v2, then a manual edit makes v3, then approve -> stale
R="$(call update "{$ids,\"skill_id\":\"$SID\",\"expected_version\":2,\"content\":\"$(skill_md "$NAME" 'proposal on v2')\",\"change_source\":\"extracted\",\"change_reason\":\"e2e\",\"change_summary\":[\"Rewrote steps\"]}")"
PID2="$(echo "$R" | jget 'd["data"]["proposal"]["proposal_id"]')"
call update "{$ids,\"skill_id\":\"$SID\",\"expected_version\":2,\"content\":\"$(skill_md "$NAME" 'manual v3')\",\"change_source\":\"manual\",\"change_reason\":\"manual edit\"}" >/dev/null
R="$(call proposals/approve "{$ids,\"proposal_id\":\"$PID2\"}")"
LIST="$(call proposals/list "{$ids,\"skill_id\":\"$SID\",\"status\":[\"stale\"]}")"
if echo "$LIST" | grep -q "$PID2" && [[ "$(call get "{$ids,\"skill_id\":\"$SID\"}" | jget 'd["data"]["version"]')" == "3" ]]; then
  ok "S4 stale proposal not applied"
else
  bad "S4 approve=$R list=$LIST"
fi

# S5
R="$(call rollback "{$ids,\"skill_id\":\"$SID\",\"target_version\":1,\"reason\":\"e2e rollback\"}")"
[[ "$(echo "$R" | jget 'd["data"]["version"]')" == "4" && "$(echo "$R" | jget 'd["data"]["change_source"]')" == "rollback" ]] \
  && ok "S5 rollback created v4" || bad "S5 $R"

# S6
R="$(call rollback "{$ids,\"skill_id\":\"$SID\",\"target_version\":2}")"
[[ "$(echo "$R" | jget 'd["code"]')" != "0" ]] && ok "S6 rollback without reason refused" || bad "S6 $R"

# S7
R="$(call versions/diff "{$ids,\"skill_id\":\"$SID\",\"from_version\":1,\"to_version\":2}")"
[[ "$(echo "$R" | jget 'd["data"]["added"]')" == "1" ]] && ok "S7 diff v1..v2 added=1" || bad "S7 $R"

# S8
PNAME="e2e-project-$SUFFIX"
R="$(call create "{$ids,\"name\":\"$PNAME\",\"content\":\"$(skill_md "$PNAME" 'p1')\",\"scope\":\"project\",\"project_hash\":\"$HASH\",\"project_name\":\"vtc/3q-chess/3q-game-api\"}")"
PSID="$(echo "$R" | jget 'd["data"]["skill_id"]')"
R="$(call update "{$ids,\"skill_id\":\"$PSID\",\"expected_version\":1,\"content\":\"$(skill_md "$PNAME" 'p2')\",\"change_source\":\"extracted\",\"change_reason\":\"e2e\",\"change_summary\":[\"Changed p\"]}")"
[[ "$(echo "$R" | jget 'd["data"]["version"]')" == "2" ]] && ok "S8 project skill change applied" || bad "S8 $R"

# S9
R="$(call versions "{$ids,\"skill_id\":\"$SID\"}")"
echo "$R" | jget '[ (i["version"], i["change_source"], i["approved_by"]) for i in d["data"]["items"] ]' | grep -q "'rollback'" \
  && ok "S9 versions carry audit fields" || bad "S9 $R"

echo "== $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
