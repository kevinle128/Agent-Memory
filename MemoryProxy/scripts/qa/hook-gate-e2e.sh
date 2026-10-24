#!/usr/bin/env bash
# hook-gate-e2e.sh: end-to-end check of the mandatory project hook gate with a
# real Claude Code client and the local proxy.
#
# Prerequisites: the local stack from docs/local-development.md is running
# (Core on :8420, proxy on :8096 with hookGate.enabled), and `claude` and `tmux`
# are on PATH.
#
# Usage:
#   USER_KEY_FILE=~/.cache/am-e2e/user_key MemoryProxy/scripts/qa/hook-gate-e2e.sh
#
# The script uses temporary HOME directories, so it never touches the real
# ~/.claude/settings.json or ~/.agent-memory. It reads the user key from a file
# and never prints it. It removes the temporary directories and the tmux
# sessions it starts when it ends.
#
# Checks:
#   H1  `claude -p` without the hook is not gated and gets an answer
#   H2  an interactive session without the hook shows the install form; "Install
#       now" installs the hook in the temporary HOME and the original prompt is
#       answered
#   H3  the next session of the same HOME is not asked again
#   H4  "Exit" blocks the session, also for a second prompt
#   H5  an Agent SDK session without the hook is answered (not gated, no loop);
#       skipped when @anthropic-ai/claude-agent-sdk is not found (set SDK_DIR)

set -uo pipefail

PROXY="${PROXY:-http://127.0.0.1:8096}"
SPACE="${SPACE:-default}"
USER_KEY_FILE="${USER_KEY_FILE:-$HOME/.cache/am-e2e/user_key}"
QUESTION="What is 17 plus 25? Reply with only the number."
TMUX_PREFIX="am-hook-gate-$$"

[[ -r "$USER_KEY_FILE" ]] || { echo "FAIL: user key file $USER_KEY_FILE is not readable"; exit 1; }
command -v claude >/dev/null || { echo "FAIL: claude is not on PATH"; exit 1; }
command -v tmux >/dev/null || { echo "FAIL: tmux is not on PATH"; exit 1; }
curl -fsS "$PROXY/health" >/dev/null || { echo "FAIL: proxy $PROXY is not healthy"; exit 1; }

REAL_HOME="$HOME"
WORK="$(mktemp -d /tmp/am-hook-gate.XXXXXX)"
cleanup() {
  tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "^$TMUX_PREFIX" | while read -r s; do tmux kill-session -t "$s" 2>/dev/null; done
  rm -rf "$WORK"
}
trap cleanup EXIT

# Nested Claude Code variables would make the client report as a child session.
CLEAN_ENV=()
while IFS= read -r name; do CLEAN_ENV+=(-u "$name"); done < <(env | grep -E '^(CLAUDE|ANTHROPIC)' | sed 's/=.*//')
CLEAN_ENV+=(DISABLE_AUTOUPDATER=1)

# make_home NAME: a HOME with proxy settings, no hook, and a pre-trusted project
# folder. The client runs with --permission-mode default: auto mode would let
# its classifier block the installer command.
make_home() {
  local home="$WORK/$1/home" proj="$WORK/$1/proj"
  mkdir -p "$home/.claude" "$proj"
  proj="$(cd "$proj" && pwd -P)"
  python3 - "$USER_KEY_FILE" "$PROXY/claude-code/$SPACE" "$home" "$proj" <<'PY'
import json, sys
key = open(sys.argv[1]).read().strip()
home, proj = sys.argv[3], sys.argv[4]
json.dump({"env": {"ANTHROPIC_BASE_URL": sys.argv[2], "ANTHROPIC_AUTH_TOKEN": key}},
          open(home + "/.claude/settings.json", "w"))
json.dump({"hasCompletedOnboarding": True, "projects": {proj: {"hasTrustDialogAccepted": True}}},
          open(home + "/.claude.json", "w"))
PY
}

pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }

# pane NAME: current screen of a tmux session.
pane() { tmux capture-pane -t "$1" -p 2>/dev/null; }

# wait_pane NAME REGEX SECONDS: wait until the screen matches REGEX.
wait_pane() {
  local name="$1" re="$2" secs="$3" i
  for ((i = 0; i < secs * 2; i++)); do
    pane "$name" | grep -Eq "$re" && return 0
    sleep 0.5
  done
  return 1
}

# start_session NAME HOME_NAME: an interactive Claude Code in the project folder.
start_session() {
  local name="$TMUX_PREFIX-$1" h="$WORK/$2"
  tmux new-session -d -s "$name" -x 160 -y 50 -c "$h/proj" \
    "env ${CLEAN_ENV[*]} HOME=$h/home claude --permission-mode default" || return 1
  wait_pane "$name" 'manual mode on' 30
}

# send_prompt NAME: type the prompt, wait until the screen shows it, then press
# Enter. Typing into a screen that is not ready loses the text.
send_prompt() {
  local name="$1" i
  sleep 1
  for i in 1 2 3; do
    tmux send-keys -t "$name" -l "$QUESTION"
    wait_pane "$name" '17 plus 25' 5 && break
    tmux send-keys -t "$name" C-u
  done
  sleep 0.5
  tmux send-keys -t "$name" Enter
}

# answered NAME: the screen shows the model answer 42 on its own line.
answered() { pane "$1" | grep -Eq '^[[:space:]]*[⏺●][[:space:]]*42[[:space:]]*$'; }

echo "== H1: claude -p without the hook"
make_home a
OUT="$(cd "$WORK/a/proj" && env "${CLEAN_ENV[@]}" HOME="$WORK/a/home" timeout 120 claude -p --permission-mode default "$QUESTION" 2>&1)"
if [[ "$OUT" == *42* && "$OUT" != *"hook gate"* ]]; then
  ok "H1 headless run answered without the gate"
else
  bad "H1 headless output: ${OUT:0:300}"
fi
[[ ! -e "$WORK/a/home/.agent-memory/hook.sh" ]] && ok "H1 headless run did not install the hook" || bad "H1 hook was installed"

echo "== H2: interactive, Install now"
S="$TMUX_PREFIX-s1"
start_session s1 a || bad "H2 session did not start"
send_prompt "$S"
if wait_pane "$S" 'Install now' 40; then
  ok "H2 install form shown"
  tmux send-keys -t "$S" Enter
  # Claude Code asks to approve the installer command.
  if wait_pane "$S" 'Do you want to proceed|Yes' 60; then
    tmux send-keys -t "$S" Enter
  else
    bad "H2 no approval prompt for the installer command"
  fi
  if wait_pane "$S" '^[[:space:]]*[⏺●][[:space:]]*42[[:space:]]*$' 90; then
    ok "H2 original prompt answered after the install"
  else
    bad "H2 no answer after install; screen:"; pane "$S" | grep -v '^[[:space:]]*$' | tail -15
  fi
else
  bad "H2 install form not shown; screen:"; pane "$S" | grep -v '^[[:space:]]*$' | tail -15
fi
[[ -x "$WORK/a/home/.agent-memory/hook.sh" ]] && ok "H2 hook.sh installed" || bad "H2 hook.sh missing"
grep -q 'agent-memory/hook.sh' "$WORK/a/home/.claude/settings.json" 2>/dev/null \
  && ok "H2 settings.json has the hook" || bad "H2 settings.json has no hook"
tmux kill-session -t "$S" 2>/dev/null

echo "== H3: next session is not asked again"
S="$TMUX_PREFIX-s2"
start_session s2 a || bad "H3 session did not start"
send_prompt "$S"
if wait_pane "$S" '^[[:space:]]*[⏺●][[:space:]]*42[[:space:]]*$' 90; then
  pane "$S" | grep -q 'Install now' && bad "H3 form shown again" || ok "H3 answered without the form"
else
  bad "H3 no answer; screen:"; pane "$S" | grep -v '^[[:space:]]*$' | tail -15
fi
tmux kill-session -t "$S" 2>/dev/null

echo "== H4: Exit blocks"
make_home b
S="$TMUX_PREFIX-s3"
start_session s3 b || bad "H4 session did not start"
send_prompt "$S"
if wait_pane "$S" 'Install now' 40; then
  sleep 1
  tmux send-keys -t "$S" Down
  sleep 0.5
  tmux send-keys -t "$S" Enter
  if wait_pane "$S" 'does not send requests to the model' 40; then
    ok "H4 Exit gives the fixed answer"
  else
    bad "H4 no fixed answer; screen:"; pane "$S" | grep -v '^[[:space:]]*$' | tail -15
  fi
  # A second prompt gets the same fixed answer and no model answer.
  wait_pane "$S" 'manual mode on' 20
  send_prompt "$S"
  for _ in $(seq 1 40); do
    [[ "$(pane "$S" | grep -c 'does not send requests to the model')" -ge 2 ]] && break
    sleep 0.5
  done
  if [[ "$(pane "$S" | grep -c 'does not send requests to the model')" -ge 2 ]] && ! answered "$S"; then
    ok "H4 second prompt blocked too"
  else
    bad "H4 second prompt was not blocked; screen:"; pane "$S" | grep -v '^[[:space:]]*$' | tail -15
  fi
else
  bad "H4 install form not shown; screen:"; pane "$S" | grep -v '^[[:space:]]*$' | tail -15
fi
[[ ! -e "$WORK/b/home/.agent-memory/hook.sh" ]] && ok "H4 hook not installed after Exit" || bad "H4 hook was installed"
tmux kill-session -t "$S" 2>/dev/null

echo "== H5: Agent SDK session without the hook"
SDK_DIR="${SDK_DIR:-}"
if [[ -z "$SDK_DIR" ]]; then
  for d in "$REAL_HOME"/.claude/skills/*/node_modules/@anthropic-ai/claude-agent-sdk "$REAL_HOME"/.dsh/profiles/*/node_modules/@anthropic-ai/claude-agent-sdk; do
    [[ -f "$d/sdk.mjs" ]] && { SDK_DIR="$d"; break; }
  done
fi
if [[ -z "$SDK_DIR" || ! -f "$SDK_DIR/sdk.mjs" ]]; then
  echo "SKIP H5 no @anthropic-ai/claude-agent-sdk found"
else
  make_home c
  cat > "$WORK/sdk-run.mjs" <<JS
import { readFileSync } from "node:fs";
import { query } from "$SDK_DIR/sdk.mjs";
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k)));
const settings = JSON.parse(readFileSync("$WORK/c/home/.claude/settings.json", "utf8"));
Object.assign(env, settings.env, { HOME: "$WORK/c/home", DISABLE_AUTOUPDATER: "1" });
let out = "";
for await (const m of query({ prompt: "$QUESTION", options: { cwd: "$WORK/c/proj", maxTurns: 4, env } })) {
  if (m.type === "result") out = String(m.result ?? m.subtype);
}
console.log("RESULT:" + out);
JS
  SDK_OUT="$(timeout 150 node "$WORK/sdk-run.mjs" 2>&1 | grep '^RESULT:' | head -1)"
  if [[ "$SDK_OUT" == *42* ]]; then
    ok "H5 SDK session answered without the gate"
  else
    bad "H5 SDK result: ${SDK_OUT:-none}"
  fi
  [[ ! -e "$WORK/c/home/.agent-memory/hook.sh" ]] && ok "H5 SDK session did not install the hook" || bad "H5 hook was installed"
fi

cd "$REAL_HOME" || true
echo "== $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
