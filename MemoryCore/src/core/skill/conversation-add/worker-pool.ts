/**
 * SkillWorkerPool —— 进程内单例的 skill 抽取 worker 池。
 *
 * 对齐 memory PipelineWorker：一次性起 N 条无状态 consumeLoop，
 * 从全局共享的 SkillAgentTaskQueue 拿 agent tuple。tuple 5 段自带
 * instance_id, worker 出队后按 instance_id 通过 resolver 现取对应
 * instance 的 buffer / extractor / sink, 干活时委托给
 * SkillConversationExtractWorker.consumeAgent（原封复用 8 步流程）。
 *
 * 语义与老"per-instance worker"完全一致：
 *   - agent-level extract-lock 保证同一 (instance, agent) 只有一条 loop 抽取
 *   - tasks-mutex 保护 _tasks.json 读改写
 *   - transient / permanent 错误分级 + DLQ
 *   - 幽灵 task 静默回收
 *
 * 差别只在拓扑：worker 数不再随 instance 数线性膨胀, 用 concurrency
 * 一个参数统一控制全进程 in-flight 上限。详见
 * docs/design/2026-07-30-skill-worker-instance-decoupling.md。
 */

import {
  LEGACY_INSTANCE_ID,
  parseAgentTuple,
  type AgentTuple,
  type ISkillAgentTaskQueue,
} from "./agent-task-queue.js";
import type { SkillBufferStorage } from "./buffer-storage.js";
import type { ExtractorLogger, ISkillExtractor } from "../queue/types.js";
import { runInRootContext } from "../../report/otel-context.js";
import { obsLogger } from "../../report/obs-logger.js";
import {
  SkillConversationExtractWorker,
  type SkillCandidatesSink,
  type SkillConversationExtractWorkerOptions,
  type TaskProjectLabelLookup,
  ExtractorUnavailableError,
} from "./extract-worker.js";
import type { MemoryPromptMode } from "../../../config.js";

/**
 * 由 gateway 侧闭包捕获的 per-instance 资源解析函数。走进程级 cache,
 * 首次 <10ms, 后续 <1ms (Map.get)。
 */
export interface SkillWorkerResolvers {
  resolveBuffer(instanceId: string): Promise<SkillBufferStorage>;
  resolveExtractor(instanceId: string): Promise<ISkillExtractor>;
  resolveSink(instanceId: string): Promise<SkillCandidatesSink>;
}

export interface SkillWorkerPoolOptions extends SkillWorkerResolvers {
  /** 池里 worker 数, 全进程并发上限。>=1。 */
  concurrency: number;
  /** 全进程共享的 skill agent 队列。 */
  queue: ISkillAgentTaskQueue;
  logger: ExtractorLogger;
  /** 池 id 前缀, worker id 会拼上 index; 默认 `skill-pool-${pid}`。 */
  poolId?: string;

  // ── 透传给底层 SkillConversationExtractWorker 的参数 ──
  brpopBlockMs?: number;
  extractLockTtlMs?: number;
  extractLockRenewIntervalMs?: number;
  tasksMutexLockTtlMs?: number;
  tasksMutexWaitDeadlineMs?: number;
  lockContentionSleepMs?: number;
  lockContentionSleepJitterMs?: number;
  tasksPerRound?: number;
  failureRequeueSleepMs?: number;
  permanentMaxRetries?: number;
  transientLogSampleEvery?: number;
  now?: () => number;

  /** Prompt mode of the instance. `code` turns on the project gate in each worker. */
  getPromptMode?: () => MemoryPromptMode;
  /**
   * Finds the project labels of an unlabeled task in the L0 rows of its
   * instance. The pool binds the instance id of each agent.
   */
  lookupProjectLabels?: (
    instanceId: string,
    query: Parameters<TaskProjectLabelLookup>[0],
  ) => ReturnType<TaskProjectLabelLookup>;
  /** L0 window for `lookupProjectLabels`. */
  projectLookupWindowMs?: number;

  /**
   * How long a worker waits before peeking again when the agent it just saw is
   * already being extracted in this process, or was locked by someone else.
   * Shared by the pool so idle workers do not each call acquireExtractLock.
   * Default 1000ms. `stop()` wakes the wait immediately.
   */
  suppressAgentTtlMs?: number;

  /**
   * 2026-08-03 crash-recovery §4.5: 降级路径下周期性自愈扫描的间隔 ms。
   * 只在 queue.getPeekStrategy() === "rpop_lpush_downgrade" 时启用。默认 60_000。
   * 非降级路径下 start() 只跑一次冷启动扫描, 不启动定时器。
   */
  selfHealIntervalMs?: number;
}

export class SkillWorkerPool {
  private readonly opts: SkillWorkerPoolOptions;
  private readonly logger: ExtractorLogger;
  private readonly poolId: string;
  private closed = false;
  private started = false;
  private loopPromises: Promise<void>[] = [];
  private selfHealTimer: ReturnType<typeof setInterval> | undefined;
  /** Agents whose consumeAgent call is in progress in this pool. */
  private readonly inFlightAgents = new Set<string>();
  /** Do not claim this agent again until this timestamp. */
  private readonly retryNotBefore = new Map<string, number>();
  private idleWaiters: Array<() => void> = [];

  constructor(opts: SkillWorkerPoolOptions) {
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
      throw new Error(`[skill-worker-pool] concurrency must be positive integer, got ${opts.concurrency}`);
    }
    this.opts = opts;
    this.logger = opts.logger;
    this.poolId = opts.poolId ?? `skill-pool-${process.pid}`;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.closed = false;
    const n = this.opts.concurrency;
    this.logger.info(
      `[skill-worker-pool] start pool_id=${this.poolId} concurrency=${n} ` +
        `brpopBlockMs=${this.opts.brpopBlockMs ?? 5000} ` +
        `extractLockTtlMs=${this.opts.extractLockTtlMs ?? 600_000}`,
    );

    // 2026-08-03 crash-recovery §4.5: 冷启动跑一次 selfHealScan, 清历史遗留的
    // "Set 有 / List 无" 幽灵 + legacy 4 段。放在拉起 workerLoop 之前跑, 避免竞态。
    // 用 fire-and-forget 的 IIFE 而不是 await —— pool.start() 保持同步 API,
    // 扫描慢的话让 loop 并行跑, self-heal 补上任何漏的即可。
    void (async () => {
      try {
        const result = await this.selfHealScan();
        this.logger.info(
          `[skill-worker-pool] self-heal cold scan done scanned=${result.scanned} ` +
            `repushed=${result.repushed} legacy_purged=${result.legacyPurged} dur_ms=${result.dur_ms}`,
        );
        obsLogger.info("skill.worker.self_heal_scan", {
          pool_id: this.poolId,
          scanned: result.scanned,
          repushed: result.repushed,
          legacy_purged: result.legacyPurged,
          dur_ms: result.dur_ms,
          trigger: "cold_start",
        });
      } catch (err) {
        this.logger.warn(
          `[skill-worker-pool] self-heal cold scan failed: ${(err as Error).message}`,
        );
      }
    })();

    // 降级路径下额外起周期定时器。原子路径无此需要 (peek 已保证 List 状态一致)。
    const strategy =
      typeof this.opts.queue.getPeekStrategy === "function"
        ? this.opts.queue.getPeekStrategy()
        : "lmove";
    if (strategy === "rpop_lpush_downgrade") {
      const interval = this.opts.selfHealIntervalMs ?? 60_000;
      this.logger.warn(
        `[skill-worker-pool] peek strategy is DOWNGRADED — starting periodic self-heal ` +
          `every ${interval}ms`,
      );
      this.selfHealTimer = setInterval(() => {
        void (async () => {
          if (this.closed) return;
          try {
            const result = await this.selfHealScan();
            obsLogger.info("skill.worker.self_heal_scan", {
              pool_id: this.poolId,
              scanned: result.scanned,
              repushed: result.repushed,
              legacy_purged: result.legacyPurged,
              dur_ms: result.dur_ms,
              trigger: "periodic_downgrade",
            });
          } catch (err) {
            this.logger.warn(
              `[skill-worker-pool] periodic self-heal failed: ${(err as Error).message}`,
            );
          }
        })();
      }, interval);
    }

    // 拉起 N 条 workerLoop。跟 memory PipelineWorker.start 同 pattern:
    // 不 await, 全部并发常驻; stop() 里再一起等。每条 loop 放到 OTel
    // ROOT_CONTEXT 里跑 (跟老 SkillConversationExtractWorker 对齐), 防止
    // 无限循环继承"启动那一刻"的 active span 污染 LLM trace。
    for (let i = 0; i < n; i++) {
      const p = runInRootContext(() => this.workerLoop(i));
      p.catch(() => { /* logged inside */ });
      this.loopPromises.push(p);
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.selfHealTimer) {
      clearInterval(this.selfHealTimer);
      this.selfHealTimer = undefined;
    }
    this.notifyIdleWaiters();
    for (const p of this.loopPromises) {
      try { await p; } catch { /* swallow */ }
    }
    this.loopPromises = [];
    this.inFlightAgents.clear();
  }

  /**
   * 一次性扫描 pending-agents-set, 修 List 侧缺失 + 清 legacy 4 段残留。
   * 详见 docs/design/2026-07-21-skill-worker-crash-recovery.md §4.5。
   *
   * 语义:
   *   - 5 段 legit tuple 且 List 无 → LPUSH 补回, repushed++
   *   - 4 段 legacy 残留            → SREM + LREM 清, legacyPurged++
   *   - 5 段 legit tuple 且 List 有 → 不动
   *
   * 冷启动时 pool.start() 会 fire-and-forget 调用一次; 降级路径下额外周期性调用。
   * 也 export 出来给测试 + 排障用。
   */
  async selfHealScan(): Promise<{
    scanned: number;
    repushed: number;
    legacyPurged: number;
    dur_ms: number;
  }> {
    const q = this.opts.queue;
    if (typeof q.scanAgentSet !== "function") {
      // 老 queue 实现没升级, 直接返回空结果, 不 crash pool。
      return { scanned: 0, repushed: 0, legacyPurged: 0, dur_ms: 0 };
    }
    const t0 = Date.now();
    let scanned = 0;
    let repushed = 0;
    let legacyPurged = 0;
    const members = await q.scanAgentSet();
    for (const raw of members) {
      scanned++;
      const parsed = parseAgentTuple(raw);
      if (!parsed || parsed.instance_id === LEGACY_INSTANCE_ID) {
        // legacy 4 段 (parse 出来 instance_id === LEGACY) 或损坏 (parse null) → 清。
        // 损坏残留跟 legacy 一起处理: 反正 pool 处理不了它。
        await q.purgeRawAgent(raw);
        legacyPurged++;
        continue;
      }
      const inList = await q.listContains(raw);
      if (!inList) {
        await q.enqueueRawAgent(raw);
        repushed++;
      }
    }
    return { scanned, repushed, legacyPurged, dur_ms: Date.now() - t0 };
  }

  private busyRecheckMs(): number {
    const configured = this.opts.suppressAgentTtlMs ?? 1_000;
    return configured > 0 ? configured : 1_000;
  }

  private noteRetry(key: string, delayMs: number): void {
    const now = this.opts.now?.() ?? Date.now();
    this.retryNotBefore.set(key, now + delayMs);
    if (this.retryNotBefore.size <= 200) return;
    for (const [k, until] of this.retryNotBefore) {
      if (until <= now) this.retryNotBefore.delete(k);
    }
  }

  private notifyIdleWaiters(): void {
    const waiting = this.idleWaiters;
    this.idleWaiters = [];
    for (const wake of waiting) wake();
  }

  /** Wait, but return as soon as stop() runs. */
  private park(ms: number): Promise<void> {
    if (this.closed || ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const idx = this.idleWaiters.indexOf(finish);
        if (idx >= 0) this.idleWaiters.splice(idx, 1);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.idleWaiters.push(finish);
    });
  }

  /**
   * 单条 worker loop。设计上无状态：每次拿到 agent 就 resolver 现取资源,
   * 构造一次性 SkillConversationExtractWorker 委托 consumeAgent。
   *
   * peek 不把 agent 移出 List。一个 agent 正在被本 pool 抽, 或 extract-lock
   * 被别的进程占着时, 其余 worker 只隔 busyRecheckMs 再看队列, 不再各自抢锁
   * 也不再每 20ms 打 suppressed_skip。队里若出现第二个 agent, 下一轮 peek
   * 轮转到它就会被领走。
   */
  private async workerLoop(index: number): Promise<void> {
    const workerId = `${this.poolId}#${index}`;
    const blockMs = this.opts.brpopBlockMs ?? 5000;

    while (!this.closed) {
      let agent: AgentTuple | null = null;
      try {
        // peekAgent keeps the agent in the List (LMOVE). A crash can pick it up again.
        agent = await this.opts.queue.peekAgent(blockMs);
      } catch (err) {
        if (this.closed) break;
        this.logger.warn(`[skill-worker-pool] ${workerId} peek error: ${(err as Error).message}`);
        await this.park(200);
        continue;
      }
      if (!agent || this.closed) continue;

      // Legacy 4-segment rows stay at the head under LMOVE, so purge them
      // instead of skipping. A 5-segment serialize does not match that raw.
      if (agent.instance_id === LEGACY_INSTANCE_ID) {
        const legacyRaw = `${agent.space_id}|${agent.user_id}|${agent.team_id}|${agent.agent_id}`;
        this.logger.error(
          `[skill-worker-pool] ${workerId} legacy 4-segment tuple detected, purging: ${legacyRaw}`,
        );
        obsLogger.warn("skill.worker.legacy_tuple_dropped", {
          worker_id: workerId,
          space_id: agent.space_id,
          user_id: agent.user_id,
          team_id: agent.team_id,
          agent_id: agent.agent_id,
        });
        try {
          await this.opts.queue.purgeRawAgent(legacyRaw);
        } catch (err) {
          this.logger.warn(
            `[skill-worker-pool] ${workerId} purgeRawAgent(legacy) failed: ${(err as Error).message}`,
          );
        }
        continue;
      }

      const key = agentBusyKey(agent);
      const now = this.opts.now?.() ?? Date.now();
      const retryAt = this.retryNotBefore.get(key) ?? 0;
      const isDowngrade =
        (typeof this.opts.queue.getPeekStrategy === "function"
          ? this.opts.queue.getPeekStrategy()
          : "lmove") === "rpop_lpush_downgrade";
      if (this.inFlightAgents.has(key) || retryAt > now) {
        if (isDowngrade) {
          try {
            await this.opts.queue.requeueAgent(agent);
          } catch (err) {
            this.logger.warn(
              `[skill-worker-pool] ${workerId} requeueAgent(busy) failed: ${(err as Error).message}`,
            );
          }
        }
        const waitMs = this.inFlightAgents.has(key)
          ? this.busyRecheckMs()
          : Math.min(this.busyRecheckMs(), Math.max(1, retryAt - now));
        await this.park(waitMs);
        continue;
      }

      // Claim before the first await so only one worker enters consumeAgent.
      this.inFlightAgents.add(key);
      let contended = false;
      try {
        const result = await this.consumeAgent(agent, workerId);
        contended = result?.lockContended === true;
      } catch (err) {
        if (!this.closed) {
          this.logger.error(
            `[skill-worker-pool] ${workerId} consumeAgent error: ${(err as Error).message}`,
          );
        }
        if (isDowngrade) {
          try {
            await this.opts.queue.requeueAgent(agent);
          } catch (requeueErr) {
            this.logger.warn(
              `[skill-worker-pool] ${workerId} requeueAgent(error) failed: ${(requeueErr as Error).message}`,
            );
          }
        }
        this.noteRetry(key, this.opts.failureRequeueSleepMs ?? 1_000);
      } finally {
        // consumeAgent already waited out a long contention sleep. A short
        // gate is only needed when that wait was shorter than the recheck,
        // otherwise every idle worker would claim the same locked agent.
        if (contended) {
          const slept = this.opts.lockContentionSleepMs ?? 2_000;
          if (slept < this.busyRecheckMs()) this.noteRetry(key, this.busyRecheckMs());
        }
        this.inFlightAgents.delete(key);
        this.notifyIdleWaiters();
      }
    }
  }

  /**
   * 拿到 agent 后按 instance_id resolver 现取 3 份 per-instance 资源,
   * 构造一次性 SkillConversationExtractWorker 委托 consumeAgent 走 8 步流程。
   *
   * 这里不缓存 worker 实例 —— 每次都 new 是 O(1) 分配 + 常量字段拷贝,
   * 相对 20-90 秒的 LLM 抽取可忽略, 换来的是 worker pool 本身完全无状态。
   */
  private async consumeAgent(
    agent: AgentTuple,
    workerId: string,
  ): Promise<{ lockContended?: boolean }> {
    const instanceId = agent.instance_id;
    const [buffer, sink] = await Promise.all([
      this.opts.resolveBuffer(instanceId),
      this.opts.resolveSink(instanceId),
    ]);
    // The extractor is resolved only when a task reaches the LLM step. A task
    // that the project gate drops never needs it, and a resolver failure then
    // goes through the per-task retry rules instead of failing the whole agent
    // loop again and again.
    const extractor = lazyExtractor(() => this.opts.resolveExtractor(instanceId));

    const extractWorkerOpts: SkillConversationExtractWorkerOptions = {
      workerId,
      buffer,
      queue: this.opts.queue,
      extractor,
      sink,
      logger: this.logger,
      brpopBlockMs: this.opts.brpopBlockMs,
      extractLockTtlMs: this.opts.extractLockTtlMs,
      extractLockRenewIntervalMs: this.opts.extractLockRenewIntervalMs,
      tasksMutexLockTtlMs: this.opts.tasksMutexLockTtlMs,
      tasksMutexWaitDeadlineMs: this.opts.tasksMutexWaitDeadlineMs,
      lockContentionSleepMs: this.opts.lockContentionSleepMs,
      lockContentionSleepJitterMs: this.opts.lockContentionSleepJitterMs,
      tasksPerRound: this.opts.tasksPerRound,
      failureRequeueSleepMs: this.opts.failureRequeueSleepMs,
      shouldStop: () => this.closed,
      permanentMaxRetries: this.opts.permanentMaxRetries,
      transientLogSampleEvery: this.opts.transientLogSampleEvery,
      now: this.opts.now,
      getPromptMode: this.opts.getPromptMode,
      lookupProjectLabels: this.opts.lookupProjectLabels
        ? (query) => this.opts.lookupProjectLabels!(instanceId, query)
        : undefined,
      projectLookupWindowMs: this.opts.projectLookupWindowMs,
    };
    const oneShot = new SkillConversationExtractWorker(extractWorkerOpts);
    // 直接调 consumeAgent —— 走同一份 8 步流程 (extract-lock / renewTimer /
    // tasks-mutex / transient-permanent / DLQ / 幽灵检测)。返回 lockContended 供
    // 上游短抑制表使用。
    const result = await oneShot.consumeAgent(agent);
    return { lockContended: result.lockContended };
  }
}

/** An extractor that is built on its first use and kept for later calls. */
function lazyExtractor(resolve: () => Promise<ISkillExtractor>): ISkillExtractor {
  let pending: Promise<ISkillExtractor> | undefined;
  return {
    extract: async (input) => {
      pending ??= resolve().catch((err: unknown) => {
        pending = undefined;
        throw new ExtractorUnavailableError(err instanceof Error ? err.message : String(err), { cause: err });
      });
      return (await pending).extract(input);
    },
  };
}

function agentBusyKey(agent: AgentTuple): string {
  return `${agent.instance_id}|${agent.space_id}|${agent.user_id}|${agent.team_id}|${agent.agent_id}`;
}
