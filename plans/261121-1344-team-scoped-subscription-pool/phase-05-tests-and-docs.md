# Phase 5: Cross-package e2e and documentation

## Goal

Prove the isolation end to end on a local stack, and record the new meaning of a Subscription Pool. Unit tests of each package are in phases 1-4; this phase adds only the cross-package checks and the docs.

## Local e2e (no production)

Setup: local Core (SQLite and, in a second run, MongoDB), Proxy and Hub (`docs/local-development.md`). Start from a **copy of a pre-change database** with one claude pool and one codex pool and accounts, so the migration path is part of the run. Create team A = the init-admin team (name `default-team`), team B and team C (no pool). Run the migration check (check 1) twice: once as is (the rule falls to `default-team`), once after renaming team A to `default` (the production name); user `a` in team A only, user `b` in team B only, user `ab` in A and B, user `c` in C only, user `z` in no team. Provider calls go to a stub upstream (the test harness in `MemoryProxy/src/subscription-pool/__tests__/test-harness.ts` shows the shape); no real subscription account is used.

| # | Check | Pass |
|---|---|---|
| 1 | Core start log after migration (both name cases above, and once with `TDAI_METADATA_DEFAULT_TEAM_NAME` set to team B's name) | one backfill line: team = the expected team id, groups = 2; `default.agents` now has the pooled agents; `PRAGMA quick_check` = ok |
| 2 | Claude Code turn of `a` | Proxy log has an account of team A's group |
| 3 | Claude Code turn of `b` | no pool; request goes to the default group target; no account id in the log |
| 4 | Team B enables its own claude pool, adds a stub account, sets clients = `claude-code` | turn of `b` uses team B's account; turn of `a` still uses team A's |
| 5 | `ab` opens one session in team A and one in team B | each session uses its own team's account |
| 6 | `b` calls every `subscription-pool/*` route with team A's `team_id` or account ids (curl through the Hub) | every call fails with `permission_denied` / `POOL_NOT_FOUND` / `account_not_found`; no account data in any body |
| 7 | `client-sources/list` as `b` | no pool source in the catalog |
| 8 | omp of `b` lists `/v1/models` | only team B pool models; `sub-claude/<model>` of team A is absent when team B has no claude pool |
| 9 | Remove `b` from team B (now in no team), wait 60 s | next Claude Code turn of `b` gets 403 `no_active_team`, never the normal upstream and never team A's pool |
| 10 | Delete team B | its pool rows and accounts are gone; scheduler log shows no timer for them; team A unchanged |
| 11 | Account Switch (`/sub`) as System Admin in a team A session | lists only team A accounts |
| 12 | Restart Core twice | no second backfill line; data unchanged |
| 13 | After migration, read the accounts | every old account has `threshold_pct` = the global value of the old database |
| 14 | Team B admin sets account B1 to 60 and B2 to 90; stub usage 70 on both | new sessions of team B go to B2 only; a team A admin cannot change B1 or B2 (`account_not_found`) |
| 15 | System Admin changes the global start value | existing accounts keep their values; a new account gets the new value |
| 16 | `ab` (team A and team B, both with a claude pool) sends `x-memory-mode: off` turns | the account comes from the first of the two teams in Core order (newest first) |
| 17 | Same as 16, with every account of the first team at quota | the account comes from the second team |
| 18 | Same as 16, with every account of both teams at quota | 429 with the earliest reset of the two pools |
| 19 | User `c` only in team C (no pool) sends an `x-memory-mode: off` turn | 403 `no_team_pool`, clear message; a registered session of `c` in team C runs on the normal upstream |
| 20 | User `z` in no team sends a turn | 403 `no_active_team` |
| 21 | `ab` chooses team B, team B has no agent, so the session is bypassed with team B chosen; team A has a usable pool | team B is the known team: team B's pool, never team A's (with team B pool off: normal upstream) |
| 22 | `a` chooses "skip" before a team (bypass without a chosen team) | the fallback picks team A's pool |

Record the commands and results in `Agent-Memory/plans/reports/tester-<yymmdd-hhmm>-team-scoped-pool-e2e.md` (the reports path of this task).

## Docs

1. `CONTEXT.md`, glossary entry **Subscription Pool** (`CONTEXT.md:28-30` today: "The set of Subscription Accounts that serves one Client Type in one Memory instance."). New text: "The set of Subscription Accounts of one team that serves one Client Type in one Memory instance. A team sees and uses only its own pools; a team without a pool uses the normal upstream of the client." Change the entry **Threshold** (`CONTEXT.md`, "The used percentage of a Quota Window at which a Subscription Account stops getting new Session Bindings.") to add: "Each Subscription Account has its own Threshold, set by an admin of its team." Add an entry **Team** if the glossary needs it: "The group of Members that owns Agents, assets and Subscription Pools. The team of a request is the team of its session."
2. New `docs/adr/0003-team-scoped-subscription-pool.md`, status `accepted`, same format as `docs/adr/0001-proxy-side-subscription-pool.md`. Content: the decision (team id on the pool group, accounts by group, per-team layer over instance groups, request team from the session with a membership check, fail closed), the per-account Threshold, the team of a request (session first, then the ordered fallback over the user's teams, clear errors; a known team without a pool uses the shared normal upstream), the options considered (team id on accounts too; one threshold per instance or per pool; a separate instance pool routing row with team accounts; changing the binding key), and the consequences (non-default teams lose the old shared pool on deploy; rollback needs the down-step; Proxy and Core must not be rolled back separately while a second team has a pool).
3. `MemoryCore/v3-api-memorycore-doc.md` and `MemoryPanel/panel-api-doc.md`: done in phases 2 and 4; check here that both match the code.
4. Skill `deploy-agent-memory` (`operator-master/.claude/skills/deploy-agent-memory/SKILL.md`): the metadata backup step already exists (`:31`). Add one line under "Roll back": "After the team-scoped pool change, run `MemoryCore/scripts/ops/subscription-pool-team-scope-down.mjs` before an image rollback." Update only after the user approves the skill change.

## Acceptance

- All 22 e2e checks pass on SQLite; checks 1, 4, 6, 12, 13 and 16 also on MongoDB (16 checks the team order of the Mongo store).
- `rg -n "one Memory instance" CONTEXT.md` shows the new text; ADR 0003 exists and links ADR 0001.

## Risk

| Risk | Likelihood × Impact | Mitigation |
|---|---|---|
| Local stack differs from production config | Medium × Medium | Use the production upstream shape recorded in phase 0 (without secrets) |
| A test uses a real account by mistake | Low × High | Stub upstream only; no OAuth against providers |

## Rollback

Docs-only changes; revert the commit.
