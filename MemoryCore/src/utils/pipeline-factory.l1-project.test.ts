/**
 * The L1 runner tags an extracted memory with a project only when all of its
 * source L0 messages carry the same project. Project never splits a batch.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as pf from "./pipeline-factory.js";
import type { PipelineLogger } from "./pipeline-factory.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { MemoryRecord } from "../core/record/l1-writer.js";
import type { LLMRunner } from "../core/types.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";

const logger: PipelineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const PROJECT_A = { projectKey: "git:github.com/acme/app", projectHash: "0123456789abcdef" };
const PROJECT_B = { projectKey: "git:github.com/acme/other", projectHash: "fedcba9876543210" };
const BASE_MS = 1_700_000_000_000;

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "l1-project-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})));
});

function makeCfg() {
  return {
    extraction: { enableDedup: false, maxMemoriesPerSession: 10, model: undefined, promptMode: "chat" },
    embedding: {},
  } as never; // MemoryTdaiConfig subset — only extraction/embedding fields are read here
}

type Project = { projectKey: string; projectHash: string } | undefined;

const MESSAGES: Array<{ id: string; content: string; project: Project }> = [
  { id: "m-a1", content: "用户正在为项目 alpha 设计新的缓存层并比较方案", project: PROJECT_A },
  { id: "m-a2", content: "用户确认项目 alpha 的缓存层使用本地磁盘存储", project: PROJECT_A },
  { id: "m-b1", content: "用户切换到项目 beta 并开始排查构建失败的原因", project: PROJECT_B },
  { id: "m-n1", content: "用户随后询问一个没有项目的通用 shell 命令用法", project: undefined },
];

/** One LLM reply with one memory per source selection. */
function replyWith(selections: Record<string, string[]>): LLMRunner {
  return {
    run: async () => JSON.stringify([{
      scene_name: "项目工作",
      message_ids: MESSAGES.map((m) => m.id),
      memories: Object.entries(selections).map(([content, ids]) => ({
        content, type: "episodic", priority: 80, source_message_ids: ids, metadata: {},
      })),
    }]),
  };
}

function dbStore(messages: typeof MESSAGES, upserted: MemoryRecord[]): IMemoryStore {
  return {
    isDegraded: () => false,
    upsertL1: async (record: MemoryRecord) => { upserted.push(record); return true; },
    queryL0GroupedBySessionId: async () => [{
      sessionId: "sess-1",
      teamId: "team-1",
      taskId: undefined,
      userId: "user-1",
      agentId: "agent-1",
      messages: messages.map((m, i) => ({
        id: m.id,
        role: "user" as const,
        content: m.content,
        timestamp: BASE_MS + i,
        recordedAtMs: BASE_MS + i,
        projectKey: m.project?.projectKey,
        projectHash: m.project?.projectHash,
      })),
    }],
  } as unknown as IMemoryStore;
}

async function runDb(messages: typeof MESSAGES, llmRunner: LLMRunner): Promise<MemoryRecord[]> {
  const upserted: MemoryRecord[] = [];
  const runner = pf.createL1Runner({
    pluginDataDir: await tmpDir(),
    cfg: makeCfg(),
    openclawConfig: undefined,
    vectorStore: dbStore(messages, upserted),
    embeddingService: undefined,
    logger,
    storage: new StorageAdapter(new LocalStorageBackend(await tmpDir())),
    llmRunner,
  });
  await runner({ sessionKey: "s-test" });
  return upserted;
}

const byContent = (records: MemoryRecord[], content: string) => records.find((r) => r.content === content);

describe("createL1Runner project tagging", () => {
  it("sets the project when all cited sources agree and clears it otherwise", async () => {
    const records = await runDb(MESSAGES, replyWith({
      "memory-agree": ["m-a1", "m-a2"],
      "memory-single-b": ["m-b1"],
      "memory-mixed": ["m-a2", "m-b1"],
      "memory-with-empty": ["m-a1", "m-n1"],
      "memory-unknown-id": ["m-a1", "m-ghost"],
    }));

    expect(records).toHaveLength(5);
    expect(byContent(records, "memory-agree")).toMatchObject(PROJECT_A);
    expect(byContent(records, "memory-single-b")).toMatchObject(PROJECT_B);
    for (const content of ["memory-mixed", "memory-with-empty", "memory-unknown-id"]) {
      expect(byContent(records, content)?.projectKey).toBeUndefined();
      expect(byContent(records, content)?.projectHash).toBeUndefined();
    }
  });

  it("keeps project out of the batch grouping", async () => {
    // Messages of different projects in one session still form one extraction call.
    let calls = 0;
    const runner: LLMRunner = {
      run: async (params) => {
        calls++;
        return replyWith({ "memory-agree": ["m-a1"] }).run(params);
      },
    };
    const records = await runDb(MESSAGES, runner);
    expect(calls).toBe(1);
    expect(records).toHaveLength(1);
  });

  it("uses the whole batch when a memory cites no source", async () => {
    const sameProject = MESSAGES.slice(0, 2);
    const records = await runDb(sameProject, replyWith({ "memory-no-source": [] }));
    expect(byContent(records, "memory-no-source")).toMatchObject(PROJECT_A);

    const mixedRecords = await runDb(MESSAGES, replyWith({ "memory-no-source": [] }));
    expect(byContent(mixedRecords, "memory-no-source")?.projectHash).toBeUndefined();
  });

  it("carries project through the JSONL fallback when the store is unavailable", async () => {
    const dataDir = await tmpDir();
    const storageDir = await tmpDir();
    const storage = new StorageAdapter(new LocalStorageBackend(storageDir));
    const rows = MESSAGES.map((m, i) => ({
      sessionKey: "s-test",
      sessionId: "sess-1",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      recordedAt: new Date(BASE_MS + i + 1).toISOString(),
      id: m.id,
      role: "user",
      content: m.content,
      timestamp: BASE_MS + i + 1,
      projectKey: m.project?.projectKey,
      projectHash: m.project?.projectHash,
    }));
    await storage.writeFile("conversations/2023-11-14.jsonl", rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const runner = pf.createL1Runner({
      pluginDataDir: dataDir,
      cfg: makeCfg(),
      openclawConfig: undefined,
      vectorStore: undefined,
      embeddingService: undefined,
      logger,
      storage,
      llmRunner: replyWith({ "memory-agree": ["m-a1", "m-a2"], "memory-mixed": ["m-a1", "m-b1"] }),
    });
    await runner({ sessionKey: "s-test" });

    const files = await fs.readdir(path.join(storageDir, "records"));
    const records = (await fs.readFile(path.join(storageDir, "records", files[0]!), "utf-8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(records.find((r) => r.content === "memory-agree")).toMatchObject(PROJECT_A);
    expect(records.find((r) => r.content === "memory-mixed")).not.toHaveProperty("projectKey");
  });
});
