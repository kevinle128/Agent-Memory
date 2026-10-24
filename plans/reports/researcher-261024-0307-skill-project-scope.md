# Skill project scope: lifecycle, production data and design

Date: 2026-10-24 (Asia/Saigon). Branch: `feat/server_team`. Mode: read-only. No code edits, no production writes, no restarts.

## Executive summary

The proxy injects a cross-project selection of the agent's skills into every session. It is not the full catalog: Core `/v3/skill/listing` returns the top 20 BM25 or activity hits for the agent, cut to 8000 characters (`MemoryCore/src/gateway/skill-handlers.ts:865-871,912-941`). This session received 15 of the 71 active skills of `agt-f0bzvpye01`. Skills have no project dimension anywhere: not in the `skills` table, not in the skill buffer, not in the `conversation/add` payload, and not in the injector cache key. The proxy already knows the verified project of each request (`withSessionProject`, `MemoryProxy/src/pipeline/runners/anthropic.ts:961-972`), so the project can be attached at the point where the proxy buffers the conversation.

User decisions that this report applies (they are decided, not open):

- Automatic extraction produces project skills only. Every extracted skill belongs to exactly one verified project. The system never creates a global skill by itself.
- Users can add skills manually and choose global or project scope.
- The project of a session comes from the existing hook report (session workspace). A session with no verified project (for example `~/Movies`, a non-git directory, or no hook report) produces no skill.

Recommended design (details in "Recommended design"): add `scope`, `project_key`, `project_hash` and `origin` to skills; let the proxy send the hook-reported project with each buffered round; gate in the Core worker at extraction time, so a slice without one verified project produces no skill; cut the buffer when the project changes; restrict the extractor's inventory and writes to the task's project; filter listing, search and load to "global + current verified project"; key the injector cache by project; quarantine existing extracted skills as `unassigned` until a user assigns them.

## 1. Skill lifecycle end to end

### 1.1 Buffering: proxy to Core

- Trigger. After the main-dialog response, the Anthropic runner calls `triggerSkillExtractIfReady` (`MemoryProxy/src/pipeline/runners/anthropic.ts:1619-1639`). Fork, side-query and subagent requests skip the buffer (`anthropic.ts:1615-1622`). Other call sites: `pipeline/stages/archive.ts:154`, `pipeline/stages/mem-command-intercept.ts:193`, `anthropic.ts:2022`.
- Gate. `skill/handler-glue.ts:73-106` returns early when `assetCapabilities.skill === false`, when identity or `space_id` is missing, or when the assistant turn has tool calls (only the final answer of a round is sent).
- Payload. `ConversationAddInput` is `session_id, space_id, user_id, team_id, agent_id, task_id, messages` (`skill/core-client.ts:133-137`; send site `handler-glue.ts:127-143`). There is no project field.
- Core route. `POST /v3/skill/conversation/add` → `handleConversationAdd` (`MemoryCore/src/gateway/skill-handlers.ts:1199`), schema `conversationAddRequestSchema` (`gateway/skill-schemas.ts:273-280`).

### 1.2 Skill buffer and archive

- Layout: `skill_buffer/<user>/<team>/<agent>/<session>/` with `data-current.jsonl`, archived `data-<ts>.jsonl` and `meta.json`; one `_tasks.json` per agent (`MemoryCore/src/core/skill/conversation-add/buffer-storage.ts:59-100,161`). Production confirms this layout under `/data/tdai-memory/skill_buffer/`.
- `meta.json` holds only `session_id, space_id, user_id, team_id, agent_id, tool_call_count, byte_count, last_appended_at_ms, last_archived_at_ms` (observed in production).
- `SkillTaskEntry` has exactly one `session_id` and one `archive_key` (`buffer-storage.ts:59-67`). One extraction task therefore covers one slice of one session.
- On a threshold (tool-call count, bytes, idle) the trigger service writes `data-<ts>.jsonl`, appends a task to `_tasks.json` and enqueues the agent (`conversation-add/wire.ts:80-120`, `trigger-service.ts`). `_tasks.json` is emptied after processing, so the task-to-session link is not kept (production `_tasks.json` files contain `"tasks":[]`).

### 1.3 Worker and extractor

- `extract-worker.ts` pops the agent, takes a per-agent lock, reads the archive and calls `SkillExtractor.extract` (`MemoryCore/src/core/skill/skill-extractor.ts:84-131`). The task id becomes `skills.task_id` of each version that the task writes (for example `skill-extract-task-4ab02287`).
- Prompts: `core/skill/prompts/skill-review-prompt.ts` (v2, default, English) and `skill-review-prompt-strict.ts` (v1, `strict_mode`). v2 says "Universality is a nice-to-have, not a gate" (`skill-review-prompt.ts:85`) and accepts "Background-type" project context as a skill (`:79`).
- Inventory and tools. Step 1 of the prompt is `skill_list` with no query to "see the whole library" (`skill-review-prompt.ts:181`). The prefetched block lists "Skills you (this agent) own" (`skill-extractor.ts:557-565`). The tools use `readIds/writeIds = {user_id, team_id, agent_id[, task_id]}` (`core/skill/skill-tools.ts:55-61`). So an extraction task in project B can read and patch a skill learned in project A.
- The one-task directive rule ("仅针对单次任务的指令 … 只有当内容被明确表述为长期规则 …") exists in L1, scene and persona prompts (`core/prompts/l1-extraction.ts:63,333`; tests `core/prompts/extraction-prompts.test.ts:6-41`, `persona-generation.test.ts:70`). It is absent from the skill review prompt. The v2 prompt only excludes secrets, log dumps, transient state and duplicates (`skill-review-prompt.ts:110-115`).

### 1.4 Storage

- Production uses SQLite (`STORE_MODE=sqlite`); skills live in `/data/tdai-memory/vectors.db`. Other backends: `core/store/mongodb/skill-store.ts`, `core/store/tcvdb/skill-store.ts`; DDL in `core/skill/skill-store-ddl.ts:21-104`.
- `skills` columns (production schema): `row_id, skill_id, version, is_head, user_id, owner_agent_id, team_id, task_id, name, description, content, content_hash, manifest_json, storage_dir, status, metadata_json, created_at_ms, updated_at_ms`. One row per `(skill_id, version)`; `is_head=1` marks the current version. Unique index `uniq_skills_team_agent_name_head (team_id, owner_agent_id, name) WHERE is_head=1 AND status='active'`.
- `skill_fts` (FTS5) indexes `name, description, content` with unindexed `skill_id, team_id, owner_agent_id, task_id, user_id`.
- `skill_vec` is created only when embedding dimensions > 0 (`core/store/sqlite/skill-store.ts:50,141,155`). Production has no `skill_vec` table, so production search and listing are BM25 only.
- `metadata_json` is `{}` for all sampled head rows. No skill row stores source sessions or a project.
- Metadata mirror: each skill has a `meta_assets` row (`asset_type='skill'`) and a fixed binding `meta_agent_fixed_assets` with `injection_mode='reference'`. `ensureSkillAsset` hardcodes `source_type: "extracted", visibility: "private"` (`MemoryCore/src/metadata/service/metadata-service.ts:1580-1632`), also for skills that a user creates in the Panel.

### 1.5 Selection and injection in the proxy

- `SkillInjector` (`MemoryProxy/src/injection/injectors/skill-injector.ts:162-342`): point `system.before_tools`, `cacheStrategy: "session_init"`, fixed `cacheKey: "skill-injector:catalog"` (`:332`), no `cacheVariantFor`.
- Prewarm runs at session registration, before any hook report. It builds a BM25 query from the agent and task descriptions (`:131-156`), or uses `mode: "activity"` for the default task (`:227-248`). The live `execute()` path (cache miss) sends no query and gets the head of the list (`:203-221`).
- Text: an English mandatory-load header, a Chinese paragraph ("以下是你（当前 agent）自带的云端 skill 列表 …"), then `<available_skills>` lines `- id=<skill_id>, name=<name>, desc=<description>` (`skill-injector.ts:104-116`; `skill-handlers.ts:950-969`).
- Scope: `core.list/search` with `team_id + agent_id`, so only the agent's own skills (`skill-handlers.ts:910-940`).
- `skillRuntime.selection` (Jev-based reranking) is off by default (`MemoryProxy/src/config.ts:41-49,819-840`).

### 1.6 Skill tools available to the model

- `SkillToolsInjector` renders a static `<skill_tools>` block with curl recipes for `skill_search`, `skill_view`, `skill_files_read`, `skill_extract`; write tools appear only when `skillRuntime.allowLlmWrite` is true (`injection/injectors/skill-tools-injector.ts:59-201,235`).
- `/skill-bridge/v3/skill/*` (`skill/skill-bridge.ts:142-162,450+`) resolves session identity, stamps `team_id/agent_id/user_id` (`:667-881`), and for `search` adds `scope:"team"` with an accessible-asset whitelist (`:746-861`). `extract` maps to `conversation/force-archive` (`:694-717`). `get` and `files/read` load any skill by id that passes the team checks. No call filters by project.

### 1.7 Manual skills and sharing

- Manual creation exists: Panel `ImportSkillDialog` creates a skill from a directory (`createSkill`) or asks Core to extract from an uploaded session (`extractSkills`) (`MemoryPanel/web/src/pages/SkillsPage/components/ImportSkillDialog.tsx:30-31,232`). The Panel server forwards `/api/v1/skill/*` to Core `/v3/skill/*` (`MemoryPanel/src/panel/api/skill-actions.ts:16-36`). Core `handleCreate` (`skill-handlers.ts:295-350`) does not record the origin.
- There is no origin field. Template skills (`api-docs`, `code-review`, `unit-test`, `task_id='default'`) and extracted skills look the same in `meta_assets` (`source_type='extracted'`).
- Sharing: search with `scope="team"` drops `agent_id` (`skill-handlers.ts:567-571`); the Panel toggles `visibility` private/team (`MemoryPanel/web/src/pages/SkillsPage/hooks/useSkillsPanel.ts:388-404`). In production, all 130 skill assets are `private` and `meta_asset_acl` is empty, so no cross-agent skill sharing is in use today.

## 2. Where the project dimension attaches

- Source of truth. The client hook posts to `routes/hook-report.ts:91-143`; `buildProjectIdentity` returns `git:<host>/<path>`, else `local:<device_id>:<toplevel>`, else no project; `projectHash` = first 16 hex characters of sha256 (`MemoryProxy/src/project-scope/project-key.ts:64-84`). `SessionWorkspaceStore` keeps the last report per session under the TTL session directory (`project-scope/session-workspace.ts:1-60`).
- Per request. `withSessionProject` adds `projectKey/projectHash` to the TDAI identity (`session-workspace.ts:81-100`); the Anthropic runner uses it for L0 and passes `projectHash` into injection (`anthropic.ts:961-997`). `getProjectHash` accepts only 16 lowercase hex characters (`tdai/identity.ts:46-56`). The OpenAI-chat runner and the mem-command stage also call it; the Codex runner does not, so Codex sessions are always "no project".
- L0 has `project_key` and `project_hash` columns with index `idx_l0_project_hash` (production schema). L1 uses `resolveUnanimousProject`: a memory gets a project only when every source agrees (`MemoryCore/src/core/record/l1-project.ts:30-39`).
- The skill path has none of this. The best attach point is the proxy call to `conversation/add`: `tdaiIdentity` is already in scope at `anthropic.ts:1624`.
- Mixed projects are real. In production, session `9c8ad33a` carries three project values in L0: none, `git:github.com/kevinle128/agent-memory`, and `local:<device>:…/vtc/operator-master`. Because one task covers a buffer slice of one session, a slice can still span two projects when the working directory changes inside the session.

## 3. Production data (read-only, 2026-10-24 03:07 ICT)

### 3.1 Counts

- `skills`: 279 rows, 130 active heads, all in team `team-f0bzqawutx`.
- Heads per agent: `agt-f0bzvpye01` 71, `agt-i7922llw41` 20, `agt-i8pj7ahk70` 12, `agt-i8q4sj15ay` 10, `agt-i8ntpqq1fp` 7, `agt-i8qeikc0ee` 7, `agt-i8r9zas515` 3.
- 18 heads are provisioned templates (`api-docs`, `code-review`, `unit-test` for six agents, `task_id='default'`, created 2026-10-21 14:26-14:37 ICT). 112 heads are extracted.
- L0 has 3352 rows. Project keys appear only from 2026-10-23 15:43 ICT (hook rollout) and only for `agt-f0bzvpye01`: 8 distinct project hashes. All other agents have no L0 row with a project.

### 3.2 Source sessions and projects

Skill buffer sessions mapped to L0 `project_key` by `session_id` (exact join, indexed):

| Agent | Sessions | Single project | No project | Mixed | No L0 |
|---|---|---|---|---|---|
| agt-f0bzvpye01 | 73 | 14 | 50 | 3 | 6 |
| six other agents | 32 | 0 | 32 | 0 | 0 |

Task-to-session mapping for the 71 heads of `agt-f0bzvpye01` is an estimate. Method: match each `task_id` to the latest archive file `data-<ts>.jsonl` of the agent that is at most 15 minutes before the first row of that task; this assumes the per-agent worker runs tasks in order. 26 of 129 tasks have no match (old archives were removed). Failure mode: queued archives can be attributed to the wrong session; for example `video-sentences-*` maps to an agent-memory session, which is probably wrong. Do not treat this as proof of source.

Estimated classification of the 71 heads:

- Single provable project (7): `creator-studio-project-architecture` (studio-plugin), `gbrain-skillpack-project-install` and `gbrain-team-vault-sync` (phat-second-brain), `goal-warmup-contract-gated`, `paseo-local-web-build-qa`, `paseo-react-virtualizer-duplicate-key-crash` (kevinle128/paseo), `paseo-plugin-sdk-unblock` (local paseo-computer-use).
- Mixed sources across versions or sessions (36), for example `agent-memory-production-noise-cleanup` (versions estimated from a paseo-computer-use session and an agent-memory session) and `paseo-orca-computer-use-port-recon` (three projects). This estimate is consistent with cross-project patching. The proof of the path itself is structural: the extractor tools use agent-wide ids (`skill-tools.ts:55-61`) and the prompt lists the whole library first (`skill-review-prompt.ts:181`).
- No project in source (15), for example `memorycore-team-memory-sharing`, `tea-tabs-overflow-arrows`, `mermaid-report-browser-validation`, `no-advisor-tool`.
- No match (13), for example `deploy-weknora`, `deploy-agent-memory` (partly), `obs-webcam-lut-selection`.

By content, most skills are clearly project-bound (`aca-*` = 3q-game-api, `paseo-*`, `agent-memory-*`, `memorycore-*`, `english-translate-*`, `video-sentences-*`, `unity-*`, `blr-client-*`). About 20 are tool- or method-generic (`mermaid-report-browser-validation`, `greenscreen-keying-source-workflow`, `claude-code-hooks-reference-check`, `no-advisor-tool`, `api-docs`, `code-review`, `unit-test`). Under the user decision, these generic ones can become global only by a user action.

Upstream fork and submodule issue: `git:github.com/getpaseo/paseo` and `git:github.com/kevinle128/paseo` are different project keys for one code base, and `agent-memory` is a submodule of the `operator-master` local project. Project identity follows the git remote, not the product.

## 4. UI (MemoryPanel, served by the Hub container)

- The Hub image contains MemoryPanel server, MemoryPanel web and MemoryKnowledge (`deploy/compose/Hub.Dockerfile:21-40`).
- Skills UI: `MemoryPanel/web/src/pages/SkillsPage/index.tsx`, `components/SkillsPanel.tsx:49-347` (team vs fixed tabs, version tag, visibility toggle at `:206-282`, header `AssetPageHeader` at `:95-172`), `components/SkillDetailPane.tsx`, `components/ImportSkillDialog.tsx`.
- Data: `assetsApi.listAccessible` (team tab), `listSkills` with `owner_agent_id` (fixed tab), `assetsApi.list` for visibility (`hooks/useSkillsPanel.ts:168-240`). `SkillSummary` fields: `skill_id, name, description, version, is_head, status, owner_user_id, owner_agent_id, team_id, task_id, created_at_ms, updated_at_ms, metadata` (`web/src/lib/api/skill-api.ts:41-55`).
- There is no persona or scene page (`web/src/routes/index.tsx:21-38`), and no UI shows a project today.
- Project label source: there is no registry. `SessionWorkspace.projectLabel` is per session and expires with the session. The only durable source is distinct `l0_conversations.project_key`. Label rule from `project-key.ts:70-75`: `git:` keys use `host/path`; `local:` keys use the last path segment. Do not show the device id; show the full local path only to its owner.

Changes for "Global" / "Project <label>" and a filter:

1. Core: return `scope, project_hash, project_label, origin` in skill list/get/search; add a project list endpoint (distinct L0 project keys for the team, label derived, device id removed).
2. Panel web types: `SkillSummary` and `Asset` (`web/src/lib/api/types.ts:84-104`).
3. `SkillsPanel.tsx`: badge beside the visibility tag; project filter in `AssetPageHeader`; "Unassigned" badge for quarantined skills.
4. `useSkillsPanel.ts`: filter state and request parameters.
5. `ImportSkillDialog.tsx`: scope choice (Global / Project from the list) for manual create; required project for session import.
6. Detail pane: "Move to project" and "Make global" actions (manual only, see open questions).

## 5. Design

### 5.1 Extraction gate (decided: no project, no skill; gate in Core at extraction time)

The user decided that the gate is in Core, when the worker processes a buffered conversation. Buffering continues as today.

- What the buffer must carry. The proxy sends optional `project_key` and `project_hash` with each `conversation/add` round. Add them to `ConversationAddInput` (`skill/core-client.ts:133-137`) and `TriggerInput` (`skill/handler-glue.ts:46-71`), and fill them from `tdaiIdentity` at the call sites (`anthropic.ts:961-972,1624`; also `anthropic.ts:2022`, `stages/archive.ts:154`, `stages/mem-command-intercept.ts:193`). Core accepts them in `conversationAddRequestSchema` (`gateway/skill-schemas.ts:273-280`), validates the hash format (16 lowercase hex characters, like `tdai/identity.ts:46-56`), and writes them on each round line of `data-current.jsonl`. A round without a project is written with empty fields.
- Optional buffer cut. When a round arrives with a different hash than the previous round, Core archives the current buffer before it appends the new round. Each task then has one project, and a session that moves between projects loses no extraction. This is a recommendation, not a gate; without it, mixed slices are skipped by the rule below.
- Gate in the worker. Before the LLM call, `extract-worker.ts` resolves the project of the archived slice with the same rule as `resolveUnanimousProject` (`MemoryCore/src/core/record/l1-project.ts:30-39`): every round must have the same non-empty hash. Fallback for rounds without tags (buffers written before the proxy change): read distinct `project_key/project_hash` from `l0_conversations` for the `session_id` in the slice time window (index `idx_l0_session_id`; L0 `session_id` equals the skill buffer session directory name, confirmed by the production join in section 3.2). The fallback must also be unanimous.
- No single project. The worker writes no skill, makes no LLM call, removes the task from `_tasks.json` with reason `no_project` or `mixed_project` (log and counter), and leaves the archive file to the normal buffer retention. The buffer is not extracted later, also not when the user installs the hook afterwards.
- Single project. The worker passes `project_key/project_hash` to `SkillExtractor` and `skill-tools.ts`; every create writes `scope='project'` with that hash (section 5.2).
- Manual paths: Panel session import (`extractSkills` → `handleExtract`, `skill-handlers.ts:1030`) and the model's `skill_extract` (force-archive) go through the same worker gate. The Panel import must ask the user for a project, because an uploaded file has no hook report.
- Trade-off of the gate location: Core keeps receiving and storing buffer rounds for `~/Movies`-type sessions (the same load as today), but saves every LLM extraction call for them. The gate has one implementation for all clients.
- Consequence: for six of seven agents no L0 row has a project, so their automatic skill extraction stops until their users install the hook. Codex, pi, hermes and openclaw sessions also stop extracting (no project join, ADR 0002 lines 52-55, 70-72).

### 5.2 Storage

New fields on every skill version row: `scope` (`global` | `project` | `unassigned`), `project_key`, `project_hash` (empty for global), `origin` (`extracted` | `manual` | `template`). Invariant enforced in `SkillCore.create/update` (not only in the prompt): `origin='extracted'` implies `scope='project'` with a non-empty hash; the extractor cannot set scope. Store the label derived from the key at read time, not as a column.

- SQLite (production): `ALTER TABLE skills ADD COLUMN` × 4 with defaults, plus index `(team_id, owner_agent_id, is_head, status, scope, project_hash)`. Filter FTS hits by a join on `skills` instead of new FTS columns, because FTS5 tables cannot add columns without a rebuild. 279 rows: the change takes milliseconds, but run it at Core start under the existing idempotent DDL pattern, with a backup of `vectors.db` first.
- MongoDB: add fields and a compound index; no rewrite.
- TCVDB: adding a filterable field may need an index change on `{database}_skills`. This is not verified in this research.
- `meta_assets`: keep `source_type` in step with `origin`; stop hardcoding `"extracted"` in `ensureSkillAsset`.
- Name uniqueness: keep `(team_id, owner_agent_id, name)`. When an extractor create hits a name that exists in another scope (hidden from it), return a distinct error code and tell the extractor to use a project-prefixed name. Most extracted names already carry a project prefix (`paseo-`, `aca-`, `unity-`).

### 5.3 Extractor scope

- Pass the task's `project_hash` into `SkillExtractor` and `skill-tools.ts`. `skill_list/search/view` return same-project skills plus global skills read-only. `skill_update/patch/files_write` succeed only on skills with the same project hash and `origin='extracted'`.
- Prompt: no global-vs-project judgment. Add one English paragraph with the one-task directive rule, aligned with `l1-extraction.ts:63`: "Do not capture instructions that apply only to one task, including task briefs that a lead or agent gives to another agent: scope limits (read-only, do not edit, commit or push), allowed or forbidden file lists, output format or length, report file paths, status-line formats, one-task acceptance lists and test-count baselines. Capture them only when the transcript states them as a standing rule ('always', 'from now on', repository or team convention) or shows that the project repeats them." Add a prompt test like `extraction-prompts.test.ts`.

### 5.4 Injection and tools

- Rule: inject, list, search and load only `scope='global'` plus `scope='project' AND project_hash = <verified session hash>`. No project known: global only. `unassigned`: never injected; visible in the UI and to the owner through the Panel only.
- Core enforces the filter (`listing`, `list`, `search`, `get`, `get-by-name`, `files/read`) from a `project_hash` parameter; the proxy never filters by itself only. The skill bridge reads the hash from `SessionWorkspaceStore` for the session (same source as `withSessionProject`). The store key is `(spaceId, userId, agentSource, sessionId)` (`session-workspace.ts:35-40`); verify during implementation that the bridge identity resolution (`skill-bridge.ts:238-337`) can build this key, including `agentSource`.
- Cache: give `SkillInjector` and `SkillToolsInjector` a `cacheVariantFor(custom)` keyed by `getProjectHash(custom)`, the same pattern as `tdai-profile-memory-injector.ts:54,63-65,339`. Prewarm (no project yet) renders the global-only block; the first request after the hook report misses the cache and renders global + project.
- Team sharing: the same rule applies to team-visible skills of other agents. `git:` keys match across users; `local:` keys contain the device id and never match another user.

### 5.5 Backfill of existing skills

- Default: set all 112 extracted heads (and all their versions) to `scope='unassigned'`, `origin='extracted'`; set the 18 templates to `origin='template'` and leave their scope to the user decision below. Show a suggested project in the UI from the estimate in section 3.2 and from L0, but require a user click to apply it.
- Run as a separate script with a backup, a dry-run list and small batches; do not run it inside a request handler.

## 6. Risks

- Core load on the auth path: listing already runs once per session; the project variant adds at most one listing per project change. The new filter must use the new index. Keep the backfill offline and batched. Because the gate is at extraction time, buffer writes for no-project sessions continue at today's rate; the L0 fallback lookup in the worker must stay on `idx_l0_session_id` with a time window and must run in the worker, not in a request handler.
- Cache invalidation: the fixed key `skill-injector:catalog` would serve a pre-hook block for the whole session; the cache variant must change in the same release as the filter. Old cached blocks expire with the session TTL; bump the variant name to drop them at once.
- Migration: SQLite is cheap; TCVDB index behaviour is unverified; FTS5 cannot add columns.
- Version skew: production already runs mixed revisions (`agent-memory/hub:e2636c3` with `core` and `proxy` at `2ba14ac`). Deploy Core first (accepts optional fields, defaults rows to `unassigned`), then the proxy, then the Hub. A new proxy against an old Core that returns no `scope` must treat the skill as not injectable (fail closed). An old proxy against a new Core gets only global skills if Core filters by default when no hash is given. An old Hub shows skills without badges.
- Coverage loss: extraction stops for agents and clients without a hook report; injection drops to global-only until users assign the quarantined skills.
- Project identity granularity: forks and submodules split one product into several project keys.
- Mapping evidence: task-to-session data is lost after processing; store `project_hash` and `source_session_id` on each version from now on.

## Recommended design

1. The proxy sends the hook-reported `project_key/project_hash` with every `conversation/add` round; Core stores them on each buffered round. Buffering continues for all sessions.
2. The Core worker gates at extraction time: it extracts only when all rounds of the slice (or, for untagged old buffers, the L0 rows of the session) agree on one verified project; otherwise it drops the task without an LLM call. Core also cuts the buffer on a project change, so mixed sessions still produce single-project tasks.
3. Skills get `scope`, `project_key`, `project_hash`, `origin`, plus `source_session_id` in each version; Core enforces "extracted implies project".
4. Extractor sees same-project skills (global read-only) and writes only same-project extracted skills; prompt gets the one-task directive rule, no scope judgment.
5. Core filters listing, search and load to global + current project; the proxy keys the injector cache by project hash.
6. Existing extracted skills become `unassigned` with a suggested project; users assign, promote or delete them in the Panel.
7. Panel shows Global / Project <label> / Unassigned badges, a project filter, and a scope choice in the create dialog; Core provides a project list from L0.

## Status

Status: DONE_WITH_CONCERNS

Summary: Skills have no project dimension today, and the proxy injects a BM25-selected subset of each agent's skills from all projects into every session. The proxy already holds the verified hook project for each request, so the extraction gate and the injection filter can both use that one source. In production, 112 of 130 active skills are extracted, and an estimate finds only 7 with one provable source project; 36 already mix projects through the agent-wide extractor inventory. Six of seven agents have no project data at all, so the decided "no project, no skill" rule stops their extraction until their users install the hook. The recommended design adds four skill fields, project tags on buffered rounds, an extraction-time gate and a project cut in the Core buffer, project-limited extractor tools, a project-keyed injector cache and a quarantine backfill with user assignment.

Concerns: the task-to-session mapping is a timestamp estimate; TCVDB migration cost is unverified.

## Open questions for the user

1. Existing extracted skills without one provable project (105 of 112; 7 have a likely single project). Options: (A) quarantine as `unassigned`, not injected, user assigns in the Panel with a suggested project; (B) delete them; (C) auto-assign the 7 likely ones and quarantine the rest. Recommendation: A, because it loses nothing and never injects a wrong project; C only after you review the 7.
2. May a user promote an extracted skill to global? Options: (A) yes, by an explicit Panel action that sets `origin='manual'` and stops further extractor edits; (B) no, the user must create a new manual global skill and copy the content; (C) defer. Recommendation: A, because about 20 current skills are tool-generic and copying is error-prone.
3. Scope of the 18 template skills (`api-docs`, `code-review`, `unit-test` for each agent). Options: (A) mark them `origin='template', scope='global'`; (B) treat them like extracted skills and quarantine them; (C) delete them. Recommendation: A, because a user-level provisioning step created them, not extraction.
4. Agents and clients without a hook report (six agents today, plus Codex, pi, hermes, openclaw). Under the decided rule they extract nothing. Options: (A) accept and ask those users to install the hook; (B) also fix the Codex runner to call `withSessionProject` in the same change; (C) defer the gate for them. Recommendation: A plus B, because B is a small runner change and keeps Codex users productive.
5. Forks and submodules (`getpaseo/paseo` vs `kevinle128/paseo`; `agent-memory` inside `operator-master`). Options: (A) keep one project per git remote; (B) let a user link several project keys to one project in the Panel; (C) defer. Recommendation: A now, B later if users ask, because B needs a registry.
6. Should a global skill be visible to the extractor? Options: (A) read-only, to avoid near-duplicate project skills; (B) hidden, so no global content enters extraction context. Recommendation: A, because writes stay blocked either way.

## Appendix A: active head skills (team-f0bzqawutx, 130 rows)

Columns: agent (`agt-` prefix removed), skill id, version, extraction task id (`default` = provisioned template), creation time of the head version in ICT, name, first 80 characters of the description. Source sessions are not stored on skill rows.

| Agent | Skill id | Ver | Task id | Created (ICT) | Name | Description (80 chars) |
|---|---|---|---|---|---|---|
| f0bzvpye01 | skl-o6CXlQFzlS8C | v1 | 2cd0e78e | 2026-10-23 16:49 | agent-desktop-readme-assessment | Summarize Agent Desktop capabilities and integration boundaries from supplied RE |
| f0bzvpye01 | skl-9ef79opNdp6Z | v3 | 1a4d698d | 2026-10-23 14:44 | agent-memory-approved-upstream-merges | Execute approved batches of upstream Agent-Memory PR merges with package baselin |
| f0bzvpye01 | skl-S4tHZPsro0Dm | v1 | c72a80a0 | 2026-10-23 14:53 | agent-memory-client-installer-audit | Audit Agent-Memory client setup scripts, credential locations and hook-installat |
| f0bzvpye01 | skl-R99PPmeb5PEU | v2 | d4667996 | 2026-10-23 15:07 | agent-memory-local-oauth-startup | Bật stack Agent-Memory ở local để đăng nhập Subscription Pool bằng OAuth, giữ ng |
| f0bzvpye01 | skl-vRIGA3AKYR5k | v3 | 7f2baa28 | 2026-10-24 00:23 | agent-memory-production-noise-cleanup | Lập danh sách dry-run và dọn dữ liệu nhiễu trong Agent-Memory production theo từ |
| f0bzvpye01 | skl-ZChrXMSG6wqr | v6 | 055c91c9 | 2026-10-23 15:16 | agent-memory-subscription-pool-audit | Map Agent-Memory subscription account storage, OAuth usage adapters, Core timers |
| f0bzvpye01 | skl-R8gznyeHYCBU | v1 | 579d0b17 | 2026-10-23 14:06 | agent-memory-team-code-pool | Giải thích và kiểm tra luồng Team Code Pool, Register Repo và Allocate trong Age |
| f0bzvpye01 | skl-7fjx2exDzcdX | v2 | aca35c59 | 2026-10-23 14:34 | agent-memory-upstream-pr-triage | Rà soát hàng loạt PR upstream cho fork Agent-Memory, phân loại xung đột không ch |
| f0bzvpye01 | skl-kiXl9ucivDeg | v2 | 59c7840f | 2026-10-23 14:19 | apple-billing-email-investigation | Kiểm tra khoản thanh toán Apple không rõ dịch vụ hoặc số tiền bằng Gmail và lịch |
| f0bzvpye01 | skl-uNWrE36g5TAt | v1 | 4b5894bc | 2026-10-23 14:17 | capcut-background-removal-evidence | Assess CapCut background-removal pricing, platform limits and transparent export |
| f0bzvpye01 | skl-lARUgr6QJuRT | v3 | fc401bc0 | 2026-10-23 15:00 | claude-code-hooks-reference-check | Answer Claude Code hook lifecycle, stdin schema, settings reload and failure-pol |
| f0bzvpye01 | skl-ViKyX8Zbsrl7 | v1 | fe8976f7 | 2026-10-23 15:18 | claude-framework-reversible-removal | Gỡ framework khỏi cấu hình Claude bằng kiểm kê manifest, kiểm tra tham chiếu và  |
| f0bzvpye01 | skl-HMbwSeGZB5jn | v1 | f3c477b5 | 2026-10-23 14:54 | codex-hooks-source-check | Check Codex lifecycle-hook configuration and shell-tool schemas against supplied |
| f0bzvpye01 | skl-HLJxcp5CXfwI | v3 | cb3a5e82 | 2026-10-23 16:57 | computer-use-api-reference-check | Extract version-sensitive computer-use API contracts from supplied documentation |
| f0bzvpye01 | skl-otWkjUNKY0Tv | v4 | 656a8384 | 2026-10-23 14:46 | content-engine-video-short-migration-audit | Audit migration of HyperFrames video-short workflows into content-engine's Remot |
| f0bzvpye01 | skl-215s1P58jJ20 | v1 | 33e84caf | 2026-10-24 01:45 | creator-studio-project-architecture | 解释 Creator Studio Claude 插件项目的仓库结构、视频与轮播工作流、运行时状态隔离、发布集成和 CI；适用于阅读该项目源码或向非技术用户说明 |
| f0bzvpye01 | skl-R9QstMVS93k8 | v1 | 3da895a0 | 2026-10-23 16:50 | cua-readme-assessment | Assess trycua/cua components, migration paths, licensing and desktop automation  |
| f0bzvpye01 | skl-cgTGEKHHWQwo | v3 | 4ab02287 | 2026-10-24 02:27 | deploy-agent-memory | Deploy hoặc rollback Agent-Memory trên server VTC bằng Docker Compose, bảo toàn  |
| f0bzvpye01 | skl-0dzs1nZaeW5z | v3 | 99329f07 | 2026-10-23 15:18 | deploy-weknora | Commit, push và deploy WeKnora lên server VTC bằng Docker Compose, bảo toàn cấu  |
| f0bzvpye01 | skl-slJghb7O2v9T | v1 | 982267c3 | 2026-10-23 14:59 | dsh-hooks-bridge-source-check | Verify DeepSeek Harness hook bridges, plugin registration and event semantics ag |
| f0bzvpye01 | skl-qUulYFi2BUfB | v1 | 51fda691 | 2026-10-23 16:07 | english-translate-host-permission-context | Bối cảnh quyền công cụ của native host english-translate, lựa chọn người dùng và |
| f0bzvpye01 | skl-SO6ZBARr1FTa | v5 | 9c26474b | 2026-10-23 16:47 | english-translate-transcript-word-lookup | Bối cảnh triển khai và quy trình kiểm chứng tra nghĩa từ theo câu trong transcri |
| f0bzvpye01 | skl-mPQzMvcHbYHs | v7 | 51fda691 | 2026-10-23 16:06 | english-translate-youtube-cc-sync | Bối cảnh code và các điểm cần làm rõ khi dùng nút CC của YouTube để điều khiển t |
| f0bzvpye01 | skl-7svoX4HQ2LjW | v1 | 07e1b13a | 2026-10-24 02:09 | gbrain-skillpack-project-install | Chọn và cài bộ skill gbrain vào project hoặc Claude Code mà không làm rối skill  |
| f0bzvpye01 | skl-5aleKORbPQEV | v2 | b1d2cc48 | 2026-10-24 02:21 | gbrain-team-vault-sync | Thiết lập và vận hành vault Markdown dùng chung với gbrain, GitHub và một chat g |
| f0bzvpye01 | skl-xcfTAPZ2jsWm | v1 | a34b9c38 | 2026-10-24 02:33 | goal-warmup-contract-gated | Chuẩn bị một goal chạy dài theo quy trình có phê duyệt hai bước, preflight và gó |
| f0bzvpye01 | skl-B3WwWKodNGz5 | v3 | 4b5894bc | 2026-10-23 14:17 | greenscreen-keying-source-workflow | Research uneven-greenscreen keying in Nuke and verify FFmpeg keying filter docum |
| f0bzvpye01 | skl-3rH52w6gjywu | v10 | a9051a1b | 2026-10-23 17:01 | jev-systemone-source-check | Extract Jev / TypeSafe System One API and computer-use architecture from supplie |
| f0bzvpye01 | skl-LBlRRUcIXVSu | v4 | 121a3235 | 2026-10-23 16:53 | macos-ax-mcp-discovery | Find and verify open-source macOS computer-use MCP servers with AXUIElement supp |
| f0bzvpye01 | skl-WSqDPFMowisq | v4 | 90ca8a0b | 2026-10-23 23:35 | macos-virtual-pointer-background-input | Nghiên cứu và spike virtual pointer trên macOS, định tuyến click/phím vào cửa sổ |
| f0bzvpye01 | skl-SEwfzWINjPrb | v3 | a01d8696 | 2026-10-23 21:46 | memorycore-chat-code-prompt-modes | Giải thích và kiểm tra hai chế độ promptMode chat/code trong MemoryCore, từ cấu  |
| f0bzvpye01 | skl-pdk5o0zAJT4q | v6 | 1a4d698d | 2026-10-23 14:44 | memorycore-l1-cursor-retry-audit | Audit MemoryCore L1 cursor loss and design restart-safe partial-batch retries us |
| f0bzvpye01 | skl-N9YmPiVEVrFl | v4 | dbd9c7c4 | 2026-10-24 02:05 | memorycore-project-scope-audit | Map project-key propagation across MemoryCore L0–L3, profile storage, Proxy inje |
| f0bzvpye01 | skl-8cS6OlrbD4S5 | v1 | 584cee40 | 2026-10-23 14:07 | memorycore-team-memory-sharing | Explain and audit Agent-Memory team memory sharing, layer isolation, asset bindi |
| f0bzvpye01 | skl-0gVb614W37Sf | v1 | 9712f3b7 | 2026-10-23 14:09 | memoryknowledge-repository-sharing | Trace Agent-Memory repository and wiki lifecycles, instance scoping, Panel callb |
| f0bzvpye01 | skl-EmvlMGhEZk7O | v1 | 1cb7e4b0 | 2026-10-23 14:05 | memorypanel-default-agent-provisioning | 排查 Agent-Memory 中新成员默认 Agent、模板资产与自动生成的三个预置 Skill 的来源。 |
| f0bzvpye01 | skl-7CMVBXgwNuhi | v2 | 00d5276d | 2026-10-23 14:39 | memoryproxy-admin-auth-audit | Audit MemoryProxy admin-route protection, upstream auth hunks, caller compatibil |
| f0bzvpye01 | skl-6TTlC6wwzALr | v7 | e1b93446 | 2026-10-23 21:58 | memoryproxy-team-request-path | Trace Agent-Memory coding-agent requests through MemoryProxy authentication, ses |
| f0bzvpye01 | skl-tC38zB0rxuNq | v1 | f19830a0 | 2026-10-23 14:11 | mermaid-report-browser-validation | Validate Mermaid diagrams in Markdown reports, recover from a missing Puppeteer  |
| f0bzvpye01 | skl-tSamDIu0kRb4 | v1 | f12525b6 | 2026-10-23 14:37 | no-advisor-tool | Respect the user's standing prohibition on consulting the advisor tool. |
| f0bzvpye01 | skl-qd7wol4qChm9 | v6 | 0cd584e0 | 2026-10-23 15:14 | obs-webcam-lut-selection | Chọn LUT phù hợp tín hiệu webcam và thiết lập Apply LUT trong OBS, kiểm tra meta |
| f0bzvpye01 | skl-6Obp2fbU1F8R | v3 | fc401bc0 | 2026-10-23 15:00 | opencode-plugin-tools-reference-check | Extract OpenCode plugin loading, lifecycle events, hook payloads and tool permis |
| f0bzvpye01 | skl-GxB2ljyQnaZL | v1 | b6a37a3b | 2026-10-23 16:58 | orca-computer-agent-surface-audit | Audit Orca's computer-use CLI, runtime RPC, agent guide and onboarding from pinn |
| f0bzvpye01 | skl-2y6YfdnFawEI | v3 | 0a18031f | 2026-10-23 15:11 | orca-computer-focus-safe-navigation | Điều khiển cửa sổ bằng Orca an toàn khi cây accessibility rỗng, nhiều cửa sổ trì |
| f0bzvpye01 | skl-K8IcwemFv2VF | v1 | 11ed3dff | 2026-10-23 17:00 | orca-computer-native-source-audit | Audit Orca's native computer-use providers, process protocols, TCC identity, inp |
| f0bzvpye01 | skl-mCiD0ui5nsvU | v5 | 411b3338 | 2026-10-23 21:13 | paseo-codex-elicitation-persistence | Implement and verify Codex MCP elicitation session/always persistence choices in |
| f0bzvpye01 | skl-E7FRVnoEc4BQ | v4 | e831fd6c | 2026-10-24 02:21 | paseo-computer-use-build-review | Kiểm tra build, test và review an toàn một plugin computer-use của Paseo gồm Typ |
| f0bzvpye01 | skl-crLRdjW5xCwN | v1 | ef933903 | 2026-10-23 17:02 | paseo-computer-use-integration-audit | Map Paseo desktop automation integration points through core tools, provider MCP |
| f0bzvpye01 | skl-xJaUbsIygsxQ | v2 | 411b3338 | 2026-10-23 21:13 | paseo-isolated-desktop-qa | Chạy QA Paseo Electron trong worktree với daemon, dữ liệu và profile riêng, trán |
| f0bzvpye01 | skl-AwX0nEh4B0AU | v1 | e7fce027 | 2026-10-24 01:50 | paseo-local-web-build-qa | 在 Paseo worktree 中启动本地 Expo/Metro Web 构建并验证桌面 Web 行为，正确隔离 daemon、检查 WebSocket/CO |
| f0bzvpye01 | skl-I819kAUkwx88 | v3 | c5bddddb | 2026-10-23 18:36 | paseo-macos-apple-events-packaging-fix | Sửa và kiểm chứng cấu hình Apple Events của ứng dụng Paseo macOS, với regression |
| f0bzvpye01 | skl-MdlYbZKOsb2m | v1 | 9af6ccff | 2026-10-23 21:53 | paseo-mcp-spike-runtime-diagnostics | Run a minimal Paseo MCP spike to verify tool routing, image return handling, mac |
| f0bzvpye01 | skl-x6zsR8EMjiKw | v9 | e831fd6c | 2026-10-24 02:20 | paseo-orca-computer-use-port-recon | Khảo sát và lập kế hoạch port computer use từ Orca sang Paseo, phân tách native  |
| f0bzvpye01 | skl-iqxz0UDO76sO | v1 | 9f0f02e6 | 2026-10-23 17:59 | paseo-parallel-upstream-agents | Tạo các panel agent Paseo để sửa nhiều bug upstream song song trong worktree riê |
| f0bzvpye01 | skl-QHFoEFySPL0X | v2 | ec24e6b6 | 2026-10-24 03:07 | paseo-plugin-sdk-unblock | Unblock a Paseo TypeScript computer-use plugin when SDK settings APIs, agent.cre |
| f0bzvpye01 | skl-qIqVJHf1BqoX | v1 | 7a4c2bf0 | 2026-10-23 22:10 | paseo-react-virtualizer-duplicate-key-crash | Chẩn đoán và sửa lỗi React |
| f0bzvpye01 | skl-qIXKY8csjOvQ | v1 | f383bce3 | 2026-10-23 21:27 | paseo-upstream-pr-fork-merge | Đưa các branch fix Paseo lên fork, mở PR vào upstream và đồng bộ rồi merge các f |
| f0bzvpye01 | skl-TPSL9s5HhyHv | v1 | 982267c3 | 2026-10-23 14:59 | pi-extensions-reference-check | Assess Pi coding-agent extension events, tools, UI capabilities and config paths |
| f0bzvpye01 | skl-Qp0NYZmtThIw | v1 | 4ab02287 | 2026-10-24 02:27 | project-scoped-skill-injection-audit | Kiểm tra và ngăn skill-injector đưa tên, mô tả hoặc nội dung skill của dự án này |
| f0bzvpye01 | skl-TkA7Z8qv2EvJ | v1 | cbb5973f | 2026-10-23 22:21 | rea-ghidra-setup-safe-research | Thiết lập REA và Ghidra có kiểm chứng để nghiên cứu binary macOS, đồng thời giữ  |
| f0bzvpye01 | skl-OSsfysuT1FDo | v1 | fe8976f7 | 2026-10-23 15:17 | repo-documentation-skill-selection | Chọn công cụ đọc repository để tạo tài liệu dựa trên skill đã cài, phân biệt sin |
| f0bzvpye01 | skl-ShEKcpgcs1vh | v1 | 1cb7e4b0 | 2026-10-23 14:05 | tea-tabs-overflow-arrows | 排查 tea-component Tabs 中覆盖标签文字的左右滚动箭头，并在固定少量标签场景使用组件属性修复。 |
| f0bzvpye01 | skl-ZydD5QOeXEfH | v4 | 4b5894bc | 2026-10-23 14:17 | video-matting-readme-assessment | Assess video-matting repositories from supplied README content, covering licensi |
| f0bzvpye01 | skl-s10BBIRTrvCm | v1 | 4bd8e9f0 | 2026-10-23 15:02 | video-sentences-fast-transcript | Bối cảnh và ràng buộc kỹ thuật cho transcript nhanh sau khi kết thúc tape trong  |
| f0bzvpye01 | skl-bC5Bm1fk6xzW | v1 | 760d1fc0 | 2026-10-23 14:43 | video-sentences-real-stack-verification | Kiểm chứng tính năng video-sentences trên stack thật bằng Playwright, cô lập dữ  |
| f0bzvpye01 | skl-wVyICk7UsB6d | v2 | 760d1fc0 | 2026-10-23 14:42 | video-sentences-row-fix-dialog | Chuyển thao tác sửa câu của video-sentences sang popup trên từng row, bảo toàn t |
| f0bzvpye01 | skl-Ztq2REZ01QvC | v1 | 760d1fc0 | 2026-10-23 14:42 | video-sentences-space-tape-transitions | Chẩn đoán video pause nhưng tape không record trong Practice bằng cách tách SPAC |
| f0bzvpye01 | skl-0FD3QA1KSafK | v2 | 99329f07 | 2026-10-23 15:18 | weknora-hadong-pdf-source-locators | Chẩn đoán trích dẫn PDF không định vị được trong WeKnora và tạo locator theo tra |
| f0bzvpye01 | skl-irx6SXTTRWIJ | v4 | 9615383f | 2026-10-23 16:56 | windows-linux-accessibility-mcp-discovery | Find Windows UI Automation and Linux AT-SPI computer-use MCP servers, verifying  |
| f0bzvpye01 | skl-F8C1KVxTDXSV | v2 | 4bd8e9f0 | 2026-10-23 15:01 | wisprflow-sdk-static-integration | Đánh giá tích hợp Wispr Flow bằng SDK không chính thức và phân tích tĩnh app.asa |
| f0bzvpye01 | skl-QpSl0gjaqkD1 | v4 | 982267c3 | 2026-10-23 14:58 | workbuddy-codebuddy-hooks-reference-check | Verify WorkBuddy Enterprise and CodeBuddy hook paths, session/prompt payloads, c |
| i7922llw41 | skl-fYnTtQ68eKVQ | v3 | cb44346c | 2026-10-23 16:55 | aca-admin-event-creation | Thêm API admin tạo event trong 3q-game-api với thời gian bắt đầu/kết thúc và ID  |
| i7922llw41 | skl-zbZqo7k9hs30 | v1 | c94ceb87 | 2026-10-23 15:21 | aca-battle-failure-triage | Điều tra Create Battle Failed và BATTLE_ERROR trong 3q-chess bằng Graylog, đối c |
| i7922llw41 | skl-5pvlCW7AzePK | v3 | b80574e1 | 2026-10-23 15:28 | aca-consecutive-packages | Tra cứu cơ chế gói quà liên tiếp trong 3q-game-api, lần theo tạo event, thứ tự m |
| i7922llw41 | skl-7qqgYa7c983I | v3 | cb44346c | 2026-10-23 16:55 | aca-cumulative-cash-scheduler | Chống tạo trùng và căn lịch 00:00 UTC cho cả event tích tiêu lẫn tích nạp trong  |
| i7922llw41 | skl-esocjBNNGAun | v1 | 1d62aa5d | 2026-10-23 16:08 | aca-cumulative-cash-server-list | Tra cứu và mở rộng API danh sách event cumulative_cash theo server trong 3q-game |
| i7922llw41 | skl-DuykGxlzeYv8 | v2 | cb44346c | 2026-10-23 16:55 | aca-event-time-boundary-audit | Rà soát và chuẩn hóa mốc mở, hết hạn event trong 3q-game-api, phân biệt ngày lịc |
| i7922llw41 | skl-4uD9KKS6T7p7 | v1 | 095a9014 | 2026-10-23 17:00 | aca-game-init-null-gears-triage | Điều tra gears hoặc heroes bị null trong /game-init của 3q-game-api, lần theo fa |
| i7922llw41 | skl-tCtdc11q9uUm | v3 | 6c6c7392 | 2026-10-23 15:30 | aca-hero-power-battle-attributes | Kiểm tra công thức power của hero trong 3q-game-api bằng static DB thực tế và đố |
| i7922llw41 | skl-5bpLj9VJWJfC | v2 | 8916b6fb | 2026-10-23 15:24 | aca-jpa-unique-constraint-startup-triage | Điều tra lỗi khởi động JPA do UniqueConstraint không khớp tên cột trong 3q-game- |
| i7922llw41 | skl-GPypSJ9Us6Dm | v4 | 5eb32c4e | 2026-10-23 15:53 | aca-level-up-event-packs | Tra cứu hoặc nhân bản event pack lên cấp trong 3q-game-api, nối trigger qua call |
| i7922llw41 | skl-8xk376jBm70E | v2 | 1d62aa5d | 2026-10-23 16:07 | aca-notification-soft-timeout-fanout | Sửa và kiểm chứng fan-out soft-timeout của /check-notification trong 3q-game-api |
| i7922llw41 | skl-BXPbAeJZEfKL | v1 | caba284d | 2026-10-23 15:37 | aca-player-id-cluster-merge | Kiểm tra danh tính player và định tuyến cluster trong 3q-game-api, đánh giá nguy |
| i7922llw41 | skl-hbkYgYtVL288 | v5 | eb8ed699 | 2026-10-23 16:25 | aca-refund-purchase-lifecycle | Tra cứu và mở rộng Refund Purchase trong 3q-game-api: mua CASH một lần mỗi event |
| i7922llw41 | skl-H8qkoURHBQUF | v2 | ffe89c21 | 2026-10-23 15:35 | aca-server-cluster-feature-scope | Phân loại tính năng 3q-game-api theo server logic, cluster, nhóm server hoặc ngư |
| i7922llw41 | skl-52eeswF6o7LN | v1 | a2de088a | 2026-10-23 15:31 | aca-service-topology-server-sizing | Tra cứu kiến trúc liên dịch vụ 3q-chess và đề xuất cấu hình máy chủ dựa trên dep |
| i7922llw41 | skl-zuXoDSdLxgoo | v1 | 513c87d7 | 2026-10-23 15:54 | aca-staticdb-runtime-service | Thêm service tải StaticDB JSON cho gameplay trong 3q-game-api, kiểm tra mapping  |
| i7922llw41 | skl-ZVwQSigsg1Ne | v1 | b4fcb94c | 2026-10-23 15:20 | aca-ticket-cap | Tra cứu và kiểm tra giới hạn TICKET (resource = 1) trong 3q-game-api, bao gồm nh |
| i7922llw41 | skl-YosW5Si7oF4S | v1 | default | 2026-10-21 14:26 | api-docs | API 文档生成助手，根据代码中的接口定义自动生成清晰、规范的 API 文档，支持 RESTful 和 RPC 风格 |
| i7922llw41 | skl-AkdKIlWSxpe5 | v1 | default | 2026-10-21 14:26 | code-review | 代码审查助手，帮助检查代码质量、潜在缺陷、安全漏洞和性能问题，提供专业的改进建议 |
| i7922llw41 | skl-FiPfWGgPoZfC | v1 | default | 2026-10-21 14:26 | unit-test | 单元测试生成助手，根据代码自动生成高质量单元测试用例，覆盖正常流程、边界条件和异常场景 |
| i8ntpqq1fp | skl-lZasMI1o1daa | v1 | default | 2026-10-21 14:34 | api-docs | API 文档生成助手，根据代码中的接口定义自动生成清晰、规范的 API 文档，支持 RESTful 和 RPC 风格 |
| i8ntpqq1fp | skl-fvZbGJFO3pjD | v3 | 8ecb9ef9 | 2026-10-23 16:22 | blr-client-localization-sheet | Xử lý text còn tiếng Trung trong blr-client, phân biệt hai hệ dịch và đồng bộ la |
| i8ntpqq1fp | skl-80KpwT0hH2ex | v11 | 0a6ecf3d | 2026-10-23 14:51 | buttonbase-json-config-bundle | Xây dựng ButtonBase dùng chung trong Cocos Creator 2.x, cấu hình JSON, xem ngay  |
| i8ntpqq1fp | skl-UJIjvPC8Xzzh | v1 | 8ecb9ef9 | 2026-10-23 16:23 | cocos-controller-prefab-rename | Đổi tên controller và prefab trong blr-client, đồng bộ thuộc tính theo node thiế |
| i8ntpqq1fp | skl-J5DKPoED8WD7 | v3 | 8ecb9ef9 | 2026-10-23 16:22 | cocos-duplicate-attribute-label-triage | Truy vết nhãn chỉ số bị lặp trong giao diện Cocos Creator, đối chiếu prefab, cấu |
| i8ntpqq1fp | skl-5R1gXMSWeWAW | v1 | default | 2026-10-21 14:34 | code-review | 代码审查助手，帮助检查代码质量、潜在缺陷、安全漏洞和性能问题，提供专业的改进建议 |
| i8ntpqq1fp | skl-FZgTVyodcNRM | v1 | default | 2026-10-21 14:34 | unit-test | 单元测试生成助手，根据代码自动生成高质量单元测试用例，覆盖正常流程、边界条件和异常场景 |
| i8pj7ahk70 | skl-x2vGqUlH33nD | v1 | default | 2026-10-21 14:35 | api-docs | API 文档生成助手，根据代码中的接口定义自动生成清晰、规范的 API 文档，支持 RESTful 和 RPC 风格 |
| i8pj7ahk70 | skl-eW0vveWXvE0S | v1 | default | 2026-10-21 14:35 | code-review | 代码审查助手，帮助检查代码质量、潜在缺陷、安全漏洞和性能问题，提供专业的改进建议 |
| i8pj7ahk70 | skl-QZfVVTzI84c2 | v1 | b6ff4136 | 2026-10-23 16:24 | github-page-fact-extraction | Extract release dates or exact directory entries from supplied GitHub page text  |
| i8pj7ahk70 | skl-OcpZnDBJ7Xnp | v1 | default | 2026-10-21 14:35 | unit-test | 单元测试生成助手，根据代码自动生成高质量单元测试用例，覆盖正常流程、边界条件和异常场景 |
| i8pj7ahk70 | skl-mqex1QiuLlGz | v2 | ce08ae94 | 2026-10-23 16:29 | unity-buff-frame-team-relic-data | Truy vết danh sách hero và buff relic trong BuffFrame/BuffInfoController, tránh  |
| i8pj7ahk70 | skl-BpYXeFhfkcmP | v1 | e3326246 | 2026-10-23 16:29 | unity-centralized-error-reporting | Thiết kế thu thập exception và gửi báo lỗi tập trung cho Unity, lựa chọn SDK hoặ |
| i8pj7ahk70 | skl-jma2Cbo98HcB | v1 | 07a67e2f | 2026-10-23 16:30 | unity-i2-localization-key-tracing | Truy vết key I2 trong bản dịch, C#, prefab và scene của Unity, phân biệt key gần |
| i8pj7ahk70 | skl-p274uFdbfIyC | v1 | 936521a7 | 2026-10-23 16:25 | unity-ios-custom-event-bridge | Kiểm tra null và dữ liệu tracking qua C#, P/Invoke và bridge Objective-C của SDK |
| i8pj7ahk70 | skl-Yh4P0ZK9YvDN | v1 | 07a67e2f | 2026-10-23 16:31 | unity-live-ui-input-triage | Chẩn đoán trực tiếp game Unity vẫn chạy animation nhưng không nhận click bằng Un |
| i8pj7ahk70 | skl-xROvS1cKNtOY | v1 | 936521a7 | 2026-10-23 16:24 | unity-payment-reward-delta | Kiểm tra và sửa popup ngọc nhận khi PaymentSuccess trong Unity, chú ý thứ tự cập |
| i8pj7ahk70 | skl-yQJB8p59iZyS | v1 | 07a67e2f | 2026-10-23 16:30 | unity-ui-click-outside-bubble | Sửa bubble Unity bị đóng khi bấm item bên trong bằng ClickOutsideHandler có sẵn, |
| i8pj7ahk70 | skl-KnO6kGPeYUPt | v1 | aafb54a2 | 2026-10-23 16:28 | unity-ui-late-api-callback | Chẩn đoán và sửa MissingReferenceException do callback API trả về sau khi UI Uni |
| i8q4sj15ay | skl-35P9v8H7ZM4V | v1 | default | 2026-10-21 14:36 | api-docs | API 文档生成助手，根据代码中的接口定义自动生成清晰、规范的 API 文档，支持 RESTful 和 RPC 风格 |
| i8q4sj15ay | skl-rgIpgcNnq1pH | v1 | default | 2026-10-21 14:36 | code-review | 代码审查助手，帮助检查代码质量、潜在缺陷、安全漏洞和性能问题，提供专业的改进建议 |
| i8q4sj15ay | skl-0Y8p32hnumks | v5 | 77d84e7c | 2026-10-23 17:17 | game-equipment-stat-comparison | Đối chiếu chỉ số trang bị và thưởng bộ MangaChess với game gốc theo phẩm, ô, loạ |
| i8q4sj15ay | skl-z4xLr1332AXu | v2 | 0e39cdec | 2026-10-23 17:07 | game-forge-config-comparison | Kiểm tra chi phí ForgeGearQualities theo từng phẩm và sao, đối chiếu CraftValues |
| i8q4sj15ay | skl-0oPX5tm99BxK | v1 | 77d84e7c | 2026-10-23 17:17 | game-live-config-log-verification | Kiểm tra game Unity đang mở bằng tiến trình, cache JSON và Player.log để đối chi |
| i8q4sj15ay | skl-gtgMgxoUrCRY | v1 | c073c7e5 | 2026-10-23 15:49 | game-localization-batch-validation | Review Vietnamese/English game localization in parallel batches while preserving |
| i8q4sj15ay | skl-2uBcOHL7PrRi | v1 | 77d84e7c | 2026-10-23 17:18 | game-preset-reward-curves | Giải thích và kiểm tra đường tăng preset quà theo league của Auto Brawl Chess, g |
| i8q4sj15ay | skl-pkposN8AJgO0 | v2 | d8d11742 | 2026-10-23 15:54 | idle-reward-config-review | So sánh các bản JSON quà treo máy PvE và mô phỏng thu nhập theo cấp Battle Pass  |
| i8q4sj15ay | skl-hcAdup1Xdw2R | v1 | c073c7e5 | 2026-10-23 15:49 | image-grounded-game-item-naming | Name game items from reference images and hero themes, then merge parallel namin |
| i8q4sj15ay | skl-5d3wUpyivbXi | v1 | default | 2026-10-21 14:36 | unit-test | 单元测试生成助手，根据代码自动生成高质量单元测试用例，覆盖正常流程、边界条件和异常场景 |
| i8qeikc0ee | skl-cYiTj0vaSBES | v1 | default | 2026-10-21 14:36 | api-docs | API 文档生成助手，根据代码中的接口定义自动生成清晰、规范的 API 文档，支持 RESTful 和 RPC 风格 |
| i8qeikc0ee | skl-H5xSvX28C9Z4 | v1 | c673f8f9 | 2026-10-23 15:52 | blender-cinematic-fight-animation | Tạo clip võ thuật nhiều góc máy bằng Blender MCP, kiểm tra keyframe và camera, x |
| i8qeikc0ee | skl-8Lo5jtwLwyDe | v1 | 845929e5 | 2026-10-23 15:37 | blender-mcp-connection-repair | Kiểm tra kết nối Blender MCP, cập nhật addon cũ và xác nhận lại sau khi Blender  |
| i8qeikc0ee | skl-ZQgLJu25x5nK | v1 | 845929e5 | 2026-10-23 15:37 | blender-procedural-building | Dựng tòa nhà đơn giản bằng bpy và bmesh qua Blender MCP, nhóm mesh theo vật liệu |
| i8qeikc0ee | skl-a5F27HS0VjvI | v2 | da0980bf | 2026-10-23 15:55 | code-review | Rà soát tính đúng đắn, an toàn, hiệu năng và khả năng bảo trì của code; có quy t |
| i8qeikc0ee | skl-emvX6imi9ST7 | v1 | default | 2026-10-21 14:36 | unit-test | 单元测试生成助手，根据代码自动生成高质量单元测试用例，覆盖正常流程、边界条件和异常场景 |
| i8qeikc0ee | skl-Cl2MsBeJOMDC | v1 | c378f3d9 | 2026-10-23 15:56 | unity-pooled-popup-countdown | Thay countdown mỗi frame bằng coroutine theo giây cho popup Unity dùng pool, xử  |
| i8r9zas515 | skl-R6Y4BBsACWRg | v1 | default | 2026-10-21 14:37 | api-docs | API 文档生成助手，根据代码中的接口定义自动生成清晰、规范的 API 文档，支持 RESTful 和 RPC 风格 |
| i8r9zas515 | skl-8NdWcrqBQcEb | v1 | default | 2026-10-21 14:37 | code-review | 代码审查助手，帮助检查代码质量、潜在缺陷、安全漏洞和性能问题，提供专业的改进建议 |
| i8r9zas515 | skl-m6iBIxuNz0Yt | v1 | default | 2026-10-21 14:37 | unit-test | 单元测试生成助手，根据代码自动生成高质量单元测试用例，覆盖正常流程、边界条件和异常场景 |

## Appendix B: estimated source projects for agt-f0bzvpye01 (estimate, not proof)

Method: section 3.2 (nearest archive of the agent at most 15 minutes before the first row of each extraction task). `|` separates the sessions of different versions; `+` joins the project values found in L0 for one session; `(none)` means L0 rows without a project; `UNMATCHED` means no archive matched. `github.com/` is removed and local paths are shortened.

| Skill | Estimated source projects |
|---|---|
| agent-desktop-readme-assessment | getpaseo/paseo+kevinle128/paseo+(none) |
| agent-memory-approved-upstream-merges | kevinle128/agent-memory+local:…/vtc/operator-master+(none) |
| agent-memory-client-installer-audit | kevinle128/agent-memory+local:…/vtc/operator-master+(none) |
| agent-memory-local-oauth-startup | UNMATCHED |
| agent-memory-production-noise-cleanup | local:…/opensources/paseo-computer-use \| kevinle128/agent-memory+local:…/vtc/operator-master+(none) |
| agent-memory-subscription-pool-audit | UNMATCHED |
| agent-memory-team-code-pool | (none) |
| agent-memory-upstream-pr-triage | (none) |
| apple-billing-email-investigation | (none) |
| capcut-background-removal-evidence | (none) |
| claude-code-hooks-reference-check | kevinle128/agent-memory+local:…/vtc/operator-master+(none) \| UNMATCHED |
| claude-framework-reversible-removal | UNMATCHED |
| codex-hooks-source-check | UNMATCHED |
| computer-use-api-reference-check | getpaseo/paseo+kevinle128/paseo+(none) |
| content-engine-video-short-migration-audit | (none) \| kevinle128/agent-memory+local:…/vtc/operator-master+(none) |
| creator-studio-project-architecture | tenfoldmarc/studio-plugin |
| cua-readme-assessment | getpaseo/paseo+kevinle128/paseo+(none) |
| deploy-agent-memory | UNMATCHED \| kevinle128/agent-memory+local:…/vtc/operator-master+(none) |
| deploy-weknora | UNMATCHED |
| dsh-hooks-bridge-source-check | UNMATCHED |
| english-translate-host-permission-context | (none) |
| english-translate-transcript-word-lookup | local:…/chrome-extension/english-translate+(none) \| getpaseo/paseo+kevinle128/paseo+(none) |
| english-translate-youtube-cc-sync | (none) |
| gbrain-skillpack-project-install | doanphatvtp96-del/phat-second-brain |
| gbrain-team-vault-sync | doanphatvtp96-del/phat-second-brain |
| goal-warmup-contract-gated | kevinle128/paseo |
| greenscreen-keying-source-workflow | (none) |
| jev-systemone-source-check | getpaseo/paseo+kevinle128/paseo+(none) |
| macos-ax-mcp-discovery | getpaseo/paseo+kevinle128/paseo+(none) |
| macos-virtual-pointer-background-input | local:…/opensources/paseo-computer-use \| kevinle128/paseo |
| memorycore-chat-code-prompt-modes | (none) \| UNMATCHED \| kevinle128/agent-memory+local:…/vtc/operator-master+(none) |
| memorycore-l1-cursor-retry-audit | (none) \| kevinle128/agent-memory+local:…/vtc/operator-master+(none) |
| memorycore-project-scope-audit | kevinle128/agent-memory+local:…/vtc/operator-master+(none) \| UNMATCHED |
| memorycore-team-memory-sharing | (none) |
| memoryknowledge-repository-sharing | (none) |
| memorypanel-default-agent-provisioning | (none) |
| memoryproxy-admin-auth-audit | (none) \| kevinle128/agent-memory+local:…/vtc/operator-master+(none) |
| memoryproxy-team-request-path | (none) \| kevinle128/agent-memory+local:…/vtc/operator-master+(none) |
| mermaid-report-browser-validation | (none) |
| no-advisor-tool | (none) |
| obs-webcam-lut-selection | UNMATCHED |
| opencode-plugin-tools-reference-check | UNMATCHED |
| orca-computer-agent-surface-audit | getpaseo/paseo+kevinle128/paseo+(none) |
| orca-computer-focus-safe-navigation | (none) \| UNMATCHED |
| orca-computer-native-source-audit | getpaseo/paseo+kevinle128/paseo+(none) |
| paseo-codex-elicitation-persistence | getpaseo/paseo+kevinle128/paseo+(none) \| kevinle128/paseo |
| paseo-computer-use-build-review | kevinle128/paseo \| doanphatvtp96-del/phat-second-brain |
| paseo-computer-use-integration-audit | getpaseo/paseo+kevinle128/paseo+(none) |
| paseo-isolated-desktop-qa | getpaseo/paseo+kevinle128/paseo+(none) |
| paseo-local-web-build-qa | kevinle128/paseo |
| paseo-macos-apple-events-packaging-fix | getpaseo/paseo+kevinle128/paseo+(none) \| kevinle128/paseo |
| paseo-mcp-spike-runtime-diagnostics | (none) |
| paseo-orca-computer-use-port-recon | getpaseo/paseo+kevinle128/paseo+(none) \| kevinle128/paseo \| doanphatvtp96-del/phat-second-brain |
| paseo-parallel-upstream-agents | getpaseo/paseo+kevinle128/paseo+(none) |
| paseo-plugin-sdk-unblock | local:…/opensources/paseo-computer-use |
| paseo-react-virtualizer-duplicate-key-crash | kevinle128/paseo |
| paseo-upstream-pr-fork-merge | getpaseo/paseo+kevinle128/paseo+(none) |
| pi-extensions-reference-check | UNMATCHED |
| project-scoped-skill-injection-audit | kevinle128/agent-memory+local:…/vtc/operator-master+(none) |
| rea-ghidra-setup-safe-research | getpaseo/paseo+kevinle128/paseo+(none) |
| repo-documentation-skill-selection | UNMATCHED |
| tea-tabs-overflow-arrows | (none) |
| video-matting-readme-assessment | (none) |
| video-sentences-fast-transcript | UNMATCHED |
| video-sentences-real-stack-verification | kevinle128/agent-memory+local:…/vtc/operator-master+(none) |
| video-sentences-row-fix-dialog | kevinle128/agent-memory+local:…/vtc/operator-master+(none) |
| video-sentences-space-tape-transitions | kevinle128/agent-memory+local:…/vtc/operator-master+(none) |
| weknora-hadong-pdf-source-locators | UNMATCHED |
| windows-linux-accessibility-mcp-discovery | getpaseo/paseo+kevinle128/paseo+(none) |
| wisprflow-sdk-static-integration | kevinle128/agent-memory+local:…/vtc/operator-master+(none) \| UNMATCHED |
| workbuddy-codebuddy-hooks-reference-check | UNMATCHED |
