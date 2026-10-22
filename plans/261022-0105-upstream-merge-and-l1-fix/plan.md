# Merge 26 upstream PRs, fix L1 cursor loss properly, protect proxy admin rate-limits

## Context
We triaged all 498 open upstream PRs. The ledger is `plans/upstream-sync/pr-ledger.md`, with details in `plans/upstream-sync/reports/`.
The owner decided three things:
- Merge the 26 `pending-approval` PRs.
- Fix L1 cursor loss properly, not with a stopgap.
- Add auth to `/v3/admin/rate-limits` and set `TDAI_PROXY_ADMIN_API_KEY`.
- Do not push anything upstream.

Order: merges first, then the L1 fix on top of the merged code. The merged PRs touch the same files: #1717 changes pipeline-factory, #959 changes l1-extractor, #1311 changes pipeline-worker.
Branch: `feat/server_team` (HEAD `3a83a59d`, clean). The plan record and progress go to `plans/261022-0105-upstream-merge-and-l1-fix/plan.md`, with checkable items.

## Phase A: Merge the 26 PRs
Method: `git merge --no-ff refs/upr/N -m "merge upstream PR #N: <title>"`, one PR at a time, in the order below. Resolve conflicts in the same commit.
After each group, run that package's tests plus `tsc`/build, and run `detect_changes` (GitNexus) before moving on. If a group breaks tests, stop and re-plan.

1. **Proxy adapters** (end state already verified in a sandbox: 208/208 tests pass, `tsc` clean; diff at `plans/upstream-sync/reports/triage-261022-overlap-combined.diff`):
   - #1722.
   - #1725, then revert our `default:` branch in `MemoryProxy/src/injection/adapters/openai.ts` to the upstream line.
   - #1723, with a manual fix in the tool-role branch: keep our `parseToolResultContent`/`serializeToolResultContent` and add their `metadata`/`identity`.
   - Port the tests from #1726 and #1724 only, not their code.
2. **Proxy, other:** #1517, #1080, #1349.
3. **Core:** #814, #1040, #1173 (plus the tests from #1488), #1344, #1348, #1220, #959, #1717, #1311, #1366, #1527, #1594.
   - #1366 has no test. Smoke-test `/session/end` locally after merging it.
4. **Knowledge:** #1754, #1470, #1390, #1262, #1141. #1040 also touches `MemoryKnowledge/src/store/serial-queue.ts`.
5. **Panel:** #1588, #1637, #1713.

Tests per package:
- MemoryProxy, MemoryKnowledge, MemoryPanel: `npm test` and `npm run build`.
- MemoryCore: `npm test` and `npm run build:plugin`.

## Phase B: Proper L1 cursor fix
Port the approach of upstream commit `a4d39853` (in #1595) without the structured-output commits. Then add the parts that commit lacks:
- failure classification;
- quarantine of a batch that keeps failing;
- re-arm of the session after dead-letter.

Before editing each symbol, run `impact` (GitNexus) and report any HIGH or CRITICAL risk.

1. **`MemoryCore/src/core/record/l1-extractor.ts`**
   - `L1ExtractionResult` gets `errorReason` and `error`.
   - `llm_error` returns the original error.
   - `no_json`, `parse_fail`, `not_array` and `normalized_all_dropped` become `success:false`.
   - A valid empty `[]` (`empty_scenes`) and empty quality-gate output stay `success:true`.
2. **New `MemoryCore/src/core/record/l1-failure.ts`:** a pure classifier. It unwraps `AI_RetryError.lastError` and the `.cause` chain, then sorts errors into two classes:
   - **transient:** retryable 408/409/429/5xx, timeouts, network errors, 401/403/404 (an operator config mistake must not drop data), and unknown errors;
   - **deterministic:** a 400/413/422 whose message matches context-length or content-policy patterns, plus the parse reasons from step 1.
3. **`MemoryCore/src/core/conversation/l0-recorder.ts`:** port the a4d39853 hunk verbatim. It adds stable `legacy_<file>_<line>` ids and the owner tuple.
4. **`MemoryCore/src/utils/checkpoint.ts`**
   - Port `l1_replay_guard`, `l1_pending_profile_scopes` and the `completion` parameter.
   - Add `l1_failure` (group key, class, reason, `det_attempts`, `transient_streak`) and `l1_quarantine` (a bounded log).
   - When a stale run regresses state, take the union of the guard and scopes instead of overwriting them.
   - Old checkpoints read fine: `read()` merges defaults (checkpoint.ts:322).
5. **`MemoryCore/src/utils/pipeline-factory.ts` `createL1Runner`**
   - Port verbatim: `L1ExtractionFailedError`, `completedPrefixCursor`, `guardsPastCursor`, the guard filter, and the merged pending scopes. The cursor only moves over a certified DONE prefix, and a retry never re-inserts groups that already succeeded.
   - Wrap each group's extraction in try/catch, so a throw in group B still persists group A's prefix and guard.
   - **Deterministic failure:** after N failures in a row on the same group, quarantine the group: log its ids, append a quarantine record, guard the ids, move past it, and continue.
   - **Transient failure:** never skip data. Throw with `retryAfterMs = min(cap, base·2^max(0, streak−4))`.
6. **`MemoryCore/src/services/pipeline-worker.ts`:** `moveToDeadLetter` receives `err`. For an `L1` or `flush` task whose error is a transient `L1ExtractionFailedError` (duck-typed, to avoid an import cycle):
   - set `conversation_count = max(cur, 1)`, because timer-fired L1 is skipped when the count is 0 (server.ts:3037);
   - set `L1_idle` at `now + retryAfterMs`;
   - keep `L2_schedule`;
   - ACK the task, and do not put it on the dead-letter queue.
   Other errors keep today's behaviour. Cap the dead-letter queue at 1000.
7. **`MemoryCore/src/gateway/server.ts`:** fix the tail drain. Bump the count when `armL1IdleAfterDrain` arms. Today the count resets to 0, so the next run is skipped and the backlog waits for a new message.
8. **`MemoryCore/src/utils/pipeline-manager.ts`** (plugin mode, ~736-750): after max retries, a transient error keeps rescheduling at `retryAfterMs`.

**Default thresholds (exported constants; the owner can change them):**

| Constant | Default |
|---|---|
| Quarantine after | 3 deterministic failures on the same group |
| Re-arm backoff | 60 s base, 30 min cap |
| Replay guard | 500 ids |
| Quarantine log | 50 records × 20 ids |
| Pending scopes | 200 |

**Tests:**
- New `src/utils/pipeline-factory.l1.test.ts`: the a4d39853 tests (fixtures rewritten as bare arrays, the `unclosed_reasoning` test dropped), plus these cases:
  - transient 503 or `RetryError(429)`: the cursor stays and the backoff grows up to the cap;
  - 401/404: never quarantined;
  - 3× `no_json` or a context-length 400: quarantined, the next group runs, nothing is thrown;
  - the failure counter resets when the failing group changes;
  - a legit `[]` advances the cursor;
  - partial failure (A succeeds, B fails): the retry extracts only B, and A's scope is delivered;
  - an exception inside group B causes no duplicate of A;
  - interleaved sessions, same-ms rows, and a full page of same-ms rows;
  - guard cleanup and cap;
  - a regressed write produces a union.
- New `src/services/pipeline-worker.test.ts` (LocalStateBackend + fake timers):
  - a transient L1 error that exhausts its retries is re-armed (timer set, count ≥ 1, L2 timer kept), and the timer actually runs L1;
  - `flush` behaves the same;
  - an L2 error keeps the dead-letter behaviour;
  - the queue cap holds.

## Phase C: Proxy admin rate-limits auth
- `MemoryProxy/src/routes/rate-limits.ts`: port the `enforceAuth(c) || handler` wrapper from #808 (commit `d937cb54`). It reuses `checkAdminAuth`/`adminAuthError` from `routes/admin-auth.ts`, the same pattern as `instance-destroy.ts:69` and `model-aliases.ts:17`.
  - Add `src/__tests__/rate-limits.test.ts`: 401 without the key or with a wrong key, 200 with the key.
- `compose.yaml` proxy env: `TDAI_PROXY_ADMIN_API_KEY: ${TDAI_PROXY_ADMIN_API_KEY}`. `config.ts:625` already reads it first.
  - Add it to the `.env` example next to `KNOWLEDGE_SERVICE_KEY`/`MEMORY_CORE_GATEWAY_API_KEY`, and document it in `docs/local-development.md`.
- **Not changed:** `checkAdminAuth` stays "open when no key is set". Default-deny for every deployment was not approved, and our compose sets the key. No in-repo caller uses rate-limits or model-aliases, so nothing breaks.

## Phase D: Records
Update `plans/upstream-sync/pr-ledger.md`:
- set the merged PRs to `merged`, with the merge commit SHA;
- point #1595, #808, #673 and #685 to the port commits;
- add a review section to the plan file.

Commits use conventional messages with no plan or finding codes. Do not push.

## Verification
- Run `npm test` and the build in all 4 packages; MemoryProxy also needs `tsc --noEmit`. Compare the test counts with before the merges.
- Run the new L1 and worker tests in isolation and confirm they fail on the pre-fix code: revert the factory change in a scratch copy.
- Run `docker compose up --build` locally, then:
  - `/health` on the 3 services;
  - `curl /v3/admin/rate-limits` without the key returns 401, and with the key returns 200;
  - one Claude Code request through the proxy;
  - `/session/end` triggers L1, which shows in the logs.
- Simulate an LLM outage: point `MEMORY_LLM_BASE_URL` at a dead port and write L0. The logs must show retries and then `core.task.rearmed`, the cursor must not move, and after restoring the URL the batch must be extracted.
- Run `detect_changes({scope:"compare", base_ref:"3a83a59d"})` before the final commit.

## Progress checklist
- [x] Baseline tests recorded (all 4 packages)
- [x] A1 Proxy adapters: #1722 #1725 #1723 (+ tests from #1726 #1724)
- [x] A2 Proxy other: #1517 #1080 #1349
- [x] A3 Core: #814 #1040 #1173(+#1488 tests) #1344 #1348 #1220 #959 #1717 #1311 #1366 #1527 #1594
- [x] A4 Knowledge: #1754 #1470 #1390 #1262 #1141
- [x] A5 Panel: #1588 #1637 #1713
- [x] B L1 cursor fix (extractor, l1-failure, l0-recorder, checkpoint, pipeline-factory, worker re-arm, tail drain, pipeline-manager) + tests
- [x] C Proxy admin rate-limits auth + compose/env/docs
- [x] D Ledger + review section
- [x] Verification (tests, builds, compose smoke, outage simulation, detect_changes)

## Review (2026-10-22)

**Result.** 26 approved upstream PRs plus #1488 (tests) are merged. The L1 cursor fix and the proxy admin auth are committed. Nothing is pushed.

| Package | Tests before | Tests after | Typecheck / build |
|---|---|---|---|
| MemoryProxy | 185 | 221 | `tsc` clean |
| MemoryCore | 193 | 383 | `build:plugin` OK, 0 new `tsc` errors (one existing error fixed by #1348) |
| MemoryKnowledge | 0 | 31 | `tsc` clean, build OK |
| MemoryPanel | 71 | 79 | `tsc` clean (server and web) |

**Live check** (isolated compose project `amverify` with its own ports and volumes, plus a stub LLM; torn down afterwards):
- Core and Proxy were healthy.
- `/v3/admin/rate-limits` returned 401 with no key and 401 with a wrong key. With the right key it reached the handler, which returned 503 because Redis is not enabled.
- The proxy logged `auth.init bearer:true`.
- **LLM outage:** the stub returned 503 on every call.
  - L1 failed as `transient`, and the cursor stayed unchanged.
  - The worker retried 3 times, then logged `core.task.rearmed` instead of dead-lettering.
  - After the stub was restored, one run extracted all 8 L0 messages: 6 written during the outage and 2 new ones. No data was lost.

**Deviations from the plan:**
- **#1488** was merged in full for its contract tests, but its sqlite post-filter was dropped. An empty `recordIds` means "no id filter" in every backend.
- **ReDoS test timeout** raised from 3 s to 10 s. It was flaky under parallel load.
- **Compose** now also sends the gateway key on proxy auth verify, so #1349 takes effect.
- **Tail drain** uses a task flag that `cascadeSchedule` honours. A count bump in `server.ts` alone was overwritten.
- **Review findings fixed:**
  - Replay-guard cap removed: with more than 500 rows in one millisecond, the cap made the drain loop for ever.
  - An empty read no longer wipes the guard.
  - A memory that no store accepted is now a failure.
  - Every `L1ExtractionFailedError` is re-armed.
  - Errors before the group loop are now classified.
- **Deterministic pattern** narrowed: an oversized `max_tokens` setting stays transient, and Anthropic's `prompt is too long` is matched.

**Found during verification. Not fixed, owner decision:**
1. **The Hub image can no longer start Knowledge on a fresh build.** It fails with `@opentelemetry` "Named export 'SeverityNumber' not found".
   - Cause: `MemoryKnowledge` has no lockfile, and `Hub.Dockerfile` runs `npm install`, so the newest dependencies are pulled at every build.
   - Our merges changed no `package.json`, so this existed before.
   - #1141 now makes the process exit, so the failure shows. Before, it hung without listening.
2. **Re-arm backoff reaches the 30 min cap quickly.** The transient streak counts every run, including the worker's own 3 retries and each capture trigger. In the live check, about 12 runs during a few minutes of outage gave `retry_after_ms=1800000`.
   - No data is lost: a new conversation triggers L1 earlier.
   - An idle session can wait up to 30 min after the LLM recovers.
3. **Known limits, documented:**
   - With `TDAI_LLM_STREAM=true`, every LLM error looks transient. Our deployment uses streaming off.
   - The degraded JSONL read path can skip an unreadable day file. Our deployment uses sqlite.
   - A permanent "exception" fault, such as a store bug or a wrong API key, retries every 30 min for ever. Alert on `core.task.rearmed`.
