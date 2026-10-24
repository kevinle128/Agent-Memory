#!/usr/bin/env bash
# skill-project-gate-e2e.sh: end-to-end check of the project label on skill
# rounds and of the extraction gate, over HTTP against a running local Core
# in `code` prompt mode.
#
# Usage:
#   TOKEN_FILE=~/.cache/am-e2e/service_token TEAM=team-x AGENT=agt-x USER_ID=usr-x \
#   CORE_LOG=~/.cache/am-e2e/logs/core.log MemoryCore/scripts/qa/skill-project-gate-e2e.sh
#
# The token is read from TOKEN_FILE and never printed.
#
# Checks:
#   G1  a round with a project is accepted
#   G2  a round of another project archives the previous buffer first
#   G3  a session without a project is dropped by the gate with reason no_project
#   G4  a session with one project passes the gate (no project drop for it)
#   G5  a malformed project hash is refused or ignored, never stored as a project

set -uo pipefail

CORE="${CORE:-http://127.0.0.1:8420}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.cache/am-e2e/service_token}"
CORE_LOG="${CORE_LOG:-$HOME/.cache/am-e2e/logs/core.log}"
TEAM="${TEAM:?TEAM required}"
AGENT="${AGENT:?AGENT required}"
USER_ID="${USER_ID:?USER_ID required}"
SPACE="${SPACE:-default}"
SUFFIX="$(date +%s)"
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

# Each scenario uses its own user id, so it has its own worker queue and a
# task that waits for the LLM cannot block the next scenario.
ids() { echo "\"space_id\":\"$SPACE\",\"team_id\":\"$TEAM\",\"agent_id\":\"$AGENT\",\"user_id\":\"$USER_ID-$1\",\"session_id\":\"$1\""; }
msgs='"messages":[{"role":"user","content":"Run the build and fix the lint errors."},{"role":"assistant","content":"Build passed after fixing two lint errors."}]'
proj() { echo "\"project_key\":\"git:git.oceanlabs.dev/$2\",\"project_hash\":\"$1\",\"project_name\":\"$2\""; }

# Wait until the worker logged a decision line that mentions the task id.
wait_log() {
  for _ in $(seq 1 60); do
    grep -q "$1" "$CORE_LOG" && return 0
    sleep 1
  done
  return 1
}

# G1 + G2: one session, project A then project B
S1="e2e-gate-mix-$SUFFIX"
R="$(call conversation/add "{$(ids "$S1"),$(proj "$HASH_A" vtc/3q-chess/3q-game-api),$msgs}")"
[[ "$(echo "$R" | jget 'd["code"]')" == "0" ]] && ok "G1 round with project accepted" || bad "G1 $R"
R="$(call conversation/add "{$(ids "$S1"),$(proj "$HASH_B" kevinle128/agent-memory),$msgs}")"
TASK_A="$(echo "$R" | jget 'd["data"]["archived"]["task_id"]')"
[[ -n "$TASK_A" && "$TASK_A" != "None" ]] && ok "G2 project change archived the previous buffer ($TASK_A)" || bad "G2 $R"

# G3: session without project, forced archive
S2="e2e-gate-none-$SUFFIX"
call conversation/add "{$(ids "$S2"),$msgs}" >/dev/null
R="$(call conversation/force-archive "{$(ids "$S2"),\"reason\":\"e2e\"}")"
TASK_N="$(echo "$R" | jget 'd["data"]["task_id"]')"
if [[ -n "$TASK_N" ]] && wait_log "task_id=$TASK_N reason=no_project"; then
  ok "G3 no-project task dropped (no_project)"
else
  bad "G3 task=$TASK_N archive=$R"
fi

# G4: the project-A task from G2 passes the gate and reaches the extractor.
# Without a local LLM the extract step then fails and is retried, which is
# still proof that the gate let it through.
if [[ -n "$TASK_A" ]] && wait_log "extract start task_id=$TASK_A"; then
  if grep "$TASK_A" "$CORE_LOG" | grep -q "project gate dropped"; then
    bad "G4 one-project task was dropped"
  else
    ok "G4 one-project task passed the gate and reached the extractor"
  fi
else
  bad "G4 task $TASK_A did not reach the extractor"
fi

# G5: malformed hash
S3="e2e-gate-bad-$SUFFIX"
R="$(call conversation/add "{$(ids "$S3"),\"project_key\":\"git:x/y\",\"project_hash\":\"NOT-A-HASH\",$msgs}")"
CODE="$(echo "$R" | jget 'd["code"]')"
if [[ "$CODE" != "0" ]]; then
  ok "G5 malformed hash refused ($CODE)"
else
  R="$(call conversation/force-archive "{$(ids "$S3"),\"reason\":\"e2e\"}")"
  T="$(echo "$R" | jget 'd["data"]["task_id"]')"
  if [[ -n "$T" ]] && wait_log "task_id=$T reason=no_project"; then ok "G5 malformed hash stored as no project"; else bad "G5 $R"; fi
fi

echo "== $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
