# Codex and pi: reporting cwd and git info to MemoryProxy

Date: 2026-10-24. Versions tested: codex-cli 0.164.0, pi 0.80.1. Read-only on the repo; experiments used temp dirs (/tmp/cxh, /tmp/pih) and a local capture server on 127.0.0.1 (stopped afterwards). Nothing under ~/.codex or ~/.pi was changed.

## Outcome

- **Codex can use the existing hook.sh almost unchanged.** Codex has Claude-style hooks. Its `SessionStart` and `UserPromptSubmit` events send `session_id` and `cwd` on stdin. That `session_id` is byte-identical to the `session-id` header the proxy already uses as the session key. The proxy join works with no change to `resolveConversationId`. Two gaps remain: hook trust (the user must trust the hook, or the installer must pre-seed it), and the Codex runner never calls `withSessionProject`, so the L0 write would still carry no project.
- **pi needs a TypeScript extension plus one proxy-side header change.** pi's `session_start` and `input` events give `ctx.cwd` and `ctx.sessionManager.getSessionId()`. By default pi sends no session header to a custom OpenAI-compatible endpoint. Setting `compat.sendSessionAffinityHeaders: true` makes it send `session_id`, `x-client-request-id` and `x-session-affinity`, all equal to the extension's session id. The proxy reads none of those three names, so it has to learn one.
- The earlier research note (`plans/261022-1550-project-scoped-memory/research-client-capabilities.md`) says pi's `before_provider_headers` can inject a header. That hook does not exist in the installed 0.80.1 (only `before_provider_request`, which rewrites the body). Do not rely on it.

## 1. Codex

### Hooks system (verified)

- Docs: https://learn.chatgpt.com/docs/hooks (308 redirect from developers.openai.com/codex/hooks). Feature flag `hooks`: `codex features list` shows `hooks stable true` in 0.164.0. The docs name no minimum version; `[features] hooks = false` disables them and `codex_hooks` is a deprecated alias.
- Config: `~/.codex/hooks.json`, or inline `[hooks]` tables in `~/.codex/config.toml`, or the same under `<repo>/.codex/` (project layer only if trusted). All sources merge.
- Events: `SessionStart` (source: startup, resume, clear, compact, fork), `UserPromptSubmit` (matcher ignored; adds `turn_id`, `prompt`), `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`, and others. Handler types: `command` and `mcp_tool`.
- Stdin fields observed in a real run (SessionStart): `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `source`. UserPromptSubmit adds `turn_id` and `prompt`. `notify` exists as a `ConfigToml` key (seen in the 0.164.0 binary strings) but I did not read its docs or test it. It is believed to fire on turn completion only, which would be too late for a before-first-request report. Unverified.
- Plain stdout of SessionStart and UserPromptSubmit is injected as developer context. hook.sh already sends stdout to /dev/null, so it is safe. Default timeout 600 s; our curl uses `--max-time 2`.
- **Runs for `codex exec`: yes** (verified). With `--dangerously-bypass-hook-trust`, `codex exec "hi"` fired SessionStart then UserPromptSubmit before the first model request. The docs page is silent on this; the test is the evidence.
- **Trust gate (verified):** without trust, `codex exec` silently skips the hooks. No hook ran and no warning was printed in exec output. Trust is stored as `[hooks.state."<key>"] trusted_hash = "sha256:..."` in config.toml. Pre-seeding works: I wrote both entries into a temp config.toml and the hooks fired with no flag.
  - Get key and hash from `codex app-server` (JSON-RPC `initialize`, `initialized`, then `hooks/list` with `cwds`). It returns `key` (for example `/private/tmp/cxh/home/config.toml:session_start:0:0`) and `currentHash`.
  - The key contains the config path, event and index, so adding or reordering hooks changes keys. The hash changes when the hook definition changes. Compute them at install time, do not hard-code them.
  - Other options per the docs: managed hooks (`requirements.toml`, trusted by policy), or the user runs `/hooks` once.

### Session id sent to the proxy (verified by capture)

Request to `/v1/responses` carried: `session-id`, `thread-id`, `x-client-request-id` (all the same UUID), `x-codex-turn-metadata` (JSON with `session_id`, `thread_id`, `turn_id`, and `workspaces: {"<cwd>": {"has_changes": ...}}`), and body `client_metadata.session_id` and `prompt_cache_key` (same UUID).

- Hook `session_id` = `01a16c99-623a-7cc3-b2c4-91528f4f0665` = header `session-id` = body `client_metadata.session_id`.
- `extractCodexSessionId` (`MemoryProxy/src/pipeline/runners/codex.ts:196-208`) reads `x-parent-conversation-id`, then `session-id`, then `client_metadata.session_id`. The key is therefore the same value the hook reports, and `agentSource` is `"codex"` (`codex.ts:437`), matching the `/codex/:spaceId` URL segment.
- Resume or fork: the docs list `resume` and `fork` as SessionStart sources. Whether the id changes on each was not tested.
- Docs say subagent hooks use the parent session id. I did not test what `session-id` header a Codex subagent sends. Unverified.

### Gap in the Codex runner (verified by grep)

`withSessionProject` is called in `anthropic.ts:963`, `openai-chat.ts:983` and `mem-command-intercept.ts:166`. It is not called in `codex.ts`. The Codex archive context builds `tdaiIdentity` with `deriveTdaiIdentity(...)` only (`codex.ts:930-935`), so L0 writes from Codex carry no `projectKey`, even when a report exists. `resolveSessionProject` consumers (`memory-bridge.ts`, `skill-bridge.ts`, `client-tool.ts`) use the composite key `<agentSource>:<sessionId>` and would find a Codex report.

### Install approach

1. Reuse `~/.agent-memory/hook.sh codex`. The stdin fields (`session_id`, `cwd`, `hook_event_name`) are identical to Claude Code's, so the git lookup, device id and body builder do not change.
2. Two changes inside hook.sh/install.sh:
   - `install.sh` today rejects any client except `claude-code` (`install.sh:358`). Add `codex`.
   - hook.sh reads `ANTHROPIC_BASE_URL` and token from `~/.claude/settings.json`. For Codex it must read `~/.codex/config.toml`: the active `model_provider`'s `base_url` (for example `http://host/codex/default`; report URL is `base_url + /v3/hook/report`, which hits `/:agent/:spaceId/v3/hook/report` with agent=codex) and `experimental_bearer_token`. With the "own login" mode the key is in `http_headers = { "x-tdai-user-key" = ... }` instead; hook.sh would send it as the `x-tdai-user-key` header. Whether `stageAuth` accepts that header on the hook route was not checked.
3. Config snippet (inline form, one form per layer to avoid the merge warning):

```toml
[[hooks.SessionStart]]
matcher = "startup|resume|clear|fork"
[[hooks.SessionStart.hooks]]
type = "command"
command = "/Users/<u>/.agent-memory/hook.sh codex"
timeout = 5

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "/Users/<u>/.agent-memory/hook.sh codex"
timeout = 5

[hooks.state."<key from hooks/list>"]
trusted_hash = "<currentHash from hooks/list>"
```

   Skip `compact` in the SessionStart matcher, since it re-fires mid-turn.

### Field mapping (Codex hook stdin to report body)

| Report field | Source |
|---|---|
| `session_id` | stdin `session_id` |
| `cwd` | stdin `cwd` (real path, e.g. `/private/tmp/...` on macOS) |
| `hook_event` | stdin `hook_event_name` |
| `git_toplevel`, `git_remote` | `git -C $cwd ...` (existing code) |
| `device_id`, `os`, `arch`, `hostname` | existing `~/.agent-memory/device.json` and uname |
| `client` | `codex` (passes `CLIENT_RE`) |
| `hook_version` | `1` |

### Proxy-side change for Codex

- No change to the report route or to the key: `store.put({spaceId, userId, "codex", sessionId})` already matches the lookup key.
- Add `withSessionProject(...)` around the `deriveTdaiIdentity` call in `codex.ts:930`, with `{ spaceId, userId, agentSource: "codex", sessionId: sessionKey }`. Without this the L0 project tag never reaches Core for Codex.

### Risks (Codex)

- The hook is silently skipped when untrusted, and `codex exec` shows no warning. The installer should verify with `hooks/list` that `trustStatus` is `trusted`.
- Pre-seeded hashes break if Codex changes the hash scheme, and the key changes when hooks are reordered. Fail safe: the report is then absent and the proxy treats it as "no project".
- A user opening `/hooks` can disable the hook; no report means no project, which is the safe default.
- A parallel hook that prints to stdout would inject context into the model; hook.sh already sends all output to /dev/null.
- Codex needs `--dangerously-bypass-hook-trust` in no scenario once trust is seeded; do not use that flag in the installer.

## 2. pi

### Extension API (verified, docs and a live run)

- Docs: `/Users/dale/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`. Global location `~/.pi/agent/extensions/*.ts` or `*/index.ts` (auto-discovered, no trust prompt for user-level files). Existing examples already live there (`orca-agent-status.ts`, `superset-hooks.ts`).
- Events: `session_start` (`event.reason` is startup, reload, new, resume or fork), `input` (raw user text, fires per prompt, `event.source` interactive, rpc or extension), `before_agent_start`, `before_provider_request` (payload only), `after_provider_response` (response headers only).
- Data: `ctx.cwd`, `ctx.sessionManager.getSessionId()`, `ctx.sessionManager.getCwd()`. `pi.exec(cmd, args)` runs commands; `fetch` is available in-process.
- Live run (`pi -p "hi"`, temp `PI_CODING_AGENT_DIR`): `session_start`, `input` and `before_agent_start` all fired in print mode, with `sid` = `01a16c9a-989c-730e-b265-ca0e2582933c` and the real cwd.
- No event can add request headers (checked `dist/core/extensions/types.d.ts`; no `before_provider_headers` in 0.80.1).

### Session id pi sends (verified)

- Default config (OpenAI-compatible provider via `models.json`, `api: openai-completions`): **no session header at all** (0 matches in the capture). `getCompat` defaults `sendSessionAffinityHeaders: false` (`pi-ai/dist/api/openai-completions.js:1186`). `prompt_cache_key` (body) is sent when the base URL contains `api.openai.com`, or when cache retention is `long` and `compat.supportsLongCacheRetention` is true (`openai-completions.js:519-521`). With `PI_CACHE_RETENTION=long` it would carry the session id with no compat flag, a second join key the proxy could read from the body. Less preferred: it depends on an env var, not a config file.
- With `"compat": {"sendSessionAffinityHeaders": true}` (provider or model level in `~/.pi/agent/models.json`, documented in `docs/models.md`): headers `session_id`, `x-client-request-id`, `x-session-affinity` are all the same UUID, equal to `ctx.sessionManager.getSessionId()` (`pi-coding-agent/dist/core/sdk.js:218` passes it as `sessionId`). The CHANGELOG line 1017 describes this flag. Only sent when cache retention is not `none` (`PI_CACHE_RETENTION`).
- pi's own `x-opencode-session` header applies only to opencode hosts.

### The mismatch, concretely

1. `openai-chat.ts:634-636`: `sessionKey = resolveConversationId(c) ?? resolveSessionKey(config, lcHeaders, path, body, keyId)`.
2. `resolveConversationId` (`session/session-key.ts:28-41`) checks `x-parent-conversation-id`, `x-conversation-id`, `x-session-id`, `x-claude-code-session-id`, `x-deepseek-harness-session-id`, `x-chat-id`, `x-thread-id`. pi sends none of these (default: no headers; with the flag: `session_id`, `x-client-request-id`, `x-session-affinity`, none in the list).
3. Fallback is `resolveSessionKey` (`guard-adapter.ts:515-530`), which returns the agent profile's `sessionKey(headers)` or `keyId`. The profile comes from a private costGuard extension (`guard-adapter.ts:176`) that I could not inspect. If its pi profile reads `session_id` or `x-session-affinity`, the mismatch may already be partly solved once the compat flag is on; check that first. `keyId` here is `apiKeyToKeyId(apiKey)` (`openai-chat.ts:619`; reassigned to `userId` only at line 644, after the session key is computed). So every pi session of one API key shares one session key.
4. The hook report is stored under `(spaceId, userId, "pi", <pi UUID>)`. `withSessionProject` (`openai-chat.ts:983-990`) looks up `(spaceId, userId, "pi", sessionKey)` with `sessionKey` = key id, so it never finds the report.
5. `resolveSessionProject` (memory-bridge, skill-bridge) splits the composite key `pi:<sessionKey>` and has the same mismatch.

### Install approach

1. File: `~/.pi/agent/extensions/agent-memory.ts`. Hook `session_start` (all reasons) and `input` (cheap; skip when same cwd and session already reported in-process). Collect `ctx.cwd`, `ctx.sessionManager.getSessionId()`, git via `pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"])` and `remote get-url origin` (strip userinfo like hook.sh does). POST JSON to `<proxy>/pi/<spaceId>/v3/hook/report` with bearer user key and 2 s timeout; swallow errors.
2. Proxy URL and key: read from `~/.pi/agent/models.json` (`baseUrl` minus the trailing `/v1`, and `apiKey`). `apiKey` and `headers` values in models.json may be env names or `!command` expressions (`docs/models.md`), so the extension must resolve them or read a small `~/.agent-memory/pi.json` written by the installer. Not verified whether the extension can use `ctx.modelRegistry` to get the resolved key.
3. models.json change (installer must merge, not overwrite, and must keep other providers):

```json
{ "providers": { "<proxy-provider>": { "compat": { "sendSessionAffinityHeaders": true } } } }
```

4. Extensions load at pi startup; `/reload` picks up a new one in a running session.

### Field mapping (pi to report body)

| Report field | Source |
|---|---|
| `session_id` | `ctx.sessionManager.getSessionId()` |
| `cwd` | `ctx.cwd` |
| `hook_event` | `"session_start"` or `"input"` (must stay within 64 chars; free-form) |
| `git_toplevel`, `git_remote` | `pi.exec` git calls |
| `device_id` | read `~/.agent-memory/device.json` (same file as hook.sh) |
| `os`, `arch`, `hostname` | `node:os` |
| `client` | `pi` |
| `hook_version` | `1` |

### Proxy-side change for pi

- Add a header to `resolveConversationId` so the key equals pi's session id. Pick `x-session-affinity` (or `session_id`). Hono header lookup is case-insensitive.
- Scope concern: `resolveConversationId` is shared by all OpenAI-chat clients. If another client sends `x-session-affinity` with a different meaning, its session key changes. Safer: add the header only when `agentSource === "pi"`, in `openai-chat.ts` near line 634, instead of globally.
- No change to `withSessionProject`, the route or the store: after the key matches, the existing lookup works.
- Existing pi sessions (no flag) keep the keyId fallback, so the change is backward compatible; the session just stays project-less until the flag is set.

### Risks (pi)

- Depends on `compat.sendSessionAffinityHeaders`, introduced in a recent pi release (CHANGELOG line 1017). Older pi ignores it: the session id never reaches the proxy and reports stay orphaned.
- The flag only affects `openai-completions`. If a user configures the proxy with another pi API type, the session header may not be sent. Not tested.
- Cache retention `none` disables the session headers.
- Extension code is unsandboxed, TypeScript, and loaded by pi at startup; a thrown error in a handler could affect the session. Wrap everything in try/catch.
- pi and its extension API are fast-moving (0.80.x). Pin tests to the event names used here.

## Ranking and recommendation

1. **Codex first.** Smallest delta: reuse hook.sh, add `codex` to install.sh, seed trust via `hooks/list`, add `withSessionProject` in `codex.ts`. Join key already correct.
2. **pi second.** Needs a new extension, a models.json merge, and a scoped proxy change in `openai-chat.ts`. All steps verified individually, but the models.json and key resolution inside the extension add install risk.
3. **Zero-install fallback for Codex cwd only:** the request header `x-codex-turn-metadata` carries `workspaces` keyed by cwd, so the proxy could derive the cwd without a hook. It has no git remote or device id, so the project identity would be weaker. Not recommended unless the hook trust step proves too fragile.

## Limitations

- Did not test Codex fork/resume ids, Codex subagent `session-id`, the Codex own-login `x-tdai-user-key` path on the hook route, or an end-to-end report to a running MemoryProxy.
- pi tested with an `openai-completions` custom provider only, print mode only (TUI is the same extension API per docs).
- Codex docs page text came through a summarizer; the key claims (events, fields, trust, exec) were then confirmed by running the CLI.

## Unresolved questions

1. Does `stageAuth` accept `x-tdai-user-key` on `/v3/hook/report` (needed for Codex own-login users)?
2. What `session-id` does a Codex subagent send, and does it match the hook's parent session id?
3. Scope of the pi header: global in `resolveConversationId` or only for `agentSource === "pi"`?
4. Is pre-seeding `trusted_hash` acceptable to the team (it bypasses the user's review step), or should the installer only print "run /hooks and trust"?
5. Can a pi extension get the resolved API key from `ctx.modelRegistry`, or must the installer write a separate config file?

Status: DONE
Summary: Codex hooks (SessionStart/UserPromptSubmit) run in `codex exec` and their `session_id` equals the `session-id` header the proxy already uses; the pi session id never reaches the proxy by default and needs `compat.sendSessionAffinityHeaders` plus a proxy header change. Both were verified with local captures; the Codex runner also needs a `withSessionProject` call.
