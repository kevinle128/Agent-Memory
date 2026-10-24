#!/usr/bin/env bash
# Agent-Memory hook installer.
#
# Usage:
#   curl -fsSL <proxy-origin>/setup/hooks.sh | bash -s -- \
#     [--base-url URL] [--client claude-code|codex|pi] [--session SID] [--uninstall]
#
# Install, claude-code (default):
#   1. Download <proxy-origin>/setup/hook.sh to ~/.agent-memory/hook.sh.
#   2. Create ~/.agent-memory/device.json when it is missing.
#   3. Add the hook to the SessionStart and UserPromptSubmit events in
#      ~/.claude/settings.json. A backup of the file is made first.
#   4. With --session SID: send one test report with this session id.
# Install, codex:
#   Steps 1 and 2 as above. Then add the hook to the SessionStart and
#   UserPromptSubmit events in $CODEX_HOME/config.toml (default ~/.codex), inside
#   a marked block, after a backup. The blocks sit before the first table of the
#   file, because Codex appends its own tables at the end. An exact copy of each
#   block is kept in ~/.agent-memory/codex-*.block. If a block no longer matches its
#   copy (other lines inside, a marker missing), install and uninstall stop with
#   exit 1 and change nothing. Codex runs a hook only after it is trusted, so
#   the installer asks `codex app-server` (hooks/list) for the key and hash that
#   Codex itself computes and stores them as [hooks.state."<key>"] trusted_hash.
#   Without the codex command, the hooks stay untrusted: run /hooks in Codex.
#   The proxy URL and key come from the active model provider of the Codex config.
# Install, pi:
#   Download <proxy-origin>/setup/pi-extension.ts to
#   $PI_CODING_AGENT_DIR/extensions/agent-memory.ts (default ~/.pi/agent). Set
#   compat.sendSessionAffinityHeaders = true on every provider of models.json whose
#   baseUrl is an Agent-Memory pi route, so pi sends its session id to the proxy.
# Uninstall:
#   Remove only our hook entries (and hook.sh when no other client uses it, or the
#   pi extension). Keep device.json. For pi, the compat flag stays: it may have
#   been set before and is harmless.
#
# The script is safe to run again: it never adds a second entry.
# Test override: AGENT_MEMORY_JSON_TOOL=jq|python3|node forces one JSON tool.
set -euo pipefail

CLAUDE_DIR="$HOME/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CODEX_CONFIG="$CODEX_DIR/config.toml"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PI_EXTENSION_FILE="$PI_DIR/extensions/agent-memory.ts"
PI_MODELS_FILE="$PI_DIR/models.json"
AM_DIR="$HOME/.agent-memory"
HOOK_FILE="$AM_DIR/hook.sh"
DEVICE_FILE="$AM_DIR/device.json"
TMP_FILE=""
BACKED_UP_FILE=""
LAST_BACKUP=""

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/am-install.XXXXXX")"

cleanup() {
  if [ -n "$TMP_FILE" ]; then rm -f "$TMP_FILE"; fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

fail() {
  echo "agent-memory install: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# JSON tool selection: jq, then python3, then node.
# ---------------------------------------------------------------------------

# On macOS /usr/bin/python3 is a stub that opens an install dialog when the
# command line tools are missing. Do not run it in that case.
tool_usable() {
  command -v "$1" >/dev/null 2>&1 || return 1
  if [ "$1" = "python3" ] && [ "$(command -v python3)" = "/usr/bin/python3" ] \
    && [ "$(uname -s)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

detect_json_tool() {
  local t
  if [ -n "${AGENT_MEMORY_JSON_TOOL:-}" ]; then
    JSON_TOOL="$AGENT_MEMORY_JSON_TOOL"
    return
  fi
  for t in jq python3 node; do
    if tool_usable "$t"; then
      JSON_TOOL="$t"
      return
    fi
  done
  fail "a JSON tool is required. Install one of: jq (brew install jq, apt install jq), python3, or node. Then run this command again."
}

# Read JSON on stdin. Print the string value found at the key path.
# $1 is a JSON array of keys, for example '["env","ANTHROPIC_BASE_URL"]'.
# Print nothing when the value is missing or is not a string.
json_get() {
  local path="$1"
  case "$JSON_TOOL" in
    jq)
      jq -r --argjson p "$path" 'getpath($p) | select(type == "string")' || true
      ;;
    python3)
      python3 -c 'import json, sys
try:
    v = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    for k in json.loads(sys.argv[1]):
        v = v[k]
    if isinstance(v, str):
        sys.stdout.buffer.write(v.encode("utf-8"))
except Exception:
    pass' "$path" || true
      ;;
    node)
      node -e 'let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { s += c; }).on("end", () => {
  try {
    let v = JSON.parse(s);
    for (const k of JSON.parse(process.argv[1])) v = v[k];
    if (typeof v === "string") process.stdout.write(v);
  } catch (e) { /* print nothing */ }
});' "$path" || true
      ;;
    *)
      fail "unknown JSON tool: $JSON_TOOL"
      ;;
  esac
}

# Print the JSON object {"session_id", "cwd", "hook_event_name"} for a test
# report. The values come from AM_SID and AM_CWD.
session_json() {
  case "$JSON_TOOL" in
    jq)
      jq -n -c '{session_id: env.AM_SID, cwd: env.AM_CWD, hook_event_name: "Install"}'
      ;;
    python3)
      python3 -c 'import json, os
print(json.dumps({"session_id": os.environ["AM_SID"], "cwd": os.environ["AM_CWD"],
                  "hook_event_name": "Install"}, separators=(",", ":")))'
      ;;
    node)
      node -e 'process.stdout.write(JSON.stringify({session_id: process.env.AM_SID,
  cwd: process.env.AM_CWD, hook_event_name: "Install"}));'
      ;;
  esac
}

# Edit the settings JSON. Read the file on stdin. $1 is "add" or "remove".
# Print the new document, or print nothing when the document does not change.
# Exit with a non-zero status when the document has an unexpected structure.
edit_settings() {
  local mode="$1"
  case "$JSON_TOOL" in
    jq)
      if [ "$mode" = "add" ]; then
        jq --arg cmd "$HOOK_CMD" '
          def isours: type == "object" and .command == $cmd;
          def ours: type == "object" and ((.hooks | type) == "array") and any(.hooks[]; isours);
          . as $orig
          | (reduce ("SessionStart", "UserPromptSubmit") as $e (.;
              if ((.hooks[$e] // []) | any(.[]; ours)) then .
              else .hooks = ((.hooks // {}) | .[$e] = ((.[$e] // []) + [{hooks: [{type: "command", command: $cmd, timeout: 5}]}]))
              end)) as $new
          | if $new == $orig then empty else $new end'
      else
        jq --arg cmd "$HOOK_CMD" '
          def isours: type == "object" and .command == $cmd;
          def ours: type == "object" and ((.hooks | type) == "array") and any(.hooks[]; isours);
          . as $orig
          | (reduce ("SessionStart", "UserPromptSubmit") as $e (.;
              if (((.hooks | type) == "object") and ((.hooks[$e] | type) == "array") and any(.hooks[$e][]; ours)) then
                .hooks[$e] |= [.[] | if ours then ((.hooks |= map(select(isours | not))) | select((.hooks | length) > 0)) else . end]
                | if (.hooks[$e] | length) == 0 then del(.hooks[$e]) else . end
                | if .hooks == {} then del(.hooks) else . end
              else . end)) as $new
          | if $new == $orig then empty else $new end'
      fi
      ;;
    python3)
      python3 -c '
import json, sys

cmd, mode = sys.argv[1], sys.argv[2]
EVENTS = ("SessionStart", "UserPromptSubmit")
raw = sys.stdin.buffer.read().decode("utf-8")
doc = json.loads(raw) if raw.strip() else {}
if not isinstance(doc, dict):
    sys.exit("settings.json root is not an object")
before = json.dumps(doc)

def is_ours(h):
    return isinstance(h, dict) and h.get("command") == cmd

def group_has(g):
    return isinstance(g, dict) and isinstance(g.get("hooks"), list) and any(is_ours(h) for h in g["hooks"])

hooks = doc.get("hooks")
if mode == "add":
    if hooks is None:
        hooks = doc["hooks"] = {}
    if not isinstance(hooks, dict):
        sys.exit("settings.json hooks is not an object")
    for ev in EVENTS:
        groups = hooks.get(ev)
        if groups is None:
            groups = hooks[ev] = []
        if not isinstance(groups, list):
            sys.exit("settings.json hooks." + ev + " is not an array")
        if not any(group_has(g) for g in groups):
            groups.append({"hooks": [{"type": "command", "command": cmd, "timeout": 5}]})
elif isinstance(hooks, dict):
    removed = False
    for ev in EVENTS:
        groups = hooks.get(ev)
        if not (isinstance(groups, list) and any(group_has(g) for g in groups)):
            continue
        removed = True
        kept = []
        for g in groups:
            if group_has(g):
                g["hooks"] = [h for h in g["hooks"] if not is_ours(h)]
                if not g["hooks"]:
                    continue
            kept.append(g)
        if kept:
            hooks[ev] = kept
        else:
            del hooks[ev]
    if removed and not hooks:
        del doc["hooks"]
if json.dumps(doc) != before:
    sys.stdout.buffer.write((json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
' "$HOOK_CMD" "$mode"
      ;;
    node)
      node -e '
const fs = require("fs");
const cmd = process.argv[1];
const mode = process.argv[2];
const EVENTS = ["SessionStart", "UserPromptSubmit"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const raw = fs.readFileSync(0, "utf8");
const doc = raw.trim() ? JSON.parse(raw) : {};
if (!isObj(doc)) { console.error("settings.json root is not an object"); process.exit(1); }
const before = JSON.stringify(doc);
const isOurs = (h) => isObj(h) && h.command === cmd;
const groupHas = (g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some(isOurs);

if (mode === "add") {
  if (doc.hooks === undefined || doc.hooks === null) doc.hooks = {};
  if (!isObj(doc.hooks)) { console.error("settings.json hooks is not an object"); process.exit(1); }
  for (const ev of EVENTS) {
    if (doc.hooks[ev] === undefined || doc.hooks[ev] === null) doc.hooks[ev] = [];
    if (!Array.isArray(doc.hooks[ev])) { console.error("settings.json hooks." + ev + " is not an array"); process.exit(1); }
    if (!doc.hooks[ev].some(groupHas)) {
      doc.hooks[ev].push({ hooks: [{ type: "command", command: cmd, timeout: 5 }] });
    }
  }
} else if (isObj(doc.hooks)) {
  let removed = false;
  for (const ev of EVENTS) {
    const groups = doc.hooks[ev];
    if (!Array.isArray(groups) || !groups.some(groupHas)) continue;
    removed = true;
    const kept = [];
    for (const g of groups) {
      if (groupHas(g)) {
        g.hooks = g.hooks.filter((h) => !isOurs(h));
        if (g.hooks.length === 0) continue;
      }
      kept.push(g);
    }
    if (kept.length > 0) doc.hooks[ev] = kept; else delete doc.hooks[ev];
  }
  if (removed && Object.keys(doc.hooks).length === 0) delete doc.hooks;
}
if (JSON.stringify(doc) !== before) process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
' "$HOOK_CMD" "$mode"
      ;;
    *)
      fail "unknown JSON tool: $JSON_TOOL"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Device id. Keep this block the same as the one in hook.sh.
# ---------------------------------------------------------------------------

new_uuid() {
  local u=""
  if command -v uuidgen >/dev/null 2>&1; then
    u=$(uuidgen)
  elif [ -r /proc/sys/kernel/random/uuid ]; then
    u=$(cat /proc/sys/kernel/random/uuid)
  elif tool_usable python3; then
    u=$(python3 -c 'import uuid; print(uuid.uuid4())')
  elif command -v node >/dev/null 2>&1; then
    u=$(node -e 'console.log(require("crypto").randomUUID())')
  fi
  printf '%s' "$u" | tr '[:upper:]' '[:lower:]'
}

read_device_id() {
  [ -f "$DEVICE_FILE" ] || return 0
  json_get '["device_id"]' < "$DEVICE_FILE"
}

# Print the device id. Create device.json when it is missing or has no id.
ensure_device_id() {
  local id new tmp
  id=$(read_device_id)
  if [ -n "$id" ]; then
    printf '%s' "$id"
    return
  fi
  new=$(new_uuid)
  [ -n "$new" ] || fail "cannot create a device id (no uuidgen, python3 or node)"
  mkdir -p "$AM_DIR"
  chmod 700 "$AM_DIR"
  tmp=$(mktemp "$AM_DIR/device.XXXXXX")
  chmod 600 "$tmp"
  printf '{"device_id": "%s", "created_at": "%s"}\n' "$new" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
  if [ -e "$DEVICE_FILE" ]; then
    # The file exists but has no usable id. Replace it.
    mv -f "$tmp" "$DEVICE_FILE"
  else
    # A hard link fails if another process created the file first.
    ln "$tmp" "$DEVICE_FILE" 2>/dev/null || true
    rm -f "$tmp"
  fi
  id=$(read_device_id)
  printf '%s' "${id:-$new}"
}

# ---------------------------------------------------------------------------
# settings.json
# ---------------------------------------------------------------------------

# Copy settings.json to a new backup file. Never overwrite an older backup.
backup_settings() {
  local ts dest n=0
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  dest="$SETTINGS_FILE.agent-memory-backup-$ts"
  while [ -e "$dest" ]; do
    n=$((n + 1))
    dest="$SETTINGS_FILE.agent-memory-backup-$ts-$n"
  done
  cp -p "$SETTINGS_FILE" "$dest"
}

# Apply edit_settings "$1" to settings.json. Write the file only on a change.
update_settings() {
  local mode="$1" new
  new=$(edit_settings "$mode" < "$SETTINGS_FILE") \
    || fail "cannot update $SETTINGS_FILE. Is it valid JSON? The file is not changed."
  if [ -n "$new" ]; then
    if [ "$SETTINGS_EXISTED" = "1" ]; then backup_settings; fi
    # Write in place: this keeps the file mode and any symbolic link.
    printf '%s\n' "$new" > "$SETTINGS_FILE"
  fi
}

# ---------------------------------------------------------------------------
# Download and backup helpers
# ---------------------------------------------------------------------------

# Download $1 (origin) + $2 (path) to $3 through a temp file. $4 is the first
# two bytes the file must have.
fetch_file() {
  local origin="$1" rpath="$2" dest="$3" magic="$4" tmp
  mkdir -p "$(dirname "$dest")"
  tmp=$(mktemp "$(dirname "$dest")/fetch.XXXXXX")
  TMP_FILE="$tmp"
  curl -fsSL --connect-timeout 5 --max-time 30 -o "$tmp" "$origin$rpath" \
    || fail "cannot download $origin$rpath"
  [ "$(head -c 2 "$tmp")" = "$magic" ] || fail "$origin$rpath has an unexpected content"
  chmod 755 "$tmp"
  mv -f "$tmp" "$dest"
  TMP_FILE=""
}

# Copy file $1 to a new backup file "$1.agent-memory-backup-<time>". Never
# overwrite an older backup.
backup_file() {
  local src="$1" ts dest n=0
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  dest="$src.agent-memory-backup-$ts"
  while [ -e "$dest" ]; do
    n=$((n + 1))
    dest="$src.agent-memory-backup-$ts-$n"
  done
  cp -p "$src" "$dest"
  LAST_BACKUP="$dest"
}

# Remove hook.sh when no client config refers to it any more.
remove_hook_file_if_unused() {
  if [ -f "$SETTINGS_FILE" ] && grep -qF "$HOOK_FILE" "$SETTINGS_FILE"; then return; fi
  if [ -f "$CODEX_CONFIG" ] && grep -qF "$HOOK_FILE" "$CODEX_CONFIG"; then return; fi
  rm -f "$HOOK_FILE"
}

# ---------------------------------------------------------------------------
# Codex: connection settings. Keep this block the same as the one in hook.sh.
# ---------------------------------------------------------------------------

# Print the name of the active model provider: the model_provider of the
# profile named by the top-level "profile" key, else the top-level
# model_provider. TOML single quotes become double quotes first.
codex_provider_name() {
  local profile name=""
  [ -f "$CODEX_CONFIG" ] || return 0
  profile=$(awk '/^[[:space:]]*\[/ { exit } /^[[:space:]]*profile[[:space:]]*=/ { print; exit }' "$CODEX_CONFIG" \
    | tr "'" '"' | sed -nE 's/^[^=]*=[[:space:]]*"([^"]*)".*/\1/p')
  if [ -n "$profile" ]; then
    name=$(awk -v p="$profile" '
      /^[[:space:]]*\[/ {
        h = $0
        gsub(/[[:space:]]/, "", h)
        sub(/#.*/, "", h)
        ins = (h == "[profiles." p "]" || h == "[profiles.\"" p "\"]")
        next
      }
      ins && /^[[:space:]]*model_provider[[:space:]]*=/ { print; exit }' "$CODEX_CONFIG" \
      | tr "'" '"' | sed -nE 's/^[^=]*=[[:space:]]*"([^"]*)".*/\1/p')
  fi
  if [ -z "$name" ]; then
    name=$(awk '/^[[:space:]]*\[/ { exit } /^[[:space:]]*model_provider[[:space:]]*=/ { print; exit }' "$CODEX_CONFIG" \
      | tr "'" '"' | sed -nE 's/^[^=]*=[[:space:]]*"([^"]*)".*/\1/p')
  fi
  printf '%s' "$name"
}

# Print the lines of the active provider table and of its http_headers and
# env_http_headers subtables. Each line has a tag: "M|" for the provider table,
# "H|" for http_headers and "E|" for env_http_headers.
codex_provider_lines() {
  local name
  name=$(codex_provider_name)
  [ -n "$name" ] || return 0
  awk -v p="$name" '
    /^[[:space:]]*\[/ {
      h = $0
      gsub(/[[:space:]]/, "", h)
      sub(/#.*/, "", h)
      m1 = "[model_providers." p
      m2 = "[model_providers.\"" p "\""
      tag = ""
      if (h == m1 "]" || h == m2 "]") tag = "M"
      else if (h == m1 ".http_headers]" || h == m2 ".http_headers]") tag = "H"
      else if (h == m1 ".env_http_headers]" || h == m2 ".env_http_headers]") tag = "E"
      next
    }
    tag != "" { print tag "|" $0 }' "$CODEX_CONFIG" | tr "'" '"'
}

# Print "<base_url>" on line 1, "<header-name>" on line 2 and "<token>" on line 3.
# The header name is "authorization" or "x-tdai-user-key". The order is the
# one the proxy uses to find the user key (extractApiKeyFromContext): the
# x-tdai-user-key header first (a literal value, then an environment variable
# named in env_http_headers), then the bearer token (experimental_bearer_token,
# then the env var named by env_key). Print nothing when the active provider
# has no base_url or no token.
codex_connection() {
  local section base token header var key_re
  section=$(codex_provider_lines)
  [ -n "$section" ] || return 0
  base=$(printf '%s\n' "$section" | sed -nE 's/^M\|[[:space:]]*base_url[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' | head -n 1)
  [ -n "$base" ] || return 0
  key_re='"?x-tdai-user-key"?[[:space:]]*=[[:space:]]*"([^"]*)"'
  header="x-tdai-user-key"
  token=$(printf '%s\n' "$section" | sed -nE "s/^H\\|[[:space:]]*$key_re.*/\\1/p" | head -n 1)
  [ -n "$token" ] || token=$(printf '%s\n' "$section" | sed -nE "s/^M\\|[[:space:]]*http_headers[[:space:]]*=.*$key_re.*/\\1/p" | head -n 1)
  if [ -z "$token" ]; then
    var=$(printf '%s\n' "$section" | sed -nE "s/^E\\|[[:space:]]*$key_re.*/\\1/p" | head -n 1)
    [ -n "$var" ] || var=$(printf '%s\n' "$section" | sed -nE "s/^M\\|[[:space:]]*env_http_headers[[:space:]]*=.*$key_re.*/\\1/p" | head -n 1)
    [ -z "$var" ] || token=$(printenv "$var")
  fi
  if [ -z "$token" ]; then
    header="authorization"
    token=$(printf '%s\n' "$section" | sed -nE 's/^M\|[[:space:]]*experimental_bearer_token[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' | head -n 1)
  fi
  if [ -z "$token" ]; then
    var=$(printf '%s\n' "$section" | sed -nE 's/^M\|[[:space:]]*env_key[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' | head -n 1)
    [ -z "$var" ] || token=$(printenv "$var")
  fi
  [ -n "$token" ] || return 0
  printf '%s\n%s\n%s\n' "$base" "$header" "$token"
}

# Print the Agent-Memory Codex route of a model provider base URL, which is
# <proxy>/codex/<space>. A trailing /v1 and the /cost-guard marker are not part
# of it. Print nothing when the URL is not a Codex route.
codex_route() {
  printf '%s' "$1" | sed -E 's#/cost-guard(/|$)#\1#g' | sed -nE 's#^(https?://[^?]*/codex/[^/?]+).*#\1#p'
}

# ---------------------------------------------------------------------------
# Codex: config.toml blocks and hook trust
# ---------------------------------------------------------------------------

HOOKS_BEGIN="# >>> agent-memory hooks >>>"
HOOKS_END="# <<< agent-memory hooks <<<"
TRUST_BEGIN="# >>> agent-memory hook trust >>>"
TRUST_END="# <<< agent-memory hook trust <<<"

# Block files that hold an exact copy of each block this installer wrote. They
# let the installer see, before it removes a block, whether Codex or the user
# put other lines inside it.
HOOKS_SAVED="$AM_DIR/codex-hooks.block"
TRUST_SAVED="$AM_DIR/codex-trust.block"

# Print "none" when file $1 has neither marker line $2 nor $3, "ok" when each
# appears exactly once and the end marker comes after the begin marker, and
# "bad" in every other case.
block_state() {
  awk -v b="$2" -v e="$3" '
    $0 == b { nb++; if (!bl) bl = NR }
    $0 == e { ne++; if (!el) el = NR }
    END {
      if (nb == 0 && ne == 0) print "none"
      else if (nb == 1 && ne == 1 && el > bl) print "ok"
      else print "bad"
    }' "$1"
}

# Print the marker lines $2 ... $3 of file $1, with the lines between them.
block_text() {
  awk -v b="$2" -v e="$3" '$0 == b { f = 1 } f { print } $0 == e { f = 0 }' "$1"
}

# Read a file on stdin. Print it without the marked block $1 ... $2, without
# the one blank line before the block and the one blank line after it, so that
# adding and removing a block restores the original bytes. The caller has
# checked with block_state that the markers are well formed.
strip_block() {
  awk -v b="$1" -v e="$2" '
    { line[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) { if (line[i] == b) bl = i; if (line[i] == e) el = i }
      if (!bl || !el) { for (i = 1; i <= NR; i++) print line[i]; exit }
      lo = bl; hi = el
      if (lo > 1 && line[lo - 1] == "") lo--
      if (hi < NR && line[hi + 1] == "") hi++
      for (i = 1; i <= NR; i++) if (i < lo || i > hi) print line[i]
    }'
}

# Print file $1 with the hooks block file $2 and the trust block file $3 put
# before the first table header of the file, after the top-level keys, and
# before the comment lines that sit directly above that header. Codex appends
# new tables at the end of the file, so the blocks must not be there. $2 or $3
# may be empty.
insert_blocks() {
  if [ ! -s "$2" ] && [ ! -s "$3" ]; then cat "$1"; return; fi
  awk -v hf="$2" -v tf="$3" '
    function slurp(f,   s, l) {
      s = ""
      if (f == "") return s
      while ((getline l < f) > 0) s = s l "\n"
      close(f)
      return s
    }
    { line[NR] = $0 }
    END {
      h = 0
      for (i = 1; i <= NR; i++) if (line[i] ~ /^[[:space:]]*\[/) { h = i; break }
      p = (h ? h : NR + 1)
      if (h) while (p > 1 && line[p - 1] ~ /^[[:space:]]*#/) p--
      for (i = 1; i < p; i++) print line[i]
      if (p > 1) print ""
      printf "%s", slurp(hf)
      printf "%s", slurp(tf)
      if (p <= NR) print ""
      for (i = p; i <= NR; i++) print line[i]
    }' "$1"
}

# Stop when the blocks of this installer in config.toml are not what the
# installer wrote: a marker is missing or repeated, or other lines are inside a
# block. Nothing is changed. $1 is a block name, $2 and $3 are its markers, $4
# is the saved copy and $5 is the text the installer would write now (a file;
# empty when it cannot be known).
check_block() {
  local name="$1" begin="$2" end="$3" saved="$4" generated="$5" state actual expected
  state=$(block_state "$CODEX_CONFIG" "$begin" "$end")
  case "$state" in
    none) return 0 ;;
    ok) ;;
    *) fail "$CODEX_CONFIG has a broken $name block: the line \"$begin\" or the line \"$end\" is missing, repeated, or in the wrong order. Nothing was changed. Fix or remove these marker lines by hand, then run this command again." ;;
  esac
  actual="$WORK_DIR/actual.$name"
  block_text "$CODEX_CONFIG" "$begin" "$end" > "$actual"
  if [ -f "$saved" ]; then
    expected="$saved"
  elif [ -n "$generated" ]; then
    expected="$generated"
  else
    # No saved copy and no way to build the text: accept only the shape the
    # installer writes (comments, blank lines, hook trust tables).
    if awk '
      $0 ~ /^#/ || $0 == "" { next }
      $0 ~ /^\[hooks\.state\."[^"]*"\][[:space:]]*$/ { next }
      $0 ~ /^trusted_hash = "sha256:[0-9a-f]*"$/ { next }
      { bad = 1 }
      END { exit bad }' "$actual"; then
      return 0
    fi
    fail "$CODEX_CONFIG: the $name block between \"$begin\" and \"$end\" holds lines that the installer does not write. Nothing was changed. Move those lines out of the block by hand (or delete the whole block), then run this command again."
  fi
  if ! cmp -s "$actual" "$expected"; then
    echo "agent-memory install: $CODEX_CONFIG: the $name block between \"$begin\" and \"$end\" was changed after the installer wrote it." >&2
    echo "Lines marked < are expected, lines marked > were added or changed:" >&2
    diff "$expected" "$actual" | grep '^[<>]' >&2 || true
    fail "Nothing was changed. Move the lines marked > out of the block by hand (or delete the whole block), then run this command again."
  fi
}

# Check both blocks.
check_codex_blocks() {
  local hooks_gen="$WORK_DIR/hooks.generated"
  codex_hooks_block > "$hooks_gen"
  check_block hooks "$HOOKS_BEGIN" "$HOOKS_END" "$HOOKS_SAVED" "$hooks_gen"
  check_block "hook trust" "$TRUST_BEGIN" "$TRUST_END" "$TRUST_SAVED" ""
}

# Escape a string for a TOML basic string.
toml_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Print the hooks block for config.toml.
codex_hooks_block() {
  local cmd
  cmd=$(toml_escape "$HOOK_CMD")
  printf '%s\n' "$HOOKS_BEGIN"
  printf '%s\n' '# Managed by the Agent-Memory installer. Remove it with --uninstall.'
  printf '%s\n' '[[hooks.SessionStart]]' 'matcher = "startup|resume|clear|fork"' '[[hooks.SessionStart.hooks]]' \
    'type = "command"' "command = \"$cmd\"" 'timeout = 5' ''
  printf '%s\n' '[[hooks.UserPromptSubmit]]' '[[hooks.UserPromptSubmit.hooks]]' \
    'type = "command"' "command = \"$cmd\"" 'timeout = 5'
  printf '%s\n' "$HOOKS_END"
}

# Ask `codex app-server` for the hooks that Codex loads. Print the JSON-RPC
# output (one JSON document per line) of the hooks/list call, or nothing when
# the codex command is missing or gives no answer within 15 seconds.
codex_hooks_list() {
  command -v codex >/dev/null 2>&1 || return 0
  local dir fifo out pid i
  dir=$(mktemp -d "${TMPDIR:-/tmp}/am-codex.XXXXXX") || return 0
  fifo="$dir/in"
  out="$dir/out"
  mkfifo "$fifo" || { rm -rf "$dir"; return 0; }
  : > "$out"
  CODEX_HOME="$CODEX_DIR" codex app-server < "$fifo" > "$out" 2>/dev/null &
  pid=$!
  # Open the pipe for reading and writing here, so this shell never blocks
  # when codex fails to start. Closing it later gives codex the end of input.
  exec 7<>"$fifo"
  printf '%s\n' \
    '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"agent-memory-install","version":"1"}}}' \
    '{"method":"initialized"}' \
    "{\"id\":2,\"method\":\"hooks/list\",\"params\":{\"cwds\":[\"$(printf '%s' "$PWD" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')\"]}}" >&7
  for i in $(seq 1 150); do
    if grep -q '"id":2' "$out" 2>/dev/null; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.1
  done
  exec 7>&-
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  cat "$out"
  rm -rf "$dir"
}

# Read hooks/list output on stdin. Print "errors<TAB>N" and, for each of our
# hooks, "hook<TAB>key<TAB>hash<TAB>trustStatus". Print nothing when there is no
# answer.
codex_hooks_summary() {
  case "$JSON_TOOL" in
    jq)
      jq -r --arg cmd "$HOOK_CMD" '
        select(.id? == 2)
        | if .error then "errors\t1"
          else (.result.data // [])[]
            | "errors\t\((.errors // []) | length)",
              ((.hooks // [])[] | select(.command == $cmd) | "hook\t\(.key)\t\(.currentHash)\t\(.trustStatus)")
          end' 2>/dev/null || true
      ;;
    python3)
      python3 -c '
import json, sys
cmd = sys.argv[1]
for line in sys.stdin:
    try:
        d = json.loads(line)
    except Exception:
        continue
    if not isinstance(d, dict) or d.get("id") != 2:
        continue
    if "error" in d:
        print("errors\t1")
        continue
    for ent in (d.get("result") or {}).get("data") or []:
        print("errors\t%d" % len(ent.get("errors") or []))
        for h in ent.get("hooks") or []:
            if h.get("command") == cmd:
                print("hook\t%s\t%s\t%s" % (h.get("key"), h.get("currentHash"), h.get("trustStatus")))
' "$HOOK_CMD" 2>/dev/null || true
      ;;
    node)
      node -e '
const cmd = process.argv[1];
for (const line of require("fs").readFileSync(0, "utf8").split("\n")) {
  let d;
  try { d = JSON.parse(line); } catch (e) { continue; }
  if (!d || d.id !== 2) continue;
  if (d.error) { console.log("errors\t1"); continue; }
  for (const ent of (d.result && d.result.data) || []) {
    console.log("errors\t" + (ent.errors || []).length);
    for (const h of ent.hooks || []) {
      if (h.command === cmd) console.log(["hook", h.key, h.currentHash, h.trustStatus].join("\t"));
    }
  }
}' "$HOOK_CMD" 2>/dev/null || true
      ;;
  esac
}

# Write file $1 from stdin only when the content changes. Make a backup first
# when the file exists. Write in place, to keep the file mode and any link.
write_if_changed() {
  local dest="$1" tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/am-write.XXXXXX")
  cat > "$tmp"
  if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"
    return 1
  fi
  # One backup per run and file: it holds the content from before this run.
  if [ -f "$dest" ] && [ "$BACKED_UP_FILE" != "$dest" ]; then
    backup_file "$dest"
    BACKED_UP_FILE="$dest"
  fi
  cat "$tmp" > "$dest"
  rm -f "$tmp"
  return 0
}

# Print config.toml without the blocks of this installer. The trust block goes
# first: it sits after the hooks block.
codex_config_plain() {
  strip_block "$TRUST_BEGIN" "$TRUST_END" < "$CODEX_CONFIG" | strip_block "$HOOKS_BEGIN" "$HOOKS_END"
}

# Put the config.toml copy $1 back and stop.
restore_codex_config() {
  cat "$1" > "$CODEX_CONFIG"
  rm -f "$1"
  fail "$2 The file is restored."
}

# Write config.toml as the plain config (without our blocks) plus the hooks
# block and the trust block file $1 (may be empty). The hooks block is left out
# when the config has the hook command outside the block (set by hand): a
# second entry would run the hook twice.
write_codex_config() {
  local trust_file="$1" plain="$WORK_DIR/plain" hooks="$WORK_DIR/hooks.block" new="$WORK_DIR/config.new"
  codex_config_plain > "$plain"
  : > "$hooks"
  if ! grep -qF "$HOOK_CMD" "$plain"; then codex_hooks_block > "$hooks"; fi
  insert_blocks "$plain" "$hooks" "$trust_file" > "$new"
  write_if_changed "$CODEX_CONFIG" < "$new" || true
}

# Save an exact copy of each block that is now in config.toml.
save_codex_blocks() {
  mkdir -p "$AM_DIR"
  rm -f "$HOOKS_SAVED" "$TRUST_SAVED"
  if [ "$(block_state "$CODEX_CONFIG" "$HOOKS_BEGIN" "$HOOKS_END")" = "ok" ]; then
    block_text "$CODEX_CONFIG" "$HOOKS_BEGIN" "$HOOKS_END" > "$HOOKS_SAVED"
  fi
  if [ "$(block_state "$CODEX_CONFIG" "$TRUST_BEGIN" "$TRUST_END")" = "ok" ]; then
    block_text "$CODEX_CONFIG" "$TRUST_BEGIN" "$TRUST_END" > "$TRUST_SAVED"
  fi
}

# Install the hooks block and the hook trust state in config.toml.
codex_install() {
  local list summary line key hash status errs restore plain n=0 sep="" trust_text="" trust_file
  if [ ! -f "$CODEX_CONFIG" ]; then
    mkdir -p "$CODEX_DIR"
    (umask 077; : > "$CODEX_CONFIG")
  fi

  # Check first: a changed block stops the install before any write.
  check_codex_blocks

  restore=$(mktemp "${TMPDIR:-/tmp}/am-restore.XXXXXX")
  cat "$CODEX_CONFIG" > "$restore"

  # First write: the hooks block with the trust block of the last install, so a
  # repeated install changes nothing. The file is written from a temp file, not
  # from a pipe, so the backup marker survives in this shell.
  trust_file="$WORK_DIR/trust.block"
  : > "$trust_file"
  if [ "$(block_state "$CODEX_CONFIG" "$TRUST_BEGIN" "$TRUST_END")" = "ok" ]; then
    block_text "$CODEX_CONFIG" "$TRUST_BEGIN" "$TRUST_END" > "$trust_file"
  fi
  write_codex_config "$trust_file"

  if ! command -v codex >/dev/null 2>&1; then
    rm -f "$restore"
    save_codex_blocks
    echo "Note: the codex command was not found, so the hooks are not trusted yet." >&2
    echo "      Start Codex, run /hooks and trust the two Agent-Memory hooks." >&2
    return
  fi

  list=$(codex_hooks_list)
  summary=$(printf '%s\n' "$list" | codex_hooks_summary)
  errs=$(printf '%s\n' "$summary" | awk -F'\t' '$1 == "errors" { s += $2 } END { print s + 0 }')
  if [ -z "$summary" ] || [ "$errs" != "0" ]; then
    restore_codex_config "$restore" "Codex could not load $CODEX_CONFIG with the new hooks (or gave no answer)."
  fi
  n=$(printf '%s\n' "$summary" | awk -F'\t' '$1 == "hook" { n++ } END { print n + 0 }')
  if [ "$n" -eq 0 ]; then
    restore_codex_config "$restore" "Codex does not list the Agent-Memory hooks. Is hooks = false in $CODEX_CONFIG?"
  fi

  plain=$(codex_config_plain; printf x)
  plain=${plain%x}
  while IFS="$(printf '\t')" read -r line key hash status; do
    [ "$line" = "hook" ] || continue
    # A table that Codex wrote after /hooks stays: a second one breaks the TOML.
    if printf '%s' "$plain" | grep -qF "[hooks.state.\"$key\"]"; then continue; fi
    trust_text="$trust_text$sep[hooks.state.\"$(toml_escape "$key")\"]
trusted_hash = \"$hash\"
"
    sep="
"
  done <<EOF
$summary
EOF
  : > "$trust_file"
  if [ -n "$trust_text" ]; then
    {
      printf '%s\n' "$TRUST_BEGIN"
      printf '%s\n' '# Hook trust, as computed by Codex (hooks/list). Install again after a hook change.'
      printf '%s' "$trust_text"
      printf '%s\n' "$TRUST_END"
    } > "$trust_file"
  fi
  write_codex_config "$trust_file"
  rm -f "$restore"
  save_codex_blocks

  summary=$(codex_hooks_list | codex_hooks_summary)
  if printf '%s\n' "$summary" | awk -F'\t' '$1 == "hook" && $4 != "trusted" { bad = 1 } END { exit !bad }'; then
    echo "Note: Codex does not trust all Agent-Memory hooks. Start Codex, run /hooks and trust them." >&2
  fi
}

# Remove the blocks of this installer, and the trust tables of our hooks that
# Codex wrote itself, from config.toml.
codex_uninstall() {
  local summary keys key tmp
  [ -f "$CODEX_CONFIG" ] || { rm -f "$HOOKS_SAVED" "$TRUST_SAVED"; return 0; }
  check_codex_blocks
  summary=$(codex_hooks_list | codex_hooks_summary)
  keys=$(printf '%s\n' "$summary" | awk -F'\t' '$1 == "hook" { print $2 }')
  tmp="$WORK_DIR/uninstall"
  codex_config_plain > "$tmp"
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    awk -v hdr="[hooks.state.\"$(toml_escape "$key")\"]" '
      BEGIN { gsub(/[[:space:]]/, "", hdr) }
      /^[[:space:]]*\[/ { h = $0; gsub(/[[:space:]]/, "", h); skip = (h == hdr) }
      !skip { print }' "$tmp" > "$tmp.next"
    mv -f "$tmp.next" "$tmp"
  done <<EOF
$keys
EOF
  write_if_changed "$CODEX_CONFIG" < "$tmp" || true
  rm -f "$HOOKS_SAVED" "$TRUST_SAVED"
}

# ---------------------------------------------------------------------------
# pi: models.json
# ---------------------------------------------------------------------------

# Read models.json on stdin. Set compat.sendSessionAffinityHeaders = true on
# every provider whose baseUrl is an Agent-Memory pi route (.../pi/<space>/v1).
# Print the new document, or nothing when it does not change.
edit_models() {
  case "$JSON_TOOL" in
    jq)
      jq '
        . as $orig
        | (if (.providers | type) == "object" then
            .providers |= with_entries(
              if (.value | type) == "object" and ((.value.baseUrl // "") | type) == "string"
                 and (.value.baseUrl | test("^https?://.+/pi/[^/]+/v1/?$"))
              then .value.compat = ((if (.value.compat | type) == "object" then .value.compat else {} end) + {sendSessionAffinityHeaders: true})
              else . end)
          else . end) as $new
        | if $new == $orig then empty else $new end'
      ;;
    python3)
      python3 -c '
import json, re, sys
raw = sys.stdin.buffer.read().decode("utf-8")
doc = json.loads(raw) if raw.strip() else {}
if not isinstance(doc, dict):
    sys.exit("models.json root is not an object")
before = json.dumps(doc)
pat = re.compile(r"^https?://.+/pi/[^/]+/v1/?$")
providers = doc.get("providers")
if isinstance(providers, dict):
    for p in providers.values():
        if isinstance(p, dict) and isinstance(p.get("baseUrl"), str) and pat.match(p["baseUrl"]):
            compat = p.get("compat") if isinstance(p.get("compat"), dict) else {}
            compat["sendSessionAffinityHeaders"] = True
            p["compat"] = compat
if json.dumps(doc) != before:
    sys.stdout.buffer.write((json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
'
      ;;
    node)
      node -e '
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8");
const doc = raw.trim() ? JSON.parse(raw) : {};
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
if (!isObj(doc)) { console.error("models.json root is not an object"); process.exit(1); }
const before = JSON.stringify(doc);
const pat = /^https?:\/\/.+\/pi\/[^/]+\/v1\/?$/;
if (isObj(doc.providers)) {
  for (const p of Object.values(doc.providers)) {
    if (isObj(p) && typeof p.baseUrl === "string" && pat.test(p.baseUrl)) {
      const compat = isObj(p.compat) ? p.compat : {};
      compat.sendSessionAffinityHeaders = true;
      p.compat = compat;
    }
  }
}
if (JSON.stringify(doc) !== before) process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
'
      ;;
    *)
      fail "unknown JSON tool: $JSON_TOOL"
      ;;
  esac
}

pi_install() {
  local origin="$1" new
  fetch_file "$origin" "/setup/pi-extension.ts" "$PI_EXTENSION_FILE" "//"
  chmod 644 "$PI_EXTENSION_FILE"
  if [ ! -f "$PI_MODELS_FILE" ]; then
    echo "Note: $PI_MODELS_FILE does not exist. Add the proxy as a pi provider (baseUrl .../pi/<space>/v1), then run this installer again." >&2
    return
  fi
  new=$(edit_models < "$PI_MODELS_FILE") \
    || fail "cannot update $PI_MODELS_FILE. Is it valid JSON? The file is not changed."
  if [ -n "$new" ]; then
    printf '%s\n' "$new" | write_if_changed "$PI_MODELS_FILE" || true
  fi
  if ! grep -Eq '"baseUrl"[[:space:]]*:[[:space:]]*"https?://[^"]*/pi/[^"/]+/v1/?"' "$PI_MODELS_FILE"; then
    echo "Note: no provider in $PI_MODELS_FILE has a baseUrl like .../pi/<space>/v1. The extension reports nothing until one exists." >&2
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  local base="" client="claude-code" session="" uninstall=0
  local origin device token

  while [ $# -gt 0 ]; do
    case "$1" in
      --base-url) [ $# -ge 2 ] || fail "--base-url needs a value"; base="$2"; shift 2 ;;
      --client) [ $# -ge 2 ] || fail "--client needs a value"; client="$2"; shift 2 ;;
      --session) [ $# -ge 2 ] || fail "--session needs a value"; session="$2"; shift 2 ;;
      --uninstall) uninstall=1; shift ;;
      *) fail "unknown argument: $1" ;;
    esac
  done

  case "$client" in
    claude-code | codex | pi) ;;
    *) fail "unsupported client: $client (use claude-code, codex or pi)" ;;
  esac
  case "$HOME" in /*) ;; *) fail "HOME must be an absolute path" ;; esac

  # The hook command in settings.json. Quote the path if it has special characters.
  case "$HOOK_FILE" in
    *[!A-Za-z0-9_./+@:-]*) HOOK_CMD="\"$HOOK_FILE\" $client" ;;
    *) HOOK_CMD="$HOOK_FILE $client" ;;
  esac

  detect_json_tool

  SETTINGS_EXISTED=0
  if [ -f "$SETTINGS_FILE" ]; then SETTINGS_EXISTED=1; fi

  if [ "$uninstall" = "1" ]; then
    case "$client" in
      claude-code) if [ "$SETTINGS_EXISTED" = "1" ]; then update_settings remove; fi ;;
      codex) codex_uninstall ;;
      pi) rm -f "$PI_EXTENSION_FILE" ;;
    esac
    remove_hook_file_if_unused
    echo "Agent-Memory hooks removed."
    return
  fi

  # Proxy base URL: argument, then the client's own settings.
  if [ -z "$base" ] && [ "$client" = "claude-code" ]; then base="${ANTHROPIC_BASE_URL:-}"; fi
  if [ -z "$base" ] && [ "$client" = "claude-code" ] && [ "$SETTINGS_EXISTED" = "1" ]; then
    base=$(json_get '["env","ANTHROPIC_BASE_URL"]' < "$SETTINGS_FILE")
  fi
  if [ -z "$base" ] && [ "$client" = "codex" ]; then
    base=$(codex_connection | sed -n 1p)
  fi
  if [ -z "$base" ] && [ "$client" = "pi" ] && [ -f "$PI_MODELS_FILE" ]; then
    base=$(grep -Eo '"baseUrl"[[:space:]]*:[[:space:]]*"https?://[^"]*/pi/[^"/]+/v1/?"' "$PI_MODELS_FILE" \
      | head -n 1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')
  fi
  [ -n "$base" ] || fail "no proxy URL. Use --base-url, or configure the client first (claude-code: ANTHROPIC_BASE_URL in env or $SETTINGS_FILE; codex: $CODEX_CONFIG; pi: $PI_MODELS_FILE)."
  origin=$(printf '%s' "$base" | sed -nE 's|^(https?://[^/?]+).*|\1|p')
  [ -n "$origin" ] || fail "the base URL must start with http:// or https:// (got: $base)"

  if [ "$client" = "pi" ]; then
    [ -z "$session" ] || fail "--session is not supported for pi"
    mkdir -p "$AM_DIR"
    chmod 700 "$AM_DIR"
    device=$(ensure_device_id)
    pi_install "$origin"
    echo "Agent-Memory pi extension installed (device $device)."
    return
  fi

  # Hook script: download to a temp file, then move it in place.
  mkdir -p "$AM_DIR"
  chmod 700 "$AM_DIR"
  fetch_file "$origin" "/setup/hook.sh" "$HOOK_FILE" "#!"

  device=$(ensure_device_id)

  if [ "$client" = "codex" ]; then
    codex_install
    if [ -n "$session" ]; then
      AM_SID="$session" AM_CWD="$PWD" session_json \
        | AGENT_MEMORY_HOOK_STRICT=1 "$HOOK_FILE" codex \
        || exit 1
    fi
    echo "Agent-Memory hooks installed for codex (device $device)."
    return
  fi

  if [ "$SETTINGS_EXISTED" = "0" ]; then
    mkdir -p "$CLAUDE_DIR"
    (umask 077; printf '{}\n' > "$SETTINGS_FILE")
  fi
  update_settings add

  if [ -n "$session" ]; then
    token="${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}"
    if [ -z "$token" ]; then token=$(json_get '["env","ANTHROPIC_AUTH_TOKEN"]' < "$SETTINGS_FILE"); fi
    if [ -z "$token" ]; then token=$(json_get '["env","ANTHROPIC_API_KEY"]' < "$SETTINGS_FILE"); fi
    [ -n "$token" ] || fail "no API token found for --session (set ANTHROPIC_AUTH_TOKEN or add it to $SETTINGS_FILE)"
    AM_SID="$session" AM_CWD="$PWD" session_json \
      | AGENT_MEMORY_HOOK_STRICT=1 ANTHROPIC_BASE_URL="$base" ANTHROPIC_AUTH_TOKEN="$token" \
          "$HOOK_FILE" "$client" \
      || exit 1
  fi

  echo "Agent-Memory hooks installed (device $device)."
}

main "$@"
