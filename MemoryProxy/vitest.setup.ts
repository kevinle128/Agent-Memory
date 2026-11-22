import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";
import { closeDb } from "./src/db/index.js";

// Every test gets its own SQLite file. Without this the session DB falls back to
// ~/.tdai-memory-proxy/proxy.db: tests with fixed session ids then read old state and
// write into the DB of the user. The variable is always replaced, also when the caller
// has set one, so a test run never reaches a real database. The connection is closed
// before each test so no state of an earlier test (or file) is kept.
const dir = mkdtempSync(join(tmpdir(), "proxy-test-db-"));
let counter = 0;

beforeEach(() => {
  closeDb();
  process.env.PROXY_DB_PATH = join(dir, `proxy-${counter++}.db`);
});

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
