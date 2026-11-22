# Phase 6: Deploy, verify, roll back

## Context

- Runbook: `operator-master/.claude/skills/deploy-agent-memory/SKILL.md`. A merge to `master` builds core, hub and proxy and deploys all three in one Komodo stack update (`:8`, `:65`). Production metadata is SQLite at `/data/tdai-memory/metadata/tdai_metadata_default/metadata.db` (`:31`).
- Before a metadata schema change: stop `memory-core`, copy only `metadata.db*` to `~/backups/`, then start the new image (`:31`). Do not tar the whole volume (`operator-master/tasks/lessons.md`, 2026-11-19).
- Test every data change on a restored copy first (`tasks/lessons.md` main rules, `operator-master/CLAUDE.md`).
- Providers rotate refresh tokens (`docs/adr/0001-proxy-side-subscription-pool.md`). A restored backup can hold tokens that are already dead.

## Down-step script (write and test before deploy)

New file `MemoryCore/scripts/ops/subscription-pool-team-scope-down.mjs`. It runs inside the Core container with the Node SQLite runtime, on the live database, with Core stopped. Steps, in one transaction:

1. Find the default team id the same way as the backfill (`pickDefaultTeam`, plan D6; production: `team-f0bzqawutx`). Find pool rows with another `team_id`.
2. Export those rows and their accounts to `~/backups/<ts>-team-pools.json`, file mode `600` (it holds tokens; never print it).
3. Delete those pool rows (accounts go by the FK cascade).
4. Remove from `default.agents` each agent that is in a default team pool row's `agents` (the backfill added them; production: claude-code, codex, antigravity).
5. `DROP INDEX IF EXISTS ux_iuc_team_source_name`; `CREATE UNIQUE INDEX ux_iuc_source_name ON meta_instance_upstream_config(source_name) WHERE source_name != ''`.
6. Keep the `team_id` column and the account `threshold_pct` column. The old image ignores both: it maps named fields only and names its insert columns, so the column defaults apply. After a rollback every account uses the global threshold again; the per-account values stay in the column and come back on the next forward deploy.
7. Print counts only: rows exported, rows deleted, agents removed, `PRAGMA quick_check` result.

`--dry-run` prints the counts and changes nothing. Test on a restored copy: run up (start the new image on the copy), create a team B pool, run down, start the old image on the copy, and check that Core starts, `quick_check` = ok, and default team pool requests work.

Why the down-step is necessary (verified):
- The old image creates `ux_iuc_source_name` on every start (`sqlite-adapter.ts:500-512`). With two teams holding `sub-claude` the index creation fails and Core does not start.
- The old store rejects writes with `agents_overlap` while an agent is in both `default.agents` and a pool row (`sqlite-adapter.ts:2814-2850`).
- The old Proxy takes the first custom row that holds the agent (`instance-upstream-cache.ts:235-246`). With two teams' pools holding `claude-code`, the old Proxy can send team A traffic on team B's account. So **never roll back the Proxy alone while a non-default team has a pool**. Run the down-step first.
- The old image maps named fields only (`mapInstanceUpstreamGroup`, `sqlite-adapter.ts:2905-2935`), so the extra `team_id` column does not break reads.
- MongoDB instances (not production today): the old image tries to create `ux_source_name` again; with duplicate source names across teams the creation fails, but `ensureIndex` only logs it (`mongodb-adapter.ts:381-431`), so Core starts. The old-Proxy cross-team risk above still applies, so run the same down-step logic (a Mongo variant of the script) before the image rollback.

## Deploy steps

1. Phase 0 results accepted by the user; phase 5 e2e green; PR reviewed.
2. GitNexus: `node .gitnexus/run.cjs detect-changes --scope all --repo .` with no `partial` or `truncated` flag; record the result in the PR.
3. Backup: stop `agent-memory-memory-core-1`, copy `metadata.db*` to `~/backups/<yyyymmdd-hhmm>-team-pool/`, run `PRAGMA quick_check` on the copy, start Core again. Record the current image tag (rollback tag).
4. Rehearsal: copy the backup to a temp folder, start the new Core image against it locally or in a throwaway container, check the backfill log line and the phase 0 numbers. Run the down-step `--dry-run` on that copy.
5. Merge to `master`; watch `gh run watch <id> --repo kevinle128/Agent-Memory --exit-status`.

## Checks after deploy

0. Wait 30 s (one Proxy cache TTL) after Core is healthy on the new tag. This ends the window in which a new Proxy cached rows of the old Core without `team_id` (plan D8). Do not restart services by hand; the runbook forbids compose by hand (`SKILL.md:12`).
1. Three containers healthy on the new tag (`SKILL.md:76-81`).
2. Core log: one line `[subscription-pool] team backfill team=team-f0bzqawutx groups=3 agents_restored=claude-code,codex,antigravity` (values from phase 0).
3. DB read-only: every pool row has the default team id; `default.agents` has the restored agents; every account has `threshold_pct` equal to the global value recorded in phase 0.
4. A default team Claude Code turn: Proxy log has a pool `account_id` and `team=<default id>`.
5. A Claude Code turn of a non-default team user in a registered session (if one exists; ask the user): no pool account in the log; the response comes from the normal upstream.
5a. One `x-memory-mode: off` Claude Code request of a default team user: the Proxy log has a default team pool `account_id` and `team=<default id>`.
5b. Count the new error lines `[subscription-pool] no usable team pool code=` for 10 minutes by code. Compare with the phase 0 step 5b numbers; a much higher count means the gate or the order is wrong: stop and roll back.
6. `subscription-pool/status` without `team_id` → 400; with another team's id as a member of the default team only → `permission_denied`.
7. Logs of Proxy and Core for 10 minutes, starting one minute after step 0: no `AGENT_NOT_CONFIGURED`, `UPSTREAM_DISABLED`, 5xx or 401 bursts. An `AGENT_NOT_CONFIGURED` for a pooled client after that minute means the agent restore did not run: stop and roll back. Health alone is not a pass.

## Roll back

Order: Core data first, then images.

1. Stop Core. Run the down-step (`--dry-run`, then real). Check `quick_check`.
2. Deploy the old tag for all three services (`gh workflow run deploy.yml --repo kevinle128/Agent-Memory --ref <old sha>`), or set `MEMORY_BUILD_REVISION` in Komodo (`SKILL.md:91-94`).
3. Check: default team pool works as before; Panel pool page loads.
4. Last resort only: restore `metadata.db*` from step 3 of the deploy. After a restore, any account whose token rotated since the backup shows `auth_error` and needs a new login in Panel.

## Risk

| Risk | Likelihood × Impact | Mitigation |
|---|---|---|
| Backfill finds no single default team in production | Low × High | Phase 0 checks it. If it happens anyway, agents are still restored, so every client runs on its default group (no 400) and no pool is used until the operator fixes the team name and restarts Core |
| Non-default team users lose the pool and land on a paid key | Medium × High | Accepted by the user (Q1, Q4); phase 0 counts them |
| Requests without a known team now get `no_team_pool` / `no_active_team` instead of the old shared pool | Medium × Medium | Accepted by the user (Q6); phase 0 step 5b counts the users; check 5b watches the error count |
| Old Proxy + new Core during the swap | High × Low | Only default team pool rows exist on the first deploy, and the old Proxy picks the pool row first (`instance-upstream-cache.ts:235-246`), so traffic matches the old behavior |
| New Proxy + old Core during the swap | Medium × Medium | Old rows have no `team_id` and the pooled agent is only in the pool row, so pooled clients get 400 `AGENT_NOT_CONFIGURED` for up to one cache TTL (30 s). This falls inside the known deploy gap of about one minute (`SKILL.md:65`); step 0 waits it out |
| Rollback restores dead refresh tokens | Medium × Medium | Down-step on the live database instead of a restore |

## Done when

All checks after deploy pass, the results are written into `plan.md` "Progress", and the backup path and rollback tag are recorded there.
