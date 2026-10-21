# L1 cursor-loss fix: implementation report

Branch `feat/server_team`, nothing committed. Only the owned files were changed (plus `core/record/l1-writer.ts`, approved for the review fixes). The "Review fixes" section below updates some statements in the earlier sections; where they differ, that section is current.

## What changed, per file

- **core/record/l1-extractor.ts**: `L1ExtractionResult` now has `errorReason?: L1FailureReason` and `error?: unknown`. The new type is `L1FailureReason = L1EmptyReason | "normalized_all_dropped" | "exception"`. The `llm_error` catch now returns `errorReason` and the original `error`. When zero memories come back, `no_json`, `parse_fail`, `not_array` and `normalized_all_dropped` return `success:false`. A valid `[]` (or scenes with no memories), empty input and an empty quality-gate result still return `success:true`. The #959 dedup code is not changed.
- **core/record/l1-failure.ts** (new): `classifyL1Failure(reason, error)` is pure. It reads fields by duck typing and does not import `ai`. It follows `AI_RetryError.lastError` (I checked this in ai@6.0.309: `lastError` is set and `cause` is undefined) and then the `cause` chain, at most 5 links, with cycle protection. The rules follow the spec. I added `EAI_AGAIN` to the network list. The module also exports `l1RearmDelayMs(err)` (first named `transientL1RetryAfterMs`), which the worker and pipeline-manager share. It uses duck typing, so there is no import cycle.
- **core/conversation/l0-recorder.ts**: I applied the upstream hunk unchanged, because the file was identical to the upstream parent. It adds stable `legacy_<file>_<line>` ids, the owner tuple on records and groups, and the `storage` param.
- **utils/checkpoint.ts**: I applied the upstream hunk and rewrote its comments (they referenced issue and review codes). Then I added:
  - The `L1FailureState` and `L1QuarantineRecord` types, plus `l1_failure` and `l1_quarantine` with defaults.
  - `L1_QUARANTINE_LOG_MAX=50`.
  - `completion.failure` (omitted keeps the stored value, `null` clears it) and `completion.quarantineAppend` (appends, then keeps the newest 50).
  - On a regressed (stale) cursor write, the guard and the pending scopes are merged with the stored values instead of replaced.
  - Defaults now come from `newRunnerState()` (a `structuredClone`) at all 3 places that create or merge a runner state. The defaults now include arrays, and a shallow spread would make all sessions share one array.

  The call without `completion` still works (bench script).
- **utils/pipeline-factory.ts** (`createL1Runner`): I ported `completedPrefixCursor`, `guardsPastCursor`, the guard filter, the `queryLimit` / bounded slice, the JSON group key, `hasFullBacklog = queryIsFull` and the merged pending scopes. The additions:
  - `L1ExtractionFailedError` now has `failureClass`, `retryAfterMs` and `groupKey`, and keeps `cause` through the ES2022 `cause` option. The details are optional; the default is `transient`.
  - The exported constants from the spec (`L1_QUARANTINE_LOG_MAX` is defined in checkpoint.ts and re-exported here), plus `l1RetryAfterMs(streak)`.
  - Each `extractL1Memories` call is in a try/catch that turns a throw into `{success:false, errorReason:"exception", error}`.
  - The deterministic and transient branches follow the spec. On quarantine, the ids go into the guard, the runner logs a greppable `l1-quarantine` error line, appends a record (at most 20 ids), resets the failure state and continues with the next group.
  - A full success clears `l1_failure`.
  - Guard cleanup: an id that is not in a page that is not full is dropped. The guard has no size cap (see the review fixes). The pending scopes are capped at 200, with a warning.
- **services/pipeline-worker.ts**:
  - Both catch sites now pass `err` to `moveToDeadLetter`.
  - For an L1 or flush task with an `L1ExtractionFailedError` (any class, see the review fixes), the new `rearmFailedL1` does these steps in order: (1) `getSessionState`, then `updateSessionState(conversation_count = max(cur, 1))`. (2) `setTimerIfEarlier(L1_idle, now + retryAfterMs)` through `buildPipelineTimerMember`. (3) ACK the task, and only if the ACK succeeds, `tasksRearmed++`. (4) A warning plus `obsLogger.warn("core.task.rearmed")`.

    The re-arm path keeps the `L2_schedule` timer and does not call `onDeadLetter` or add to the queue. If a side effect fails, the error propagates and the message stays in the PEL. This is the same contract as an `onDeadLetter` failure.
  - `DEAD_LETTER_QUEUE_MAX=1000`: when the queue is full, the oldest entries are dropped first.
  - Also `cascadeSchedule` changes; see the first deviation below.
- **gateway/server.ts**: In the `hasMore` branch of `executeL1`, the executor now sets `task._l1TailPending = true`, with a comment.
- **utils/pipeline-manager.ts**: After `L1_MAX_RETRIES`, any `L1ExtractionFailedError` keeps rescheduling `l1Idle` at `err.retryAfterMs`. Other errors still stop after the limit, as before.

## Deviations from the spec

1. **The tail-drain fix needs a worker change.** `executeL1` (server.ts:3026) returns before `cascadeSchedule` (pipeline-worker.ts, L1 branch) sets `conversation_count: 0`. Any count bump inside server.ts would be overwritten. So server.ts sets a flag on the task (the same pattern as `_l2ProfileScopes`), and `cascadeSchedule` writes `1` instead of `0` when the flag is set. Both files are in my ownership list.
2. **The worker tests use real timers with very short delays and `vi.waitFor`, not `vi.useFakeTimers`.** The worker's consume loop, sleeps and lock renewal do not work well with fake timers. I check the timer's fire time with `LocalStateBackend.getExpiredTimers(now + …)`. For "the timer path runs L1", the test copies the executor's skip check from server.ts (`conversation_count === 0` → skip). It does not run the real gateway executor.
3. **The 20-id cap on quarantine records cannot be reached today.** A group comes from a slice of at most `L1_BATCH_PROCESS = 10` rows. The cap is defensive. The tests check the 50-record trim and that all ids of a group are recorded.
4. **Dropped upstream test:** `unclosed_reasoning` (it depends on structured output). The upstream `{"scenes":…}` fixtures are rewritten as bare arrays. Test names no longer contain finding or issue codes.
5. **`l1RearmDelayMs` lives in `l1-failure.ts`**, shared by the worker and pipeline-manager, instead of two duck-typed copies. `l1-failure.ts` imports types only, so there is no runtime cycle.

## Tests

- At first delivery: **30 files, 371 tests pass** (current numbers are in the review fixes section). The baseline was 27 files and 291 tests. New: `l1-failure.test.ts` 34, `pipeline-worker.test.ts` 9, `pipeline-factory.l1.test.ts` 37 (19 ported upstream cases plus 18 new, where `it.each` cases count once per row).
- `npm run build:plugin` succeeds.
- The tsc command from the spec gives 215 errors, the same list as `/tmp/upr/tsc-now.n.txt`, so there are **zero new errors**. The new test files are also clean under strict tsc.
- **Proof that the new tests fail on the old code.** I ran `git stash push` on the 7 implementation files, kept the new tests, and ran them. Then I ran `git stash pop` and the full suite passed again (371/371). Results on the old code:
  - transient-keeps-cursor: "expected undefined to match object". The old runner did not throw and moved the cursor.
  - partial-failure no-duplicate: "promise resolved { processedCount: 2 … } instead of rejecting".
  - exception-in-group-B: the raw Error came out with no failure class.
  - worker re-arm for L1 and for flush: `tasksRearmed` was undefined. The task was dead-lettered.
  - re-armed timer runs L1: the timer never fired an L1 run.

## Caller check (no edits)

No file under `MemoryCore/scripts` (excluding `dist/`) builds a `RunnerSessionState` by hand, so the new required fields do not break `build:scripts`. `scripts/bench-checkpoint-lock.ts` calls `markL1ExtractionComplete` without `completion`, which still works.

`tdai-core.runL1WithStore` (tdai-core.ts:1061) lets the throw propagate to `executeL1`, then to the worker, which retries and re-arms. `wirePipelineRunners` (tdai-core.ts:743) passes the runner to `MemoryPipelineManager.runL1`, which catches the error, restores the buffer and retries (now with no limit for any `L1ExtractionFailedError`). Both handle the throw correctly.

## Open risks

- **The `max_tokens` regex issue is fixed.** The first version of this report said that the deterministic regex matches `max_tokens`. The coordinator removed `max_tokens` from `INPUT_REJECTED_PATTERN` and added `prompt is too long|input is too long`, with 2 test cases. That note is now stale and no longer a risk.
- **No limit for transient failures.** Reason `exception` (for example a store bug that always fails, or a permanently wrong API key) is transient by the owner's rule, so it is retried for ever (at most every 30 min) and never quarantined. The `core.task.rearmed` warning and `l1_failure.transient_streak` show this state; alerting on them is recommended.
- **Credit for a failed L1 run is not reported.** `runL1WithStore` reads `accumulatedCredit` after `await runner(...)`, so a throw skips the read. This matters for deterministic failures, which do use tokens. I did not change tdai-core.
- **A persistence failure can cause duplicates on retry.** When one memory of a group exists in no store, the whole group fails and is retried with new record ids. Memories of that group that were stored before the failure are written again. A duplicate is better than a loss.
- **Dedup update/merge order is unchanged.** The target records are deleted from the vector store before the new record is written. If the new write then fails everywhere, the retry may not find the old targets. This order existed before this change.
- **A large same-ms group makes the guard large.** With no cap, the guard (and the checkpoint) grows to the size of the largest same-ms group until that group is drained. A compound `(recorded_at_ms, record_id)` cursor would remove this; it is a follow-up.
- **Known limits, out of scope (our deployment uses sqlite with streaming off):**
  - **M3:** in stream mode (`llm.stream: true`), provider errors come back as `NoOutputGeneratedError` with no status, so they are classified as transient and input rejections are never quarantined.
  - **M4:** on the degraded JSONL path, a failed day-file read is skipped, so the cursor can cross unread older rows.
- GitNexus rates `createL1Runner`, `markL1ExtractionComplete`, `extractL1Memories`, `readConversationMessagesGroupedBySessionId` and now `writeMemory` as CRITICAL. That is expected: they are the core L1 path this fix targets.

## Review fixes

These fixes follow the code review (`code-reviewer-261022-l1-cursor-fix.md`); the owner approved each decision.

- **B1, guard cap removed.** I removed `L1_REPLAY_GUARD_MAX` and the eviction in `guardsPastCursor`. The non-full-page cleanup stays. Without the cap, the page grows with the guard until it is not full. The cursor then crosses the shared millisecond and the guard clears. A comment in the code explains why there is no cap.
  - Regression test: 600 rows with one `recorded_at_ms`, and a stub that honors `limit`. The drain takes exactly 61 runs, each row is extracted once, the cursor ends at that millisecond and the guard ends empty.
  - The old cap test is removed, because it tested the removed behaviour.
- **B2, empty reads do not write.** When the L0 query returns zero rows, the runner returns without a checkpoint write: the guard, `l1_failure`, the pending scopes and the cursor stay as they are. Pending scopes are delivered by a later run that reads rows again.
  - Regression test: A succeeds and B fails, which leaves the guard as `["a1"]`. Then a read that returns `[]` leaves the guard, the failure state, the scopes and the cursor unchanged. The next normal run extracts only B, and A is stored once.
- **H1, failed writes do not count.** `writeMemory` (l1-writer.ts) now throws `L1PersistenceError` when no target stored the record: the JSONL append failed, and the vector upsert failed or returned `false` (or there is no vector store). When one target succeeds, the behaviour is the same as before.
  - `applyDecisions` and `storeAllDirectly` rethrow this error; other write errors stay non-fatal.
  - The dedup catch does not fall back to `storeAllDirectly` on this error, because that would rewrite memories that were already stored.
  - `extractL1Memories` returns `success:false, errorReason:"exception", error`. The runner classifies this as transient, and the cursor does not move. The log line is `l1-store-failed`.
  - Callers: `writeMemory` is called only by the extractor and the existing `l1-writer.test.ts`, which still passes.
  - Tests:
    - End to end: the record append fails and the stub store has no `upsertL1`. The run throws a transient error, the cursor stays at 0 and no record is written. After the storage recovers, the retry stores the memory once.
    - `writeMemory` unit cases: the JSONL append fails with no vector store, the JSONL append fails and the upsert fails, and one target succeeds.
  - I put these tests in `pipeline-factory.l1.test.ts`, not in `l1-writer.test.ts`, because that test file is not in my ownership list.
- **M1, re-arm for any L1 failure.** The worker (`rearmFailedL1`) and pipeline-manager now re-arm for any `L1ExtractionFailedError`, deterministic too, through `l1RearmDelayMs`. The runner quarantine bounds the deterministic retries. Errors that are not `L1ExtractionFailedError` (for example a task with no `instanceId`) keep the dead-letter path.
  - Tests: the deterministic failure test now asserts a re-arm (no dead letter, the timer is set and the count is at least 1). A new test checks that a plain L1 error is still dead-lettered and its timers are removed.
- **M2, errors before the loop are transient.** The checkpoint construction and read (including the lock) are now inside the runner's `try`. In the outer catch, any error that is not `L1ExtractionFailedError` becomes `L1ExtractionFailedError("exception", {failureClass:"transient", retryAfterMs:l1RetryAfterMs(streak), cause})`. This covers the checkpoint read or lock, the L0 query, the prompt lookup and the final checkpoint write.
  - When the runner state was read, the runner persists `l1_failure` (best effort), with `transient_streak + 1` and the guard and scopes unchanged, so the backoff grows across runs.
  - Test: a store whose L0 query throws gives a transient error with the base delay. The streak goes 1, then 2. The guard, the scopes and the cursor are kept.
- **Low fixes.**
  - `buildRetryTask` deletes `_l1TailPending`, with a test.
  - The re-arm uses `setTimerIfEarlier`, which is in `IStateBackend`, so an earlier timer armed by a conversation is not pushed later. Test added.
  - The test comments "Phase 1/2/3" are renamed to "First run", "Retry run" and "Third read".
- **Kept the coordinator's edits** to `l1-failure.ts` and `l1-failure.test.ts`. The re-arm helper tests there are updated for the rename and the deterministic case.

**Verification after the review fixes**
- `npx vitest run`: **30 files, 383 tests pass**.
- `npm run build:plugin` succeeds.
- The tsc compare against `/tmp/upr/tsc-now.n.txt` shows zero new errors. The new and changed test files are clean under strict tsc.
- **The B1 and B2 tests failed before the fix.** I ran them before I changed `pipeline-factory.ts`:
  - B1: "expected 10 to be +0". After 80 runs the drain was still processing, which is the livelock.
  - B2: "expected [] to deeply equal ['a1']". The empty read wiped the guard.

Status: DONE_WITH_CONCERNS
Summary: All review fixes are done (B1, B2, H1, M1, M2 and the Low items): the same-ms drain now ends with each row extracted exactly once, empty reads keep the guard, failed writes keep the cursor, and every L1 extraction failure is re-armed instead of dead-lettered. The suite passes (383), the build succeeds, there are zero new tsc errors, and the B1 and B2 tests failed before the fix. The concerns are the open risks above: possible duplicates on a persistence-failure retry, unlimited retries for permanent faults, lost credit reporting on failed runs, and the out-of-scope stream-mode (M3) and JSONL (M4) limits.
