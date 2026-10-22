import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { SqliteMetadataStore } from "./sqlite-adapter.js";
import { runDeviceSetupContract } from "./device-setup.contract.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

runDeviceSetupContract(
  "sqlite",
  async () => new SqliteMetadataStore(":memory:"),
  async (store) => {
    await store.close();
  },
);

describe("device setup table on an existing sqlite database", () => {
  it("adds the table at start and keeps old rows", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "device-setup-"));
    const dbPath = path.join(dir, "metadata.db");
    try {
      // First start makes the current schema. The device table is then removed to
      // look like a database from a release before the registry.
      const first = new SqliteMetadataStore(dbPath);
      await first.init();
      const user = await first.createUser({ auth_provider: "local", external_id: "old-1", username: "old-user" });
      await first.close();

      const raw = new DatabaseSync(dbPath);
      raw.exec("DROP TABLE meta_device_setups");
      raw.close();

      const second = new SqliteMetadataStore(dbPath);
      await second.init();
      try {
        expect(await second.getUserById(user.user_id)).toMatchObject({ user_id: user.user_id });
        expect(await second.listDeviceSetups(user.user_id)).toEqual([]);
        const row = await second.upsertDeviceSetup({
          user_id: user.user_id, device_id: "device-1", client: "codex",
          os: "", arch: "", hostname: "", hook_version: "1.0.0",
        });
        expect(row.status).toBe("installed");
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
