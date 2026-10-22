#!/usr/bin/env bash
# Agent-Memory hook installer.
#
# Usage:
#   curl -fsSL <proxy-origin>/setup/hooks.sh | bash -s -- \
#     [--base-url URL] [--client claude-code] [--session SID] [--uninstall]
#
# Install:
#   1. Download <proxy-origin>/setup/hook.sh to ~/.agent-memory/hook.sh.
#   2. Create ~/.agent-memory/device.json when it is missing.
#   3. Add the hook to the SessionStart and UserPromptSubmit events in
#      ~/.claude/settings.json. A backup of the file is made first.
#   4. With --session SID: send one test report with this session id.
# Uninstall:
#   Remove only our hook entries and hook.sh. Keep device.json.
#
# The script is safe to run again: it never adds a second entry.
# Test override: AGENT_MEMORY_JSON_TOOL=jq|python3|node forces one JSON tool.
set -euo pipefail

CLAUDE_DIR="$HOME/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
AM_DIR="$HOME/.agent-memory"
HOOK_FILE="$AM_DIR/hook.sh"
DEVICE_FILE="$AM_DIR/device.json"
TMP_FILE=""

cleanup() {
  if [ -n "$TMP_FILE" ]; then rm -f "$TMP_FILE"; fi
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
# Main
# ---------------------------------------------------------------------------

main() {
  local base="" client="claude-code" session="" uninstall=0
  local origin tmp device token

  while [ $# -gt 0 ]; do
    case "$1" in
      --base-url) [ $# -ge 2 ] || fail "--base-url needs a value"; base="$2"; shift 2 ;;
      --client) [ $# -ge 2 ] || fail "--client needs a value"; client="$2"; shift 2 ;;
      --session) [ $# -ge 2 ] || fail "--session needs a value"; session="$2"; shift 2 ;;
      --uninstall) uninstall=1; shift ;;
      *) fail "unknown argument: $1" ;;
    esac
  done

  [ "$client" = "claude-code" ] || fail "unsupported client: $client (only claude-code)"
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
    if [ "$SETTINGS_EXISTED" = "1" ]; then update_settings remove; fi
    rm -f "$HOOK_FILE"
    echo "Agent-Memory hooks removed."
    return
  fi

  # Proxy base URL: argument, then environment, then settings.json.
  if [ -z "$base" ]; then base="${ANTHROPIC_BASE_URL:-}"; fi
  if [ -z "$base" ] && [ "$SETTINGS_EXISTED" = "1" ]; then
    base=$(json_get '["env","ANTHROPIC_BASE_URL"]' < "$SETTINGS_FILE")
  fi
  [ -n "$base" ] || fail "no proxy URL. Use --base-url, or set ANTHROPIC_BASE_URL (env or $SETTINGS_FILE)."
  origin=$(printf '%s' "$base" | sed -nE 's|^(https?://[^/?]+).*|\1|p')
  [ -n "$origin" ] || fail "the base URL must start with http:// or https:// (got: $base)"

  # Hook script: download to a temp file, then move it in place.
  mkdir -p "$AM_DIR"
  chmod 700 "$AM_DIR"
  tmp=$(mktemp "$AM_DIR/hook.XXXXXX")
  TMP_FILE="$tmp"
  curl -fsSL --connect-timeout 5 --max-time 30 -o "$tmp" "$origin/setup/hook.sh" \
    || fail "cannot download $origin/setup/hook.sh"
  [ "$(head -c 2 "$tmp")" = "#!" ] || fail "$origin/setup/hook.sh is not a shell script"
  chmod 755 "$tmp"
  mv -f "$tmp" "$HOOK_FILE"
  TMP_FILE=""

  device=$(ensure_device_id)

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
