/** Runs the subscription pool team migration contract on SQLite database files. */
import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteMetadataStore } from "./sqlite-adapter.js";
import { runSubscriptionPoolMigrationContract } from "./subscription-pool-migration.contract.js";
import { seedLegacySqliteDatabase } from "./subscription-pool-migration.sqlite-fixture.js";

// A reopen needs a file: an in-memory database is gone when its store closes.
const dir = mkdtempSync(path.join(tmpdir(), "meta-pool-team-migration-"));
let dbSeq = 0;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

runSubscriptionPoolMigrationContract("sqlite", {
  async newDatabase() {
    dbSeq += 1;
    return path.join(dir, `metadata-${dbSeq}.db`);
  },
  async seedLegacy(db, seed) {
    seedLegacySqliteDatabase(db, seed);
  },
  async open(db, options) {
    const store = new SqliteMetadataStore(db, options);
    store.init();
    return store;
  },
  async close(store) {
    await store.close();
  },
});
