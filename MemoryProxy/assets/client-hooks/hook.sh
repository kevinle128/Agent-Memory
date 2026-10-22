#!/usr/bin/env bash
# Agent-Memory client hook.
#
# Claude Code runs this script on the SessionStart and UserPromptSubmit events.
# It sends the working directory and git identity of the session to the
# Agent-Memory proxy. The proxy uses them to find the project of the session.
#
# Usage: ~/.agent-memory/hook.sh [client]     (client defaults to claude-code)
#
# Rules for this script:
#   - It MUST NOT write to stdout. Claude Code adds hook stdout to the model
#     context.
#   - It always exits 0, so a failure here never blocks the session.
#   - Exception: when AGENT_MEMORY_HOOK_STRICT=1, it writes one error line to
#     stderr and exits 1 if the report cannot be sent. The installer uses this.
#
# Test override: AGENT_MEMORY_JSON_TOOL=jq|python3|node|sed forces one JSON tool.
set -u

# Keep the original stderr on fd 3 for strict mode. Silence fd 1 and fd 2.
exec 3>&2 2>/dev/null 1>/dev/null

CLIENT="${1:-claude-code}"
HOOK_VERSION="1"
HOME_DIR="${HOME:-}"
AM_DIR="$HOME_DIR/.agent-memory"
DEVICE_FILE="$AM_DIR/device.json"
SETTINGS_FILE="$HOME_DIR/.claude/settings.json"

# Report an error. In strict mode this exits 1. Otherwise it exits 0 silently.
die() {
  if [ "${AGENT_MEMORY_HOOK_STRICT:-}" = "1" ]; then
    echo "agent-memory hook: $*" >&3
    exit 1
  fi
  exit 0
}

# ---------------------------------------------------------------------------
# JSON tool selection: jq, then python3, then node, then sed (read-only).
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
  JSON_TOOL="sed"
}

# Read JSON on stdin. Print the string value found at the key path.
# $1 is a JSON array of keys, for example '["env","ANTHROPIC_BASE_URL"]'.
# Print nothing when the value is missing or is not a string.
# The sed fallback only reads the last key. It takes the last match in the
# text and can fail on nested objects with the same key name.
json_get() {
  local path="$1" key
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
      key=$(printf '%s' "$path" | sed -E 's/.*"([^"]+)"\]$/\1/')
      tr '\n' ' ' \
        | sed -nE 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' \
        | head -n 1 \
        | sed -E 's/\\(["\\/])/\1/g'
      ;;
  esac
}

# Escape one string for a JSON string literal (sed fallback only).
json_escape() {
  printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Print a JSON string literal, or null when the value is empty (sed fallback).
json_value() {
  if [ -z "$1" ]; then
    printf 'null'
  else
    printf '"%s"' "$(json_escape "$1")"
  fi
}

# Build the report body from the AM_* environment variables.
# An empty value becomes JSON null.
build_report() {
  case "$JSON_TOOL" in
    jq)
      jq -n -c 'def n: if . == null or . == "" then null else . end;
        {device_id: (env.AM_DEVICE_ID | n), session_id: (env.AM_SESSION_ID | n),
         cwd: (env.AM_CWD | n), git_toplevel: (env.AM_GIT_TOPLEVEL | n),
         git_remote: (env.AM_GIT_REMOTE | n), hook_event: (env.AM_HOOK_EVENT | n),
         hook_version: (env.AM_HOOK_VERSION | n), client: (env.AM_CLIENT | n),
         os: (env.AM_OS | n), arch: (env.AM_ARCH | n),
         hostname: (env.AM_HOSTNAME | n)}'
      ;;
    python3)
      python3 -c 'import json, os
keys = ["device_id", "session_id", "cwd", "git_toplevel", "git_remote",
        "hook_event", "hook_version", "client", "os", "arch", "hostname"]
print(json.dumps({k: os.environ.get("AM_" + k.upper()) or None for k in keys},
                 separators=(",", ":")))'
      ;;
    node)
      node -e 'const keys = ["device_id", "session_id", "cwd", "git_toplevel",
  "git_remote", "hook_event", "hook_version", "client", "os", "arch", "hostname"];
const o = {};
for (const k of keys) o[k] = process.env["AM_" + k.toUpperCase()] || null;
process.stdout.write(JSON.stringify(o));'
      ;;
    *)
      printf '{"device_id":%s,"session_id":%s,"cwd":%s,"git_toplevel":%s,"git_remote":%s,' \
        "$(json_value "$AM_DEVICE_ID")" "$(json_value "$AM_SESSION_ID")" \
        "$(json_value "$AM_CWD")" "$(json_value "$AM_GIT_TOPLEVEL")" \
        "$(json_value "$AM_GIT_REMOTE")"
      printf '"hook_event":%s,"hook_version":%s,"client":%s,"os":%s,"arch":%s,"hostname":%s}' \
        "$(json_value "$AM_HOOK_EVENT")" "$(json_value "$AM_HOOK_VERSION")" \
        "$(json_value "$AM_CLIENT")" "$(json_value "$AM_OS")" \
        "$(json_value "$AM_ARCH")" "$(json_value "$AM_HOSTNAME")"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Device id. Keep this block the same as the one in install.sh.
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
  [ -n "$new" ] || return 0
  mkdir -p "$AM_DIR" && chmod 700 "$AM_DIR" || return 0
  tmp=$(mktemp "$AM_DIR/device.XXXXXX") || return 0
  chmod 600 "$tmp"
  printf '{"device_id": "%s", "created_at": "%s"}\n' "$new" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
  if [ -e "$DEVICE_FILE" ]; then
    # The file exists but has no usable id. Replace it.
    mv -f "$tmp" "$DEVICE_FILE"
  else
    # A hard link fails if another hook created the file first. Both hooks
    # then read the same id.
    ln "$tmp" "$DEVICE_FILE" || true
    rm -f "$tmp"
  fi
  id=$(read_device_id)
  printf '%s' "${id:-$new}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  local input="" base token session cwd event device top remote name url body code

  detect_json_tool

  if [ ! -t 0 ]; then
    input=$(cat)
  fi

  session=$(printf '%s' "$input" | json_get '["session_id"]')
  cwd=$(printf '%s' "$input" | json_get '["cwd"]')
  event=$(printf '%s' "$input" | json_get '["hook_event_name"]')

  # Connection settings: the environment first, then settings.json.
  base="${ANTHROPIC_BASE_URL:-}"
  token="${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}"
  if [ -f "$SETTINGS_FILE" ]; then
    [ -n "$base" ] || base=$(json_get '["env","ANTHROPIC_BASE_URL"]' < "$SETTINGS_FILE")
    [ -n "$token" ] || token=$(json_get '["env","ANTHROPIC_AUTH_TOKEN"]' < "$SETTINGS_FILE")
    [ -n "$token" ] || token=$(json_get '["env","ANTHROPIC_API_KEY"]' < "$SETTINGS_FILE")
  fi
  [ -n "$base" ] && [ -n "$token" ] || die "no ANTHROPIC_BASE_URL or token found"
  [ -n "$session" ] || die "no session_id on stdin"

  device=$(ensure_device_id)
  [ -n "$device" ] || die "cannot create a device id"

  # Git identity. An empty value means: not a git repository, or no remote.
  top=""
  remote=""
  if [ -n "$cwd" ] && command -v git >/dev/null 2>&1; then
    top=$(GIT_OPTIONAL_LOCKS=0 git -C "$cwd" rev-parse --show-toplevel)
    if [ -n "$top" ]; then
      remote=$(GIT_OPTIONAL_LOCKS=0 git -C "$cwd" remote get-url origin)
      if [ -z "$remote" ]; then
        name=$(GIT_OPTIONAL_LOCKS=0 git -C "$cwd" remote | head -n 1)
        [ -z "$name" ] || remote=$(GIT_OPTIONAL_LOCKS=0 git -C "$cwd" remote get-url "$name")
      fi
      # Remove userinfo (user:token@) from scheme://... URLs. A scp-like
      # git@host:owner/repo URL has no scheme and holds no secret.
      remote=$(printf '%s' "$remote" | sed -E 's#^([a-zA-Z][a-zA-Z0-9+.-]*://)[^/]*@#\1#')
    fi
  fi

  export AM_DEVICE_ID="$device" AM_SESSION_ID="$session" AM_CWD="$cwd"
  export AM_GIT_TOPLEVEL="$top" AM_GIT_REMOTE="$remote" AM_HOOK_EVENT="$event"
  export AM_HOOK_VERSION="$HOOK_VERSION" AM_CLIENT="$CLIENT"
  AM_OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  AM_ARCH=$(uname -m)
  AM_HOSTNAME=$(hostname || uname -n)
  export AM_OS AM_ARCH AM_HOSTNAME

  body=$(build_report)
  [ -n "$body" ] || die "cannot build the report"

  command -v curl >/dev/null 2>&1 || die "curl not found"
  url="${base%/}/v3/hook/report"
  # The token goes to curl on stdin, so it does not show in the process list.
  code=$(printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' \
      "$(printf '%s' "$token" | tr -d '\r\n' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')" \
    | curl -s -o /dev/null -w '%{http_code}' --connect-timeout 1 --max-time 2 \
        -K - -X POST --data-binary "$body" "$url")
  case "$code" in
    2??) ;;
    *) die "report to $url failed (HTTP ${code:-none})" ;;
  esac
}

main
exit 0
