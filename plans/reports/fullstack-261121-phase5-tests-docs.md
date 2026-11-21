# Phase 5 report: local two-team check and docs (team-scoped Subscription Pools)

Branch `feat/team-scoped-subscription-pool`. Nothing committed, pushed or switched. No production access, no SSH. Only the local machine was used.

Status: DONE_WITH_CONCERNS

## Outcome

All 22 numbered checks pass on SQLite on the final run (25 PASS lines: the 22 checks and the extra name cases 1b to 1d). On the outcome they pass; on the **literal pass text** four of them are only partly met (checks 2, 3, 6 and 10; see "Pass text not met"). Checks 1, 4, 6, 12, 13 and 16 also pass on MongoDB (9 PASS lines). The check found one real defect (a stale start value for new accounts), fixed with a failing test first. The docs are written. The full suites pass.

The down-step script and its test are **not written**. The phase 5 text names the script only in a skill line that waits for user approval, and the plan gives the file to phase 6. So the phase 5 spec requires nothing of it. The ADR describes the rollback data step without citing a script path.

## Database fixture (no production copy)

No production copy exists locally. The old-shape database was built by the **old code**:

- `git archive HEAD MemoryCore` (HEAD `eff54bda`, before the change; confirmed: no `threshold_pct` and no `ux_iuc_team_source_name` in the old `sqlite-adapter.ts`), unpacked in `/tmp/tp-e2e/old` with `node_modules` linked.
- `MemoryCore/scripts/qa/team-scoped-pool-e2e/build-fixture.ts` runs the old store and the old `MetadataService`. It creates the admin (init-admin creates the team `default-team`), users `a`, `b`, `ab`, `c`, `z`, teams B and C, one agent per user that needs a registered session, a claude pool (2 accounts) and a codex pool (1 account), pooled agents only in the pool rows (not in `default.agents`), and a global threshold of **90** (not the default 95). The tokens are fake.
- The fixture can fail: before each open, the runner checks the fixture sha256 and that the copy has no `team_id` column, no `threshold_pct` column and has `ux_iuc_source_name` (SQLite), or no such fields and the index `ux_source_name` (Mongo).
- This replaces the hand-copied schema of the phase 1 tests. It is still not a production file: the real data volume, real ids and real team names are not covered (phase 6 rehearsal on a restored backup covers that).

## Harness (new files, all under `MemoryCore/scripts/qa/team-scoped-pool-e2e/`)

| File | Role |
|---|---|
| `build-fixture.ts` | Builds the old-shape fixture with the old code (SQLite file or Mongo database) |
| `core-launcher.ts` | Starts one Core gateway on a fixed port with its own data directory |
| `fake-upstreams.mjs` | One process, two listeners: fake provider (usage by token, models, profile, OAuth code exchange, Claude and Codex inference) on 18500, fake normal upstream on 18501, request log at `/__log` |
| `redirect-fetch.mjs` | `--import` preload of Core and Proxy: provider hosts go to the fake; any other non-loopback host throws and is logged |
| `lib.mjs`, `mongo-helpers.mjs` | Process tracking, port guard, Core client, database readers, own `mongod` with a replica set |
| `run-e2e.mjs` | The runner: prints PASS, FAIL or NOT RUN with evidence, writes `results.json` and `processes.json` |

The runner uses no real provider. Outbound guard log: SQLite run 230 calls redirected to the fake, 0 blocked; Mongo run 38 redirected, 0 blocked. Nothing read `MemoryProxy/config.yaml`, `MemoryCore/tdai-gateway.yaml`, Mongo 27017 or `~/.memory-tencentdb`: `HOME` of both processes is a temp directory, the Proxy config is written by the runner. Node 22.22.2 runs Core and Proxy (the Proxy refuses other majors).

Calls to Core go **Core-direct** with the user key header. The Hub was not started and its forward call was not traced. What I read: `MemoryPanel/src/panel/http/routes/meta/proxy.ts:171-177` builds the call context with `userKey: panelMeta.userKey` (the caller's key) and `gatewayApiKey`, and `MemoryPanel/src/panel/kernel/headers.ts:6` names the header `x-tdai-user-key`. So the Hub should send the same body and caller key, but this check did not prove it.

**Every turn is checked, not only the last one.** The retry loops (`waitFor`) of checks 4, 9, 14, 16, 17, 21 and 22 would hide a turn that used a wrong team during cache convergence. `claudeTurn` and `formTurn` therefore record every turn in a ledger: the account token must belong to a team that the user may use at that moment, and with `x-team-id` set it must be that team. A recorded violation fails the check that was running, whatever the retry loop returned. Check 9 narrows the allowed list of `b` to none from the first `403` on (the membership list is cached for 60 s before that), and check 10 narrows `ab` to team A. No violation was recorded in the final runs.

## Checks run

Final runs (Node 22.22.2): SQLite `node run-e2e.mjs --root /tmp/tp-e2e` → 25 PASS, 0 FAIL, 0 NOT RUN (about 9 minutes). Mongo `node run-e2e.mjs --backend mongo --root /tmp/tp-e2e --only 1,13,4,6,16,12` → 9 PASS, 0 FAIL. Earlier runs in the same session had failures that were harness errors (counting of the shared fake log, a missing `modelSources.enabled`, a wrong team owner in the fixture), the real defect 1 below, and one Mongo race that is now explained (see "Observations").

| # | Result | Evidence |
|---|---|---|
| 1a | PASS (SQLite, Mongo) | Team `default-team`: `[subscription-pool] team backfill team=<A> groups=2 agents_restored=claude-code,codex`; `default.agents` now holds both agents; `PRAGMA quick_check` = ok |
| 1b | PASS (SQLite, Mongo) | Team A renamed `default`: same line with team A |
| 1c | PASS (SQLite, Mongo) | `TDAI_METADATA_DEFAULT_TEAM_NAME=team-b`: line with team B, groups=2 |
| 1d | PASS (SQLite, Mongo) | Two teams named `default`: line `team=none groups=0 agents_restored=claude-code,codex`, pool rows stay `team_id=''`, error line lists both candidate ids |
| 2 | PASS on outcome, pass text not met | Claude turn of `a` reached the fake with `tok-fake-claude-A1` (team A); no normal call. The text asks for "an account of team A's group in the Proxy log". A Claude Code turn writes no account to the Proxy log (defect 2), so the account is proved by the token the provider received. A Codex turn of `a` gave a usage log row with the codex account of team A, which proves the log field only for Codex |
| 3 | PASS on outcome, pass text not met | Turn of `b` (team B, no pool): reply `fake-normal`; 0 pool calls; 1 call reached the normal upstream fake (the target of the default group); 0 calls with no token to the provider host. "No account id in the log" is always true for Claude Code (defect 2), so it proves nothing; the proof is the missing pool token |
| 4 | PASS (SQLite, Mongo) | Team B enabled its pool, added B1/B2 through `oauth-start` / `oauth-complete` (code exchange answered by the fake), set clients; `b` got `tok-fake-b*`, `a` got a team A token |
| 5 | PASS | `ab` session in team A got `tok-fake-claude-A1`, session in team B got `tok-fake-b1` |
| 6 | PASS on outcome, pass text not met (SQLite, Mongo) | The text says "through the Hub"; the calls went Core-direct (above). `b` called all 12 `subscription-pool/*` routes (list taken from the router source; the check fails if one is missing) and 7 group routes with team A ids: 403 `not a team member`, 404 `account_not_found`, 403 for the group routes; `groups/view` answered 200 with an empty list. No team A token, account id, group id or name in any body (ids the caller sent are not counted as a leak). A denial must be `403 permission_denied` or `404 account_not_found` / `POOL_NOT_FOUND` (a generic group route may also answer `400 POOL_GROUP_TEAM_SCOPED`); a schema error counts as a failure. Pool rows and accounts identical before and after. Own team status 200 |
| 7 | PASS | `client-sources/list` as `b`: no `sub-*` source |
| 8 | PASS | omp `/v1/models`: `b` lists `sub-claude/claude-b-only` and not `claude-a-only`; `a` the reverse; `c` no `sub-claude` model. The fake gives each team an extra model that only its own accounts return, so the list shows which pool made it. Needs `modelSources.enabled: true` in the Proxy config |
| 9 | PASS | (ledger on) `b` removed from team B: the registered session got `403 no_active_team` 62 s after the removal (membership cache is 60 s), a fresh session too; 0 upstream calls |
| 10 | PASS on outcome, pass text not met | Team delete: pool rows 0, accounts 0, team A rows and accounts identical, no token in the answer. A later `check-all` made provider calls for team A and none with a team B token. **Limit:** the Core log has no line when the scheduler drops a timer, so "scheduler log shows no timer" cannot be read; the proof is the check set, plus the unit tests of phase 2 |
| 11 | PASS | System Admin session in team A: `current` gives a team A account; `switch` to a team B account e-mail gives `404 account_not_in_pool`; `switch` to a team A account (added through the login route, because the fixture accounts have no e-mail) gives 200 |
| 12 | PASS (SQLite, Mongo) | Two restarts: no second backfill line; pool rows and accounts identical; quick_check ok (SQLite) |
| 13 | PASS (SQLite, Mongo) | All 3 old accounts have `threshold_pct` 90 in the database; the status of team A shows 90, 90 |
| 14 | PASS | B1=60, B2=90, usage 70 on both through `check-all`: four new sessions all on B2; a team A admin got `404 account_not_found` for B1 |
| 15 | PASS | Start value changed to 80: existing 5 accounts unchanged; new account 80; explicit 75 kept; team admin refused 403 |
| 16 | PASS (SQLite, Mongo) | `ab`, `x-memory-mode: off`: tokens of team B (newest first), Core order `team-b, default` |
| 17 | PASS | Team B at quota: tokens of team A |
| 18 | PASS | Both at quota: `429` with `resets_at` = reset of A1 (2 h), not the 5 h of team B. The check fails if the first pool's reset is returned. Headers seen: `retry-after: 7170`, `x-tdai-pool-status: exhausted`, `x-tdai-pool-earliest-reset` = the same reset in epoch seconds (asserted) |
| 19 | PASS | `c` with memory off: `403 no_team_pool`, 0 upstream calls; registered session of `c`: normal upstream |
| 20 | PASS | `z`: `403 no_active_team` |
| 21 | PASS | `ab` with `x-team-id` of team B and no agent of `ab` there (session bypassed with team B chosen): pool B on gives a team B token; pool B off (clients cleared, then disabled) gives the normal upstream, never the team A pool that had usable accounts |
| 22 | PASS | Real session start form (`AskUserQuestion` answer "No, skip for this session"): `a` got a team A token; `ab` (teams A and B) got a team B token (first in Core order) |

Waits: the Proxy caches are 30 s (rows, accounts) and 60 s (membership). The runner polls with a deadline after each Core change and never restarts the Proxy.

## Pass text not met

| # | What the plan text asks | What the check did |
|---|---|---|
| 2 | An account of team A's group in the Proxy log | Provider call token (proof) plus a Codex usage log row; no Claude Code line exists |
| 3 | No account id in the log | Missing pool token on the provider call, one call to the normal upstream fake |
| 6 | Through the Hub | Core-direct with the caller's user key; Hub not started, its forward not traced |
| 10 | Scheduler log shows no timer for the deleted accounts | The scheduler logs no line when it drops a timer; a later `check-all` called the provider for team A and never with a team B token |

Not observed, only read from code and unit tests: the `503 team_list_unavailable` answer and the OpenAI-shaped bodies (`{"code":403,"error_code":"NO_TEAM_POOL",...}`) written in the Proxy doc. I saw the Anthropic-shaped `403 no_team_pool`, `403 no_active_team` and the `429` with its headers. The doc shapes for the first two come from `pool-team.ts` (`teamErrorResponse`) and its unit tests.

## Observations

- Core answers `/health` before the store of the instance is open. The store opens on the first metadata call, and the migration (the backfill line) runs then. In one Mongo run the runner read `default.agents` about 200 ms after `GATEWAY_READY`, before the migration had finished (log order: `GATEWAY_READY`, `GET /health`, then the backfill line). The data was right a moment later. This is not a data defect, but a deploy check that reads the database right after "healthy" can see the old shape. The runner now makes one metadata call after `/health`. Phase 6 should wait for the backfill line, not for health.

## Defects

**Fixed (small, proven by a failing test first)**

1. A new account got the old start value for up to 60 s after a System Admin changed it. `MetadataService.defaultSubscriptionThreshold` read the value through the config parameter service, which caches for 60 s, but the settings route writes the store directly. Found by check 15 (new account got 90, not 80). The old code had the same cache, but the cache now matters because the value is the start threshold of every new account.
   - Test: `subscription-pool-team-scope.contract.ts`, "a changed start value reaches the next read at once, also after an earlier read". It failed (`expected 95 to be 80`) before the fix and passes on SQLite and Mongo after it.
   - Fix: `defaultSubscriptionThreshold` (`MetadataService`) reads the stored row first and uses the service only for the registry default.
   - GitNexus: the index was stale for this new method (`Target not found`, risk UNKNOWN). Callers confirmed by `rg`: status, the internal account list and `completeSubscriptionOAuth`, all in `metadata-service.ts`. The change keeps the signature and adds no behavior other than the fresher read.

**Not fixed (for the coordinator)**

2. The Claude Code runner does not write the serving account id to the usage log. Only the Codex, WorkBuddy and utility runners do. The old code is the same (`git show HEAD` has no `subscriptionAccountId` in `anthropic.ts`). The deploy check "a Claude Code turn: Proxy log has a pool `account_id` and `team=`" cannot pass from the usage log, and the success path of a pool request logs no `account_id=… team=…` line (only the retry and warning lines do). Phase 6 must prove it another way (Core usage and `active_sessions`, or the provider call) or the Proxy must log it.
3. `team/delete` and `team-member/remove` need the caller to be admin of the team, also for a System Admin. In my fixture the admin owns teams B and C. This is the old rule, not a regression. If the System Admin must delete a team that he is not in, this is a gap (not in the plan).
4. `deploy/global-images/start-memory-core.sh` passes a fixed list of variables and does not pass `TDAI_METADATA_DEFAULT_TEAM_NAME`. The `compose.yaml` of the production stack can pass it only through `environment` or a server-only file in `env_file` of `memory-core`. Production has one team named `default` and needs no setting. Not changed.
5. Check 10 cannot see the scheduler drop a timer in a log (no log line exists).
6. Check 22 and the form: the answer text is matched by the English label "No, skip for this session". The Chinese label is also accepted by the Proxy; not run.

## Docs changed

- `CONTEXT.md`: **Subscription Pool** (team meaning), **Threshold** (per account), new **Team** and **Request Team**. `rg -n "one Memory instance" CONTEXT.md` shows the new text.
- `docs/adr/0003-team-scoped-subscription-pool.md` (next free number: 0001 and 0002 exist). Status `accepted`, links ADR 0001. Describes what the code does: user default before header preset, team errors wait for session init, fail-closed rows, per-account threshold, migration rule, options considered, consequences (no script path cited).
- `MemoryProxy/v3-api-memoryproxy-doc.md` (section 4.4): "Team of a request", the table of `403 no_team_pool`, `403 no_active_team`, `429`, `503 team_list_unavailable` with the body shapes of both envelopes and `retry-after: 5`, models list and Account Switch by team. Checked against `pool-team.ts`, `exhausted-response.ts` and the bodies seen in checks 18, 19 and 20 (see "Pass text not met" for what was not observed). The order of the team sources is qualified: the user default and the header preset count only for a request that can still run session init (`pool-team.ts`, `else if (deferrable)`); a request with `x-memory-mode: off` skips both. The same qualification is in the ADR.
- `MemoryCore/v3-api-memorycore-doc.md`: new section "Team of the pool rows at start" with the default team rule, the log lines and `TDAI_METADATA_DEFAULT_TEAM_NAME` (and the deploy gap of defect 4). This file is where the other pool variables (`SUBSCRIPTION_POOL_ENABLED`) are documented. The Core pool route table from phase 2 matched the observed answers; no change.
- `MemoryPanel/panel-api-doc.md`: checked, no change. The 12 `subscription-pool/*` actions of the doc match the allowlist in `meta-actions.ts`.
- Not changed, on purpose: `deploy-agent-memory` skill (waits for user approval), `INSTALL*.md`, `.env.example` (they list variables that the start script passes; this one is not passed).

## Processes started and stopped

Every process was started by the runner (or by hand for the smoke and probe runs) with `node --import … ` directly, so each PID is the listener. All exited on SIGTERM with code 0; no SIGKILL was needed. Ports were checked free before each run (`lsof`) and after the last run: no listener on 18017, 18096, 18419, 18420, 18500, 18501.

| Run | Processes (name PID, ports) |
|---|---|
| Final SQLite run (`/tmp/tp-e2e/run/processes.json`) | fakes 80955 (18500, 18501); core 80977, 81253, 81386, 81537, 81683 (check 1 variants and the first start of the main run); proxy 81793 (18096); core 9615 and 9705 (the two restarts), all Core on 18420 |
| Final Mongo run (`/tmp/tp-e2e/run-mongo/processes.json`) | mongod 9864 (18017, replica set `rs0`, temp dbpath); fakes 10025; core 10112, 10261, 10421, 10698, 11238; proxy 11405; core 11863 and 12052 |
| First smoke run (by hand) | fakes 41994 (18500, 18501), core 42028 (18420), proxy 44119 (18096); stopped with `kill -TERM` |
| Probe run (`--hold`, last registry kept in `/tmp/tp-e2e/probe/processes.json`) | fakes 36649, core 36659, proxy 36894; released by the release file |
| Mongo inspection (by hand) | mongod 78182 on 18017 over the dbpath of the failed Mongo run, to read the data; stopped with `kill -TERM` |

The registries of the earlier full runs and of the other `--hold` probe runs were overwritten when the runner cleared its work directory, so I cannot list their PIDs. They used the same ports and were all stopped (the port check after each run showed no listener). The `mongod` PID 87561 (port 56587, started on 2026-11-20 by `mongodb-memory-server`) is not mine and was not touched. Outbound guard log of the final runs: 272 provider calls redirected to the fake, 0 blocked.

Temp data stays in `/tmp/tp-e2e` (outside the repository): old code tree, fixtures, run logs, `results.json`.

## Suites (final)

| Suite | Command | Result | Baseline |
|---|---|---|---|
| MemoryCore | `cd MemoryCore && MONGOMS_SYSTEM_BINARY=$(command -v mongod) npx vitest run` | 91 files passed, 1 skipped; **1614 passed**, 1 skipped (Mongo suites ran) | 1606 |
| MemoryProxy | `cd MemoryProxy && npx vitest run`; `npm run typecheck` | 91 files, **1384 passed**; typecheck clean | 1384 |
| MemoryPanel | `cd MemoryPanel && npx vitest run`; `npm run typecheck`; `cd web && npx tsc --noEmit -p .` | 36 files, **505 passed**; both typechecks clean | 500 |

Delta: Core +8. Two are mine (the new test runs on SQLite and on Mongo). I cannot attribute the other six: I changed no other Core test file, so they come from tests that were added after the phase 2 count. Panel +5: I did not touch Panel, so these also come from after the phase 4 count. No test fails.

## Plan state

I did not update the plan or the phase file status (`ak plan` was not run); the coordinator owns it.

## Not run / limits

- Check 10: scheduler timer drop is not visible in a log (above).
- The Hub and the Panel web were not started (Core-direct calls).
- Checks 2 to 22 on MongoDB other than 4, 6, 12, 13, 16 were not run (the plan asks only for those).
- Fake providers: real token refresh, real quota payload drift and real 429 behavior are not covered.
- No production copy: real data volume and team names are phase 6 rehearsal work.

## Unresolved questions

0. Core reports healthy before the migration has run (Observations). Should the runbook wait for the backfill line?
1. Must the down-step script be written now (phase 6 owns it, phase 5 asks only for its mention)? I wrote none.
2. Should the Claude Code runner log the serving account id and team (defect 2)? Phase 6 check 4 assumes it does.
3. Should a System Admin be able to remove a member of, or delete, a team that he is not in (defect 3)?
4. Should `start-memory-core.sh` pass `TDAI_METADATA_DEFAULT_TEAM_NAME` (defect 4)?

Status: DONE_WITH_CONCERNS
Summary: All 22 local two-team checks pass on the outcome on SQLite and the six Mongo checks pass, from an old-shape fixture built by the base code; checks 2, 3, 6 and 10 meet their literal pass text only in part, and one start-value cache defect was fixed under a failing test.
Docs (CONTEXT, ADR 0003, Proxy and Core API docs) are written; the down-step script is not written (phase 6 owns it), and the Claude Code usage log has no account id, which phase 6 check 4 needs.
