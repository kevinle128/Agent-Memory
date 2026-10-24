#!/usr/bin/env bash
# persona-scope-judge-e2e.sh: end-to-end check of the LLM call log and the persona
# scope judge against a real local Core, with a local OpenAI-compatible stub as the LLM.
#
# The script starts the stub, restarts the local Core so that it uses the stub and a
# throw-away data directory, then drives
#   - an L1 extraction (POST /capture + POST /session/end), the stage that stands for
#     "any other stage", for each error kind,
#   - the persona scope judge through POST /v3/persona/regenerate (the real L3 runner,
#     generator and judge runner), for each error kind, a pass and a leaks verdict,
# and reads POST /v3/llm-call/list and POST /v3/llm-call/stats.
# On exit it stops the stub and restarts the Core with its normal settings.
#
# Usage:
#   MemoryCore/scripts/qa/persona-scope-judge-e2e.sh
#   RUN_TIMEOUT_CASE=1 MemoryCore/scripts/qa/persona-scope-judge-e2e.sh   # adds a 60 s judge timeout
#
# Only the sqlite store is driven here: the script seeds the agent profile as files in
# the data directory, and the mongodb mode keeps profiles in rows. The mongodb table is
# covered by the store contract test (MONGO_TEST_URI).
#
# TOKEN_FILE holds the Core service token. It is read from the file and never printed.
#
# Checks:
#   L1.<kind>  a failing L1 extraction leaves a row with stage l1-extraction and that error kind
#   J.<kind>   a failing judge call leaves a row with stage persona-scope-check, that kind and
#              status; the previous persona is kept byte for byte, no rejected marker, no retry
#              request, exactly one judge call
#   J.pass / J.leaks   judge successes are stored (outcome ok) with the verdict
#   S1  stats group by error_kind, http_status, provider_error_code, stage, outcome, day
#   S2  a service id of another instance sees no rows
#   S3  a request without a bearer token is refused with 401
#   R1  a stored record older than the retention is deleted by the first recorded call
#   W1  with TDAI_LLM_CALL_LOG_ENABLED=false, failing L1 and judge calls add no rows and the
#       list API still answers

set -uo pipefail

CORE="${CORE:-http://127.0.0.1:8420}"
STORE=sqlite
TOKEN_FILE="${TOKEN_FILE:-$HOME/.cache/am-e2e/service_token}"
RESTART="${RESTART:-$HOME/.cache/am-e2e/core-restart.sh}"
STUB_PORT="${STUB_PORT:-18999}"
SUFFIX="$(date +%s)"
TEAM="${TEAM:-e2e-team-$SUFFIX}"
AGENT="${AGENT:-e2e-agent-$SUFFIX}"
USER_ID="${USER_ID:-e2e-user-$SUFFIX}"

[[ -r "$TOKEN_FILE" ]] || { echo "FAIL: token file $TOKEN_FILE is not readable"; exit 1; }
[[ -r "$RESTART" ]] || { echo "FAIL: restart helper $RESTART not found"; exit 1; }
command -v python3 >/dev/null || { echo "FAIL: python3 is required"; exit 1; }
if lsof -nP -iTCP:"$STUB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "FAIL: port $STUB_PORT is in use; stop its owner or set STUB_PORT"; exit 1
fi
TOKEN="$(cat "$TOKEN_FILE")"

WORK="$(mktemp -d)"
DATA="$WORK/data"
JUDGE_MODE="$WORK/judge-mode"
L1_MODE="$WORK/l1-mode"
CALL_LOG="$WORK/calls.log"
mkdir -p "$DATA"
: > "$CALL_LOG"
echo pass > "$JUDGE_MODE"
echo pass > "$L1_MODE"

STUB_PID=""
cleanup() {
  if [[ -n "$STUB_PID" ]]; then kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; fi
  if [[ "${KEEP_CORE:-0}" != "1" ]]; then
    echo "-- restoring the Core with its normal settings"
    bash "$RESTART" "$STORE" >/dev/null 2>&1 || echo "WARN: Core did not restart; run: bash $RESTART $STORE"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }

# ── stub LLM ────────────────────────────────────────────────
# A request whose system prompt starts with "You check a user profile" is the scope judge;
# a request that carries tools is the persona generation; any other request is an L1
# extraction. The judge and the L1 calls each read their own mode file. A mode is a
# failure kind (below), "pass", "garbage" (not JSON), "empty", "leaks" (judge only),
# "flaky" (one failure, then pass) or "hang-once".
#   rate429       429, Retry-After: 2, OpenAI body rate_limit_exceeded
#   quota429      429, OpenAI body insufficient_quota
#   overloaded529 529, Anthropic-style overloaded_error
#   unavailable503 503, "The server is overloaded"
#   server500     500
#   ctx400        400, context_length_exceeded
#   auth401       401
#   bad400        400, unsupported parameter
#   drop          the connection is closed without a response
#   refuse        the connection is closed and the stub stops listening for 12 s
cat > "$WORK/stub.py" <<'PY'
import json, sys, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

judge_mode_file, l1_mode_file, call_log, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
lock = threading.Lock()
revision = [0]
state = {"httpd": None, "restart": False}

def read_mode(path):
    with open(path) as f:
        return f.read().strip()

def set_mode(path, value):
    with open(path, "w") as f:
        f.write(value)

def log(kind):
    with open(call_log, "a") as f:
        f.write(kind + "\n")

def completion(message, finish):
    return {"id": "stub", "object": "chat.completion", "created": int(time.time()), "model": "stub-model",
            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}

ERRORS = {
    "rate429": (429, {"Retry-After": "2"}, {"error": {"message": "Rate limit reached for stub-model on requests per min (RPM): Limit 3, Used 3.", "type": "requests", "param": None, "code": "rate_limit_exceeded"}}),
    "quota429": (429, {}, {"error": {"message": "You exceeded your current quota, please check your plan and billing details.", "type": "insufficient_quota", "param": None, "code": "insufficient_quota"}}),
    "overloaded529": (529, {}, {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
    "unavailable503": (503, {}, {"error": {"message": "The server is overloaded or not ready yet.", "type": "server_error", "param": None, "code": None}}),
    "server500": (500, {}, {"error": {"message": "The server had an error while processing your request", "type": "server_error", "param": None, "code": None}}),
    "ctx400": (400, {}, {"error": {"message": "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.", "type": "invalid_request_error", "param": "messages", "code": "context_length_exceeded"}}),
    "auth401": (401, {}, {"error": {"message": "Incorrect API key provided: sk-stub-abcdefghijklmnop1234.", "type": "invalid_request_error", "param": None, "code": "invalid_api_key"}}),
    "bad400": (400, {}, {"error": {"message": "Unsupported parameter: 'foo'", "type": "invalid_request_error", "param": "foo", "code": None}}),
}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, status, body, headers=None):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        messages = req.get("messages", [])
        system = next((m.get("content", "") for m in messages if m.get("role") == "system"), "")
        if isinstance(system, list):
            system = "".join(p.get("text", "") for p in system)
        if system.startswith("You check a user profile"):
            return self.respond("judge", judge_mode_file, lambda eff: self.judge_ok(eff))
        if req.get("tools"):
            return self.generate(messages)
        return self.respond("l1", l1_mode_file, lambda eff: self.l1_ok(eff))

    def respond(self, target, mode_file, ok):
        with lock:
            mode = read_mode(mode_file)
            if mode == "flaky":
                set_mode(mode_file, "pass")
                effective = "server500"
            elif mode == "hang-once":
                set_mode(mode_file, "pass")
                effective = "hang"
            else:
                effective = mode
        log("%s:%s" % (target, effective))
        if effective in ERRORS:
            status, headers, body = ERRORS[effective]
            return self.send(status, body, headers)
        if effective == "drop":
            self.connection.close()
            return
        if effective == "refuse":
            state["restart"] = True
            threading.Thread(target=state["httpd"].shutdown, daemon=True).start()
            self.connection.close()
            return
        if effective == "hang":
            time.sleep(75)
            effective = "pass"
        return ok(effective)

    def judge_ok(self, effective):
        if effective == "garbage":
            text = "I am unable to answer in JSON."
        elif effective == "empty":
            text = ""
        elif effective == "leaks":
            text = json.dumps({"leaks": ["evidence"]})
        else:
            text = json.dumps({"leaks": []})
        return self.send(200, completion({"role": "assistant", "content": text}, "stop"))

    def l1_ok(self, effective):
        text = "" if effective == "empty" else ("not json" if effective == "garbage" else json.dumps({"memories": []}))
        return self.send(200, completion({"role": "assistant", "content": text}, "stop"))

    def generate(self, messages):
        log("generate")
        if any(m.get("role") == "tool" for m in messages):
            return self.send(200, completion({"role": "assistant", "content": "done"}, "stop"))
        with lock:
            revision[0] += 1
            rev = revision[0]
        content = "# User Narrative Profile\n\n- Prefers evidence before conclusions.\n- Revision %d." % rev
        call = {"id": "call_%d" % rev, "type": "function",
                "function": {"name": "write", "arguments": json.dumps({"path": "persona.md", "content": content})}}
        return self.send(200, completion({"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls"))

while True:
    state["restart"] = False
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    state["httpd"] = httpd
    httpd.serve_forever()
    httpd.server_close()
    if not state["restart"]:
        break
    time.sleep(12)
PY
python3 "$WORK/stub.py" "$JUDGE_MODE" "$L1_MODE" "$CALL_LOG" "$STUB_PORT" >"$WORK/stub.log" 2>&1 &
STUB_PID=$!
wait_stub() { for _ in $(seq 1 80); do lsof -nP -iTCP:"$STUB_PORT" -sTCP:LISTEN >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }
wait_stub || { echo "FAIL: stub did not start"; cat "$WORK/stub.log"; exit 1; }

# ── helpers ─────────────────────────────────────────────────
call() { # $1 path, $2 body
  curl -sS -m "${CALL_TIMEOUT:-300}" -X POST "$CORE$1" \
    -H "authorization: Bearer $TOKEN" -H "x-tdai-service-id: ${SERVICE_ID:-default}" \
    -H 'content-type: application/json' -d "$2"
}
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
set_judge() { printf '%s' "$1" > "$JUDGE_MODE"; }
set_l1() { printf '%s' "$1" > "$L1_MODE"; }
start_core() { # $@ extra env assignments
  env TDAI_DATA_DIR="$DATA" TDAI_LLM_BASE_URL="http://127.0.0.1:$STUB_PORT/v1" TDAI_LLM_API_KEY="stub-key" \
      TDAI_LLM_MODEL="stub-model" TDAI_LLM_TIMEOUT_MS=8000 "$@" \
      bash "$RESTART" "$STORE" >/dev/null
}
rows_where() { # $1 JSON filter body -> prints JSON items
  call /v3/llm-call/list "$1" | jget 'json.dumps(d["data"]["items"])'
}

# ── seed one agent: an accepted persona, one scene, a checkpoint ─
SCOPE="team:$TEAM|agent:$AGENT"
ENC="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$SCOPE")"
SCOPE_DIR="$DATA/profiles/$ENC"
PERSONA="$SCOPE_DIR/persona.md"
MARKER_OK='<!-- agent-memory:scope=user-global v1 -->'
MARKER_REJECTED='<!-- agent-memory:scope=user-global-rejected v1 -->'
PREV="$MARKER_OK
# Previous accepted persona

- Prefers small, reversible changes."
mkdir -p "$SCOPE_DIR/scene_blocks" "$SCOPE_DIR/.metadata"
printf -- '-----META-START-----\nsummary: working habits\n-----META-END-----\nPrefers small changes and evidence.\n' > "$SCOPE_DIR/scene_blocks/habits.md"
cat > "$SCOPE_DIR/.metadata/scene_index.json" <<JSON
[{"filename":"habits.md","summary":"working habits","heat":1,"created":"2026-10-01T00:00:00Z","updated":"2026-10-01T00:00:00Z"}]
JSON
reset_persona() { printf '%s' "$PREV" > "$PERSONA"; echo '{"scenes_processed":1,"memories_since_last_persona":0}' > "$SCOPE_DIR/.metadata/checkpoint.json"; }
sha() { shasum -a 256 < "$1" | cut -d' ' -f1; }
reset_persona
body="{\"team_id\":\"$TEAM\",\"agent_id\":\"$AGENT\",\"user_id\":\"$USER_ID\",\"reason\":\"e2e\",\"timeout_ms\":${REGEN_WAIT_MS:-200000}}"
regen() { call /v3/persona/regenerate "$body"; }

# A record that is older than the retention, written straight into the database before the
# Core runs, to see that the first recorded call removes it (R1).
echo "-- starting the Core ($STORE) with the stub as its LLM"
start_core || { echo "FAIL: Core did not start"; exit 1; }
PROBE="$(call /v3/llm-call/list '{"limit":1}' | jget 'd["code"]')"
[[ "$PROBE" == "0" ]] || { echo "FAIL: the Core on $CORE does not serve the LLM call routes (code=$PROBE); stop it and rerun"; exit 1; }

python3 - "$DATA/vectors.db" <<'PY'
import sqlite3, sys, time
db = sqlite3.connect(sys.argv[1])
old = int((time.time() - 40 * 86400) * 1000)
cols = [r[1] for r in db.execute("PRAGMA table_info(llm_calls)")]
row = {"id": "llmc_e2e_old", "instance_id": "default", "created_at_ms": old, "finished_at_ms": old + 1, "latency_ms": 1,
       "stage": "e2e-old", "outcome": "error", "error_kind": "timeout", "generation_id": "e2e_old"}
db.execute("INSERT INTO llm_calls (%s) VALUES (%s)" % (",".join(row), ",".join("?" * len(row))), list(row.values()))
db.commit()
PY
OLD_BEFORE="$(call /v3/llm-call/list '{"generation_id":"e2e_old"}' | jget 'len(d["data"]["items"])')"

# ── L1: each error kind on an L1 extraction ─────────────────
L1_KINDS="${L1_KINDS:-rate429:rate_limit:429 quota429:quota_exhausted:429 overloaded529:overloaded:529 unavailable503:overloaded:503 server500:server_error:500 ctx400:context_too_long:400 auth401:auth:401 bad400:bad_request:400 drop:network:0 refuse:network:0}"
SESS=0
trigger_l1() { # one capture and a session end: the session end flushes the L1 extraction
  SESS=$((SESS + 1))
  curl -sS -m 30 -X POST "$CORE/capture" -H 'content-type: application/json' \
    -d "{\"user_content\":\"e2e message $SESS about working habits\",\"assistant_content\":\"noted $SESS\",\"session_key\":\"e2e-l1-$SUFFIX-$SESS\",\"session_id\":\"e2e-l1-$SUFFIX-$SESS\"}" >/dev/null
  curl -sS -m 30 -X POST "$CORE/session/end" -H 'content-type: application/json' -d "{\"session_key\":\"e2e-l1-$SUFFIX-$SESS\"}" >/dev/null
}
l1_case() { # $1 mode, $2 expected kind, $3 expected status
  set_l1 "$1"
  local found="" since; since="$(python3 -c 'import datetime; print((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
  # The L1 queue can be busy with an earlier case; ask again every 50 s, at most three times.
  for round in 1 2 3; do
    trigger_l1
    for _ in $(seq 1 50); do
      found="$(call /v3/llm-call/list "{\"stage\":\"l1-extraction\",\"error_kind\":\"$2\",\"start_time\":\"$since\",\"limit\":200}" \
        | jget "len([i for i in d['data']['items'] if i['http_status'] == $3 and i['outcome'] == 'error' and i['model']])")"
      [[ "$found" =~ ^[0-9]+$ && "$found" -ge 1 ]] && break 2
      sleep 1
    done
  done
  set_l1 pass
  wait_stub   # the refuse case stops the stub for 12 s
  if [[ "$found" =~ ^[0-9]+$ && "$found" -ge 1 ]]; then ok "L1.$2 ($1): row with stage l1-extraction, http_status $3"
  else bad "L1.$2 ($1): no row ($(rows_where '{"stage":"l1-extraction","limit":3}' | head -c 400))"; fi
  sleep 3
}
sleep 5   # the Core has just started
for spec in $L1_KINDS; do IFS=: read -r mode kind status <<<"$spec"; l1_case "$mode" "$kind" "$status"; done
# An L1 timeout is not driven here: the L1 call has a fixed 180 s deadline. The judge timeout
# (60 s) is driven with RUN_TIMEOUT_CASE=1; the timeout kind is unit tested for the wrapper.

R1="$(call /v3/llm-call/list '{"generation_id":"e2e_old"}' | jget 'len(d["data"]["items"])')"
[[ "$OLD_BEFORE" == "1" && "$R1" == "0" ]] && ok "R1: the record older than the retention was deleted by the first recorded call" || bad "R1 before=$OLD_BEFORE after=$R1"

# ── judge: each error kind through the regenerate route ─────
J_KINDS="${J_KINDS:-rate429:rate_limit:429 quota429:quota_exhausted:429 overloaded529:overloaded:529 unavailable503:overloaded:503 server500:server_error:500 ctx400:context_too_long:400 auth401:auth:401 bad400:bad_request:400 drop:network:0 refuse:network:0 garbage:unparseable:0 empty:empty_reply:0}"
judge_case() { # $1 mode, $2 kind, $3 status
  reset_persona
  local before; before="$(sha "$PERSONA")"
  set_judge "$1"
  local R GEN; R="$(regen)"; GEN="$(echo "$R" | jget 'd["data"]["generation_id"]')"
  set_judge pass
  local rows; rows="$(rows_where "{\"generation_id\":\"$GEN\",\"limit\":50}")"
  local flag; flag="$(python3 -c "import json; print(json.load(open('$SCOPE_DIR/.metadata/checkpoint.json')).get('request_persona_update'))")"
  local check; check="$(echo "$rows" | python3 -c "
import json,sys
r=json.load(sys.stdin)
print(len(r), r[0]['stage'] if r else '', r[0]['outcome'] if r else '', r[0]['error_kind'] if r else '', r[0]['http_status'] if r else '')")"
  if [[ "$(echo "$R" | jget 'd["data"]["outcome"]')" == "technical_failure" && "$(sha "$PERSONA")" == "$before" \
        && "$(head -n1 "$PERSONA")" == "$MARKER_OK" && "$flag" != "True" && "$check" == "1 persona-scope-check error $2 $3" ]]; then
    ok "J.$2 ($1): one row ($check), previous persona kept byte for byte, no rejected marker, no retry request"
  else bad "J.$2 ($1) outcome=$(echo "$R" | jget 'd["data"]["outcome"]') error=$(echo "$R" | jget 'd["data"].get("error_message")') rows=$check flag=$flag"; tail -n 6 "$CALL_LOG" | tr '\n' ' '; echo; grep -a "ERROR" "$HOME/.cache/am-e2e/logs/core-$STORE.log" | tail -n 4 | cut -c1-500; fi
  sleep 14   # the refuse case needs the stub back before the next case
  wait_stub
}
for spec in $J_KINDS; do IFS=: read -r mode kind status <<<"$spec"; judge_case "$mode" "$kind" "$status"; done

if [[ "${RUN_TIMEOUT_CASE:-0}" == "1" ]]; then
  reset_persona; set_judge hang-once
  R="$(REGEN_WAIT_MS=300000 CALL_TIMEOUT=400 regen)"; GEN="$(echo "$R" | jget 'd["data"]["generation_id"]')"
  K="$(rows_where "{\"generation_id\":\"$GEN\"}" | python3 -c "import json,sys; r=json.load(sys.stdin); print(len(r), r[0]['error_kind'], r[0]['timeout_ms'])")"
  [[ "$K" == "1 timeout 60000" ]] && ok "J.timeout: one row, error_kind timeout, deadline 60000 ms" || bad "J.timeout rows=$K"
  set_judge pass
else
  echo "SKIP J.timeout (set RUN_TIMEOUT_CASE=1; it waits about 80 s)"
fi

# judge successes
reset_persona; set_judge pass
R="$(regen)"; GEN="$(echo "$R" | jget 'd["data"]["generation_id"]')"
V="$(rows_where "{\"generation_id\":\"$GEN\"}" | python3 -c "import json,sys; r=json.load(sys.stdin); print(len(r), r[0]['outcome'], json.loads(r[0]['verdict'])['outcome'], r[0]['error_kind'] == '', r[0]['reply'])")"
if [[ "$(echo "$R" | jget 'd["data"]["outcome"]')" == "pass" && "$(head -n1 "$PERSONA")" == "$MARKER_OK" && "$V" == '1 ok pass True {"leaks": []}' ]]; then
  ok "J.pass: accepted marker, one ok row with verdict pass and the reply"
else bad "J.pass response=$R row=$V"; fi

reset_persona; set_judge leaks
R="$(regen)"; GEN="$(echo "$R" | jget 'd["data"]["generation_id"]')"
V="$(rows_where "{\"generation_id\":\"$GEN\"}" | python3 -c "import json,sys; r=json.load(sys.stdin); print(len(r), [x['outcome'] for x in r], [json.loads(x['verdict'])['outcome'] for x in r])")"
if [[ "$(echo "$R" | jget 'd["data"]["outcome"]')" == "leaks" && "$(head -n1 "$PERSONA")" == "$MARKER_REJECTED" && "$V" == "2 ['ok', 'ok'] ['leaks', 'leaks']" ]]; then
  ok "J.leaks: one regeneration, rejected marker, two ok rows with verdict leaks"
else bad "J.leaks response=$R rows=$V"; fi
set_judge pass

# ── stats ───────────────────────────────────────────────────
stats() { call /v3/llm-call/stats "$1"; }
KEYS() { stats "{\"group_by\":\"$1\"}" | jget '",".join(sorted(g["key"] for g in d["data"]["groups"]))'; }
EK="$(KEYS error_kind)"; HS="$(KEYS http_status)"; PC="$(KEYS provider_error_code)"; ST="$(KEYS stage)"; OC="$(KEYS outcome)"; DY="$(KEYS day)"
EXPECT_KINDS="auth,bad_request,context_too_long,empty_reply,network,none,overloaded,quota_exhausted,rate_limit,server_error,unparseable"
[[ "${RUN_TIMEOUT_CASE:-0}" == "1" ]] && EXPECT_KINDS="auth,bad_request,context_too_long,empty_reply,network,none,overloaded,quota_exhausted,rate_limit,server_error,timeout,unparseable"
if [[ "$EK" == "$EXPECT_KINDS" && "$HS" == *400* && "$HS" == *401* && "$HS" == *429* && "$HS" == *500* && "$HS" == *503* && "$HS" == *529* \
      && "$PC" == *context_length_exceeded* && "$PC" == *insufficient_quota* && "$PC" == *rate_limit_exceeded* \
      && "$ST" == "l1-extraction,persona-scope-check" && "$OC" == "error,ok" && "$DY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  ok "S1 stats group by error_kind, http_status, provider_error_code, stage, outcome, day"
else bad "S1 kinds=$EK status=$HS codes=$PC stages=$ST outcomes=$OC days=$DY"; fi
TOTAL="$(stats '{"group_by":"stage"}' | jget 'd["data"]["total"]')"
EX="$(stats '{"group_by":"error_kind"}' | jget 'd["data"]["groups"][0]["example_id"]')"
[[ "$TOTAL" -ge 20 && "$EX" == llmc_* ]] && ok "S1b total=$TOTAL, every group carries an example id ($EX)" || bad "S1b total=$TOTAL example=$EX"

RL="$(call /v3/llm-call/list '{"stage":"persona-scope-check","error_kind":"rate_limit"}' | jget '[(i["sdk_attempts"], i["retry_after_ms"], i["provider_error_type"], i["provider_error_code"]) for i in d["data"]["items"]][0]')"
[[ "$RL" == "(3, 2000, 'requests', 'rate_limit_exceeded')" ]] \
  && ok "S1c the rate_limit row carries the SDK attempt count (3), Retry-After (2000 ms) and the provider type and code" || bad "S1c $RL"

OTHER_TOTAL="$(SERVICE_ID=other-instance call /v3/llm-call/stats '{"group_by":"stage"}' | jget 'd["data"]["total"]')"
OTHER_ROWS="$(SERVICE_ID=other-instance call /v3/llm-call/list '{}' | jget 'len(d["data"]["items"])')"
[[ "$OTHER_TOTAL" == "0" && "$OTHER_ROWS" == "0" ]] && ok "S2 another service id sees no rows" || bad "S2 stats=$OTHER_TOTAL rows=$OTHER_ROWS"

CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$CORE/v3/llm-call/list" -H 'x-tdai-service-id: default' -H 'content-type: application/json' -d '{}')"
CODE2="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$CORE/v3/llm-call/stats" -H 'x-tdai-service-id: default' -H 'content-type: application/json' -d '{}')"
[[ "$CODE" == "401" && "$CODE2" == "401" ]] && ok "S3 requests without a bearer token are refused (401)" || bad "S3 list=$CODE stats=$CODE2"

# ── the switch ──────────────────────────────────────────────
TOTAL_ON="$(stats '{"group_by":"stage"}' | jget 'd["data"]["total"]')"
echo "-- restarting the Core with TDAI_LLM_CALL_LOG_ENABLED=false"
start_core TDAI_LLM_CALL_LOG_ENABLED=false || { echo "FAIL: Core did not restart"; exit 1; }
set_l1 server500
SESS=$((SESS + 1))
curl -sS -m 30 -X POST "$CORE/capture" -H 'content-type: application/json' \
  -d "{\"user_content\":\"e2e off $SESS\",\"assistant_content\":\"noted\",\"session_key\":\"e2e-off-$SUFFIX\",\"session_id\":\"e2e-off-$SUFFIX\"}" >/dev/null
curl -sS -m 30 -X POST "$CORE/session/end" -H 'content-type: application/json' -d "{\"session_key\":\"e2e-off-$SUFFIX\"}" >/dev/null
reset_persona; set_judge server500
R="$(regen)"
set_judge pass
sleep 20
set_l1 pass
TOTAL_OFF="$(stats '{"group_by":"stage"}' | jget 'd["data"]["total"]')"
if [[ "$(echo "$R" | jget 'd["data"]["outcome"]')" == "technical_failure" && "$TOTAL_OFF" == "$TOTAL_ON" && "$TOTAL_ON" -ge 20 ]]; then
  ok "W1 switch off: failing L1 and judge calls add no rows (total stays $TOTAL_ON), list and stats still answer, the judge still keeps the persona"
else bad "W1 on=$TOTAL_ON off=$TOTAL_OFF response=$R"; fi

echo "-- stub calls: $(sort "$CALL_LOG" | uniq -c | tr '\n' ' ')"
echo "== $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
