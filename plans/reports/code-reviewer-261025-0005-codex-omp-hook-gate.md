# Code review: Codex TUI and oh-my-pi hook-install gate

Date: 2026-10-25 (Asia/Saigon). Branch `feat/server_team`, uncommitted tree. Read-only review.
Plan: `plans/261024-2318-codex-omp-hook-gate/plan.md`. Research: `plans/reports/researcher-261024-2300-codex-hook-gate.md`, `researcher-261024-2300-oh-my-pi-hook-gate.md`.

## Scope

- Files: `MemoryProxy/src/session/hook-gate-core.ts` (new), `src/session/codex/hook-gate.ts` (new), `src/session/pi/hook-gate.ts` (new), `src/session/claude-code/hook-gate.ts`, `src/session/session-key.ts`, `src/agent-adapters/{codex,pi}.ts`, `src/pipeline/runners/{codex,openai-chat}.ts`, `src/types.ts`, `config.example.yaml`, `assets/client-hooks/{install.sh,pi-extension.ts}`, `agents/{claude-code,codex}/README.md`, 7 new test files and the snapshot, `scripts/qa/codex-omp-hook-gate-e2e.sh`.
- About 450 changed lines in tracked files, plus about 1,000 new lines in the gate modules and tests.

## What I checked

- `npx vitest run`: the 8 gate/adapter/session-id test files passed (184 tests). A wider run over `src/pipeline/runners`, `src/agent-adapters`, `src/session`, `src/__tests__/client-hooks*.test.ts` and `src/routes/__tests__/hook-report.test.ts` passed (19 files, 330 tests).
- `npx tsc --noEmit`: clean.
- **Claude Code output is unchanged (shown by a test, not by reading).** I copied `src` to `/tmp/mp-head`, put back the HEAD version of `claude-code/hook-gate.ts`, and ran the new snapshot test and the existing Claude gate tests. All 67 passed. So the snapshot was not just recorded from the new code: it also matches the old code.
- I ran `omp_models_edit` from `install.sh` by itself on 11 YAML shapes (results below).
- E2E: I did **not** see results from `scripts/qa/codex-omp-hook-gate-e2e.sh`, because another session owns the local proxy. My verdict rests on the unit tests, static review, and the HEAD comparison above.

## Overall assessment

The shared core is a faithful extraction. The Claude Code gate behaves the same. Cache keys include `agentSource`, so the shared cache cannot mix clients. The Codex and omp adapters are small and follow the same state machine, which is read from the conversation. The shell command is built only from a regex-checked origin and a regex-checked session id. No secret is printed. I found no Critical issue. There is one High risk that is not yet confirmed (Codex subagents). The rest are Medium and Low.

## Critical

None.

## High

### H1. Codex subagent threads may be gated: every child turn could return gate text instead of work (unverified)
- `MemoryProxy/src/session/codex/hook-gate.ts:101-122`, `src/pipeline/runners/codex.ts:177-188` (`extractCodexSessionId`), `src/session-trace/subagent.ts:91` (`detectCodex` returns null).
- The Claude Code gate skips subagent requests (`isSubagentRequest` in `claude-code/hook-gate.ts`). The Codex gate has no such check. Reports are stored per session id. `extractCodexSessionId` reads `x-parent-conversation-id` first, which is not the Codex header. The Codex binary has the strings `x-codex-parent-thread-id` and `x-openai-subagent` (research §3 lines 189/230, marked [I], not captured).
- Failure scenario: a TUI user with the hook installed starts a collab/`spawn_agent` child. If the child sends `originator: codex-tui`, offers `exec_command`, and sends its own new `session-id`, and the installed Codex hook does not report for child threads, then the child gets the escalated install call. If the child cannot get approval (it inherits `never`, or the approval goes nowhere), it gets the gate text as its only answer, and the parent gets that text as the subagent's result. This repeats for every new child, because each child is a new session and starts with 0 attempts.
- How to decide: on the local proxy with `hookGate.enabled: false`, record one child request. Note its `session-id`, `originator`, `x-codex-turn-metadata`, and whether `x-codex-parent-thread-id` / `x-openai-subagent` is present. Also check whether a hook report arrives for the child's session id.
- Simpler fix if the child's `thread_source` is not `user`: gate only when `x-codex-turn-metadata.thread_source === "user"`. Every captured TUI main turn carries that value (research table lines 176-181). This allow-list matches the decision "gate only interactive sessions" and also covers thread kinds we do not know yet.
- Fallback fix if the child also says `user`: in `runCodexHookGate`, pass (`reason: "subagent"`) when `x-codex-parent-thread-id` or `x-openai-subagent` is present. Or send the parent id to the gate key, the same way `x-parent-conversation-id` is handled now. Add a unit case.
- Verdict: does not block the merge (collab may be behind a flag in 0.164). It blocks production e2e sign-off until the capture is done.

## Medium

### M1. `check-result` tests for refusal before it looks for the report
- `src/session/codex/hook-gate.ts:139`, `src/session/pi/hook-gate.ts:153`, `hook-gate-core.ts:170`.
- `REJECTED_RE` matches `denied`, `reject`, `not allowed` and similar words anywhere in the tool output. Normal shell failures also contain these words (`Permission denied` from curl, mkdir or git), and so can a Codex sandbox message. The report is never read in that case.
- Failure scenario: the installer stored the report, but the output contains such a word, for example a `git` warning from `$PWD`. The user is told "not approved", and the original prompt is not answered. The next prompt passes because the report exists, so the cost is one lost turn.
- Fix: do one `lookupReport` first. If the report is found, pass. Only when it is missing, choose between the "rejected" answer (no wait) and `waitForReport`. This keeps the fast path for real refusals.

### M2. The installer's models.yml editor has no unit test
- `assets/client-hooks/install.sh:1014-1110` (`omp_models_edit`, `omp_install`). The only coverage is `codex-omp-hook-gate-e2e.sh` O3/O4, which needs real `omp`, `tmux` and a running proxy and covers one file shape. `src/__tests__/client-hooks-codex-pi.test.ts` has pi `models.json` cases but no omp cases.
- I ran the function by itself:
  - plain provider: the compat block is inserted after `baseUrl`. OK.
  - existing block compat with another key: the key is added. OK.
  - `supportsPromptCacheKey: false # old`: changed to `true`, and the comment is dropped. OK.
  - inline `compat: { a: 1 }`: left as it is, rc 3; other providers are still edited. OK.
  - 4-space indent, a comment in column 0, blank lines: OK.
  - flow provider `am: {baseUrl: ...}` and list-style `providers:` + `- am:`: no change, no corruption. OK.
  - quoted provider key containing `:`: OK. Last line without a newline: OK.
  - CRLF file: `providers:\r` does not match, so there is no edit and `--client omp` fails with "no proxy URL". No corruption, but the message is misleading.
  - Trailing blank lines: `new=$(...)` removes trailing newlines, so `write_if_changed` sees a change and rewrites the file (with a backup) even when no provider matched. This happens once, then the file is stable.
- Fix: add vitest cases next to the pi `models.json` tests in `client-hooks-codex-pi.test.ts`: no file; no proxy provider; existing flag (no rewrite, no backup); inline compat (rc 3, message, other providers edited); second run makes no new backup; `--session` with an env-var apiKey and with a literal apiKey (assert the key is never in stdout/stderr); `!cmd` apiKey refused. To keep a file that already ends with blank lines byte-identical, compare the awk output with the file before writing, or write the awk output to a temp file directly instead of using `$(...)`.

### M3. Compaction resets the attempt counter in failed-open Codex sessions
- `src/session/codex/hook-gate.ts:229-247`. The state is the history. After `/responses/compact`, the gate items are gone from the new history (they are also removed from the compaction input, `runners/codex.ts:413`).
- Failure scenario: a session that failed open (2 failed attempts) is compacted. The next prompt is gated again, and the user loses up to 2 more turns per compaction. This does not lock the user out, and the README already says compaction can make the gate ask again. Note it as known behaviour, or keep a small per-session in-process count of failures that opened the gate (bounded like `installedCache`).

### M4. omp: in practice the gate only works when the provider already has the flag; a bypass is logged only once per process
- `src/session/pi/hook-gate.ts:118-127`, research report line 144.
- By decision, no session id means no gate. But omp sends `prompt_cache_key` only after `compat.supportsPromptCacheKey: true` is in models.yml, and only the installer writes that. A fresh omp user is therefore never gated until the product's provider template has the flag. `warnedNoSessionId` logs once per process, so operators cannot see how many omp sessions skip the gate.
- Fix (only observability, the decision stays): log a per-request reason `no-session-id` at debug level or count it in a metric. Make sure the provider snippet that the product hands to omp users has the flag.

## Low

### L1. `isTurnAborted` uses `.some` over the content parts
- `src/session/codex/hook-gate.ts:212-217`. If a future Codex put `<turn_aborted>` and the typed prompt into one user message, the strip after a gate result would remove the real prompt. Research line 107 confirms that today it is a separate item, so the risk is low. A safer check: every text part starts with `<turn_aborted>`, or check only the first part.

### L2. Origin comes from client headers when `hookGate.publicOrigin` is not set
- `hook-gate-core.ts:123-138`. `HOST_RE`/`ORIGIN_RE` block shell syntax. I traced the threat model: the only party that can set `X-Forwarded-Host` is the client itself or its provider config. A party that controls provider config can already point `baseUrl` at a hostile server and send any tool call, and omp runs bash without approval. So header injection gives no new privilege. Not a defect. Still, set `hookGate.publicOrigin` in production so the command does not depend on proxy header handling.

### L3. Session id in the command
- `SESSION_ID_RE = ^[A-Za-z0-9._:-]{1,128}$` is applied to the Codex header id, the omp `prompt_cache_key` (`session-key.ts:57-60`) and the core builder (`hook-gate-core.ts:142`). An id like `--uninstall` is consumed as the value of `--session` (`install.sh:1164` uses `session="$2"; shift 2`), so it is not read as a flag. Safe.

### L4. Marker-based removal of omp text answers
- `src/session/pi/hook-gate.ts:220-222` runs on every pi/omp request. It removes only assistant messages with no tool calls that start with `[Agent-Memory hook gate]`. A false positive needs the model to start a reply with that exact text, so the risk is negligible. This is the accepted design (omp keeps no message id).

### L5. Cost-guard routes are never gated
- `GATED_PATH_RE` (`codex/hook-gate.ts:70`) does not match `/codex/<space>/cost-guard/v1/responses`, and the unit test asserts `other-route`. This is the same as the Claude Code gate, and the removal of gate items still runs. Confirm that this is intended for Codex users whose base URL is a cost-guard route.

### L6. Docs and comments do not agree on the title request's tools
- `codex/hook-gate.ts:34-35` and `agents/codex/README.md` say "apply_patch only". The research (line 12, table line 181) says "no tools". Either way there is no shell tool, so the behaviour is the same. Align the wording.

### L7. Installer usability details
- `install.sh:1211-1215`: when `--client omp` has no models file, `main` fails before `omp_install` can print its more specific note. The "models.yml does not exist" branch in `omp_install` only runs with `--base-url`.
- `OMP_DIR` reuses `PI_CODING_AGENT_DIR`. A user who exported it for pi and then runs `--client omp` writes the omp extension into the pi dir. Research confirms omp honours the same variable, so this is consistent but surprising. Mention it in the README.

### L8. `session-key.ts` now depends on the gate module
- `src/session/session-key.ts:7` imports `SESSION_ID_RE` from `hook-gate-core.ts`. That module also imports `project-scope/session-workspace` (storage). So a general session-key helper now depends on a feature module, and the dependency points the wrong way. This is not a runtime defect. Fix: move the regex to a neutral constants module and import it from both files.

### L9. Untracked files from earlier work
- `agents/plans/reports/Explore-261022-1545-client-hook-installer.md` and `.claude/agent-memory/debugger/*` are older than this change. Do not include them in this commit.

## Checked and not a problem

- **Classification side effects:** `classifyCodexRequest` now calls `codexAdapter.classifyRequest`. The suffix list and header signal are the same. `thread_source` is read from `body.client_metadata` first, then from `x-codex-turn-metadata`. Captured main TUI and exec turns send `thread_source:"user"`, and app-server sends none (research table lines 176-181). So no main request becomes auxiliary. The title request is still credited and rate-limited: `forwardToUpstream` runs `enforceRateLimit` (`runners/codex.ts:1205`) and taps auxiliary responses for credit (`:1407-1409`). It only skips Langfuse, L0 and session-init, which is the decided behaviour.
- **Report key parity:** Codex uses `stageAuth(c, "bearer-first")`, the same mode as `hook-report.ts:97`. omp uses `earlyAuth` (`stageAuth(c, "bearer-only")`, `openai-chat.ts:396`). The installer report and the extension both send `Authorization: Bearer <same key>`, so the user id and space id match. omp reports are stored under agent source `pi`, and the gate reads `pi`.
- **`prompt_cache_key` fallback is only for omp:** it is applied only when the User-Agent matches `^omp/` (`session-key.ts:57`), so plain pi keeps header-only ids (tested). Existing omp users who already had the flag will get one session-key change (from a hash to `prompt_cache_key`). That is acceptable.
- **No L0 or upstream for blocked requests:** both runners return before `createSessionTurnSeed`, session-init and forwarding. The only earlier side effect is identity recording, which already happened before.
- **`previous_response_id`:** Codex 0.164 sends none (research line 38), so the made-up response ids cannot break later requests.
- **Lockout:** the attempt counter rises only on gate calls. `rejected` needs `!lastAnswered`, and the Codex text item id survives replay (research line 75). The longest path is 2 calls and 2 text answers, then the request passes. I found no path that loops forever.
- **`--client pi/codex/claude-code` are unchanged:** the `install.sh` diff removes only 6 lines (usage text, the client `case`, and one `local` list), and the rest is the new omp branch. `client-hooks.test.ts` and `client-hooks-codex-pi.test.ts` passed.
- **Secrets:** the apiKey reaches `hook.sh` only through the environment and `curl -K -`. Error lines print the URL and HTTP code only. The tool output that contains installer stdout is removed before forwarding.

## Recommended actions

1. Record one Codex subagent request (H1). If it has its own session id, add the subagent pass with a unit test before production e2e.
2. Reorder `check-result` to look up the report once before the refusal test (M1).
3. Add the omp installer unit tests (M2). Optionally keep the file byte-identical when nothing changed.
4. Add per-request visibility for omp `no-session-id` bypasses (M4). Check that the omp provider template has the flag.
5. Low items as time allows. Set `hookGate.publicOrigin` in production.

## Plan follow-ups (no plan edits made)

- Shared core, Codex adapter, omp adapter, installer `--client omp`, session-id fallback, docs, and unit tests with the Claude snapshot all look done.
- Not done or not seen: production e2e, the Langfuse check, the reruns of `hook-gate-e2e.sh` / `codex-pi-e2e.sh`, and the omp installer unit tests.

## Metrics

- Type check: clean. Lint: not run (no lint script was asked for).
- Tests: 330 passed in the related suites. The Claude snapshot also passes against the HEAD gate.

## Unresolved questions

1. Does a Codex 0.164 collab child send its own `session-id`, and does the installed Codex hook report for it? (H1)
2. Is skipping the gate on Codex cost-guard routes intended? (L5)
3. Will the omp provider snippet that the product distributes include `compat.supportsPromptCacheKey: true`? (M4)

Status: DONE_WITH_CONCERNS
Summary: The refactor keeps Claude Code behaviour the same (the snapshot passes against the HEAD gate), and the Codex and omp gates look correct, safe to quote into a shell command, and covered by unit tests. The open concern is that Codex subagent threads may be gated per child session (H1, needs one capture), plus a refusal-before-report ordering issue and missing installer unit tests.
