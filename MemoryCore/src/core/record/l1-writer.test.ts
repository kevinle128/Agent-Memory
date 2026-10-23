/**
 * Unit tests for writeMemory — batch intra-dedup branches.
 *
 * Focus:
 * - skip → returns null, writes/appends nothing
 * - merge with empty target_ids (pure batch dedup) → appends merged content,
 *   does NOT call deleteL1Batch, upserts merged record
 *
 * Mock style: hand-written mocks (MockVectorStore / MockStorage), matching the
 * repo's existing convention (see sdk/typescript/tests/client.test.ts).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { writeMemory } from "./l1-writer.js";
import type { ExtractedMemory, DedupDecision, MemoryRecord } from "./l1-writer.js";
import type { IMemoryStore } from "../store/types.js";
import type { StorageAdapter } from "../storage/adapter.js";

function mkMemory(): ExtractedMemory {
  return {
    content: "用户决定前端框架从 Vue 2 迁移到 Vue 3",
    type: "episodic",
    priority: 80,
    source_message_ids: ["msg-1"],
    metadata: {},
    scene_name: "default",
  };
}

interface MockVectorStore {
  /** Records the (ids, filter) passed to each deleteL1Batch call. */
  deleted: Array<{ ids: string[]; filter: unknown }>;
  upserted: Array<{ record: MemoryRecord; hasEmbedding: boolean }>;
  /** Existing records returned by queryL1Records (used by update/merge to read version). */
  existing: MemoryRecord[];
}

/**
 * Minimal IMemoryStore mock recording deleteL1Batch / upsertL1 / queryL1Records calls.
 * deleteL1Batch 记录传入的 filter，以便断言隔离过滤器的形状。
 */
function mkVectorStore(existing: MemoryRecord[] = []): IMemoryStore & MockVectorStore {
  const mock: MockVectorStore = { deleted: [], upserted: [], existing };
  return {
    ...mock,
    deleteL1Batch: async (ids: string[], filter?: unknown) => {
      mock.deleted.push({ ids, filter });
      return true;
    },
    upsertL1: async (record: MemoryRecord, embedding?: Float32Array) => {
      mock.upserted.push({ record, hasEmbedding: embedding !== undefined });
      return true;
    },
    queryL1Records: async (_params: { recordIds: string[] }) => mock.existing,
  } as unknown as IMemoryStore & MockVectorStore;
}

interface MockStorage {
  appended: Array<{ key: string; content: string }>;
}

/** Minimal StorageAdapter mock recording appendFile calls. */
function mkStorage(): StorageAdapter & MockStorage {
  const mock: MockStorage = { appended: [] };
  return {
    ...mock,
    appendFile: async (key: string, content: string) => {
      mock.appended.push({ key, content });
    },
  } as unknown as StorageAdapter & MockStorage;
}

describe("writeMemory - batch intra-dedup branches", () => {
  it("skip returns null and writes/appends nothing", async () => {
    const vs = mkVectorStore();
    const storage = mkStorage();

    const result = await writeMemory({
      memory: mkMemory(),
      decision: { record_id: "m4", action: "skip", target_ids: [] } satisfies DedupDecision,
      baseDir: "/tmp",
      sessionKey: "s1",
      vectorStore: vs,
      storage,
    });

    expect(result).toBeNull();
    expect(storage.appended).toHaveLength(0);
    expect(vs.deleted).toHaveLength(0);
    expect(vs.upserted).toHaveLength(0);
  });

  it("merge with empty target_ids appends merged content, does not delete, upserts merged record", async () => {
    const vs = mkVectorStore();
    const storage = mkStorage();
    const merged = "用户决定前端框架从 Vue 2 迁移到 Vue 3，预计 Q3 完成";

    const result = await writeMemory({
      memory: mkMemory(),
      decision: {
        record_id: "m1",
        action: "merge",
        target_ids: [],
        merged_content: merged,
        merged_type: "episodic",
        merged_priority: 85,
        merged_timestamps: ["t1", "t2"],
      } satisfies DedupDecision,
      baseDir: "/tmp",
      sessionKey: "s1",
      vectorStore: vs,
      storage,
    });

    expect(result).not.toBeNull();
    expect(result!.content).toBe(merged);
    expect(result!.priority).toBe(85);
    // empty target_ids → goes through the append (store-like) branch, no deletion
    expect(vs.deleted).toHaveLength(0);
    // merged record appended to JSONL
    expect(storage.appended).toHaveLength(1);
    expect(storage.appended[0]!.content).toContain(merged);
    // dual-write upserts the merged record (no embedding service → undefined embedding)
    expect(vs.upserted).toHaveLength(1);
    expect(vs.upserted[0]!.record.content).toBe(merged);
    expect(vs.upserted[0]!.hasEmbedding).toBe(false);
  });

  it("update with non-empty target_ids deletes targets with scope-only filter (no sessionId/sessionKey)", async () => {
    // Regression guard: when update replaces a cross-session old record, the delete
    // filter must isolate only by scope (team/user/agent) without sessionId/sessionKey
    // — otherwise rowMatchesIsolation filters out the cross-session old record and
    // update cannot actually delete it (old and new coexist). See deleteFilter in l1-writer.ts.
    const existingOld = { id: "c1", version: 2 } as unknown as MemoryRecord;
    const vs = mkVectorStore([existingOld]);
    const storage = mkStorage();
    const updated = "用户不喜欢喝单丛茶。";

    const result = await writeMemory({
      memory: mkMemory(),
      decision: {
        record_id: "m1",
        action: "update",
        target_ids: ["c1"],
        merged_content: updated,
        merged_type: "persona",
        merged_priority: 85,
        merged_timestamps: ["t1", "t2"],
      } satisfies DedupDecision,
      baseDir: "/tmp",
      sessionKey: "sess-correct-tea-vfy3",
      sessionId: "sess-correct-tea-vfy3",
      teamId: "team-vswf3d49st",
      userId: "usr-tnw0vg7cdv",
      agentId: "agt-vswfutdjgl",
      vectorStore: vs,
      storage,
    });

    expect(result).not.toBeNull();
    // Old record deleted
    expect(vs.deleted).toHaveLength(1);
    expect(vs.deleted[0]!.ids).toEqual(["c1"]);
    // Key assertion: filter contains only the scope triple, no sessionId / sessionKey
    const filter = vs.deleted[0]!.filter as Record<string, unknown>;
    expect(filter).toEqual({
      teamId: "team-vswf3d49st",
      userId: "usr-tnw0vg7cdv",
      agentId: "agt-vswfutdjgl",
    });
    expect(filter).not.toHaveProperty("sessionId");
    expect(filter).not.toHaveProperty("sessionKey");
    // New record written, version = old version + 1
    expect(vs.upserted).toHaveLength(1);
    expect(vs.upserted[0]!.record.content).toBe(updated);
    expect(vs.upserted[0]!.record.version).toBe(3);
  });

  it("update without scope fields still passes a normalised default-bucket filter", async () => {
    // When team/user/agent are all absent, the filter must not disappear (that would
    // allow cross-tenant unisolated deletes); instead it normalizes to the default
    // bucket and keeps the team-less bucket ("") so other teams' rows never match.
    const existingOld = { id: "c1", version: 0 } as unknown as MemoryRecord;
    const vs = mkVectorStore([existingOld]);
    const storage = mkStorage();

    await writeMemory({
      memory: mkMemory(),
      decision: {
        record_id: "m1",
        action: "update",
        target_ids: ["c1"],
        merged_content: "更新后的内容",
        merged_type: "episodic",
        merged_priority: 80,
        merged_timestamps: ["t1"],
      } satisfies DedupDecision,
      baseDir: "/tmp",
      sessionKey: "s1",
      vectorStore: vs,
      storage,
    });

    expect(vs.deleted).toHaveLength(1);
    expect(vs.deleted[0]!.ids).toEqual(["c1"]);
    const filter = vs.deleted[0]!.filter as Record<string, unknown>;
    expect(filter).toEqual({ teamId: "", userId: "default", agentId: "default" });
    expect(filter).not.toHaveProperty("sessionId");
  });
});

describe("writeMemory - update/merge replaces old records only after the new one is stored", () => {
  const updateDecision = (targetIds: string[]): DedupDecision => ({
    record_id: "m1",
    action: "update",
    target_ids: targetIds,
    merged_content: "merged",
    merged_type: "episodic",
    merged_priority: 80,
    merged_timestamps: ["t1"],
  });

  it("deletes the targets after the replacement upsert", async () => {
    const calls: string[] = [];
    const vs = mkVectorStore();
    const upsert = vs.upsertL1.bind(vs);
    const del = vs.deleteL1Batch.bind(vs);
    vs.upsertL1 = (async (...args: Parameters<IMemoryStore["upsertL1"]>) => {
      calls.push("upsert");
      return upsert(...args);
    }) as IMemoryStore["upsertL1"];
    vs.deleteL1Batch = (async (...args: Parameters<IMemoryStore["deleteL1Batch"]>) => {
      calls.push("delete");
      return del(...args);
    }) as IMemoryStore["deleteL1Batch"];

    await writeMemory({ memory: mkMemory(), decision: updateDecision(["c1"]), baseDir: "/tmp", sessionKey: "s1", vectorStore: vs, storage: mkStorage() });

    expect(calls).toEqual(["upsert", "delete"]);
    expect(vs.deleted[0]!.ids).toEqual(["c1"]);
  });

  it("keeps the targets when the replacement is not in the vector store", async () => {
    const vs = mkVectorStore();
    vs.upsertL1 = (async () => false) as IMemoryStore["upsertL1"];
    const storage = mkStorage();

    const result = await writeMemory({ memory: mkMemory(), decision: updateDecision(["c1"]), baseDir: "/tmp", sessionKey: "s1", vectorStore: vs, storage });

    expect(result).not.toBeNull();
    expect(storage.appended).toHaveLength(1);
    expect(vs.deleted).toHaveLength(0);
  });

  it("keeps the targets and reports a failure when no target stored the replacement", async () => {
    const vs = mkVectorStore();
    vs.upsertL1 = (async () => { throw new Error("vdb down"); }) as IMemoryStore["upsertL1"];
    const storage = mkStorage();
    storage.appendFile = (async () => { throw new Error("disk full"); }) as StorageAdapter["appendFile"];

    await expect(
      writeMemory({ memory: mkMemory(), decision: updateDecision(["c1"]), baseDir: "/tmp", sessionKey: "s1", vectorStore: vs, storage }),
    ).rejects.toThrow("no persistence target");
    expect(vs.deleted).toHaveLength(0);
  });

  it("never deletes the replacement itself", async () => {
    const vs = mkVectorStore();

    await writeMemory({ memory: mkMemory(), decision: updateDecision(["c1", "m1"]), baseDir: "/tmp", sessionKey: "s1", vectorStore: vs, storage: mkStorage() });

    expect(vs.deleted[0]!.ids).toEqual(["c1"]);
  });
});

describe("writeMemory - retries a failed delete of the replaced records", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const updateDecision: DedupDecision = {
    record_id: "m1",
    action: "update",
    target_ids: ["c1"],
    merged_content: "merged",
    merged_type: "episodic",
    merged_priority: 80,
    merged_timestamps: ["t1"],
  };

  const writeWithDeleteResults = async (results: Array<boolean | Error>) => {
    vi.useFakeTimers();
    const vs = mkVectorStore();
    let attempts = 0;
    vs.deleteL1Batch = (async () => {
      const result = results[Math.min(attempts++, results.length - 1)]!;
      if (result instanceof Error) throw result;
      return result;
    }) as IMemoryStore["deleteL1Batch"];
    const warnings: string[] = [];
    const logger = { info: () => {}, warn: (msg: string) => warnings.push(msg), error: () => {}, debug: () => {} };
    const pending = writeMemory({ memory: mkMemory(), decision: updateDecision, baseDir: "/tmp", sessionKey: "s1", vectorStore: vs, storage: mkStorage(), logger });
    await vi.runAllTimersAsync();
    const record = await pending;
    return { record, attempts: () => attempts, warnings };
  };

  it("succeeds on a retry after the store throws", async () => {
    const { record, attempts, warnings } = await writeWithDeleteResults([new Error("timeout"), true]);
    expect(record).not.toBeNull();
    expect(attempts()).toBe(2);
    expect(warnings.filter((w) => w.includes("delete failed"))).toHaveLength(0);
  });

  it("treats a false result as a failure and retries", async () => {
    const { attempts, warnings } = await writeWithDeleteResults([false, false, true]);
    expect(attempts()).toBe(3);
    expect(warnings.filter((w) => w.includes("delete failed"))).toHaveLength(0);
  });

  it("stops after three attempts, warns, and still returns the stored replacement", async () => {
    const { record, attempts, warnings } = await writeWithDeleteResults([false]);
    expect(record?.id).toBe("m1");
    expect(attempts()).toBe(3);
    expect(warnings.some((w) => w.includes("delete failed") && w.includes("[c1] remain beside m1"))).toBe(true);
  });
});


describe("writeMemory - project propagation", () => {
  const PROJECT_A = { projectKey: "git:github.com/acme/app", projectHash: "0123456789abcdef" };
  const PROJECT_B = { projectKey: "git:github.com/acme/other", projectHash: "fedcba9876543210" };

  /** queryL1Records returns snake_case rows; the mock casts them like the other tests. */
  function mkStoreWithRows(rows: Array<Record<string, unknown>>) {
    return mkVectorStore(rows as unknown as MemoryRecord[]);
  }

  it("writes the project of a new memory to the vector store and to JSONL", async () => {
    const vs = mkVectorStore();
    const storage = mkStorage();

    const record = await writeMemory({
      memory: { ...mkMemory(), ...PROJECT_A },
      decision: { record_id: "m1", action: "store", target_ids: [] } satisfies DedupDecision,
      baseDir: "/tmp",
      sessionKey: "s1",
      vectorStore: vs,
      storage,
    });

    expect(record).toMatchObject(PROJECT_A);
    expect(vs.upserted[0]?.record).toMatchObject(PROJECT_A);
    expect(JSON.parse(storage.appended[0]!.content)).toMatchObject(PROJECT_A);
  });

  it("keeps a memory without project free of project keys", async () => {
    const vs = mkVectorStore();
    const storage = mkStorage();

    const record = await writeMemory({
      memory: mkMemory(),
      decision: { record_id: "m2", action: "store", target_ids: [] } satisfies DedupDecision,
      baseDir: "/tmp",
      sessionKey: "s1",
      vectorStore: vs,
      storage,
    });

    expect(record?.projectKey).toBeUndefined();
    expect(record?.projectHash).toBeUndefined();
    expect(JSON.parse(storage.appended[0]!.content)).not.toHaveProperty("projectKey");
  });

  it("keeps the project of the existing record when a merge has no project of its own", async () => {
    const vs = mkStoreWithRows([
      { record_id: "old-1", version: 2, project_key: PROJECT_A.projectKey, project_hash: PROJECT_A.projectHash },
    ]);

    const record = await writeMemory({
      memory: mkMemory(),
      decision: { record_id: "m3", action: "merge", target_ids: ["old-1"], merged_content: "merged" } satisfies DedupDecision,
      baseDir: "/tmp",
      sessionKey: "s1",
      vectorStore: vs,
      storage: mkStorage(),
    });

    expect(record).toMatchObject({ ...PROJECT_A, version: 3 });
  });

  it("takes the project of the new sources when a merge has one", async () => {
    const vs = mkStoreWithRows([
      { record_id: "old-1", version: 1, project_key: PROJECT_A.projectKey, project_hash: PROJECT_A.projectHash },
    ]);

    const record = await writeMemory({
      memory: { ...mkMemory(), ...PROJECT_B },
      decision: { record_id: "m4", action: "update", target_ids: ["old-1"], merged_content: "updated" } satisfies DedupDecision,
      baseDir: "/tmp",
      sessionKey: "s1",
      vectorStore: vs,
      storage: mkStorage(),
    });

    expect(record).toMatchObject(PROJECT_B);
  });

  it("leaves the project empty when merged records disagree and the new memory has none", async () => {
    const vs = mkStoreWithRows([
      { record_id: "old-1", version: 1, project_key: PROJECT_A.projectKey, project_hash: PROJECT_A.projectHash },
      { record_id: "old-2", version: 1, project_key: PROJECT_B.projectKey, project_hash: PROJECT_B.projectHash },
    ]);

    const record = await writeMemory({
      memory: mkMemory(),
      decision: { record_id: "m5", action: "merge", target_ids: ["old-1", "old-2"], merged_content: "merged" } satisfies DedupDecision,
      baseDir: "/tmp",
      sessionKey: "s1",
      vectorStore: vs,
      storage: mkStorage(),
    });

    expect(record?.projectHash).toBeUndefined();
  });
});
