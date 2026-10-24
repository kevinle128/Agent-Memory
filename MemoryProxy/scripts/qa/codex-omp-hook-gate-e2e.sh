#!/usr/bin/env bash
# codex-omp-hook-gate-e2e.sh: end-to-end check of the mandatory project hook
# gate for interactive Codex and oh-my-pi (omp) sessions, with the real clients
# and the local proxy.
#
# Prerequisites: the local stack from docs/local-development.md is running
# (Core on :8420, proxy on :8096 with hookGate.enabled), and `codex`, `omp` and
# `tmux` are on PATH. Codex reaches its upstream through the proxy. The omp model
# call may fail upstream (the local pi upstream key can be invalid); the omp
# checks prove the gate from the proxy log and the files the installer wrote,
# not from the model answer.
#
# Usage:
#   USER_KEY_FILE=~/.cache/am-e2e/user_key PROXY_LOG=~/.cache/am-e2e/logs/proxy.log \
#   MemoryProxy/scripts/qa/codex-omp-hook-gate-e2e.sh
#
# The script uses temporary HOME directories, so it never touches the real
# ~/.codex, ~/.omp or ~/.agent-memory. It reads the user key from a file and never
# prints it. It removes the temporary directories and the tmux sessions it starts
# when it ends.
#
# Checks:
#   X1  Codex TUI without the hook shows the approval screen for the installer;
#       the title request of the terminal is a side request and is not gated
#   X2  approve: the report is stored, the original prompt is answered, the
#       synthetic items are removed from the forwarded request, and the hook is
#       installed in the temporary HOME
#   X3  the next prompt and the next session of the same HOME are not gated
#   X4  refuse: the answer is text with the manual command, nothing is installed
#   X5  `codex exec` without the hook is not gated
#   O1  omp TUI without the hook runs the installer by itself; the report is
#       stored, and the synthetic turns are removed from the forwarded request
#   O2  the next prompt and `omp -p` without the hook are not gated
#   O3  the installer adds compat.supportsPromptCacheKey to the proxy provider
#       (backup made, other providers untouched, second run changes nothing)
#   O4  the installer without a proxy provider stops with an instruction

set -uo pipefail

PROXY="${PROXY:-http://127.0.0.1:8096}"
SPACE="${SPACE:-default}"
USER_KEY_FILE="${USER_KEY_FILE:-$HOME/.cache/am-e2e/user_key}"
PROXY_LOG="${PROXY_LOG:-$HOME/.cache/am-e2e/logs/proxy.log}"
CODEX_MODEL="${CODEX_MODEL:-gpt-6-astra}"
OMP_MODEL="${OMP_MODEL:-gpt-4o-mini}"
QUESTION="What is 17 plus 25? Reply with only the number."
TMUX_PREFIX="am-gate-co-$$"
INSTALL="$(cd "$(dirname "$0")/../.." && pwd)/assets/client-hooks/install.sh"

[[ -r "$USER_KEY_FILE" ]] || { echo "FAIL: user key file $USER_KEY_FILE is not readable"; exit 1; }
for cmd in codex omp tmux; do command -v "$cmd" >/dev/null || { echo "FAIL: $cmd is not on PATH"; exit 1; }; done
curl -fsS "$PROXY/health" >/dev/null || { echo "FAIL: proxy $PROXY is not healthy"; exit 1; }

REAL_HOME="$HOME"
WORK="$(mktemp -d /tmp/am-gate-co.XXXXXX)"
cleanup() {
  tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "^$TMUX_PREFIX" | while read -r s; do tmux kill-session -t "$s" 2>/dev/null; done
  rm -rf "$WORK"
}
trap cleanup EXIT

pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }

pane() { tmux capture-pane -t "$1" -p 2>/dev/null; }
show() { pane "$1" | grep -v '^[[:space:]]*$' | tail -15; }

# wait_pane NAME REGEX SECONDS: wait until the screen matches REGEX.
wait_pane() {
  local name="$1" re="$2" secs="$3" i
  for ((i = 0; i < secs * 2; i++)); do
    pane "$name" | grep -Eq "$re" && return 0
    sleep 0.5
  done
  return 1
}

# Proxy log lines written since the line count in $1.
log_since() { tail -n +"$(($1 + 1))" "$PROXY_LOG"; }
log_mark() { wc -l < "$PROXY_LOG"; }
# wait_log MARK REGEX SECONDS: wait until a proxy log line since MARK matches REGEX.
wait_log() {
  local mark="$1" re="$2" secs="$3" i
  for ((i = 0; i < secs * 2; i++)); do
    log_since "$mark" | grep -Eq "$re" && return 0
    sleep 0.5
  done
  return 1
}

# send_prompt NAME [TEXT]: type the prompt, wait until the screen shows it, then
# press Enter. Typing into a screen that is not ready loses the text, so a
# missing text is cleared and typed again (up to three times).
send_prompt() {
  local name="$1" text="${2:-$QUESTION}" i j
  sleep 1
  for i in 1 2 3; do
    tmux send-keys -t "$name" -l "$text"
    for ((j = 0; j < 20; j++)); do
      pane "$name" | grep -qF "${text:0:20}" && break 2
      sleep 0.5
    done
    tmux send-keys -t "$name" C-u
    sleep 1
  done
  sleep 0.5
  tmux send-keys -t "$name" Enter
}

# ── Codex ────────────────────────────────────────────────────────────────────

# make_codex_home NAME: a HOME with a Codex config for the proxy, a trusted project folder, no hook.
make_codex_home() {
  local home="$WORK/$1/home" proj="$WORK/$1/proj"
  mkdir -p "$home/.codex" "$proj"
  proj="$(cd "$proj" && pwd -P)"
  python3 - "$USER_KEY_FILE" "$PROXY" "$SPACE" "$CODEX_MODEL" "$home/.codex/config.toml" "$proj" <<'PY'
import sys
key, proxy, space, model, cfg, proj = open(sys.argv[1]).read().strip(), *sys.argv[2:]
open(cfg, "w").write(f'''model = "{model}"
model_provider = "team-proxy"
disable_response_storage = true

[model_providers.team-proxy]
name = "TDAI team-proxy"
wire_api = "responses"
base_url = "{proxy}/codex/{space}"
experimental_bearer_token = "{key}"

[projects."{proj}"]
trust_level = "trusted"
''')
PY
  chmod 600 "$home/.codex/config.toml"
}

start_codex() {
  local name="$TMUX_PREFIX-$1" h="$WORK/$2"
  tmux new-session -d -s "$name" -x 160 -y 50 -c "$h/proj" \
    "env HOME=$h/home CODEX_HOME=$h/home/.codex codex" || return 1
  wait_pane "$name" 'Ask Codex to do anything' 40
}

codex_answered() { pane "$1" | grep -Eq '^[[:space:]]*•[[:space:]]*42[[:space:]]*$'; }

# Session id of the first gate answer in the log lines on stdin.
gated_session() { sed -nE 's/^\[hook-gate\] session=([^ ]+) agent=codex answered locally.*/\1/p' | head -1; }

echo "== X1/X2: Codex TUI without the hook, approve"
make_codex_home a
S="$TMUX_PREFIX-x1"; M="$(log_mark)"
start_codex x1 a || bad "X1 Codex did not start"
send_prompt "$S"
if wait_pane "$S" 'Would you like to run the following command' 60; then
  pane "$S" | grep -q 'setup/hooks.sh | bash -s -- --client codex --session' \
    && ok "X1 approval screen shows the installer command" || bad "X1 approval screen has no installer command"
  SID="$(log_since "$M" | gated_session)"
  [[ -n "$SID" ]] && ok "X1 request answered by the gate (session $SID)" || bad "X1 no gate log line"
  log_since "$M" | grep -q 'CODEX_AUX auxiliary request' && ok "X1 title request passed as a side request" || bad "X1 no side request in the log"
  [[ "$(log_since "$M" | grep -c 'agent=codex answered locally')" -eq 1 ]] && ok "X1 only the main request was gated" || bad "X1 more than one gated request"
  tmux send-keys -t "$S" y
  if wait_pane "$S" '^[[:space:]]*•[[:space:]]*42[[:space:]]*$' 120; then
    ok "X2 original prompt answered after the install"
  else
    bad "X2 no answer after the install; screen:"; show "$S"
  fi
  log_since "$M" | grep -q "\[hook-report\] session=$SID agent=codex event=Install" \
    && ok "X2 hook report stored for the session" || bad "X2 no hook report for $SID"
  log_since "$M" | grep -q "\[hook-gate\] session=$SID agent=codex removed synthetic items" \
    && ok "X2 synthetic items removed from the forwarded request" || bad "X2 no strip log line"
  [[ -x "$WORK/a/home/.agent-memory/hook.sh" ]] && grep -q 'agent-memory' "$WORK/a/home/.codex/config.toml" \
    && ok "X2 hook installed in the temporary HOME" || bad "X2 hook missing"

  echo "== X3: next prompt and next session are not gated"
  M="$(log_mark)"
  send_prompt "$S" "What is 20 plus 22? Reply with only the number."
  sleep 25
  [[ "$(log_since "$M" | grep -c 'agent=codex answered locally')" -eq 0 ]] \
    && ok "X3 next prompt of the session not gated" || bad "X3 next prompt gated"
  tmux kill-session -t "$S" 2>/dev/null
  M="$(log_mark)"
  S="$TMUX_PREFIX-x3"
  start_codex x3 a || bad "X3 second session did not start"
  send_prompt "$S"
  if wait_pane "$S" '^[[:space:]]*•[[:space:]]*42[[:space:]]*$' 120; then
    ok "X3 second session answered without the approval screen"
  else
    bad "X3 second session not answered; screen:"; show "$S"
  fi
  pane "$S" | grep -q 'Would you like to run' && bad "X3 approval screen shown again" || ok "X3 no approval screen in the second session"
  [[ "$(log_since "$M" | grep -c 'agent=codex answered locally')" -eq 0 ]] \
    && ok "X3 second session not gated in the log" || bad "X3 second session gated"
else
  bad "X1 approval screen not shown; screen:"; show "$S"
fi
tmux kill-session -t "$S" 2>/dev/null

echo "== X4: Codex TUI, refuse"
make_codex_home b
S="$TMUX_PREFIX-x4"; M="$(log_mark)"
start_codex x4 b || bad "X4 Codex did not start"
send_prompt "$S"
if wait_pane "$S" 'Would you like to run the following command' 60; then
  tmux send-keys -t "$S" Escape
  sleep 3
  send_prompt "$S" "hello again"
  if wait_pane "$S" 'was not approved' 60; then
    ok "X4 refusal answered with text"
    pane "$S" | grep -q 'hooks.sh | bash -s -- --client codex --session' \
      && ok "X4 text holds the manual command" || bad "X4 no manual command in the text"
  else
    bad "X4 no text after the refusal; screen:"; show "$S"
  fi
else
  bad "X4 approval screen not shown; screen:"; show "$S"
fi
[[ ! -e "$WORK/b/home/.agent-memory/hook.sh" ]] && ok "X4 nothing installed after the refusal" || bad "X4 hook was installed"
tmux kill-session -t "$S" 2>/dev/null

echo "== X5: codex exec without the hook"
make_codex_home c
M="$(log_mark)"
OUT="$(cd "$WORK/c/proj" && env HOME="$WORK/c/home" CODEX_HOME="$WORK/c/home/.codex" timeout 150 codex exec --skip-git-repo-check "$QUESTION" </dev/null 2>&1)"
if [[ "$OUT" == *42* ]]; then ok "X5 codex exec answered"; else bad "X5 codex exec output: ${OUT:0:300}"; fi
[[ "$(log_since "$M" | grep -c 'agent=codex answered locally')" -eq 0 ]] && ok "X5 codex exec not gated" || bad "X5 codex exec gated"
[[ ! -e "$WORK/c/home/.agent-memory/hook.sh" ]] && ok "X5 codex exec did not install the hook" || bad "X5 hook was installed"

# ── omp ──────────────────────────────────────────────────────────────────────

# make_omp_home NAME [NO_FLAG]: a HOME with an omp agent dir whose models.yml has a proxy provider.
make_omp_home() {
  local home="$WORK/$1/home" proj="$WORK/$1/proj"
  mkdir -p "$home/.omp/agent" "$proj"
  {
    echo "providers:"
    echo "  am-proxy:"
    echo "    baseUrl: $PROXY/pi/$SPACE/v1"
    echo "    apiKey: AM_E2E_KEY"
    echo "    api: openai-completions"
    if [[ "${2:-}" != "no-flag" ]]; then
      echo "    compat:"
      echo "      supportsPromptCacheKey: true"
    fi
    echo "    models:"
    echo "      - id: $OMP_MODEL"
    echo "        name: $OMP_MODEL"
    echo "        input: [text]"
    echo "        contextWindow: 100000"
    echo "        maxTokens: 4096"
  } > "$home/.omp/agent/models.yml"
  echo "setupVersion: 2" > "$home/.omp/agent/config.yml"
}

omp_env() { echo "HOME=$WORK/$1/home PI_CODING_AGENT_DIR=$WORK/$1/home/.omp/agent AM_E2E_KEY=$(cat "$USER_KEY_FILE")"; }

echo "== O1: omp TUI without the hook"
make_omp_home d
S="$TMUX_PREFIX-o1"; M="$(log_mark)"
tmux new-session -d -s "$S" -x 160 -y 50 -c "$WORK/d/proj" \
  "env $(omp_env d) omp --model am-proxy/$OMP_MODEL" || bad "O1 omp did not start"
wait_pane "$S" 'to change thinking effort' 60 || bad "O1 omp screen not ready"
sleep 2
send_prompt "$S"
if wait_pane "$S" 'Agent-Memory omp extension installed' 90; then
  ok "O1 omp ran the installer without an approval screen"
else
  bad "O1 installer did not run; screen:"; show "$S"
fi
OSID="$(log_since "$M" | sed -nE 's/^\[hook-gate\] session=([^ ]+) agent=pi answered locally.*/\1/p' | head -1)"
[[ -n "$OSID" ]] && ok "O1 request answered by the gate (session $OSID)" || bad "O1 no gate log line"
wait_log "$M" "\\[hook-report\\] session=$OSID agent=pi event=Install" 30 \
  && ok "O1 hook report stored for the session" || bad "O1 no hook report for $OSID"
wait_log "$M" "\\[hook-gate\\] session=$OSID agent=pi removed synthetic turns" 60 \
  && ok "O1 synthetic turns removed from the forwarded request" || bad "O1 no strip log line"
wait_log "$M" 'FORWARD upstream=.*chat/completions' 60 \
  && ok "O1 original prompt forwarded to the upstream" || bad "O1 prompt not forwarded"
[[ -f "$WORK/d/home/.omp/agent/extensions/agent-memory.ts" ]] && ok "O1 extension installed in the omp agent dir" || bad "O1 extension missing"

echo "== O2: next prompt and omp -p are not gated"
M="$(log_mark)"
send_prompt "$S" "What is 3 plus 4? Reply with only the number."
sleep 10
[[ "$(log_since "$M" | grep -c 'agent=pi answered locally')" -eq 0 ]] && ok "O2 next prompt not gated" || bad "O2 next prompt gated"
tmux kill-session -t "$S" 2>/dev/null

make_omp_home e
M="$(log_mark)"
(cd "$WORK/e/proj" && env $(omp_env e) timeout 90 omp -p --model "am-proxy/$OMP_MODEL" "$QUESTION" </dev/null >/dev/null 2>&1)
sleep 1
log_since "$M" | grep -q 'FORWARD upstream=.*chat/completions' && ok "O2 omp -p reached the upstream" || bad "O2 omp -p request not forwarded"
[[ "$(log_since "$M" | grep -c 'agent=pi answered locally')" -eq 0 ]] && ok "O2 omp -p not gated" || bad "O2 omp -p gated"
[[ ! -e "$WORK/e/home/.omp/agent/extensions/agent-memory.ts" ]] && ok "O2 omp -p did not install the extension" || bad "O2 extension was installed"

echo "== O3: installer sets compat.supportsPromptCacheKey"
make_omp_home f no-flag
cat >> "$WORK/f/home/.omp/agent/models.yml" <<'YML'
  other:
    baseUrl: https://api.example.com/v1
    apiKey: OTHER
    api: openai-completions
YML
cp "$WORK/f/home/.omp/agent/models.yml" "$WORK/f/before.yml"
SIDF="01a16eab-0b03-708d-8d4f-4bba152cad8e"; M="$(log_mark)"
OUT="$(cd "$WORK/f/proj" && env $(omp_env f) bash "$INSTALL" --client omp --session "$SIDF" </dev/null 2>&1)"
RC=$?
[[ $RC -eq 0 ]] && ok "O3 installer exit 0" || bad "O3 installer exit $RC: ${OUT:0:300}"
MF="$WORK/f/home/.omp/agent/models.yml"
python3 - "$MF" "$WORK/f/before.yml" <<'PY' && ok "O3 flag set on the proxy provider only, rest unchanged" || bad "O3 models.yml content wrong"
import sys
new, old = open(sys.argv[1]).read(), open(sys.argv[2]).read()
assert "    compat:\n      supportsPromptCacheKey: true\n" in new
assert new.count("supportsPromptCacheKey") == 1
assert new.replace("    compat:\n      supportsPromptCacheKey: true\n", "") == old
PY
ls "$WORK/f/home/.omp/agent"/models.yml.agent-memory-backup-* >/dev/null 2>&1 && ok "O3 backup of models.yml made" || bad "O3 no backup"
log_since "$M" | grep -q "\[hook-report\] session=$SIDF agent=pi event=Install" && ok "O3 report of the given session stored" || bad "O3 no report"
cp "$MF" "$WORK/f/after1.yml"
(cd "$WORK/f/proj" && env $(omp_env f) bash "$INSTALL" --client omp </dev/null >/dev/null 2>&1)
cmp -s "$MF" "$WORK/f/after1.yml" && [[ "$(ls "$WORK/f/home/.omp/agent"/models.yml.agent-memory-backup-* | wc -l)" -eq 1 ]] \
  && ok "O3 second run changes nothing and makes no new backup" || bad "O3 second run changed the file"

echo "== O4: installer without a proxy provider"
mkdir -p "$WORK/g/home/.omp/agent"
printf 'providers:\n  other:\n    baseUrl: https://api.example.com/v1\n    apiKey: X\n' > "$WORK/g/home/.omp/agent/models.yml"
OUT="$(env HOME="$WORK/g/home" PI_CODING_AGENT_DIR="$WORK/g/home/.omp/agent" bash "$INSTALL" --client omp --session "$SIDF" </dev/null 2>&1)"
RC=$?
if [[ $RC -ne 0 && "$OUT" == *"models.yml"* && "$OUT" == *"supportsPromptCacheKey"* ]]; then
  ok "O4 installer stops and explains what to add"
else
  bad "O4 rc=$RC output: ${OUT:0:300}"
fi
[[ ! -e "$WORK/g/home/.omp/agent/extensions/agent-memory.ts" ]] && ok "O4 nothing installed" || bad "O4 extension was installed"

cd "$REAL_HOME" || true
echo "== $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
