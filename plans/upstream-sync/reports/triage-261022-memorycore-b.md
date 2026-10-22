# MemoryCore-B upstream PR triage

Scope: 84 PRs (68 clean, 16 conflict-upstream). Read-only review against our HEAD 3a83a59d (feat/server_team).

Relevance context verified in our tree:
- compose.yaml runs MemoryCore with `TDAI_DEPLOY_MODE: standalone`, `STORE_MODE: sqlite`, a single `TDAI_LLM_*` provider; Docker image does not run `npm run build` (MemoryCore/Dockerfile).
- The gateway uses `PipelineWorker` + `StatefulPipelineManager` in standalone too (server.ts:2046-2078).
- `MemoryCore/src/offload*` and `offload_server/compact` serve the OpenClaw context-offload plugin; MemoryProxy never calls them -> low.
- MemoryPanel edits L1 through `/v3/atomic/update` (MemoryPanel/src/panel/http/routes/chat-memory.ts:1635).
- MemoryProxy calls `/v3/meta/agent/get` and `/v3/meta/agent-fixed-asset/list-with-detail` (MemoryProxy/src/meta/client.ts:325,534; knowledge/core-client.ts:257).
- The clusters named in the task brief (#1717/#1719, #1619 vs #1528/#1293, #1583-#1585) are NOT in this input file (likely MemoryCore-A).

## Table

| # | title | +/- | status | relevance | quality | verdict | reason |
|---|---|---|---|---|---|---|---|
| 1757 | fix(memory-core): compact OpenClaw tool results without breaking call pairing | +244/-21 | clean | low | good, tests | wait | OpenClaw offload compaction only. |
| 1749 | fix(memory-core): recalculate compaction token totals after fast-path replacements | +111/-1 | clean | low | good, test | wait | OpenClaw offload compaction only. |
| 1748 | fix(memory-core): restore per-agent agentId in the OpenClaw plugin | +290/-18 | clean | low | good, tests | skip | OpenClaw client plugin; we do not run it. |
| 1710 | docs(memory-core): add the external task source guide | +139/-0 | clean | low | docs | wait | Docs only. |
| 1701 | fix(memory-core): interpret false local task judgments correctly | +42/-3 | clean | low | good, test | wait | OpenClaw offload local-LLM parser. |
| 1700 | fix(memory-core): retain concurrent session registry updates | +78/-11 | clean | low | good, test | wait | OpenClaw offload session registry. |
| 1698 | fix(memory-core): preserve strings during JSON comma repair | +53/-2 | clean | low | good, test | wait | Offload local-LLM parser only. |
| 1697 | fix(memory-core): retain outer offload response arrays | +54/-32 | clean | low | good, test | wait | Offload parsers only. |
| 1695 | fix(memory-core): share concurrent offload session initialization | +74/-2 | clean | low | good, test | wait | OpenClaw offload only. |
| 1676 | fix(tapd): paginate combined results using bounded page offsets | +162/-12 | clean | low | good, test | skip | TAPD task source not used. |
| 1634 | fix(gateway): let /v3/scenario/write create missing L2 blocks (upsert) | +209/-4 | clean | low-med | good, tests | wait | Contract alignment with the v3 doc; MemoryProxy does not expose scenario/write and Panel edits only existing blocks. |
| 1617 | feat(memory-core): record memory data-plane usage in a sidecar sqlite | +944/-2 | conflict-upstream | low | ok | skip | New usage-metrics feature, stale (conflicts in gateway/config.ts). |
| 1604 | feat(memory-core): add caller-approved atomic L1 create API | +918/-45 | conflict-upstream (CHANGELOG only) | low-med | good, contract tests | wait | Clean design for creating L1 notes; feature, not a fix; preferred over the upsert half of #1082. |
| 1603 | fix(skill): compensate a create whose asset registration failed | +274/-1 | clean | med | good, real-sqlite tests | wait | Fixes orphan skill row after meta_assets failure; rare on our sqlite setup. |
| 1600 | fix(hermes-plugin): kill the whole Gateway process tree on Windows shutdown | +133/-9 | clean | low | ok, tests | skip | Hermes + Windows; dup of #1383. |
| 1567 | fix(hermes-plugin): read agent_id from MEMORY_TENCENTDB_AGENT_ID | +126/-1 | clean | low | ok, tests | skip | Hermes only; overlaps #1121. |
| 1563 | feat(gateway): add core/delete to remove L3 persona per triplet | +198/-0 | clean | low-med | good, tests | wait | New endpoint, not a bug fix. |
| 1558 | fix(MemoryCore): replace pnpm-workspace.yaml build placeholders | +8/-8 | clean | low | fine | wait | Our pnpm-workspace.yaml has literal placeholder strings; only affects pnpm local dev (Docker uses npm). |
| 1555 | fix(build): restore seed-v2 build with placeholder fixtures | +2/-41 | clean | low | odd (deletes bin, adds empty README) | skip | Duplicate of #998 with a heavier, less clear change. |
| 1527 | fix: acl/check honors explicit grants on restricted assets | +64/-4 | clean | med | good, table test | merge-now | acl/check denied restricted assets even with an explicit grant; Panel skill-fork/knowledge flows use restricted visibility + ACL. |
| 1490 | perf(gateway): build the v3 route table once at module load | +16/-14 | clean | low | fine | wait | Micro-perf only. |
| 1489 | chore(v2-router): drop unreachable legacy block | +0/-10 | clean | low | fine | wait | Dead code removal. |
| 1487 | fix(metadata): retry relation-id collisions for async inserts | +218/-4 | clean | low | good, tests | wait | MongoDB metadata adapter only; we run sqlite. |
| 1475 | feat(memory-core): activate skill vector search on the PostgreSQL backend | +3925/-45 | clean | low | large | skip | PostgreSQL backend; we run sqlite; superset of #1466. |
| 1473 | fix: resume pending-backlog sessions after restart (standalone) | +61/-1 | clean | high | ok, no test | consider | We run standalone in Docker and lose L1 drain after restart; but the boot re-arm uses sessionKey only (no teamId/agentId), so owner must confirm the drained L1 keeps team/agent scope. |
| 1472 | fix(bridge): probe all known agent sources for L1 session lookup | +327/-8 | conflict-upstream | high | good, tests | skip | Same bug as #1260 (Codex sessions miss the bridge L1 lookup); stale, prefer #1260's suffix scan. |
| 1466 | feat(metadata): PostgreSQL metadata store backend | +3799/-44 | clean | low | large | skip | PostgreSQL; we run sqlite; subset of #1475. |
| 1456 | fix(core): honor LOG_LEVEL in gateway logger | +110/-28 | clean | low-med | good, tests | wait | Useful ops knob (default stays debug); not a bug. |
| 1439 | fix(gateway): report degraded vector stores in health | +190/-4 | clean | med | good, tests | wait | /health stays 200 but adds vectorStoreStatus; nice observability, our healthcheck only curls -f. |
| 1426 | fix(gateway): never strand L0 backlog on stale conversation_count + manual L1 drain | +323/-11 | conflict-upstream (server.ts) | high | good, tests | consider | Our server.ts:3039 still skips timer-fired L1 when conversation_count==0, which can strand backlog; complements #1473; needs manual port. |
| 1423 | fix(pi): disable developer role for strict upstreams | +45/-0 | clean | low | ok | skip | Pi client not used. |
| 1421 | feat(pi): sync mined skills into native Pi skills | +989/-1 | clean | low | - | skip | Pi feature. |
| 1417 | fix(hermes): read conversation search hits from data.messages | +123/-5 | clean | low | good, test | skip | Hermes only; dup of #835. |
| 1415 | feat(pi): isolate memory across /tree branches | +604/-5 | clean | low | - | skip | Pi feature; touches MemoryProxy session-key.ts (needs-owner-read if ever taken). |
| 1409 | fix(hermes-plugin): bridge MEMORY_TENCENTDB_LLM_* to TDAI_LLM_* | +276/-6 | clean | low | good, tests | skip | Hermes only; same bug as #1115. |
| 1407 | feat(gateway): multi-provider llm config via activeProvider + providers[] | +319/-5 | clean | low-med | good, tests | wait | Config feature; we use one provider via env. |
| 1401 | feat(memory-core): per-layer LLM overrides (llm.layers.{l1,l2,l3}) | +266/-23 | conflict-upstream | med | good, tests | wait | Useful to give L1 a small JSON budget (reasoning-model truncation) but a feature and stale. |
| 1383 | fix(hermes): terminate the Gateway process tree on Windows | +33/-9 | clean | low | ok | skip | Hermes + Windows; dup of #1600. |
| 1371 | feat(memory-core): add direction A memory evaluation | +22502/-0 | conflict-upstream | low | huge research dump | skip | Evaluation data/docs. |
| 1366 | fix(gateway): let flush tasks fall through to executeL1 | +6/-3 | clean | med | good, no test | merge-now | Our server.ts:3246 executeFlush calls handleSessionEnd -> StatefulPipelineManager.flushSession, which only enqueues another flush task, so /session/end never runs L1; removing it uses the worker fallback at pipeline-worker.ts:995. |
| 1358 | fix(memory-core): expose extraction configuration in skill archive responses | +212/-5 | conflict-upstream | low | ok | skip | Response-shape change + SDK, stale. |
| 1333 | fix: stop compact truncation loops spinning on oversized tool results | +114/-10 | clean | low | good, test | wait | Infinite CPU loop, but only in offload_server compaction used by OpenClaw. |
| 1323 | fix(memory): cascade-delete agents on member/user removal + admin deletion | +775/-101 | clean | med | good, many tests | consider | Fixes orphan agents in team mgmt we use via Panel, but hard-deletes agents on member removal (policy decision) and changes sqlite tx (SAVEPOINT) + Panel; owner review. |
| 1311 | fix(l3): enqueue L3 when L2 is skipped so persona can (re)generate | +23/-1 | clean | high | good, no test | merge-now | Once L2 is skipped (maxScenes reached or L1 drained) L3 is never enqueued, so persona stops updating; PersonaTrigger still gates LLM cost. |
| 1265 | fix(proxy): bridge session resolution + Pi first-class (companion to #1260) | +1603/-91 | clean | high (proxy part) | dup | skip | Near-identical copy of #1260 (diff of 5 small doc/script lines). |
| 1260 | fix(proxy): bridge session resolution + make Pi a first-class client | +1609/-91 | clean | high (proxy part) | good, tests | consider | memory-bridge.ts:155 / skill-bridge.ts:305 only probe codebuddy:/claude-code: prefixes, so Codex bridge calls miss L1; cherry-pick only proxy commits feea0030, 6542ecb8, 53b0da54 (needs-owner-read: MemoryProxy session). |
| 1229 | fix(memory-core): route standalone Skill assets by request instance | +129/-21 | clean | low-med | good, test | wait | Matters only with multiple x-tdai-service-id instances on one standalone gateway. |
| 1228 | fix(hermes): clarify memory provider activation | +101/-0 | clean | low | ok | skip | Hermes only. |
| 1216 | fix: update skill usage_count/last_used_at on read | +93/-0 | clean | low | ok, test | wait | Stats only. |
| 1186 | feat(pi): interactive Team->Agent->Task picker | +1187/-49 | clean | low | - | skip | Pi feature. |
| 1151 | perf(memory-core): optimize ScopedStorageBackend.key() hot path | +369/-2 | clean | low | risky | skip | Hand-rolled rewrite of the path-traversal guard plus a key cache for micro-perf; risk exceeds gain. |
| 1137 | feat(memory-core): authenticate Hermes memory by user scope | +718/-53 | conflict-upstream | low | - | skip | Hermes auth; stale. |
| 1123 | fix(hermes): stop retry loop after gateway breaker opens | +35/-6 | clean | low | ok | skip | Hermes only. |
| 1121 | fix(hermes): allow configured v3 agent identity | +37/-3 | clean | low | ok | skip | Hermes only; overlaps #1567. |
| 1119 | fix(hermes): preserve line breaks in recall output | +12/-3 | clean | low | ok | skip | Hermes only. |
| 1115 | fix(gateway): accept Hermes LLM environment aliases | +62/-8 | clean | low | ok, test | skip | Adds MEMORY_TENCENTDB_LLM_* aliases in gateway config for Hermes; same bug as #1409. |
| 1103 | OpenClaw Plugin - Multi-Agent Framework + Auto Select Agent | +430/-16 | clean | low | - | skip | OpenClaw feature. |
| 1099 | perf(memory-core): optimize fastEstimateTokens hot path | +280/-17 | clean | low | ok | wait | Offload token estimator (OpenClaw path). |
| 1082 | fix: upsert L1 notes in atomic/update and honor recordIds lookup | +57/-6 | clean (renamed to sqlite/memory-store.ts) | high (recordIds part) | mixed | consider | Verified bug: sqlite queryL1Records (memory-store.ts:1650) ignores recordIds, so atomic/update (v2-router.ts:1065) uses an arbitrary row and copies its team/user/agent/session/type onto the edited note; take only the 1-line recordIds filter, not the new upsert-create semantics. |
| 1042 | fix(openclaw): isolate remote memory by runtime agent | +206/-3 | clean | low | ok | skip | OpenClaw plugin; dup intent of #1748. |
| 998 | fix: don't fail npm run build when seed-v2 source is absent | +1/-1 | clean | low | ok (inline node -e) | wait | Our checkout lacks scripts/seed-v2 so local `npm run build` fails; Docker does not build. Preferred over #1555/#775. |
| 977 | test(gateway): regression coverage for conversation delete isolation | +153/-0 | clean | low-med | test only | wait | Test only; harmless. |
| 971 | fix(gateway): honor TDAI_EMBEDDING_* env vars + real /health version | +35/-1 | clean | low-med | ok, no test | wait | We configure embedding in deploy/compose/core.yaml, not env. |
| 922 | fix: remove legacy monkey-patch postinstall reference | +2/-4 | conflict-upstream | low | fine | wait | Our postinstall has `|| true`, so it is harmless; trivial cleanup. |
| 894 | docs(memory-core): Git memory storage backend RFC | +152/-0 | clean | low | docs | skip | RFC only. |
| 893 | fix(offload): resolve session manager in assemble/afterTurn without sessionKey | +259/-51 | clean | low | ok | skip | OpenClaw offload; overlaps #863/#886. |
| 886 | refactor(offload): replace dist-patch dependency with getSessionMessages | +21/-35 | clean | low | ok | wait | OpenClaw offload. |
| 863 | fix(offload): resolve session manager from sessionId in compact() | +287/-5 | clean | low | ok | skip | OpenClaw offload; overlaps #893. |
| 860 | fix(metadata): bind v3 subject-scoped list endpoints to caller | +68/-10 | conflict-upstream | med | ok | wait | Part of SashaMIT authz series; stale. |
| 859 | fix(metadata): authorize v3 team-scoped list endpoints by caller | +58/-6 | conflict-upstream | med | ok | wait | Same series; stale. |
| 858 | fix(metadata): authorize v3 agent-fixed-asset read endpoints by caller | +109/-5 | clean | med | ok, no admin bypass | consider | Closes an enumeration hole, but readableAgentForCaller has no isSystemAdmin bypass (unlike getAssetForCaller) and MemoryProxy calls list-with-detail with a per-user key while caching per agent (core-client.ts:253); needs owner check. |
| 857 | fix(metadata): authorize v3 team/agent/task get by caller | +47/-3 | clean | med | ok, no admin bypass | consider | Same hardening for team/agent/task get; no system-admin bypass and requireCallerId throws without x-tdai-user-key, which can break MemoryProxy meta client agent/get and Panel admin views. |
| 856 | fix(metadata): bind acl/check and list-accessible subject to caller | +57/-4 | conflict-upstream | med | ok | wait | Same series; stale. |
| 848 | fix(metadata): enforce caller authorization on v3 asset read endpoints | +69/-3 | conflict-upstream | low | ok | skip | Superseded: our asset/get already uses getAssetForCaller with admin bypass (metadata-service.ts:1283). |
| 840 | fix(compact): call compressProtectedTail after emergency compression | +74/-1 | clean | low | good, test | wait | Offload compaction (OpenClaw). |
| 835 | fix(hermes): conversation_search must read messages field | +84/-1 | clean | low | ok, test | skip | Hermes; dup of #1417. |
| 812 | feat(memory-core): reproducible memory evaluation harness | +2149/-0 | conflict-upstream | low | - | skip | Eval tooling. |
| 810 | fix(hermes): bound Gateway stdout/stderr logs with rotation guard | +153/-0 | clean | low | ok | skip | Hermes only. |
| 797 | feat(export): skill asset in export bundles (#779) | +1078/-1 | clean | med | good, tests | consider | Backup/export of chat-memory + skills is useful ops tooling; stacked branch containing #793/#795/#796 - take this one alone if wanted. |
| 796 | feat(import): apply bundles with conflict handling (#779 step 3) | +913/-1 | clean | med | good, tests | skip | Contained in #797. |
| 795 | feat(import): import dry-run for export bundles (#779 step 2) | +692/-1 | clean | med | good, tests | skip | Contained in #796/#797. |
| 793 | feat(export): chat-memory export bundle with manifest schema (#779 step 1) | +420/-1 | clean | med | good, tests | skip | Contained in #795-#797. |
| 775 | fix(build): Dockerfile missing files, dead seed-v2 build, version alignment | +36/-44 | conflict-upstream | low | ok | skip | Mostly superseded: MemoryKnowledge/docker/entrypoint.sh and smoke-test.sh already exist; seed-v2 part covered by #998. |
| 774 | feat(plugin): local scene-memory reader (tdai_read_local) + guarded read_cos | +305/-35 | conflict-upstream | low | - | skip | OpenClaw plugin feature. |

## Top picks

**merge-now**

- **#1311 (L3 after skipped L2).** `PipelineWorker` returns early when `_l2Skipped` is set, without enqueuing L3. Once a scope reaches `persona.maxScenes`, or its L1 is fully drained, the persona never updates again, even with `request_persona_update`. Each restart brings this back because `l2LastRunTime` is held in memory. We run this worker in standalone, so persona memory (injected into every Claude Code/Codex system prompt) goes stale. Risk is low: `PersonaTrigger.shouldGenerate()` still gates the LLM call. The one cost is an extra cheap L3 task per skipped L2. Verified that the added block compiles in our file: `now`, `tid` and `aid` are declared at the top of `cascadeSchedule` (pipeline-worker.ts:1006-1008), and the ID `L3-${task.id}` matches the existing non-skipped L3 enqueue (pipeline-worker.ts:1046).
- **#1366 (flush -> L1).** Verified in our tree: `executeFlush` -> `core.handleSessionEnd` -> `StatefulPipelineManager.flushSession` only enqueues another `flush` task, or does nothing when the count is 0. So `/session/end` never extracts. Removing the override lets `pipeline-worker.ts:995` fall back to `executeL1`. It is a 6-line deletion with no test. Verified that the wrapper does not block the fallback: the gateway wraps the executor in `TracedTaskExecutor` (server.ts:2077), and that wrapper calls `this.executeL1(task)` when `inner.executeFlush` is absent (traced-task-executor.ts:58-63). Smoke-test `/session/end` after the merge.
- **#1527 (ACL grants on restricted assets).** `checkAssetPermission` returned `visibility_restricted` without loading the ACL, so `acl/grant` had no effect on `acl/check` for restricted assets. Our Panel uses restricted skills and knowledge plus ACL. The fix only loads the ACL lazily in that one case. A table test covers it, and the grant path can only widen access to explicitly granted subjects.

**consider**

- **#1082 (take the recordIds hunk only).** This is a real data-integrity bug on sqlite. `queryL1Records({recordIds:[id]})` ignores `recordIds` and returns every row. `handleAtomicUpdate` then takes `existing[0]`: it can return a false 403, or rewrite the edited note with another row's team/user/agent/session/type. Panel L1 edits go through this path. Cherry-pick only the 1-line filter at `memory-store.ts` (around line 1683). Do not take the "missing id creates a note" change; #1604 is the proper create API.
- **#1260 (proxy commits only).** `memory-bridge.ts:155` and `skill-bridge.ts:305` probe only `codebuddy:` and `claude-code:` prefixes. As a result, Codex sessions miss the L1 fast path and fall to the spaceId L2 lookup. Take commits feea0030, 6542ecb8 and 53b0da54 (suffix scan via `store.keysWithSuffix`, with tests), not the Pi onboarding. Our tree already calls `ensureBindingRepoPersistent` (injection/index.ts:462), so drop or verify the duplicate call in server.ts. The change is in a MemoryProxy session area, so it needs an owner read.
- **#1473 + #1426 (backlog stranding after restart).** These fix two halves of one failure in our standalone Docker setup. #1473 re-arms L1 idle timers on boot. #1426 stops timer-fired L1 from being skipped on a stale `conversation_count==0` and adds a manual drain endpoint. Risk: #1473 re-arms by bare sessionKey without teamId/agentId, which may drain under the wrong scope in our v3 team/agent model. #1426 conflicts in server.ts and needs a manual port. Review them together.
- **#857 / #858 (meta read authz).** These close real horizontal-read holes on team/agent/task get and fixed-asset listing. Neither has a `ctx.isSystemAdmin` bypass, and `requireCallerId` throws without a user key. MemoryProxy calls `agent/get` and `list-with-detail`, and Panel admins may view teams they are not members of. Check every caller before merging, or add the admin bypass.
- **#1323 (orphan agents).** This correctly fixes agents being orphaned after member or user removal. But it hard-deletes a member's agents on removal (a product decision) and changes sqlite transactions to SAVEPOINT. It is large and touches Panel too.
- **#797 (export/import).** This is a stacked branch: it contains #793, #795 and #796 and adds skill support. It is useful backup tooling with tests, but it is a feature, not a fix.

## Duplicates

- **Bridge session prefix (Codex miss):** #1260, #1265 and #1472. Prefer #1260's proxy commits. #1265 is a near-identical copy, and #1472 is stale and uses a hard-coded adapter list.
- **seed-v2 build break:** #998, #1555 and #775 (seed-v2 part). Prefer #998 (minimal guard).
- **PostgreSQL backend:** #1466 is a subset of #1475. Skip both (we run sqlite).
- **Export/import stack:** #793 < #795 < #796 < #797. Take #797 alone if wanted.
- **Hermes conversation_search reads data.messages:** #835 and #1417. Prefer #1417 if ever needed (Hermes is unused).
- **Hermes Windows process-tree kill:** #1383 and #1600. Prefer #1600 (has tests).
- **Hermes LLM env mismatch:** #1409 (plugin-side bridge) and #1115 (gateway-side aliases). Prefer #1409 because it keeps the change out of gateway config.
- **Hermes agent id env:** #1121 and #1567 (overlap).
- **OpenClaw per-agent isolation:** #1042 and #1748. Prefer #1748 (newer, tests). Both are unused by us.
- **OpenClaw offload session-manager resolution:** #863, #893 and #886 overlap.
- **L1 atomic create:** the #1082 upsert half and #1604. Prefer #1604 for create; take only the recordIds filter from #1082.
- **L0 backlog stranding:** #1473 and #1426 are complementary, not duplicates. Review them together.
- **SashaMIT meta-authz series:** #848, #856, #857, #858, #859 and #860 are one series. #848 is superseded in our tree, and the others conflict except #857 and #858.

Status: DONE
Summary: merge-now: #1311 persona regenerates when L2 skipped; #1366 session/end actually runs L1 extraction; #1527 acl/check honors explicit restricted grants.
