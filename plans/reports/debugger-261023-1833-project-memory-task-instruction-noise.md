# Project memory noise: delegated task prompts stored as project conventions

Date: 2026-10-23 (all times below are Asia/Saigon, UTC+7, unless marked Z). Investigation was read-only. Production data was copied to `/tmp/dbg` and `/tmp/dbg2` on the server and read there. No production file was changed.

## 1. Executive summary

The noise comes from path (a): subagent request traffic captured as L0. It does not come from path (b), the lead's own `Agent` tool_use input. MemoryProxy does not know which `/v1/messages` requests come from a Claude Code subagent when it decides to write L0. The L0 gate uses only the cache-marker request classifier. The first request of each subagent looks like a main-dialog turn, so the proxy writes the subagent's task prompt (as a `user` row) and its first sentence (as an `assistant` row). The subagent shares the lead's `x-claude-code-session-id`, so the rows get the lead's session id and the lead's `project_hash`.

Core then treats the lead's delegation brief as if a human typed it. The L1 code-mode prompt has no rule that separates a delegated one-off brief from a standing project rule. Its `work_method` and `work_task` types and the L2 "core SOP" template turn "do not edit, do not commit, report ranked file:line defects" into SOP lines. The project persona prompt then lists them under "Conventions & Workflow".

The pollution is live. My own task prompt (this investigation) arrived at 18:34:03. It became 3 L1 records at 18:34:38 and changed the scene at 18:35:48. The persona file was rewritten at 18:36:12. Every subagent dispatch in this project repeats the damage.

Two findings change how the fix must be designed:

- In the polluted session, almost all requests are classified `fork` and skip L0. In the proxy log since 00:00Z, session `9c8ad33a` has 5 `main` and 413 `fork` classifications. All 49 requests with 300 or more messages (the lead) are `fork`. So the lead's own human turns are missing from L0, and the only project L0 for Agent-Memory is subagent first requests plus two hook test rows. Suppressing subagent L0 alone would leave this project with almost no L0.
- Subagent findings are not captured today at all (see section 4). Suppressing subagent L0 therefore loses almost nothing now.

## 2. Evidence for Question 1: which L0 and L1 produced the scene

### 2.1 Production state

- Scope: team `team-f0bzqawutx`, agent `agt-f0bzvpye01`, project `db73c988534bc1c8`, key `git:github.com/kevinle128/agent-memory`.
- L0 rows with `projectHash = db73c988534bc1c8`: 9 in total (from `conversations/*.jsonl`, 4771 rows overall). Four are hook tests in two other sessions, five are in the lead session.
- Session `9c8ad33a-7a8b-44e1-95ec-20f145f29d4b` is the lead session. Its first row (2026-10-22 14:32) is a Vietnamese human message that starts "tôi phát hiện có vấn đề khi agent memory inject data". The same id is also on every subagent request (see section 3).
- L1 rows with this hash: 10 live rows in sqlite `l1_records`. `records/2026-10-23.jsonl` holds 14 records for the hash. Four of them (`66c2b72e`, `f2eddbf6`, `75ded795`, `17a8a9be`) are no longer in sqlite. I did not verify why. The L1 dedup stage most likely replaced them. Three more L1 records were written after my first copy (section 2.4).
- The scene file `scene_blocks/projects/db73c988534bc1c8/Agent-Memory-Project-Isolation.md` was created 17:07:47 and updated 17:39:19 and 18:35:48. The project persona `project_personas/db73c988534bc1c8.md` was first written about 17:59 and rewritten at 18:36:12.

### 2.2 The L0 rows (all in session `9c8ad33a`, all with the hash)

| L0 id (prefix) | Role | Time | Length | First characters (no secrets present) |
|---|---|---|---|---|
| `msg-8fbc0c18` | user | 17:04:51 | 6967 | "Add per-project L3 personas and project-scoped read parameters. Timezone Asia/Saigon. Comments/identifiers in English (ASD-STE100 ...); never mention plan phases or finding codes. Do NOT commit; the lead commits. Run GitNexus impact ..." |
| `msg-8cdf1301` | assistant | 17:04:51 | 40 | "I'll start by orienting in the codebase." |
| `msg-89cd3d8e` | user | 17:27:50 | 3817 | "Review the uncommitted diff in /Users/dale/Desktop/workspace/vtc/operator-master/Agent-Memory (branch feat/server_team). Timezone Asia/Saigon. Read-only review: do NOT edit files, do NOT commit. Ignore untracked `agents/plans/`. Changed files: ..." |
| `msg-95a582a1` | user | 18:34:03 | 5364 | "Read-only root-cause investigation. Do NOT edit code, config or data, do NOT restart anything, do NOT commit. Timezone Asia/Saigon. Write the report in English ..." |
| `msg-066099a0` | assistant | 18:34:03 | 67 | "I'll start with the code paths and the production data in parallel." |

Why I classify these as subagent traffic and not as the lead's own text:

- Each `user` row equals, character for character, the task prompt that the lead passed to the subagent (`fullstack-developer`, `code-reviewer`, `debugger`). The third row is the prompt I received as my first user message.
- Each `assistant` row is the first sentence of that subagent's first reply, not a lead reply. The review prompt (17:27) has no assistant row because that subagent started with a tool call and no text. The proxy log shows `msgs:1` for that write.
- The proxy log shows `tdai-recorder:write-l0 ... session=9c8ad33a... project=db73c988534bc1c8` at 10:04:51Z, 10:27:50Z and 11:34:03Z. In the same minute the log shows `[cc-routing] ... kind=main msgs=2`.
- None of the three prompt texts appears in any `assistant` row of any L0 file. I searched the unique phrases "Hard invariants to check", "the lead commits", "Read-only root-cause investigation", and "Add per-project L3 personas" across all of `conversations/*.jsonl`. Each occurs only in `user` rows, in this session.

Conclusion on (a), (b), (c): (a) is the sole source. (b) is excluded by the flattening code (section 4) and by the search above. The lead's own text did not produce any of these L1 records.

### 2.3 The L1 records and their source

All 14 records have `sessionId = 9c8ad33a-...` and a single source message. The lead's real project conversation is not a source for any record.

| L1 id | Type / priority | Created | Source L0 | Assessment |
|---|---|---|---|---|
| `400729ce` | work_method 98 | 17:06:40 | msg-8fbc | Task noise: allowed-edit file list for one task. |
| `c0640628` | work_method 93 | 17:06:40 | msg-8fbc | Mixed. GitNexus-before-edit and STE comment rules are real user conventions, but they come from the user's CLAUDE.md, not from this project. |
| `ff3c7f1c` | work_fact 100 | 17:06:40 | msg-8fbc | Durable fact (project fields exist on L0/L1). Keep. |
| `66c2b72e`, `f2eddbf6`, `75ded795`, `17a8a9be` | work_task 89-99 | 17:06:40 | msg-8fbc | Task noise. No longer in sqlite. |
| `1250f3d2` | work_task 94 | 17:06:40 | msg-8fbc | Task noise: acceptance list for one task. |
| `1c2dc121` | work_method 96 | 17:06:40 | msg-8fbc | Task noise: "602 and 356 tests" baselines. |
| `3497b60d`, `b71f9fbe`, `3daff0b6` | work_task or work_method 99-100 | 17:39:09 | msg-89cd | Task noise: a spec for one implementation task, relabelled constraint. |
| `926e0df5` | work_fact 100 | 17:39:09 | msg-89cd | Durable fact (production runs sqlite/standalone). Keep. |
| `e028000f` | work_task 97 | 17:39:09 | msg-89cd | Task noise: the review instructions themselves. |
| `e20412cd`, `c17021e4`, `f158806c` | work_fact / work_task 92-97 | 18:34:38 | msg-95a5 | Task noise from this investigation prompt. |

Timing: the first batch was extracted 109 seconds after the L0 write, the second 11 minutes later, the third 35 seconds later. L1 inherits the project because every source message has the same hash (`l1-project.ts` `resolveUnanimousProject`). A single-source delegated prompt always passes this check.

### 2.4 From L1 to scene to persona

- The scene was created 1 minute 7 seconds after the first L1 batch and updated after each later batch. The 18:35:48 update rewrote the scene summary and the "SOP" and "Guardrails" sections to describe this investigation.
- The persona was generated by the project L3 variant from the scene. The text "Review diffs, untracked MemoryCore files and callers read-only; ignore agents/plans. Do not edit or commit." is a near copy of the scene's first SOP line, which is a near copy of L1 `e028000f`, which is a near copy of the line in `msg-89cd3d8e`.
- A similar problem exists outside this project. Unprojected L0 from older subagent runs (the same session has about 310 rows without a hash, many repeated 40 times) produced the root scene `scene_blocks/MemoryCore-Read-Only-Review.md`. The root persona line "Keep read-only work read-only" and the project L1 records in projects `4ca24d031de147cb` and `95383b786edb390e` (for example "must include a diff summary..." and "never use `git add -A`") also look like delegated briefs. I did not review them in detail.

## 3. Question 2: subagent detection and L0 capture in MemoryProxy

There are three mechanisms. None of them gates L0.

1. Request kind classifier. `src/common/cc-request-classifier.ts:30-60` returns `main`, `fork` or `sidequery` from the position of the last `cache_control` marker. The Claude Code adapter calls it (`src/agent-adapters/claude-code.ts:17-20`). The runner computes `requestKind` at `src/pipeline/runners/anthropic.ts:533` and `memoryTurn = requestKind === "main"` at `:539`. L0 is written only when `isMainDialog` is true (`:1611`, `:1638` non-stream, `:1946` stream). The classifier has no concept of a subagent. Routing is on by default (`src/config.ts:203`).
2. Subagent detector. `src/session-trace/subagent.ts:47-54` (`detectClaudeCode`) treats a request with header `x-claude-code-agent-id` as a subagent and sets `parentSessionId` to the value of `x-claude-code-session-id`. Other agents have detectors at `:56-92` (CodeBuddy and WorkBuddy via `x-agent-type`, OpenCode, DSH, Hermes, OpenClaw; Codex returns null). The only caller of `detectSubagent` is `src/session-trace/index.ts:~104-108`, which builds turn records for session tracing. The L0 path never calls it.
3. Session id. `src/session/session-key.ts:26-41` (`resolveConversationId`) normalizes only WorkBuddy subagents (header `x-parent-conversation-id`). For Claude Code it falls back to `x-claude-code-session-id` (`:35`), which a subagent shares with the lead. The proxy log confirms it: every request in this window prints `x-claude-code-session-id=9c8ad33a-...`.

L0 write path: `extractLatestUserMessage(messages)` at `anthropic.ts:973`, identity at `:961-972`, `recordTdaiTurn` at `:1639` and `:1952` (stream), `client.addConversation` at `src/tdai/client.ts:141-178`. The identity is built from the session id, and `withSessionProject` (`src/project-scope/session-workspace.ts:82-100`) looks up the workspace the hook reported for that session id. A subagent therefore gets the same session id and the same `project_key` and `project_hash` as its parent. The DB rows show this.

What the proxy does for a subagent today (proxy log, 2026-10-23 17:00-18:40):

- First request of the subagent: `kind=main msgs=2`, so one L0 write (task prompt and first reply sentence).
- Later requests in the same tool loop: `kind=fork`, so `skip L0 write (stream)`.
- Earlier subagent loops in the same session were written on every request: on 2026-10-22 at 14:36-14:39, and on 2026-10-23 at 14:34-14:38 (about 40 identical 4451-character `user` rows, then a 8192-character `assistant` row). The next subagent, at 14:41, wrote only once. The proxy was not restarted in between (proxy container started 15:42 on 2026-10-23) and no classifier code changed since 2026-10-22. So the "fork" classification of loop requests is not a stable property. I do not know why it differs (the subagent type, the Claude Code marker placement, or client state). The fix must not rely on it.
- Claude Code 2.1.289 (the local binary) contains the strings `x-claude-code-agent-id` and `x-claude-code-parent-agent-id` and adds them only when the request has an `agentId`. I verified this in the binary. I could not see the production request headers, because the proxy does not log them. Langfuse has no trace for this session.

## 4. Question 3: what L0 contains from tool_use and tool_result

- User side: `src/tdai/recorder.ts:21-30` takes the last `user` message, `extractContentText` (`:41-52`) keeps only `text` and `input_text` blocks (`:47`), and `extractUserQueryText` (`src/common/user-query-extractor.ts:133-180`) drops harness wrappers including `tool_result`. A user message that contains only tool results becomes empty, so the loop at `recorder.ts:22-29` continues backward to the previous user message with text. In a subagent loop this is the task prompt. That explains the 40 repeated rows on 2026-10-22.
- Assistant side: only `text` blocks are kept (`anthropic.ts:1430-1449` non-stream, `:2085-2086` stream `text_delta`). `tool_use` input is never written.
- Result: the lead's `Agent` tool_use input and the subagent's final report (returned to the lead as a `tool_result`) are not in L0. The subagent's findings are not captured anywhere today. Only the prompt text (as the subagent's first user message) and the first sentence of its first reply are captured.

## 5. Question 4: do the prompts separate durable knowledge from one-off task instructions

No. Evidence:

- L1 chat prompt `MemoryCore/src/core/prompts/l1-extraction.ts:33,60-65`: "filter temporary instructions and one-off operations (such as 'this time')". The rule is about a human's casual requests. It has no rule for task briefs addressed to an executing agent.
- L1 code (work) prompt, used in production (L1 types are `work_*`): `l1-extraction.ts:323-328` lists only greetings, "this time" requests, unadopted AI drafts and similar. The `work_method` definition (`:250-282`, priority rule at `:278`) asks for "SOP, prohibitions, boundaries, Agent execution rules, Prompt writing principles" and sets priority 90-100 for rules that "affect Agent behavior". A brief that says "Do NOT edit, do NOT commit, report ranked defects" fits this definition exactly. `work_task` (`:219-248`) accepts "next steps" and "owner/deadline" items. The prompt asks for care when a person only proposes something ("only an explicit confirmation or execution order makes a decision", `:164`), but an imperative sentence in a `user` row reads as an execution order.
- L1 input has no provenance. `l1-extractor.ts:173` filters messages with `shouldExtractL1` (`utils/sanitize.ts:135`: length, symbols, injection patterns) and nothing else. Role `user` is the only signal.
- L2 scene work prompt `scene-extraction.ts:262-293,371-377,436-438,475`: "the core goal is to distil methodology from project events", with a required "Core SOP" section and a "Related tasks and assets" section. The prompt tells the model not to write a daily report, but it has no rule against scope limits or output formats of a single task.
- Project persona prompt `persona-generation.ts:306-376` (`PROJECT_MEMORY_SYSTEM_PROMPT`): the section "Conventions & Workflow" asks for "code style, branch and release flow, test and verification methods, team rules". The prohibition list (`:321-328`) forbids personal traits, speculation and daily reports. It does not forbid one-off task directives. The variant is selected at `:452`.

## 6. Hypotheses tested

| Hypothesis | Result |
|---|---|
| H1: Lead L0 contains the `Agent` tool_use input. | Eliminated. Flattening keeps only `text` blocks (section 4). The phrases occur only in `user` rows. |
| H2: Subagent traffic is detected and tagged as such before L0. | Eliminated. `detectSubagent` has one caller (session trace) and the L0 gate uses the cache-marker classifier only. |
| H3: Subagent requests use their own session id, so the project hash is not inherited. | Eliminated. The L0 rows carry the lead's session id and the lead's hash; the proxy log shows one session id for all requests. |
| H4: The project inheritance rule in L1 should have blocked these records. | Eliminated as a cause. The rule is correct for its purpose: all sources have the same hash, and the L1 prompt cannot see that the source is a brief. |
| H5: The persona prompt alone invented the directives. | Eliminated. The same sentences exist in the scene and in L1 `e028000f` and `400729ce`. |
| H6: Subagent findings are also captured. | Eliminated for the current traffic. Later subagent requests are `fork` and skip L0, and `tool_result` is dropped. |

## 7. Fix options

### Option (i): do not write L0 for subagent requests

- Files: `MemoryProxy/src/pipeline/runners/anthropic.ts` (the two L0 gates at `:1638` and `:1946`; compute `isSubagent` once near `:533` from `lcHeaders`, which already exist at `:652`); `MemoryProxy/src/pipeline/runners/openai-chat.ts` (L0 sites `:1556`, `:1971`); reuse `detectSubagent` from `src/session-trace/subagent.ts` (export a small helper such as `isSubagentRequest(agent, headers, body, sessionId)`); Codex has no detector and stays unchanged.
- Behavior change: no `recordTdaiTurn` for requests where the detector returns a subagent. Skill buffering and injection stay as they are. Project hash lookup is unchanged.
- Variant (i-b), "keep only the final answer": add a recorder function that writes one `assistant` row when `stop_reason` is `end_turn` for a subagent. `recordTdaiTurn` needs a user message (`recorder.ts:32-39`), so this is new code, and L1 would see an assistant row with no user context.
- What is lost: today, nothing of value. Subagent findings are not captured now (section 4). If routing changes back to capturing every loop request (as on 2026-10-22), the subagent's reasoning text would be lost, but that text is also not durable project knowledge.
- Risk: the gate is fail-open. A client that does not send the header (older Claude Code, `x-claude-code-agent-id` missing) still leaks. A wrong match would drop a real turn. Because the lead's own requests are mostly classified `fork` in this session, the project would have almost no L0 left (see unresolved question 1).
- Test: unit tests with a mocked `TdaiClient`. Request with header `x-claude-code-agent-id` must not call `addConversation`; a request without the header must still call it with the project fields. Add the same cases for the OpenCode (`x-parent-session-id`), CodeBuddy (`x-agent-type: subagent`) and DSH/Hermes/OpenClaw markers. Existing pattern: `MemoryProxy/src/project-scope/__tests__/session-project.test.ts`. On staging, dispatch a subagent and check that no new `write-l0` line appears for the subagent request.

### Option (ii): mark delegated messages so L1 ignores the brief but keeps findings

- Files, proxy: `src/tdai/types.ts` (new optional field on the message, for example `origin: "delegated"`), `src/tdai/client.ts:141-178` (send it), the runners as in option (i). Files, core: gateway schema `MemoryCore/src/gateway/v2-schemas.ts`, L0 storage (sqlite `l0_conversations`, tcvdb, mongo; the project columns commit `642722ee` is the precedent), `core/record/l1-extractor.ts:173` (move delegated messages from `newMessages` to `backgroundMessages` using the `formatExtractionPrompt` background block, which forbids extraction).
- Behavior change: the delegated brief stays in L0 as context. L1 can still extract from the subagent's own assistant output.
- What is lost: nothing, but it gains value only if subagent findings are captured. Today they are not, so this option adds a schema migration in three stores for no current benefit.
- Risk: highest. Core and proxy version skew, a migration on three backends, and an `ALTER` on a live sqlite file. The background window is limited (`maxBgMessages`), so the brief can fall out of the window.
- Test: L1 extractor test with a fake LLM runner that asserts the delegated message appears only under "background", migration tests per backend, and a gateway schema test for the new field.

### Option (iii): prompt rules that drop one-off task directives

- Files: `MemoryCore/src/core/prompts/l1-extraction.ts` (add to "should not extract" in both prompts, `:60-65` and `:323-328`, and tighten `work_method` and `work_task` so a method needs a standing statement); `scene-extraction.ts` (the work variant, near `:267-293` and `:436-438`); `persona-generation.ts` (`PROJECT_MEMORY_SYSTEM_PROMPT` prohibitions at `:321-328`, and the TEAM prompt for the root persona).
- Proposed rule text (STE): "Do not store instructions that a lead or agent gave to another agent for one task. Examples: scope limits (read-only, do not edit, do not commit), allowed file lists, output format or length demands, report paths, per-task acceptance lists, test-count baselines. Store a rule only when it is stated as standing ('always', 'from now on', repository policy) or when the project facts show that it is a repeated practice."
- Behavior change: the model drops task briefs at three layers. It also stops writing standing rules that were only seen once in a brief.
- What is lost: some real conventions that appear first in a brief (for example "run GitNexus impact before editing"). A model judges the rule, so results are not deterministic.
- Risk: prompt changes affect all agents and both modes. A weak model can ignore the rule. It cannot repair data that already exists.
- Test: replay the three real L0 messages (`msg-8fbc0c18`, `msg-89cd3d8e`, `msg-95a582a1`, available in `/tmp/dbg/conversations` on the server) through the L1 extractor with the real model, and check that no `work_method` or `work_task` repeats the scope limits. Run the existing prompt tests (`persona-generation.test.ts`) for the project variant.

### Option (iv): heuristic text filter in the proxy

Not recommended. A regular expression for "Do NOT commit" or "Read-only" would also drop real human rules and would need constant tuning. The header already gives a deterministic signal.

## 8. Recommendation

Use option (i) with the header-based detector, plus a short version of option (iii) as a second layer. Do not build option (ii) now.

Reasons:

- Option (i) removes the cause at the source with a deterministic signal that Claude Code sends (`x-claude-code-agent-id`, verified in the 2.1.289 binary), and the proxy already has the detector. The cost is almost zero because no subagent finding reaches L0 today.
- Option (iii) is needed anyway. A human can also type "this time do not commit", and clients without a subagent header would still leak. Keep the wording narrow (task scope, output format, report paths) so that real conventions survive.
- Option (ii) adds three-backend migrations to protect a data stream that does not exist yet. Revisit it only if the team decides to capture subagent final answers.
- Before shipping option (i), resolve unresolved question 1. If lead turns are not in L0, the project would lose its only real signal.

## 9. Cleanup plan (not done)

Do these steps in this order, in a maintenance window, after the fix (i) is deployed so that no new brief arrives:

1. Back up. On the Core host, copy `/data/tdai-memory/vectors.db` with `sqlite3 .backup` (not `cp` of a live WAL database; my plain copy of the WAL produced "database disk image is malformed"). Copy `conversations/`, `records/`, and the profile directory `profiles/team%3Ateam-f0bzqawutx%7Cagent%3Aagt-f0bzvpye01/` (scene blocks, `project_personas`, `.metadata/projects/db73c988534bc1c8`, `.backup`).
2. L0: remove the five rows `msg-8fbc0c18...`, `msg-8cdf1301...`, `msg-89cd3d8e...`, `msg-95a582a1...`, `msg-066099a0...` from `l0_conversations` and the daily JSONL. Without this step a future L1 re-extraction would read them again.
3. L1: remove the noise records `400729ce`, `1250f3d2`, `1c2dc121`, `3497b60d`, `b71f9fbe`, `3daff0b6`, `e028000f`, `e20412cd`, `c17021e4`, `f158806c` from `l1_records`, the vector and FTS tables, and `records/*.jsonl`. Keep `ff3c7f1c` and `926e0df5`. Decide on `c0640628` with the user. Remove the four records that exist only in JSONL (`66c2b72e`, `f2eddbf6`, `75ded795`, `17a8a9be`) so the JSONL does not resurrect them.
4. L2: delete `scene_blocks/projects/db73c988534bc1c8/Agent-Memory-Project-Isolation.md` and its entry in the project scene index, and reset the project L2 checkpoint under `.metadata/projects/db73c988534bc1c8/` so that the scene is rebuilt from the remaining L1 only.
5. L3: delete `project_personas/db73c988534bc1c8.md` and let the project trigger regenerate it (its cold-start rule). Check this rule on a copy first, because the project variant has no marker to force regeneration.
6. Root exposure: review `scene_blocks/MemoryCore-Read-Only-Review.md`, `Agent-Memory-Project-Isolation.md` and `Agent-Memory-Project-Storage.md` in the root scope and the user-global `persona.md` lines that came from the same briefs ("Keep read-only work read-only"). Handle projects `4ca24d031de147cb` and `95383b786edb390e` the same way after a review.

## 10. Unresolved questions

1. Why are the lead's own requests in session `9c8ad33a` all classified `fork` (49 of 49 with 300 or more messages) while other sessions are mostly `main` (session `a7b0bcec`: 320 main, 48 fork)? This drops the lead's human turns from L0. Likely a cache-marker position issue in `cc-request-classifier.ts`, but I could not see the request bodies. It needs a separate investigation before option (i) ships.
2. Why were all requests of some subagent loops written to L0 (2026-10-22 14:36, 2026-10-23 14:34) but only the first request of the three later subagents? There is no proxy restart or classifier change in between. Candidates are the subagent type (for example the built-in Explore agent) or a different cache-marker placement in the client.
3. Does the production Claude Code client send `x-claude-code-agent-id` on every subagent request? The 2.1.289 binary supports it, but the proxy logs no headers. Add a debug log line or capture one request before relying on it.
4. Why do four of the 14 L1 records exist only in JSONL? I assume dedup removed them. I did not verify it.
5. Should `c0640628` (GitNexus and STE rules) be kept, given that the same rules come from the user's global CLAUDE.md?

Status: DONE_WITH_CONCERNS
Summary: The noise is subagent task prompts captured as L0 under the lead's session id and project hash, then promoted by prompts that cannot tell a delegated brief from a standing rule. The tool_use input of the lead is not captured. Concerns: the lead's own turns are largely missing from L0 because of request classification, and the production header was verified only in the client binary.
Recommended fix: block L0 for header-detected subagent requests in the proxy runners, add a narrow "no one-off task directives" rule to the L1, L2 and project persona prompts, and skip the schema-marking option for now. Clean the data with the backup-first plan in section 9 after the fix is deployed.

## 11. Follow-up: request capture

Date: 2026-10-23, 21:23-21:35 Asia/Saigon. Client: Claude Code 2.1.289 (local binary). Read-only for product code and shared services. No commit, no restart.

### 11.1 Method

- A pass-through capture proxy (`/tmp/cc-capture/proxy.mjs`, Node, no dependencies) listened on `127.0.0.1:18977` (PID 69277, then PID 83366 after one logging change). It forwarded every request unchanged, with the original auth headers, to the upstream from `~/.claude/settings.json` (`http://vtc.taildae6a9.ts.net:8096/claude-code/default`). It logged only a skeleton per request: header names, `x-claude-code-*` values, `anthropic-beta`, model, message roles, block types, cache_control positions, and text prefixes of at most 120 characters. It did not log bodies or auth values.
- The shell variable `ANTHROPIC_BASE_URL` does not override the `env` block in `~/.claude/settings.json`. The first run therefore went directly to production. The working override is `claude -p ... --settings '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:18977/claude-code/default"}}'`.
- Runs were in a scratch git repository (`/tmp/cc-scratch`, 3 files), with the real `~/.claude` (hooks, agents, MCP). These scratch sessions reached production Agent-Memory and can have written L0/L1: `bdd5e7a3` (first run, not captured), `48d8c38a` (fresh turn, 4 resumes, `/compact`), `c8d88776` (hooks disabled, 2 resumes), `4a702008` (Explore subagent), `07c25071` (general-purpose and `code-simplifier` subagents). All prompts were trivial ("say hi", "reply ok1", "ls").
- Each captured skeleton was replayed through the real `classifyCcRequest` (`npx tsx /tmp/cc-capture/replay.ts` and `replay2.ts`, importing `MemoryProxy/src/common/cc-request-classifier.ts`).
- The production proxy log (read-only `docker logs`) has `cc-routing` lines for session `9c8ad33a` only from 08:42Z (15:42 local). The container was recreated then, so older lines are gone.
- The marker placement code was read from the binary (`function $1t`, the `x-claude-code-agent-id` header builder).

### 11.2 Q1: is `x-claude-code-agent-id` a subagent-only header?

Yes, in every captured request.

| Request | Type | Model | `x-claude-code-agent-id` | `x-claude-code-session-id` |
|---|---|---|---|---|
| L4-L26, L30, L34, L38, L42, L45, L48 (16 requests) | lead turns, lead tool loop, `/compact` | opus-5-5 | absent | the session id |
| L31, L32, L33 | `Explore` (user custom `~/.claude/agents/explore.md`, haiku) | haiku-4-5 | `a5912256...` on all 3 | same as lead `4a702008` |
| L39, L40, L41 | `general-purpose` | opus-5-5 | `a4cd79d5...` on all 3 | same as lead `07c25071` |
| L43, L44 | `code-simplifier` (custom) | opus-5-5 | `ad55d676...` on both | same as lead `07c25071` |

- `x-claude-code-parent-agent-id` did not appear in any request. It is probably sent only for nested subagents. I did not test that case.
- In the binary, the header builder adds the header only when the request context has an agent id: `...Q?.agentId&&{"x-claude-code-agent-id":Uor(Q.agentId)}, ...Q?.parentAgentId&&{"x-claude-code-parent-agent-id":...}`. Forks from the lead (for example `/compact`, L48) run in the lead context and carry no agent id.
- The subagent and the lead share `x-claude-code-session-id`. This confirms section 3, item 3.

### 11.3 Q2: why lead turns are classified `fork`

Claude Code 2.1.289 sends hook output and other context as `role: "system"` messages inside `messages` (beta `mid-conversation-system-2026-04-07`). When the last message is such a system message, Claude Code puts the turn marker on it. The classifier removes all system messages before it finds the marker. The last remaining marker is then the previous assistant reply at `n-2`, and the classifier returns `fork`.

Observed cache_control placement (all lead and Opus requests):

- System prompt: 3 blocks. Blocks 1 and 2 have cache_control. Block 0 (the billing header) has none.
- Tools: no tool has cache_control (`toolCC = []`), with 120 tools at start and 324-327 after MCP tools load.
- Messages: at most two markers. One is on the last block of the previous assistant reply. The other is on the last raw message. In all 22 captured requests except `/compact`, the last raw message has the last marker.

| Case | Raw roles (end) | Marker positions (raw index, role, block) | Last raw message | Classifier |
|---|---|---|---|---|
| Fresh turn, hooks on (L4, L30, L38) | `u s` | (1, system, `tool_addition`) | system: SessionStart hook text + `tool_addition` | `main` (no marker after the filter, fallback) |
| Resumed turn, hooks on (L8, L12, L16, L20) | `... a u s` | (n-3, assistant, text), (n-1, system, text) | system: "UserPromptSubmit hook success: ..." | `fork` |
| Resumed turn, hooks off (L24, L26) | `... a u` | (n-2, assistant), (n-1, user, text) | user | `main` |
| Lead tool loop with a new system message (L34, L42) | `... a u s` | (n-3, assistant, `tool_use`), (n-1, system) | system: "# MCP Server Instructions ..." | `fork` |
| Lead tool loop without a new system message (L45) | `... a u` | (n-2, assistant, `tool_use`), (n-1, user, `tool_result`) | user | `main` |
| `/compact` (L48, a real fork) | `... a u s` | (n-3, assistant) only | system (string content) | `fork` |

The rule that turns the lead turn into `fork`:

- `MemoryProxy/src/common/cc-request-classifier.ts:40-43` removes every message whose role is not `user` or `assistant`.
- `:45` runs `findLastCacheControlIndex` on the filtered array, so a marker on a system message is not seen.
- `:50` returns `"fork"` when the last seen marker is at `n - 2`. That is the previous assistant reply, which always has the second marker.
- The filter came from upstream release commit `a5dcbe6e` (v2.0.1, 2026-08-25). No test covers a `role: "system"` message with a marker. The tests in `src/common/__tests__/cc-request-classifier.test.ts` cover only "marker on last message" and "marker on n-2".

The binary confirms the client side (`function $1t`). It skips `api_system` messages and ephemeral user messages when it picks the conversation marker (`ke`). For a normal turn it moves the marker onto the trailing `api_system` message when system marking is allowed (`Pe = canMarkApiSystem && caching && !skipCacheWrite && ... ? Te : Se`). For a fork (`skipCacheWrite`), it moves the marker one eligible message back (`Se = ke(Se-1)`) and never marks a system message.

Why session `9c8ad33a` is all `fork`: the user's `UserPromptSubmit` hook adds context to every human turn, and hooks or MCP updates add a system message at almost every tool step. The production log shows the same pattern. Every lead step grows by 3 messages (assistant, user, system), for example `fork msgs=1402`, `1405`, `1408`, `...`, `1543`. Every subagent loop shows `main msgs=2` and then `fork msgs=5, 8, 11, 14, 17`. In the log since 08:42Z, the 6 `main` lines are all `msgs=2` subagent first requests (08:45:41, 09:15:09, 10:04:45, 10:27:47, 11:33:58, 14:23:14Z), and 470 lines are `fork`. Sessions without such hooks (for example `a7b0bcec`) put the marker on the last user message and stay `main`.

Proposed classifier fix (not implemented): compute the last marker on the raw array. If the marker is on a message after the last `user` or `assistant` message (a trailing system message), return `main`. Otherwise keep the current filtered `n-2` logic. Replay against all captured requests:

| Requests | Current | Proposed |
|---|---|---|
| Lead L8, L12, L16, L20, L34, L42 | `fork` | `main` |
| Subagent L40, L44 | `fork` | `main` |
| All other 13 lead and subagent requests | `main` | `main` |
| `/compact` L48 | `fork` | `fork` |

Synthetic cases for the unit tests (all pass with the proposed rule in the replay script): `[u, a(m), u, s(m)]` gives `main`; `[u, a(m), u, s]` (compact shape) gives `fork`; `[u, s(m on tool_addition)]` gives `main`; `[u, a(m), u(m)]` gives `main`; `[u(m)]` gives `main`; a fork after a system message, `[u, a, u(m), s, u_fork]`, gives `fork`.

### 11.4 Q3: why some subagent loops wrote L0 on every request

This was not a fork misdetected as main. The Haiku model does not get the `mid-conversation-system` beta. The L31 `anthropic-beta` value has no `mid-conversation-system-2026-04-07`, `inline-tools`, or `per-turn-control`, but the L30 (Opus) value has them. So a Haiku request has no `role: "system"` messages. The context is folded into text blocks of the first user message (L31 has 8 text blocks). The marker is always on the last message, and the classifier correctly returns `main` for every step (L31-L33). The classifier has no concept of a subagent, so each step writes L0. The recorder walks back from the `tool_result` message to the task prompt (`src/tdai/recorder.ts:21-30`), so each write repeats the brief.

Opus and Sonnet subagents get the beta. Their first request is `[u, s(m)]` and gives `main` by the no-marker fallback. Later steps that add a system message give `fork`. Steps without one give `main`. In the capture, general-purpose L41 is `main`. In production, the hooks add a system message at every step (stride +3), so only the first request was written.

The local transcripts of session `9c8ad33a` (`~/.claude/projects/-Users-dale-Desktop-workspace-vtc-operator-master/9c8ad33a-.../subagents/`) confirm the link. The two "every request" windows are both haiku `Explore` agents: `agent-a697a951...` at 2026-10-22 14:36:23 (22 API requests) and `agent-afdcf5aa...` at 2026-10-23 14:34:22 (52 API requests). The later single-write agents are `fullstack-developer` (Sonnet), `code-reviewer` (Opus) and `debugger` (Sonnet). I did not reconcile 52 requests with the "about 40" identical rows in section 3. L0 dedup or non-completed streams can explain the difference, but I did not verify it.

### 11.5 Conclusions

(a) The header is a reliable deterministic subagent signal for the L0 gate. All 8 subagent requests had `x-claude-code-agent-id`, and none of the 16 lead requests (including the `/compact` fork) had it. The binary adds it only when the request runs in an agent context. Caveats: I tested only `-p` mode (`cc_entrypoint=sdk-cli`), but the production stride matches. I did not capture a Sonnet subagent, a nested subagent, an in-process teammate (agent teams), or a fork that a subagent starts (for example `agent_summary`, which runs with `overrides: {agentId}`). A teammate is the only untested path where a non-subagent turn could carry an agent id. Older clients without the header still leak (fail-open).

(b) Root cause of lead = `fork`: `cc-request-classifier.ts:40-43` removes `role: "system"` messages, and Claude Code 2.1.289 puts the turn marker on a trailing system message whenever hooks or tool and MCP updates add one. `:45` then finds the previous assistant marker at `n-2`, and `:50` returns `fork`. Proposed fix: treat a last marker on a trailing system message as `main`, and keep the rest of the logic. This fix must ship with option (i). Without option (i), the fix turns every Opus and Sonnet subagent step into `main`, and every subagent step writes the brief again, as the haiku Explore loops do today.

(c) Option (i) does not drop real lead turns. No lead request carried the header. But option (i) alone does not restore lead L0, because the lead turns are `fork` today. The classifier fix is needed to restore them. After that fix there is one more consequence. Every lead tool-loop step becomes `main`. When the last user message has only `tool_result` blocks, `extractLatestUserMessage` (`src/tdai/recorder.ts:21-30`) walks back to the last human text, so the lead's L0 gets the same human message once per tool step. This is pre-existing recorder behavior (section 4). The L0 gate must also require human text in the last user message (or the recorder must dedup by turn), or the restored lead L0 will be full of duplicates.

### 11.6 Cleanup

- Both capture proxy processes are stopped (PIDs 69277 and 83366). Port 18977 is free.
- `/tmp/cc-scratch` is removed. `/tmp/cc-capture/log.jsonl` contains only skeletons and short prefixes, with no bodies and no auth values. The replay scripts stay in `/tmp/cc-capture` for reuse.
- The five scratch sessions in 11.1 can have L0/L1 rows in production under the scratch workspace. Remove them during the section 9 cleanup.

Status: DONE_WITH_CONCERNS
Summary: Claude Code sends `x-claude-code-agent-id` on every subagent request and never on lead requests, so it is a deterministic L0 gate signal. Lead turns are `fork` because the classifier drops `role: "system"` messages (`cc-request-classifier.ts:40-43`), and Claude Code puts the turn marker on the trailing hook or context system message, so the previous assistant marker at `n-2` wins (`:50`). The "every request" subagent loops were haiku Explore agents, which get no system messages and are correctly `main` on every step. Concerns: the classifier fix must ship together with option (i), and lead tool-loop steps then need a human-text check to avoid duplicate L0 rows.
