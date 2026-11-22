import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";
import { closeDb } from "./src/db/index.js";
import { __resetSessionRepoForTests } from "./src/db/sessionRepo.js";
import { __resetHookCacheRepoForTests } from "./src/db/hookCacheRepo.js";
import { __resetHookRecallLogForTests } from "./src/db/hook-recall-log.js";
import { __resetSessionStoreForTests } from "./src/session/store.js";
import { __resetProxyStorageForTests } from "./src/storage/factory.js";

// Every test gets its own SQLite file. Without this the session DB falls back to
// ~/.tdai-memory-proxy/proxy.db: tests with fixed session ids then read old state and
// write into the DB of the user. The variable is always replaced, also when the caller
// has set one, so a test run never reaches a real database.
const dir = mkdtempSync(join(tmpdir(), "proxy-test-db-"));
let counter = 0;

// Set at once, so code that runs at import time or in `beforeAll` is isolated too.
process.env.PROXY_DB_PATH = join(dir, "proxy-import.db");

/** Close every SQLite connection and drop every singleton that holds one. */
function releaseDatabases(): void {
  __resetHookRecallLogForTests();
  __resetProxyStorageForTests();
  __resetSessionStoreForTests();
  __resetSessionRepoForTests();
  __resetHookCacheRepoForTests();
  closeDb();
}

beforeEach(() => {
  releaseDatabases();
  process.env.PROXY_DB_PATH = join(dir, `proxy-${counter++}.db`);
});

afterAll(() => {
  releaseDatabases();
  rmSync(dir, { recursive: true, force: true });
});
