# Codex CLI 0.164.0 hook gate: wire-level research

Date: 2026-10-24 (Asia/Saigon). Read-only research. Scratch files are in `/tmp/gate/` (fake upstream stopped, captures kept).

## Bottom line

The gate is feasible on the Codex wire, and simpler than the Claude Code one in one respect: the original user prompt is already in `input[]`, so "strip the synthetic turns and forward" is a pure delete of two items. Four findings change the design you described:

1. **The shell tool is not one tool.** It depends on the model slug. `gpt-5.5` and unknown slugs get a `function` named `exec_command` (argument `cmd`). The `gpt-6-*` slugs (the e2e default is `gpt-6-astra`) get NO `tools[]` key at all. Their tools arrive as an `input[]` item of type `additional_tools`, and the only way to run a command is a **custom** tool `exec` whose input is raw JavaScript (`await tools.exec_command({...})`). The gate has to emit a `function_call` or a `custom_tool_call` according to what the request offers.
2. **`require_escalated` is needed in the sandboxed cases and is rejected in the unsandboxed one.** With `approval policy = never` an escalated call is rejected, even under `danger-full-access`. The request body carries the approval policy and sandbox mode in plain text, so the gate can choose.
3. **`codex exec` cannot run the installer unless the user already runs with full access.** The default sandbox blocks both `~/.codex`, `~/.agent-memory` and the network, and `exec` has approval `never`. So gating `exec` is pointless. Gate `originator == "codex-tui"` only.
4. **The TUI sends a second request per first prompt: a title request with its own `session-id` and no tools.** The adapter does not classify it as auxiliary (`thread_source: "thread_title"` is not in `CODEX_AUX_THREAD_SOURCES`). The gate must pass it, or it will answer a tool call the client cannot execute.

Recommendation: build it, TUI only, fail open everywhere else, one install attempt per session then a text fallback. Details below.

Legend: **[V]** verified live against `codex-cli 0.164.0` and a fake Responses upstream; **[S]** verified in repo source; **[I]** inferred, not run.

## 1. Request shape [V]

Setup: temp `HOME`/`CODEX_HOME`, `wire_api = "responses"`, `base_url = http://127.0.0.1:18999/codex/default`, python fake upstream logging every request (`/tmp/gate/srv.py`, captures in `/tmp/gate/reqs.jsonl`). Bearer token redacted.

Path: `POST /codex/default/responses` (no `/v1`). HTTP SSE, not WebSocket.

Headers (redacted):

```
originator: codex_exec            (codex-tui in the TUI; the clientInfo.name for app-server)
user-agent: codex_exec/0.164.0 (Mac OS 26.6.2; arm64) unknown (codex_exec; 0.164.0)
session-id: 01a16ea5-a106-7a43-bfe3-63f9fdeee66a
thread-id:  01a16ea5-a106-7a43-bfe3-63f9fdeee66a      (equal to session-id in every run)
x-client-request-id: <same uuid>
x-codex-window-id: <uuid>:0
x-codex-turn-metadata: {"session_id":..,"thread_id":..,"request_kind":"turn","thread_source":"user",
   "turn_trigger":"exec","sandbox":"seatbelt","sandbox_mode":"read-only","model":"gpt-5",...}
authorization: REDACTED
```

Body keys: `model, stream:true, input, tools, tool_choice:"auto", parallel_tool_calls, reasoning, store:false, include:["reasoning.encrypted_content"], prompt_cache_key, client_metadata{session_id, thread_id, turn_id, ...}`. There is **no `previous_response_id`**: every request replays the full `input[]` (same as `agents/codex/README.md` says).

`input[]` of a first turn: developer message (base instructions, long), developer message (`<skills_instructions>`), developer message `<permissions instructions>` (see section 4), user message `<environment_context>`, user message with the prompt. `instructions` is not sent.

Tool list by model (same fake upstream, `/models` returns 404 from the proxy too, so Codex always uses its bundled catalog):

| model slug | where tools are | shell tool |
|---|---|---|
| unknown slug (`gpt-5` fallback), `gpt-5.5` | `tools[]` | `function` `exec_command`, plus `write_stdin`, `request_user_input`, `apply_patch`, `view_image`, goal tools, `web_search` |
| `gpt-6-astra` (all bundled `gpt-6*`/`gpt-5.6*` slugs share the catalog; only `gpt-6-astra` and `gpt-5.5` were run) | **no `tools` key**; `input[0]` = `{"type":"additional_tools","role":"developer","tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec",...},{"type":"function","name":"wait"},{"type":"function","name":"request_user_input"},...]}, ...]}` | `custom` `exec` (lark grammar, raw JS), nested `tools.exec_command(...)` |
| TUI (`codex -m gpt-5.5`, no `-a`/`-s`) | `tools[]`: `exec_command, write_stdin, list_mcp_resources, list_mcp_resource_templates, read_mcp_resource, request_user_input, apply_patch, view_image, goal tools, tool_search, web_search` | `exec_command` (`request_user_input` is listed even though its description says Plan mode only) |

`exec_command` schema (request, abridged): `{"cmd": string (required), "justification": string, "sandbox_permissions": "use_default"|"require_escalated", "prefix_rule": string[], "workdir", "login", "tty", "yield_time_ms", "max_output_tokens", "shell"}`, `additionalProperties:false`.

`shell_command` / `shell` / `local_shell`: the bundled catalog says `"shell_type": "shell_command"` for all 11 models, but no run in this build produced a `shell_command` tool (I tried `--disable unified_exec`, no change). **[I]** Treat as "may appear on other builds"; the detector should list them but they are untested.

The adapter's `isCodexAuxiliary` ([S] `MemoryProxy/src/agent-adapters/codex.ts:29-60`) knows `thread_source` values `memory_consolidation` and `system`. The TUI title request carries `thread_source: "thread_title"`, `tools` absent/empty, its own fresh `session-id`, and the prompt `Generate a concise, single-line task title ...`. It is classified `main`. **[V]** (captured, 2 per first prompt in the TUI).

## 2. SSE the server must return [V]

Verified against both tool kinds. Each event is `event: <type>\ndata: {"type":"<type>", ...}\n\n` (the `type` field inside `data` is required, same as in `MemoryProxy/src/session/codex/form.ts:577-581`).

Function call (`exec_command`), which Codex executed:

```
response.created              {response:{id,object:"response",status:"in_progress",output:[]}}
response.output_item.added    {output_index:0,item:{type:"function_call",id:"fc_...",name:"exec_command",arguments:"",call_id:"call_..."}}
response.function_call_arguments.delta {output_index:0,item_id:"fc_...",delta:"<args json>"}
response.function_call_arguments.done  {output_index:0,item_id:"fc_...",arguments:"<args json>"}
response.output_item.done     {output_index:0,item:{...,arguments:"<args json>"}}
response.completed            {response:{...,status:"completed",output:[<item>],usage:{input_tokens,output_tokens,total_tokens}}}
```

`response.in_progress` is optional (my fake omitted it, Codex ran the call; the existing `buildStreamingResponse` in `session/codex/form.ts` sends it and is also fine). The existing builder is hard-wired to `request_user_input`; it needs `name`/`arguments` parameters, and a second variant for the custom tool.

Custom tool (`exec`, gpt-6 family): same frame, but the item is `{"type":"custom_tool_call","id":"ctc_...","call_id":"call_...","name":"exec","input":"<raw JS>"}` and I sent only `output_item.added` (with `input:""`) and `output_item.done` (full `input`). No `custom_tool_call_input.delta/done` events were needed. **[V]** Codex ran it.

Text reply: `output_item.added` (message, `content:[]`) + `response.output_text.delta` + `output_item.done` + `completed`. **[V]** printed by Codex. The assistant item `id` is preserved in later `input[]` (`msg_x` came back after `codex exec resume`), so the fallback text can be recognised by an id prefix. **[V]**

Working command examples (`/tmp/gate/js1.txt`, `/tmp/gate/a1.json`):

```
function_call exec_command   arguments: {"cmd":"echo gate-ok > /tmp/gate/x"}
custom_tool_call exec        input: const r = await tools.exec_command({cmd:"echo gate-ok > /tmp/gate/x; echo done"}); text(r);
```

`gate-ok` was written under `--sandbox workspace-write` (fn call) and in the TUI after approval (custom call). Under the default read-only exec sandbox it was refused: `zsh:1: operation not permitted: /tmp/gate/x`.

## 3. Tool result in the next request, and stripping [V]

The next request replays the whole history plus the result as the last item. Shapes:

```
{"type":"function_call","id":"fc_gate_1792857742592","name":"exec_command","arguments":"{...}","call_id":"call_gate_1792857742592"}
{"type":"function_call_output","id":"fco_01a1...","call_id":"call_gate_1792857742592",
 "output":"Chunk ID: cef6fc\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 0\nOutput:\n..."}

{"type":"custom_tool_call","id":"ctc_...","call_id":"call_gate_...","name":"exec","input":"<js>"}
{"type":"custom_tool_call_output","id":"ctco_01a1...","call_id":"call_gate_...",
 "output":[{"type":"input_text","text":"Script completed\nWall time 0.1 seconds\nOutput:\n"},
           {"type":"input_text","text":"{\"chunk_id\":\"..\",\"exit_code\":0,\"output\":\"...\"}"}]}
```

Notes for the stripper:

- `call_id` is preserved, so a prefix such as `call_codex_hook_gate_` (like `TOOLCALL_PREFIX` in `session/codex/form.ts:26`) is enough. The item `id` is preserved too (`fc_`/`ctc_` prefix), but the output item gets a new `id`; match outputs by `call_id` only.
- `custom_tool_call_output.output` is an **array** of `input_text` parts, `function_call_output.output` is a **string**. Do not assume a string.
- Original prompt is already earlier in `input[]` (the user message `"run gate"` sits before the `function_call`). After removing `function_call` + its `*_output` (and the cancel marker below), the body equals the original request. No re-injection needed.
- Gate items must be stripped on **every** later request, not only the one right after install: the history keeps them for the rest of the session, after `resume` too (**[V]** resume keeps the same `session-id` and replays items).
- Cancel (user presses Esc on the approval prompt in the TUI) leaves **three** items: the output `{"output":"Wall time: 6.0 seconds\naborted by user"}` for the call, then a user message `<turn_aborted>\nThe user interrupted the previous turn on purpose. ...</turn_aborted>`, then the next prompt. The `<turn_aborted>` message directly follows a gate output and should be dropped with it. No model request is made after the cancel until the user types again. **[V]**
- Do not rely on a "form answer" the way Claude Code does. Codex shows no gate UI of our own; the state machine is: last `input[]` item is the gate's output means "install attempted".

Interaction with session-init: `codexFormAnswersAsMessages` and `detectCodexMore` look only at `call_id` starting with `call_codex_session_init_` ([S] `session/codex/form.ts:142-165, 233-250`), so a different prefix does not collide. The gate must still run **before** the session-init stage in `runners/codex.ts` (before line ~494 "7. Session-init state machine", after the aux passthrough and session id extraction at ~385-440), and the stripped body must be the one used by `countHumanTurnsResponses`, session-init and forwarding.

## 4. Sandbox and approval [V unless marked]

All runs: fake upstream returns a tool call; command output is read back from the next request.

Default `codex exec` in a fresh `HOME` (untrusted dir): `approval: never`, `sandbox: read-only` (header printed by `exec`). Behaviour per mode, for the command `mkdir ~/.agent-memory; write ~/.codex/t; curl http://127.0.0.1:18999/x` (HOME outside `/tmp` roots, enforced with `exclude_slash_tmp`/`exclude_tmpdir_env_var`):

| mode | `~/.agent-memory` write | `~/.codex` write | network (curl) |
|---|---|---|---|
| `read-only` | `Operation not permitted` | `operation not permitted` | exit 7 (blocked) |
| `workspace-write` (cwd not HOME) | not permitted | not permitted | exit 7 (blocked) |
| `danger-full-access` | ok | ok | ok (HTTP 404 from the fake) |

So the installer (`curl | bash`, writes `~/.codex/config.toml`, `~/.agent-memory/*`, runs `codex app-server`) cannot work in a sandbox without escalation. `install.sh` does exactly those writes ([S] `assets/client-hooks/install.sh:42-43, 799-870`).

Escalation (`sandbox_permissions:"require_escalated"` + `justification`; the old `with_escalated_permissions` field is gone in 0.164):

- `codex exec` (approval never), any sandbox including `danger-full-access` and `--dangerously-bypass-approvals-and-sandbox`: **rejected without running**. Function output string:
  `approval policy is Never; reject command — you cannot ask for escalated permissions if the approval policy is Never`.
  In code mode the nested call throws and the custom output is `Script failed ... Script error:\napproval policy is Never; reject command — ...`.
- TUI with `-a on-request -s workspace-write`: Codex shows a prompt. Verbatim from the pane:
  ```
  Would you like to run the following command?
  Environment: local
  Reason: Install Agent-Memory hook        <- the justification field
  $ <cmd>
  1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `<cmd>` (p)
  3. No, and tell Codex what to do differently (esc)
  ```
  `y` runs the command **unsandboxed** (it wrote `~/.codex/t`, and curl reached the network). Same prompt for the code-mode nested call. Option 2 stores a prefix rule, so `prefix_rule` is not worth setting. `codex exec --full-auto` is a usage error in 0.164.
- **TUI default, captured with no `-a`/`-s` flags** (temp HOME, untrusted cwd): `sandbox_mode` is `read-only`, network restricted, and the `<permissions instructions>` message contains the section `# Escalation Requests ... ## How to request escalation: provide sandbox_permissions "require_escalated" ... justification`, i.e. on-request behaviour. The other TUI runs above forced `-a on-request -s workspace-write` by flag. I did not capture a TUI default in a trusted project (it may pick workspace-write) or the user's real config. The two wordings are distinguishable: `never` says `Approval policy is currently never. Do not provide the sandbox_permissions ...`; on-request has the `# Escalation Requests` section.
- Not tested: `-a untrusted` (`unless-trusted`), `granular` approval, auto-review/guardian (`auto_review_enabled` in the metadata), Windows sandbox. **[I]** `untrusted` should also prompt for an escalated call.

The request tells the gate which case it is in. The developer message `<permissions instructions>` contains, for example:

```
`sandbox_mode` is `danger-full-access`: No filesystem sandboxing - all commands are permitted. Network access is enabled.
Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected.
```
and `<environment_context>` has `<permission_profile type="disabled">` for full access, `type="managed"` for sandboxed.

Decision table for the gate (I recommend the robust variant, not text parsing alone):

| situation | first attempt | on failure |
|---|---|---|
| approval `never`, sandbox `disabled` | plain command (no escalation fields). **[V]** runs | text fallback |
| approval `never`, sandboxed | do not install; text fallback with manual command | n/a |
| approval `on-request`/`untrusted` | escalated + justification | text fallback |

Parsing "Approval policy is currently X" couples the gate to prompt wording that OpenAI can change, and the text is model-visible. Alternative with no parsing: attempt 1 escalated; if the output contains `approval policy is Never; reject command`, attempt 2 plain (it works only in full access and otherwise fails harmlessly before writing anything because `mkdir ~/.agent-memory` is the first step); if that also leaves no report, text fallback. Cost: one or two extra round trips only for `never` sessions. I recommend this variant and using the `<permissions instructions>` match only as an optimisation. Open question 2.

Blocked or failed command, what the gate sees (all verified above):

| cause | last `input[]` item |
|---|---|
| sandbox blocks writes | `function_call_output` "...Process exited with code 1/0 ... operation not permitted" (exit code may be 0 if the script's last command succeeds, so do not use the exit code) |
| approval never + escalation | `approval policy is Never; reject command ...` |
| user Esc in TUI | `aborted by user` + `<turn_aborted>` message |
| tool not offered (title thread) | `unsupported call: exec_command` |

The only reliable success signal is the one you already have: the hook report exists for the session. Wait for the report (poll as `waitForReport`), then pass; otherwise answer text. The 10 s default yield of `exec_command` (30 s for `exec`) matters: `install.sh` may run `codex app-server` for up to 15 s ([S] install.sh:654-668), so the tool can return "running" before the report exists. Wait longer than Claude Code's 3 s default, 15-20 s, before concluding failure. **[I]** timing not measured against the real installer.

## 5. Interactive vs non-interactive [V]

| mode | `originator` | `user-agent` prefix | `x-codex-turn-metadata` |
|---|---|---|---|
| `codex` TUI | `codex-tui` | `codex-tui/0.164.0 (... ) tmux-256c` (terminal name in UA) | `thread_source:"user"`, `turn_trigger:"user"` |
| `codex exec` | `codex_exec` | `codex_exec/0.164.0 ...` | `thread_source:"user"`, `turn_trigger:"exec"` |
| `codex app-server` | the `clientInfo.name` the host sends (probe used `gate_probe`) | `<name>/0.164.0 ...` | no `thread_source`, no `turn_trigger` |
| TUI title request | `codex-tui` | same | `thread_source:"thread_title"`, no tools, new `session-id` |

Strings present in the binary **[I]**: `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` (env override of `originator`), `codex_sdk_ts`, `codex_vscode`, `Codex Desktop`, `codex_cli_rs` (older name, appears in `pool-forwarding.test.ts`). The SDK drives `codex exec` and can override the originator, so `originator` alone is a hint, like the User-Agent entrypoint for Claude Code.

Recommended rule (same philosophy as the Claude Code gate, fail open):

1. Gate only when `originator === "codex-tui"`. Everything else passes: `codex_exec` (cannot approve, and approval is `never`), app-server hosts and the SDK (unknown approval UI; some auto-decline).
2. Pass when no shell tool is offered (title request, `tools` empty, or none of `exec_command`/`shell_command`/`shell`/`local_shell` in `tools[]` and no `exec` custom tool in `additional_tools`). This is the real capability check, as `AskUserQuestion` is for Claude Code.
3. Pass for subagent threads. The runner already honours `x-parent-conversation-id` ([S] `runners/codex.ts:195-210`) but `subagent.ts:91` says "Codex subagent markers are not confirmed". The binary contains `x-openai-subagent` and `x-codex-parent-thread-id` **[I]**, not captured. Until confirmed, the main thread is always gated before any subagent can exist, so a child cannot start in an un-reported session; the leftover risk is a child of a session where the gate failed open.
4. Pass on `thread_source` in `{thread_title, memory_consolidation, system}` and the aux paths (`/responses/compact`, etc.), which `isAuxiliary` already covers for all but `thread_title`. Add `thread_title` to `CODEX_AUX_THREAD_SOURCES` as a separate fix (open question 5); it also stops that request from entering session-init with a throwaway session id.
5. Retry limit independent of detection: if the history already holds one gate attempt (a `call_codex_hook_gate_*` item) and the report is still missing, answer the text fallback once and then pass (fail open) for that session. Do not loop on every prompt. Claude Code's "Exit" has no equivalent here because there is no form.

## 6. Session id [S][V]

- Source in the proxy: `extractCodexSessionId` ([S] `runners/codex.ts:200-211`): `x-parent-conversation-id` header, else `session-id` header, else `body.client_metadata.session_id`. Codex 0.164 sends both `session-id` and `client_metadata.session_id`, equal values. **[V]**
- Hook side: the installer is called with `--session <sid>` and posts `session_id` to `/codex/<space>/v3/hook/report` ([S] `install.sh:1052-1059`; `routes/hook-report.ts:100-130` stores under `{spaceId, userId, agentSource: "codex", sessionId}`). The gate reads the same key (`SessionWorkspaceKey`) like `hook-gate.ts:152-158`. The gate passes `sid` from the `session-id` header into the command, so it matches by construction.
- Real traffic in `~/.cache/am-e2e/logs/proxy.log`: `[hook-report] session=01a16d8e-... agent=codex event=SessionStart` then `event=UserPromptSubmit`, same uuid shape as the request `session-id`. The report is sent at SessionStart (hook installed and trusted), i.e. before the first model request, so an installed machine never sees the gate. (The existing `scripts/qa/codex-pi-e2e.sh` C1/C3/C4 assert this join, resume and fork; I did not rerun it, it needs the Mongo stack.)
- Resume: `codex exec resume --last` kept the same `session-id` and replayed history. **[V]** Fork gets a new id (script C4 [S]); a fork of a gated session therefore has no report and gets gated again, and its inherited history holds the old gate items, which the stripper removes.
- The title request has a different `session-id` (new thread) and never gets a report, which is one more reason rule 2 above is mandatory.
- `x-parent-conversation-id`: if a subagent sends it, the gate would use the parent id and find the parent's report, which is the right behaviour.
- The session id charset: uuid v7, passes `SESSION_ID_RE` (`hook-gate.ts:104`).

## Design sketch (what the lead needs, no code written)

- New module `session/codex/hook-gate.ts` reusing the Claude Code gate's `lookupReport`, `waitForReport`, origin and command helpers (extract to a shared file instead of copying: DRY). Command: `curl -fsSL <origin>/setup/hooks.sh | bash -s -- --client codex --session <sid>`.
- Response builders: generalise `buildStreamingResponse` in `session/codex/form.ts` (or a sibling) to take `{kind:"function_call"|"custom_tool_call", name, args|input, idPrefix}` and add a text variant. Keep non-stream support (`body.stream !== false` handled as in the form builder).
- Detector `pickShellTool(body)` returns `{kind:"function", name:"exec_command"|"shell_command"|"shell"}` or `{kind:"code-mode"}` from `tools[]` / `input[].additional_tools`. Code-mode input: `await tools.exec_command({cmd: <command>, sandbox_permissions: "require_escalated", justification: "..."}); ` plus `text(r)`. Use a JS string literal built with `JSON.stringify(command)` (session id and origin are already regex-validated).
- State machine from the last item(s) of `input[]`: last item is a gate output means "attempt made"; wait for the report; pass (with the strip) or retry plain or text fallback.
- Strip function applied on every path, including `disabled`, non-TUI and `installed`: remove items with `call_id` starting `call_codex_hook_gate_` (call and output), the `<turn_aborted>` user message directly after a gate output, and assistant messages with `id` starting `msg_codex_hook_gate_`.
- Placement: `runners/codex.ts` after the aux passthrough (~line 385-400) and session id extraction (~440), before session-init (~494) and before `countHumanTurnsResponses`.
- The gate response never reaches upstream, so no L0/skill/billing write; mirror the Claude Code runner note ([S] `runners/anthropic.ts:673-693`).

## Risks

- **Prompt-injection look-alike.** A model-less proxy making Codex run `curl | bash` is the same trust model as the Claude Code gate, but in the TUI the user sees a plain approval prompt with a `Reason`. The justification text should say what is written (`~/.codex/config.toml`, `~/.agent-memory`). Option 2 of the prompt ("don't ask again for commands that start with ...") would whitelist the prefix; harmless but do not suggest it.
- **Auto-approve environments** (`approval=never` + `danger-full-access`, `--yolo`) run the installer silently, including in `codex exec`, if the gate were widened. Another reason to keep `codex-tui` only.
- **Model-dependent tool shape.** The `gpt-6-*` code-mode shape is new and could change between Codex releases. Unknown shape means fail open plus the text fallback. Add a test fixture per observed shape (captured payloads are in `/tmp/gate/reqs.jsonl`, they will be lost; copy the redacted samples above into fixtures).
- **Installer side effects in a running session.** The installer edits `~/.codex/config.toml` and runs `codex app-server` to trust the hooks. Hooks installed mid-session take effect only for new sessions; the explicit `--session` report covers the current one. Needs a live test.
- **Duration.** The installer can take longer than the tool's yield (10 s / 30 s); gate must wait for the report before declaring failure.
- **Resume/fork history.** Gate items persist in the Codex rollout file. A user who later runs Codex against a proxy without the gate (or directly against OpenAI) sends `fc_`/`ctc_` items with `call_gate` ids to OpenAI. Upstream OpenAI accepts a call+output pair, so it is harmless there, but the `<turn_aborted>` text and the text fallback persist in the visible transcript.
- **Title request misclassification** (finding 4) exists today independent of the gate.
- **Prompt text parsing** ("Approval policy is currently never") is not a contract.

## Not covered / not verified

- No run against the real proxy: the gate does not exist yet; only the fake upstream. Real-model behaviour after the strip is not tested (it cannot differ, the body equals the original).
- `shell_command`/`shell`/`local_shell` tool shapes, never produced by 0.164.
- Approval modes `untrusted`, granular, auto-review; Windows/Linux sandboxes (macOS seatbelt only).
- App-server/IDE hosts: the probe only showed `originator` = `clientInfo.name`; the approval round trip in VS Code or Desktop was not run.
- Subagent request headers (`x-openai-subagent`, `x-codex-parent-thread-id`) seen only as strings in the binary.
- `exec`/TUI behaviour of `parallel_tool_calls: true` with two gate calls: not needed, the gate emits one call.
- Real `install.sh` run from inside a Codex tool call (needs a running proxy and a hook report round trip).

## Unresolved questions

1. Scope: is TUI-only acceptable, or must VS Code / Desktop (app-server) clients be gated as well? That needs a live approval test per host.
2. Escalation strategy: parse `<permissions instructions>` up front, or use the attempt-escalated-then-plain retry (my recommendation)?
3. After one failed or declined attempt, fail open for the rest of the session (my recommendation) or keep blocking like the Claude Code "Exit" state?
4. Should the gate wait for the model slug rather than the tool shape (for example only `gpt-6-*`), or support both shapes from day one (my recommendation, both are small)?
5. Add `thread_title` to `CODEX_AUX_THREAD_SOURCES` in the same change, or in a separate fix? It changes billing/session-init behaviour for those requests, so it needs its own decision.
6. Is it acceptable that the visible Codex transcript keeps the "Install Agent-Memory hook" tool call and result after the install?

Status: DONE_WITH_CONCERNS
Summary: The gate is feasible on Codex 0.164 and the SSE sequences, tool-result shapes, sandbox/approval behaviour and session-id join were verified live against a fake upstream. Concerns: the shell tool differs per model (a custom JS `exec` tool for gpt-6 slugs), escalation is rejected under approval never, and only the TUI (`originator: codex-tui`) can realistically be gated.
