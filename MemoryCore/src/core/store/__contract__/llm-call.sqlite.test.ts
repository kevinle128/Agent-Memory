import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { VectorStore } from "../sqlite/memory-store.js";
import type { IMemoryStore } from "../types.js";
import { runLlmCallContract } from "./llm-call.contract.js";

const dirs = new Map<IMemoryStore, string>();
let seq = 0;

runLlmCallContract({
  backend: "sqlite",
  createStore: () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-call-"));
    const store = new VectorStore(join(dir, `vectors-${process.pid}-${seq++}.db`), 0);
    store.init();
    dirs.set(store, dir);
    return Promise.resolve(store);
  },
  disposeStore: (store: IMemoryStore) => {
    (store as VectorStore).getRawDb().close();
    rmSync(dirs.get(store)!, { recursive: true, force: true });
    return Promise.resolve();
  },
});

describe("llm_calls table creation", () => {
  it("is created on an existing database that has none, and keeps old tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-call-mig-"));
    const dbPath = join(dir, "vectors.db");
    try {
      const first = new VectorStore(dbPath, 0);
      first.init();
      first.getRawDb().exec("DROP TABLE llm_calls");
      first.getRawDb().close();
      const second = new VectorStore(dbPath, 0);
      second.init();
      const tables = (second.getRawDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
      expect(tables).toContain("llm_calls");
      expect(tables).toContain("memory_generation_refs");
      second.getRawDb().close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
