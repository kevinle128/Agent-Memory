# Phase 1 report: Core schema, backfill and store rules (team-scoped Subscription Pools)

- Phase: `plans/261121-1344-team-scoped-subscription-pool/phase-01-core-schema-and-store.md`
- Branch: `feat/team-scoped-subscription-pool` (nothing committed, pushed or switched; no other submodule touched; no production access)
- Status: DONE_WITH_CONCERNS

## Outcome

The store layer of both backends now does the following:

- It keeps a `team_id` on pool groups.
- It applies the agent and name rules per scope. The instance scope holds the groups that are not pools. Each team has its own pool scope.
- It keeps source names unique per `team_id`.
- On each start it gives the pool groups without a team to the default team found by rule D6. Before that, it always gives pooled agents back to `default.agents`.
- It gives each account its own `threshold_pct`. When the column or field is added, the global value is copied in once.
- `deleteTeams` deletes the pool groups and accounts of the team and returns the account ids.

All new store tests pass on SQLite and on MongoDB. Mongo did not skip: `mongod` 8.2.5 is at `/opt/homebrew/bin/mongod`.

The store rule `team_required` is strict, as the spec says. Because of it, 130 existing tests now fail; they create pools through the service, and the service still creates them without a team. Phase 2 must pass `team_id`. The coordinator accepted this approach. See "Red tests".

## Files changed

| File | Change |
|---|---|
| `MemoryCore/src/metadata/types.ts` | +47: `team_id` on the group entity and on the create input. The move create input excludes `team_id`. The filter gets `team_id` and `mode`. New reason `team_required`. New `DeleteTeamsResult`. `threshold_pct` on the account entity, the proxy view, the upsert input (create only) and the patch. |
| `MemoryCore/src/metadata/store/interface.ts` | +35: `deleteTeams` returns `DeleteTeamsResult`. The scope invariant is commented on list, create, update and move. |
| `MemoryCore/src/metadata/store/sqlite-adapter.ts` | +289: `team_id` column in the DDL plus `migrateInstanceUpstreamTeamColumn`. The source index swap is `DROP ux_iuc_source_name`, then `ux_iuc_team_source_name(team_id, source_name)`. `backfillSubscriptionPoolTeam` is the last step of `createSchema`. Threshold column: CHECK in the DDL. Add and copy happen once in one tx, before the provider rebuild. Also changed: scope rules, the list filter, the sync filter, the move scope check, `deleteTeams`, the account map/insert/update and the regex. |
| `MemoryCore/src/metadata/store/mongodb-adapter.ts` | +270: `migrateSubscriptionPoolTeam` runs before the index block. It sets missing `team_id` to `""` and missing `threshold_pct` to the global value. It drops `ux_source_name` (ignores codes 26 and 27; any other code is logged) and then runs the backfill. Also: the `ux_team_source_name` index, `team_id: ""` on the seed insert and on the move-create insert, the same scope rules, and `deleteTeams`. `threshold_pct` is always written on insert. |
| `MemoryCore/src/metadata/store/factory.ts` | +15: `MetadataStoreConfig.defaultTeamName` comes from `TDAI_METADATA_DEFAULT_TEAM_NAME` (trimmed; the field is left out when unset). It is passed at all three construction sites: SQLite create, Mongo create and `MetadataStorePool.getStore`. |
| `MemoryCore/src/metadata/store/pool-team-scope.ts` (new, 125) | Pure shared rules: `defaultTeamSearchNames`, `pickDefaultTeam`, `upstreamGroupScope`/`sameUpstreamScope`, `parseStoredThresholdPct`, `logSubscriptionPoolTeamBackfill`. It has no dependencies. The phase 6 down-step is `.mjs`, so it can use this rule only through tsx or the built output; otherwise it must copy the rule. |
| `MemoryCore/src/metadata/store/pool-team-scope.test.ts` (new, 83) | Unit tests of the pure rules. |
| `MemoryCore/src/metadata/store/subscription-pool-migration.contract.ts` (new, 261) | Backend-neutral migration contract. It uses a legacy-seed harness (old shape, then open). |
| `MemoryCore/src/metadata/store/subscription-pool-migration.sqlite-fixture.ts` (new, 148) | Old SQLite DDL (copied on purpose) and the seed writer. |
| `MemoryCore/src/metadata/store/subscription-pool-migration.sqlite.test.ts` (new, 34) | SQLite runner (file databases, so the store can reopen them). |
| `MemoryCore/src/metadata/store/subscription-pool-migration.mongo.test.ts` (new, 162) | Mongo runner, plus Mongo-only index and store-pool wiring tests. |
| `MemoryCore/src/metadata/store/factory-default-team.test.ts` (new, 76) | Env parsing, plus wiring through `createMetadataStore` and `MetadataStorePool` (SQLite). |
| `MemoryCore/src/metadata/store/metadata-store.contract.ts` | +235: new block of 11 contract tests. One existing test was rewritten, because it moved an agent from default into a pool, which is now a cross-scope move rejected by design. It now moves the agent between two pools of one team. Its purpose ("toggle and agent moves keep the source fields") is the same. |
| `MemoryCore/src/metadata/store/subscription-account.contract.ts` | +28: the pool fixture gets a team. 2 threshold tests. |
| `MemoryCore/src/metadata/store/subscription-account.test.ts` | +11: the 6 pool fixtures get a team. No assertion changed. |
| `MemoryCore/src/metadata/store/sqlite-upstream-restart.test.ts` | +111: 3 SQLite-only upgrade tests. |
| **Outside my files:** `MemoryCore/src/metadata/service/metadata-service.ts` | +1 line: `threshold_pct: account.threshold_pct` in `toProxySubscriptionAccount`. This is a compile fix, because `SubscriptionAccountProxyView.threshold_pct` is required. |

## GitNexus impact (`impact --direction upstream`, index refreshed first)

On the first run every name was ambiguous, so the walk returned `UNKNOWN`. I ran it again per uid, so no result stays `UNKNOWN`. I confirmed the callers of `deleteTeams` with rg: the only metadata caller is `MetadataService.deleteTeams` → `deleteTeamsForCaller` → `team/delete`. `gateway/v2-router.ts:1499` uses the core `IMemoryStore`, not this store.

| Symbol (uid) | Risk | Impacted / direct | Direct callers (non-test) |
|---|---|---|---|
| `IMetadataStore.listInstanceUpstreamGroups` | **HIGH** | 36 / 24 | MetadataService: completeSubscriptionOAuth, enable/disableSubscriptionPool, getSubscriptionPoolStatus, listClientSources, updateClientSources, listInstanceUpstreamGroups(Internal/View), listSubscriptionAccountsInternal, refreshAllSourceModels, takenSourceNames, the extraction get/update/toggle/delete methods |
| Sqlite / Mongo `listInstanceUpstreamGroups` | MEDIUM | 7 / 6 | same, through the interface |
| `IMetadataStore.createInstanceUpstreamGroup` | MEDIUM | 16 / 8 | completeSubscriptionOAuth, createInstanceUpstreamCustomGroup, createInstanceUpstreamExtraction, enableSubscriptionPool |
| `IMetadataStore.updateInstanceUpstreamGroup` | MEDIUM | 15 / 8 | enableSubscriptionPool, setMultiSourceClient, updateInstanceUpstreamExtraction, updateInstanceUpstreamGroup, updateSourceModels |
| `IMetadataStore.moveAgentBetweenUpstreamGroups` | MEDIUM | 9 / 6 | setSingleSourceClient |
| `assertAgentsNotOverlap` (sqlite) | LOW | 5 | create/update group |
| `assertGroupNameUnique` (sqlite) | **HIGH** | 9 | create/update/move group |
| `IMetadataStore.deleteTeams` | LOW | 5 / 4 | MetadataService.deleteTeams |
| `mapInstanceUpstreamGroup` (sqlite) | **HIGH** | 15 | get/list/update/updateGroupSourceModels/toggle/move |
| `assertAgentsNotOverlapMongo`, `assertGroupNameUniqueMongo` | LOW | 5 each | create/update/move (mongo) |
| `_syncDefaultAgentsWithSnapshot` / Mongo | **HIGH** | 8 / 7 | list with seed |
| `mapMongoGroup` | **HIGH** | 14 | every Mongo group read |
| `upsertSubscriptionAccountByProviderId` (interface) | LOW | 5 | completeSubscriptionOAuth |
| `IMetadataStore.updateSubscriptionAccount` | MEDIUM | 19 | service account update, usage check, report, refresher |
| `mapSubscriptionAccount` (sqlite / mongo) | LOW | 11 / 10 | account reads |
| `createSchema`, `migrateSubscriptionPool`, `migrateInstanceUpstreamSourceColumns` | **CRITICAL** | 9 each | `init` (every store open) |
| `IMetadataStore.ensureDefaultSeeded` (Mongo insert changed) | **HIGH** | 30 (Mongo impl MEDIUM 7) | seed paths |
| `runSourceNameChecked` | LOW | 5 | create/update group |
| `loadStoreConfig` / `MetadataStorePool` / `createMetadataStore` | **HIGH** / **HIGH** / LOW | 10 / 44 / 3 | Core start, store pool |
| `toProxySubscriptionAccount` (compile fix; impact ran after the edit, a gap in the rule) | LOW | 5 | listSubscriptionAccountsInternal → internal-meta-router (Proxy account list) |

HIGH/CRITICAL warning: these symbols are on the start path (`init`) and on every group read. I made only additive changes there. The read map adds a field. The list filter fields are optional, and the old filter behavior does not change. `detect-changes --scope all` reports 10 files, 89 symbols, 15 flows, risk **high**. All the flows are store-contract or `init` flows. The CLI text output does not show the `partial`/`truncated` flags.

## Commands run

| Command | Result |
|---|---|
| `node .gitnexus/run.cjs analyze --index-only` | indexed (24,717 nodes) |
| Baseline before edits: `MONGOMS_SYSTEM_BINARY=/opt/homebrew/bin/mongod npx vitest run src/metadata src/subscription-pool` | 29 files, **764 passed**, 0 failed |
| `npx vitest run` SQLite store runners, right after the store edits | 21 failed (fixtures created pools without a team) → fixtures fixed → 3 files, **131 passed** |
| SQLite: new contract block + `pool-team-scope.test.ts` | **29 passed** (11 new contract tests listed) |
| SQLite: migration contract + account tests | **41 passed** |
| Mongo: migration contract + account contract | 31 passed, 1 failed (test fixture: empty `insertMany`) → fixed → **all pass** |
| `sqlite-upstream-restart.test.ts` | **5 passed** (includes `PRAGMA quick_check = ok` after the upgrade) |
| Factory wiring (SQLite) + Mongo store-pool wiring + Mongo index tests | **10 passed** |
| Whole store directory `npx vitest run src/metadata/store` (SQLite + Mongo) | 550 tests: 489 passed, **61 failed**. All are in service-driven contracts; see below. |
| Baseline command after the change: `npx vitest run src/metadata src/subscription-pool` (Mongo on) | 33 files, 839 tests: **709 passed, 130 failed**. All 75 new tests pass. The 634 other old tests pass. |
| JSON re-run of the 10 red files, failures classified by message | 130 of 130 = `team_required` ("a subscription pool group needs a team") |
| Re-run of my SQLite files after the last edit | 7 files, **185 passed** |
| Typecheck: `tsc -p <strict ad-hoc tsconfig>` on `MemoryCore/src/**` + `index.ts`. MemoryCore has no `typecheck` script and no tsconfig. | 238 errors after vs 239 on the base (`git archive HEAD`). **0 new errors.** The only error that is gone is an artifact of the export. |
| Lint: `MODE=working-tree bash scripts/ci/check-skill-queue-isolation.sh` (the only lint script) | **PASS** |

## Wire-visible changes

- Public views (`toPublicGroup`, `toPublicSubscriptionAccount`) pick fields one by one, so neither `team_id` nor `threshold_pct` reaches the Panel or public API yet.
- The internal lists that the Proxy reads return the stored rows as they are:
  - `instance-upstream/list` (through `listInstanceUpstreamGroupsInternal`) now has `team_id` on every row. Plan D7 wants this.
  - `subscription-accounts` (through `toProxySubscriptionAccount`) now has `threshold_pct` on every account. Plan D12 wants this.
  - Both changes only add fields.
- `team/delete` now also returns `deleted_pool_account_ids` (see concern 2).

## Red tests (expected until phase 2)

Cause, the same for all 130: `MetadataService.enableSubscriptionPool` (`metadata-service.ts:2454`) and `completeSubscriptionOAuth` (`:2632`) create pool groups without `team_id`. The store now rejects that with `team_required`.

| File | Failed |
|---|---|
| `src/subscription-pool/usage-check.test.ts` | 25 |
| `src/subscription-pool/pool-scheduler.test.ts` | 14 |
| `src/subscription-pool/token-refresher.test.ts` | 12 |
| `src/subscription-pool/retry-check.test.ts` | 3 |
| `src/metadata/service/model-source-fetch.test.ts` | 8 |
| `src/metadata/service/pool-model-refresh.test.ts` | 7 |
| `src/metadata/store/subscription-pool.service.test.ts` | 35 |
| `src/metadata/store/client-sources.service.sqlite.test.ts` | 7 |
| `src/metadata/store/model-source.service.sqlite.test.ts` | 6 |
| `src/metadata/store/metadata-store.mongo.test.ts` (the client-sources and model-source service contracts on Mongo) | 13 |

I did not skip, weaken or edit any of them. `subscription-pool/test-support.ts` (`createPoolFixture`) is the shared cause in `subscription-pool/*`.

**Probe behind `team_required` (no repo change).** All 130 tests stop at `team_required` during fixture setup, so the code after that line had not run. To check it, I ran the 9 red SQLite files once more with a temporary vitest setup shim in `/tmp`. The shim gave a fixed `team_id` to each pool group created without one. The shim is now deleted.

- Result: 216 tests, **207 passed, 9 failed**.
- All 9 fail on the cross-scope move rule ("group … is not in the scope of this move"). No other cause appeared, so my changes cause no further regression in service paths. Phase 2 must rework these 9:
  - `model-source-fetch.test.ts`: "does not fetch while the pool is off"
  - `client-sources.service.sqlite.test.ts`: "returns every agent with its mode, format and selected sources, and every source"; "moves claude-code from the pool to an Anthropic source and back"; "refuses to disable a pool that claude-code or a multi-source client uses"
  - `model-source.service.sqlite.test.ts`: "keeps the source through a pool off/on cycle and reports source_active"; "lets a disabled pool keep its source agents and still change them"; "sends the proxy the same account list with and without a source, pool on and off"
  - `subscription-pool.service.test.ts`: "turns the codex pool on as a source without moving codex, and switches it off only while unused"; "moves claude-code onto its own pool and returns a Claude authorize URL"
- The Mongo service contracts in `metadata-store.mongo.test.ts` were not probed. They are the same contract code as the SQLite runs above.

## Not done / deviations

- The backfill and threshold-migration tests are in a new contract file, `subscription-pool-migration.contract.ts`, with its own runners. The spec named `metadata-store.contract.ts` and `subscription-account.contract.ts`. The reason: these tests must write an old-shape database before the store opens, and the existing runners only give `makeStore()`. All spec test names are present. The two SQLite-only names are in `sqlite-upstream-restart.test.ts`.
- These choices are not in the spec. I kept them small and documented them in the code:
  - The store writes `team_id = ''` for every group that is not a pool, so only pool groups carry a team.
  - An update that changes a group into a pool → `team_required`. An update that takes a group out of pool mode clears its team, and the group joins the instance scope.
  - A move that creates its target cannot create a pool (`team_required`).
  - The backfill does not assign a team when the default team already has a group with the same source name. It logs `reason=source_name_clash`. This prevents a start failure or a half-applied Mongo `updateMany`. It can only happen after a down-step and a new pool.
  - A Mongo `dropIndex` failure other than "not found" is logged and the start continues. This is the same rule as `ensureIndex`.
- I did not update the phase file or the plan status (`ak plan` not run). The coordinator owns the plan state.
- Acceptance line 2 ("a copy of a database from before the change opens…, `PRAGMA quick_check` = ok"): my evidence is a hand-copied old schema (`subscription-pool-migration.sqlite-fixture.ts`), not a file that the base revision wrote. Phase 6 covers a restored real copy.
- I did not fix the type error in `src/subscription-pool/timer-plan.test.ts`. It existed before my change (that fixture already lacked fields) and the file is not mine.

## Open concerns (for phase 2 and later)

1. **The cross-scope move rule is next in line** (the probe shows 9 such tests). When phase 2 passes `team_id`, `setSingleSourceClient` (`metadata-service.ts:3438`) still moves claude-code from default into the pool row. That now gives `group_not_found`. Plan D15 must set pool clients on the pool row itself, through `updateInstanceUpstreamGroup` with `agents`, which checks only the team scope. The agent must stay in its instance group. Some tests move agents across scopes directly on the store, and phase 2 must rework them too: `model-source.service.contract.ts:69` and `:268`, `model-source-fetch.test.ts:63` and `:286`.
2. **`deleted_pool_account_ids`** reaches the `team/delete` response until phase 2 removes it. The coordinator accepted this. The service must also notify the scheduler for each id.
3. **Source names:** the index allows the same source name for an instance group (`team_id ''`) and a team pool. Phase 2 must reserve `sub-claude` / `sub-openai` / `sub-antigravity` for pool rows, and `takenSourceNames` must not let an instance group take them. Otherwise `sub-claude/<model>` is ambiguous in the Proxy.
4. **Group names are now unique per scope.** An instance custom group can use the name of a team pool. The service finds pools by `mode === 'subscription_pool'` together with the name, so this is safe as long as phase 2 keeps the mode filter and adds a `team_id` filter.
5. **Docs impact (minor):** the new env var `TDAI_METADATA_DEFAULT_TEAM_NAME` is not documented in any config or deploy doc that I own. Phase 5 or 6 should add it next to the other `TDAI_METADATA_*` variables.
6. **Atomicity:** the existing SQLite `deleteTeams` cascade (members, agents, tasks, assets) is still outside a transaction. The new pool step runs in its own transaction. Mongo atomicity depends on `useTransactions` (true in production per the factory default).
7. **Process housekeeping:** I removed my temp dirs. One `mongod` (pid 87561, dbpath `mongo-mem-*` in the user temp dir, parent launchd) is still running. It started on 2026-11-20, before this session, so it is not mine and I left it.
8. **Unassigned pool groups:** when no single default team is found, every start writes one error line until the operator fixes the cause. This is intended (plan D6).

Status: DONE_WITH_CONCERNS
Summary: The store schema, the backfill (rule D6), the per-scope rules, the per-account threshold and `deleteTeams` are done on SQLite and MongoDB, and all 75 new tests pass on both backends with no new type errors.
130 old service-driven tests fail on `team_required` until phase 2 passes `team_id`, and phase 2 must also replace the default-to-pool agent move.
