import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMetadataStore, createMetadataStorePool, loadStoreConfig } from "./factory.js";
import { resolveSqliteDbPath } from "./db-name.js";
import { seedLegacySqliteDatabase } from "./subscription-pool-migration.sqlite-fixture.js";
import type { LegacyPoolSeed } from "./subscription-pool-migration.contract.js";

const SEED: LegacyPoolSeed = {
  teams: [
    { team_id: "team-def", name: "default" },
    { team_id: "team-main", name: "Main" },
  ],
  groups: [
    { id: 1, group_id: "dflt-old", group_type: "default", name: "default", mode: "official", agents: ["claude-code"] },
    { id: 2, group_id: "grp-pool", group_type: "custom", name: "claude pool", mode: "subscription_pool", agents: ["claude-code"], source_name: "sub-claude" },
  ],
  accounts: [],
};

describe("default team name in the store config", () => {
  it("reads TDAI_METADATA_DEFAULT_TEAM_NAME for both backends and trims it", () => {
    expect(loadStoreConfig({ TDAI_METADATA_DEFAULT_TEAM_NAME: "  Main " }, "/tmp/x").defaultTeamName).toBe("Main");
    expect(loadStoreConfig({
      TDAI_METADATA_MONGO_URI: "mongodb://localhost:27017",
      TDAI_METADATA_DEFAULT_TEAM_NAME: "Main",
    }).defaultTeamName).toBe("Main");
  });

  it("leaves the field out when the variable is unset or blank", () => {
    expect("defaultTeamName" in loadStoreConfig({}, "/tmp/x")).toBe(false);
    expect("defaultTeamName" in loadStoreConfig({ TDAI_METADATA_DEFAULT_TEAM_NAME: "   " }, "/tmp/x")).toBe(false);
  });
});

describe("default team name reaches the SQLite store", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), "meta-factory-default-team-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function seedInstance(instanceId: string): void {
    const dbPath = resolveSqliteDbPath(baseDir, instanceId);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    seedLegacySqliteDatabase(dbPath, SEED);
  }

  it("gives the pool groups to the configured team through createMetadataStore", async () => {
    seedInstance("inst-a");
    const config = loadStoreConfig({ TDAI_METADATA_SQLITE_BASE_DIR: baseDir, TDAI_METADATA_DEFAULT_TEAM_NAME: "Main" });
    const store = await createMetadataStore(config, "inst-a");
    try {
      expect((await store.getInstanceUpstreamGroup("grp-pool"))!.team_id).toBe("team-main");
    } finally {
      await store.close();
    }
  });

  it("gives the pool groups to the team named default through the store pool when no name is set", async () => {
    seedInstance("inst-b");
    const pool = await createMetadataStorePool(loadStoreConfig({ TDAI_METADATA_SQLITE_BASE_DIR: baseDir }));
    try {
      const store = await pool.getStore("inst-b");
      expect((await store.getInstanceUpstreamGroup("grp-pool"))!.team_id).toBe("team-def");
    } finally {
      await pool.closeAll();
    }
  });
});
