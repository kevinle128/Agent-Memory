# Phase 2 report: Core service and API authorization (team-scoped Subscription Pools)

- Branch `feat/team-scoped-subscription-pool`. Nothing committed, pushed or switched. No MemoryProxy or MemoryPanel edit. No production access.
- Status: DONE_WITH_CONCERNS

## Outcome

Every `subscription-pool/*` route is team scoped and authorized. The 130 red tests are green by fixing the service behavior. The full MemoryCore suite passes: 91 files passed, 1 skipped; 1606 tests passed, 1 skipped (`MONGOMS_SYSTEM_BINARY=$(command -v mongod) npx vitest run`, Mongo suites not skipped). `src/metadata src/subscription-pool` also passes (34 files, 873 tests before the Mongo runner of the new contract was added).

## Deviations (first item needs a decision)

1. **client-sources catalog.** The task text says "lists only the pool sources of the caller's teams". The phase spec says to drop pool rows, and `client-sources/update` answers `SOURCE_NOT_FOUND` for a pool name. I built the spec version: the catalog has no pool source (`clientSourceGroups` filters `mode !== "subscription_pool"`). Reason: the same source name `sub-claude` repeats in every team, so a catalog row would be ambiguous, and update could not accept it. Pool clients come from `subscription-pool/status` `clients`. To switch to the other version, change that one filter and `buildClientSources`; ask if wanted.
2. `check-all` without `team_id` is allowed for the System Admin only (spec: "optional only for System Admin").
3. A System Admin who names a team that does not exist gets `404 team_not_found` on enable, status and login (no pool row for a ghost team that a team delete could never remove). A blank team gives `400 team_required` before the store is reached (`''` is the store marker of unassigned pool rows).
4. `groups/source-models/update` and `groups/source-refresh` answer `403 permission_denied` for a non-System-Admin who is not admin of the pool's team, with one answer for a missing id, an instance group and another team's pool.
5. Account routes answer `404 account_not_found` also to a same-team member on a manage route (literal spec rule). Team-level routes answer `403` for non-members.
6. `team/delete`: the service `deleteTeams` strips `deleted_pool_account_ids`, notifies the scheduler once per account, and drops open logins of the deleted teams.
7. A store file was not changed. No store bug was found.

## Files changed (Core only)

| File | Change |
|---|---|
| `src/metadata/service/metadata-service.ts` | Team helpers (`assertCanViewTeamPool`, `assertCanManageTeamPool`, `requireTeamPoolGroup`, `requireTeamPoolAccount`, `assertCanManageSourceGroup`, `teamPoolGroup`); team argument on status, enable, disable, login start and complete, check-all; new `updateSubscriptionPoolClients`; `assertNotPoolGroup` on generic create/update/toggle/delete; `takenSourceNames` takes a scope; catalog and `setSingleSourceClient` ignore pool rows; per-account threshold (`defaultSubscriptionThreshold`, `assertThresholdPct`, usage check uses the account value); `SubscriptionAccountChange.thresholdPct` removed; internal list and public account carry `threshold_pct`; `team_id` on public group; OAuth pending state bound to team and caller; `deleteTeams` cleanup |
| `src/metadata/service/model-source-rules.ts` | `POOL_SOURCE_NAMES`; `SOURCE_NAME_RESERVED` for a non-pool group |
| `src/metadata/router/v3-meta-router.ts` | Team checks on every pool route; new `subscription-pool/clients/update`; `POOL_NOT_FOUND` mapped to 404; `POOL_GROUP_TEAM_SCOPED`, `SOURCE_NAME_RESERVED`, `team_required` mapped to 400; source model routes use `assertCanManageSourceGroup` |
| `src/metadata/router/v3-meta-schemas.ts` | `team_id` required on status/enable/disable/oauth-start/oauth-complete; `threshold_pct` (50-100) on account update and login; `clients/update` schema; `check-all` optional `team_id` |
| `src/subscription-pool/pool-scheduler.ts` | Scheduler target no longer has a global threshold; `syncAccount` uses `account.threshold_pct` |
| `v3-api-memorycore-doc.md` | Pool routes, rules, error codes, internal rows |
| Tests | New `store/subscription-pool-team-scope.contract.ts` (+ sqlite runner, Mongo runner in `metadata-store.mongo.test.ts`, 25 tests per backend); changed `subscription-pool.service.test.ts`, `client-sources.service.contract.ts`, `model-source.service.contract.ts`, `service/model-source-fetch.test.ts`, `service/pool-model-refresh.test.ts`, `subscription-pool/{test-support,pool-scheduler,pool-scheduler-source-models,timer-plan,usage-check}.test.ts`, `router/subscription-pool-provider-schema.test.ts` |

## Old test to new test (behavior the spec changed)

- Status "members and system admins view" to "allows members of the team and system admins to view the team pool" plus "refuses status of a team the caller is not in".
- "moves claude-code onto its own pool..." to "gives claude-code to the team pool and back without leaving the default group". `moveIntoPool`/`releaseToDefault` replaced by `updateSubscriptionPoolClients`; the `SOURCE_IN_USE` asserts stay.
- Codex pool "switch off only while unused" and custom-upstream tests: pass `team_id`, assert `codex` stays in its instance group.
- "rejects a base url on a subscription pool group" to "refuses to create a subscription pool group through the generic group call" (`POOL_GROUP_TEAM_SCOPED`).
- Client-source tests that chose `sub-claude`/`sub-openai` in the catalog now use `clients/update`; the catalog list test no longer lists the pool; "does not take over a source name another group holds" to "keeps the fixed pool names for pool rows" (`SOURCE_NAME_RESERVED`).
- Model-source pool tests ("fixes provider and format", "source_enabled", off/on cycle, disabled pool clients, proxy account list) now use the pool calls; generic update on a pool row asserts `POOL_GROUP_TEAM_SCOPED`.
- Member mutation route tests: new team-aware bodies; account routes assert 404.
- Fixture agents `omp` got explicit formats, because the pool format check now applies.

New coverage: cross-team read/write attempts (every team call and every account route, same answer as a missing id), source model route answer parity, blank/unknown team, isolation of status/clients/internal list, check-all per team, generic group routes refuse pools, catalog hides pools, login bound to team and user, threshold range (service direct call and route), threshold rights, start value, global change keeps accounts, per-account timers, usage check at account threshold, team delete (accounts, scheduler notify, no leak in response, logins dropped), clients storage rules.

## GitNexus impact (upstream, run per file path, `-r` set)

All LOW except: `notifySubscriptionAccount` MEDIUM (16 impacted, 6 direct), `runSubscriptionUsageCheck` MEDIUM (7/5), `toPublicSubscriptionAccount` MEDIUM (11/6), `requireSubscriptionAccount` MEDIUM (14/5). I kept their signatures, except `notifySubscriptionAccount` (field removed, callers all in this file) and `toPublicSubscriptionAccount` (field added). Others: getSubscriptionPoolStatus 3, enable 4, disable 2, updateClientSources 2, listClientSources 2, deleteTeams 1, subscriptionThreshold 22 (renamed, all callers updated; confirmed by rg and tsc), takenSourceNames 12, setSingleSourceClient 3, clientSourceGroups 6, planAccountTimers 5, syncAccount 6, checkAccountUsage 7, resolveSourceWrite 8. `completeSubscriptionOAuth`, `startSubscriptionOAuth`, `deleteTeamsForCaller`, `checkAllSubscriptionAccountUsage` showed 0 callers: this is UNKNOWN-like (route table property access), so I confirmed callers with rg: only `v3-meta-router.ts` and tests. Not run for `requireSourceGroup`, `buildClientSources`, `sourceClients`, `mapErrorCode`, `createPendingSubscriptionOAuth`: all file-local, edited only additively or not at all (`mapErrorCode` got new cases; its only caller is the router handler).

## Typecheck

MemoryCore has no tsconfig or typecheck script. I used the same ad-hoc strict config as phase 1 on `src/**` + `index.ts`: base 240 errors, after 242 by count. After path normalization the difference is only: 2 errors that exist as the same pattern in the existing route-test harness (`IncomingMessage` cast, handler `Promise<T>`) and one more field in the fixture error of `timer-plan.test.ts` (an old error with the same text). The two new errors in my new contract file were fixed afterwards; a re-run shows no error in that file. No new error in service, router or scheduler files.

## Commands

- Baseline of old state: from phase 1, 709 passed / 130 failed.
- `MONGOMS_SYSTEM_BINARY=$(command -v mongod) npx vitest run` (full MemoryCore): 91 files passed, 1 skipped; 1606 tests passed, 1 skipped.
- `npx vitest run src/metadata/store/metadata-store.mongo.test.ts -t "team scope"`: 25 passed (Mongo).
- Acceptance rg: `subscriptionPoolName(` remains only in `teamPoolGroup`, the creation sites and the status loop (after the team filter).

## Open concerns

1. Deviation 1 (catalog) needs a user decision.
2. MemoryProxy and MemoryPanel callers that need changes (read-only rg, no edit): Panel `meta-actions.ts` (allowlist lacks `subscription-pool/clients/update`), `web/src/lib/api/{subscription-pool,client-sources,model-providers}.ts` and the SubscriptionPoolPage files (no `team_id`; top-level `threshold_pct` is now `default_threshold_pct` on status); Proxy `account-cache.ts`, `selector.ts`, `pool-request.ts`, `subscription-bridge.ts`, `types.ts` still read one global threshold (Core keeps the top-level `threshold_pct` on the internal account list and adds `threshold_pct` on each account, so an older Proxy still works).
3. `SubscriptionPoolSchedulerTarget` no longer has `subscriptionThreshold`; any external implementer must drop it.
4. Phase-1 concerns 1-3 handled here (move rule, delete ids, reserved names). Concern 5 (document `TDAI_METADATA_DEFAULT_TEAM_NAME`) is still open for the docs phase.
5. `generic groups/update` on a pool row is refused even for the System Admin; pool rows change only through the pool calls (as specified).
6. A background run `b0003043d` of `src/metadata src/subscription-pool` was started last and may still be running; results do not change the full-suite count above.

Status: DONE_WITH_CONCERNS
Summary: Core pool routes are team scoped with not-found answers across teams, clients stored on the pool row (`clients/update`), per-account threshold, reserved names, team delete cleanup, doc updated; the full MemoryCore suite passes (1606 tests) with no new type errors in service files.
The catalog shows no pool sources (spec version, not "caller's teams"); Proxy and Panel callers still need their phases.
