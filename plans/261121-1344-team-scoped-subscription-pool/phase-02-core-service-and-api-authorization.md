# Phase 2: Core service and API authorization

## Context (read in code)

- Every pool function finds "the pool" by fixed name across the instance: `groups.find(g => g.mode === "subscription_pool" && g.name === subscriptionPoolName(p))` at `metadata-service.ts:2418`, `:2447`, `:2486`, `:2631`. With several teams this returns the wrong team's row.
- `getSubscriptionPoolStatus` returns all accounts of the provider when no group matches (`metadata-service.ts:2419`: `!group || a.group_id === group.group_id`). This is a leak once teams exist.
- Route checks today (`v3-meta-router.ts:475-517`): `status` has no check (any signed-in user); all other pool routes call `assertCanManageUsers` (System Admin, `metadata-service.ts:821-825`).
- Generic group routes that reach pool rows: `groups/list|create|update|toggle|delete` (`v3-meta-router.ts:401-420`, System Admin), `groups/view` (`:423-425`, any user, excludes pool rows at `metadata-service.ts:3278-3284`), `suggest-source-name` (`:426-429`), `source-models/update` and `source-refresh` (`:430-433`, `:441-444`; the Panel calls them with a pool `group_id` from `SelectedModelsModal.tsx:51`, `:63`), `client-sources/list` (`:434-436`, any user, lists pool sources through `clientSourceGroups` `metadata-service.ts:3314-3318`) and `client-sources/update` (`:437-440`).
- Team role helpers exist: `requireActiveTeamMember` (`metadata-service.ts:1907-1914`), `assertCallerIsTeamAdmin` (`:1916-1921`). The Hub forwards the caller's own user key to Core (`MemoryPanel/src/panel/http/routes/meta/proxy.ts:176`), and Core builds the auth context from it (`metadata/router/auth.ts:67`), so Core sees the real caller.
- OAuth login state is in memory, keyed by `state`, with provider only (`metadata/subscription-pool/authorize-url.ts:28-34`, map at `metadata-service.ts:356`).
- Scheduler listener: `notifySubscriptionAccount` (`metadata-service.ts:2513-2522`) → `syncAccount` with `account: null` removes the timers (`pool-scheduler.ts:81-87`).

## Authorization rule (one place)

New private helpers in `metadata-service.ts`, used by every pool route:

- `assertCanViewTeamPool(ctx, teamId)`: System Admin, or active member of `teamId`.
- `assertCanManageTeamPool(ctx, teamId)`: System Admin, or active member with role `admin` of `teamId`.
- `requireTeamPoolGroup(ctx, groupId, need: "view" | "manage")`: load the group; not a pool row, or the caller fails the check for `group.team_id` → `MetadataError("POOL_NOT_FOUND")`. Same answer for "missing" and "other team", so an id of another team gives no information.
- `requireTeamPoolAccount(ctx, accountId, need)`: account → group → same rule; failure → `account_not_found` (code already used at `metadata-service.ts:2528-2532`).
- `teamPoolGroup(teamId, provider)`: replaces the four fixed-name lookups. Filter `{ mode: "subscription_pool", team_id: teamId }`, then the fixed name.

"Manage" = team admin of the team or System Admin (plan D11, user answer Q2). The check lives only in `assertCanManageTeamPool`.

## Route changes

GitNexus first: `impact --direction upstream` for `getSubscriptionPoolStatus`, `enableSubscriptionPool`, `disableSubscriptionPool`, `completeSubscriptionOAuth`, `startSubscriptionOAuth`, `updateClientSources`, `listClientSources`, `deleteTeams`, `deleteTeamsForCaller`, `checkAllSubscriptionAccountUsage`.

| Route | Body change (`v3-meta-schemas.ts:480-516`) | Check | Service change |
|---|---|---|---|
| `subscription-pool/status` | add `team_id` (required) | view | filter groups and accounts by the team pool group; no group → `accounts: []` (fixes `:2419`); add `clients` (pool row `agents` + `source_agents`) per provider; each account carries its own `threshold_pct`; the top-level `threshold_pct` becomes `default_threshold_pct` (the start value for a new account) |
| `subscription-pool/enable` | add `team_id` | manage | create or switch on the team pool row with `team_id` (create input at `:2454-2465`) |
| `subscription-pool/disable` | add `team_id` | manage | switch off the team row. Keep the `SOURCE_IN_USE` stop (`:2490`, `:3292-3301`; 409 with `detail.clients`): it is an accepted rule that a source a client uses cannot be switched off (skill `multi-source-model-routing`). The admin clears the clients with `clients/update` first |
| `subscription-pool/settings/update` | none | System Admin (unchanged) | the global value is now only the start value of a new account (plan D12). It never changes the threshold of an existing account |
| `subscription-pool/account/oauth-start` | add `team_id` | manage | store `team_id` and caller `user_id` in the pending state |
| `subscription-pool/account/oauth-complete` | add `team_id`, optional `threshold_pct` (int 50-100) | manage | pending `team_id` and `user_id` must equal the request and the caller, else `INVALID_OAUTH_STATE`; the account goes to the team pool row (create switched off as today at `:2631-2642`, with `team_id`); a new account gets `threshold_pct` from the body, else the global start value; a re-login keeps the stored value |
| `subscription-pool/account/update` | add optional `threshold_pct` (int 50-100) to `subscriptionPoolAccountUpdateSchema` (`v3-meta-schemas.ts:485-489`) | manage, by account | via `requireTeamPoolAccount`; pass `threshold_pct` into the patch at `v3-meta-router.ts:500`; out of range → `INVALID_THRESHOLD` (same check as `metadata-service.ts:2500-2502`); notify the scheduler so the reset-check timer moves |
| `subscription-pool/account/delete` | none | manage, by account | same |
| `subscription-pool/account/check-usage` | none | manage, by account | same |
| `subscription-pool/account/redeem-reset-credit` | none | manage, by account | same |
| `subscription-pool/check-all` | add `team_id` (optional only for System Admin) | manage | check only accounts of the team pool groups (`:2814-2827`) |
| new `subscription-pool/clients/update` | `{ team_id, provider, agents: string[] }` | manage | set the team pool row: a single-source client whose format matches the pool goes to `agents`, a multi-source client to `source_agents` (format rule as in `updateClientSources` `:3381-3395`, `clientFormats` `:3303-3305`). Pool off → `SOURCE_DISABLED`. Store applies the per-team agent rule |

Generic group routes:

| Route | Change |
|---|---|
| `groups/list` | unchanged (System Admin); rows now carry `team_id` |
| `groups/create`, `groups/update`, `groups/toggle`, `groups/delete` | a pool row or `mode: "subscription_pool"` → `POOL_GROUP_TEAM_SCOPED`. Pools change only through `subscription-pool/*` |
| `groups/source-models/update`, `groups/source-refresh` | pool row → `requireTeamPoolGroup(ctx, id, "manage")`; other rows → System Admin (unchanged) |
| `client-sources/list` | drop pool rows from the catalog (`clientSourceGroups` `:3314-3318`); team pool clients come from `status.clients` |
| `client-sources/update` | a pool source name → `SOURCE_NOT_FOUND` (it is not in the instance catalog any more). `setSingleSourceClient` builds `holders` from all groups (`metadata-service.ts:3435`); after the migration that list holds the default team pool row too, and the store's same-scope rule (phase 1) rejects the move. Filter `holders` to instance-scope rows (`mode !== "subscription_pool"`) |
| `suggest-source-name` | `kind: "subscription"` → always the fixed name; no lookup of other teams |

Other service reads of `agents` across groups (from `rg -n "\.agents\.includes|g\.agents|sourceClients" metadata-service.ts`): `buildClientSources` `:3332` (pool rows leave the catalog, row above), `sourceClients` `:3287-3290` (used only for one row at a time; no change), group update `:2969` (store applies the scope rule). Re-run the `rg` in the implementation and add any new hit to this list.

Model source rules (`model-source-rules.ts`):

- Export `POOL_SOURCE_NAMES = new Set(["sub-claude", "sub-openai", "sub-antigravity"])` built from `POOL_SOURCE` (`:45-49`).
- `resolveSourceWrite` (`:97-185`): a non-pool group with a name in `POOL_SOURCE_NAMES` → `SOURCE_NAME_RESERVED`. `takenNames` for a pool write is the set of the same team only.
- `takenSourceNames` (`metadata-service.ts:3257-3262`) gets a scope argument.

Team delete:

- `deleteTeamsForCaller` (`metadata-service.ts:1993-1998`) → `deleteTeams` (`:1005-1007`): after the store returns `deleted_pool_account_ids` (phase 1), call `notifySubscriptionAccount({ accountId, account: null })` for each. This is the user's answer to Q5: deleting a team deletes its pools.

Per-account threshold readers (plan D12). Every reader takes the value from the account; none reads the global param except the create path:

| Reader | Change |
|---|---|
| `subscriptionThreshold()` `metadata-service.ts:2405-2408` | rename to `defaultSubscriptionThreshold()`; used only when an account is created without a value |
| `notifySubscriptionAccount` `:2513-2522` and `SubscriptionAccountChange.thresholdPct` `:207-215` | drop the field; the scheduler reads `account.threshold_pct` (null account = delete, no threshold needed) |
| `SubscriptionPoolSchedulerTarget.subscriptionThreshold` `pool-scheduler.ts:12` and the pass `:137-138` | remove; `syncAccount` (`:81-98`) calls `planAccountTimers(account, account.threshold_pct, now)` at `:88`. `timer-plan.ts:17` keeps its signature; only its caller changes |
| `runSubscriptionUsageCheck` `:2686` → `checkAccountUsage` (`usage-check.ts:43-53`) | pass `current.threshold_pct` |
| `listSubscriptionAccountsInternal` `:2555-2566` | add `threshold_pct` to each `toProxySubscriptionAccount` view (`:2387-2403`); keep the top-level `threshold_pct` (global start value) so an older Proxy still works during the deploy |
| `getSubscriptionPoolStatus` `:2410-2437` | `toPublicSubscriptionAccount` (`:2339-2363`) adds `threshold_pct` |

Internal routes:

- `instance-upstream/list` (`internal-meta-router.ts:103-107`): no code change; the entity now has `team_id`. Add an assertion in tests that every row has the field.
- `subscription-pool/accounts/list|report|refresh|check-usage` (`:108-123`): no change. The Proxy filters accounts by the `group_id` of the team row (`pool-request.ts:446`).

Docs: update `MemoryCore/v3-api-memorycore-doc.md` for every changed route (body, check, per-account `threshold_pct`, new error codes `POOL_NOT_FOUND`, `POOL_GROUP_TEAM_SCOPED`, `SOURCE_NAME_RESERVED`, `team_required`).

## Tests

Change `MemoryCore/src/metadata/store/subscription-pool.service.test.ts`:
- "allows members and system admins to view status without tokens" (`:584`) becomes two tests: "allows members of the team and system admins to view the team pool" and "refuses status of a team the caller is not in".
- "moves claude-code onto its own pool …" (`:155-177`) becomes "gives claude-code to the team pool and back without leaving the default group".
- "turns the codex pool on as a source without moving codex, and switches it off only while unused" (`:45`) and "turns the pool on while the agent has a custom upstream and leaves the agent there" (`:66`): pass `team_id`, keep the asserts on `SOURCE_IN_USE`, and assert that `codex` stays in its instance group.

Add (service and router level, SQLite runner; Mongo runner where the file has one):
- "a team admin manages the pool of the team; a member only views it"
- "a team admin of another team gets not found for every account route" (loop over update, delete, check-usage, redeem-reset-credit)
- "status of a team without a pool returns no account"
- "two teams each enable a claude pool and see only their own accounts"
- "a login started for one team cannot finish in another team or by another user"
- "check-all of a team checks only that team's accounts"
- "the generic group routes refuse pool groups"
- "client-sources list hides pool sources"
- "an api source cannot take a reserved pool name"
- "deleting a team removes its pool accounts and their timers"
- "the internal list gives a team id on every row"
- "a team admin sets the threshold of an account of the team; a member and another team's admin cannot"
- "rejects a threshold outside 50-100"
- "a new account takes the threshold from the login request, else the global start value"
- "changing the global value does not change existing accounts"
- "the reset-check timer of an account follows its own threshold" (`pool-scheduler.test.ts`, `timer-plan.test.ts`)
- "the usage check marks windows at the account's own threshold" (`usage-check.test.ts`)
- "the internal account list gives each account its threshold"

Run: `cd MemoryCore && MONGOMS_SYSTEM_BINARY=$(command -v mongod) npx vitest run src/metadata src/subscription-pool`.

## Acceptance

- Tests above pass. `rg -n "subscriptionPoolName\(" MemoryCore/src/metadata/service/metadata-service.ts` shows only the creation sites and `teamPoolGroup`.
- No pool route calls the store without a team filter (`rg -n "listSubscriptionAccounts\(\)" MemoryCore/src/metadata/service` lists only the scheduler feed `listSubscriptionAccountEntities` and the token/model paths that filter by group).

## Risk

| Risk | Likelihood × Impact | Mitigation |
|---|---|---|
| A route keeps the old instance-wide lookup | Medium × High | One helper `teamPoolGroup`; acceptance `rg`; loop test over all account routes |
| Panel of the old build calls `status` without `team_id` during deploy | Medium × Low | Schema rejects with a clear 400; Hub and Core deploy in one stack update |
| Team admins add many accounts | Low × Low | Per-account provider limits apply; System Admin still sees all |
| Team admin cannot switch off a pool that has clients | — | Intended (accepted `SOURCE_IN_USE` rule); Panel points the admin to the Clients control of the same page (phase 4) |

## Rollback

Revert the commit. With the data change in place, use the phase 6 down-step first.
