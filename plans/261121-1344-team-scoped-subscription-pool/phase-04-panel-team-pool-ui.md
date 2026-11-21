# Phase 4: Panel, Subscription Pool page per team

## Context (read in code)

- The page lives at `team/subscription-pool` (`MemoryPanel/web/src/routes/index.tsx:39`) in the "organization" menu group (`web/src/constants/menu.tsx:80`, `:103`).
- Edit rights today: only a global admin (`web/src/pages/SubscriptionPoolPage/index.tsx:74`: `readOnly = !auth || !isGlobalAdmin(...)`).
- Active team and role helpers exist: `useTeams().activeTeam`, `roleInTeam`, `isGlobalAdmin` (`web/src/services/useCurrentRole.ts:14-31`).
- All pool calls go through `web/src/lib/api/subscription-pool.ts:78-120`; none sends a team.
- The page reads `client-sources/list` to explain "source in use" (`SubscriptionPoolPage/index.tsx:153`). Model Provider page reads pool status for taken source names (`web/src/pages/ModelProviderPage/use-provider-groups.ts:31`, `:56`). The client source picker is in `web/src/pages/ApiKeysPage/components/ClientEndpoints.tsx:32`, `:69`, `:119-122`.
- The pool models dialog calls `source-models/update` and `source-refresh` with the pool `group_id` (`web/src/components/model-source/SelectedModelsModal.tsx:51`, `:63`).
- Hub action allowlist: `MemoryPanel/src/panel/api/meta-actions.ts:88-99`.

## Steps

1. `src/panel/api/meta-actions.ts`: add `subscription-pool/clients/update`. Change the comment "(System Admin only; the kernel enforces the role)" to state the new rule: team admin or System Admin manages, team members view; Core enforces it.
2. `web/src/lib/api/subscription-pool.ts`: every call except `updateThreshold` takes `teamId` and sends `team_id` (`status`, `enable`, `disable`, `oauthStart`, `oauthComplete`, `checkAll`, new `updateClients`). Account calls keep their body (Core finds the team by account). Add `clients: string[]` to `SubscriptionPoolProviderStatus`.
3. `SubscriptionPoolPage`:
   - Read `activeTeam` from `useTeams()`. No active team → an empty state with a short text ("Select a team to see its subscription pools").
   - `canManage = isGlobalAdmin(...) || roleInTeam(activeTeam, auth.user_id) === 'admin'`; `readOnly = !canManage`. 
   - `use-pool-status.ts:36`: pass `activeTeam.team_id`; refresh when the active team changes; drop the old data at once on a team change, so a list of one team never shows under another team's name.
   - Header shows the team name next to the pool title.
   - Per-account threshold (plan D12, user decision 4):
     - `SubscriptionAccount` type (`web/src/lib/api/subscription-pool.ts:14-40`) gets `threshold_pct: number`; `updateAccount` input gets `threshold_pct?: number`; `oauthComplete` input gets `threshold_pct?: number`.
     - `AccountTable.tsx`: new column "Threshold" with the account value; an editable number (50-100) for `canManage`, plain text otherwise. Save calls `updateAccount({ account_id, threshold_pct, expected_version })`.
     - `AddAccountDialog.tsx`: optional threshold field; empty = the start value from `status.default_threshold_pct`.
     - `PoolSettings.tsx` (`:12-47`) and `saveThreshold` (`index.tsx:165-170`): the control no longer sets the pool threshold. It becomes "Start threshold for new accounts", shown and editable only for a global admin, with a short note that it does not change existing accounts. Team admins see the per-account values only.
   - New "Clients" control in `PoolHeader` (or a small new component in the same folder): checkboxes for the clients that can use this provider (single-source client of the provider + multi-source clients with the same format, from `client-sources/list` `agents[].formats`). Save calls `updateClients`. Off while the pool is off.
   - Keep the "source in use" dialog for disable (`index.tsx:123-140`), because Core still answers `SOURCE_IN_USE` while the team pool has clients (plan D15). Take the client list from `detail.clients` of the error or from `status.clients`, not from `client-sources/list` (`index.tsx:153`), and point the admin to the Clients control on this page instead of the API Key page.
   - `AddAccountDialog.tsx:49`, `:76`: pass the team id to `oauthStart` and `oauthComplete`.
4. `ModelProviderPage/use-provider-groups.ts:31`, `:56`: stop reading pool status; add the three reserved pool names as taken names (constant shared with `web/src/lib/subscription-pool-display.ts`).
5. `ApiKeysPage/components/ClientEndpoints.tsx`: the catalog no longer has pool sources (phase 2). Show one line under the picker: "Subscription pools are set per team on the Subscription Pool page." No other change.
6. i18n: add every new key to both `web/src/i18n/en-US.ts` and `web/src/i18n/zh-CN.ts`. Follow the `memory-panel-i18n-sync-deploy` skill: list keys of both files with `rg -o "^\s*'([^']+)':" -r '$1' <file> | sort -u`, `comm -23` must print nothing in both directions, `uniq -d` must print no duplicate, then `npx tsc --noEmit -p .` in `MemoryPanel/web`. Search the repo for old texts that say the pool is "System Admin only" and update them (`rg -n "System Admin only" MemoryPanel`), per `operator-master/tasks/lessons.md` 2026-10-28.
7. `MemoryPanel/panel-api-doc.md`: document `team_id` on the pool actions and the new action.

## Tests

- `MemoryPanel/tests/subscription-pool-actions.test.ts`: "sends the active team with every pool call"; "allows the new clients action".
- `MemoryPanel/tests/subscription-pool-display.test.ts`: "a team admin can edit, a member only views, a global admin can edit any team"; "shows the threshold of each account"; "a team admin edits an account threshold; the start threshold control is for a global admin only".
- `MemoryPanel/tests/client-sources.test.ts`: "the client source catalog has no pool sources".
- Web typecheck and build; manual check in a browser with two teams (phase 5 e2e).

Run: `cd MemoryPanel && npm test && npm run typecheck`, then `cd MemoryPanel/web && npm run build` (`tsc && vite build` in `web/package.json`) and `npm run lint:check`.

## Acceptance

- Tests and typecheck pass; both locale files have the same new keys.
- Changing the active team in the header changes the pool list with no request that carries the old team id (check the network panel in the e2e).

## Risk

| Risk | Likelihood × Impact | Mitigation |
|---|---|---|
| Old team data shows for a moment after a team switch | Medium × Medium | Clear state on team change before the fetch; request id guard in `use-pool-status.ts` |
| UI hides a button, but Core allows the call | — | Core is the boundary (phase 2); UI only follows it |
| Missing locale key shows a raw key | Low × Low | i18n sync check in step 6 |

## Rollback

Revert the Panel commit. An old Panel against the new Core gets a 400 on `status` without `team_id`; roll back Hub and Core together (phase 6).
