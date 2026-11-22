# Phase 0: Preflight facts and user confirmation

## Goal

Get the production facts that the code cannot give, and get the user's go for the behavior change. No write to production. Every step here reads production, so ask the user first (`operator-master/tasks/lessons.md`, 2026-10-22 entry: "Do not touch production during local work, not even read-only. Ask first.").

**Production access status: approved by the user on 2026-11-21 for the read-only steps of this phase only.** Steps 1-4 and 6-9 are done (results below). Still unread: step 5 (affected request counts, 5a and 5b), the user ids of the 3 users in no team (plan Q8), and the effective normal upstream value (plan Q9). Any further read needs the same read-only scope; any write or restart is out of scope and needs a new go from the user.

User answers already given (2026-11-21): Q1-Q7 are answered; Q3 = threshold per account, Q6 = ordered team fallback with clear errors (see `plan.md`). Phase 0 still records the facts below, because the migration depends on them (default team name, global threshold value) and the counts document the accepted change.

## Why this phase is first

- The default team id is random and its name can change (`metadata-service.ts:524-528`, `sqlite-adapter.ts:1116-1120`). The backfill can only find it by name. The backfill finds it with the default team rule of plan D6 (configured name, else `default`, else `default-team`). If that rule finds zero or two teams, no team uses the old pools (plan D6): every client runs on its default group until the operator sets the name.
- After the change, sessions of non-default teams stop using the default team pool and run on the shared normal upstream (user decision 3, plan D3/D4). Requests without a known team (bypass without a chosen team, no session id, `x-memory-mode: off`) use the fallback of plan D14; a user whose teams have no pool for the client then gets a clear error. The counts below show how many requests each rule touches.
- The "normal upstream" of Claude Code and Codex comes from Proxy config (`pipeline/stages/resolve-target-full.ts:58-67`: `upstream.agents[agent]`, then `costGuard.anthropicUpstream`, then `upstream.url`). Code cannot tell whether that is a paid API key. [UNVERIFIED]

## Steps (read-only, after the user says yes)

Use the shared SSH connection from the `deploy-agent-memory` skill. Never print a token or key. Database: `/data/tdai-memory/metadata/tdai_metadata_default/metadata.db` in container `agent-memory-memory-core-1`. Open it read-only (`?mode=ro`) with the Node SQLite runtime of the container.

1. Default team candidates:
   `SELECT team_id, name, status, created_at FROM meta_teams WHERE name IN ('default', 'default-team');`
   Pass: the plan D6 rule finds exactly one team. Record the `team_id`.
2. Pool rows and their agents:
   `SELECT group_id, name, enabled, agents, source_name, source_agents FROM meta_instance_upstream_config WHERE mode = 'subscription_pool';`
   and the default row: `SELECT agents FROM meta_instance_upstream_config WHERE group_type = 'default';`
   Record which agents the migration adds back to `default.agents`.
3. Accounts per pool group (no token columns):
   `SELECT group_id, provider, COUNT(*) FROM meta_upstream_subscription_account GROUP BY group_id, provider;`
4. Reserved source names on non-pool rows (must be zero rows):
   `SELECT group_id, mode, source_name FROM meta_instance_upstream_config WHERE mode != 'subscription_pool' AND source_name IN ('sub-claude','sub-openai','sub-antigravity');`
5. Requests affected on deploy day (plan D14, Q1). Count for the last 7 days, by client and by team id, never by user name:
   - a. Registered sessions of pool clients (`claude-code`, `codex`, `antigravity`, and multi-source clients in `source_agents`) whose team is not the default team, and bypassed sessions. Source: the Proxy session bindings (L2b, written at `session/store.ts:220-245` with `teamId`, `userId`, `outcome`). Find the storage path in the `storage:` section of `/data/config.yaml` first.
   - b. Pool requests that have no registered session (no session id, or `x-memory-mode: off`). After the change these use the fallback of D14; their users who are only in teams without a pool get `no_team_pool`, and users with no active team get `no_active_team`. Count the distinct users in each group by team membership (`meta_team_members`, read-only). L2b cannot see these requests. Source: Proxy pool log lines (`[subscription-pool]` with `account_id`, `pool-request.ts:42`) joined by request id to the session-init debug line (`[injection-debug] conversationId=...`, `anthropic.ts:775`), or Langfuse traces of pool requests without a session id. If the logs do not cover 7 days, report the window that they cover.
6. Normal upstream per client: read the `upstream:` and `costGuard:` sections of `/data/config.yaml` in `agent-memory-proxy-1`. Record only whether `upstream.agents.claude-code`, `upstream.agents.codex` exist and whether their key is empty, a client pass-through, or a stored key. Do not copy values.
7. Session init is on: `sessionInit.enabled` in the same file. If it is off, no session gives a team, so every pool request uses the ordered fallback of plan D14 (first team of the user in Core order with a usable account).
8. Optional header auto-select: `sessionInit.headerAutoSelect.enabled` and header names.
9. Current global threshold (the value the migration copies into each account, plan D12):
   `SELECT param_value FROM meta_config_params WHERE module = 'subscription_pool' AND param_name = 'threshold_pct' AND scope = 'global';`
   No row → the default 95 (`MemoryCore/src/metadata/config/metadata_config_params.json:56-60`).

## Gate

Write the results into the "Preflight results" section below and stop. Show the user the numbers. Q1 and Q4 are already accepted; ask again only if the numbers differ from what the user expected (for example many non-default team sessions). Phases 1-5 are local work and can start before this phase; phase 6 (deploy) cannot start before this phase is done and its stop conditions are clear.

Stop conditions:
- The plan D6 rule does not find exactly one team: ask the user which team is the default team, then set `TDAI_METADATA_DEFAULT_TEAM_NAME` in the stack before deploy. (Production result: one team `default`; no setting needed.)
- Step 4 returns a row: ask the user how to rename that source before deploy; reserved names would reject later writes to it.
- Step 7 is off: the team of a session is never used, only the fallback order; show this to the user before deploy.

## Preflight results

Read-only check of 2026-11-21. No secret value was read or written here.

| Item | Value |
|---|---|
| default team id | `team-f0bzqawutx`, name `default`, 13 active members; confirmed by the user as the default team. No team is named `default-team` |
| pool rows (group_id, provider, enabled, agents, source_agents) | 3 rows, all enabled: claude (`agents` = claude-code, source `sub-claude`, `source_agents` = omp, hermes, openclaw); codex (`agents` = codex, source `sub-openai`, `source_agents` = omp, hermes, openclaw); antigravity (`agents` = antigravity, source `sub-antigravity`, `source_agents` empty) |
| agents to add to default.agents | claude-code, codex, antigravity. The default row now holds codebuddy, dsh, hermes, omp, openclaw, opencode, workbuddy |
| accounts per group | claude 1, antigravity 1, codex 0 |
| reserved-name conflicts | none |
| affected sessions (7 days) by team / client; bypassed | not read yet (step 5a and 5b) |
| team membership | 14 users in at least one team; 1 user in more than one team; 3 active users in no team (they get 403 `no_active_team` after deploy, plan Q8). Other team: `GAME MOBILE STUDIO` (`team-3m8q059j9r`, 2 members, no pool) |
| normal upstream of claude-code / codex | unknown: `/data/config.yaml` of the Proxy has no `upstream:` section and the container has no `UPSTREAM*` variable; `costGuard.enabled` is false. Effective value not read yet (plan Q9) |
| sessionInit.enabled / headerAutoSelect | `sessionInit.enabled` true; `headerAutoSelect.enabled` true with headers `x-team-id`, `x-agent-id`, `x-task-id`, `onMismatch: form` |
| global threshold_pct (copied into accounts) | 95 |

## Risk

| Risk | Likelihood × Impact | Mitigation |
|---|---|---|
| A read step changes production | Low × High | Read-only DB mode; no restart; no write command; ask first |
| Secret printed in a log | Low × High | Select no token columns; report presence of keys only |

## Rollback

Nothing to roll back. This phase writes nothing.
