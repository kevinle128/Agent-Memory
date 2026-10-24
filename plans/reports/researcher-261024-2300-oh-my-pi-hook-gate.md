# oh-my-pi (omp) support and hook gate: research

Date 2026-10-24. Read-only. All captures are from the installed `omp` 18.6.3 against a fake upstream in `/tmp/omp-cap/` (`up.mjs`, `agent/models.yml`). Keys were fake and redacted.

## Bottom line

1. omp is a fork of pi (`can1357/oh-my-pi`). It runs pi extensions, and our `pi-extension.ts` works unchanged when it is placed in `~/.omp/agent/extensions/`. This was verified live.
2. The blocker is the session id. omp does not send `x-session-affinity` or `session_id` to a custom `openai-completions` provider, so `resolvePiSessionId` returns null for omp and the gate has nothing to key on.
   - Fix: add `compat.supportsPromptCacheKey: true` to the model in `models.yml`. omp then sends body field `prompt_cache_key`, and its value equals the id the extension reports (verified live).
   - The proxy must read `prompt_cache_key` for omp.
3. omp can be told apart from pi by `User-Agent: omp/<version>`. pi sends `OpenAI/JS 6.26.0`. Verified.
4. The gate mechanism works. omp ran a synthetic `bash` tool call in both `-p` and interactive mode with no approval prompt (default `yolo`). It sent back `role: tool` with the matching `tool_call_id`.
5. Recommendation: use the same `/pi/` route and `piAdapter`, and add a derived agent flavour for omp. Details in section 5.

## 1. What omp is

| Item | Finding | Evidence |
|---|---|---|
| Version | `omp/18.6.3` is installed. It is a compiled Mach-O at `~/.bun/bin/omp`, a symlink into `/Users/dale/Desktop/workspace/opensources/oh-my-pi/packages/coding-agent/dist/omp`. That checkout is 18.8.0 (HEAD `efbc17154a`, 2026-10-07). The omp TUI reports 18.12.6 as available. | `omp --version`; `packages/coding-agent/package.json`; TUI banner |
| Relation to pi | Fork of pi (author Mario Zechner is listed as a contributor). Package `@oh-my-pi/pi-coding-agent`, repo `github.com/can1357/oh-my-pi`, bin `omp`. The extension API keeps the `pi.on(...)` shape and a pi-compat loader. | `package.json`; `docs/extension-loading.md`; `plugins/legacy-pi-compat.ts` |
| Config dir | `~/.omp/agent` (default profile). `PI_CODING_AGENT_DIR` overrides it, but only for the default profile. `PI_CONFIG_DIR` changes the root name. Named profiles use `~/.omp/profiles/<name>/agent`. | `docs/models.md`; `docs/extension-loading.md`. Live: `PI_CODING_AGENT_DIR=/tmp/omp-cap/agent` was honoured. |
| Custom providers | `~/.omp/agent/models.yml` (or `.yaml`), root key `providers`. Fields: `baseUrl`, `apiKey` (an env var name or literal), `api`, `headers` (static), `models[]`, `compat`. A legacy `models.json` is migrated only if both yml files are missing. omp does not read `~/.pi/agent/models.json`. | `docs/models.md` |
| Wire APIs | `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-*`. | `docs/models.md` |

Two live findings that matter for the install script:
- The first interactive run on a fresh agent dir starts a setup wizard. Add `setupVersion: 2` to `config.yml` to skip it. This only affects my test harness.
- With stdin not closed, `omp -p` hangs at "readPipedInput". Use `</dev/null`.

## 2. Extensions

Evidence: `docs/extension-loading.md` and `docs/extensions.md`. The first four rows below were verified live; the rest come from the docs only.

- Native roots are `<cwd>/.omp/extensions` and `<agentDir>/extensions` (default `~/.omp/agent/extensions`). The `settings.json#extensions` list and `config.yml extensions:` also work. `.pi/extensions` is NOT scanned natively. `pi-extension.ts` must therefore be installed to `~/.omp/agent/extensions/agent-memory.ts`, not under `~/.pi`.
- `pi-extension.ts` loaded unchanged and POSTed to `/pi/space1/v3/hook/report` on `session_start`. The body had `session_id`, `cwd`, `git_toplevel`, and `git_remote` with `user:tok@` stripped.
- The report carries `client: "pi"`, which is hard-coded in the file.
- The context object has `cwd`, `sessionManager.getSessionId()`, `model.baseUrl`, and `modelRegistry.getApiKeyAndHeaders(model)`. The last one is a compat facade in `model-registry.ts:2997` that returns `{ok, apiKey, headers}`, so `resolveTarget` works as-is.
- The extension imports only node builtins, so no host-package rewriting is needed.
- Extra context fields in omp are `mode: "tui" | "rpc" | "json" | "print"`, `hasUI`, and `agent.kind: "main" | "sub"`.
- Extra events include `before_provider_request` (it can replace the payload but not headers) and `before_agent_start`.

Event firing, observed:

| Mode | `session_start` | `input` |
|---|---|---|
| `-p` | fired | NOT observed (no second report) |
| interactive TUI | fired at startup, before any prompt | fired before the chat request |

Hook reporting is therefore at startup in TUI mode. The first LLM request only follows later.

## 3. Request shape (captured live, openai-completions)

```
POST /pi/space1/v1/chat/completions
accept: text/event-stream
authorization: Bearer sk-...REDACTED
content-type: application/json
user-agent: omp/18.6.3          (hook-report fetch from the extension has the same UA)
```

No `session_id`, `x-session-affinity`, or other session header was present.

Body keys: `model, messages, stream:true, stream_options:{include_usage:true}, store:false, tools, max_completion_tokens`.

Messages:
- `system` is about 10.5 KB. It starts with "RFC 2119 keywords..." and contains `§ Role\nYou are omp's trusted coding assistant.`
- `user.content` is an ARRAY of parts, not a string: `[{"type":"text","text":"<system-reminder>\nToday: ...; current working directory: '...'. ...</system-reminder>"}, {"type":"text","text":"say ok"}]`.
- The first text part is a system-reminder with the date and cwd. `piAdapter.extractUserText` accepts only a string and otherwise delegates to `defaultAdapter`. I did not check what that does with this multi-part shape (see open questions).

Tools:

| Mode | Tool names |
|---|---|
| `-p` (11) | read, bash, edit, eval, glob, grep, task, wait, todo, web_search, write |
| interactive (12) | the same list plus `ask` |

Shell tool schema (abridged):
```json
{"name":"bash","parameters":{"type":"object","properties":{"i":{"type":"string","description":"concise intent"},"command":{"type":"string"},"timeout":{...},"cwd":{...},"pty":{...},"async":{...},"name":{...},"ready":{...}},"required":["command","i"],"additionalProperties":false}}
```

pi (for contrast, same fake upstream): UA `OpenAI/JS 6.26.0`, tools `read,bash,edit,write`, system prompt "You are an expert coding assistant operating inside pi...", bash args `{command}`.

### Session id carriers by API (all verified live; the extension-reported id was compared in rows 1, 2, and 4)

| omp provider setup | Where the session id appears | Equals extension id? |
|---|---|---|
| `openai-completions`, custom provider id | nowhere | n/a |
| `openai-completions`, custom id, `compat.supportsPromptCacheKey: true` | body `prompt_cache_key` | yes (`01a16eab-0b03-...`) |
| `openai-responses`, custom id | body `prompt_cache_key` | yes (`01a16ea8-92e9-...`) |
| `openai-completions` with provider id literally `openai` | headers `session_id` and `x-client-request-id` | yes (`01a16eaa-5525-...`) |
| `anthropic-messages` | headers `x-claude-code-session-id`, body `metadata.user_id` | not compared |

The anthropic row has a hazard. omp spoofs `User-Agent: claude-cli/2.1.280 (external, cli)` and the full Claude Code beta header set. A custom `anthropic-messages` model gets this shaping when `auth` is omitted (`docs/models.md`). The proxy would classify that traffic as Claude Code. Do not offer an anthropic route for omp until this is handled.

`sendSessionAffinityHeaders` does not exist in omp (grep over `ai/src`, `catalog/src`, `coding-agent/src` is empty). The `x-session-affinity` path that our pi install uses has no omp equivalent. The `provider id == "openai"` header path is in `inference-headers.ts:applyInferenceHeaders`. It is a hack that shadows the real OpenAI provider.

## 4. Tool-call round trip (live)

The fake upstream streamed this, in SSE chunks:

```
delta.tool_calls[0] = {index:0, id:"call_gate1", type:"function", function:{name:"bash", arguments:""}}
delta.tool_calls[0].function.arguments = "{\"command\":\"echo gate-ok > /tmp/omp-gate-x\"}"
finish_reason:"tool_calls"
```

Results:
- omp executed it in `-p` mode. The file `/tmp/omp-gate-x` contained `gate-ok`.
- In the interactive TUI it ran and rendered a `$ echo gate-ok > ...` box. There was no approval prompt, because the default `tools.approvalMode` is `yolo` (`docs/approval-mode.md`).
- I omitted the required `i` argument and omp still ran the call. Include `i` anyway, because the schema requires it and a stricter version may reject the call.

Next request, tail of `messages` (content shortened):
```json
{"role":"assistant","content":"","tool_calls":[{"id":"call_gate1","type":"function","function":{"name":"bash","arguments":"{\"command\":\"echo gate-ok > /tmp/omp-gate-x\"}"}}]}
{"role":"tool","content":"(no output)\n\nWall time: 0.03 seconds","tool_call_id":"call_gate1"}
```

Tool-result content for a command with output is plain text; for no output it is `(no output)` plus a wall-time line. The assistant turn keeps `content: ""` rather than null.

Approval risk: a user with `tools.approvalMode: always-ask` or `write` gets a prompt for `bash` in the TUI. In `-p` mode with no UI, "a call that still requires a prompt fails" (`docs/approval-mode.md`). Also, `bash` forces a prompt for "remote-fetch-then-execute" patterns, which the doc lists as critical safety overrides. Our command is `curl ... | bash`. In `yolo` a bare critical override is ignored, so it is fine by default. In other modes it will prompt, and for `-p` it will fail. Not tested.

## 5. Distinguishing omp, interactive vs non-interactive

| Signal | omp | pi | Reliability |
|---|---|---|---|
| `User-Agent` | `omp/<version>` (`USER_AGENT` in `utils/src/dirs.ts:37`) | `OpenAI/JS 6.26.0` | high, and the same UA appears on hook reports |
| system prompt | contains `omp's trusted coding assistant` | `operating inside pi` | medium (prompt text can change) |
| tools | has `eval`, `glob`, `grep`, `task` | `read,bash,edit,write` | medium |
| user content | array with a leading `<system-reminder>` | array with one text part | low |

Interactive vs non-interactive:
- Request side: the tool list has `ask` only in interactive mode (live: 12 vs 11 tools). This is a heuristic. A user can disable tools, and RPC/SDK modes are untested.
- Extension side (stronger): `ctx.mode` is `"tui" | "rpc" | "json" | "print"` per docs. The extension could include `mode` in the hook report, or skip reporting for non-`tui` modes. I did not test rpc or sdk.
- In `-p` mode the `input` event did not fire. Non-interactive runs report once at `session_start` only.

Route and adapter recommendation:
1. Keep the `/pi/<space>/v1` route and reuse `piAdapter` (all requests are main; no cache_control; same wire format).
2. Add an omp flavour derived from `User-Agent` (`^omp/`), used only for session-id resolution, install target, and gate command text. A separate agent source is more code than needed. The risk is if later omp-specific prompt or memory handling is wanted. Then a separate source becomes justified.
3. Gate command: `curl -fsSL <proxy>/setup/hooks.sh | bash -s -- --client omp --session <sid>`. `install.sh` needs an `omp` client that:
   - writes the extension to `~/.omp/agent/extensions/agent-memory.ts`;
   - edits `models.yml` (YAML, not JSON) to set `compat.supportsPromptCacheKey: true` on matching models;
   - keeps the extension's `client` field distinguishable (`"omp"`).

Note on the gate bootstrap: the current pi flow depends on `sendSessionAffinityHeaders`, which the pi install sets. For omp the `supportsPromptCacheKey` flag must already be present in `models.yml` BEFORE the first request, otherwise the proxy has no session id to put into the gate command (`hook-gate.ts:147` returns `pass("no-session-id")`). This means whatever creates the proxy provider entry for omp must write that flag, so the gate only has to install the extension.

## 6. Session id resolution

- `resolvePiSessionId` reads `session_id` or `x-session-affinity` headers (`session-key.ts:49`). For omp with a custom provider id it returns null (verified: no such headers). It works only under the `openai` provider-id hack.
- Proposed change: for omp, fall back to body `prompt_cache_key` after the header check. Wire it in `openai-chat.ts:635`, where `resolvePiSessionId` is already called. I have not implemented this (read-only task).
- `prompt_cache_key` equals the extension-reported `sessionManager.getSessionId()` on the first request. I compared values in `-p` and in the TUI (both `01a16eab-...` in the TUI run, in the hook reports and in both chat requests).
- The gate regex `SESSION_ID_RE` must accept omp ids. They are UUIDv7-style (`01a16eab-0b03-708d-8d4f-4bba152cad8e`). I did not check whether the regex accepts them.
- Subagent sessions: omp runs `task` subagents with their own `ctx.agent.kind === "sub"`. Their session id was not captured, so they may produce different `prompt_cache_key` values. They run with the same extension rebound (`docs/extensions.md`), so each could also report. Untested.

## Verified live vs inferred

Verified live (omp 18.6.3):
- UA and headers; absence of session headers on a custom completions provider.
- `prompt_cache_key` with `compat.supportsPromptCacheKey` (completions) and on the responses API.
- `session_id` header only under provider id `openai`.
- Extension loading from `~/.omp/agent/extensions` with the unchanged `pi-extension.ts`.
- Hook-report content.
- Tool-call execution in `-p` and in the TUI, with no approval prompt in default mode; the follow-up request shape.
- Tool list differences, and the pi comparison capture.

Inferred from docs/source only:
- Approval behaviour in `always-ask`/`write` modes and for `curl | bash` patterns.
- `ctx.mode` values.
- Named-profile paths.
- rpc/sdk behaviour.
- The `before_provider_request` payload-only limitation.

## Risks

- Version drift: the installed binary is 18.6.3, the doc source is 18.8.0, and 18.12.6 is current. UA format, `supportsPromptCacheKey`, and the extension dir were verified on 18.6.3 only.
- `prompt_cache_key` is a prompt-cache field. A user who sets it differently, or an omp release that changes it, breaks session joining. Mitigation: the gate degrades to pass-through when no id is found.
- Forwarding `prompt_cache_key` upstream is harmless for OpenAI-compatible backends, but some strict backends may reject unknown fields. Not tested against our real upstreams.
- Anthropic-messages mode for omp looks like Claude Code to the proxy (see section 3).
- The shell tool can be disabled or approval-gated by user config, so the gate can silently fail to run the installer. The gate should fall back to a plain text message when the tool result is missing or an error.

## Open questions

1. Does `defaultAdapter.extractUserText` handle omp's array content (system-reminder first, prompt second)? It matters for L0 writes and for the gate's "original prompt" extraction.
2. Which omp-provider setup will the product generate: `openai-completions` plus `supportsPromptCacheKey` (my pick) or `openai-responses`? The proxy currently exposes only the completions route for pi.
3. Should `-p`/rpc/sdk runs be skipped by the gate, as decided for Claude Code? If yes, the cheapest signal is the missing `ask` tool in the request; better is `ctx.mode` reported by the extension.
4. Does `SESSION_ID_RE` accept UUIDv7?
5. Should the extension report `client: "omp"` (detected from the model host or `ctx.mode`/process) so the proxy can pick the correct installer without relying on UA?

Status: DONE_WITH_CONCERNS
Summary: omp is a pi fork; it loads our pi extension unchanged from `~/.omp/agent/extensions/`, runs synthetic bash tool calls without approval in default mode, and is distinguishable by `User-Agent: omp/<ver>`. It sends no session header on a custom provider, so the gate needs `compat.supportsPromptCacheKey: true` in `models.yml` and a proxy fallback to body `prompt_cache_key`. All of this was verified on omp 18.6.3 only; approval modes other than `yolo` and rpc/sdk modes are untested.
