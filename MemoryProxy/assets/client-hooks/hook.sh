#!/usr/bin/env bash
# Agent-Memory client hook.
#
# Claude Code and Codex run this script on the SessionStart and UserPromptSubmit
# events. It sends the working directory and git identity of the session to the
# Agent-Memory proxy. The proxy uses them to find the project of the session.
#
# Usage: ~/.agent-memory/hook.sh [client]     (client: claude-code (default) or codex)
#
# Connection settings:
#   claude-code: ANTHROPIC_BASE_URL and token, from the environment or
#                ~/.claude/settings.json.
#   codex:       the active model provider in $CODEX_HOME/config.toml
#                (default ~/.codex): the model_provider of the active profile, else
#                the top-level one. Its base_url must be an Agent-Memory Codex
#                route (".../codex/<space>"; a trailing /v1 or /cost-guard is
#                dropped). The user key is found in the order the proxy uses:
#                x-tdai-user-key in http_headers (also as a subtable), then the
#                env var named in env_http_headers, then experimental_bearer_token,
#                then the env var named by env_key.
#
# Recall (Claude Code only): on UserPromptSubmit with a prompt, the hook also
# posts the report fields and the prompt to <base>/v3/hook/recall. When the
# proxy answers HTTP 200 with a hook JSON object, the hook prints that object.
# Claude Code then adds the memories next to the prompt. Codex stays silent.
# AGENT_MEMORY_RECALL=0 turns recall off on this machine.
#
# Self-update: on SessionStart, at most once per 6 hours, the hook reads
# <base>/v3/hook/manifest ({version, sha256}). When the version is not the
# version of this script, it downloads <origin>/setup/hook.sh to a temp file,
# checks the sha256, the version line and `bash -n`, and then moves the file
# over ~/.agent-memory/hook.sh. Any failure keeps the current file. Only the
# installed hook updates itself. AGENT_MEMORY_HOOK_UPDATE=0 turns this off.
#
# Rules for this script:
#   - It MUST NOT write to stdout, except the recall JSON that the proxy sent.
#     Claude Code and Codex add hook stdout to the model context.
#   - It always exits 0, so a failure here never blocks the session.
#   - Exception: when AGENT_MEMORY_HOOK_STRICT=1, it writes one error line to
#     stderr and exits 1 if the report cannot be sent. The installer uses this.
#
# Test override: AGENT_MEMORY_JSON_TOOL=jq|python3|node|sed forces one JSON tool.
set -u

# Keep the original stderr on fd 3 for strict mode and the original stdout on
# fd 4 for the recall JSON. Silence fd 1 and fd 2.
exec 3>&2 4>&1 2>/dev/null 1>/dev/null

CLIENT="${1:-claude-code}"
HOOK_VERSION="2"
HOME_DIR="${HOME:-}"
AM_DIR="$HOME_DIR/.agent-memory"
DEVICE_FILE="$AM_DIR/device.json"
SETTINGS_FILE="$HOME_DIR/.claude/settings.json"
CODEX_CONFIG="${CODEX_HOME:-$HOME_DIR/.codex}/config.toml"

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
# An empty value becomes JSON null. When AM_PROMPT is set, the body also has
# "prompt" (the recall request).
build_report() {
  case "$JSON_TOOL" in
    jq)
      jq -n -c 'def n: if . == null or . == "" then null else . end;
        {device_id: (env.AM_DEVICE_ID | n), session_id: (env.AM_SESSION_ID | n),
         cwd: (env.AM_CWD | n), git_toplevel: (env.AM_GIT_TOPLEVEL | n),
         git_remote: (env.AM_GIT_REMOTE | n), hook_event: (env.AM_HOOK_EVENT | n),
         hook_version: (env.AM_HOOK_VERSION | n), client: (env.AM_CLIENT | n),
         os: (env.AM_OS | n), arch: (env.AM_ARCH | n),
         hostname: (env.AM_HOSTNAME | n)}
        + (if (env.AM_PROMPT // "") != "" then {prompt: env.AM_PROMPT} else {} end)'
      ;;
    python3)
      python3 -c 'import json, os
keys = ["device_id", "session_id", "cwd", "git_toplevel", "git_remote",
        "hook_event", "hook_version", "client", "os", "arch", "hostname"]
o = {k: os.environ.get("AM_" + k.upper()) or None for k in keys}
if os.environ.get("AM_PROMPT"):
    o["prompt"] = os.environ["AM_PROMPT"]
print(json.dumps(o, separators=(",", ":")))'
      ;;
    node)
      node -e 'const keys = ["device_id", "session_id", "cwd", "git_toplevel",
  "git_remote", "hook_event", "hook_version", "client", "os", "arch", "hostname"];
const o = {};
for (const k of keys) o[k] = process.env["AM_" + k.toUpperCase()] || null;
if (process.env.AM_PROMPT) o.prompt = process.env.AM_PROMPT;
process.stdout.write(JSON.stringify(o));'
      ;;
    *)
      printf '{"device_id":%s,"session_id":%s,"cwd":%s,"git_toplevel":%s,"git_remote":%s,' \
        "$(json_value "$AM_DEVICE_ID")" "$(json_value "$AM_SESSION_ID")" \
        "$(json_value "$AM_CWD")" "$(json_value "$AM_GIT_TOPLEVEL")" \
        "$(json_value "$AM_GIT_REMOTE")"
      printf '"hook_event":%s,"hook_version":%s,"client":%s,"os":%s,"arch":%s,"hostname":%s' \
        "$(json_value "$AM_HOOK_EVENT")" "$(json_value "$AM_HOOK_VERSION")" \
        "$(json_value "$AM_CLIENT")" "$(json_value "$AM_OS")" \
        "$(json_value "$AM_ARCH")" "$(json_value "$AM_HOSTNAME")"
      # json_escape drops control characters; keep line breaks as spaces.
      [ -z "${AM_PROMPT:-}" ] || printf ',"prompt":%s' "$(json_value "$(printf '%s' "$AM_PROMPT" | tr '\n\r\t' '   ')")"
      printf '}'
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Codex connection settings. Keep this block the same as the one in install.sh.
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
# Report, recall and self-update
# ---------------------------------------------------------------------------

# Post the report body $2 to $1/v3/hook/report. CURL_AUTH holds the curl
# config lines with the auth header.
send_report() {
  local url="${1%/}/v3/hook/report" code
  code=$(printf '%s' "$CURL_AUTH" \
    | curl -s -o /dev/null -w '%{http_code}' --connect-timeout 1 --max-time 2 \
        -K - -X POST --data-binary "$2" "$url")
  case "$code" in
    2??) ;;
    *) die "report to $url failed (HTTP ${code:-none})" ;;
  esac
}

# Post the recall body $2 to $1/v3/hook/recall. Print the answer on the
# original stdout only when it is HTTP 200 and one hook JSON object. Any other
# answer, an error or the time limit prints nothing.
recall() {
  local url="${1%/}/v3/hook/recall" resp code out
  # The body holds the prompt: send it on stdin, so it does not show in the
  # process list. The auth config goes through a pipe for the same reason.
  resp=$(printf '%s' "$2" \
    | curl -s -w '\n%{http_code}' --connect-timeout 1 --max-time 1.5 \
        -K <(printf '%s' "$CURL_AUTH") -X POST --data-binary @- "$url") || return 0
  code=${resp##*$'\n'}
  out=${resp%$'\n'*}
  [ "$code" = "200" ] || return 0
  case "$out" in
    '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"'*'"}}') ;;
    *) return 0 ;;
  esac
  printf '%s\n' "$out" >&4
}

# Print the sha256 of file $1 in lower-case hex, or nothing.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{ print $NF }'
  fi
}

# Replace the installed hook with the version that the proxy at $1 serves.
# Runs at most once per 6 hours. Every check must pass, else nothing changes.
self_update() {
  local installed="$AM_DIR/hook.sh" stamp="$AM_DIR/hook-update.stamp"
  local manifest version sha origin tmp
  [ "${AGENT_MEMORY_HOOK_UPDATE:-}" != "0" ] || return 0
  # Only the installed copy updates itself, never a copy run from another path.
  [ "$0" = "$installed" ] && [ -f "$installed" ] || return 0
  if [ -f "$stamp" ] && [ -n "$(find "$stamp" -mmin -360 2>/dev/null)" ]; then
    return 0
  fi
  touch "$stamp" || return 0

  manifest=$(curl -fsS --connect-timeout 1 --max-time 2 "${1%/}/v3/hook/manifest") || return 0
  version=$(printf '%s' "$manifest" | json_get '["version"]')
  sha=$(printf '%s' "$manifest" | json_get '["sha256"]' | tr '[:upper:]' '[:lower:]')
  [ -n "$version" ] && [ "$version" != "$HOOK_VERSION" ] || return 0
  printf '%s' "$version" | grep -Eq '^[A-Za-z0-9._-]{1,32}$' || return 0
  printf '%s' "$sha" | grep -Eq '^[0-9a-f]{64}$' || return 0

  origin=$(printf '%s' "$1" | sed -nE 's|^(https?://[^/?]+).*|\1|p')
  [ -n "$origin" ] || return 0
  # The temp file is in the same directory, so the final mv is atomic.
  tmp=$(mktemp "$AM_DIR/hook.update.XXXXXX") || return 0
  if curl -fsS --connect-timeout 1 --max-time 5 -o "$tmp" "$origin/setup/hook.sh" \
    && [ "$(sha256_of "$tmp")" = "$sha" ] \
    && [ "$(head -c 2 "$tmp")" = "#!" ] \
    && grep -qx "HOOK_VERSION=\"$version\"" "$tmp" \
    && bash -n "$tmp" \
    && chmod 755 "$tmp"; then
    # mv gives the file a new inode: a hook that runs now keeps reading the old file.
    mv -f "$tmp" "$installed" && return 0
  fi
  rm -f "$tmp"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  local input="" base token session cwd event device top remote name body prompt
  local auth_header="authorization" conn

  detect_json_tool

  if [ ! -t 0 ]; then
    input=$(cat)
  fi

  session=$(printf '%s' "$input" | json_get '["session_id"]')
  cwd=$(printf '%s' "$input" | json_get '["cwd"]')
  event=$(printf '%s' "$input" | json_get '["hook_event_name"]')

  if [ "$CLIENT" = "codex" ]; then
    # Connection settings: the active model provider in the Codex config. The
    # token goes only to a Codex route of the proxy, never to another provider.
    conn=$(codex_connection)
    base=$(printf '%s\n' "$conn" | sed -n 1p)
    auth_header=$(printf '%s\n' "$conn" | sed -n 2p)
    token=$(printf '%s\n' "$conn" | sed -n 3p)
    base=$(codex_route "$base")
    [ -n "$base" ] || die "the active Codex provider is not an Agent-Memory route"
    [ -n "$token" ] || die "no token found in $CODEX_CONFIG"
  else
    # Connection settings: the environment first, then settings.json.
    base="${ANTHROPIC_BASE_URL:-}"
    token="${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}"
    if [ -f "$SETTINGS_FILE" ]; then
      [ -n "$base" ] || base=$(json_get '["env","ANTHROPIC_BASE_URL"]' < "$SETTINGS_FILE")
      [ -n "$token" ] || token=$(json_get '["env","ANTHROPIC_AUTH_TOKEN"]' < "$SETTINGS_FILE")
      [ -n "$token" ] || token=$(json_get '["env","ANTHROPIC_API_KEY"]' < "$SETTINGS_FILE")
    fi
    [ -n "$base" ] && [ -n "$token" ] || die "no ANTHROPIC_BASE_URL or token found"
  fi
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
  # The token goes to curl on stdin, so it does not show in the process list.
  if [ "$auth_header" = "x-tdai-user-key" ]; then
    auth_header="x-tdai-user-key: %s"
  else
    auth_header="Authorization: Bearer %s"
  fi
  CURL_AUTH=$(printf "header = \"$auth_header\"\nheader = \"Content-Type: application/json\"\n" \
    "$(printf '%s' "$token" | tr -d '\r\n' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')")

  prompt=""
  if [ "$CLIENT" = "claude-code" ] && [ "$event" = "UserPromptSubmit" ] && [ "${AGENT_MEMORY_RECALL:-}" != "0" ]; then
    prompt=$(printf '%s' "$input" | json_get '["prompt"]' | head -c 8000)
  fi

  if [ -n "$prompt" ]; then
    # The report and the recall do not depend on each other: run them at the same time.
    send_report "$base" "$body" &
    export AM_PROMPT="$prompt"
    recall "$base" "$(build_report)"
    unset AM_PROMPT
    wait
  else
    send_report "$base" "$body"
  fi

  if [ "$event" = "SessionStart" ]; then
    self_update "$base"
  fi
}
main
exit 0
