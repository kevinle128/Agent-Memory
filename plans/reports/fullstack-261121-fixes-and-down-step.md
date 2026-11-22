# Fixes and down-step: team-scoped Subscription Pools

Date: 2026-11-21 (Asia/Saigon). Branch `feat/team-scoped-subscription-pool`. No commit, no push, no production access, no SSH. The AntiGravity quota display files were not touched.

## Summary per task

| # | Task | Result |
|---|---|---|
| 1 | Default team by id | Done |
| 2 | SQLite `deleteTeams` atomic | Done (SQLite). MongoDB documented, not changed |
| 3 | System Admin sees every team in the Panel | NOT done: Core has no all-teams route. Reported, as agreed |
| 4 | Claude Code runner logs account id and team id | Done |
| 5 | Down-step script and rehearsal | Done (SQLite only) |
| 6 | ADR paragraphs for the two accepted low risks | Done |
| 7 | Full suites and typechecks | See "Task 7" |

## Task 1: default team by id

- New optional setting `TDAI_METADATA_DEFAULT_TEAM_ID`, read in `loadStoreConfig` like the name variable (trimmed; a blank value counts as not set; the field is left out of the config when not set).
- New pure function `pickDefaultTeamById(configuredId, activeTeamIds)` in `pool-team-scope.ts`. When the id is set, only the active team with that id counts. A missing or inactive id gives `not_found` with `reason: "configured_team_not_active"`, and no name rule runs. The existing error line (one line per start) now shows `reason=configured_team_not_active` and names `TDAI_METADATA_DEFAULT_TEAM_ID`. When the id is not set, the name rules are unchanged. The id wins over the name when both are set.
- SQLite and MongoDB backfill both use it (`sqlite-adapter.ts`, `mongodb-adapter.ts`); both store options and the store pool pass `defaultTeamId`.
- Deploy files: `deploy/global-images/start-memory-core.sh` passes both variables (only when set), `deploy/global-images/.env.example` lists both, and `compose.yaml` declares both under `memory-core.environment` (empty default). Komodo reads the stack environment through `compose.yaml`, so `deploy/komodo/compose.override.yml` needs no change (deviation: the name variable was declared nowhere before, so there was no existing line to extend there).
- Docs: `MemoryCore/v3-api-memorycore-doc.md` (rule list, pass-through text) and ADR 0003 (Migration).
- Tests (written first, failed first): `pool-team-scope.test.ts` (3 new), `factory-default-team.test.ts` (4 new), shared migration contract on SQLite and MongoDB (3 new cases each: id ignores a team named default; id wins over name; missing and inactive id assign nothing and log one line, agents still restored). 
- Command: `MONGOMS_SYSTEM_BINARY=$(command -v mongod) npx vitest run src/metadata/store/pool-team-scope.test.ts src/metadata/store/factory-default-team.test.ts src/metadata/store/subscription-pool-migration.sqlite.test.ts src/metadata/store/subscription-pool-migration.mongo.test.ts` gives 4 files, 59 passed.
- The comments I added to `start-memory-core.sh` and `.env.example` are in English. `docker compose -f compose.yaml config` parses and shows both variables (exit 0); `bash -n` on the start script is clean.
- GitNexus: `loadStoreConfig` impact is HIGH by caller count, but the change only adds an optional field. `pickDefaultTeam` and the backfill methods are not in the index (`UNKNOWN`); callers were confirmed with `rg` (only the two adapters call the pick functions).

## Task 2: SQLite `deleteTeams` is one transaction

- `SqliteMetadataStore.deleteTeams` now runs the team delete, the member/agent/task/asset deletes, the pool account id read and the pool group delete (accounts go by the foreign key cascade) inside one `BEGIN IMMEDIATE` transaction.
- New test `sqlite-delete-team-atomic.test.ts` (2 tests): the normal delete, and a trigger that makes the pool group delete fail. Before the fix the second test failed because the team row was already gone; after the fix the team, its member, its pool group and its account all stay.
- Run: this file plus `subscription-pool-team-scope.sqlite.test.ts` and `metadata-store.sqlite.test.ts`: 3 files, 143 passed.
- GitNexus `impact` on `SqliteMetadataStore.deleteTeams` (with the file path): LOW, 1 direct caller, with the interface caveat. `rg` shows one production caller, `MetadataService.deleteTeams` (`metadata-service.ts:1008`); the `v2-router.ts` call uses a different store type. Signature and return value are unchanged.
- MongoDB is not equal and was not changed. It deletes the team document first and the related rows in separate steps; only the pool groups and accounts share one transaction, and only when the deployment has transactions. A stop in between leaves pool rows of a team that no longer exists (no team can use them). Documented in ADR 0003. Production uses SQLite.

## Task 3: Panel, System Admin sees every team (NOT done)

Core `team/list` (`v3-meta-router.ts:182`) calls `listTeamsByUser` for the user id in the body. A System Admin gets only the teams of which he is a member. No other route lists all teams. As instructed, I did not add a Core route and did not change the Panel. This needs a decision: add an admin team list route in Core (then use it in `teamsApi.list` for a System Admin and add a Panel test), or accept the gap. The start-threshold-without-a-team case in the review is also not handled.

## Task 4: Claude Code runner logs the serving account and team

- `MemoryProxy/src/pipeline/runners/anthropic.ts`: after the pool send, when a pool account served the request, the ids are added to `responseLogMeta`, so the non-stream and stream usage records carry `subscriptionAccountId` (the same field the Codex runner writes, which fills the ClickHouse column) and a new `subscriptionTeamId` (the 4xx error record spreads the same object, but that path has no test). `responseLogMeta` also feeds the Langfuse trace and observation metadata, so the account id and team id go there too. One line is written: `[subscription-pool] served account_id=<id> team=<team_id>`. No token is logged. A fallback to the client's own login adds nothing.
- `MemoryProxy/src/types.ts`: new optional `subscriptionTeamId` on the usage entry type.
- Tests in `pool-usage-log.test.ts` (4 new, failed first): non-stream and stream records carry both ids; exactly one console line, and the pool token is in no log call; a turn outside a pool has neither field. The file now has 7 tests, all passing.
- GitNexus: `runAnthropicPipeline` impact LOW.

## Task 5: down-step script

File: `MemoryCore/scripts/ops/subscription-pool-team-scope-down.mjs` (SQLite, Core stopped). Test: `MemoryCore/src/metadata/store/subscription-pool-team-scope-down.test.ts` (13 tests, all pass).

Behavior:
- Refuses (exit 2, nothing changed, no backup folder) when more than one team holds pool groups, when a source name is used twice (any groups, so a pool name that clashes with an API group is caught), when a pooled agent would stay in a second group, or when the database is not a Core metadata database.
- `--dry-run` opens the database read only and prints counts.
- Before the first write it copies `metadata.db`, `-wal`, `-shm` to a new folder `<backup-dir>/<UTC stamp>-team-pool-down` (folder 700, files 600, hash of each copy checked). `--backup-dir` is required for a real run (there is no default), because the script runs in a throwaway container and a folder inside it would be lost. A dry run needs none.
- The output names the team that holds the pools (`pool_team`). After a rollback the old code shares that pool with every team.
- Disabled pool groups: `disable` is refused while the pool has clients, so a disabled pool group has `agents = []` and no agent leaves the default group because of it (tested). But `disable` only sets `enabled = 0`; the group stays. So a second team with only a disabled pool still makes the script refuse (tested).
- The only supported action that removes a pool group is team delete (`team/delete`; the generic group delete refuses pool groups). The refusal message says so. This is a product decision, listed in the open questions.
- In one `BEGIN IMMEDIATE` transaction it re-reads the plan, removes the agents of the pool groups from the default group, drops `ux_iuc_team_source_name`, creates `ux_iuc_source_name`, runs `PRAGMA quick_check`, and rolls back if the result is not `ok`.
- It keeps `team_id` and `threshold_pct`. It prints counts, agent names and the backup path only; it never reads or prints a token. A second run changes nothing.

Deviation from phase 6 text: phase 6 deleted the pool rows of non-default teams and exported them. Your instruction replaced that with "refuse when more than one team has pools", so the script exports and deletes nothing. The operator must remove other teams' pools first. There is no MongoDB variant (production is SQLite); the ADR says so.

Tests: the script test was written after the script (deviation from fails-first). I checked it by mutation: removing the duplicate check, the multi-team check, or the index creation each made exactly one test fail.

Rehearsal (all on COPIES in `/tmp/team-pool-rehearsal`, Node 22.22.2, fake tokens, local fake provider, ports 18420 only, no production):
1. Old tree = `git archive eff54bda MemoryCore`; the harness `build-fixture.ts` made the old-shape fixture (no `team_id`, no `threshold_pct`, index `ux_iuc_source_name`, default group without claude-code and codex).
2. New Core on a copy: log `team backfill team=team-43mqrvgzdl groups=2 agents_restored=claude-code,codex`; index became `ux_iuc_team_source_name`; the three accounts got threshold 90.
3. Down-step `--dry-run`: exit 0, counts `pool_rows=2 teams_with_pools=1 agents_removed=2`, database file hash unchanged, no backup folder.
4. Down-step real: exit 0, `quick_check=ok`, default group back to the 8 old agents, index `ux_iuc_source_name`, pool rows and all accounts unchanged (`team_id` kept), backup folder with `metadata.db` mode 600 and the same hash as the database before the step. A second run: `agents_removed=0`.
5. OLD Core (`eff54bda` code) opened the rolled-back copy: it started, `auth/verify` code 0, `instance-upstream/groups/list` returned the default group and both pool groups, a write to the claude pool group succeeded (status 200), `quick_check` ok afterwards, index unchanged. The only error lines in its log are the harness log directory and the expected rejection of a description write to the default group.
6. Roll forward again with the new Core on the same copy: starts, default agents restored again, index back to the team index, thresholds kept (90).
7. Second copy: new Core, then team B enabled a claude pool through the API (status 200), so `sub-claude` existed in two teams. Down-step real and `--dry-run` both exit 2 with `REFUSED (multiple_teams_with_pools)`; database hash unchanged; no backup folder. (Without the refusal, the old Core could not build its unique index.)

8. Way out of the refusal (same second copy): the System Admin deleted team B with `team/delete` (status 200, `sub-claude` of team B gone). Down-step `--dry-run` exit 0, real run exit 0 (`quick_check=ok`, `pool_team` = team A, 2 agents removed, backup folder written). A real run without `--backup-dir` exits 1 with the message. The OLD Core (`eff54bda`) then opened the copy: `auth/verify` code 0, default group and both pool groups listed, `quick_check` ok, index `ux_iuc_source_name`.

How to run it on the server (Core stopped; `scripts/ops` is in the Core image, because the Dockerfile copies the tree and `.dockerignore` does not exclude `scripts`; the image is Node 22): 
`docker run --rm --entrypoint node -v <core data volume>:/data/tdai-memory -v ~/backups:/backups <core image> scripts/ops/subscription-pool-team-scope-down.mjs --db /data/tdai-memory/metadata/tdai_metadata_default/metadata.db --backup-dir /backups --dry-run` and then the same without `--dry-run`. (Not run: the volume and image names are the operator's; the runbook forbids compose by hand, so run it the way the deploy skill runs one-off containers.)

Not rehearsed: a restored copy of the real production database (not available to me), a MongoDB database, and a pool request through the OLD Proxy (only the old Core was opened).

## Task 6: ADR 0003

Added to Consequences: the accepted low risk that an `openai-chat` error text reveals whether a pool name exists, is off or lacks the client; the accepted low risk that a removed member keeps the team pool up to 10 minutes during a Core outage; the team delete atomicity note; the rollback bullet now names the script; the old "Claude Code writes no account id" bullet was replaced by the new behavior.

## Task 7: full suites

- MemoryProxy: `npx tsc --noEmit` exit 0; `npx vitest run`: 91 files, 1388 passed.
- MemoryPanel: `MemoryPanel/node_modules` was an empty directory (created 19:58, before this session, not by me), so the tools were missing. I ran `npm ci --ignore-scripts` there (ignored directory, no tracked file changed). Then `tsc --noEmit` exit 0, `web: tsc --noEmit -p .` exit 0, `npm test`: 36 files, 505 passed.
- MemoryCore full run, `MONGOMS_SYSTEM_BINARY=$(command -v mongod) npx vitest run`: 94 files, 1639 tests: 1634 passed, 1 skipped, 4 failed. The 4 failures are all in `metadata-store.mongo.test.ts` and are `Hook timed out in 120000ms` / `MongoNetworkTimeoutError` from the in-memory Mongo server, while the Proxy and Panel suites ran at the same time on this machine. The same file run alone afterwards: 1 file, 219 passed. This full run started before the later edits to the down-step script and its test; the 13 tests of that file were run again after the edits (13 passed), and the rehearsal ran with the final script.
- MemoryCore typecheck: MemoryCore has no tsconfig or typecheck script, so I used the strict ad-hoc config of the phase 1 report (`src/**` and `index.ts`, `strict`, `NodeNext`, `skipLibCheck`) on the working tree and on `git archive HEAD`. Both give 240 errors. After removing the position and path text, the lists differ only in the absolute path inside three messages and in one old fixture error of `timer-plan.test.ts` (one more field listed in the same old error). No error in `factory.ts`, `pool-team-scope.ts`, the new tests, or the migration contract. The adapters keep the same two old errors each (`IMetadataStore` name, and others that exist at `HEAD`). The new test files compile (`import.meta.dirname`, top-level `await import`).

Processes: every Core process of the rehearsal was stopped by the harness; at the end `ps` shows no vitest, core-launcher or redirect-fetch process and nothing listens on ports 18420, 18500, 18501 or 18017. The background waiter finished. One `mongod` (port 56587, started Friday 04:00) is not mine and was left alone.

Label scan of added lines (`git diff -U0` and the new files; words `phase`, `finding`, `audit`, `H1`..`L9`, `F<n>`): none. The only hits are the cache layer names `L1`/`L2` in older diff lines of the session store, which are not plan labels.

Rehearsal output: `/tmp/team-pool-rehearsal/rehearsal-output.txt` (30 lines; fake tokens only). The orchestration script is `/tmp/team-pool-rehearsal/tools/rehearse.mjs`; it is outside the repository.

## Unresolved questions

1. Task 3: add a Core route that lists all teams for a System Admin, or accept the gap?
2. Should the down-step get a MongoDB variant, or is "production is SQLite" enough?
3. Only `team/delete` removes a second team's pool group (and its accounts, which cannot be undone). Is that the intended way out of the refusal, or should the script move or delete those rows (the earlier phase 6 text exported and deleted them)? I kept "refuse".
4. Production `TDAI_METADATA_DEFAULT_TEAM_ID` should be set to `team-f0bzqawutx` in the Komodo stack environment before deploy; I did not set it anywhere.

Status: DONE_WITH_CONCERNS

Tasks 1, 2, 4, 5 and 6 are done with tests; task 3 is not done because Core has no all-teams route (decision needed). Core full suite: 1634 passed, 4 Mongo hook timeouts under load that pass alone (219 of 219).
The down-step script refuses with more than one team holding pools and was rehearsed up, down, old Core and roll forward on copies; the only way out of its refusal is deleting the other team.
