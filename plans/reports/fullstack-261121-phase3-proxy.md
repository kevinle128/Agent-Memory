# Phase 3 report: Proxy request team and team-aware pool routing

- Branch `feat/team-scoped-subscription-pool`. Nothing committed, pushed or switched. Only `MemoryProxy/**` edited (src and tests). No Core or Panel edit. No production access.
- Status: DONE_WITH_CONCERNS

## Outcome

Every path that can reach a Subscription Pool now asks one helper for the team of the request first. A pool row is used only when its `team_id` equals the verified request team. `resolveForAgent` and all call sites are team-aware and fail closed. The full MemoryProxy suite passes (91 files, 1384 tests) and the typecheck is clean.

| Check | Base (before the change) | After |
|---|---|---|
| `npx vitest run` (MemoryProxy) | 86 files, 1245 passed, 0 failed | 91 files, 1384 passed, 0 failed |
| `npx tsc --noEmit` (`npm run typecheck`) | exit 0, no output | exit 0, no output |

Narrow runs first: `selector` + `binding-store` (53 passed), then `src/subscription-pool` (334 passed at the end), then `src/__tests__/models-handler.test.ts`, `src/injection`, `src/pipeline` and the full suite.

## Files changed (MemoryProxy)

New:
- `src/subscription-pool/pool-team.ts` (request team helper, membership cache, user default cache, settle after init, team error answers).
- `src/subscription-pool/__tests__/pool-team.test.ts` (43 tests), `team-routing.test.ts` (18, real Claude Code and Codex runners), `team-session-init.test.ts` (10, same runners with a replaced init function), `team-session-key.test.ts` (3, real init and real session store: turn 1 registers in team B, turn 2 and a sidequery carry team B's token), `src/session/__tests__/store-peek-team.test.ts` (17, `peekForTeam` on fake L2a and L2b repos).

Changed source:
- `src/instance-upstream-cache.ts`: `team_id` on the row, `resolveForAgent(items, agent, teamId)` with a team layer and an instance layer, `isPoolRow`, `isTeamPoolRow`, `poolServesClient`.
- `src/pipeline/stages/{model-source,instance-upstream-early,instance-upstream-responses}.ts`: new required `teamId` input. `model-source.ts` also exports `modelSourcePrefix` (shared by the stage and the helper).
- `src/pipeline/runners/{anthropic,codex,workbuddy,antigravity,utility,openai-chat}.ts`.
- `src/session/store.ts`: one read-only method, `peekForTeam`, and type `SessionTeamPeek`.
- `src/subscription-pool/{selector,types,binding-store,pool-request,account-switch-access,subscription-bridge}.ts`.
- `src/modelsHandler.ts`.
- `src/injection/injectors/subscription-tools-injector.ts` (outside the plan's ownership table; it calls `resolveSwitchPool`, so it had to follow the new signature).

Changed tests (fixtures get a `team_id`, harness gets team defaults): `test-harness.ts`, `resolve-pool`, `account-switch-access`, `binding-store`, `selector`, `subscription-bridge`, `pool-forwarding`, `claude-pool-forwarding`, `pool-off-identical`, `pool-usage-log`, `models-handler`, `model-source` (stage), `model-source-routing`, `client-source-agents-routing`, `omp-responses-route`, `anthropic-request-preservation`, `anthropic-l0-write`, `antigravity`, `antigravity-session-init`, `subscription-tools-injector`.

## Call sites of `resolveForAgent` (listed by hand; `rg -n "resolveForAgent\(" MemoryProxy/src --glob '!**/__tests__/**'`)

| Site | Team input | Notes |
|---|---|---|
| `pipeline/stages/instance-upstream-early.ts:74` | `input.teamId` | used by Claude Code (pre-init team, again after init when the team changed) and by openai-chat (always `null`, see deviations) |
| `pipeline/stages/instance-upstream-responses.ts:96` | `input.teamId` | `forwardToUpstream` of Codex and WorkBuddy pass the settled team |
| `pipeline/runners/codex.ts:434` (dynamic import, missed by GitNexus) | `teamIdOf(requestTeam)` | pre-init team for the model gate |
| `pipeline/runners/codex.ts:993` (new, dynamic import) | `settledTeam.teamId` | picks the model name again when the team changed |
| `pipeline/runners/workbuddy.ts:1306` (dynamic import, missed by GitNexus) | `teamIdOf(requestTeam)` | model gate flag |
| `pipeline/runners/utility.ts:158` | `teamIdOf(requestTeam)` | helper with the session header, else the fallback |
| `pipeline/runners/antigravity.ts:328` (`resolvePool`) | caller passes the team | dialogue: pre-init, then after init; model list: first usable team |
| `subscription-pool/account-switch-access.ts:126` (`resolveSwitchPool`) | `session.teamId` after a membership check | bridge and injector |
| `pipeline/stages/model-source.ts` (not a `resolveForAgent` call) | `input.teamId` | pool source row search is team-aware |

Every call has a third argument. Imports of `resolveForAgent` in `anthropic.ts` and `openai-chat.ts` are unused imports that were there before. Callers of `stageModelSource`: `anthropic.ts`, `codex.ts`, `workbuddy.ts` pass the team; `openai-chat.ts` passes `null` (see deviations). Callers of `getCursor`/`setCursor`: only `pool-request.ts` (two lines).

## GitNexus impact (`impact --direction upstream`, run before the edits; index refreshed by the earlier phases)

| Symbol | Risk | Impacted / direct |
|---|---|---|
| `resolveForAgent` | **CRITICAL** (the task said HIGH; the index now says CRITICAL) | 19 / 5 (2 processes: `runAntigravityPipeline`, `runUtilityPipeline`) |
| `stageModelSource` | HIGH | 6 / 4 |
| `stageInstanceUpstreamResponses` | HIGH | 5 / 2 |
| `stageInstanceUpstreamEarly` | LOW | 2 / 2 |
| `openPoolRequest` | HIGH | 10 / 6 (not edited, only its row use) |
| `resolveSwitchPool` | HIGH | 7 / 2 |
| `getPoolSnapshot` | HIGH | 10 / 2 (not edited) |
| `listSourceModels` | LOW | 4 / 2 |
| `getCursor` / `setCursor` | LOW | 5 / 1 and 3 / 1 |
| `selectAccount`, `earliestReset`, `accountSwitchRejection`, `isEligible` | LOW | 5/1, 8/2, 3/1, 3/1 |
| `findSession`, `handleAction` | LOW | 3 / 1 each |
| `handleModels`, `handleSourceModel` | LOW | 2 / 1 each |
| `resolvePool` (antigravity) | LOW | 4 / 2 |
| `shouldOffer` (injector) | LOW | 4 / 1 |
| `runUtilityPipeline`, `runCodexPipeline`, `runAntigravityPipeline`, `runAntigravityModels` | LOW | 2/1 each |
| `runAnthropicPipeline`, `runWorkbuddyPipeline` | LOW (0 callers: route table property access) | 0 |
| `runOpenaiChatPipeline` (first query used a wrong name) | LOW | 0 (route table property access) |
| `switchAccount`, `rejectionError` (bridge) | LOW | 3 / 1 each |
| `forwardToUpstream` (Codex, WorkBuddy), `authenticate` (modelsHandler), `renderBlocks` (injector), `peekForTeam` (new) | **UNKNOWN** (same-named symbols, private method, or new code) | confirmed by `rg`: `forwardToUpstream` has 3 callers in `codex.ts` and 2 in `workbuddy.ts`, all file-local; `authenticate` is called by `handleModels` and `handleSourceModel` only; `renderBlocks` by `execute` and `prewarm` only; `peekForTeam` by `pool-team.ts` (2 calls) |

HIGH/CRITICAL warning: `resolveForAgent` has two dynamic imports that the index cannot see. I made the third argument required, so `tsc` listed every call, including the two dynamic ones and the tests. After the edits, `detect-changes --scope all` reports 89 files, 339 symbols, risk critical; this covers the Core and Panel work of the other phases too, so it is not a Proxy-only number. Proxy flows in the list: `runUtilityPipeline` (send), others are Core store flows.

## What the helper does (`subscription-pool/pool-team.ts`)

- Gate: runs only when an enabled pool row with a non-empty `team_id` holds the agent, or a pool row with a team has the model prefix as source name (also when switched off, so a source request still gets `model_source_disabled` from its own team). Otherwise returns null and the request runs as before. Null also for an empty or `anonymous` user and for a system user.
- Known team (first hit wins, and the candidate must be in the active team list): the registered session, a bypassed session with a chosen team, an open form with a chosen team, the user default, then the header preset. A known team without a pool uses the shared normal upstream.
- Fallback: the active teams in Core order; the first team with an enabled pool for the client and a selectable account (`selectAccount` with the account's own threshold and the refresh cooldown). Errors: 429 `pool_exhausted` (pool's own answer with the earliest reset), 503 `pool_unavailable` (Core cannot list accounts and no earlier list exists, the existing 503), 403 `no_team_pool`, 403 `no_active_team`, 503 `team_list_unavailable` with `Retry-After: 5`.
- Membership cache: key `space\0user`, fresh 60 s, last good value kept 10 minutes after a Core error, one shared call, max 2 000 entries, active teams only (status absent or `active`).
- `SessionStore.peekForTeam`: L1 (initialized answers at once), then L2a (pending L1 is not authoritative, so L2a is read first), then the L2b binding; compares the user on every layer; no rebuild, no history scan, no Core call, no write.
- Settle after init (`settleRequestTeam`): reads the session again (read-only). A session team wins over a first answer (fallback or prediction) only while the user is still a member of it. A deferred error stands when init gave no team.
- Pool log lines (`account_id=...`) and the bridge `account switch` lines carry `team=<team_id>`.

## Verification of the `[UNVERIFIED]` items

1. Final form turn forwards the first message upstream in the same turn: **verified by code**. Claude Code `completeRegistration` returns `intercepted: false` with the messages (`session/claude-code/init.ts:556-560`). The Codex/WorkBuddy state machine returns `intercepted: false, justRegistered: true` (`session/codebuddy/init.ts:519-523`, `:650-652`). AntiGravity strips question and reply turns and forwards the request after init (`session/antigravity/session-init-text.ts` header, `runner antigravity.ts` `stripSessionInitTurns` and `if (!orchestrated.proceed)`). Runner tests cover Claude Code and Codex with a replaced init function (`team-session-init.test.ts`); AntiGravity is covered by the settle logic and by the `antigravity.test.ts` team tests, not by a real state machine run.
2. Single-team form flow has `selectedTeamId`: **verified, no change needed**. `session/claude-code/init.ts:245,260,269,280` (single team goes through `advanceFromTeamPicked`) and `session/codebuddy/init.ts:1048,1093,1267,1310` (`selectedTeamId: onlyTeam.team_id`).
3. Same-turn registration by the user default and the header preset: **verified for Claude Code and the Codex/CB machine**: both call `completeRegistration` in the same turn (`claude-code/init.ts:774-800` and `:802-870`, `codebuddy/init.ts:843-880`, `:894-1021`). **Finding: the order in init is user default first, header preset second, and the default wins and ignores the preset** (`codebuddy/init.ts:843-851`, `claude-code/init.ts:773-803`). The helper follows that order (the plan lists the preset first). This only affects the first answer; the settle step corrects a wrong prediction anyway.
4. `peekForTeam` key: derived per runner from the same expressions as the orchestrator (`<agent>:<sessionId>`; WorkBuddy uses `codex:<sessionId>` because it reuses the Codex machine; AntiGravity uses `antigravity:<cascade id>`). The Codex subagent id is the parent id first (`extractCodexSessionId`, `resolveConversationId`, `extractPoolSessionId` all prefer `x-parent-conversation-id`), so the team, the binding key and the pool session agree. Tested: "a subagent request follows the team of its parent session".
5. Core `team/list` for a user: **verified by reading Core (read only)**: `listTeamsByUser` joins `meta_team_members` with `status = 'active'` and sorts `created_at DESC`; a System Admin gets only their own memberships, so the fallback and the models union do not leak other teams.
6. Core internal list rows: `team_id` on pool rows and `threshold_pct` on accounts reach the Proxy as sent (the account overlay spreads the account, so the field survives `account-cache.ts`).

## Deviations from the spec, and why

1. **Init-order of default and preset** (above). The spec lists preset before default; init does the opposite.
2. **Error deferral.** The spec returns a team error at once. That would block the session form for a user whose first turn has no registered team (a new session of a user in a team without a pool, while another team has one: step B gives `no_team_pool` before the form that lets the user pick their team). So an error is marked `deferrable` when init may still register a team (init enabled, session id present, not memory-off, session not in a final state). The runner goes on with no team, lets init run (it may only show a form or a mem command), and `settleRequestTeam` runs right before the upstream is chosen; a still-unresolved error answers there, before any upstream call. Errors that cannot wait (aux requests, no init, memory off, final session state) still answer at once.
3. **openai-chat passes `teamId: null` and does not run the helper.** That runner has no pool branch. `stageModelSource` now finds a pool source of any team when `servesPool` is false, so it answers the same `model_format_mismatch` error for every team. An agent in a pool row behaves exactly as before there (the instance layer decides; pool rows never give a pool).
4. **Auth-disabled deployments get no pool.** A request with an empty user id (auth off) or `anonymous` never gets a pool (fail closed, decision 9: every request has a user). With auth disabled there is no user, so no team. The test harness now enables auth with a stubbed verify.
5. **Step B in the model list of AntiGravity** ignores helper errors and uses the existing 400 (as the spec says); the dialogue path uses the error answers.
6. Pool-source gate counts a switched-off source row by its prefix (needed to keep `model_source_disabled`); a fallback team is then the first team with such a row.
7. Codex model name: when the team changes during init, `body.model` is chosen again (pool takes the client's name, other upstreams the pricing alias). `modelId` (log/credit name) is not recomputed.
8. Claude Code: the pure block (agent adapter, request kind, memory gates) and the `lcHeaders`/conversation id lines moved above the model-source stage so the helper can use them. They have no side effect.

## Test changes: old to new

- `resolve-pool.test.ts`: "returns kind pool..." now needs a team; "a disabled pool group blocks the agent like any custom group" became "a team pool no longer blocks the agent when it is switched off" (switched-off team pool is skipped). New: other team, no team, null team, two teams, helper tests.
- `account-switch-access.test.ts` `resolveSwitchPool`: new 4th argument (session team, user key, membership primed); new tests for the session team only, a team without a pool, a user that left, a missing team or key, an unreadable team list.
- Fixtures: every pool row of the existing tests gets `team_id: "team-a"`. `test-harness.ts` enables stub auth, makes the user a member of `team-a`, and answers every session as registered in `team-a` (a spy on `peekForTeam`; the new tests restore the real store with `useRealSessionTeams`).
- `anthropic-l0-write.test.ts`: the workspace row is stored under the stub user id instead of `anonymous` (auth is on now). `anthropic-request-preservation.test.ts` (AntiGravity case): answers the verify call.
- `subscription-bridge.test.ts`: sessions carry `team_id` and `user_key`; one log assertion has the new `team=` field.
- `pool-off-identical.test.ts`: the file-level setup is the original. Only the case "claude count_tokens in a pool group uses the pool account bearer and the oauth beta" changed: its pool row has a team, and the case sets up auth and teams itself and switches auth off again after it. The other 7 cases pass unchanged.
- Spec tests added: first team has no usable account and second has one (Claude Code, Codex, AntiGravity); no team has one (429, no upstream call); user with zero teams (403); `x-memory-mode: off` with two teams (first usable team in Core order, and newest first); a team B request never goes to a team A account (asserted on the token that reached the upstream); a known team without a pool uses the normal upstream with no pool token; a session whose team changed during init uses the new team in the same turn; an error returns before any upstream call; bypassed session with a chosen team keeps it; bypassed without one uses the fallback; cursor per pool group; binding key unchanged; selector, earliest reset and Account Switch use each account's own threshold; models lists pool models of the caller's teams only and dedupes; stage tests for two teams with one prefix.

## Concerns and open points

0. **Known limits of the deferral.** (a) Only requests that run session init can wait for init. A sidequery, a `count_tokens` call, an aux request or a request with `x-memory-mode: off` that has no registered team gets its team error at once. A user whose teams have no pool can get 403 on such a request when it arrives before the main turn registers the session (the plan says so). (b) A deferred request runs the first stages with no team: the Codex pricing gate and the alias, and a model-source lookup that returned `none`, are not redone after init. Claude Code redoes the early stage and the source lookup; Codex redoes the source lookup and the model name; WorkBuddy redoes the source lookup only.
0a. The helper option `servesPool` was removed: openai-chat does not call the helper, so no caller used it.
0b. Plan state: I did not update the phase file or the plan status (`ak plan` not run); the coordinator owns it.

1. **Fallback loses the client-login fallback.** For a request with no known team where no team has a usable account, the helper answers 429 before the pool request can use the client's own login (`x-tdai-user-key` + own bearer). A known team still gets that fallback. This follows the plan text; tell me if sessionless requests should still try the client's login.
2. **An extra team list call per gated request** is cached 60 s. A first request of a session on a node may also read L2a once in `peekForTeam` (read only, no promotion to L1).
3. **Deploy gap** (plan D8): a new Proxy with an old Core sees pool rows without `team_id` and uses none of them, so a pooled client gets 400 `AGENT_NOT_CONFIGURED` for up to one cache TTL (30 s).
4. **Docs impact: minor to major** for phase 5: `MemoryProxy/v3-api-memoryproxy-doc.md` does not yet list the new 403/429/503 answers (`no_team_pool`, `no_active_team`, `team_list_unavailable`) or the team scope of the bridge and the models list. I did not edit it (not in the phase file list).
5. Phase 6 should wait one cache TTL after Core is healthy, as the plan says; nothing in Proxy needs a setting.
6. No Core bug found. Core internal list rows carry `team_id` and account `threshold_pct` as the phase 1 and 2 reports say.

Status: DONE_WITH_CONCERNS
Summary: The request team helper and team-aware routing are in all runners, the bridge, the injector and the models handlers; MemoryProxy has 91 files and 1384 tests passing and a clean typecheck.
Deviations to review: error deferral until session init ran, user default before header preset (the order init really uses), and the lost client-login fallback for sessionless requests when no team has a usable account.
