/**
 * createL1Runner failure semantics.
 *
 * Failures use the pipeline's throw channel. A partly completed batch may
 * persist only its safe prefix, replay guards and pending scopes; failed or
 * unprocessed messages stay available for retry. Transient failures are
 * retried without a limit; deterministic failures quarantine the group after
 * L1_QUARANTINE_AFTER attempts.
 *
 * Symbols added with this behaviour are read from the `pf` namespace inside
 * each test, so the file also loads against older code.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APICallError, RetryError } from "ai";
import * as pf from "./pipeline-factory.js";
import { CheckpointManager } from "./checkpoint.js";
import type { PipelineLogger } from "./pipeline-factory.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { LLMRunner } from "../core/types.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";
import { writeMemory } from "../core/record/l1-writer.js";

// Lets a test make extractL1Memories throw for one group, the way a store or
// embedding fault would. Without a hook the real function runs.
const extractorHooks = vi.hoisted(() => ({
  throwFor: undefined as undefined | ((contents: string[]) => boolean),
}));
vi.mock("../core/record/l1-extractor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/record/l1-extractor.js")>();
  return {
    ...actual,
    extractL1Memories: async (params: Parameters<typeof actual.extractL1Memories>[0]) => {
      if (extractorHooks.throwFor?.(params.messages.map((m) => m.content))) {
        throw new Error("embedding service unavailable");
      }
      return actual.extractL1Memories(params);
    },
  };
});

const logger: PipelineLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const tmpDirs: string[] = [];
async function tmpDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "l1-pipeline-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  extractorHooks.throwFor = undefined;
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})));
});

/** Stub L0 store with configurable session groups; honors the L1 cursor. */
const CURSOR_MS = 1_700_000_000_000;
function stubStore(groups: Array<{ sessionId: string; content: string }>): IMemoryStore {
  const rows = groups.map((g, i) => ({
    sessionId: g.sessionId,
    teamId: undefined,
    taskId: undefined,
    userId: "",
    agentId: "",
    message: { id: `m-${i}`, role: "user" as const, content: g.content, timestamp: CURSOR_MS + i, recordedAtMs: CURSOR_MS + i },
  }));
  return {
    isDegraded: () => false,
    queryL0GroupedBySessionId: async (_sessionKey: string, l1Cursor?: number) => {
      const active = rows.filter((r) => r.message.recordedAtMs > (l1Cursor ?? 0));
      const bySession = new Map<string, typeof rows>();
      for (const r of active) {
        const list = bySession.get(r.sessionId) ?? [];
        list.push(r);
        bySession.set(r.sessionId, list);
      }
      return Array.from(bySession.entries()).map(([sessionId, list]) => ({
        sessionId,
        teamId: list[0]!.teamId,
        taskId: list[0]!.taskId,
        userId: list[0]!.userId,
        agentId: list[0]!.agentId,
        messages: list.map((r) => r.message),
      }));
    },
  } as unknown as IMemoryStore;
}

function makeCfg() {
  return {
    extraction: { enableDedup: false, maxMemoriesPerSession: 10, model: undefined, promptMode: "chat" },
    embedding: {},
  } as never; // MemoryTdaiConfig subset — only extraction/embedding fields are read here
}

function runnerReply(text: string): LLMRunner {
  return { run: async () => text };
}

function build(dataDir: string, llmRunner: LLMRunner, store: IMemoryStore = stubStore([{ sessionId: "sess-1", content: "用户说明天要去北京出差,顺便拜访客户" }])) {
  return pf.createL1Runner({
    pluginDataDir: dataDir,
    cfg: makeCfg(),
    openclawConfig: undefined,
    vectorStore: store,
    embeddingService: undefined,
    logger,
    llmRunner,
  });
}

async function readCursor(dataDir: string, sessionKey: string): Promise<number> {
  const checkpoint = new CheckpointManager(dataDir, logger);
  const cp = await checkpoint.read();
  return checkpoint.getRunnerState(cp, sessionKey).last_l1_cursor;
}

describe("createL1Runner failure semantics", () => {
  it("throws L1ExtractionFailedError and does NOT advance the cursor on a hard parse failure", async () => {
    const dataDir = await tmpDataDir();
    const l1Runner = build(dataDir, runnerReply("模型完全没输出 JSON,只是闲聊"));

    await expect(l1Runner({ sessionKey: "s-test" })).rejects.toMatchObject({
      name: "L1ExtractionFailedError",
      reason: "no_json",
      sessionKey: "s-test",
    });
    expect(await readCursor(dataDir, "s-test")).toBe(0); // cursor untouched → batch retried later
  });

  it("throws L1ExtractionFailedError on llm_error (runner throws) and keeps the cursor", async () => {
    const dataDir = await tmpDataDir();
    const throwing: LLMRunner = {
      run: async () => {
        throw new Error("upstream 503");
      },
    };
    const l1Runner = build(dataDir, throwing);

    await expect(l1Runner({ sessionKey: "s-test" })).rejects.toMatchObject({
      name: "L1ExtractionFailedError",
      reason: "llm_error",
    });
    expect(await readCursor(dataDir, "s-test")).toBe(0);
  });

  it("advances the checkpoint for a legit empty outcome (valid [])", async () => {
    const dataDir = await tmpDataDir();
    const l1Runner = build(dataDir, runnerReply("[]"));

    const result = await l1Runner({ sessionKey: "s-test" });

    expect(result.processedCount).toBe(1);
    expect(result.storedCount).toBe(0);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS); // advanced past the batch
  });

  it("L1ExtractionFailedError is exported as a class for pipeline consumers", () => {
    expect(pf.L1ExtractionFailedError).toBeInstanceOf(Function);
    const err = new pf.L1ExtractionFailedError("no_json", "s");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("no_json");
  });

  it("partial group failure advances the durable prefix — retry replays only the failed group, no duplicate writes", async () => {
    const dataDir = await tmpDataDir();
    const store = stubStore([
      { sessionId: "sess-A", content: "用户说明天要去北京出差,顺便拜访客户" },
      { sessionId: "sess-B", content: "用户提出了一个新的项目排期要求" },
    ]);
    const validFor = (sessionId: string) =>
      JSON.stringify([
          {
            scene_name: `情境-${sessionId}`,
            message_ids: [`m-${sessionId === "sess-A" ? 0 : 1}`],
            memories: [
              { content: `记忆:${sessionId}`, type: "episodic", priority: 80, source_message_ids: [], metadata: {} },
            ],
          },
        ]);

    // Attempt 1: group A extracts + stores fine, group B returns garbage.
    // Groups are processed in timestamp order (A's message at CURSOR_MS, B's at CURSOR_MS+1).
    const scriptedRunner: LLMRunner = {
      run: async (params) => {
        const prompt = params.prompt ?? "";
        if (prompt.includes("北京出差")) return validFor("sess-A");
        return "完全不是 JSON";
      },
    };
    const l1Runner = build(dataDir, scriptedRunner, store);

    await expect(l1Runner({ sessionKey: "s-test" })).rejects.toMatchObject({ reason: "no_json" });

    // Durable prefix: group A's message was fully processed → cursor advanced
    // to CURSOR_MS (A's message ms), strictly before B's pending message.
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS);
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1); // A stored exactly once

    // Attempt 2 (retry): cursor past A → only group B is re-queried and extracted.
    const retryRunner: LLMRunner = {
      run: async (params) => {
        const prompt = params.prompt ?? "";
        expect(prompt).not.toContain("北京出差"); // A must NOT be re-extracted
        return validFor("sess-B");
      },
    };
    const l1RunnerRetry = build(dataDir, retryRunner, store);
    const result = await l1RunnerRetry({ sessionKey: "s-test" });

    expect(result.storedCount).toBe(1);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 1); // batch fully drained
    // Idempotency: A was written exactly once across both attempts; B once.
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1);
    expect(await countRecords(dataDir, "记忆:sess-B")).toBe(1);
  });

  it("failure of the first group advances nothing — full batch retried", async () => {
    const dataDir = await tmpDataDir();
    const store = stubStore([
      { sessionId: "sess-A", content: "用户说明天要去北京出差,顺便拜访客户" },
      { sessionId: "sess-B", content: "用户提出了一个新的项目排期要求" },
    ]);
    const l1Runner = build(dataDir, runnerReply("完全不是 JSON"), store);

    await expect(l1Runner({ sessionKey: "s-test" })).rejects.toMatchObject({ reason: "no_json" });
    expect(await readCursor(dataDir, "s-test")).toBe(0); // no durable prefix
    expect(await countRecords(dataDir, "")).toBe(0); // nothing written
  });

  it("interleaved groups (A t1, B t2, A t3, B t4) — replay guard prevents re-writing A's tail on retry", async () => {
    const dataDir = await tmpDataDir();
    // Interleaved by recorded time: A(t1), B(t2), A(t3), B(t4).
    const store = stubStoreMessages([
      { sessionId: "sess-A", id: "a1", content: "用户说明天要去北京出差", ms: CURSOR_MS + 1 },
      { sessionId: "sess-B", id: "b1", content: "用户提出了一个新的项目排期要求", ms: CURSOR_MS + 2 },
      { sessionId: "sess-A", id: "a2", content: "用户补充出差要带演示设备", ms: CURSOR_MS + 3 },
      { sessionId: "sess-B", id: "b2", content: "用户强调排期要在周五前确认", ms: CURSOR_MS + 4 },
    ]);
    const validFor = (sessionId: string) =>
      JSON.stringify([{ scene_name: `情境-${sessionId}`, message_ids: [], memories: [{ content: `记忆:${sessionId}`, type: "episodic", priority: 80, source_message_ids: [], metadata: {} }] }]);

    // Attempt 1: group A (a1+a2) completes; group B fails.
    const scriptedRunner: LLMRunner = {
      run: async (params) => ((params.prompt ?? "").includes("北京出差") ? validFor("sess-A") : "完全不是 JSON"),
    };
    await expect(build(dataDir, scriptedRunner, store)({ sessionKey: "s-test" })).rejects.toMatchObject({ reason: "no_json" });

    // Durable prefix ends at t1 (B's t2 message is pending); a2 (t3) is past
    // the cursor → must be in the replay guard, not re-extracted on retry.
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 1);
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1);

    // Attempt 2: query > t1 returns b1,a2,b2 — the guard filters a2 out, so
    // ONLY group B is extracted; A's prompt never appears again.
    const retryRunner: LLMRunner = {
      run: async (params) => {
        expect(params.prompt ?? "").not.toContain("北京出差");
        expect(params.prompt ?? "").not.toContain("演示设备");
        return validFor("sess-B");
      },
    };
    const result = await build(dataDir, retryRunner, store)({ sessionKey: "s-test" });
    expect(result.storedCount).toBe(1);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 4);
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1); // still exactly one A record
    expect(await countRecords(dataDir, "记忆:sess-B")).toBe(1);
  });

  it("same-ms groups (A and B share t1) — cursor stays put, guard still prevents A replay", async () => {
    const dataDir = await tmpDataDir();
    const store = stubStoreMessages([
      { sessionId: "sess-A", id: "a1", content: "用户说明天要去北京出差", ms: CURSOR_MS },
      { sessionId: "sess-B", id: "b1", content: "用户提出了一个新的项目排期要求", ms: CURSOR_MS },
    ]);
    const validFor = (sessionId: string) =>
      JSON.stringify([{ scene_name: `情境-${sessionId}`, message_ids: [], memories: [{ content: `记忆:${sessionId}`, type: "episodic", priority: 80, source_message_ids: [], metadata: {} }] }]);

    const scriptedRunner: LLMRunner = {
      run: async (params) => ((params.prompt ?? "").includes("北京出差") ? validFor("sess-A") : "完全不是 JSON"),
    };
    await expect(build(dataDir, scriptedRunner, store)({ sessionKey: "s-test" })).rejects.toMatchObject({ reason: "no_json" });

    // Same-ms boundary: cursor cannot advance past A without skipping B.
    expect(await readCursor(dataDir, "s-test")).toBe(0);
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1);

    const retryRunner: LLMRunner = {
      run: async (params) => {
        expect(params.prompt ?? "").not.toContain("北京出差"); // guarded, not re-queried
        return validFor("sess-B");
      },
    };
    const result = await build(dataDir, retryRunner, store)({ sessionKey: "s-test" });
    expect(result.storedCount).toBe(1);
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1); // no duplicate A
    expect(await countRecords(dataDir, "记忆:sess-B")).toBe(1);
  });

  it("guard tail: completed group's last message above the failed group — third read must not re-write it", async () => {
    const dataDir = await tmpDataDir();
    // A(t1), B(t2), A(t3): A's tail (t3) lies ABOVE B's pending message.
    const store = stubStoreMessages([
      { sessionId: "sess-A", id: "a1", content: "用户说明天要去北京出差", ms: CURSOR_MS + 1 },
      { sessionId: "sess-B", id: "b1", content: "用户提出了一个新的项目排期要求", ms: CURSOR_MS + 2 },
      { sessionId: "sess-A", id: "a2", content: "用户补充出差行程细节", ms: CURSOR_MS + 3 },
    ]);
    const validFor = (sessionId: string) =>
      JSON.stringify([{ scene_name: `情境-${sessionId}`, message_ids: [], memories: [{ content: `记忆:${sessionId}`, type: "episodic", priority: 80, source_message_ids: [], metadata: {} }] }]);

    // First run: group A (a1+a2) completes, B fails → durable prefix t1, guard {a2}.
    const failBRunner: LLMRunner = {
      run: async (params) => ((params.prompt ?? "").includes("北京出差") ? validFor("sess-A") : "完全不是 JSON"),
    };
    await expect(build(dataDir, failBRunner, store)({ sessionKey: "s-test" })).rejects.toMatchObject({ reason: "no_json" });
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 1);
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1);

    // Retry run — B succeeds; a2 is guard-filtered. The success watermark
    // MUST cover a2's t3 too (max of processed + filtered), so the guard can
    // be cleared safely.
    const okRunner: LLMRunner = {
      run: async (params) => {
        expect(params.prompt ?? "").not.toContain("北京出差");
        return validFor("sess-B");
      },
    };
    await build(dataDir, okRunner, store)({ sessionKey: "s-test" });
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 3);

    // Third read — nothing pending, and crucially NO re-extraction of A.
    const sentinelRunner: LLMRunner = {
      run: async () => {
        throw new Error("no LLM call expected on the third read");
      },
    };
    const result = await build(dataDir, sentinelRunner, store)({ sessionKey: "s-test" });
    expect(result.processedCount).toBe(0);
    expect(result.storedCount).toBe(0);
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1); // never duplicated
  });

  it("retry delivers the earlier-succeeded group's L2 profile scope (merged with its own)", async () => {
    const dataDir = await tmpDataDir();
    const store = stubStore([
      { sessionId: "sess-A", content: "用户说明天要去北京出差,顺便拜访客户" },
      { sessionId: "sess-B", content: "用户提出了一个新的项目排期要求" },
    ]);
    const validFor = (sessionId: string) =>
      JSON.stringify([{ scene_name: `情境-${sessionId}`, message_ids: [], memories: [{ content: `记忆:${sessionId}`, type: "episodic", priority: 80, source_message_ids: [], metadata: {} }] }]);

    const scriptedRunner: LLMRunner = {
      run: async (params) => ((params.prompt ?? "").includes("北京出差") ? validFor("sess-A") : "完全不是 JSON"),
    };
    await expect(build(dataDir, scriptedRunner, store)({ sessionKey: "s-test" })).rejects.toMatchObject({ reason: "no_json" });

    // Retry succeeds for B: the result must carry BOTH scopes — B's own and
    // A's (persisted from the failed run whose throw never reached the
    // scheduler), so L2 is scheduled for every stored group.
    const retryRunner: LLMRunner = {
      run: async (params) => ((params.prompt ?? "").includes("排期") ? validFor("sess-B") : validFor("sess-B")),
    };
    const result = await build(dataDir, retryRunner, store)({ sessionKey: "s-test" });
    expect(result.profileScopes.some((s) => s.includes("sess-A"))).toBe(true);
    expect(result.profileScopes.some((s) => s.includes("sess-B"))).toBe(true);
  });

  it("does not cross unprocessed late arrivals to reach a guarded tail beyond the processing slice", async () => {
    const dataDir = await tmpDataDir();
    const rows = [
      { sessionId: "sess-A", id: "a1", content: "用户说明天要去北京出差", ms: CURSOR_MS + 1 },
      { sessionId: "sess-B", id: "b1", content: "用户提出了一个新的项目排期要求", ms: CURSOR_MS + 2 },
      { sessionId: "sess-A", id: "a2", content: "用户补充出差行程细节", ms: CURSOR_MS + 100 },
    ];
    const store = stubStoreMessages(rows);
    const validFor = (content: string) => JSON.stringify([{
        scene_name: "项目与行程安排",
        message_ids: [],
        memories: [{ content, type: "episodic", priority: 80, source_message_ids: [], metadata: {} }],
      }]);

    // A completes, including its t100 tail; B fails. Each subsequent attempt
    // gets a fresh runner and reads the durable checkpoint from disk.
    const failB: LLMRunner = {
      run: async (params) => (params.prompt ?? "").includes("北京出差")
        ? validFor("记忆:sess-A")
        : "完全不是 JSON",
    };
    await expect(build(dataDir, failB, store)({ sessionKey: "s-test" })).rejects.toMatchObject({ reason: "no_json" });
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 1);
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1);

    // Async writes made these earlier-recorded messages visible only after
    // the first attempt. They are all before the guarded tail, but only nine
    // fit alongside B in the next ten-message processing slice.
    const lateRows = Array.from({ length: 12 }, (_, index) => {
      const ms = index + 3;
      return {
        sessionId: "sess-B",
        id: `late-${ms}`,
        content: `用户补充项目排期中的待处理事项 late-${ms} 请在本周完成确认`,
        ms: CURSOR_MS + ms,
      };
    });
    rows.push(...lateRows);
    const prompts: string[] = [];
    const succeed: LLMRunner = {
      run: async (params) => {
        const prompt = params.prompt ?? "";
        expect(prompt).not.toContain("北京出差");
        expect(prompt).not.toContain("出差行程细节");
        prompts.push(prompt);
        return validFor(`记忆:sess-B-${prompts.length}`);
      },
    };

    const retry = await build(dataDir, succeed, store)({ sessionKey: "s-test" });
    expect(retry.processedCount).toBe(10);
    expect(retry.hasMore).toBe(true);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 11);
    const checkpoint = new CheckpointManager(dataDir, logger);
    expect(checkpoint.getRunnerState(await checkpoint.read(), "s-test").l1_replay_guard).toContain("a2");

    const remainder = await build(dataDir, succeed, store)({ sessionKey: "s-test" });
    expect(remainder.processedCount).toBe(3);
    expect(remainder.hasMore).toBe(false);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 100);
    expect(checkpoint.getRunnerState(await checkpoint.read(), "s-test").l1_replay_guard).toEqual([]);
    for (const row of lateRows) {
      expect(prompts.filter((prompt) => prompt.includes(row.content))).toHaveLength(1);
    }
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1);

    const drained = await build(dataDir, {
      run: async () => { throw new Error("no LLM call expected after all rows complete"); },
    }, store)({ sessionKey: "s-test" });
    expect(drained.processedCount).toBe(0);
  });

  it("over-fetches past guarded rows to process new messages and deliver pending scopes", async () => {
    const dataDir = await tmpDataDir();
    const guardedRows = Array.from({ length: 20 }, (_, index) => ({
      sessionId: "sess-A",
      id: `done-${index + 1}`,
      content: `用户已经确认了出差安排中的事项 done-${index + 1}`,
      ms: CURSOR_MS + index + 1,
    }));
    const store = stubStoreMessages([
      ...guardedRows,
      { sessionId: "sess-B", id: "pending-21", content: "用户新提出了一项需要完成的项目排期要求", ms: CURSOR_MS + 21 },
    ]);
    const checkpoint = new CheckpointManager(dataDir, logger);
    await checkpoint.markL1ExtractionComplete("s-test", 0, undefined, undefined, {
      replayGuard: guardedRows.map((row) => row.id),
      pendingProfileScopes: ["profile-scope-A"],
    });
    let calls = 0;
    const runner: LLMRunner = { run: async () => { calls++; return "[]"; } };

    const result = await build(dataDir, runner, store)({ sessionKey: "s-test" });
    expect(calls).toBe(1);
    expect(result.processedCount).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.hasFullBacklog).toBe(false);
    expect(result.profileScopes).toEqual(["profile-scope-A"]);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 21);
    expect(checkpoint.getRunnerState(await checkpoint.read(), "s-test").l1_replay_guard).toEqual([]);

    const drained = await build(dataDir, runner, store)({ sessionKey: "s-test" });
    expect(calls).toBe(1);
    expect(drained.processedCount).toBe(0);
  });

  it("completes an all-guarded window without an LLM call and still delivers pending scopes", async () => {
    const dataDir = await tmpDataDir();
    const rows = Array.from({ length: 20 }, (_, index) => ({
      sessionId: "sess-A",
      id: `done-${index + 1}`,
      content: `用户已经确认了出差安排中的事项 done-${index + 1}`,
      ms: CURSOR_MS + index + 1,
    }));
    const store = stubStoreMessages(rows);
    const checkpoint = new CheckpointManager(dataDir, logger);
    await checkpoint.markL1ExtractionComplete("s-test", 0, undefined, undefined, {
      replayGuard: rows.map((row) => row.id),
      pendingProfileScopes: ["profile-scope-A"],
    });
    const result = await build(dataDir, {
      run: async () => { throw new Error("already completed rows must never be sent to the LLM"); },
    }, store)({ sessionKey: "s-test" });

    expect(result.processedCount).toBe(0);
    expect(result.storedCount).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.hasFullBacklog).toBe(false);
    expect(result.profileScopes).toEqual(["profile-scope-A"]);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 20);
    const state = checkpoint.getRunnerState(await checkpoint.read(), "s-test");
    expect(state.l1_replay_guard).toEqual([]);
    expect(state.l1_pending_profile_scopes).toEqual([]);
  });

  it("drains more than one query page of same-millisecond messages exactly once, at most ten per attempt", async () => {
    const dataDir = await tmpDataDir();
    const rows = Array.from({ length: 21 }, (_, index) => ({
      sessionId: "sess-A",
      id: `collision-${index + 1}`,
      content: `用户提出本周需要完成的项目事项 collision-${index + 1} 请逐项核实排期`,
      ms: CURSOR_MS,
    }));
    const store = stubStoreMessages(rows);
    const prompts: string[] = [];
    const runner: LLMRunner = {
      run: async (params) => {
        const prompt = params.prompt ?? "";
        expect(rows.filter((row) => prompt.includes(row.content)).length).toBeLessThanOrEqual(10);
        prompts.push(prompt);
        return "[]";
      },
    };

    const first = await build(dataDir, runner, store)({ sessionKey: "s-test" });
    expect(first.processedCount).toBe(10);
    expect(first.hasFullBacklog).toBe(true);
    expect(await readCursor(dataDir, "s-test")).toBe(0);
    const checkpoint = new CheckpointManager(dataDir, logger);
    expect(checkpoint.getRunnerState(await checkpoint.read(), "s-test").l1_replay_guard).toHaveLength(10);

    const second = await build(dataDir, runner, store)({ sessionKey: "s-test" });
    expect(second.processedCount).toBe(10);
    expect(second.hasMore).toBe(true);
    expect(await readCursor(dataDir, "s-test")).toBe(0);
    expect(checkpoint.getRunnerState(await checkpoint.read(), "s-test").l1_replay_guard).toHaveLength(20);

    const third = await build(dataDir, runner, store)({ sessionKey: "s-test" });
    expect(third.processedCount).toBe(1);
    expect(third.hasMore).toBe(false);
    expect(third.hasFullBacklog).toBe(false);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS);
    expect(checkpoint.getRunnerState(await checkpoint.read(), "s-test").l1_replay_guard).toEqual([]);
    for (const row of rows) {
      expect(prompts.filter((prompt) => prompt.includes(row.content))).toHaveLength(1);
    }
    const drained = await build(dataDir, runner, store)({ sessionKey: "s-test" });
    expect(drained.processedCount).toBe(0);
    expect(prompts).toHaveLength(3);
  });

  it("degraded JSONL reads drain oldest recorded-time rows without loss despite independently reordered event timestamps", async () => {
    const dataDir = await tmpDataDir();
    const rows = Array.from({ length: 25 }, (_, index) => ({
      sessionKey: "s-test",
      sessionId: "sess-A",
      id: `jsonl-${index + 1}`,
      role: "user",
      content: `用户提出本周需要完成的项目事项 jsonl-${index + 1} 请逐项核实排期`,
      recordedAt: new Date(CURSOR_MS + index + 1).toISOString(),
      // Conversation order is independent of capture order; reverse each
      // event-time block. The old newest-event-time truncation omitted the
      // five oldest recorded rows from the first twenty-row query window.
      timestamp: CURSOR_MS + 1_000 + Math.floor(index / 5) * 5 + (4 - index % 5),
    }));
    const conversationsDir = path.join(dataDir, "conversations");
    await fs.mkdir(conversationsDir, { recursive: true });
    await fs.writeFile(
      path.join(conversationsDir, "2023-11-14.jsonl"),
      [...rows].reverse().map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    const degradedStore = { isDegraded: () => true } as unknown as IMemoryStore;
    const prompts: string[] = [];
    const runner: LLMRunner = {
      run: async (params) => {
        prompts.push(params.prompt ?? "");
        return "[]";
      },
    };

    const first = await build(dataDir, runner, degradedStore)({ sessionKey: "s-test" });
    expect(first.processedCount).toBe(10);
    expect(first.hasFullBacklog).toBe(true);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 10);
    expect(rows.filter((row) => prompts[0]!.includes(row.content)).map((row) => row.id))
      .toEqual(rows.slice(0, 10).map((row) => row.id));

    const second = await build(dataDir, runner, degradedStore)({ sessionKey: "s-test" });
    expect(second.processedCount).toBe(10);
    expect(second.hasMore).toBe(true);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 20);

    const third = await build(dataDir, runner, degradedStore)({ sessionKey: "s-test" });
    expect(third.processedCount).toBe(5);
    expect(third.hasMore).toBe(false);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 25);
    for (const row of rows) {
      expect(prompts.filter((prompt) => prompt.includes(row.content))).toHaveLength(1);
    }
    const drained = await build(dataDir, runner, degradedStore)({ sessionKey: "s-test" });
    expect(drained.processedCount).toBe(0);
    expect(prompts).toHaveLength(3);
  });

  it("retries a later-group failure among 21 same-millisecond rows without replaying successful inputs", async () => {
    const dataDir = await tmpDataDir();
    const rows = Array.from({ length: 21 }, (_, index) => ({
      sessionId: index < 5 ? "sess-A" : "sess-B",
      id: `same-ms-${index + 1}`,
      content: `用户提出项目排期事项 same-ms-${index < 5 ? "A" : "B"}-${index + 1} 请在周五前确认`,
      ms: CURSOR_MS,
    }));
    const store = stubStoreMessages(rows);
    const validFor = (content: string) => JSON.stringify([{
        scene_name: "项目安排",
        message_ids: [],
        memories: [{ content, type: "episodic", priority: 80, source_message_ids: [], metadata: {} }],
      }]);
    const successfulPrompts: string[] = [];
    const failLaterGroup: LLMRunner = {
      run: async (params) => {
        const prompt = params.prompt ?? "";
        if (!prompt.includes("same-ms-A-")) return "完全不是 JSON";
        successfulPrompts.push(prompt);
        return validFor("记忆:sess-A");
      },
    };
    await expect(build(dataDir, failLaterGroup, store)({ sessionKey: "s-test" }))
      .rejects.toMatchObject({ reason: "no_json" });
    expect(await readCursor(dataDir, "s-test")).toBe(0);
    const checkpoint = new CheckpointManager(dataDir, logger);
    expect(checkpoint.getRunnerState(await checkpoint.read(), "s-test").l1_replay_guard)
      .toEqual(rows.slice(0, 5).map((row) => row.id));

    const retry: LLMRunner = {
      run: async (params) => {
        const prompt = params.prompt ?? "";
        expect(prompt).not.toContain("same-ms-A-");
        expect(rows.filter((row) => prompt.includes(row.content)).length).toBeLessThanOrEqual(10);
        successfulPrompts.push(prompt);
        return validFor(`记忆:sess-B-${successfulPrompts.length}`);
      },
    };
    const second = await build(dataDir, retry, store)({ sessionKey: "s-test" });
    expect(second.processedCount).toBe(10);
    expect(second.hasMore).toBe(true);
    expect(await readCursor(dataDir, "s-test")).toBe(0);
    expect(checkpoint.getRunnerState(await checkpoint.read(), "s-test").l1_replay_guard).toHaveLength(15);
    expect(second.profileScopes.some((scope) => scope.includes("sess-A"))).toBe(true);

    const third = await build(dataDir, retry, store)({ sessionKey: "s-test" });
    expect(third.processedCount).toBe(6);
    expect(third.hasMore).toBe(false);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS);
    expect(checkpoint.getRunnerState(await checkpoint.read(), "s-test").l1_replay_guard).toEqual([]);
    // Failed B inputs are intentionally retried; every input belongs to
    // exactly one successful extraction, and successful A is never replayed.
    for (const row of rows) {
      expect(successfulPrompts.filter((prompt) => prompt.includes(row.content))).toHaveLength(1);
    }
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1);
    const drained = await build(dataDir, retry, store)({ sessionKey: "s-test" });
    expect(drained.processedCount).toBe(0);
    expect(successfulPrompts).toHaveLength(3);
  });
  it("drains legacy JSONL rows without ids using stable replay identities", async () => {
    const dataDir = await tmpDataDir();
    const rows = Array.from({ length: 21 }, (_, index) => ({
      sessionKey: "s-test",
      sessionId: "legacy-session",
      recordedAt: new Date(CURSOR_MS).toISOString(),
      role: "user",
      content: `用户提出需要完成的历史项目事项 legacy-${index + 1} 请逐项安排排期`,
      timestamp: CURSOR_MS + index,
    }));
    await fs.mkdir(path.join(dataDir, "conversations"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "conversations", "2023-11-14.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const store = { isDegraded: () => true } as unknown as IMemoryStore;
    const prompts: string[] = [];
    const runner: LLMRunner = { run: async (params) => { prompts.push(params.prompt); return "[]"; } };
    for (let attempt = 0; attempt < 3; attempt++) {
      await build(dataDir, runner, store)({ sessionKey: "s-test" });
    }
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS);
    for (const row of rows) {
      expect(prompts.filter((prompt) => prompt.includes(row.content))).toHaveLength(1);
    }
    expect((await build(dataDir, runner, store)({ sessionKey: "s-test" })).processedCount).toBe(0);
    expect(prompts).toHaveLength(3);
  });

  it("keeps different owners separate when degraded JSONL rows share a source session", async () => {
    const dataDir = await tmpDataDir();
    const storageDir = await tmpDataDir();
    const storage = new StorageAdapter(new LocalStorageBackend(storageDir));
    const owners = ["A", "B"].map((name, index) => ({
      sessionKey: "s-test",
      sessionId: "shared-session",
      teamId: `team-${name}`,
      taskId: `task-${name}`,
      userId: `user-${name}`,
      agentId: `agent-${name}`,
      recordedAt: new Date(CURSOR_MS + index + 1).toISOString(),
      id: `owned-${name}`,
      role: "user",
      content: `用户在讨论项目 owner-${name} 的客户拜访和排期安排`,
      timestamp: CURSOR_MS + index + 1,
    }));
    await storage.writeFile("conversations/2023-11-14.jsonl", owners.map((row) => JSON.stringify(row)).join("\n") + "\n");
    let calls = 0;
    const runner = pf.createL1Runner({
      pluginDataDir: dataDir,
      cfg: makeCfg(),
      openclawConfig: undefined,
      vectorStore: undefined,
      embeddingService: undefined,
      logger,
      storage,
      llmRunner: { run: async (params) => {
        const owner = params.prompt.includes("owner-A") ? owners[0]! : owners[1]!;
        expect(params.prompt).not.toContain(owner === owners[0] ? "owner-B" : "owner-A");
        calls++;
        return JSON.stringify([{
          scene_name: "客户拜访安排",
          message_ids: [owner.id],
          memories: [{ content: owner.content, type: "episodic", priority: 80, source_message_ids: [owner.id], metadata: {} }],
        }]);
      } },
    });
    const result = await runner({ sessionKey: "s-test" });
    expect(calls).toBe(2);
    expect(result.storedCount).toBe(2);
    expect(result.profileScopes).toHaveLength(2);
    const files = await fs.readdir(path.join(storageDir, "records"));
    const records = (await fs.readFile(path.join(storageDir, "records", files[0]!), "utf-8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    for (const owner of owners) {
      expect(records.find((record) => record.userId === owner.userId)).toMatchObject({
        teamId: owner.teamId, taskId: owner.taskId, agentId: owner.agentId, content: owner.content,
      });
    }
  });

  it("reads degraded L0 data through the configured storage adapter", async () => {
    const dataDir = await tmpDataDir();
    const storageDir = await tmpDataDir();
    const storage = new StorageAdapter(new LocalStorageBackend(storageDir));
    const content = "用户说明天要去北京出差并携带客户演示设备";
    await storage.writeFile("conversations/2023-11-14.jsonl", JSON.stringify({
      sessionKey: "s-test",
      sessionId: "sess-A",
      teamId: "team-A",
      taskId: "task-A",
      userId: "user-A",
      agentId: "agent-A",
      recordedAt: new Date(CURSOR_MS).toISOString(),
      id: "remote-l0",
      role: "user",
      content,
      timestamp: CURSOR_MS,
    }) + "\n");
    let calls = 0;
    const runner = pf.createL1Runner({
      pluginDataDir: dataDir,
      cfg: makeCfg(),
      openclawConfig: undefined,
      vectorStore: undefined,
      embeddingService: undefined,
      logger,
      storage,
      llmRunner: {
        run: async (params) => {
          expect(params.prompt).toContain(content);
          calls++;
          return JSON.stringify([{
            scene_name: "客户拜访安排",
            message_ids: ["remote-l0"],
            memories: [{ content, type: "episodic", priority: 80, source_message_ids: ["remote-l0"], metadata: {} }],
          }]);
        },
      },
    });
    const result = await runner({ sessionKey: "s-test" });
    expect(result.processedCount).toBe(1);
    expect(result.storedCount).toBe(1);
    expect(result.profileScopes).toEqual(["profile:team:team-A|agent:agent-A|session:sess-A"]);
    expect(calls).toBe(1);
    const recordFiles = await fs.readdir(path.join(storageDir, "records"));
    const stored = JSON.parse((await fs.readFile(path.join(storageDir, "records", recordFiles[0]!), "utf-8")).trim());
    expect(stored).toMatchObject({ teamId: "team-A", taskId: "task-A", userId: "user-A", agentId: "agent-A" });
    const checkpoint = new CheckpointManager(dataDir, logger, storage);
    expect(checkpoint.getRunnerState(await checkpoint.read(), "s-test").last_l1_cursor).toBe(CURSOR_MS);
    expect((await runner({ sessionKey: "s-test" })).processedCount).toBe(0);
    expect(calls).toBe(1);
  });
});

/** Stub store with fully explicit interleaved message rows (id + ms per row). */
function stubStoreMessages(rows: Array<{ sessionId: string; id: string; content: string; ms: number }>): IMemoryStore {
  return {
    isDegraded: () => false,
    queryL0GroupedBySessionId: async (_sessionKey: string, l1Cursor?: number, limit?: number) => {
      const active = rows
        .filter((r) => r.ms > (l1Cursor ?? 0))
        .sort((a, b) => a.ms - b.ms)
        .slice(0, limit ?? rows.length);
      const bySession = new Map<string, typeof rows>();
      for (const r of active) {
        const list = bySession.get(r.sessionId) ?? [];
        list.push(r);
        bySession.set(r.sessionId, list);
      }
      return Array.from(bySession.entries()).map(([sessionId, list]) => ({
        sessionId,
        teamId: undefined,
        taskId: undefined,
        userId: "",
        agentId: "",
        messages: list.map((r) => ({ id: r.id, role: "user" as const, content: r.content, timestamp: r.ms, recordedAtMs: r.ms })),
      }));
    },
  } as unknown as IMemoryStore;
}

async function countRecords(dataDir: string, contentIncludes: string): Promise<number> {
  const recordsDir = path.join(dataDir, "records");
  try {
    const files = await fs.readdir(recordsDir);
    let total = 0;
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const content = await fs.readFile(path.join(recordsDir, file), "utf-8");
      total += content
        .split("\n")
        .filter((line) => line.trim().length > 0 && line.includes(contentIncludes)).length;
    }
    return total;
  } catch {
    return 0;
  }
}

// ── Failure classification, retry delay and quarantine ──

const TRAVEL = "用户说明天要去北京出差,顺便拜访客户";
const SCHEDULE = "用户提出了一个新的项目排期要求";

function memoryFor(label: string): string {
  return JSON.stringify([{
    scene_name: `情境-${label}`,
    message_ids: [],
    memories: [{ content: `记忆:${label}`, type: "episodic", priority: 80, source_message_ids: [], metadata: {} }],
  }]);
}

function apiError(statusCode: number, message: string): APICallError {
  return new APICallError({ message, url: "https://llm.example/v1/chat", requestBodyValues: {}, statusCode });
}

function throwing(make: () => unknown): LLMRunner {
  return { run: async () => { throw make(); } };
}

/** Run once and return the thrown error, or undefined when the run succeeded. */
// The caught value is checked with toMatchObject; `any` keeps field access short in tests.
async function runAndCatch(run: () => Promise<unknown>): Promise<any> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return err;
  }
}

async function readState(dataDir: string, sessionKey = "s-test") {
  const checkpoint = new CheckpointManager(dataDir, logger);
  return checkpoint.getRunnerState(await checkpoint.read(), sessionKey);
}

function twoGroups(): IMemoryStore {
  return stubStore([
    { sessionId: "sess-A", content: TRAVEL },
    { sessionId: "sess-B", content: SCHEDULE },
  ]);
}

describe("createL1Runner transient failures", () => {
  it("keeps the cursor on a transient 503 and grows the retry delay after four failures, up to the cap", async () => {
    const dataDir = await tmpDataDir();
    const store = stubStore([{ sessionId: "sess-1", content: TRAVEL }]);
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      const err = await runAndCatch(() =>
        build(dataDir, throwing(() => apiError(503, "Service Unavailable")), store)({ sessionKey: "s-test" }));
      expect(err).toMatchObject({ name: "L1ExtractionFailedError", reason: "llm_error", failureClass: "transient" });
      delays.push(err.retryAfterMs);
    }
    expect(await readCursor(dataDir, "s-test")).toBe(0);
    expect(await countRecords(dataDir, "")).toBe(0);
    const base = pf.L1_REARM_BASE_MS;
    expect(delays).toEqual([base, base, base, base, base * 2, base * 4, base * 8, base * 16, pf.L1_REARM_CAP_MS]);
    const state = await readState(dataDir);
    expect(state.l1_failure).toMatchObject({
      group_key: "m-0",
      failure_class: "transient",
      det_attempts: 0,
      transient_streak: 9,
    });
    expect(state.l1_failure?.reason).toContain("status=503");
    expect(state.l1_quarantine).toEqual([]);

    // The provider is back: the same batch is extracted and the failure state clears.
    const ok = await build(dataDir, runnerReply(memoryFor("sess-1")), store)({ sessionKey: "s-test" });
    expect(ok.storedCount).toBe(1);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS);
    expect((await readState(dataDir)).l1_failure).toBeNull();
  });

  it("classifies AI_RetryError(429) as transient and does not change the deterministic counter", async () => {
    const dataDir = await tmpDataDir();
    const store = stubStore([{ sessionId: "sess-1", content: TRAVEL }]);
    const run = (runner: LLMRunner) => runAndCatch(() => build(dataDir, runner, store)({ sessionKey: "s-test" }));
    const rateLimited = () => new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [apiError(429, "Too Many Requests")],
    });

    expect(await run(runnerReply("完全不是 JSON"))).toMatchObject({ failureClass: "deterministic" });
    expect((await readState(dataDir)).l1_failure).toMatchObject({ det_attempts: 1, transient_streak: 0 });

    const transient = await run(throwing(rateLimited));
    expect(transient).toMatchObject({ name: "L1ExtractionFailedError", failureClass: "transient", groupKey: "m-0" });
    expect((await readState(dataDir)).l1_failure).toMatchObject({
      failure_class: "transient",
      det_attempts: 1,
      transient_streak: 1,
    });
    expect((await readState(dataDir)).l1_failure?.reason).toContain("status=429");

    expect(await run(runnerReply("完全不是 JSON"))).toMatchObject({ failureClass: "deterministic" });
    expect((await readState(dataDir)).l1_failure).toMatchObject({ det_attempts: 2, transient_streak: 0 });
    expect(await readCursor(dataDir, "s-test")).toBe(0);
  });

  it.each([
    [401, "Unauthorized"],
    [404, "Not Found"],
  ])("never quarantines a %i (operator configuration) failure", async (status, message) => {
    const dataDir = await tmpDataDir();
    const store = stubStore([{ sessionId: "sess-1", content: TRAVEL }]);
    for (let i = 0; i < 10; i++) {
      const err = await runAndCatch(() =>
        build(dataDir, throwing(() => apiError(status, message)), store)({ sessionKey: "s-test" }));
      expect(err).toMatchObject({ name: "L1ExtractionFailedError", failureClass: "transient" });
    }
    const state = await readState(dataDir);
    expect(state.l1_quarantine).toEqual([]);
    expect(state.l1_replay_guard).toEqual([]);
    expect(state.l1_failure).toMatchObject({ det_attempts: 0, transient_streak: 10 });
    expect(await readCursor(dataDir, "s-test")).toBe(0);
  });

  it("partial failure: A stored, B fails transiently — retry extracts only B and delivers A's scope", async () => {
    const dataDir = await tmpDataDir();
    const store = twoGroups();
    const failB: LLMRunner = {
      run: async (params) => {
        if (params.prompt.includes("北京出差")) return memoryFor("sess-A");
        throw apiError(503, "Service Unavailable");
      },
    };
    await expect(build(dataDir, failB, store)({ sessionKey: "s-test" })).rejects.toMatchObject({
      name: "L1ExtractionFailedError",
      failureClass: "transient",
    });
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS);
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1);

    const prompts: string[] = [];
    const retry = await build(dataDir, {
      run: async (params) => { prompts.push(params.prompt); return memoryFor("sess-B"); },
    }, store)({ sessionKey: "s-test" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("北京出差");
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1);
    expect(await countRecords(dataDir, "记忆:sess-B")).toBe(1);
    expect(retry.profileScopes.some((s) => s.includes("sess-A"))).toBe(true);
    expect(retry.profileScopes.some((s) => s.includes("sess-B"))).toBe(true);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 1);
    const state = await readState(dataDir);
    expect(state.l1_pending_profile_scopes).toEqual([]);
    expect(state.l1_failure).toBeNull();
  });

  it("an exception thrown inside group B keeps A's progress — no duplicate of A on retry", async () => {
    const dataDir = await tmpDataDir();
    const store = twoGroups();
    const runner: LLMRunner = {
      run: async (params) => memoryFor(params.prompt.includes("北京出差") ? "sess-A" : "sess-B"),
    };
    extractorHooks.throwFor = (contents) => contents.some((c) => c.includes("排期"));
    await expect(build(dataDir, runner, store)({ sessionKey: "s-test" })).rejects.toMatchObject({
      name: "L1ExtractionFailedError",
      reason: "exception",
      failureClass: "transient",
    });
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS);
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1);
    expect((await readState(dataDir)).l1_failure?.reason).toContain("embedding service unavailable");

    extractorHooks.throwFor = undefined;
    const retry = await build(dataDir, runner, store)({ sessionKey: "s-test" });
    expect(retry.storedCount).toBe(1);
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1);
    expect(await countRecords(dataDir, "记忆:sess-B")).toBe(1);
    expect(retry.profileScopes.some((s) => s.includes("sess-A"))).toBe(true);
  });

  it("a legit empty answer advances the cursor and clears the failure state", async () => {
    const dataDir = await tmpDataDir();
    const store = stubStore([{ sessionId: "sess-1", content: TRAVEL }]);
    await expect(build(dataDir, throwing(() => apiError(503, "Service Unavailable")), store)({ sessionKey: "s-test" }))
      .rejects.toMatchObject({ failureClass: "transient" });
    expect((await readState(dataDir)).l1_failure).not.toBeNull();

    const result = await build(dataDir, runnerReply("[]"), store)({ sessionKey: "s-test" });
    expect(result.processedCount).toBe(1);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS);
    expect((await readState(dataDir)).l1_failure).toBeNull();
  });
});

describe("createL1Runner empty reads", () => {
  it("keeps the replay guard and failure state when the L0 query returns no rows", async () => {
    const dataDir = await tmpDataDir();
    const rows = [
      { sessionId: "sess-A", id: "a1", content: TRAVEL, ms: CURSOR_MS },
      { sessionId: "sess-B", id: "b1", content: SCHEDULE, ms: CURSOR_MS },
    ];
    const healthy = stubStoreMessages(rows);
    // Stores return [] when their query fails, so an empty read can hide data.
    const hiccup = stubStoreMessages([]);
    const failB: LLMRunner = {
      run: async (params) => {
        if (params.prompt.includes("北京出差")) return memoryFor("sess-A");
        throw apiError(503, "Service Unavailable");
      },
    };
    await expect(build(dataDir, failB, healthy)({ sessionKey: "s-test" })).rejects.toMatchObject({ failureClass: "transient" });
    const before = await readState(dataDir);
    expect(before.l1_replay_guard).toEqual(["a1"]);
    expect(before.l1_failure).not.toBeNull();

    const empty = await build(dataDir, throwing(() => new Error("no LLM call expected")), hiccup)({ sessionKey: "s-test" });
    expect(empty.processedCount).toBe(0);
    const after = await readState(dataDir);
    expect(after.l1_replay_guard).toEqual(["a1"]);
    expect(after.l1_failure).toEqual(before.l1_failure);
    expect(after.l1_pending_profile_scopes).toEqual(before.l1_pending_profile_scopes);
    expect(after.last_l1_cursor).toBe(before.last_l1_cursor);

    const prompts: string[] = [];
    await build(dataDir, { run: async (params) => { prompts.push(params.prompt); return memoryFor("sess-B"); } }, healthy)({ sessionKey: "s-test" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("北京出差");
    expect(await countRecords(dataDir, "记忆:sess-A")).toBe(1);
    expect(await countRecords(dataDir, "记忆:sess-B")).toBe(1);
  });
});

describe("createL1Runner deterministic failures and quarantine", () => {
  it.each([
    ["no_json", (): string => "完全不是 JSON", "no_json"],
    ["context-length 400", (): string => { throw apiError(400, "This model's maximum context length is 8192 tokens"); }, "status=400"],
  ] as const)("quarantines a group after three %s failures and extracts the next group", async (_label, failA, reasonPart) => {
    const dataDir = await tmpDataDir();
    const store = twoGroups();
    const runner: LLMRunner = {
      run: async (params) => (params.prompt.includes("北京出差") ? failA() : memoryFor("sess-B")),
    };
    for (let attempt = 1; attempt < pf.L1_QUARANTINE_AFTER; attempt++) {
      const err = await runAndCatch(() => build(dataDir, runner, store)({ sessionKey: "s-test" }));
      expect(err).toMatchObject({ name: "L1ExtractionFailedError", failureClass: "deterministic", groupKey: "m-0" });
      expect((await readState(dataDir)).l1_failure).toMatchObject({ det_attempts: attempt, failure_class: "deterministic" });
      expect(await readCursor(dataDir, "s-test")).toBe(0);
    }

    const errors: string[] = [];
    const third = await pf.createL1Runner({
      pluginDataDir: dataDir,
      cfg: makeCfg(),
      openclawConfig: undefined,
      vectorStore: store,
      embeddingService: undefined,
      logger: { ...logger, error: (m: string) => { errors.push(m); } },
      llmRunner: runner,
    })({ sessionKey: "s-test" });

    expect(third.storedCount).toBe(1);
    expect(await countRecords(dataDir, "记忆:sess-B")).toBe(1);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 1); // past the quarantined group
    const state = await readState(dataDir);
    expect(state.l1_failure).toBeNull();
    expect(state.l1_replay_guard).toEqual([]); // the cursor covers the quarantined ids
    expect(state.l1_quarantine).toHaveLength(1);
    expect(state.l1_quarantine[0]).toMatchObject({
      session_id: "sess-A",
      message_ids: ["m-0"],
      first_ms: CURSOR_MS,
      last_ms: CURSOR_MS,
      attempts: pf.L1_QUARANTINE_AFTER,
    });
    expect(state.l1_quarantine[0]!.reason).toContain(reasonPart);
    expect(errors.some((m) => m.includes("l1-quarantine") && m.includes("ids=m-0") && m.includes("sessionId=sess-A"))).toBe(true);

    // The quarantined group is not sent again.
    const sentinel = await build(dataDir, throwing(() => new Error("no LLM call expected")), store)({ sessionKey: "s-test" });
    expect(sentinel.processedCount).toBe(0);
  });

  it("guards quarantined ids when a same-ms pending sibling blocks the cursor", async () => {
    const dataDir = await tmpDataDir();
    const store = stubStoreMessages([
      { sessionId: "sess-A", id: "a1", content: TRAVEL, ms: CURSOR_MS },
      { sessionId: "sess-B", id: "b1", content: SCHEDULE, ms: CURSOR_MS },
    ]);
    const badA: LLMRunner = {
      run: async (params) => {
        if (params.prompt.includes("北京出差")) return "完全不是 JSON";
        throw apiError(503, "Service Unavailable");
      },
    };
    for (let attempt = 1; attempt < pf.L1_QUARANTINE_AFTER; attempt++) {
      await expect(build(dataDir, badA, store)({ sessionKey: "s-test" })).rejects.toMatchObject({ failureClass: "deterministic" });
    }
    // Third run: A is quarantined, then B fails transiently.
    await expect(build(dataDir, badA, store)({ sessionKey: "s-test" })).rejects.toMatchObject({
      failureClass: "transient",
      groupKey: "b1",
    });
    let state = await readState(dataDir);
    expect(state.last_l1_cursor).toBe(0);
    expect(state.l1_replay_guard).toEqual(["a1"]);
    expect(state.l1_quarantine.map((q) => q.message_ids)).toEqual([["a1"]]);
    expect(state.l1_failure).toMatchObject({ group_key: "b1", det_attempts: 0, transient_streak: 1 });

    const prompts: string[] = [];
    await build(dataDir, { run: async (params) => { prompts.push(params.prompt); return memoryFor("sess-B"); } }, store)({ sessionKey: "s-test" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("北京出差");
    state = await readState(dataDir);
    expect(state.last_l1_cursor).toBe(CURSOR_MS);
    expect(state.l1_replay_guard).toEqual([]);
    expect(state.l1_failure).toBeNull();
  });

  it("resets the deterministic counter when a different group fails", async () => {
    const dataDir = await tmpDataDir();
    const store = twoGroups();
    await expect(build(dataDir, runnerReply("完全不是 JSON"), store)({ sessionKey: "s-test" }))
      .rejects.toMatchObject({ failureClass: "deterministic", groupKey: "m-0" });
    expect((await readState(dataDir)).l1_failure).toMatchObject({ group_key: "m-0", det_attempts: 1 });

    const failB: LLMRunner = {
      run: async (params) => (params.prompt.includes("北京出差") ? memoryFor("sess-A") : "完全不是 JSON"),
    };
    await expect(build(dataDir, failB, store)({ sessionKey: "s-test" }))
      .rejects.toMatchObject({ failureClass: "deterministic", groupKey: "m-1" });
    expect((await readState(dataDir)).l1_failure).toMatchObject({ group_key: "m-1", det_attempts: 1 });
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS);
  });

  it("treats a valid array whose memories all have invalid types as a deterministic failure", async () => {
    const dataDir = await tmpDataDir();
    const store = stubStore([{ sessionId: "sess-1", content: TRAVEL }]);
    const reply = JSON.stringify([{
      scene_name: "x",
      message_ids: [],
      memories: [{ content: "记忆", type: "not-a-type", priority: 80, source_message_ids: [], metadata: {} }],
    }]);
    await expect(build(dataDir, runnerReply(reply), store)({ sessionKey: "s-test" })).rejects.toMatchObject({
      reason: "normalized_all_dropped",
      failureClass: "deterministic",
    });
    expect(await readCursor(dataDir, "s-test")).toBe(0);
  });
});

describe("createL1Runner replay guard and pending scope bounds", () => {
  it("drops guard ids outside a page that is not full, and keeps them while the page is full", async () => {
    const dataDir = await tmpDataDir();
    const rows = Array.from({ length: 25 }, (_, index) => ({
      sessionId: "sess-A",
      id: `row-${index + 1}`,
      content: `用户提出本周需要完成的项目事项 row-${index + 1} 请逐项核实排期`,
      ms: CURSOR_MS + index + 1,
    }));
    const store = stubStoreMessages(rows);
    const checkpoint = new CheckpointManager(dataDir, logger);
    await checkpoint.markL1ExtractionComplete("s-test", 0, undefined, undefined, { replayGuard: ["gone-1"] });

    // queryLimit = 20 + 1 guard id → the page of 21 rows is full: keep the unknown id.
    await build(dataDir, runnerReply("[]"), store)({ sessionKey: "s-test" });
    expect((await readState(dataDir)).l1_replay_guard).toEqual(["gone-1"]);

    // 15 rows left → not full: the unknown id is at or before the cursor (or deleted).
    await build(dataDir, runnerReply("[]"), store)({ sessionKey: "s-test" });
    expect((await readState(dataDir)).l1_replay_guard).toEqual([]);
    await build(dataDir, runnerReply("[]"), store)({ sessionKey: "s-test" });
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS + 25);
  });

  it("drains more than 520 rows that share one recorded_at_ms: each row extracted once, none skipped", async () => {
    const dataDir = await tmpDataDir();
    const rows = Array.from({ length: 600 }, (_, index) => ({
      sessionId: "sess-A",
      id: `bulk-${index + 1}`,
      content: `用户导入的历史项目事项 bulk-${index + 1} 需要逐项确认排期`,
      ms: CURSOR_MS,
    }));
    const store = stubStoreMessages(rows);
    const seen = new Map<string, number>();
    const runner: LLMRunner = {
      run: async (params) => {
        for (const row of rows) {
          if (params.prompt.includes(`${row.id} `)) seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
        }
        return "[]";
      },
    };
    let runs = 0;
    let last: { processedCount: number } | undefined;
    // 600 rows at 10 per run need 60 runs plus one empty run. The bound
    // stops a livelock from looping for ever.
    while (runs < 80) {
      runs++;
      last = await build(dataDir, runner, store)({ sessionKey: "s-test" });
      if (last.processedCount === 0) break;
    }
    expect(last?.processedCount).toBe(0);
    expect(runs).toBe(61);
    expect(seen.size).toBe(rows.length);
    expect([...seen.values()].every((count) => count === 1)).toBe(true);
    expect(await readCursor(dataDir, "s-test")).toBe(CURSOR_MS);
    expect((await readState(dataDir)).l1_replay_guard).toEqual([]);
  });

  it("caps pending profile scopes at L1_PENDING_SCOPES_MAX and warns", async () => {
    const dataDir = await tmpDataDir();
    const oldScopes = Array.from({ length: 250 }, (_, i) => `scope-${i}`);
    const checkpoint = new CheckpointManager(dataDir, logger);
    await checkpoint.markL1ExtractionComplete("s-test", 0, undefined, undefined, { pendingProfileScopes: oldScopes });
    const warnings: string[] = [];
    const failB: LLMRunner = {
      run: async (params) => {
        if (params.prompt.includes("北京出差")) return memoryFor("sess-A");
        throw apiError(503, "Service Unavailable");
      },
    };
    await expect(pf.createL1Runner({
      pluginDataDir: dataDir,
      cfg: makeCfg(),
      openclawConfig: undefined,
      vectorStore: twoGroups(),
      embeddingService: undefined,
      logger: { ...logger, warn: (m: string) => { warnings.push(m); } },
      llmRunner: failB,
    })({ sessionKey: "s-test" })).rejects.toMatchObject({ failureClass: "transient" });
    const scopes = (await readState(dataDir)).l1_pending_profile_scopes;
    expect(scopes).toHaveLength(pf.L1_PENDING_SCOPES_MAX);
    expect(scopes[scopes.length - 1]).toContain("sess-A"); // the newest scope is kept
    expect(warnings.some((m) => m.includes("Pending profile scopes"))).toBe(true);
  });
});

describe("CheckpointManager L1 bookkeeping", () => {
  it("merges guard and pending scopes when a stale cursor write is detected", async () => {
    const dataDir = await tmpDataDir();
    const checkpoint = new CheckpointManager(dataDir, logger);
    await checkpoint.markL1ExtractionComplete("s", 0, 2_000, undefined, { replayGuard: ["x"], pendingProfileScopes: ["p1"] });
    await checkpoint.markL1ExtractionComplete("s", 0, 1_000, undefined, { replayGuard: ["y"], pendingProfileScopes: ["p2"] });
    let state = await readState(dataDir, "s");
    expect(state.last_l1_cursor).toBe(2_000);
    expect(state.l1_replay_guard).toEqual(["x", "y"]);
    expect(state.l1_pending_profile_scopes).toEqual(["p1", "p2"]);

    // A normal (not stale) write replaces both values.
    await checkpoint.markL1ExtractionComplete("s", 0, 3_000, undefined, { replayGuard: ["z"], pendingProfileScopes: [] });
    state = await readState(dataDir, "s");
    expect(state.l1_replay_guard).toEqual(["z"]);
    expect(state.l1_pending_profile_scopes).toEqual([]);
  });

  it("keeps failure state when omitted, clears it with null, and trims the quarantine log", async () => {
    const dataDir = await tmpDataDir();
    const checkpoint = new CheckpointManager(dataDir, logger);
    const failure = {
      group_key: "g", failure_class: "transient" as const, reason: "llm_error", det_attempts: 0,
      transient_streak: 1, first_at: 1, last_at: 1,
    };
    const record = (i: number) => ({
      at: i, user_id: "", agent_id: "", session_id: "s", message_ids: [`m-${i}`], first_ms: i, last_ms: i, reason: "no_json", attempts: 3,
    });
    await checkpoint.markL1ExtractionComplete("s", 0, undefined, undefined, {
      failure,
      quarantineAppend: Array.from({ length: 30 }, (_, i) => record(i)),
    });
    await checkpoint.markL1ExtractionComplete("s", 0, undefined, undefined, {
      quarantineAppend: Array.from({ length: 30 }, (_, i) => record(30 + i)),
    });
    let state = await readState(dataDir, "s");
    expect(state.l1_failure).toEqual(failure);
    expect(state.l1_quarantine).toHaveLength(50);
    expect(state.l1_quarantine[0]!.at).toBe(10);
    expect(state.l1_quarantine[49]!.at).toBe(59);

    await checkpoint.markL1ExtractionComplete("s", 0, undefined, undefined, { failure: null });
    state = await readState(dataDir, "s");
    expect(state.l1_failure).toBeNull();
    expect(state.l1_quarantine).toHaveLength(50);

    // The plain call (no bookkeeping) keeps working and clears only guard/scopes.
    await checkpoint.markL1ExtractionComplete("s", 1, 5_000, "scene");
    state = await readState(dataDir, "s");
    expect(state.last_l1_cursor).toBe(5_000);
    expect(state.l1_quarantine).toHaveLength(50);
  });

  it("reads an old checkpoint without the new fields and does not share default arrays", async () => {
    const dataDir = await tmpDataDir();
    const checkpoint = new CheckpointManager(dataDir, logger);
    // Write one session through the manager, then strip the new fields to
    // simulate a checkpoint written by an older release.
    await checkpoint.markL1ExtractionComplete("old-a", 0, 1_000, "scene");
    await checkpoint.markL1ExtractionComplete("old-b", 0, 1_000, "scene");
    const file = await findCheckpointFile(dataDir);
    const raw = JSON.parse(await fs.readFile(file, "utf-8"));
    for (const state of Object.values(raw.runner_states) as Array<Record<string, unknown>>) {
      delete state.l1_replay_guard;
      delete state.l1_pending_profile_scopes;
      delete state.l1_failure;
      delete state.l1_quarantine;
    }
    await fs.writeFile(file, JSON.stringify(raw));

    const cp = await checkpoint.read();
    const a = checkpoint.getRunnerState(cp, "old-a");
    const b = checkpoint.getRunnerState(cp, "old-b");
    expect(a).toMatchObject({ last_l1_cursor: 1_000, l1_replay_guard: [], l1_pending_profile_scopes: [], l1_failure: null, l1_quarantine: [] });
    a.l1_replay_guard.push("mutated");
    expect(b.l1_replay_guard).toEqual([]);
    expect(checkpoint.getRunnerState(cp, "new-session").l1_replay_guard).toEqual([]);
  });
});

async function findCheckpointFile(dataDir: string): Promise<string> {
  const stack = [dataDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.includes("checkpoint") && entry.name.endsWith(".json")) return full;
    }
  }
  throw new Error(`checkpoint file not found under ${dataDir}`);
}

describe("createL1Runner errors outside the group loop", () => {
  it("turns an L0 query error into a transient L1ExtractionFailedError and keeps the guard", async () => {
    const dataDir = await tmpDataDir();
    const checkpoint = new CheckpointManager(dataDir, logger);
    await checkpoint.markL1ExtractionComplete("s-test", 0, CURSOR_MS, undefined, {
      replayGuard: ["a2"],
      pendingProfileScopes: ["scope-A"],
    });
    const broken = {
      isDegraded: () => false,
      queryL0GroupedBySessionId: async () => { throw new Error("connection reset by store"); },
    } as unknown as IMemoryStore;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const err = await runAndCatch(() => build(dataDir, runnerReply("[]"), broken)({ sessionKey: "s-test" }));
      expect(err).toMatchObject({
        name: "L1ExtractionFailedError",
        reason: "exception",
        failureClass: "transient",
        retryAfterMs: pf.L1_REARM_BASE_MS,
      });
      expect(err.cause).toBeInstanceOf(Error);
      const state = await readState(dataDir);
      expect(state.l1_failure).toMatchObject({ failure_class: "transient", transient_streak: attempt });
      expect(state.l1_failure?.reason).toContain("connection reset by store");
      expect(state.l1_replay_guard).toEqual(["a2"]);
      expect(state.l1_pending_profile_scopes).toEqual(["scope-A"]);
      expect(state.last_l1_cursor).toBe(CURSOR_MS);
    }
  });
});

describe("persistence failures", () => {
  function failingAppendStorage(dir: string, fail: { on: boolean }): StorageAdapter {
    const storage = new StorageAdapter(new LocalStorageBackend(dir));
    const append = storage.appendFile.bind(storage);
    storage.appendFile = async (key: string, content: string) => {
      if (fail.on && key.startsWith("records")) throw new Error("COS append failed");
      return append(key, content);
    };
    return storage;
  }

  it("does not move the cursor when no store kept the memory, and stores it on retry", async () => {
    const dataDir = await tmpDataDir();
    const fail = { on: true };
    const storage = failingAppendStorage(dataDir, fail);
    // The stub store has no upsertL1, so the vector write fails too.
    const store = stubStore([{ sessionId: "sess-1", content: TRAVEL }]);
    const run = () => pf.createL1Runner({
      pluginDataDir: dataDir,
      cfg: makeCfg(),
      openclawConfig: undefined,
      vectorStore: store,
      embeddingService: undefined,
      logger,
      storage,
      llmRunner: runnerReply(memoryFor("sess-1")),
    })({ sessionKey: "s-test" });

    await expect(run()).rejects.toMatchObject({
      name: "L1ExtractionFailedError",
      reason: "exception",
      failureClass: "transient",
    });
    const checkpoint = new CheckpointManager(dataDir, logger, storage);
    const state = checkpoint.getRunnerState(await checkpoint.read(), "s-test");
    expect(state.last_l1_cursor).toBe(0);
    expect(state.l1_failure?.reason).toContain("no persistence target");
    expect(await countRecords(dataDir, "记忆:sess-1")).toBe(0);

    fail.on = false;
    const ok = await run();
    expect(ok.storedCount).toBe(1);
    expect(await countRecords(dataDir, "记忆:sess-1")).toBe(1);
    expect(checkpoint.getRunnerState(await checkpoint.read(), "s-test").last_l1_cursor).toBe(CURSOR_MS);
  });

  describe("writeMemory", () => {
    const memory = {
      content: "用户决定前端框架从 Vue 2 迁移到 Vue 3",
      type: "episodic" as const,
      priority: 80,
      source_message_ids: ["msg-1"],
      metadata: {},
      scene_name: "default",
    };
    const decision = { record_id: "r1", action: "store" as const, target_ids: [] };
    const failingStorage = { appendFile: async () => { throw new Error("append failed"); } } as unknown as StorageAdapter;
    const okStorage = { appendFile: async () => {} } as unknown as StorageAdapter;
    const vector = (upsertL1: () => Promise<boolean>) => ({ upsertL1 } as unknown as IMemoryStore);

    it("throws L1PersistenceError when the JSONL append fails and there is no vector store", async () => {
      await expect(writeMemory({ memory, decision, baseDir: "/tmp", sessionKey: "s", storage: failingStorage }))
        .rejects.toMatchObject({ name: "L1PersistenceError" });
    });

    it("throws L1PersistenceError when the JSONL append fails and the vector upsert fails", async () => {
      await expect(writeMemory({ memory, decision, baseDir: "/tmp", sessionKey: "s", storage: failingStorage, vectorStore: vector(async () => false) }))
        .rejects.toMatchObject({ name: "L1PersistenceError" });
      await expect(writeMemory({ memory, decision, baseDir: "/tmp", sessionKey: "s", storage: failingStorage, vectorStore: vector(async () => { throw new Error("vdb down"); }) }))
        .rejects.toThrow(/jsonl: append failed; vector: vdb down/);
    });

    it("returns the record when at least one target stored it", async () => {
      const viaVector = await writeMemory({ memory, decision, baseDir: "/tmp", sessionKey: "s", storage: failingStorage, vectorStore: vector(async () => true) });
      expect(viaVector?.content).toBe(memory.content);
      const viaJsonl = await writeMemory({ memory, decision, baseDir: "/tmp", sessionKey: "s", storage: okStorage, vectorStore: vector(async () => { throw new Error("vdb down"); }) });
      expect(viaJsonl?.content).toBe(memory.content);
    });
  });
});
