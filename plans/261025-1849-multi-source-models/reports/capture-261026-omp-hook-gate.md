# Capture: omp 18.6.3 traffic for the hook gate (2026-10-26)

Method: `omp` 18.6.3, temporary HOME and `PI_CODING_AGENT_DIR` (the real `~/.omp` is untouched), a local mock
on 127.0.0.1 that logs each request (auth headers redacted) and answers with a short stream in the matching
format. `omp -p --model cap/capmodel "say hi"` and the TUI (tmux, prompt typed with send-keys) were run per format.
The provider has `compat.supportsPromptCacheKey: true`. A second mock answered the first TUI main request with a
`bash` tool call (id `call_omp_hook_gate_1`) to see how the next turn replays it. All values below are observed.

## Signal that tells TUI from `-p`

| Format | Path | User-Agent | Tool list in TUI | Tool list in `-p` | stream |
|---|---|---|---|---|---|
| anthropic-messages | `/omp/<s>/v1/messages?beta=true` | `claude-cli/2.1.280 (external, cli)` | `_read _bash _edit _ask _eval _glob _grep _task _wait _todo web_search _write` | same without `_ask` | true |
| openai-responses | `/omp/<s>/v1/responses` | `omp/18.6.3` | `read bash edit ask eval glob grep task wait todo web_search write` | same without `ask` | true |
| openai-completions | `/omp/<s>/v1/chat/completions` | `omp/18.6.3` | same as Responses | same without `ask` | true |

- The only reliable difference is the `ask` tool (`_ask` in the Anthropic format). No header differs between TUI and `-p`.
- The TUI also sends a title request with no tools at all (one per format, its own session id). It has no `ask`, so it is not gated.
- Anthropic tools are a flat `tools[].name`; Responses tools are flat `tools[].name`; chat tools are `tools[].function.name`.

## Shell tool

- Names: `_bash` (Anthropic), `bash` (Responses, chat).
- Arguments: `command` and `i` (short intent) are required; optional `timeout cwd pty async name ready`. The gate sends `{"command": ..., "i": ...}`.

## Session id

- Anthropic: header `x-claude-code-session-id`; the same value is in `metadata.user_id` (a JSON string `{"session_id":"..."}`).
- Responses and chat: body field `prompt_cache_key` (no session header). Needs `compat.supportsPromptCacheKey: true`.
- The id differs between the title request and the main request of one TUI session, so the gate reads it from the request it gates.

## How a gate turn appears on the next request

The tool ran and omp replayed history (output `gate-test\n\n\nWall time: 0.06 seconds`):

- Anthropic: `{role:"assistant", content:[{type:"tool_use", id:"call_omp_hook_gate_1", name:"_bash", input:{command,i}, cache_control}]}` then `{role:"user", content:[{type:"tool_result", tool_use_id:"call_omp_hook_gate_1", content:"<text>", is_error:false, cache_control}]}`. The user prompt before it is a plain string.
- Responses: items `{type:"function_call", call_id:"call_omp_hook_gate_1", name:"bash", arguments:"<json string>"}` (the `id` the stream gave is dropped) and `{type:"function_call_output", call_id, output:"<text>"}`.
- Chat: `{role:"assistant", content:"", tool_calls:[{id, type:"function", function:{name:"bash", arguments:"<json string>"}}]}` and `{role:"tool", content:"<text>", tool_call_id}`.
- The user prompt is split in two parts: a `<system-reminder>` block and the real prompt text.
- Gate text answers were not captured (they are plain assistant text, found by the marker at the start).
