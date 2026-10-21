# Code review: L1 cursor-loss fix (uncommitted, MemoryCore)

Date: 2026-10-22 (Asia/Saigon). Branch `feat/server_team`. Review only. No repo edits.

## Scope
- Files: `utils/pipeline-factory.ts` (createL1Runner), `utils/checkpoint.ts`, `core/record/l1-extractor.ts`, `core/record/l1-failure.ts` (new), `services/pipeline-worker.ts`, `gateway/server.ts`, `utils/pipeline-manager.ts`, `core/conversation/l0-recorder.ts`, plus 3 new test files.
- Diff: +686 / -135 tracked, plus about 1.9k LOC of untracked code and tests.
- Tests: `npx vitest run` gives **30 files / 373 tests pass** (144 s).
- Extra verification: a scratch tsx probe (in /tmp, now deleted) drove the real `createL1Runner` against a stub store that honors `limit`. Results are quoted below.

## Verdict
The core design (certified DONE prefix, replay guard, pending scopes, classifier) is sound for the normal paths. I found **two blocking defects**, both reproduced. A third issue is pre-existing but defeats the stated guarantee. Several medium issues leave sessions stuck with no data loss.

---

## CONFIRMED — Blocking

### B1. Replay-guard cap converts the same-ms drain into a livelock: unbounded duplicate extraction plus a hot LLM loop
- Where: `pipeline-factory.ts:634-641` (`guardsPastCursor` cap at `L1_REPLAY_GUARD_MAX=500`), with `queryLimit = L1_BATCH_QUERY + replayGuard.size` (`:516`) and `hasFullBacklog = queryIsFull` (`:732`).
- Scenario: more than about 510 L0 rows share one `recorded_at_ms` under one sessionKey. The page stays full, so `completedPrefixCursor` can never cross that ms, and progress depends only on the guard.
  1. When the guard reaches 500, `kept.slice(-500)` drops the earliest-processed ids.
  2. Those ids sort first in the next page (`queryLimit` stays at 520), so they are unguarded and get re-extracted.
  3. They are re-added, the next oldest ids are dropped, and the cycle repeats.
  4. Rows past position 520 are never reached.
  5. Every run returns `hasFullBacklog=true`, so `server.ts:3089` `enqueueL1Drain` re-enqueues immediately. The result is a tight LLM loop with no backoff.
- Probe result (600 same-ms rows, 80 runs): `distinct-extracted=510 duplicated=290 never-reached=90 lastHasFullBacklog=true`.
- Precondition is reachable: `/conversation/add` accepts a client-supplied `recorded_at` per message (`gateway/v2-router.ts:724`), for example a bulk import with one fixed timestamp. Real stores do not guarantee tie order: SQLite has no secondary sort key, and TCVDB uses offset pagination with `QUERY_PAGE_SIZE=100` (`tcvdb/memory-store.ts:622-643`). Real behavior is therefore no better than the probe.
- Provenance: upstream `a4d39853` had **no cap**. With no cap, the guard grows to the cluster size, `queryLimit` then exceeds the cluster, the page becomes non-full, the cursor crosses the ms, and the guard clears, so the drain terminates. The implementer report lists the 500 cap as a spec constant. **This is an owner decision to confirm, not to change silently.**
  - Original decision: cap the guard at 500 (also caps pending scopes at 200).
  - Finding: the cap turns a bounded-growth algorithm into a livelock with duplicates and unbounded LLM spend.
  - Options:
    - (a) Remove the guard cap and keep the warning log only. This is the upstream behavior. Growth is bounded by the size of the largest same-ms cluster.
    - (b) Never drop ids that are inside the current page, and cap only unknown (out-of-page) ids. This is still unbounded in exactly this case, so it is effectively the same as (a).
    - (c) Use a compound cursor `(recorded_at_ms, record_id)` with a strict tuple `>` in all 3 stores. This removes the same-ms guard entirely, but it is a bigger change: a store interface change and an index.
  - Recommendation: (a) now, (c) as follow-up.
- Test gap: `caps the replay guard…` (`pipeline-factory.l1.test.ts:1180`) only uses stale out-of-page ids, so it cannot catch this. The default `stubStore` ignores `limit` (`:76`).

### B2. A swallowed L0 query error wipes the replay guard and the failure state, which causes a duplicate re-extraction
- Where: `pipeline-factory.ts:629-633` (an unknown id is kept only `if queryIsFull`) and `:668` (when the guard or pending scopes are non-empty, an empty read does not return early). The success write at `:935-941` then persists `replayGuard: []` and `failure: null`.
- Root cause: every store swallows query errors and returns `[]`:
  - SQLite `queryL0ForL1` / `queryL0GroupedBySessionId` (`sqlite/memory-store.ts:2309-2314, 2372-2376`).
  - TCVDB (`tcvdb/memory-store.ts:1313-1316, 1364-1367`), which also returns `[]` when it becomes degraded mid-call.
  - JSONL: a failed `readFile` is skipped with `continue` (`l0-recorder.ts:374-377`).
  The runner cannot tell "no rows" from "query failed".
- Scenario: group A succeeds and B fails, so `a1` is in the guard past the cursor. The next run hits a store hiccup and the read returns `[]`. The guard is recomputed from an empty, non-full window, so all ids are dropped and `failure` is cleared. The run after that extracts A again.
- Probe result: `guard-after-fail=["a1"] guard-after-empty-read=[] llm-calls=["A","B","A","B"]`, so A was sent to the LLM twice.
- Side effect: `failure: null` also resets `det_attempts`. Any store hiccup resets the quarantine counter of a deterministic group.
- Fix: when `rawQueryCount === 0`, carry the guard and `l1_failure` through unchanged. Write only the pending-scope delivery, or skip the checkpoint write entirely. Better still, make the store queries throw (or return a typed failure) for the L1 path, so that the runner throws a transient `L1ExtractionFailedError`.

---

## CONFIRMED — High (pre-existing, but the fix's guarantee depends on it)

### H1. A failed memory write is certified DONE, so the cursor moves past messages whose memories were never stored
- Where:
  - `l1-writer.ts:299-303, 307-311`: a failed JSONL append is only logged.
  - `l1-writer.ts:341-350`: a failed `upsertL1` (false or throw) is only logged.
  - `l1-writer.ts:357`: the record is still returned.
  - `l1-extractor.ts:841-845` (`storeAllDirectly`): exceptions are caught.
- Scenario: the VDB or COS is down during L1. The LLM extracts memories, every write fails silently, and `storedCount` still counts them. The runner treats the group as a success, adds its ids to the guard, and moves the cursor. The memories are permanently lost.
- Impact: the new `exception` → transient path in the runner (`pipeline-factory.ts:795-809`) is almost never reached for store faults. The design note "exception (store/embedding fault) is transient" does not hold.
- Fix: return the write outcome from `writeMemory`. If any intended write fails, return `success:false, errorReason:"exception"`. Writes are already upserts keyed by `record_id`, so a retry with fresh ids could duplicate. Generate ids deterministically from (group key, index), or accept the risk of duplicates over loss.

---

## CONFIRMED — Medium

### M1. A deterministic failure on the last worker retry is dead-lettered with no re-arm, so the session is stuck until the next conversation
- Where: `pipeline-worker.ts:1193-1202`. Only `transientL1RetryAfterMs(cause) !== undefined` re-arms. The same gap exists in `pipeline-manager.ts:740-762` after `L1_MAX_RETRIES`.
- Scenario: `maxRetries=3` gives 4 attempts. Group A fails deterministically on attempts 1-3 and is quarantined on attempt 3. In the same run, group B fails deterministically (det=1), and attempt 4 fails again (det=2). The worker then calls `moveToDeadLetter`, and no `L1_idle` timer is set.
- Another scenario: transient, transient, transient, then deterministic on the last attempt.
- B and everything after it stay unprocessed until a new conversation or flush. There is no loss, but the session is stuck indefinitely if the user is idle.
- Fix: re-arm on **any** `L1ExtractionFailedError` (deterministic uses `L1_REARM_BASE_MS`). Runner-side quarantine already bounds deterministic retries. In `transientL1RetryAfterMs`, drop the `failureClass === "transient"` check, or add a sibling helper.

### M2. Errors before the group loop are not classified, so a transient infra fault is dead-lettered and the session stalls
- Where: `pipeline-factory.ts:507, 537, 755`. These are `checkpoint.read()` (including a distributed-lock acquire timeout), a throwing `queryL0GroupedBySessionId` (Mongo does not swallow, `mongodb/memory-store.ts:501-513`), and `resolveMemoryPrompts`. All rethrow raw at `:952-955`.
- Scenario: a Mongo or VDB outage longer than the worker retry budget dead-letters L1 with no re-arm. This contradicts the stated goal "transient → retry forever". The implementer acknowledged it.
- Fix: in the outer catch, wrap non-`L1ExtractionFailedError` errors as `new L1ExtractionFailedError("exception", sessionKey, { failureClass: classifyL1Failure("exception", err).failureClass, cause: err })`.

### M3. With stream mode on, every provider error is classified transient, so quarantine is unreachable for input rejections
- Where: `adapters/standalone/llm-runner.ts:361-367` (`streamText` path). In ai@6.0.309 (`ai/dist/index.mjs:7818`), the stream flush rejects with `new NoOutputGeneratedError({message})`. The error has **no `cause`** and no `statusCode`, so `classifyL1Failure` falls through to the transient default.
- Scenario: `TDAI_LLM_STREAM=true` or yaml `llm.stream: true` (the default is false: `gateway/config.ts:656-660`). A 400 context-length error or content-filter rejection retries forever, every ≤30 min. The session's L1 (and its pending L2 scopes) are blocked permanently.
- Fix: in stream mode, capture the error from `onError` (or the `error` part) and rethrow that error instead of the `NoOutputGeneratedError`. Or attach it as `cause` and let the classifier walk it.

### M4. JSONL degraded path: a failed file read lets the cursor cross unread older rows (data loss, pre-existing)
- Where: `l0-recorder.ts:374-377` (`catch { warn; continue }`). Then `pipeline-factory.ts:605-623` certifies the prefix only over rows that were actually read.
- Scenario: COS `readFile` fails for the older day file and succeeds for the newer one. The newer rows are processed, and the cursor moves to their max ms. The older day's rows have ms below the cursor and are skipped permanently.
- Fix: propagate read failures from `readConversationRecords` when it is called for L1, or abort the run (throw transient) when any file read fails.

---

## CONFIRMED — Low

- **L1. `_l1TailPending` survives into retry tasks.** `buildRetryTask` (`pipeline-worker.ts:1295-1311`) deletes `_l2ProfileScopes` and similar fields, but not `_l1TailPending`. If `cascadeSchedule` fails after the flag is set, the retry task inherits the flag. A retry with no tail then writes `conversation_count=1`, which causes one extra no-op timer L1 and an off-by-one in the threshold counting. Fix: add `delete (replacement as any)._l1TailPending;`.
  - Flag propagation otherwise checked: it is set on the same in-process `task` object that `executeTask` and `cascadeSchedule(task)` use (`server.ts:3026` → `pipeline-worker.ts:640-668`). It does not need to pass through Redis.
- **L2. `rearmTransientL1` uses `setTimer`, not `setTimerIfEarlier`** (`pipeline-worker.ts:1267-1271`). An earlier `L1_idle` timer that `notifyConversation` armed during the worker's in-task retries is pushed to up to 30 min later. This may be the intended backoff; confirm.
- **L3. `conversation_count` read-modify-write in `rearmTransientL1`** (`:1262-1265`, a get followed by an absolute set). A concurrent `notifyConversation` increment can be lost. The only effect is threshold timing.
- **L4. Checkpoint growth.** One checkpoint object per instance holds all sessions (`tdai-core.ts:1066-1072`), and every `mutate` rewrites it. Each session now carries up to 500 guard ids, 200 scopes, and 50 quarantine records of up to 20 ids each. Quarantine records are never pruned. Consider moving the quarantine log out of the checkpoint (the `l1-quarantine` log line is already the durable trail) or adding a time-based prune.
- **L5. `markL1ExtractionComplete` without `completion` clears the guard and pending scopes** (`checkpoint.ts:765-776`). Today only `scripts/bench-checkpoint-lock.ts:101,113` calls it this way, which is harmless. Future callers risk duplicates and lost L2 scheduling. Consider making "omitted" mean "keep the stored value", consistent with `failure`.
- **L6. Pending-scope cap (200) drops scopes**, so L2 is never scheduled for those groups. There is no data loss. Only a warning is logged.
- **L7. The classifier treats 413 as deterministic only when the body text matches.** HTML `Request Entity Too Large` bodies do not match, so the error is treated as transient forever. Suggest treating 413 as deterministic unconditionally.
- **L8. Implementer report inconsistency.** The "Open risks: `max_tokens` matches the deterministic regex" item is contradicted by `l1-failure.ts:39-45` (the regex excludes it, with an explicit comment). The report text is stale; the code is fine.
- **L9. Comment rule.** No plan, phase, finding or PR codes appear in new production comments. The `P0-2` and `H-11` labels are on unchanged context lines. Test comments `Phase 1/2/3` (`pipeline-factory.l1.test.ts:318,326,338`) are step labels. They are ambiguous under the rule; rename them to "Step".

---

## Speculative / owner-decision risks (not bugs as written)

- **S1. Mass quarantine from systematic output problems.** `no_json`, `parse_fail` and `not_array` are deterministic. A misconfigured model, a proxy that returns an error string as HTTP 200, or output truncation from a too-small `maxOutputTokens` (→ `parse_fail`) quarantines one group per about 20 s (worker backoff of 5 s and 15 s) across every session. Only 50 records per session stay in the checkpoint. This is the owner's rule, so I raise it as input only. Options: require attempts to span a minimum wall-clock window, or add a global circuit breaker when the quarantine rate is high.
- **S2. Permanent "exception" (for example a code TypeError on one message) is transient forever**, so that session's L1 is blocked forever. This is the owner's rule. Alert on `l1_failure.transient_streak`.
- **S3. TCVDB offset pagination with ties.** When `queryLimit > 100`, `_queryAllDocs` pages with offset over `recorded_at_ms` ASC without a tiebreaker. Tie reordering between sub-queries could omit a row whose ms is below the page boundary. The prefix cursor could then cross it, which would be a loss. Unverified: it depends on TCVDB sort stability.
- **S4. Lock-lost runner write.** After the worker aborts on lock loss, the runner still writes the checkpoint. On the equal-cursor, non-regressed path (`checkpoint.ts:774-776`), it replaces the guard instead of merging, which could drop another worker's guard and cause a duplicate. Low probability.
- **S5. Credit is not reported for failed runs.** The implementer noted this. Deterministic failures consume tokens.

---

## Checklist answers (as asked)
1. Data loss: H1 (store write swallow), M4 (JSONL read skip). Both are pre-existing. Partial batches, same-ms rows, full pages and interleaved sessions are correct in the probe and the tests, apart from the B1 cap. The guard cleanup on a non-full page is correct only if the read is complete (B2).
2. Duplicates: B1 and B2 are confirmed. S4 is speculative.
3. Stuck sessions: M1, M2 and M3, plus S2 by design. The tail-drain flag is correct (L1 is minor). The timer path's `conversation_count===0` skip is handled by the re-arm `max(cur,1)`.
4. Back-compat: old checkpoints fill defaults through `newRunnerState` (`structuredClone`, so arrays are not shared). The bench-script caller compiles and works (L5). The e2e script asserts `success && storedCount>0`, so it is unaffected by `no_json` → `success:false`. No other `extractL1Memories` callers exist.
5. Classifier: the `RetryError.lastError` walk is correct for ai@6.0.309 (`RetryError` sets `lastError` and no `cause`). `APICallError.statusCode` and `responseBody` are read correctly. `AbortSignal.timeout` → `TimeoutError` is transient. The gaps are M3 (stream mode) and L7 (413).
6. Comments: clean (L9 nit).

## Recommended actions (priority)
1. B1: decide on the guard cap (recommend removal; compound cursor as follow-up). Add a test with more than 520 same-ms rows and a limit-honoring stub.
2. B2: keep the guard and failure state when `rawQueryCount===0`, or make the L1 store reads throw. Add a test.
3. H1: surface write failures from `writeMemory` → `success:false`.
4. M1 and M2: re-arm on any `L1ExtractionFailedError`, and wrap pre-loop errors.
5. M3: propagate the real stream error.
6. M4: fail the run on a JSONL file-read error.
7. L1 and L7 one-liners. Confirm L2 with the owner.

## Metrics
- Tests: 373/373 pass. The new tests cover the failure paths well, but use stubs that ignore `limit` in most cases. The worker tests copy the server skip check instead of running the executor.
- Type check: implementer reports 0 new tsc errors (not re-run).
- Lint: not run.

## Unresolved questions
1. Is the 500 replay-guard cap an explicit owner requirement, or something the implementer added?
2. Is `TDAI_LLM_STREAM=true` used in any deployment? This decides the priority of M3.
3. Should H1 (pre-existing write swallow) be in scope for this fix, since it defeats the no-loss guarantee?

Status: DONE_WITH_CONCERNS
Summary: The fix is mostly sound, and 373/373 tests pass. Two defects were reproduced by the probe and block merge: B1, where the guard cap livelocks with duplicate extraction and a hot LLM loop when more than about 510 rows share one ms; and B2, where a swallowed store read error wipes the guard and the failure state, which causes duplicates. A pre-existing write-swallow (H1) still loses data, and M1-M3 can leave sessions stuck.
