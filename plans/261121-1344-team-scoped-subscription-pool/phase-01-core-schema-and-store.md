# Phase 1: Core schema, backfill and store rules (SQLite and MongoDB)

## Context (read in code)

- One metadata database per instance (`MemoryCore/src/metadata/store/db-name.ts:31-55`). Teams live in the same database (`sqlite-adapter.ts:293-311`), so the backfill can read `meta_teams` in the same transaction.
- Pool group row: `meta_instance_upstream_config` (`sqlite-adapter.ts:155-180`), entity `InstanceUpstreamConfigEntity` (`types.ts:691-735`). No team field today.
- Accounts: `meta_upstream_subscription_account` (`sqlite-adapter.ts:189-220`), FK to the group with `ON DELETE CASCADE` (`:215`). No team field; this plan adds none (plan D2).
- SQLite schema changes run on every start in `createSchema` (`sqlite-adapter.ts:257-493`); the source-name index is created again on every start (`:500-512`, DDL `:139-143`).
- Mongo indexes are created in parallel in init (`mongodb-adapter.ts:226-376`); `ensureIndex` logs and does not throw on failure (`:381-431`).
- Store checks that must change:

| Check | SQLite | Mongo |
|---|---|---|
| agent overlap on create/update | `assertAgentsNotOverlap` `sqlite-adapter.ts:2814` | `assertAgentsNotOverlapMongo` `mongodb-adapter.ts:2153` (error at `:2182`) |
| group name unique | `assertGroupNameUnique` `sqlite-adapter.ts:2859-2881` | `assertGroupNameUniqueMongo` `mongodb-adapter.ts:2194` (error at `:2211`) |
| move agent between groups | `moveAgentBetweenUpstreamGroups` `sqlite-adapter.ts:2706` (conflict scan `:2721-2734`) | `mongodb-adapter.ts:2017` (overlap error at `:2047`) |
| default agents sync ("custom used") | `_syncDefaultAgentsWithSnapshot` `sqlite-adapter.ts:2405` (query at `:2447-2449`) | `_syncDefaultAgentsWithSnapshotMongo` `mongodb-adapter.ts:2284` (query at `:2317-2318`) |
| source name unique | index `ux_iuc_source_name` `sqlite-adapter.ts:139-143` + `runSourceNameChecked` `:2890-2900` | index `ux_source_name` `mongodb-adapter.ts:358-361` + handlers `:1841`, `:1930` |
| list filter | `listInstanceUpstreamGroups` `sqlite-adapter.ts:2320-2347` | `mongodb-adapter.ts:1704-1730` (filter at `:1721`) |
| team delete | `deleteTeams` `sqlite-adapter.ts:1122-1132` | `mongodb-adapter.ts:860-869` |

## Steps

1. GitNexus first (repo rule, `Agent-Memory/CLAUDE.md`): `node .gitnexus/run.cjs analyze --index-only`, then `impact --direction upstream` for `listInstanceUpstreamGroups`, `createInstanceUpstreamGroup`, `updateInstanceUpstreamGroup`, `moveAgentBetweenUpstreamGroups`, `assertAgentsNotOverlap`, `assertGroupNameUnique`, `deleteTeams`, `mapInstanceUpstreamGroup`. Write the risk level of each into the PR. Treat `UNKNOWN` as unresolved and confirm with `rg`.

2. Types (`types.ts`):
   - `InstanceUpstreamConfigEntity.team_id: string` (`''` = instance scope; a pool row has a team).
   - `CreateInstanceUpstreamGroupInput.team_id?: string`. `UpdateInstanceUpstreamGroupInput` gets **no** `team_id`: a group never changes team.
   - `InstanceUpstreamConfigFilter.team_id?: string` and `mode?: UpstreamMode`.
   - Export `POOL_SOURCE_NAMES` is not added here; it lives in `model-source-rules.ts` (phase 2) to keep one owner.

3. SQLite (`sqlite-adapter.ts`):
   - Add `team_id TEXT NOT NULL DEFAULT ''` to `instanceUpstreamTableDdl` (`:155-180`), so new databases and the rebuild path have it.
   - New method `migrateInstanceUpstreamTeamColumn()`, called in `createSchema` after `migrateSubscriptionPool()` and before `migrateInstanceUpstreamSourceColumns()` (`:491-492`): `ALTER TABLE ... ADD COLUMN team_id TEXT NOT NULL DEFAULT ''` when `pragma_table_info` does not list it (same pattern as `:500-510`).
   - Replace the source index DDL (`:139-143`) with `CREATE UNIQUE INDEX IF NOT EXISTS ux_iuc_team_source_name ON meta_instance_upstream_config(team_id, source_name) WHERE source_name != ''` and run `DROP INDEX IF EXISTS ux_iuc_source_name` before it, in `migrateInstanceUpstreamSourceColumns` (`:511`). Update the regex in `runSourceNameChecked` (`:2895`) to the new column list.
   - New method `backfillSubscriptionPoolTeam()`, last step of `createSchema`, in one `withImmediateTx`:
     1. Agent restore, always (plan D4, D6): for each pool row, add each of its `agents` that is in no instance-scope default/custom row to `default.agents` (JSON array append, `version + 1`). This runs whatever the team result is, so no pooled agent is left in no instance group (that gives 400 `AGENT_NOT_CONFIGURED`, `instance-upstream-early.ts:103-118`). No default row → skip; the seed (`:2356-2400`) inserts all supported agents later.
     2. Find the default team with the rule of plan D6: `defaultTeamName` from the store config (env `TDAI_METADATA_DEFAULT_TEAM_NAME`) if set; else `SELECT team_id FROM meta_teams WHERE name = 'default' AND status = 'active'`, and only when that returns no row, the same query with `'default-team'`. A query with two or more rows stops the rule (no team). Pass the config field from `createMetadataStore` (`store/factory.ts:138-160`) into both store constructors; one shared pure function `pickDefaultTeam(candidatesByName)` decides, so SQLite, Mongo and the down-step agree.
     3. Exactly one row → `UPDATE meta_instance_upstream_config SET team_id = ?, version = version + 1, updated_at = ? WHERE mode = 'subscription_pool' AND team_id = ''`.
     4. Zero or several rows → leave `team_id = ''` (no team uses these pools; clients run on the default group); `console.error` one line with the count and the candidate team ids, no names.
     5. Log one line: `[subscription-pool] team backfill team=<id|none> groups=<n> agents_restored=<list>` when it changed rows. No line when nothing changed, so a restart is quiet.
   - `listInstanceUpstreamGroups`: support the `team_id` and `mode` filters.
   - `mapInstanceUpstreamGroup` (`:2905`): map `team_id` (`String(row.team_id ?? '')`).
   - `createInstanceUpstreamGroup` (`:2475-2540`): write `team_id` (default `''`). A `subscription_pool` row with empty `team_id` → `InstanceUpstreamWriteConflictError("team_required")` (add the reason to the union at `types.ts:836`).
   - Scope rules (one private helper `scopeOf(row) = row.mode === 'subscription_pool' ? row.team_id : ''`):
     - `assertAgentsNotOverlap(candidate, selfGroupId, scope)`: compare only with rows of the same scope. Instance scope = default + non-pool custom (`''`). Team scope = pool rows of that team.
     - `assertGroupNameUnique(name, selfGroupId, scope)`: same scope only.
     - `moveAgentBetweenUpstreamGroups`: all groups of the move must have the same scope; else `group_not_found`. The conflict scan (`:2721-2734`) reads only that scope.
     - `_syncDefaultAgentsWithSnapshot`: the "custom used" query (`:2447-2449`) adds `AND mode != 'subscription_pool'`.
   - `deleteTeams` (`:1122-1132`): also `DELETE FROM meta_instance_upstream_config WHERE mode = 'subscription_pool' AND team_id IN (...)`. Accounts go by the FK cascade (`:215`, `PRAGMA foreign_keys = ON` at `:242`). Return the deleted account ids so the service can tell the scheduler (phase 2): change the return type to `BatchDeleteResult & { deleted_pool_account_ids: string[] }` (read the ids before the delete). This field is internal: the service removes it before the `team/delete` response, so the public response shape does not change.

4. Mongo (`mongodb-adapter.ts`), same behavior:
   - Init, **before** the parallel `ensureIndex` block (`:226`): `updateMany({ team_id: { $exists: false } }, { $set: { team_id: "" } })` on `meta_instance_upstream_config`; then the backfill as in SQLite (find teams by name; one match → `updateMany({ mode: "subscription_pool", team_id: "" }, { $set: { team_id }, $inc: { version: 1 } })`; restore agents to the default document with `$addToSet` and `$inc: { version: 1 }`).
   - Drop `ux_source_name` (`dropIndex("ux_source_name")`, ignore "index not found"), then `ensureIndex({ team_id: 1, source_name: 1 }, { unique: true, partialFilterExpression: { source_name: { $gt: "" } }, name: "ux_team_source_name" })`. A new name is necessary: an index with the old name and another key fails with an options conflict.
   - Same scope rules in `assertAgentsNotOverlapMongo`, `assertGroupNameUniqueMongo`, move, sync (`:2317-2318` add `mode: { $ne: "subscription_pool" }`), list filter (`:1721`), mapping and create.
   - `deleteTeams` (`:860-869`): find pool group ids of the teams, delete their accounts in `meta_upstream_subscription_account`, delete the groups, return the account ids.

5. Account threshold (plan D12, user decision 4). Each account has its own threshold.
   - Types (`types.ts`): `SubscriptionAccountEntity.threshold_pct: number` (`:906-948`), `SubscriptionAccountProxyView.threshold_pct: number` (`:954-971`), `UpsertSubscriptionAccountInput.threshold_pct?: number` (`:979-991`, used only when the row is created; a re-login keeps the stored value, same rule as `display_name`), `UpdateSubscriptionAccountPatch.threshold_pct?: number` (`:1003-1019`).
   - SQLite: add `threshold_pct INTEGER NOT NULL DEFAULT 95 CHECK (threshold_pct BETWEEN 50 AND 100)` to `subscriptionAccountTableDdl` (`:189-220`). For an existing table, in `migrateSubscriptionPool` next to the other column adds (`:570-584`): when `pragma_table_info` has no `threshold_pct`, run `ALTER TABLE meta_upstream_subscription_account ADD COLUMN threshold_pct INTEGER NOT NULL DEFAULT 95`, then, in the same transaction, `UPDATE meta_upstream_subscription_account SET threshold_pct = ?` with the global value: `SELECT param_value FROM meta_config_params WHERE module = 'subscription_pool' AND param_name = 'threshold_pct' AND scope = 'global'` (table at `:423`), else 95 (`metadata/config/metadata_config_params.json:56-60`). The copy runs only when the column is added, so it runs once. A CHECK cannot be added by `ALTER TABLE`; the service validates the range (phase 2), and `migrateSubscriptionAccountProviders` (`:594-619`) copies the column by name if a later rebuild runs. Map the column in `mapSubscriptionAccount` (`:3147`), write it in `upsertSubscriptionAccountByProviderId` (`:2970`, insert only) and allow it in `updateSubscriptionAccount` (`:3041`).
   - Mongo: in init, `updateMany({ threshold_pct: { $exists: false } }, { $set: { threshold_pct: <global value> } })` on `meta_upstream_subscription_account` (global value read from the config params collection the same way, `upsertConfigParam` at `mongodb-adapter.ts:1529` shows its shape). This is idempotent. Map it in `mapSubscriptionAccount` (`:2577`, absent → 95), write it in `upsertSubscriptionAccountByProviderId` (`:2399`) and `updateSubscriptionAccount` (`:2506`).
   - The global param stays. It is the start value of a new account when the request gives no threshold (phase 2).

6. Interface (`interface.ts:265-351`): add the filter fields and the `deleteTeams` return change. Comment the scope rule on `createInstanceUpstreamGroup` and `moveAgentBetweenUpstreamGroups` (state the invariant, no plan labels).

## Tests (store contract, runs on SQLite and Mongo)

Add to `metadata-store.contract.ts` (runner `metadata-store.sqlite.test.ts`, `metadata-store.mongo.test.ts`) and `subscription-account.contract.ts` (runners `subscription-account.test.ts`, `subscription-account.mongo.test.ts`). The Mongo runner skips without a `mongod` binary (`subscription-account.mongo.test.ts:13-25`); run with `MONGOMS_SYSTEM_BINARY` set so it does not skip.

Test names (scenario names only):
- "assigns existing pool groups to the only default team and gives their agents back to the default group"
- "assigns pool groups to the team named default"
- "uses default-team when no team is named default"
- "uses only the configured name when it is set, and ignores default and default-team"
- "stops at two teams named default and does not try default-team"
- "leaves pool groups unassigned but still gives their agents back to the default group when no default team is found"
- "runs the team backfill again without a change"
- "keeps the accounts of a pool group when the group moves to the default team"
- "allows the same pool name and source name in two teams"
- "rejects a second pool for the same provider in one team"
- "rejects an agent in two pool groups of one team, and allows it in pools of two teams"
- "keeps the instance rule: an agent stays in exactly one default or custom group"
- "does not count pool agents as used when it syncs the default group"
- "rejects a pool group without a team"
- "deleting a team removes its pool groups and their accounts and leaves other teams alone"
- "copies the global threshold into every existing account when the threshold column is added"
- "uses 95 when no global threshold is stored"
- "keeps the threshold of an account through a re-login and changes it through an update"
- "does not copy the global value again on the next start"
- SQLite only (`sqlite-upstream-restart.test.ts`): "upgrades a database without the team column and keeps every row", "drops the old source name index and creates the team index".

Run: `cd MemoryCore && MONGOMS_SYSTEM_BINARY=$(command -v mongod) npx vitest run src/metadata/store`.

## Acceptance

- All store tests pass on both backends; no suite skipped.
- A copy of a database from before the change opens, gets the column, the index and the backfill, and `PRAGMA quick_check` returns `ok`.

## Risk

| Risk | Likelihood × Impact | Mitigation |
|---|---|---|
| Backfill picks the wrong team | Low × High | Exactly-one rule; phase 0 checks the name in production |
| Old source index stays and blocks a second team's pool | Medium × Medium | Drop before create; restart test asserts the index list |
| Mongo index swap fails silently (`ensureIndex` swallows errors) | Medium × Medium | Contract test reads `indexes()` and asserts `ux_team_source_name` exists and `ux_source_name` does not |
| Scope helper misses a write path | Medium × High | Enumerate with GitNexus `impact` in step 1; contract tests cover create, update, move, sync |
| Team delete leaves Proxy bindings to removed accounts | Low × Low | Harmless: those accounts leave the snapshot, and a binding to an absent account falls through (`selector.ts:83-88`) |

## Rollback

Code-only revert of this phase before deploy. After deploy, see phase 6 (down-step on the live database).
