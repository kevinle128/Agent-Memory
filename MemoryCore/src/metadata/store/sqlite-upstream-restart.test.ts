/**
 * Upstream groups must survive a Memory Core restart in sqlite mode.
 * A restart re-runs the schema setup on the same database file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { SqliteMetadataStore } from "./sqlite-adapter.js";
import { LEGACY_POOL_SCHEMA_DDL, seedLegacySqliteDatabase } from "./subscription-pool-migration.sqlite-fixture.js";

const { DatabaseSync: RawDatabase } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

describe("SqliteMetadataStore upgrade to team-scoped pools", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "meta-pool-team-upgrade-"));
    dbPath = path.join(dir, "metadata.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readRaw<T>(sql: string): T[] {
    const raw = new RawDatabase(dbPath);
    try {
      return raw.prepare(sql).all() as T[];
    } finally {
      raw.close();
    }
  }

  const OLD_GROUP_COLUMNS = "id, group_id, group_type, name, agents, enabled, mode, version, supported_agents_snapshot, source_name, created_at, updated_at";
  const OLD_ACCOUNT_COLUMNS = "account_id, group_id, provider, display_name, access_token, refresh_token, provider_account_id, version, created_at, updated_at";

  it("upgrades a database without the team column and keeps every row", () => {
    // No team and every pooled agent already has an instance home, so the backfill has nothing to change.
    seedLegacySqliteDatabase(dbPath, {
      teams: [],
      groups: [
        { id: 1, group_id: "dflt-old", group_type: "default", name: "default", mode: "official", agents: ["claude-code", "codex"] },
        { id: 2, group_id: "grp-pool", group_type: "custom", name: "claude pool", mode: "subscription_pool", agents: ["claude-code"], source_name: "sub-claude" },
        { id: 3, group_id: "grp-api", group_type: "custom", name: "api", mode: "custom_unified", agents: ["cursor"], source_name: "api-x" },
      ],
      accounts: [
        { account_id: "sacc-1", group_id: "grp-pool", provider: "claude", provider_account_id: "p-1", display_name: "Max 1" },
      ],
    });
    const groupsBefore = readRaw(`SELECT ${OLD_GROUP_COLUMNS} FROM meta_instance_upstream_config ORDER BY id`);
    const accountsBefore = readRaw(`SELECT ${OLD_ACCOUNT_COLUMNS} FROM meta_upstream_subscription_account`);

    const store = new SqliteMetadataStore(dbPath);
    store.init();
    try {
      expect(store.listInstanceUpstreamGroups().map((g) => [g.group_id, g.team_id]).sort()).toEqual([
        ["dflt-old", ""], ["grp-api", ""], ["grp-pool", ""],
      ]);
      expect(store.getSubscriptionAccount("sacc-1")).toMatchObject({ group_id: "grp-pool", threshold_pct: 95 });
    } finally {
      store.close();
    }

    const columns = readRaw<{ name: string }>("SELECT name FROM pragma_table_info('meta_instance_upstream_config')").map((c) => c.name);
    expect(columns).toContain("team_id");
    expect(readRaw(`SELECT ${OLD_GROUP_COLUMNS} FROM meta_instance_upstream_config ORDER BY id`)).toEqual(groupsBefore);
    expect(readRaw(`SELECT ${OLD_ACCOUNT_COLUMNS} FROM meta_upstream_subscription_account`)).toEqual(accountsBefore);
    expect(readRaw("PRAGMA quick_check")).toEqual([{ quick_check: "ok" }]);
  });

  it("drops the old source name index and creates the team index", () => {
    seedLegacySqliteDatabase(dbPath, { teams: [], groups: [], accounts: [] });
    const indexesOf = () => readRaw<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'meta_instance_upstream_config' AND name LIKE 'ux_iuc_%' ORDER BY name",
    ).map((r) => r.name);
    expect(indexesOf()).toContain("ux_iuc_source_name");

    for (let start = 0; start < 2; start++) {
      const store = new SqliteMetadataStore(dbPath);
      store.init();
      store.close();
      expect(indexesOf()).toEqual(["ux_iuc_singleton_group_type", "ux_iuc_team_source_name"]);
    }
    const sql = readRaw<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'ux_iuc_team_source_name'")[0]!.sql;
    expect(sql).toContain("(team_id, source_name)");
  });

  it("copies the global threshold into accounts of a table that is also rebuilt for a new provider", () => {
    // An account table that predates the AntiGravity provider gets a rebuild after the column add.
    seedLegacySqliteDatabase(dbPath, {
      teams: [{ team_id: "team-def", name: "default" }],
      groups: [
        { id: 1, group_id: "dflt-old", group_type: "default", name: "default", mode: "official", agents: [] },
        { id: 2, group_id: "grp-pool", group_type: "custom", name: "claude pool", mode: "subscription_pool", agents: ["claude-code"], source_name: "sub-claude" },
      ],
      accounts: [
        { account_id: "sacc-1", group_id: "grp-pool", provider: "claude", provider_account_id: "p-1", display_name: "Max 1" },
      ],
      globalThresholdPct: "85",
    }, LEGACY_POOL_SCHEMA_DDL.replace("'claude','codex','antigravity'", "'claude','codex'"));

    const store = new SqliteMetadataStore(dbPath);
    store.init();
    try {
      expect(store.getSubscriptionAccount("sacc-1")).toMatchObject({ threshold_pct: 85, access_token: "access-sacc-1" });
      expect(store.getInstanceUpstreamGroup("grp-pool")!.team_id).toBe("team-def");
      expect(store.getInstanceUpstreamGroup("dflt-old")!.agents).toEqual(["claude-code"]);
    } finally {
      store.close();
    }
    const tableSql = readRaw<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'meta_upstream_subscription_account'",
    )[0]!.sql;
    expect(tableSql).toContain("'antigravity'");
    expect(tableSql).toContain("threshold_pct BETWEEN 50 AND 100");
    expect(readRaw("PRAGMA quick_check")).toEqual([{ quick_check: "ok" }]);
  });
});

describe("SqliteMetadataStore restart", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "meta-upstream-restart-"));
    dbPath = path.join(dir, "metadata.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a custom upstream group after the store is closed and opened again", () => {
    const first = new SqliteMetadataStore(dbPath);
    first.init();
    const created = first.createInstanceUpstreamGroup({
      group_type: "custom",
      name: "team-group",
      agents: ["claude-code"],
      mode: "custom_unified",
      base_url: "https://upstream.example.test",
      api_key: "test-key",
      model_id: "test-model",
    });
    first.close();

    const second = new SqliteMetadataStore(dbPath);
    second.init();
    try {
      const reloaded = second.getInstanceUpstreamGroup(created.group_id);
      expect(reloaded).not.toBeNull();
      expect(reloaded?.name).toBe("team-group");
      expect(reloaded?.agents).toEqual(["claude-code"]);
      expect(reloaded?.mode).toBe("custom_unified");
      expect(reloaded?.api_key).toBe("test-key");
      expect(second.listInstanceUpstreamGroups().map((g) => g.group_id)).toContain(created.group_id);
    } finally {
      second.close();
    }
  });

  it("replaces a table that still has the old v1 shape", () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE meta_instance_upstream_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_source TEXT NOT NULL UNIQUE,
        base_url TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO meta_instance_upstream_config (agent_source, base_url) VALUES ('claude-code', 'https://old.example.test');
    `);
    raw.close();

    const store = new SqliteMetadataStore(dbPath);
    store.init();
    try {
      expect(store.listInstanceUpstreamGroups()).toEqual([]);
      const created = store.createInstanceUpstreamGroup({
        group_type: "custom",
        name: "after-upgrade",
        mode: "custom_unified",
      });
      expect(store.getInstanceUpstreamGroup(created.group_id)?.name).toBe("after-upgrade");
    } finally {
      store.close();
    }
  });
});
