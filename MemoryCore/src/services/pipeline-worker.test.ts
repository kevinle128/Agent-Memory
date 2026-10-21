/**
 * PipelineWorker failure handling: an L1 extraction failure (transient or
 * deterministic) is re-armed as an L1_idle timer, never a dead letter; every
 * other failure keeps the dead-letter path.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineWorker } from "./pipeline-worker.js";
import type { TaskExecutor } from "./pipeline-worker.js";
import { LocalStateBackend } from "../core/state/local-backend.js";
import { buildPipelineTimerMember, parsePipelineTimerMember } from "../core/state/timer-member.js";
import type { TaskPayload } from "../core/state/types.js";

const INSTANCE = "inst-1";
const SESSION = "sess-1";
const TEAM = "team-1";
const AGENT = "agent-1";
const RETRY_AFTER_MS = 90_000;

const quietLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Same shape as L1ExtractionFailedError, built by hand: the worker detects it by duck typing. */
function transientL1Error(retryAfterMs = RETRY_AFTER_MS): Error {
  return Object.assign(new Error("L1 extraction failed (reason=llm_error)"), {
    name: "L1ExtractionFailedError",
    failureClass: "transient",
    retryAfterMs,
  });
}

function deterministicL1Error(): Error {
  return Object.assign(new Error("L1 extraction failed (reason=no_json)"), {
    name: "L1ExtractionFailedError",
    failureClass: "deterministic",
    retryAfterMs: 60_000,
  });
}

function task(type: TaskPayload["type"], id = `${type}-task`, data: Record<string, unknown> = {}): TaskPayload {
  return {
    id,
    type,
    instanceId: INSTANCE,
    sessionId: SESSION,
    teamId: TEAM,
    agentId: AGENT,
    priority: 0,
    data: { instanceId: INSTANCE, teamId: TEAM, agentId: AGENT, ...data },
    createdAt: Date.now(),
  };
}

const running: PipelineWorker[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((w) => w.stop()));
});

function startWorker(backend: LocalStateBackend, executor: TaskExecutor, onDeadLetter?: () => Promise<void>): PipelineWorker {
  const worker = new PipelineWorker(backend, executor, {
    concurrency: 1,
    pollIntervalMs: 10,
    maxRetries: 1,
    retryBaseDelayMs: 1,
    onDeadLetter,
  }, quietLogger);
  running.push(worker);
  void worker.start();
  return worker;
}

const l1Member = buildPipelineTimerMember(SESSION, "L1_idle", { teamId: TEAM, agentId: AGENT });
const l2Member = buildPipelineTimerMember(SESSION, "L2_schedule", { teamId: TEAM, agentId: AGENT });

/**
 * Same check as the gateway executor (server.ts executeL1): a timer-fired
 * L1 task is skipped when the session conversation_count is 0.
 */
async function timerL1WouldRun(backend: LocalStateBackend): Promise<boolean> {
  const state = await backend.getSessionState(INSTANCE, SESSION, TEAM, AGENT);
  return !(state && state.conversation_count === 0);
}

describe("PipelineWorker L1 re-arm", () => {
  it.each(["L1", "flush"] as const)(
    "re-arms an L1_idle timer instead of dead-lettering a transient %s failure",
    async (type) => {
      const backend = new LocalStateBackend();
      // The threshold enqueue resets the count to 0 before L1 runs.
      await backend.updateSessionState(INSTANCE, SESSION, { conversation_count: 0 }, TEAM, AGENT);
      await backend.setTimer(INSTANCE, l2Member, Date.now() + 3_600_000);
      const onDeadLetter = vi.fn(async () => {});
      const calls: TaskPayload[] = [];
      const executor: TaskExecutor = {
        executeL1: async (t) => { calls.push(t); throw transientL1Error(); },
        executeL2: async () => {},
        executeL3: async () => {},
      };
      const worker = startWorker(backend, executor, onDeadLetter);
      const before = Date.now();
      await backend.enqueueTask(task(type));

      await vi.waitFor(() => expect(worker.getMetrics().tasksRearmed).toBe(1), { timeout: 5_000 });

      expect(calls).toHaveLength(2); // first run + one worker retry
      expect(worker.getDeadLetterQueue()).toHaveLength(0);
      expect(worker.getMetrics().tasksDeadLettered).toBe(0);
      expect(onDeadLetter).not.toHaveBeenCalled();
      expect(await backend.listQueuedTasks()).toHaveLength(0); // ACKed, not left pending

      const state = await backend.getSessionState(INSTANCE, SESSION, TEAM, AGENT);
      expect(state?.conversation_count).toBeGreaterThanOrEqual(1);
      expect(await timerL1WouldRun(backend)).toBe(true);

      // The L1_idle timer fires retryAfterMs after the failure; L2_schedule stays.
      expect(await backend.getExpiredTimers(INSTANCE, before + RETRY_AFTER_MS - 1_000)).toEqual([]);
      const expired = await backend.getExpiredTimers(INSTANCE, Date.now() + RETRY_AFTER_MS + 3_600_000);
      const members = expired.map((e) => e.member).sort();
      expect(members).toEqual([l1Member, l2Member].sort());
      const l1Timer = expired.find((e) => e.member === l1Member)!;
      expect(l1Timer.fireAtMs).toBeGreaterThanOrEqual(before + RETRY_AFTER_MS);
      expect(l1Timer.fireAtMs).toBeLessThanOrEqual(Date.now() + RETRY_AFTER_MS);
    },
  );

  it("keeps a higher conversation_count", async () => {
    const backend = new LocalStateBackend();
    await backend.updateSessionState(INSTANCE, SESSION, { conversation_count: 4 }, TEAM, AGENT);
    const worker = startWorker(backend, {
      executeL1: async () => { throw transientL1Error(); },
      executeL2: async () => {},
      executeL3: async () => {},
    });
    await backend.enqueueTask(task("L1"));
    await vi.waitFor(() => expect(worker.getMetrics().tasksRearmed).toBe(1), { timeout: 5_000 });
    expect((await backend.getSessionState(INSTANCE, SESSION, TEAM, AGENT))?.conversation_count).toBe(4);
  });

  it("runs L1 again when the re-armed timer fires", async () => {
    const delayMs = 50;
    const fired: TaskPayload[] = [];
    // Emulate the timer scanner: enqueue a timer-fired L1 task on expiry.
    const backend: LocalStateBackend = new LocalStateBackend({
      onTimerExpired: (entry) => {
        const parsed = parsePipelineTimerMember(entry.member);
        void backend.enqueueTask(task(parsed.taskType, `timer-${parsed.taskType}-${Date.now()}`, {
          triggeredBy: "timer_scanner",
        }));
      },
    });
    let attempts = 0;
    const executor: TaskExecutor = {
      executeL1: async (t) => {
        if (t.data?.triggeredBy === "timer_scanner") {
          if (!(await timerL1WouldRun(backend))) return; // same skip as the gateway executor
          fired.push(t);
          return;
        }
        attempts++;
        throw transientL1Error(delayMs);
      },
      executeL2: async () => {},
      executeL3: async () => {},
    };
    const worker = startWorker(backend, executor);
    await backend.enqueueTask(task("L1"));

    await vi.waitFor(() => expect(fired).toHaveLength(1), { timeout: 5_000 });
    expect(attempts).toBe(2);
    expect(worker.getMetrics().tasksRearmed).toBe(1);
    expect(worker.getDeadLetterQueue()).toHaveLength(0);
    // The successful run resets the count through cascadeSchedule.
    await vi.waitFor(async () => {
      expect((await backend.getSessionState(INSTANCE, SESSION, TEAM, AGENT))?.conversation_count).toBe(0);
    }, { timeout: 5_000 });
  });
});

describe("PipelineWorker dead letters", () => {
  it("re-arms a deterministic L1 extraction failure (the runner quarantine bounds its retries)", async () => {
    const backend = new LocalStateBackend();
    await backend.updateSessionState(INSTANCE, SESSION, { conversation_count: 0 }, TEAM, AGENT);
    const onDeadLetter = vi.fn(async () => {});
    const worker = startWorker(backend, {
      executeL1: async () => { throw deterministicL1Error(); },
      executeL2: async () => {},
      executeL3: async () => {},
    }, onDeadLetter);
    const before = Date.now();
    await backend.enqueueTask(task("L1"));
    await vi.waitFor(() => expect(worker.getMetrics().tasksRearmed).toBe(1), { timeout: 5_000 });
    expect(worker.getDeadLetterQueue()).toHaveLength(0);
    expect(onDeadLetter).not.toHaveBeenCalled();
    expect(await timerL1WouldRun(backend)).toBe(true);
    const [timer] = await backend.getExpiredTimers(INSTANCE, Date.now() + 3_600_000);
    expect(timer?.member).toBe(l1Member);
    expect(timer!.fireAtMs).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("does not postpone an earlier L1_idle timer when it re-arms", async () => {
    const backend = new LocalStateBackend();
    const earlier = Date.now() + 5_000;
    await backend.setTimer(INSTANCE, l1Member, earlier);
    const worker = startWorker(backend, {
      executeL1: async () => { throw transientL1Error(); },
      executeL2: async () => {},
      executeL3: async () => {},
    });
    await backend.enqueueTask(task("L1"));
    await vi.waitFor(() => expect(worker.getMetrics().tasksRearmed).toBe(1), { timeout: 5_000 });
    const [timer] = await backend.getExpiredTimers(INSTANCE, Date.now() + 3_600_000);
    expect(timer).toEqual({ instanceId: INSTANCE, member: l1Member, fireAtMs: earlier });
  });

  it("dead-letters an L1 error that is not an L1 extraction failure and removes the session timers", async () => {
    const backend = new LocalStateBackend();
    await backend.setTimer(INSTANCE, l1Member, Date.now() + 3_600_000);
    await backend.setTimer(INSTANCE, l2Member, Date.now() + 3_600_000);
    const onDeadLetter = vi.fn(async () => {});
    const worker = startWorker(backend, {
      executeL1: async () => { throw new Error("L1 task missing instanceId"); },
      executeL2: async () => {},
      executeL3: async () => {},
    }, onDeadLetter);
    await backend.enqueueTask(task("L1"));
    await vi.waitFor(() => expect(worker.getDeadLetterQueue()).toHaveLength(1), { timeout: 5_000 });
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    expect(worker.getMetrics().tasksRearmed).toBe(0);
    expect(await backend.getExpiredTimers(INSTANCE, Date.now() + 7_200_000)).toEqual([]);
  });

  it("dead-letters an L2 failure even when it looks like a transient L1 error", async () => {
    const backend = new LocalStateBackend();
    await backend.setTimer(INSTANCE, l1Member, Date.now() + 3_600_000);
    await backend.setTimer(INSTANCE, l2Member, Date.now() + 3_600_000);
    const onDeadLetter = vi.fn(async () => {});
    const worker = startWorker(backend, {
      executeL1: async () => {},
      executeL2: async () => { throw transientL1Error(); },
      executeL3: async () => {},
    }, onDeadLetter);
    await backend.enqueueTask(task("L2"));
    await vi.waitFor(() => expect(worker.getDeadLetterQueue()).toHaveLength(1), { timeout: 5_000 });
    expect(worker.getDeadLetterQueue()[0]!.task.type).toBe("L2");
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    expect(worker.getMetrics().tasksRearmed).toBe(0);
    expect(await backend.getExpiredTimers(INSTANCE, Date.now() + 7_200_000)).toEqual([]);
  });

  it("keeps at most DEAD_LETTER_QUEUE_MAX entries and drops the oldest", async () => {
    const { DEAD_LETTER_QUEUE_MAX } = await import("./pipeline-worker.js");
    const backend = new LocalStateBackend();
    const worker = new PipelineWorker(backend, {
      executeL1: async () => {},
      executeL2: async () => {},
      executeL3: async () => {},
    }, { concurrency: 1 }, quietLogger);
    running.push(worker);
    // moveToDeadLetter is private; this test calls it directly so it does not
    // need to run more than a thousand failing tasks through the queue.
    const moveToDeadLetter = (worker as unknown as {
      moveToDeadLetter(t: TaskPayload, error: string, retryCount: number, cause?: unknown): Promise<void>;
    }).moveToDeadLetter.bind(worker);
    const total = DEAD_LETTER_QUEUE_MAX + 5;
    for (let i = 0; i < total; i++) {
      const t = task("L2", `dl-${i}`);
      await backend.enqueueTask(t);
      const claimed = await backend.consumeTask(worker.getMetrics().workerId, 0);
      await moveToDeadLetter(claimed!, "boom", 1, new Error("boom"));
    }
    const queue = worker.getDeadLetterQueue();
    expect(queue).toHaveLength(DEAD_LETTER_QUEUE_MAX);
    expect(queue[0]!.task.id).toBe("dl-5");
    expect(queue[queue.length - 1]!.task.id).toBe(`dl-${total - 1}`);
    expect(worker.getMetrics().tasksDeadLettered).toBe(total);
  });
});

describe("PipelineWorker L1 tail drain", () => {
  it("keeps conversation_count at 1 when the executor armed a tail-drain timer", async () => {
    const backend = new LocalStateBackend();
    await backend.updateSessionState(INSTANCE, SESSION, { conversation_count: 0 }, TEAM, AGENT);
    const worker = startWorker(backend, {
      executeL1: async (t) => { (t as { _l1TailPending?: boolean })._l1TailPending = true; },
      executeL2: async () => {},
      executeL3: async () => {},
    });
    await backend.enqueueTask(task("L1"));
    await vi.waitFor(() => expect(worker.getMetrics().tasksCompleted).toBe(1), { timeout: 5_000 });
    expect((await backend.getSessionState(INSTANCE, SESSION, TEAM, AGENT))?.conversation_count).toBe(1);
    expect(await timerL1WouldRun(backend)).toBe(true);
  });

  it("resets conversation_count to 0 after a plain L1 completion", async () => {
    const backend = new LocalStateBackend();
    await backend.updateSessionState(INSTANCE, SESSION, { conversation_count: 3 }, TEAM, AGENT);
    const worker = startWorker(backend, {
      executeL1: async () => {},
      executeL2: async () => {},
      executeL3: async () => {},
    });
    await backend.enqueueTask(task("L1"));
    await vi.waitFor(() => expect(worker.getMetrics().tasksCompleted).toBe(1), { timeout: 5_000 });
    expect((await backend.getSessionState(INSTANCE, SESSION, TEAM, AGENT))?.conversation_count).toBe(0);
  });

  it("does not copy the tail-drain flag into a retry task", () => {
    const worker = new PipelineWorker(new LocalStateBackend(), {
      executeL1: async () => {},
      executeL2: async () => {},
      executeL3: async () => {},
    }, { concurrency: 1 }, quietLogger);
    const flagged = { ...task("L1"), _l1TailPending: true } as TaskPayload;
    const retry = (worker as unknown as { buildRetryTask(t: TaskPayload, n: number): TaskPayload }).buildRetryTask(flagged, 1);
    expect((retry as { _l1TailPending?: boolean })._l1TailPending).toBeUndefined();
  });
});
