import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../report/obs-logger.js", () => ({
  obsLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { obsLogger } from "../../../report/obs-logger.js";
import {
  LocalSkillAgentTaskQueue,
  type AgentTuple,
} from "../agent-task-queue.js";
import type { SkillBufferStorage } from "../buffer-storage.js";
import type { SkillCandidatesSink } from "../extract-worker.js";
import { SkillWorkerPool, type SkillWorkerPoolOptions } from "../worker-pool.js";
import type { ISkillExtractor } from "../../queue/types.js";

class CountingQueue extends LocalSkillAgentTaskQueue {
  counting = false;
  readonly acquires: string[] = [];

  override async acquireExtractLock(tuple: AgentTuple, ttlMs: number) {
    if (this.counting) this.acquires.push(tuple.agent_id);
    return super.acquireExtractLock(tuple, ttlMs);
  }
}

class DowngradeCountingQueue extends CountingQueue {
  override getPeekStrategy() {
    return "rpop_lpush_downgrade" as const;
  }

  override async peekAgent(blockMs: number): Promise<AgentTuple | null> {
    return this.dequeueAgent(blockMs);
  }
}

function agent(id: string): AgentTuple {
  return { instance_id: "inst", space_id: "sp", user_id: "u", team_id: "t", agent_id: id };
}

function skipLogs(): number {
  return vi.mocked(obsLogger.info).mock.calls.filter((call) => call[0] === "skill.worker.suppressed_skip").length;
}

describe("SkillWorkerPool while an extract lock is busy", () => {
  const pools: SkillWorkerPool[] = [];

  afterEach(async () => {
    vi.mocked(obsLogger.info).mockClear();
    while (pools.length > 0) {
      const pool = pools.pop();
      if (pool) await pool.stop();
    }
  });

  function startPool(
    queue: CountingQueue,
    reads: string[],
    hold: Map<string, Promise<void>>,
    overrides: Partial<SkillWorkerPoolOptions> = {},
  ): SkillWorkerPool {
    const buffer = {
      async readTasks(tuple: AgentTuple) {
        reads.push(tuple.agent_id);
        const gate = hold.get(tuple.agent_id);
        if (gate) await gate;
        return { team_id: tuple.team_id, agent_id: tuple.agent_id, updated_at_ms: 0, tasks: [] };
      },
    };
    const pool = new SkillWorkerPool({
      concurrency: 8,
      queue,
      logger: { info() {}, warn() {}, error() {} },
      brpopBlockMs: 100,
      extractLockRenewIntervalMs: 0,
      lockContentionSleepMs: 0,
      lockContentionSleepJitterMs: 0,
      suppressAgentTtlMs: 200,
      resolveBuffer: async () => buffer as unknown as SkillBufferStorage,
      resolveExtractor: async () => ({}) as ISkillExtractor,
      resolveSink: async () => ({}) as SkillCandidatesSink,
      ...overrides,
    });
    pools.push(pool);
    pool.start();
    return pool;
  }

  it("does not call acquireExtractLock again while this pool already holds the agent", async () => {
    const queue = new CountingQueue();
    queue.counting = true;
    await queue.enqueueAgent(agent("busy"));
    let release!: () => void;
    const hold = new Map<string, Promise<void>>([["busy", new Promise<void>((resolve) => { release = resolve; })]]);
    const reads: string[] = [];
    const pool = startPool(queue, reads, hold);
    const deadline = Date.now() + 2_000;
    while (!reads.includes("busy") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 250));
    expect(reads).toContain("busy");
    expect(queue.acquires.filter((id) => id === "busy")).toEqual(["busy"]);
    expect(skipLogs()).toBe(0);
    release();
    await pool.stop();
  });

  it("limits acquireExtractLock while another process holds the agent", async () => {
    const queue = new CountingQueue();
    await queue.acquireExtractLock(agent("busy"), 60_000);
    queue.counting = true;
    await queue.enqueueAgent(agent("busy"));
    const pool = startPool(queue, [], new Map(), { suppressAgentTtlMs: 500, concurrency: 8 });
    await new Promise((r) => setTimeout(r, 400));
    const attempts = queue.acquires.filter((id) => id === "busy").length;
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(2);
    expect(skipLogs()).toBe(0);
    await pool.stop();
  });

  it("still reads a second free agent while the first agent stays locked", async () => {
    const queue = new CountingQueue();
    await queue.acquireExtractLock(agent("busy"), 60_000);
    queue.counting = true;
    await queue.enqueueAgent(agent("busy"));
    const reads: string[] = [];
    const pool = startPool(queue, reads, new Map(), { suppressAgentTtlMs: 80, concurrency: 6 });
    await new Promise((r) => setTimeout(r, 30));
    await queue.enqueueAgent(agent("free"));
    const deadline = Date.now() + 2_000;
    while (!reads.includes("free") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(reads).toContain("free");
    expect(queue.acquires.filter((id) => id === "busy").length).toBeLessThan(30);
    expect(skipLogs()).toBe(0);
    await pool.stop();
  });

  it("returns from stop while the contention sleep is still long", async () => {
    const queue = new CountingQueue();
    await queue.acquireExtractLock(agent("busy"), 120_000);
    queue.counting = true;
    await queue.enqueueAgent(agent("busy"));
    const pool = startPool(queue, [], new Map(), {
      lockContentionSleepMs: 60_000,
      suppressAgentTtlMs: 60_000,
      concurrency: 6,
    });
    const seen = Date.now() + 2_000;
    while (queue.acquires.length < 1 && Date.now() < seen) {
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(queue.acquires.length).toBeGreaterThan(0);
    const started = Date.now();
    await pool.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("clears the in-flight claim after the buffer resolver throws", async () => {
    const queue = new CountingQueue();
    queue.counting = true;
    await queue.enqueueAgent(agent("free"));
    const reads: string[] = [];
    let failures = 1;
    const pool = startPool(queue, reads, new Map(), {
      failureRequeueSleepMs: 40,
      suppressAgentTtlMs: 40,
      resolveBuffer: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("resolver down");
        }
        return {
          async readTasks(tuple: AgentTuple) {
            reads.push(tuple.agent_id);
            return { team_id: tuple.team_id, agent_id: tuple.agent_id, updated_at_ms: 0, tasks: [] };
          },
        } as unknown as SkillBufferStorage;
      },
    });
    const deadline = Date.now() + 2_000;
    while (!reads.includes("free") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(reads).toContain("free");
    await pool.stop();
  });

  it("requeues popped agents in rpop_lpush_downgrade mode when another worker is busy on lock contention", async () => {
    const queue = new DowngradeCountingQueue();
    const lock = await queue.acquireExtractLock(agent("busy"), 60_000);
    expect(lock).not.toBeNull();
    queue.counting = true;
    await queue.enqueueAgent(agent("busy"));
    const reads: string[] = [];
    const pool = startPool(queue, reads, new Map(), {
      concurrency: 4,
      lockContentionSleepMs: 120,
      lockContentionSleepJitterMs: 0,
      suppressAgentTtlMs: 40,
      selfHealIntervalMs: 60_000,
    });
    // Wait until a worker hits lock contention, requeues, and sleeps in-flight while other workers pop and park.
    const seen = Date.now() + 2_000;
    while (queue.acquires.length < 1 && Date.now() < seen) {
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 60));
    await queue.releaseExtractLock(lock!);
    const deadline = Date.now() + 2_000;
    while (!reads.includes("busy") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(reads).toContain("busy");
    await pool.stop();
  });

  it("requeues popped agents in rpop_lpush_downgrade mode when a resolver throws", async () => {
    const queue = new DowngradeCountingQueue();
    queue.counting = true;
    const reads: string[] = [];
    let failures = 1;
    const pool = startPool(queue, reads, new Map(), {
      concurrency: 1,
      failureRequeueSleepMs: 40,
      suppressAgentTtlMs: 40,
      selfHealIntervalMs: 60_000,
      resolveBuffer: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("resolver down");
        }
        return {
          async readTasks(tuple: AgentTuple) {
            reads.push(tuple.agent_id);
            return { team_id: tuple.team_id, agent_id: tuple.agent_id, updated_at_ms: 0, tasks: [] };
          },
        } as unknown as SkillBufferStorage;
      },
    });
    await queue.enqueueAgent(agent("free"));
    const deadline = Date.now() + 2_000;
    while (!reads.includes("free") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(reads).toContain("free");
    await pool.stop();
  });
});
