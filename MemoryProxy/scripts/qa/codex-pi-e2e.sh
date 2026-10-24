#!/usr/bin/env bash
# codex-pi-e2e.sh: end-to-end check that Codex and pi sessions get their
# project from the client hook, with the real clients, the local proxy, and the
# local Core in mongodb mode.
#
# Prerequisites: the local stack from docs/local-development.md is running
# (Mongo in Docker, Core on :8420, proxy on :8096), and `codex` and `pi` are on
# PATH. Codex reaches its upstream through the proxy; the pi model call may fail
# upstream, which does not matter for the pi checks.
#
# Usage:
#   USER_KEY_FILE=~/.cache/am-e2e/user_key PROXY_LOG=~/.cache/am-e2e/logs/proxy.log \
#   MemoryProxy/scripts/qa/codex-pi-e2e.sh
#
# The script uses a temporary HOME, so it never touches the real ~/.codex or
# ~/.pi. It reads the user key from a file and never prints it.
#
# Checks:
#   C1  a Codex session in a repo reports the project name and writes it on L0
#   C2  a Codex session outside git reports no project and writes none on L0
#   C3  `codex exec resume` keeps the session id and its project
#   C4  `codex exec fork` gets a new session id that reports the project
#   P1  a pi session in a repo reports the project name, and the proxy session
#       key equals the reported session id
#   P2  a pi session outside git reports no project, with the same join

set -uo pipefail

PROXY="${PROXY:-http://127.0.0.1:8096}"
SPACE="${SPACE:-default}"
USER_KEY_FILE="${USER_KEY_FILE:-$HOME/.cache/am-e2e/user_key}"
PROXY_LOG="${PROXY_LOG:-$HOME/.cache/am-e2e/logs/proxy.log}"
MONGO_CONTAINER="${MONGO_CONTAINER:-memorycore-mongo-search-1}"
CODEX_MODEL="${CODEX_MODEL:-gpt-6-astra}"
PI_MODEL="${PI_MODEL:-gpt-4o-mini}"
REMOTE="https://git.oceanlabs.dev/vtc/3q-chess/3q-game-api"
EXPECTED_NAME="vtc/3q-chess/3q-game-api"
INSTALL="$(cd "$(dirname "$0")/../.." && pwd)/assets/client-hooks/install.sh"

[[ -r "$USER_KEY_FILE" ]] || { echo "FAIL: user key file $USER_KEY_FILE is not readable"; exit 1; }
for cmd in codex pi; do command -v "$cmd" >/dev/null || { echo "FAIL: $cmd is not on PATH"; exit 1; }; done
curl -fsS "$PROXY/health" >/dev/null || { echo "FAIL: proxy $PROXY is not healthy"; exit 1; }

WORK="$(mktemp -d /tmp/am-e2e.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"
export CODEX_HOME="$HOME/.codex"
export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
mkdir -p "$CODEX_HOME" "$PI_CODING_AGENT_DIR" "$WORK/repo" "$WORK/plain"
git -C "$WORK/repo" init -q && git -C "$WORK/repo" remote add origin "$REMOTE"

# Client configs for the temporary HOME. The key goes through a file, not argv.
python3 - "$USER_KEY_FILE" "$PROXY" "$SPACE" "$CODEX_MODEL" "$PI_MODEL" "$CODEX_HOME/config.toml" "$PI_CODING_AGENT_DIR/models.json" <<'PY'
import json, sys
key, proxy, space, codex_model, pi_model, codex_cfg, pi_cfg = open(sys.argv[1]).read().strip(), *sys.argv[2:]
open(codex_cfg, "w").write(f'''model = "{codex_model}"
model_provider = "team-proxy"
disable_response_storage = true

[model_providers.team-proxy]
name = "TDAI team-proxy"
wire_api = "responses"
base_url = "{proxy}/codex/{space}"
experimental_bearer_token = "{key}"
''')
json.dump({"providers": {"am-proxy": {
    "baseUrl": f"{proxy}/pi/{space}/v1", "api": "openai-completions",
    "apiKey": "$AM_E2E_KEY", "models": [{"id": pi_model}],
}}}, open(pi_cfg, "w"))
PY
chmod 600 "$CODEX_HOME/config.toml"

(cd "$WORK/repo" && bash "$INSTALL" --client codex --base-url "$PROXY" </dev/null >/dev/null 2>&1) \
  || { echo "FAIL: codex hook install"; exit 1; }
(cd "$WORK/repo" && bash "$INSTALL" --client pi --base-url "$PROXY" </dev/null >/dev/null 2>&1) \
  || { echo "FAIL: pi hook install"; exit 1; }

pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }

# Proxy log lines written since the given line count.
# `|| true`: a reader such as `grep -q` may stop early; the SIGPIPE of tail
# must not fail the pipeline under pipefail.
log_since() { tail -n +"$(($1 + 1))" "$PROXY_LOG" || true; }

l0_project() {
  docker exec "$MONGO_CONTAINER" mongosh --quiet tdai_memory --eval \
    "db.l0_conversations.find({session_id: '$1'}, {_id:0, project_hash:1, project_name:1}).forEach(d => print(JSON.stringify(d)))"
}
wait_l0() {
  local out=""
  for _ in $(seq 1 30); do
    out="$(l0_project "$1")"
    [[ -n "$out" ]] && { echo "$out"; return; }
    sleep 1
  done
}

# Run one Codex exec in a folder; print the first Codex hook report.
# Extra arguments go before the prompt (for example: resume <id>).
run_codex() {
  local dir="$1" before; shift
  before="$(wc -l < "$PROXY_LOG")"
  (cd "$dir" && timeout 120 codex exec --skip-git-repo-check "$@" "Reply with the single word ok." </dev/null >/dev/null 2>&1)
  log_since "$before" | grep "\[hook-report\]" | grep "agent=codex" | head -1
}

# Run one pi prompt; print the hook report and the injection line.
run_pi() {
  local before; before="$(wc -l < "$PROXY_LOG")"
  (cd "$1" && AM_E2E_KEY="$(cat "$USER_KEY_FILE")" timeout 90 \
    pi -p --model "am-proxy/$PI_MODEL" "Reply with the single word ok." </dev/null >/dev/null 2>&1)
  sleep 1
  log_since "$before" | grep -E "\[hook-report\].*agent=pi|\[injection-debug\].*agentSource=pi"
}

sid_of() { sed -E 's/.*session=([^ ]+).*/\1/' <<<"$1"; }

echo "== C1: Codex in a repo with remote $REMOTE"
REPORT="$(run_codex "$WORK/repo")"
SID="$(sid_of "$REPORT")"
ROWS="$( [[ -n "$SID" ]] && wait_l0 "$SID")"
if [[ "$REPORT" != *"name=$EXPECTED_NAME"* ]]; then
  bad "C1 hook report: ${REPORT:-none}"
elif ! echo "$ROWS" | grep -q "\"project_name\":\"$EXPECTED_NAME\""; then
  bad "C1 L0 rows for $SID: ${ROWS:-none}"
else
  ok "C1 hook report and L0 project_name=$EXPECTED_NAME"
fi

C1_SID="$SID"

echo "== C3: Codex resume"
REPORT="$(run_codex "$WORK/repo" resume "$C1_SID")"
if [[ -n "$C1_SID" && "$(sid_of "$REPORT")" == "$C1_SID" && "$REPORT" == *"name=$EXPECTED_NAME"* ]]; then
  ok "C3 resume keeps session $C1_SID and its project"
else
  bad "C3 hook report: ${REPORT:-none}"
fi

echo "== C4: Codex fork"
REPORT="$(run_codex "$WORK/repo" fork "$C1_SID")"
SID="$(sid_of "$REPORT")"
if [[ -n "$SID" && "$SID" != "$C1_SID" && "$REPORT" == *"name=$EXPECTED_NAME"* ]]; then
  ok "C4 fork has its own session $SID with the project"
else
  bad "C4 hook report: ${REPORT:-none}"
fi

echo "== C2: Codex outside git"
REPORT="$(run_codex "$WORK/plain")"
SID="$(sid_of "$REPORT")"
ROWS="$( [[ -n "$SID" ]] && wait_l0 "$SID")"
if [[ "$REPORT" != *"project=none"* ]]; then
  bad "C2 hook report: ${REPORT:-none}"
elif [[ -z "$ROWS" ]] || echo "$ROWS" | grep -q '"project_name":"[^"]'; then
  bad "C2 L0 rows for $SID: ${ROWS:-none}"
else
  ok "C2 hook report and L0 rows have no project"
fi

check_pi() {
  local label="$1" dir="$2" want="$3" lines report sid
  lines="$(run_pi "$dir")"
  report="$(grep "\[hook-report\]" <<<"$lines" | head -1)"
  sid="$(sid_of "$report")"
  if [[ "$report" != *"$want"* ]]; then
    bad "$label hook report: ${report:-none}"
  elif [[ -z "$sid" ]] || ! grep -q "sessionKey=$sid " <<<"$lines"; then
    bad "$label proxy session key does not equal hook session $sid"
  else
    ok "$label hook report ($want) joins proxy session $sid"
  fi
}

echo "== P1: pi in a repo"
check_pi P1 "$WORK/repo" "name=$EXPECTED_NAME"
echo "== P2: pi outside git"
check_pi P2 "$WORK/plain" "project=none"

echo "== $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
