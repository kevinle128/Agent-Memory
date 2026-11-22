# Code review: team-scoped Subscription Pools (uncommitted, branch feat/team-scoped-subscription-pool)

Date: 2026-11-21 (Asia/Saigon). Read-only review. No code edits, no commits, no production access.

## Scope
- Files: 89 modified + 19 untracked under MemoryCore, MemoryProxy, MemoryPanel (`git status`), about +3748/-797 lines.
- Plan: `plans/261121-1344-team-scoped-subscription-pool/plan.md` (D1-D15, user decisions 1-9). Reports: phase 1-4 fullstack reports.
- Threat model: OAuth access/refresh tokens of paid subscriptions and the traffic routed to them. The question is: can a caller see, change or use the pool of a team in which the caller is not an active member?

## Verification run by the reviewer
| Check | Result |
|---|---|
| `MemoryProxy: npx tsc --noEmit` | exit 0 |
| `MemoryProxy: npx vitest run src/subscription-pool src/pipeline src/__tests__/models-handler.test.ts src/session/__tests__/store-peek-team.test.ts` | 40 files, 606 passed |
| `MemoryCore: MONGOMS_SYSTEM_BINARY=$(command -v mongod) npx vitest run src/metadata/store src/metadata/service src/metadata/router src/subscription-pool` | 32 files, 893 passed, 0 skipped (728 s) |
| `MemoryPanel: npm test` | 36 files, 505 passed |
| `MemoryPanel: tsc --noEmit` and `web: tsc --noEmit -p .` | both exit 0 |
| Plan/phase/finding labels in added code, comments, test names | none found (rg over added lines and untracked source) |
| Full MemoryProxy suite, full MemoryCore suite, web build, lint, local two-team e2e | not run by the reviewer |

## What was traced and holds (no finding)
- Core, every `subscription-pool/*` route (`v3-meta-router.ts:482-534`): status = view (active member or System Admin), enable/disable/clients/oauth-start/oauth-complete/check-all with team = manage (team admin or System Admin); account update/delete/check-usage/redeem go through `requireTeamPoolAccount` (account → group → `team_id`, `metadata-service.ts:2486-2493`) with the same `account_not_found` answer for a missing id and for another team's id. No IDOR by `account_id` or `group_id` was found.
- Source-model routes use `assertCanManageSourceGroup` (`metadata-service.ts:2500-2505`). Generic group create/update/toggle/delete refuse pool rows (`assertNotPoolGroup`). `groups/view` and `client-sources/list` drop pool rows.
- OAuth pending state is bound to team and caller (`metadata-service.ts:2795-2802`) and is dropped on team delete.
- No public answer carries `access_token`/`refresh_token` (`toPublicSubscriptionAccount`, redeem returns the public view). Internal `/v3/internal/meta/*` needs the service bearer (`gateway/server.ts:1022-1024`); the Hub meta proxy only forwards allowlisted `/v3/meta` actions (`panel/http/routes/meta/proxy.ts:149-162`).
- Proxy: every team that routing can use comes from `resolveRequestTeam`/`settleTeamAfterInit` and must be in the active team list of the verified user (`pool-team.ts:302-304`, `:405-410`). The session peek, pending choice, user default and header preset are only candidates; a spoofed session id or `x-...` team header cannot pick a team of which the user is not a member.
- `resolveForAgent(..., teamId)` takes only a pool row with `team_id === teamId` (`instance-upstream-cache.ts:252-259`); a row without `team_id` never matches (fail closed). All `resolveForAgent` and `openPoolRequest` call sites pass a team or null (codex, workbuddy, anthropic, utility, antigravity, account switch, early/responses stages). Every runner calls settle before the main upstream call; aux paths use non-deferrable errors.
- Account lists are cut to `row.group_id` in pool-request (`pool-request.ts:446`), the bridge (`subscription-bridge.ts:287`) and the fallback (`pool-team.ts:332`). A Session Binding to an account of another group falls through to round robin. The cursor key has `group_id` (`binding-store.ts:41-47`).
- Models handler lists pool sources only of the caller's teams (`modelsHandler.ts:143-150`).
- Panel: the content remounts on team change (`SubscriptionPoolPage/index.tsx` `key={activeTeam.team_id}`) and `usePoolStatus` drops old data and ignores older responses. Core enforces roles on every call.

## Findings

### High

**H1. Code rollback is unsafe and the down-step it depends on does not exist; merge to `master` deploys.**
- Old Proxy on new data. The removed lines of `resolveForAgent` (HEAD `MemoryProxy/src/instance-upstream-cache.ts:235-246`) return `kind: "pool"` for the first custom row that holds the agent, with no team check. Scenario: after deploy, team B enables a Claude pool with client `claude-code`. Any Proxy-only rollback (or an image mismatch) then sends the traffic of every team to the accounts of whichever pool row comes first. That is a cross-team use of paid tokens.
- Old Core on new SQLite data. The old Core runs `CREATE UNIQUE INDEX IF NOT EXISTS ux_iuc_source_name ON meta_instance_upstream_config(source_name) WHERE source_name != ''` on each start (HEAD `sqlite-adapter.ts:139-143`, `:511`). The new code drops that index (`sqlite-adapter.ts:155-160`). When two teams have enabled the same provider, two rows hold `sub-claude`, so the old store init throws for that instance. Phase 6 (line 25) states the effect: "the index creation fails and Core does not start".
- This is a rollback gate that the plan gives to phase 6, not a defect in the phase 1-4 code. The plan knows both cases (phase 6, lines 24-29) and requires `MemoryCore/scripts/ops/subscription-pool-team-scope-down.mjs` before any code rollback. That script is not in the tree. `.github/workflows/deploy.yml:3-10` builds and deploys on each push to `master`, so this branch must not reach `master` before the down-step exists.
- Fix: implement and rehearse the down-step (SQLite and Mongo variants) before the merge. Until then, the only rollback is a backup restore, which loses rotated refresh tokens (ADR 0001).

### Medium

**M1. The pool backfill picks its team by a name that any user can create, on every start.**
- `backfillSubscriptionPoolTeam` (`sqlite-adapter.ts:550-583`, Mongo `mongodb-adapter.ts:447-489`) runs on every start. It gives every pool row with `team_id = ''` to the single active team named `default`, else `default-team` (`pool-team-scope.ts:15`, `:43-52`).
- Team names are not unique. Any user can create a team (`createTeamForCaller` checks only that the caller is the owner, `metadata-service.ts:1989-1992`; `team/create` and `team/update` are in the Hub allowlist, `meta-actions.ts:36`, `:38`). The Hub duplicate check looks only at the creator's own teams (`panel/http/routes/meta/proxy.ts:76-81`), and a team admin can rename a team through `team/update`.
- Scenario A (takeover). The scenario needs an instance whose pool rows stay unassigned because no active team is named `default` or `default-team` (for example, the operator renamed the original team). A regular user creates or renames a team to `default`. At the next Core restart (each deploy restarts Core), that user's team owns every pool account. The user can then route traffic on the paid tokens and manage or delete the accounts. A second variant: an old database where only `default-team` exists. If any user creates a team named `default` before the first start of the new code, the pools go to that user, because `default` is searched first. A third variant: after an `ambiguous` result, a new team with the same name keeps the result ambiguous (`pickDefaultTeam` stops at the first name with two or more ids). But if the operator then renames the legitimate team and not the other one, the other team gets the pools.
- Scenario B (production denial before deploy). Production today has exactly one team named `default`, so the takeover does not apply while that holds. But if any user creates a second team named `default` before deploy, the result is `ambiguous`. All pools stay unassigned, `poolServesClient` is false for everyone, and every pooled client silently moves to the shared normal upstream. Q9 says the source of that upstream is unknown. `TDAI_METADATA_DEFAULT_TEAM_NAME` cannot separate two teams with the same name. The operator must rename the other team, which is a judgment call made under pressure.
- Fix: select the target by team id (for example `TDAI_METADATA_DEFAULT_TEAM_ID`, or the confirmed `team-f0bzqawutx` for production). Do not let a name step pick a team whose owner is not a System Admin. Phase 6 should re-read the team names right before deploy. Optionally make the assignment a one-time step (a marker row), so that a later start cannot assign rows.

**M2. A System Admin cannot reach the pool of a team in which the admin is not a member from the Panel (user decision 5 / Q2 not met in the UI).**
- The pool page reads `activeTeam` from `useTeams()`, and the team list is `team/list { user_id: me.user_id }` (`MemoryPanel/web/src/lib/api/teams.ts:15`), so it shows memberships only. Core allows a System Admin to view and manage any team (`assertCanViewTeamPool`/`assertCanManageTeamPool`), but the Panel gives no way to pick a team in which the admin is not a member.
- Scenario: the System Admin is not a member of `GAME MOBILE STUDIO`. The admin cannot see that team's pool or fix it (re-login an account, switch it off) without first joining the team. This is not a leak, but it is a gap against a confirmed decision. The phase 4 spec (line 18) asked only for `useTeams().activeTeam`, so the gap is in the spec, not only in the code.
- Second case: with no active team the page shows only the empty state (`SubscriptionPoolPage/index.tsx`, the `!activeTeam` branch). A System Admin who is in no team therefore loses the whole page, including the start threshold (`settings/update`), which only a System Admin may set. Q8 lists 3 production users in no team.
- Fix: for a System Admin, list all teams on this page (an admin team list), and show the start threshold without an active team. Or accept the gap and record it.

**M3. Unrelated feature mixed into the same working tree (scope drift, not isolation).**
- The AntiGravity quota-summary work (`parseAntigravityQuotaSummary`, `shared_models`/`group_label` windows, `windowAppliesToModel`) belongs to `operator-master/plans/261121-1815-antigravity-usage-display/plan.md` and researcher report `261121-1855` (both name `retrieveUserQuotaSummary`/`shared_models`; the team-pool plan does not). Files: `MemoryCore/src/subscription-pool/providers/antigravity.ts` (+82) and its test and fixture, `MemoryProxy/src/subscription-pool/types.ts`, `selector.ts:33-35`, `pool-request.ts:422`, and part of `MemoryPanel/web/src/lib/subscription-pool-display.ts` and `AccountTable.tsx` (these two files also carry the per-account threshold of this plan).
- Risk: the Proxy selector now treats a window with `shared_models` differently for every provider path. One squashed commit would mix a routing-semantics change with an authorization change, and a revert of one would revert the other.
- Fix: commit it separately (or stash it) before the team-pool commit.

### Low

**L1. Old instance sources may hold a now-reserved pool name.** `SOURCE_NAME_RESERVED` applies only to new writes (`model-source-rules.ts:151-153`), and no migration checks existing non-pool rows. Before this change, an API source could be named `sub-openai` or `sub-antigravity` when no pool held the name. The new index is `(team_id, source_name)`, so a team can then enable that pool too, and the Proxy stage takes the first row with that prefix (`model-source.ts:122-124`). A team member's `sub-openai/<model>` can go to the instance API source and not to the team's pool. This is not cross-team. A source name cannot change after it is saved (skill `multi-source-model-routing`), so such a row needs a data fix, not an API rename. Before deploy, check production for non-pool rows whose `source_name` is one of the three fixed names.

**L2. openai-chat reveals pool state of other teams.** `stageModelSource` with `servesPool: false` matches the pool row of any team (`openai-chat.ts:420`, `model-source.ts:123`). Its error then tells the user whether some team's `sub-claude` pool exists, is switched off (`model_source_disabled`) or does not list the agent (`model_source_not_allowed`). The caller learns only on/off state, nothing else.

**L3. A removed member keeps the team pool up to 10 minutes during a Core outage.** The membership cache is fresh for 60 s (accepted by D10). After a Core error, the last good list is used for 10 minutes (`pool-team.ts:40`, `:181-184`). Access tokens stay valid without Core, so a user who was removed from the team just before the outage can still use the pool. Consider a shorter stale window, or none for a pool decision.

**L4. SQLite team delete is not atomic with the pool delete.** `deleteTeams` deletes the team rows first (`sqlite-adapter.ts:1277`), then deletes the pool rows in a separate transaction (`:1285`). Trigger: the Core process stops (container restart, OOM kill) between the two statements, or the pool transaction throws `SQLITE_BUSY`. Then pool rows and their tokens stay with a `team_id` that no longer exists. No team can use them, but Core timers keep refreshing their tokens, and the scheduler is never notified. Phase 1 concern 6 noted the non-atomic cascade. Wrap the whole delete in one transaction.

## Notes (user decisions, not findings)
- Team delete removes the team's pools and accounts (decision 7). A team admin of `default` can therefore delete every production pool account, which cannot be undone because providers rotate refresh tokens. This power already follows from D11, but phase 6 should state it.
- A request without a known team, from a user whose teams have no pool, gets 403 `no_team_pool`, also for sidequery and `count_tokens` before the first main turn (decision 9, phase 3 concern 0a). Today this affects the 2 members of `GAME MOBILE STUDIO` when they use `x-memory-mode: off` or headless runs.
- The fallback order is newest team first on both backends (Mongo sorts after `$replaceRoot`, so it sorts by the team's `created_at`).
- Auth-disabled deployments get no pool (phase 3 deviation 4).

## Migration items from the task list
- Double run: the backfill returns early when no pool row has `team_id = ''` (`sqlite-adapter.ts:557`, Mongo `mongodb-adapter.ts:456`). The agent restore adds only agents that no instance group holds. The threshold copy runs only when the column is added (SQLite) or only for documents that have no field (Mongo). A restart therefore writes nothing. The exception is M1: unassigned rows are tried again on every start.
- Mongo vs SQLite: both use `pickDefaultTeam` and the same clash check. Differences: Mongo runs the backfill before the index block. When dropping the old `ux_source_name` index fails with a code other than 26/27, Mongo logs it and continues (`mongodb-adapter.ts:426-437`). The old index then makes a second team's `enable` fail with `source_name_duplicate`, which fails closed. Production is SQLite (phase 6 line 29).
- Ambiguous default team: rows stay unassigned and agents are restored, so clients run on their instance group (no 400). See M1 for the risk of picking by name.
- Index change: SQLite drops `ux_iuc_source_name` and creates `ux_iuc_team_source_name` after the `team_id` column exists (`sqlite-adapter.ts:524-526`, `:649`). The rows are still all `''` at that point, so the old uniqueness holds until the backfill.

## Test quality spot check
- `MemoryProxy/src/subscription-pool/__tests__/team-routing.test.ts:102-145` asserts the bearer token that reached the upstream for team A and team B requests, and that the other team's token is absent.
- `MemoryCore/src/metadata/store/subscription-pool-team-scope.contract.ts:147-159` asserts `account_not_found` for every account route called by another team's admin. There are cases for client isolation (`:214`), the OAuth state bound to team and user (`:289`) and threshold rights (`:341`).
- No phantom tests were found in the cases read.

## Method note
I listed callers with `rg` and the required third argument that `tsc` enforces (Proxy typecheck clean). I did not run GitNexus `impact`/`detect_changes` in this review.

## Edge cases checked by scouting
- Session id spoofing across users: candidates are filtered by membership, so a spoofed id is safe. Unchanged earlier risk: the Session Binding key is not user-scoped, so another user's request can rebind a session and break its prompt cache.
- Two concurrent create calls for the same (team, provider) pool on Mongo: possible, because the name check runs before the insert and no unique index covers pool names. This race existed before the change and is not cross-team.
- New Proxy with old Core: rows without `team_id` give no pool, so the requests fail closed with 400 for up to 30 s (D8, accepted).

## Recommended actions (in order)
1. H1: implement and rehearse the down-step, and do not merge to `master` before it exists.
2. M1: select the backfill team by id. Re-check team names in production right before deploy.
3. M3: split the AntiGravity quota work into its own commit.
4. M2: decide on System Admin access to all teams in the Panel.
5. L1: check production for non-pool rows that hold reserved source names.
6. L2-L4: optional hardening.

## Metrics
- Type coverage: Proxy, Panel and web typecheck clean. MemoryCore has no typecheck script (phase 2 used an ad-hoc config).
- Tests: see the table above. No coverage percentage was measured.
- Lint: not run by the reviewer.

## Unresolved questions
1. Does production SQLite hold a non-pool source named `sub-claude`, `sub-openai` or `sub-antigravity` (L1)?
2. Should a System Admin see all teams on the pool page (M2)?
3. Should the backfill pick its team by id instead of by name (M1)? This would change the D6 rule of the plan, so the user must confirm it.

Status: DONE_WITH_CONCERNS
