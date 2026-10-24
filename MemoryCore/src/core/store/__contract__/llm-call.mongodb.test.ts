/**
 * Runs the LLM call log clauses against a real MongoDB with search support.
 * Skipped unless MONGO_TEST_URI is set, for example
 * MONGO_TEST_URI='mongodb://127.0.0.1:27017/?directConnection=true'.
 */

import { describe, it } from "vitest";

import { MongoClientPool } from "../mongodb/client-pool.js";
import { MongoMemoryStore } from "../mongodb/memory-store.js";
import type { IMemoryStore } from "../types.js";
import { runLlmCallContract } from "./llm-call.contract.js";

const uri = process.env.MONGO_TEST_URI;

if (!uri) {
  describe("LLM call log [mongodb]", () => {
    it.skip("needs MONGO_TEST_URI", () => {});
  });
} else {
  const pool = new MongoClientPool();
  const mongoConfig = { endpoint: uri, user: "", password: "", database: `llmc_test_${process.pid}_${Date.now()}` };
  runLlmCallContract({
    backend: "mongodb",
    createStore: async () => {
      const store = new MongoMemoryStore({ pool, mongoConfig, searchIndexWaitMs: 1_000 });
      await store.init();
      return store;
    },
    disposeStore: async (store: IMemoryStore) => {
      const db = await pool.getDb(mongoConfig);
      await db.dropDatabase();
      store.close();
    },
  });
}
