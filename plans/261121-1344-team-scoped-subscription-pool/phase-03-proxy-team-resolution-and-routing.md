# Phase 3: Proxy request team and team-aware pool routing

## Context (read in code)

- Rows of all groups of an instance come from one cache entry per `spaceId` (`instance-upstream-cache.ts:164-210`). `resolveForAgent(items, agent)` (`:220-261`) picks the first custom row that holds the agent; a pool row gives `{ kind: "pool" }` (`:242-244`).
- Multi-source clients reach a pool by the model prefix in `stageModelSource` (`pipeline/stages/model-source.ts:80-139`): first row with that `source_name` (`:95`).
- In every runner the model-source stage and the early resolution run **before** session init: `anthropic.ts:510` and `:583` before `:780`; `codex.ts:339` before `:595`; `workbuddy.ts:1239` before `:1397`; `openai-chat.ts:417` before `:790`; `antigravity.ts:495` before `:522`. The pool request opens after session init in `anthropic.ts:1125`, `codex.ts:1143-1158`, `workbuddy.ts:510-524` (in `forwardToUpstream`, called after init) and `antigravity.ts:557`.
- Session state: L1 `get` does not compare the user (`session/store.ts:121-133`); L2a and L2b do (`:496-502`, `:538-542`). A bypassed session has `sessionInfo: null` (`:416-429`). Pending state keeps `selectedTeamId` (`session/types.ts:47-51`). Header preset validates the team against the user's team list (`session/preset.ts:96-130`); user default validates it the same way (`session/user-default.ts:68-75`).
- Team list of a user: `MetaClient.listTeams(userId)` with the user key (`meta/client.ts:309-315`).
- The account list of a pool request is cut to the group of its row (`subscription-pool/pool-request.ts:440-447`).

## Rule for the request team (one helper)

New file `MemoryProxy/src/subscription-pool/pool-team.ts`:

```ts
export type RequestTeam =
  | { kind: "team"; teamId: string; source: "session" | "pending" | "preset" | "default" | "fallback" }
  | { kind: "error"; code: "no_active_team" | "no_team_pool" | "pool_exhausted" | "team_list_unavailable"; status: 403 | 429 | 503 };
export async function resolveRequestTeam(input: {
  config: ProxyConfig; spaceId: string; userId: string; userKey: string;
  agentSource: string; sessionKey: string | null; lcHeaders: Record<string, string>;
  model: string; modelPrefix: string | null;
}): Promise<RequestTeam | null>   // null = no pool serves this client in this instance (gate below)
export async function listMemberTeamIds(config, spaceId, userId, userKey): Promise<string[] | null>
```

Principle (user decision 9): every request has a user, and the user belongs to at least one team. There is no request without a team. The helper finds a team or returns a clear error.

Gate. The helper runs only when the cached instance rows hold at least one enabled pool row that serves this client (the agent is in its `agents`, or the model prefix is its `source_name`). Otherwise it returns `null` and the request runs exactly as today (no pool logic, no new error). So a client that no team pool serves never gets the new errors, and instances without pools pay nothing.

Step A, known team (first hit wins). The candidate must be in the user's active team list (membership cache below). If it is not, the request has no known team and goes to step B.

1. Session of this user (new read-only `SessionStore.peekForTeam(keyId, identity)`). It reads L1, then L2a, then the L2b binding row (`bindingRepo.getBinding`, `session/store.ts:399`; the row holds `teamId`, `userId`, `outcome`, written at `:220-245`). It compares `userId` on every layer (L1 `get` does not, `:121-133`, so the peek adds the check). It never rebuilds from L2b (`:432`) and never runs the history scan (`:394`, `:405`), so it makes no Core call and writes nothing.
   - `initialized` and not bypassed (or L2b `outcome: "initialized"`) → `sessionInfo.team_id` / binding `teamId`.
   - bypassed with a chosen team: the state has `selectedTeamId` (Claude Code sets it when the chosen team has no agent, `session/claude-code/init.ts:238-249`) → that team.
   - bypassed without a chosen team (the user chose "skip" before a team, or an L2b row with `outcome: "bypassed"` and no `teamId`) → no known team; go to step B.
   - pending with `selectedTeamId` → that team. The Claude Code flow sets it when the team is chosen or skipped (`session/claude-code/init.ts:245`, `:260`, `:269`, `:280`, `:320`, `:346`). [UNVERIFIED] that the final form turn of each client forwards the user's first message upstream in the same turn; `anthropic.ts:827-833` suggests it does for Claude Code. Test it per client.
2. Header preset, when `sessionInit.headerAutoSelect.enabled` (`preset.ts:76-94`) → its `teamId` (registration then happens in the same turn, `session/codebuddy/init.ts:894-920`, `:949-1021`).
3. User session default → its `team_id`. Read it with `metadataClient.getUserSessionDefault(userId)` (`session/user-default.ts:53`) and cache it 60 s per user; registration with it happens in the same turn (`session/codebuddy/init.ts:853-877`). Called only when rules 1-2 gave nothing.

A known team decides alone: its pool serves the request when it has one; when it has none, the request runs on the shared normal upstream (user decision 3). Rule: the fallback of step B never replaces a team that the session, the user's form choice, the preset or the default gave. So a bypassed session with a chosen team never moves to another team's pool.

Step B, ordered fallback (plan D14). Used only when step A gives no team: no session id, `x-memory-mode: off`, sidequery or fork without a main session, a bypassed session without a chosen team, or a known team that the user is no longer a member of.

1. Team list = the membership cache value, in the order Core returns it, active teams only. Core sorts by `created_at` descending on both stores (`sqlite-adapter.ts:1145`; `mongodb-adapter.ts:872-882`, `{ created_at: -1 }`), and `MetaClient.listTeams` keeps the page order (`meta/client.ts:309-315`). So the newest team comes first and the default team (`default` in production, the oldest team) usually comes last. The plan keeps this order (user decision: "in the order Core returns it").
2. Zero active teams → error `no_active_team`, HTTP 403, message "The user is not an active member of any team, so no subscription pool can serve <client>."
3. For each team in order: the team has an enabled pool row that serves this client, and `selectAccount(accountsOfThatGroup, null, now, snapshot.thresholdPct, model, 0, unavailableAccountIds(space, now)) !== null` (`selector.ts:69-111`; it uses each account's own threshold, step 8 below, and skips accounts in a refresh cooldown). The first such team wins.
4. No team qualifies:
   - at least one team of the user has a pool for this client, but none has a usable account → `pool_exhausted`: the existing exhausted answer with the earliest reset over those pools (`exhausted-response.ts`, HTTP 429), so the client waits for the reset;
   - else → `no_team_pool`, HTTP 403, message "No team of this user has a subscription pool for <client>. Open the session in a team that has one, or ask a team admin."
   All errors use the client's error envelope (Anthropic or OpenAI, as in `instance-upstream-early.ts:76-118`) and log `[subscription-pool] no usable team pool code=<code>`, without the user key.
5. The fallback team is not stored as the session team. Each request runs step B again, so a request can move to another team when an earlier team's accounts become usable again (one prompt-cache miss).

Membership cache. Key `spaceId\0userId`, value = ordered list of active team ids from `listTeams`; good for 60 s; on a Core error keep the last good value up to 10 minutes. Concurrent calls share one promise. Max 2 000 entries (drop the oldest). Same shape as the role cache in `account-switch-access.ts`. The call uses the Core timeout of `MetaClient` (`meta/client.ts:302`, `coreSkill.timeoutMs`, 3 s by default). With no value (cold cache and Core slow or down) the helper returns `team_list_unavailable`, HTTP 503 with `Retry-After: 5`, for gated requests only. It does not fall back to the normal upstream, because the team of the request is unknown (user decision 9).

Inputs and where they come from. In `anthropic.ts` the session key, headers and user key are built at `:661-688`, after the model-source stage (`:510`) and the early stage (`:583`). Hoist a small pure block before `:510` that reads: `userId = earlyVerify.userId` (already used at `:584`), `userKey = c.req.header("x-tdai-user-key") || extractApiKey(c)` (same expression as `:661-662`), `lcHeaders` (as `:672-675`), `sessionId = resolveConversationId(c)` (as `:678-679`). The helper uses only the header session id, not the profile fallback of `resolveSessionKey` (`:680`); Claude Code always sends `x-claude-code-session-id`. Other runners:

| Runner | Before the model-source stage | Session id expression to reuse |
|---|---|---|
| `codex.ts` | `userId` at `:308`; stage at `:339` | `:456` (`resolveConversationId(c) ?? (agent === "omp" ? resolveOmpSessionId(c, body) : null)`), hoist above `:339` |
| `openai-chat.ts` | `earlyVerify` at `:397`; stage at `:417` | `:646-647`, hoist above `:417` |
| `workbuddy.ts` | `userId` at `:1213`; stage at `:1239` | session id used for `:1317`, hoist above `:1239` |
| `antigravity.ts` | `verify` at `:309`; `resolvePool` at `:495` | session id used by its init at `:522`, hoist above `:495` |

## Team-aware resolution

1. GitNexus first: `impact --direction upstream` for `resolveForAgent` (index says HIGH, 16 affected; it misses the dynamic imports at `codex.ts:410` and `workbuddy.ts:1282`, so also use the `rg` list below), `stageModelSource`, `stageInstanceUpstreamEarly`, `stageInstanceUpstreamResponses`, `openPoolRequest` (LOW), `resolveSwitchPool`, `listSourceModels`, `getCursor`, `setCursor`.

2. `instance-upstream-cache.ts`:
   - `InstanceUpstreamRow.team_id?: string`.
   - `resolveForAgent(items, agentSource, teamId: string | null)`:
     1. Team layer: when `teamId` is non-empty, the pool row with `team_id === teamId`, `enabled`, and `agents` holding the agent → `{ kind: "pool", row }`. A switched-off team pool is skipped (its clients use their instance group).
     2. Instance layer: the current algorithm over rows that are **not** pool rows. Pool rows never give `blocked` any more.
   - A pool row without `team_id` or with `''` is never used (plan D8).

3. Every call site gets the helper result (current `rg -n "resolveForAgent\(" MemoryProxy/src` list, 8 sites). One rule for all sites: `null` (gate closed) → `resolveForAgent(rows, agent, null)`, the instance layer, exactly as today; `{ kind: "team" }` → `resolveForAgent(rows, agent, teamId)` (team pool, else the instance layer = shared normal upstream); `{ kind: "error" }` → return that error response at once, before any upstream call.

| Site | Where the helper result comes from |
|---|---|
| `pipeline/stages/instance-upstream-early.ts:69` (anthropic early) | new input `requestTeam`, from `resolveRequestTeam` in `anthropic.ts` in the hoisted block before `:510`; an error becomes `blockedResp` (`:73-118` shape) |
| `pipeline/stages/instance-upstream-responses.ts:91` | new input `requestTeam`; codex passes the pre-init result, changed by step 4 after session init |
| `pipeline/runners/codex.ts:413` (gate flag) | same result as the responses stage |
| `pipeline/runners/workbuddy.ts:1285` (gate flag) | pre-init result |
| `pipeline/runners/utility.ts:141` (aux, no session init) | `resolveRequestTeam` with the session header (step A rule 1, else step B) |
| `pipeline/runners/antigravity.ts:320` (`resolvePool`, called at `:415` models and `:495` dialogue) | dialogue: pre-init result; models: step 5. A known team without an AntiGravity pool keeps the existing 400 at `:322-325` ("runs only on a subscription pool"), because AntiGravity has no normal upstream |
| `subscription-pool/account-switch-access.ts:111` (`resolveSwitchPool`) | `resolveRequestTeam` for the bridge's session (`subscription-bridge.ts:129`, `:243`) and the injector (`injection/injectors/subscription-tools-injector.ts:149`), so the bridge shows the pool that serves the request; `null` or an error → `not_pool_session` |
| `pipeline/stages/model-source.ts:95` | new input `requestTeam`; the row search becomes `isSourceRow(r) && r.source_name === prefix && (r.mode !== "subscription_pool" \|\| r.team_id === teamId)`. A known team without that pool → `none` (as if no pool exists, user decision 3); step B already took the prefix into account when it chose a fallback team |

   `stageModelSource` callers pass the pre-init result: `anthropic.ts:510`, `codex.ts:339`, `workbuddy.ts:1239`, `openai-chat.ts:417`.

4. After session init, before the pool opens (`anthropic.ts:1125`, `codex.ts:1158`, `antigravity.ts:557`), three cases:
   - a. Session init ran and the session is registered (not bypassed), or it is bypassed with a chosen team (`selectedTeamId`): that team is the known team. Equal to the pre-init team → go on. Different (the pre-init result was a fallback team or another team) → resolve again with the known team: its pool row → open that pool; no pool → shared normal upstream. For Claude Code the official target is computed after session init (`anthropic.ts:1093-1104`), so both outcomes work in the same turn. If the instance result of the new team is an override group, this one turn uses the official target and logs `[subscription-pool] team changed during session init; official target this turn`.
   - b. Session init ran and the session is bypassed without a chosen team: keep the pre-init result. It came from step B, because the peek found no chosen team either.
   - c. Session init did not run (sidequery and fork without a main session, `anthropic.ts:776-779` and `:814-820`; `x-memory-mode: off`, `:552-558`; `sessionInit.enabled` off; an init error, `:932-936`): keep the pre-init result (step A from the session peek when a main session exists, else step B).

   Note on rule 2 and 3 of the helper: the same-turn registration is read in the CodeBuddy-family init (`session/codebuddy/init.ts:853-877`, `:894-920`). [UNVERIFIED] for the Claude Code, Codex and AntiGravity init files; the forwarding tests below cover each runner.

5. Session-less endpoints:
   - `modelsHandler.ts:128-146` (`handleModels`) and `:152-170` (`handleSourceModel`): rows = instance rows + pool rows whose `team_id` is in `listMemberTeamIds(user)`. Two teams with the same source → one entry per model id (dedupe in `listSourceModels`, `:63-94`). Membership unavailable → instance sources only (a read-only list, so no 503 here).
   - AntiGravity model list (`runAntigravityModels`, `antigravity.ts:408-425`): the same order as step B: the first team of the user (Core order) with an enabled AntiGravity pool and a usable account. None → the existing 400.

6. Cursor per group (plan D9): `binding-store.ts:34-38` `cursorKey(spaceId, provider, groupId)` → `nottl/<space>/pool-cursor/<provider>/<groupId>`; callers `pool-request.ts:469`, `:500` pass `this.input.row.group_id`. The binding key (`binding-store.ts:28-32`) stays. Add a comment at `sessionBindingKey` that states why: the group filter of the snapshot is the isolation boundary, and a stable key keeps live bindings and the prompt cache over a deploy.

7. Logs: the existing pool log lines add `team=<team_id>`; never the user key.

8. Per-account threshold (plan D12). Core sends `threshold_pct` on each account of `accounts/list` (phase 2).
   - `subscription-pool/types.ts:36-47`: `PoolAccount.threshold_pct?: number`. `PoolSnapshot.thresholdPct` stays as the fallback (`account-cache.ts:160-163`, `:200`) for an account without the field (older Core during the deploy).
   - `selector.ts`: one helper `accountThreshold(account, fallback) = account.threshold_pct ?? fallback`. Use it in `isEligible` (`:65-66`), the round-robin pass of `selectAccount` (`:73-94`), `earliestReset` (`:137-152`) and `accountSwitchRejection` (`:176-190`). The fallback argument keeps the current signatures, so callers `pool-request.ts:477`, `:601` and `subscription-bridge.ts:284`, `:341` still pass `snapshot.thresholdPct`.
   - The bridge message (`subscription-bridge.ts:193-195`) shows the threshold of that account.

## Tests

Proxy unit tests (`vitest`):
- `subscription-pool/__tests__/resolve-pool.test.ts`: "uses the pool of the request team", "ignores the pool of another team and falls back to the default group", "ignores a switched-off team pool", "ignores a pool row without a team", "uses the instance layer when the gate is closed (no team given)". Change "a disabled pool group blocks the agent like any custom group" (`:22-26`): a team pool no longer blocks.
- New `subscription-pool/__tests__/pool-team.test.ts`:
  - step A: session initialized → its team; L2b binding only (woken session) → its team, without a rebuild; pending with selected team (multi-team and single-team Claude Code flows); header preset; user default; L1 state of another user → not used;
  - "a known team without a pool gives the shared normal upstream, not the fallback";
  - "a bypassed session with a chosen team keeps that team even when an earlier team in the list has a usable pool";
  - "a bypassed session without a chosen team uses the fallback";
  - step B: "takes the second team when the first team has no usable account"; "keeps the Core order: newest team first"; "answers pool_exhausted with the earliest reset when the user's teams have pools but no usable account"; "answers no_team_pool when no team of the user has a pool for the client"; "answers no_active_team for a user with zero active teams"; "a removed member falls to step B after the cache TTL";
  - gate: "returns null and changes nothing when no pool in the instance serves the client";
  - cache: "Core down with no cache answers team_list_unavailable 503"; "Core down with cache uses the last good list".
- Runner tests for the three cases of step 4: registered same team → pool; registered other team → that team's pool, or the normal upstream when it has none; bypassed with a chosen team → that team; bypassed without a chosen team → the fallback team; sidequery with a main session in L2a → pool of that team; "x-memory-mode: off with two teams uses the first team in Core order that has a usable account"; "x-memory-mode: off for a user whose teams have no pool answers no_team_pool".
- `pipeline/stages/__tests__/model-source.test.ts`: "a pool prefix of another team is not found"; "two teams with the same prefix each reach their own row".
- `__tests__/models-handler.test.ts`: "lists pool models of the caller's teams only"; "dedupes a source that two of the caller's teams have".
- `subscription-pool/__tests__/subscription-bridge.test.ts` and `account-switch-access.test.ts`: "switch lists accounts of the session team only".
- `subscription-pool/__tests__/binding-store.test.ts`: "keeps the binding key of a session"; "keeps one cursor per pool group".
- `subscription-pool/__tests__/claude-pool-forwarding.test.ts` and `pool-forwarding.test.ts`: "sends a team B request to its own account and never to team A"; "a session whose team changed during init uses the new team in the same turn"; "an error of the helper returns before any upstream call".
- `subscription-pool/__tests__/selector.test.ts`: "skips an account at its own threshold and keeps one below its own threshold"; "uses the pool fallback for an account without a threshold"; "earliest reset uses each account's threshold".
- `subscription-bridge.test.ts`: "rejects a switch to an account above its own threshold and names that threshold".
- Regression: `pool-off-identical.test.ts` must still pass unchanged (an instance without pools behaves as before).

Run: `cd MemoryProxy && npx vitest run src/subscription-pool src/pipeline src/__tests__/models-handler.test.ts && npm test && npm run typecheck`.

## Acceptance

- Tests pass. `rg -n "resolveForAgent\(" MemoryProxy/src --glob '!**/__tests__/**'` shows every call with a third argument.
- No pool request opens with a row whose `team_id` differs from the verified request team (asserted in the forwarding tests by recording the `group_id` of the account used).

## Risk

| Risk | Likelihood × Impact | Mitigation |
|---|---|---|
| A runner path skips the team and uses a foreign pool | Low × High | `resolveForAgent` with `null` never returns a pool row; every gated path gets a team or an error from one helper; forwarding tests per runner assert the `group_id` of the account used |
| Pool clients without a team pool now get errors (no_team_pool, no_active_team) where they had the old shared pool | Medium × Medium | Only when the team is unknown and a pool serves the client (gate); phase 0 step 5b counts these requests; clear messages that tell the user what to do |
| Fallback order surprises users: the newest team comes first, the default team last | Medium × Low | User decision keeps Core order; documented in ADR 0003 and the error text; plan question list notes it |
| Core down with a cold cache gives 503 instead of the normal upstream | Low × Medium | Last good list kept 10 minutes; `Retry-After: 5`; only gated requests |
| Fallback moves a session between teams when an earlier team recovers | Low × Low | One prompt-cache miss; accepted by the ordered rule |
| Extra Core call per request | Medium × Low | Called only when a pool row exists; 60 s membership cache; shared promise |
| Single-team form flow has no `selectedTeamId` on the final turn [UNVERIFIED] | Medium × Medium | Test "pending with selected team" on the single-team path; if missing, set `selectedTeamId` when the team step is skipped (`session/types.ts:23` says the step is skipped when there is one team) |
| Codex sessions keep their binding but change account because the cursor key changed | Low × Low | Only the round-robin start resets; bound sessions keep their account (binding key unchanged) |
| Membership revoked but cache still valid | Low × Low | At most 60 s |

## Rollback

Revert the Proxy commit and redeploy. The cursor keys of the new format are ignored by the old code; the old code reads the old cursor key (round robin restarts at 0). Bindings keep working (same key).
