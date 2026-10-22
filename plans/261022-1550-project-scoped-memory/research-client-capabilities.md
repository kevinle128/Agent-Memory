# Client capability matrix for the lifecycle hook installer

Date: 2026-10-22 (Asia/Saigon). Author: researcher. Scope: the 9 clients that connect to MemoryProxy.
Evidence labels: **V** = verified in official docs or upstream source; **R** = verified in this repo; **U** = UNVERIFIED (inference or third-party only).

## 1. Result in one paragraph

Only Claude Code is a clean Group A client. CodeBuddy, dsh, opencode and Codex can be installed with a hook, but each has a gate that stops an automatic install from taking effect immediately (restart, trust review, or an experimental bridge). Pi, Hermes and OpenClaw have a hook-like extension point, but the hook's session id will not equal the session key the proxy sees, because these clients send either no session header or a static one. That join problem, not the install step, is the main blocker for them. OpenClaw should stay in Group C for a scope reason: its hooks run in a shared gateway process and its "cwd" is an agent workspace, not a project.

## 2. Matrix

| Client | Form tool (model-callable) | Shell tool and input | Hook system, events, payload | Session id matches proxy key? | Group | Conf. |
|---|---|---|---|---|---|---|
| claude-code | `AskUserQuestion` (R `session/claude-code/form.ts:19`) | `Bash {command, description?, timeout?, run_in_background?}` (V docs; R `detect.ts:193`) | Command hooks in `~/.claude/settings.json`. `SessionStart` and `UserPromptSubmit`. stdin has `session_id, cwd, transcript_path, hook_event_name`. stdout IS injected into context (V) | Probably yes. Header `x-claude-code-session-id` and hook `session_id` are both documented as "current session id". No page states equality (U, test it) | **A** | High |
| codebuddy (IDE; CLI shares the engine) | `ask_followup_question` (R `session/codebuddy/form.ts:17`) | IDE: `execute_command {command, requires_approval}` (R `detect.ts:194`). CLI: `Bash` (U) | Command hooks in `~/.codebuddy/settings.json`, CC-compatible. `SessionStart`, `UserPromptSubmit`. `session_id` and `cwd` present, but the `SessionStart` example omits `cwd` (V, docs inconsistent). stdout IS injected (V). Settings are snapshotted at startup and need `/hooks` review | Probably yes. Header `x-conversation-id`; IDE doc says session start is detected "by comparing conversationId" (U) | **A** (install needs restart or review) | Medium |
| codex | `request_user_input`, only in Plan mode (V source; R `agents/codex/README.md:48`). In Default mode it is unavailable | Model-dependent: `exec_command {cmd, workdir?, tty?...}` (V), `shell_command {command: string}` and `shell {command: string[]}` (R `detect.ts:196-197`; schema U) | Hooks on by default. `~/.codex/hooks.json` or `[hooks]` in `config.toml`. `SessionStart`, `UserPromptSubmit`. stdin: `session_id, cwd, transcript_path, model, turn_id, prompt`. Plain stdout IS injected (V). Non-managed hooks need trust review in `/hooks` before they run | Yes for root sessions. Header `session-id` is derived from the same `session_id`; source comment says session identity is kept "in turn metadata, hooks" (V `core/src/client.rs`) | **A in Plan mode, B in Default mode.** Trust gate applies to both | Med-High |
| workbuddy | `AskUserQuestion`, only in older builds. Newer builds ship no ask tool (R `session/client-capabilities.ts:20,82`) | `Bash {command, description}` (R `detect.ts:193`) | CC-style hooks in `~/.workbuddy/settings.json`. `SessionStart`, `UserPromptSubmit` fire (V community test). Payload has `session_id`, `transcript_path`, `prompt`. `cwd` is documented but not seen in tests (U). Needs a full app restart. Stdout injection not documented (U) | Unknown (U). Proxy reads header `session-id`, then `x-conversation-id`, then `client_metadata.session_id` (R `workbuddy.ts:198-216`) | **A (old) or B (new)**, version-dependent | Low-Med |
| dsh | `ask_user_question` (R `session/dsh/form.ts:55`) | `bash {command, description, workdir?, run_in_background?}` (V upstream `tool-bash`; R `detect.ts:195`) | No native hooks file. Official bridge plugin `@deepseek-ai/dsh-hooks-claude-code`, mounted in `~/.dsh/profiles/web/cordis.patch.yml`, reads a CC-format hooks file once at startup. `SessionStart`, `UserPromptSubmit`. stdin: `session_id, cwd, transcript_path (always ''), hook_event_name`. Package sits under `packages/experimental` | Yes. Header carries the exact `Session.id`; the hook `session_id` is `agent.session.header.id` (V) | **A** (experimental bridge, restart needed) | Medium |
| opencode | `question` (R `session/opencode/form.ts:64`) | `bash` in 1.x (R `detect.ts:195`, `form.ts` whitelist). Current docs list `shell` (V). Input `{command, ...}` (schema U) | Plugin system, not command hooks. Drop a TS file in `~/.config/opencode/plugins/`. 1.x: `event` (`session.created`) and `chat.message` hooks with `sessionID`. 2.x: `ctx.session.hook("prompt")`. Plugins can `fetch` and run shell | Root sessions: yes, header `x-session-id` is `parentID ?? fork.sessionID ?? id` (V `core/src/session/affinity.ts`). Child and forked sessions: no. 1.x sending this header is U | **A** (via plugin) | Medium |
| pi | none built in (R `preset.ts:32`). Extensions get `ctx.ui` dialogs but the model cannot call them | `bash {command, timeout?}` (V `core/src/tools/bash.ts`) | Extensions: TS file in `~/.pi/agent/extensions/`. Events `session_start` and `input`. `ctx.cwd` and `ctx.sessionManager.getSessionId()` available. Runs in-process, can `fetch`. `before_provider_headers` can add headers | **No** by default. Session headers are sent only if `sendSessionAffinityHeaders` is true, default false for non-OpenRouter endpoints (V). Proxy has no `session_id` underscore header in its list (R `session-key.ts:32-39`) | **B** (join problem) | Medium |
| hermes | Upstream has `clarify {questions[]}` (V). Repo says none (R `preset.ts:15-31`). Conflict, see section 4 | `terminal {command, timeout?, workdir?, ...}` (V upstream) | Shell hooks: `hooks:` block in `~/.hermes/config.yaml`. `on_session_start`, `pre_llm_call` (once per user turn). stdin: `session_id, cwd, profile, extra`. stdout must be JSON; empty is fine. First use of each hook needs consent, or `HERMES_ACCEPT_HOOKS=1`, `hooks_auto_accept: true`, or an entry in `~/.hermes/shell-hooks-allowlist.json` | **No.** Proxy key is a static `x-conversation-id` from config (R `agents/hermes/README.md:40`); Hermes generates its own runtime session id | **B, conditional** on the join fix | Med-Low |
| openclaw | Upstream has `ask_user` (V), but only on chat surfaces with question input. Repo says none (R `preset.ts`) | `exec {command, workdir?, timeout...}` (V) | Two systems. Internal hooks (`HOOK.md` + handler) and typed plugin hooks (`session_start`, `before_prompt_build`). Both run inside the Gateway process, not the user's shell. Some hooks need `allowConversationAccess` | **No.** Static `x-conversation-id` (R `agents/openclaw/README.md:64`) | **C** (scope, plus join problem) | Med-Low |

## 3. Per-client notes

### claude-code
- Proxy header: `x-claude-code-session-id`, third fallback after `x-conversation-id` and `x-session-id` (`session-key.ts:31-37`). Subagents add `x-claude-code-agent-id` and keep the session id (`session-trace/subagent.ts:42-49`).
- Config for the proxy: `~/.claude/settings.json` `env.ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` (`agents/claude-code/README.md:19-33`).
- Hooks, from https://code.claude.com/docs/en/hooks: handlers merge across `~/.claude/settings.json`, project and local files. `SessionStart` has `source` of startup, resume, clear, compact, fork, so `session_id` changes with resume, fork and clear. Edits to settings are picked up by a file watcher, which would let a hook installed by the "Install now" Bash call work in the current session (U for the case where no `hooks` key existed at startup, test it). Exit 0 with plain stdout adds context for both events, so the hook must print nothing, send stderr to `/dev/null` and exit 0. `UserPromptSubmit` default timeout is 30 s. Hooks run in `-p` mode (indirect evidence only).
- Header doc: https://code.claude.com/docs/en/llm-gateway-protocol (header added in v2.1.86).

### codebuddy
- The proxy's `codebuddy` source is the IDE plugin: 26 tools including `execute_command`, `x-conversation-id` header (`agent-adapters/codebuddy.ts:18-20`). CodeBuddy Code (CLI) shares hook docs. Hook config and payload docs: https://www.codebuddy.ai/docs/cli/hooks and the IDE page https://cloud.tencent.com/document/product/1831/134517 (7 events, user file `~/.codebuddy/settings.json`).
- Gates: CLI doc says settings edits "do not hot-load" and need `/hooks` review. Plugin `hooks/hooks.json` is not gated, so a plugin install may be the lower-friction path (U).
- Version trap: 4.10.2 to 4.10.4 send no session id (`agents/codebuddy/README.md:39-42`), so hooks and form both fail there.
- Proxy config: `~/.codebuddy/models.json`.

### codex
- Docs: https://learn.chatgpt.com/docs/hooks (redirect of developers.openai.com/codex/hooks). Source: `codex-rs/hooks/src/events/session_start.rs` (`session_id: ThreadId`), `codex-rs/codex-api/src/requests/headers.rs` (`session-id`, `thread-id`), `codex-rs/core/src/client.rs:679-686`.
- Session key: proxy uses `session-id` header, then `client_metadata.session_id` (`pipeline/runners/codex.ts:197-207`). It does not go through `resolveConversationId`.
- Form: `request_user_input` is offered only in Plan mode unless the `DefaultModeRequestUserInput` feature is on (V `codex-rs/tools/src/tool_config.rs:6-15`). The repo already handles the Default-mode refusal as a permanent skip (`agents/codex/README.md:95-112`).
- Trust: an installed hook does not run until the user trusts it in `/hooks`, unless Codex starts with `--dangerously-bypass-hook-trust`. Trust is stored as per-hook state in config (`HookStateToml`); how to pre-seed it is U. Plain stdout is injected, so print nothing.
- Proxy config: `~/.codex/config.toml`.

### workbuddy
- Repo evidence: `AskUserQuestion` appears in `body.tools` only in older builds; new builds get a text-only form (`client-capabilities.ts:8-12,82`). So the proxy must probe `body.tools` per request to choose A or B.
- Hook evidence is third-party: https://developer.cloud.tencent.com/article/2713175 (path `~/.workbuddy/settings.json`, hooks fire only with a workspace open, full quit needed after edits). The Tencent Enterprise page documents `.codebuddy` paths for the IDE and lists `cwd`; do not rely on it for WorkBuddy. Windows users report a 10 s timeout on `UserPromptSubmit` (https://github.com/Tencent/teamai-cli/issues/1216), so keep the hook fast.
- Proxy config: `~/.workbuddy/models.json`.

### dsh
- Upstream: https://github.com/deepseek-ai/deepseek-harness, `packages/experimental/hooks-claude-code/README.md` and `src/index.ts:331`. Config is read once per process, a relative `configPath` resolves from the launch cwd, so one hooks file covers the whole process. Hook cwd equals the session cwd.
- Install means editing `cordis.patch.yml` (also used for the proxy config, `agents/dsh/README.md:66-100`) and restarting. A failed parse logs a warning and runs no hooks, which hides errors from the user.
- Proxy header: `x-deepseek-harness-session-id` (`session-key.ts:36`), value `session-<uuid>`.

### opencode
- Plugin loading: https://opencode.ai/docs/plugins and https://opencode.ai/docs/config (global dir `~/.config/opencode/plugins/`, loaded at startup). V2 hooks: https://opencode.ai/v2/docs/build/plugins (`ctx.session.hook("prompt")`; no session-created hook; `ctx.location.directory` is the plugin instance location, not per session).
- A plugin could report: yes, with `fetch` and `$` for git. For the cwd of each session in 2.x use `ctx.location.directory` (U that it equals the session cwd).
- Repo contradiction: `agents/opencode/README.md:54` says opencode sends no session id, but `subagent.ts:59-62` and upstream `packages/core/src/session/model-request.ts` show `X-Session-Id` and `x-parent-session-id`. The repo test harness used OpenCode 2.0.18 (`agent-adapters/opencode.ts:7-13`); behavior on 1.x is U.
- Shell tool name changed between versions (`bash` in 1.x per `form.ts` whitelist, `shell` in current docs). The proxy's executor list has `bash` but not `shell {command: string}` (`detect.ts:192-198`).
- Proxy config: `~/.config/opencode/opencode.json`.

### pi
- Source: https://github.com/earendil-works/pi, `packages/coding-agent/docs/extensions.md`, `src/core/extensions/types.ts:755,1171`, `docs/models-configuration.md:136`, `src/core/tools/bash.ts:40`.
- An extension can solve the join problem itself: `before_provider_headers` can add `x-conversation-id = sessionManager.getSessionId()`. Whether to do that is a design choice for you (section 4).
- Pi has no `agents/pi/README.md` and is not in `setup-proxy.sh`. Proxy config is `~/.pi/agent/models.json` with `headers` (V docs; the repo has no pi setup text).
- Extensions run with full user permissions; no trust prompt for user-level files.

### hermes
- Source: https://github.com/NousResearch/hermes-agent, `website/docs/user-guide/features/hooks.md` (Shell Hooks section, consent model), `tools/clarify_tool.py:136`, `tools/terminal_tool.py:1569`.
- The repo marks Hermes as having no form UI (`preset.ts:15-31`). Upstream main registers `clarify` in the `coding` toolset. I could not tell whether the build behind the proxy exposes it or renders it (U). Treat Hermes as no-form until tested on a real capture.
- Wire protocol disagreement: `supported-agents.ts` says anthropic; `agents/hermes/README.md:3` says OpenAI Chat. Not my scope, but the shell tool-call shape depends on it.
- `pre_llm_call` stdout is parsed as JSON and `{"context": ...}` is injected. Empty output is safe.

### openclaw
- Source: https://github.com/openclaw/openclaw, `docs/automation/hooks.md`, `docs/plugins/hooks/reference.md`, `docs/tools/exec.md`, `docs/tools/ask-user.md`.
- Hooks run in the Gateway, which may serve many chat channels. "cwd" there is the agent workspace; project-scoped memory has no real meaning. Recommend keeping it outside the mandatory-hook rule. If you decide otherwise, a plugin with `session_start` plus `before_prompt_build` is the route (needs `allowConversationAccess`, U for exact ctx fields).

## 4. Cross-cutting findings

1. **Hook-to-proxy join key.** Only claude-code, codex, dsh and (root) opencode have a hook session id that equals the proxy's key. Pi, Hermes and OpenClaw do not, and codebuddy and workbuddy are unconfirmed. A report keyed by `(user, device_id, session_id)` would be orphaned for those clients. Options: (a) key reports by `(user, device_id, cwd)` for these clients; (b) have a plugin inject the header (pi `before_provider_headers`; opencode `http.request` hook); (c) exclude them. Decision belongs to you.
2. **"Install now" is not "active now".** Immediate: claude-code (file watcher per docs), openclaw (hybrid reload), hermes (re-read within about 30 s but needs consent). Next start: codebuddy (plus `/hooks` review), dsh, workbuddy (full quit), opencode and pi (plugin and extension load at startup; `/reload` for pi). Blocked until the user trusts: codex. The auto-install flow should tell the user to restart, and Phase 4 `--session` immediate report is the only bridge for the current session.
3. **stdout injection.** Claude Code, CodeBuddy and Codex put plain hook stdout into model context. The hook must print nothing, redirect stderr, and always exit 0 (exit 2 blocks the prompt in CC and CodeBuddy). WorkBuddy and dsh behavior is U, so apply the same rule.
4. **Shell tool mapping gap.** Auto-install via a returned tool call can use `findExecutorTool` (`detect.ts:192-209`), which already covers `Bash`, `execute_command`, `bash`, `exec_command`, `shell`. Missing: `shell {command: string}` (opencode current, codex `shell_command`), `terminal {command}` (hermes), `exec {command}` (openclaw). Pi's tool is `bash {command, timeout?}` and matches the existing `bash` entry only if `description` is optional there (U).
5. **Windows.** Hook commands for CC, CodeBuddy and Hermes need a `bash` or a platform command. The installer should not assume a POSIX shell; Codex has `commandWindows`, Hermes spawns `.sh` through Git Bash.

## 5. Recommended rollout order

1. claude-code (A, High). Matches Phase 7 as planned.
2. codebuddy (A). Same JSON shape as CC; add the restart or `/hooks` review message.
3. dsh and opencode (A). Both need a client-specific installer artifact (patch file entry, plugin file) rather than a settings merge.
4. codex (A or B). Ship the hook, but tell the user to trust it in `/hooks`. Without that step reports never arrive.
5. workbuddy (A or B by version). Gate on the `body.tools` probe; keep unverified until a real capture shows the hook payload and header equality.
6. pi (B). Only after you pick the join option (finding 1).
7. hermes (B, conditional). Same, plus a capture of its tool list to settle `clarify`.
8. openclaw (C). Leave out of the mandatory rule.

## 6. What this research did not cover

- No client was run. All hook behavior comes from docs and upstream source, not from a live capture. The plan's Phase 0 captures remain the only proof for session id equality and for "hook active in current session".
- The shell tool schemas for codex `shell` and `shell_command`, opencode `shell`, openclaw `exec` were not read at field level beyond what is cited.
- WorkBuddy and CodeBuddy IDE are closed source; claims about them rest on vendor docs and one community article.
- Windows and non-interactive (`-p`, headless) hook behavior were not tested for any client.

## 7. Unresolved questions

1. For pi, hermes and openclaw, which join option in finding 1 do you want (device and cwd key, header injection by plugin, or exclude)?
2. Is the mandatory rule meant to cover OpenClaw at all, given its hooks run in a shared gateway and have no project cwd?
3. For Codex, accept a "trust it in /hooks" step as part of Install now, or try to pre-seed the trust state (needs a source read of `HookStateToml` to see if it is safe)?
4. Which CodeBuddy product do your users run: the IDE (`execute_command`) or the CLI (`Bash`)? The hook path is shared but the shell tool name differs.
5. Is the Hermes build behind the proxy exposing `clarify`, and does the repo's "no form" claim still hold?
6. Which opencode versions must be supported, 1.x or 2.x? The plugin API and the session header differ.
