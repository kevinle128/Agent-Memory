# MemoryCore-A upstream PR triage

Scope: 85 PRs (66 clean, 1 conflict-ours, 17 conflict-upstream, 1 noref). Deployment context: gateway in sqlite store mode, `stateBackend: local` (deploy/global-images/start-memory-core.sh:178). Diffs were read for every clean and conflict-ours PR. Conflict-upstream PRs were triaged by title, body, and files. For a few of them, HEAD was checked to see whether the fix was already present.

| # | title | +/- | status | relevance | quality | verdict | reason (one sentence) |
|---|---|---|---|---|---|---|---|
| 771 | fail closed on corrupt checkpoints | +81/-4 | clean | med | tests | consider | A corrupt checkpoint now throws instead of silently resetting all cursors (which re-extracts everything), but this blocks the pipeline until a manual fix; edits the same lines as 1153. |
| 776 | support Anthropic wire protocol (MEMORY_LLM_PROTOCOL=anthropic) | +149/-14 | clean | med | tests | consider | Our deploy already exposes MEMORY_LLM_PROTOCOL (_lib.sh:359, .env.example:39), but MemoryCore ignores it; this adds @ai-sdk/anthropic and wires it in. |
| 777 | enable provider=local embedding + warm-up | +125/-10 | clean | low | tests | skip | Enables node-llama-cpp local embeddings, which our deployment does not use. |
| 778 | keep user-grounded correction conclusions in episodic L1 | +47/-1 | clean | med | prompt tests | consider | Prompt-only change that keeps AI conclusions the user confirmed; same prompt file as 1405/1500. |
| 809 | degrade hybrid recall to keyword without EmbeddingService | +61/-9 | conflict-upstream | low | tests | skip | The error string it targets is no longer in HEAD auto-recall.ts, so it is likely superseded (OpenClaw-originated). |
| 814 | recover SerialQueue after synchronous task throw | +87/-2 | clean | med | tests | merge-now | A synchronous throw in a task leaves `running=true` forever and stalls the queue (HEAD serial-queue.ts:109 still calls `entry.task()` bare). |
| 821 | sqlite queryL1Records ignores recordIds | +82/-3 | clean | high | tests | skip | Duplicate of 1173 and targets the old path `core/store/sqlite.ts`, which moved to `sqlite/memory-store.ts`. |
| 827 | checkpoint recalibrate | +282/-0 | conflict-upstream | low | ? | wait | Recounts monotonic counters on startup; affects only cosmetic/threshold counters. |
| 845 | chunk embedBatch by configurable maxBatchSize | +84/-4 | clean | med | tests | consider | Needed only for providers with small batch caps (Dashscope=10); not wired into gateway top-level embedding config; touches the same store-pool block as 1344/777. |
| 870 | carry instance ID through local timer callbacks | +7/-2 | conflict-upstream | high | - | skip | Already fixed on HEAD (local-backend.ts:127 passes instanceId; server.ts:1888 uses entry.instanceId). |
| 896 | wayneos local-fix-patches (4 fixes) | +333/-95 | conflict-upstream | low | ? | skip | Personal grab-bag patch set that also touches MemoryProxy/handler.ts. |
| 904 | hermes: mirror built-in memory writes into L1 | +771/-53 | clean | low | tests | skip | Hermes client is not used; its SerialQueue part duplicates 814. |
| 918 | apply recall score threshold to vector search | +214/-6 | conflict-upstream | low | tests | wait | Recall-tuning semantics; 1412 documents a conflicting intent for hybrid. |
| 923 | replace U+2026 before ByteString conversion | +5/-0 | clean | low | no test | wait | Global sanitizeText change for an offload backend issue; it rewrites stored text for everyone. |
| 937 | inject user display name into L1 prompt | +360/-7 | conflict-upstream | low | tests | wait | Name-attribution tweak; stale. |
| 938 | filter English FTS stop words | +112/-9 | conflict-upstream | low | tests | wait | Recall tuning; stale. |
| 959 | drop sessionId from dedup recall/delete filter | +262/-9 | clean | high | tests | merge-now | L1 dedup recall and merge deletes are filtered by the current session, so corrections in later sessions never update old memories and duplicates pile up (still on HEAD: l1-extractor.ts:323, l1-writer.ts:281). |
| 1011 | GitStorageBackend (experimental) | +2904/-130 | conflict-upstream | low | tests | skip | Large experimental storage feature. |
| 1026 | maintain L1 memories with source evidence | +530/-184 | clean | med | tests | wait | Large feature (source_message_ids across stores, plus one extra LLM recall-planning call per batch); revisit later. |
| 1040 | resolve idle waiters when clearing queued tasks | +58/-0 | clean | med | tests | merge-now | `SerialQueue.clear()` leaves `onIdle()` waiters hanging (Core and Knowledge); identical code is also in 1584, and 1040 is the minimal copy. |
| 1111 | drain L3 cascade during pipeline destroy | +86/-7 | clean | low | tests | skip | Duplicate of 1583; affects only MemoryPipelineManager (plugin/local mode), while the gateway uses StatefulPipelineManager. |
| 1116 | track persona counters per profile scope | +91/-2 | clean | med | tests | consider | L1 increments the global checkpoint's persona counter, but PersonaTrigger reads the profile-scoped one, so the count-based L3 trigger is off; changes L3 cadence. |
| 1117 | expose skill extraction action outcomes | +83/-3 | clean | low | tests | wait | Logging and observability only. |
| 1142 | retry-safe conversation idempotency | +1522/-12 | conflict-upstream | med | tests | wait | Large idempotency-key feature for /conversation/add; stale. |
| 1153 | reduce checkpoint memory allocations | +26/-10 | clean | low | no test | wait | Performance only; writes compact JSON; same lines as 771. |
| 1170 | tcvdb: prevent over-deletion in deleteL0 | +134/-2 | clean | low | tests | skip | TCVDB only, on the old tcvdb.ts path; we run sqlite. |
| 1171 | keep Node global proxy dispatcher when loading undici@8 | +210/-14 | clean | low-med | tests | wait | Eager undici@8 import (we pin ^8.1.0) overwrites Node's env-proxy dispatcher; matters only with NODE_USE_ENV_PROXY. |
| 1172 | self-heal store init cache | +295/-3 | clean | med | tests | consider | The TdaiCore `initStores` cache keeps a failed or closed bundle forever; complements 1437 (different layer). |
| 1173 | honor recordIds filter in sqlite queryL1Records | +158/-2 | clean | high | tests | merge-now | Sqlite ignores `recordIds` and returns the whole table, so `/atomic/update` takes `existing[0]` (wrong record) at v2-router.ts:1065 and l1-writer.ts:194 does a full scan per merge. |
| 1182 | normalize reasoning wrappers before structured extraction | +275/-107 | clean | low-med | tests | wait | Mostly offload paths, which our clients do not exercise. |
| 1183 | probe local LLM capabilities (ollama/llama.cpp) | +828/-25 | clean | low | tests | skip | Local-LLM backend profiles; not our setup. |
| 1184 | token-aware, resilient remote embeddings | +398/-18 | conflict-upstream | med | tests | wait | Stale; revisit at next sync. |
| 1185 | non-destructive embedding reindex | +663/-32 | conflict-upstream | med | tests | wait | Useful on embedding model change, but large and stale. |
| 1220 | repair unescaped ASCII quotes in LLM JSON | +181/-2 | clean | med | tests | merge-now | Third-pass repair runs only when the existing two passes still fail to parse, so it can only recover L1 batches that were otherwise lost. |
| 1278 | proxy+core: L0 duplicate writes, L1 batch conflicts, subject misattribution | +316/-7 | conflict-upstream | high | tests | consider | needs-owner-read: targets Codex L0/L1 duplication via MemoryProxy/src/pipeline/runners/codex.ts; stale; overlaps the 1623 L0 dedup. |
| 1294 | deepen RRF candidate pool | +10/-2 | clean | med | no test | consider | candidateK goes from k*3 to max(50, k*10) for L1 hybrid; better recall of rare matches, more DB and vector work per query. |
| 1312 | deterministic L2 scene maintenance | +194/-0 | clean | low-med | no tests | skip | Default-on automatic scene dedup, decay, and eviction (archives scenes) controlled by env vars; untested behavior change. |
| 1320 | compute L1 dedup timestamps in code | +809/-28 | clean | med | tests | consider | Stops trusting model-invented merged_timestamps, but falls back to `store` when source IDs are missing (possible more duplicates). |
| 1344 | forward sendDimensions to sqlite embedding service | +80/-0 | clean | med | tests | merge-now | Gateway StorePool sqlite path drops `sendDimensions` (verified store-pool.ts:459), so `sendDimensions:false` is ignored. |
| 1348 | preserve source fields in conversation search | +101/-0 | clean | med | tests | merge-now | The FTS branch of L0 search drops session_id/user_id/agent_id, so hits differ by which strategy won. |
| 1353 | PostgreSQL backend | +859/-6 | clean | low | thin | skip | New backend we do not run; 1387 is a superset. |
| 1355 | publish L3 persona after successful generation | +303/-66 | conflict-upstream | med | tests | wait | Atomic persona publish is worth taking at next sync; stale. |
| 1364 | vec0 KNN + RRF for sqlite skill store | +160/-6 | noref | low | ? | skip | No ref fetched. |
| 1376 | reinforce L1 memories selected by agents | +832/-34 | clean | low-med | tests | skip | New usage-boost feature plus `tdai_memory_use` tool (plugin contract); not for our clients now. |
| 1384 | skill extraction pipeline fix + rate limiting | +344/-103 | conflict-upstream | low | ? | skip | Mixed-scope PR; stale. |
| 1387 | PostgreSQL backend + Skill alignment | +1698/-31 | clean | low | tests | skip | New backend we do not run (prefer it over 1353 if ever needed). |
| 1397 | defer L1 extraction failures instead of advancing cursor | +210/-3 | clean | high | tests | consider | Real data-loss bug (see cursor cluster); broadest coverage, but a permanently unparseable batch can block or dead-letter the session, and earlier groups are re-extracted. |
| 1405 | pin L1 user-name attribution to self-introduction | +58/-5 | clean | med | prompt tests | consider | Prompt-only fix for third-party names leaking into "用户（X）"; prefer it over 1500. |
| 1406 | multi-dialect disableThinking | +472/-1 | clean | low | tests | wait | Opt-in fetch rewrite for reasoning models; conflicts with 1463/1183 in llm-runner. |
| 1408 | CJK bigram fallback without jieba | +319/-19 | clean | low | tests | wait | Only matters when the jieba native module is missing; our Linux image ships it. |
| 1412 | document scoreThreshold per strategy | +219/-7 | clean | low | tests | wait | Docs and logs only. |
| 1430 | opt-in time window for LLM pipeline tasks | +402/-0 | clean | low | tests | skip | Feature we do not need. |
| 1437 | don't cache a StorePool entry whose init failed | +171/-1 | clean | med | tests | consider | One transient DB error at first contact leaves the instance degraded forever (silent [] reads); `getStore` now throws, so callers' error paths change. |
| 1455 | distinguish store failure from not-found in DELETE | +201/-14 | clean | med | tests | consider | Returns 502 instead of a false "not found"; also adds the isolation filter to tcvdb deleteL1; partial deletes before an error skip audit rows. |
| 1463 | string-only content for strict endpoints | +213/-1 | clean | low | tests | wait | Opt-in shim for strict OpenAI-compatible endpoints. |
| 1488 | enforce store contracts and L1 query filters | +234/-2 | clean | high | contract tests | consider | Same recordIds bug as 1173, but as a post-filter after a full scan; take the 1173 fix and keep these contract tests (same function, will conflict). |
| 1491 | idx_l0_user_agent_ts for L0 pagination | +164/-0 | clean | low-med | tests | wait | Small Panel pagination performance gain. |
| 1492 | /conversation/sessions + session dims in search hits | +353/-38 | clean | low-med | tests | wait | New sqlite-only endpoint; superset of 1348 in conversation-search.ts. |
| 1500 | deterministically normalize "user (name)" attribution | +144/-1 | clean | low-med | tests | wait | Regex strips every bracketed name unless it is in an allowlist that defaults to empty, so legit names are lost. |
| 1506 | rank L1 FTS hits by query-token coverage | +485/-5 | clean | med | tests | consider | Changes sqlite keyword ranking and adds per-token FTS queries per recall. |
| 1538 | unified change ledger | +12163/-1222 | conflict-upstream | low | ? | skip | Very large; stale. |
| 1556 | default llm.stream=false + preserve L1 cursor on failure | +6/-0 | clean | high | no test | skip | Duplicate in the cursor cluster; the stream default already exists in HEAD gateway/config.ts:656. |
| 1557 | stop L2 scene blocks from growing monotonically | +107/-18 | clean | med | prompt tests | consider | L2 prompt forces full rewrite on UPDATE and a hard 1500-char budget; safe prompt-only path for scene bloat. |
| 1572 | fall back when default log dir is unavailable | +116/-5 | conflict-upstream | low | ? | wait | Stale (CHANGELOG conflict only); minor. |
| 1574 | share hybrid candidates between recall entry points | +164/-205 | conflict-upstream | low | ? | wait | Refactor; stale. |
| 1580 | append skill versions in head's team when team_id omitted | +5/-1 | clean | med | no test | skip | Duplicate of 1594, which is tested and keeps an explicit team_id. |
| 1583 | keep L3 cascade on destroy + honour recordIds in sqlite | +413/-40 | clean | med | tests | consider | Bundles a second recordIds fix (IN query, same bug as 1173) with a MemoryPipelineManager destroy fix (plugin mode only); pick one recordIds fix. |
| 1584 | release onIdle() waiters from SerialQueue.clear() | +569/-40 | clean | low-med | tests | skip | Stacked on 1583; its new code is identical to 1040. |
| 1585 | validate embedding count returned by the API | +660/-40 | clean | med | tests | consider | Stacked on 1584; cherry-pick only commit 4fea3352 (count mismatch silently mis-maps vectors). |
| 1591 | enforce scene-block character budget at write path | +136/-6 | clean | med | tests | skip | Bug: scene-extractor calls `enforceSceneBlockBudget(raw, file)` with the filename as the numeric budget (NaN, type error, would wipe block bodies); tail truncation also drops content. |
| 1594 | skill write paths land version row in head's team | +77/-6 | clean | med | tests | merge-now | Skill patch/edit without team_id appends into "default" team and hits a UNIQUE(skill_id, version) error; we use skills via the proxy. |
| 1595 | structured output for L1 extraction | +3540/-387 | clean | med-high | tests | wait | Large feature; its commit a4d39853 is the most complete L1-cursor fix (idempotent retry, no re-insert of finished groups), so revisit as a unit. |
| 1619 | keep L1 cursor when extraction fails | +190/-1 | clean | high | tests | consider | Minimal cursor-cluster fix: llm_error keeps the cursor and retries via the l1Idle timer with no tight loop; parse failures still advance. |
| 1623 | dedupe repeated L0 user-message writes within a turn | +996/-15 | clean | high | tests | consider | needs-owner-read: fork-sync bundle (CI workflow, Dockerfile, skill-injector, JEV trim); the valuable part is proxy commit 59fd609f (Claude Code/Codex tool loops re-send the user message every step), which touches MemoryProxy and needs an owner read. |
| 1641 | opt-in fail-closed mode for L1 dedup failures | +293/-3 | clean | low-med | tests | wait | Default off; only meaningful after a cursor-defer fix; same line as 959. |
| 1658 | delete FTS rows by rowid | +488/-18 | clean | med | tests | consider | Every L0/L1 upsert runs `DELETE ... WHERE record_id=?` on an UNINDEXED FTS column (full FTS scan); adds rowmap tables with an atomic backfill (schema change). |
| 1679 | Qdrant memory store backend | +2104/-91 | conflict-ours | low | tests | skip | New backend we do not run (the .env.example conflict is trivial). |
| 1694 | support empty local storage deletion prefix | +48/-2 | clean | low | tests | wait | `deleteByPrefix("")` on the local storage backend (instance teardown). |
| 1696 | retain long managed timer deadlines | +81/-7 | clean | low | tests | wait | Delays above 2^31-1 ms fire immediately; rare. |
| 1699 | page the complete local object set | +40/-1 | clean | low | tests | wait | Local storage listing capped at 10k objects. |
| 1716 | trim oversized JEV state on overflow | +2096/-16 | clean | low-med | tests | skip | needs-owner-read (ships MemoryProxy/src/injection/injectors/skill-injector.ts): superset of 1623 plus opt-in semantic/chunked JEV rewrite; default policy stays "defer". |
| 1717 | propagate L2 extraction failures | +185/-1 | clean | med-high | tests | merge-now | A failed L2 group is skipped and the cursor moves past it, so those L1s never reach scenes; minimal fix with a test (a group that always fails now retries every run and blocks the groups behind it). |
| 1719 | propagate L2 extraction failures to pipeline worker | +35/-4 | clean | med-high | tests | skip | Duplicate of 1717 with extra gateway quota-credit plumbing. |
| 1751 | raise body limit for /v2/offload/compact | +69/-2 | clean | low-med | tests | wait | Offload compact endpoint, which our clients likely do not hit. |
| 1752 | reuse short-lived query embeddings | +126/-3 | clean | med | tests | consider | 30 s per-service cache coalesces L0/L1 query embeds (fewer embedding calls per recall); performance only. |

## Top picks

### merge-now

- **959: L1 dedup was session-scoped.** The dedup candidate recall and the merge/update delete both carry the current `sessionId`. As a result, a correction in a new Claude Code or Codex session never finds or replaces the old memory, and duplicates or contradictory memories pile up. Verified still present at HEAD l1-extractor.ts:323 and l1-writer.ts:281. Risk: dedup now spans all sessions in the team/user/agent scope, which is the intended scope. It touches the same line as 1641, so merge 959 first.
- **1173: sqlite `queryL1Records` ignores `recordIds`.** On our sqlite store, `queryL1Records({recordIds:[id]})` returns every L1 row. `/v2/atomic/update` then uses `existing[0]` (v2-router.ts:1065), which is an arbitrary record, so its user/agent and version come from the wrong row. l1-writer.ts:194 also does a full-table scan on every merge. The fix is a primary-key lookup that still honours the other filters. Take 1488's contract tests on top, but not its fix (same function). 1583's IN-query is an equal alternative; pick one.
- **1717: L2 group failure no longer skips the group.** A failed L2 scene extraction was treated like an empty group. The cursor advanced, so those L1s never reached scenes or persona. Now the error is thrown and the worker retries. This is the minimal version; 1719 duplicates it with extra quota plumbing.
- **814 and 1040: SerialQueue liveness.** In 814, a synchronously throwing task left `running=true`, which stalls the queue forever. In 1040, `clear()` never resolved pending `onIdle()` waiters (fixed in both Core and Knowledge). Both are a few lines, tested, and in different regions of the same file.
- **1344: `sendDimensions` dropped in the gateway sqlite StorePool.** If our embedding endpoint rejects the `dimensions` parameter, the config switch has no effect in gateway mode. One-line fix.
- **1348: missing fields in L0 search hits.** When the FTS strategy wins, conversation-search hits lack session_id, user_id, and agent_id. The proxy's conversation search relies on these fields. 1492 is a superset if we later want the sessions endpoint.
- **1594: skill writes without team_id.** These writes landed in the "default" team, which broke with a version-conflict error. This is tested and preferred over 1580.
- **1220: stray-quote JSON repair.** The new pass runs only after the existing two passes fail. It can only rescue L1 batches that would otherwise be dropped.

### consider

- **L1 cursor data loss (1619 / 1397 / 1556 / 1595-a4d39853).** On HEAD, `createL1Runner` ignores `l1Result.success` and advances the cursor even when the LLM call failed (verified at pipeline-factory.ts:646-669). Every transient LLM error permanently drops that batch of conversation, which makes this the highest-value fix in the group. The candidates differ as follows:
  - **1619** is the minimal option: it handles llm_error only, with paced retry through the l1Idle timer.
  - **1397** also defers on parse failures, but a poison batch can wedge the session.
  - **1595's commit a4d39853** is the most correct: it uses a replay guard, so already-stored groups are not re-inserted.
  - **1556** is the crude duplicate.

  1619 and 1397 re-run the groups that already succeeded in a partly failed batch, so dedup must absorb the repeats. The owner should choose 1619 now or port a4d39853.
- **1623 (proxy commit 59fd609f): L0 user-message dedup.** Claude Code and Codex send one HTTP request per tool step, each carrying the same user message. Upstream measured 22-309x duplicate L0 rows and paid L1 extraction cost for them. This directly affects our clients. Risks:
  - It touches MemoryProxy/src/tdai/client.ts, so it needs an owner read against our proxy fork changes.
  - An identical real user message within 10 minutes ("continue") is dropped from L0.
  - The PR itself is a kitchen-sink fork sync, so cherry-pick only that commit and check overlap with 1278 and the MemoryProxy group.
- **1437 + 1172: dead-store caching.** Both stop the gateway (StorePool) and TdaiCore (`initStores`) from caching a failed or degraded store forever. Without them, one startup DB hiccup causes silent empty recall until restart. 1437 changes `getStore` to throw, so check the callers.
- **1658: sqlite FTS full-scan delete on every write.** Every L0 message write deletes from FTS by an UNINDEXED column, which costs O(table) per write and grows with history. The fix adds rowmap tables with a one-time backfill. Risk: a schema change; confirm `rebuildFtsIndex` keeps the map consistent.
- **1116: L3 count-based trigger.** The trigger counter is incremented on the wrong (global) checkpoint, so the persona refresh cadence is wrong. Changes how often L3 runs.
- **776: MemoryCore Anthropic protocol.** Our deploy scripts already set MEMORY_LLM_PROTOCOL, but MemoryCore ignores it. Take this if we want the memory LLM to use an Anthropic endpoint. It adds a dependency.
- **1557 / 1405 / 778: prompt-only quality fixes.** In order: scene bloat, third-party names in user attribution, and keeping user-confirmed corrections. They are low risk, but 1405 and 778 edit the same prompt.
- **Other smaller items:** 1294 (deeper RRF pool), 1506 (token-coverage rerank), 1752 (query-embedding cache), 1320 (code-computed dedup timestamps), 1455 (DELETE 502 on store failure), 845 (embedding batch size), 1585 commit 4fea3352 (embedding count check), 771 (fail-closed corrupt checkpoint; needs an operator recovery story), 1278 (stale; proxy Codex runner, needs an owner read).

## Duplicates

- **sqlite recordIds filter:** 821 (old path), 1173, 1488 (post-filter + contract tests), 1583/1584/1585 (IN query, stacked). Prefer **1173** and add 1488's tests.
- **L1 cursor kept on failure:** 1556, 1397, 1619, 1595 (commit a4d39853); 1641 depends on it. Prefer **1619** now, or a4d39853 for full idempotency.
- **L2 failure propagation:** 1717 and 1719. Prefer **1717**.
- **SerialQueue.clear onIdle:** 1040 and 1584 (identical code). Prefer **1040**.
- **SerialQueue sync throw:** 814 and part of 904. Prefer **814**.
- **destroy L3 cascade:** 1111 and 1583. Prefer 1583 if needed (low priority: plugin mode only).
- **skill version team:** 1580 and 1594. Prefer **1594**.
- **L1 user-name attribution:** 1405 (prompt) and 1500 (regex). Prefer **1405**.
- **scene block growth:** 1557 (prompt) and 1591 (buggy write-path trim); 1312 is also related. Prefer **1557**.
- **conversation-search session fields:** 1348 and 1492 (superset). Prefer **1348** now.
- **Postgres backend:** 1353 and 1387. Skip both (1387 is the superset).
- **JEV overflow:** 1623 and 1716 (superset). Skip both as bundles.
- **L0 duplicate writes in the proxy:** 1623 (59fd609f) and 1278. Cross-check with the MemoryProxy group.

## Mutual-conflict notes for merge-now

- 1344, 845, and 777 edit the same `createSqliteStore` block.
- 959 and 1641 edit the same extractor line.
- 1173, 1488, and 1583 edit the same `queryL1Records` branch.
- 1348, 1492, and 1752 edit conversation-search.ts.
- 771 and 1153 edit `checkpoint.readRaw`.
- 1220 and 1595 edit `utils/sanitize.ts`.
- 1320 overlaps 959 in l1-extractor.ts and l1-writer.ts.
