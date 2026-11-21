---
title: "Team-scoped Subscription Pools"
description: "Each team gets its own Subscription Pools. No team can see or use the pool of another team. All current pools move to the default team."
status: pending
priority: P1
effort: 42h
branch: "detached HEAD eff54bda (deploy target: master)"
tags: [core, proxy, panel, subscription-pool, team, migration, authorization]
blockedBy: []
blocks: []
created: 2026-11-21
---

# Team-scoped Subscription Pools

Status: waiting for review. Not started. User answers of 2026-11-21 are applied (Q1-Q7). Phase 0 read-only facts are recorded. Open: Q8 (users in no team) and Q9 (normal upstream source unknown).

## Outcome

- A Subscription Pool (pool group row + its accounts) belongs to one team.
- A team sees and manages only its own pools. A team can never read, change or use the pool of another team, in Core, Proxy or Panel.
- All pools that exist on deploy day belong to the default team.
- A request uses the pool of the team of its session. A known team with no pool for the client runs on the shared normal upstream. Every request has a user and every user belongs to at least one team: when the session gives no team (for example `x-memory-mode: off`, no session id, a fork without a main session, a bypassed session without a chosen team), the request takes the first team of its user, in Core order, that has a usable pool account for the client. If no team qualifies, or the user has no active team, the request fails with a clear error. This applies only to clients that some team pool serves; other clients behave as today.

## User decisions (confirmed, do not change)

1. Team of a request = team of the registered session (`sessionInfo.team_id`). Header auto-select (`MemoryProxy/src/session/preset.ts:96-130`) also sets the team. A member of several teams uses the team of the session.
2. Scope = only `subscription_pool` groups and their accounts. Default, custom, extraction and API model sources stay per instance.
3. A team without a pool runs as if no pool exists: the normal upstream of that client. Never use an account of another team.
4. Usage threshold is set per Subscription Account. Each account of a team has its own threshold. A team admin of the account's team or the System Admin sets it. Existing accounts start with the current global value (Q3).
5. Team admin of the team plus System Admin manage a team pool (Q2).
6. Traffic that leaves the pool uses the shared normal upstream of the client, also when that is a paid key; the normal upstream stays shared by all teams (Q1, Q4).
7. Deleting a team deletes its pools and their accounts (Q5).
8. Keep the per-team Clients control and the rule that a pool cannot be switched off while a client uses it (Q7).
9. Every request has a user, and a user belongs to at least one team; there is no request without a team. When the session rules give no team, the ordered fallback of D14 picks one, or the request fails with a clear error. A user with no active team gets a clear error, not the normal upstream (Q6).

## Design decisions of this plan (verified in code)

| # | Decision | Evidence |
|---|---|---|
| D1 | Add `team_id TEXT NOT NULL DEFAULT ''` to `meta_instance_upstream_config` only. `''` = instance scope. A pool row must have a non-empty `team_id`. A pool row with `''` is used by no team (its clients run on their instance group). | Table DDL `sqlite-adapter.ts:155-180`; SQLite treats NULLs as distinct in a unique index, so a non-null sentinel is necessary for the new unique index. |
| D2 | No `team_id` on `meta_upstream_subscription_account`. The team of an account is the team of its group. Accounts cannot move between groups. | FK `group_id` with `ON DELETE CASCADE` `sqlite-adapter.ts:215`; uniqueness is per group `:216-217`; no API moves an account (`v3-meta-router.ts:475-517`). The backfill of the group row assigns the accounts too. |
| D3 | Pool rows are a per-team layer over the instance groups. Instance groups (default + non-pool custom) keep the rule "each agent is in exactly one group". Pool rows have their own rule: "each agent is in at most one pool row per team". | Unmanaged agent = 400 `AGENT_NOT_CONFIGURED` (`instance-upstream-early.ts:96-118`, `instance-upstream-responses.ts:110-125`). Today a pooled agent is only in the pool row (`metadata-service.ts:3435-3442` moves it out of default), so a hidden pool row without a fallback home breaks every other team. |
| D4 | Migration gives each pooled agent back its instance home: add it to `default.agents`. Then the default team uses its pool and other teams use the default group. | `_syncDefaultAgentsWithSnapshot` `sqlite-adapter.ts:2405-2473` and Mongo `:2284-2340` must stop counting pool rows as "used". |
| D5 | One pool per (team, provider). Pool group name and fixed source name (`sub-claude`, `sub-openai`, `sub-antigravity`) repeat across teams. Uniqueness of `name` and `source_name` becomes per `team_id`. The three fixed names are reserved for pool rows. | Fixed names `model-source-rules.ts:45-55`; name uniqueness `sqlite-adapter.ts:2859-2881`, Mongo `:2194-2215`; source index `sqlite-adapter.ts:139-143`, Mongo `:358-361`. Clients keep model ids such as `sub-claude/<model>`, so the names must not change. |
| D6 | The migration always gives pooled agents back to `default.agents` (D4), whatever the team result. Backfill target = the default team found by name. Default team rule (one function `findDefaultTeamForBackfill`, used by both stores and the down-step): when `TDAI_METADATA_DEFAULT_TEAM_NAME` is set (new optional field `defaultTeamName` of `MetadataStoreConfig`, `store/factory.ts:15-27`, read next to the other `TDAI_METADATA_*` variables at `:77-97`), match only that name. When it is unset, match `default` first; only when no team has that name, match `default-team` (the name a fresh install creates, `metadata-service.ts:155`, `:524-528`). A name step that finds exactly one active team wins. A step that finds two or more teams stops the rule at once (it does not try the next name). No match → no team. Production has one team named `default` (`team-f0bzqawutx`, confirmed by the user as the default team) and none named `default-team`, so production needs no setting. A fresh install of the new code creates its pools with a team id, so the backfill finds no unassigned pool row there; the `default-team` step only serves old databases made by a fresh install. If there is not exactly one match, pool rows stay at `team_id = ''`: no team uses them, every client runs on its default group (no 400), and Core logs an error with the candidate ids. The operator sets `TDAI_METADATA_DEFAULT_TEAM_NAME` (or fixes the team name) and restarts; the backfill runs on each start and is idempotent. | Team id is random (`metadata-service.ts:524-528`, `sqlite-adapter.ts:1080-1101`); creation is best effort (`:522-553`); name is editable (`sqlite-adapter.ts:1116-1120`); production renamed it to `default` (phase 0 results). Without the agent restore, a pooled agent is in no instance group and every request gets 400 `AGENT_NOT_CONFIGURED` (`instance-upstream-early.ts:103-118`). |
| D7 | Core sends `team_id` on every row of `instance-upstream/list`. The Proxy keeps one cache entry per instance and filters by team per request. Cache keys do not change. | `internal-meta-router.ts:103-107` → `metadata-service.ts:2330-2335` returns full entities; cache key `instance-upstream-cache.ts:164-192`. |
| D8 | Proxy fails closed: a pool row is used only when its `team_id` is non-empty and equals the verified request team. A row without the field (older Core) is not used. Consequence: while a new Proxy reads an old Core during the stack swap, a pooled client gets 400 `AGENT_NOT_CONFIGURED` for up to one cache TTL (30 s). This falls inside the known deploy gap of about one minute; phase 6 waits one TTL after Core is healthy before its checks. | Deny-by-default rule of this project; TTL `instance-upstream-cache.ts:29`, `:189-190`. |
| D9 | Session Binding key does not change. Cursor key gets `group_id`. | The account list of a request is filtered to its group (`pool-request.ts:440-447`). A binding to an account outside that list falls through to round robin and is rewritten (`selector.ts:83-88`, `pool-request.ts:503-505`). A new key format drops every live binding on deploy and loses the prompt cache of every session. The cursor is shared by provider (`binding-store.ts:34-38`), which skews round robin between teams. |
| D10 | Request team comes from one Proxy helper, with membership checked against Core and cached. See phase 3 for the full rule per entry point. | Session store L1 read does not compare the user (`session/store.ts:121-133`); L2a and L2b do (`:496-502`, `:538-542`). Membership can change after registration. |
| D11 | Core authorization: view = active member of the team or System Admin; manage = team admin of the team or System Admin. Account routes find the team through `account → group → team_id`. A cross-team id answers `account_not_found` / `POOL_NOT_FOUND`, not `permission_denied`. | Team admin check `metadata-service.ts:1916-1921`; today every pool route uses `assertCanManageUsers` (System Admin only, `:821-825`) and `status` has no check (`v3-meta-router.ts:475-477`). **User confirmed (Q2).** |
| D12 | Threshold is a column of the account row: `threshold_pct INTEGER` on `meta_upstream_subscription_account` (SQLite) and field `threshold_pct` (Mongo). The migration copies the current global value (`meta_config_params` `subscription_pool.threshold_pct`, default 95) into every existing account once. Account create (OAuth complete) and account update set it (integer 50-100; manage right of the account's team). Every reader uses the threshold of the account: Core usage check and timers, Proxy selector, Account Switch. The global param stays only as the start value of a new account when the request gives none; only the System Admin changes it. | Today one global param (`metadata-service.ts:2405-2408`, write `:2499-2505`) is read by the timer plan (`timer-plan.ts:17-35` via `pool-scheduler.ts:88`, `:137-138`), the usage check (`metadata-service.ts:2686`, `usage-check.ts:24-53`), the scheduler listener (`:2513-2522`, `SubscriptionAccountChange.thresholdPct` `:207-215`), the internal account list (`:2555-2566`) and in the Proxy the snapshot (`account-cache.ts:160-163`), selector (`selector.ts:65-66`, `:73-94`, `:137-152`, `:176-190`), pool request (`pool-request.ts:477`, `:601`) and bridge (`subscription-bridge.ts:284`, `:341`). Default 95 in `metadata/config/metadata_config_params.json:56-60`. **User decision (Q3).** |
| D13 | Token refresh and usage timers keep their keys (`instanceId + accountId`) and Core still owns all tokens of the instance. The only change: the reset-check timer and the usage check read the threshold of each account (D12). Team delete notifies the scheduler for each removed account. | `pool-scheduler.ts:81-115`, `:130-160`; pool model list uses only accounts of the same group (`metadata-service.ts:3545-3547`). |
| D14 | Team of a request, in order (phase 3 helper): (A) known team from the registered session, a bypassed session's chosen team, a pending form choice, the header preset or the user session default; (B) else the ordered fallback: the user's active teams in the order Core returns them, the first team with an enabled pool for the client and at least one usable account (`selectAccount` with each account's threshold). No team qualifies → 429 with the earliest reset when the user's teams have pools but no usable account, else 403 `no_team_pool`; zero active teams → 403 `no_active_team`; team list unreadable → 503 `team_list_unavailable`. A known team is never replaced by the fallback; a known team without a pool runs on the shared normal upstream. The helper runs only when some enabled pool row in the instance serves the client; other clients behave as today. | Order: `ORDER BY t.created_at DESC` on SQLite (`sqlite-adapter.ts:1134-1148`) and `{ created_at: -1 }` on MongoDB (`mongodb-adapter.ts:872-882`), so the newest team is first and the default team (`default` in production, the oldest) usually last. Requests without a registered team today: `x-memory-mode: off` (`anthropic.ts:552-558`), no session id (`pool-request.ts:251-252`), bypass (`session/store.ts:416-429`). Bypass with a chosen team: `session/claude-code/init.ts:238-249`. **User decision (Q6).** |
| D15 | Clients that use a team pool are chosen on the Subscription Pool page of the team (new route `subscription-pool/clients/update`), not on the instance API Key page. Disable still answers `SOURCE_IN_USE` (409, `detail.clients`) while the team pool has clients. | The instance client-source picker cannot hold a per-team choice (`metadata-service.ts:3365-3399`). The rule "do not switch off a source that a client uses" is an accepted convention (skill `multi-source-model-routing`; `metadata-service.ts:2490`, `:3292-3301`). **User confirmed (Q7).** |

## Data flow

```
Panel (active team) ── user key ──▶ Hub meta proxy (panel/http/routes/meta/proxy.ts:176)
   └▶ Core /v3/meta/subscription-pool/* { team_id, ... }
        assertCanViewTeamPool / assertCanManageTeamPool (team member / team admin / System Admin)
        store: groups WHERE mode='subscription_pool' AND team_id=?  → accounts WHERE group_id IN (...)

Client ──▶ Proxy runner
   resolveRequestTeam(space, user, agent, session)  ── membership cache ──▶ Core /v3/meta/team/list (user key)
   rows = getInstanceUpstreamConfigs(space)          ── 30 s cache ──▶ Core /v3/internal/meta/instance-upstream/list (rows + team_id)
   resolveForAgent(rows, agent, teamId)  → team pool row | instance-level result
   stageModelSource(..., teamId)         → only pool rows of teamId
   openPoolRequest(row of teamId)        → accounts filtered by row.group_id (pool-request.ts:446)
```

## Phases

| # | File | Content | Depends on | Effort |
|---|---|---|---|---|
| 0 | [phase-00-preflight-measure-and-confirm.md](phase-00-preflight-measure-and-confirm.md) | Read-only production facts (with user permission), user confirmation of the behavior change | — | 2h |
| 1 | [phase-01-core-schema-and-store.md](phase-01-core-schema-and-store.md) | `team_id` column, account `threshold_pct` column, indexes, backfills, store rules on SQLite and Mongo, contract tests | 0 | 8h |
| 2 | [phase-02-core-service-and-api-authorization.md](phase-02-core-service-and-api-authorization.md) | Team-scoped pool service, route authorization, OAuth state, team delete, per-account threshold in routes and timers, API doc | 1 | 9h |
| 3 | [phase-03-proxy-team-resolution-and-routing.md](phase-03-proxy-team-resolution-and-routing.md) | Request team helper, team-aware resolution in every pool entry point, cursor key, per-account threshold in selector and bridge | 2 (fields on internal lists) | 11h |
| 4 | [phase-04-panel-team-pool-ui.md](phase-04-panel-team-pool-ui.md) | Pool page per active team, role rule, pool clients, account threshold field, i18n | 2 | 7h |
| 5 | [phase-05-tests-and-docs.md](phase-05-tests-and-docs.md) | Cross-package isolation tests, local e2e, CONTEXT.md, ADR 0003, API docs | 3, 4 | 3h |
| 6 | [phase-06-deploy-verify-rollback.md](phase-06-deploy-verify-rollback.md) | Backup, migration on a restored copy, deploy, checks, tested down-step | 5 | 2h |

Phases 3 and 4 can run in parallel: they touch different packages. Phases 1 and 2 run in sequence: phase 2 needs the store contract of phase 1.

## File ownership

| Phase | Files |
|---|---|
| 1 | `MemoryCore/src/metadata/types.ts`, `MemoryCore/src/metadata/store/{interface,sqlite-adapter,mongodb-adapter}.ts`, store contract and test files in `MemoryCore/src/metadata/store/` |
| 2 | `MemoryCore/src/metadata/service/{metadata-service,model-source-rules}.ts`, `MemoryCore/src/metadata/subscription-pool/authorize-url.ts`, `MemoryCore/src/metadata/router/{v3-meta-router,v3-meta-schemas}.ts`, `MemoryCore/src/subscription-pool/{pool-scheduler,usage-check}.ts`, `MemoryCore/v3-api-memorycore-doc.md`, service and scheduler test files |
| 3 | `MemoryProxy/src/instance-upstream-cache.ts`, new `MemoryProxy/src/subscription-pool/pool-team.ts`, `MemoryProxy/src/session/store.ts` (one read-only method), `MemoryProxy/src/pipeline/stages/{model-source,instance-upstream-early,instance-upstream-responses}.ts`, `MemoryProxy/src/pipeline/runners/{anthropic,codex,workbuddy,openai-chat,antigravity,utility}.ts`, `MemoryProxy/src/modelsHandler.ts`, `MemoryProxy/src/subscription-pool/{account-switch-access,subscription-bridge,binding-store,pool-request,selector,account-cache,types}.ts`, Proxy test files |
| 4 | `MemoryPanel/src/panel/api/meta-actions.ts`, `MemoryPanel/web/src/lib/api/{subscription-pool,client-sources}.ts`, `MemoryPanel/web/src/pages/SubscriptionPoolPage/**`, `MemoryPanel/web/src/pages/ModelProviderPage/use-provider-groups.ts`, `MemoryPanel/web/src/pages/ApiKeysPage/components/ClientEndpoints.tsx`, `MemoryPanel/web/src/i18n/{en-US,zh-CN}.ts`, `MemoryPanel/panel-api-doc.md`, Panel test files |
| 5 | `CONTEXT.md`, new `docs/adr/0003-team-scoped-subscription-pool.md`, cross-package e2e test files only |
| 6 | New `MemoryCore/scripts/ops/subscription-pool-team-scope-down.mjs` (down-step), operator notes in this plan, one line in the `deploy-agent-memory` skill after user approval |

## Test matrix (summary; detail in each phase)

| Layer | What |
|---|---|
| Store contract (SQLite + Mongo) | column/field exists; backfill to the one default team; ambiguous default team leaves rows unassigned but restores agents; idempotent restart; per-team name and source uniqueness; reserved names; per-team agent rule; default sync ignores pool rows; team delete removes pool rows and accounts; account threshold column, one-time copy of the global value, update keeps it |
| Core service and routes | every `subscription-pool/*` route: own team OK, other team denied without leak, member read-only, System Admin all; OAuth state bound to team; status never returns accounts of another team; generic group routes reject pool rows; account threshold set by team admin and System Admin only, range 50-100; timers and usage check use the account threshold |
| Proxy unit | `resolveForAgent` with team; `stageModelSource` with team; request team rules (session, pending, preset, default, membership); fallback order, second team when the first has no usable account, errors for no usable team and zero teams, bypassed session keeps its chosen team, `x-memory-mode: off` with two teams; bridge uses session team; models list union; cursor per group; binding key unchanged; selector, exhausted answer and Account Switch use each account's threshold |
| Panel | API calls carry `team_id`; read-only rule; clients toggle; threshold field per account; i18n keys in both locales; typecheck |
| E2E (local, two teams) | team A pool serves team A session; team B session goes to its instance home; `x-memory-mode: off` requests pick the first team with a usable account or get a clear error; team B cannot see A in Panel or API; default team keeps old behavior after migration; two accounts with different thresholds stop getting new sessions at their own value |
| Production (after deploy) | migration log line; default team pool still serves; one non-default team request goes to its home; one `x-memory-mode: off` request of a default team user uses the default team pool; no new 4xx/5xx in 10 minutes |

## Rollback (summary; detail in phase 6)

- Code-only rollback is safe only after the down-step. The down-step runs on the live database, so rotated refresh tokens stay (ADR 0001: providers rotate refresh tokens; a restored backup holds tokens that the provider already rotated).
- Restore of the backup is the last resort. After it, accounts whose tokens rotated since the backup need a new login.

## Success criteria (measurable)

1. `cd MemoryCore && npx vitest run src/metadata/store src/metadata/service src/metadata/router src/subscription-pool` passes, with the Mongo suites not skipped (a `mongod` binary is present).
2. `cd MemoryProxy && npm test && npm run typecheck` passes.
3. `cd MemoryPanel && npm test && npm run typecheck` and the web typecheck pass.
4. Local e2e with two teams meets all rows of the e2e matrix.
5. Production: Core log has one backfill line with the default team id and the count of rows; a default team (`team-f0bzqawutx`) Claude Code turn has a pool `account_id` in the Proxy log; a status call for another team returns an error without accounts; every existing account has `threshold_pct` equal to the global value read in phase 0.

## Questions

1. Q1 (answered 2026-11-21): the user accepts that requests of non-default teams stop using the default team pools, and that the shared normal upstream stays shared for all teams. Requests without a known team use the fallback of D14 (Q6), not the normal upstream. Phase 0 still counts the affected requests for the record.
2. Q2 (answered): team admin of the team plus System Admin manage a team pool (D11). The System Admin sees the pools of all teams.
3. Q3 (answered, corrected): the threshold is per Subscription Account; existing accounts start with the current global value (D12).
4. Q4 (answered): the user accepts that traffic leaving the pool uses the shared normal upstream, even if it is a paid key. Phase 0 still records which upstream it is, without values.
5. Q5 (answered): deleting a team deletes its pools and their accounts.
6. Q6 (answered 2026-11-21): every request has a user and every user belongs to at least one team. Requests whose team the session rules cannot give use the ordered fallback of D14; no qualifying team or no active team gives a clear error. A known team without a pool still runs on the shared normal upstream; this differs from the fallback on purpose. The fallback order is the Core order (newest team first, so the default team `default` usually comes last).
7. Q7 (answered): keep the per-team Clients control (D15) and the rule that a pool cannot be switched off while a client uses it.
8. Q8 (open, user decides before deploy): 3 active users in production are in no team. After deploy every request of theirs to a pooled client gets 403 `no_active_team` (D14, user decision 9). Options: (a) add them to a team (for example `default`) before deploy; (b) accept the 403. Phase 0 did not read who they are; read their user ids (no names) only with the user's go.
9. Q9 (open): the production Proxy config has no `upstream:` section and no `UPSTREAM*` environment variable, so the source of the shared normal upstream is unknown (`pipeline/stages/resolve-target-full.ts:58-67` falls back to `upstream.url`). Requests of a known team without a pool (today: team `GAME MOBILE STUDIO`, 2 members) go there. If it is empty or wrong, those requests fail after deploy. Find the effective value (config defaults in code, or the rendered config at container start) before deploy.
