import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { SqliteMetadataStore } from "./sqlite-adapter.js";
import { runSubscriptionAccountContract } from "./subscription-account.contract.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

runSubscriptionAccountContract(
  "sqlite",
  async () => new SqliteMetadataStore(":memory:"),
  async (store) => {
    await store.close();
  },
);

/** Group table as an older release created it: CHECK on `mode` without `subscription_pool`. */
const OLD_GROUP_TABLE_DDL = `
  CREATE TABLE meta_instance_upstream_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    group_type TEXT NOT NULL CHECK (group_type IN ('default','custom','extraction')),
    name TEXT NOT NULL DEFAULT '',
    agents TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    mode TEXT NOT NULL DEFAULT 'official' CHECK (mode IN ('official','custom_unified','custom_passthrough')),
    base_url TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    supported_agents_snapshot TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(group_id)
  );
  CREATE UNIQUE INDEX ux_iuc_singleton_group_type
    ON meta_instance_upstream_config(group_type)
    WHERE group_type IN ('default','extraction');
`;

const INSERT_OLD_GROUP = `
  INSERT INTO meta_instance_upstream_config
    (id, group_id, group_type, name, agents, enabled, mode, base_url, api_key, model_id, description,
     version, supported_agents_snapshot, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
`;

function seedOldDatabase(dbPath: string, extraSql = ""): void {
  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec(OLD_GROUP_TABLE_DDL);
  raw.prepare(INSERT_OLD_GROUP).run(
    7, "dflt-old", "default", "default-name", '["claude-code","codex"]', 1, "official",
    "", "", "", "", 4, '["claude-code","codex"]',
  );
  raw.prepare(INSERT_OLD_GROUP).run(
    9, "grp-old-unified", "custom", "unified group", '["cursor"]', 0, "custom_unified",
    "https://old.example.test", "old-secret-key", "old-model", "old description", 2, "[]",
  );
  raw.prepare(INSERT_OLD_GROUP).run(
    12, "grp-old-pass", "custom", "passthrough group", '["codebuddy"]', 1, "custom_passthrough",
    "https://pass.example.test", "pass-key", "", "", 1, "[]",
  );
  if (extraSql) raw.exec(extraSql);
  raw.close();
}

describe("SqliteMetadataStore subscription pool migration", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "meta-subscription-pool-"));
    dbPath = path.join(dir, "metadata.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rebuilds an old group table and keeps every existing row unchanged", () => {
    seedOldDatabase(dbPath);

    const store = new SqliteMetadataStore(dbPath);
    store.init();
    try {
      const groups = store.listInstanceUpstreamGroups();
      expect(groups).toHaveLength(3);

      const unified = store.getInstanceUpstreamGroup("grp-old-unified");
      expect(unified).toMatchObject({
        id: 9,
        group_type: "custom",
        name: "unified group",
        agents: ["cursor"],
        enabled: false,
        mode: "custom_unified",
        base_url: "https://old.example.test",
        api_key: "old-secret-key",
        model_id: "old-model",
        description: "old description",
        version: 2,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      });
      expect(store.getInstanceUpstreamGroup("grp-old-pass")).toMatchObject({
        id: 12,
        mode: "custom_passthrough",
        agents: ["codebuddy"],
      });
      expect(store.getInstanceUpstreamGroup("dflt-old")).toMatchObject({
        id: 7,
        mode: "official",
        agents: ["claude-code", "codex"],
        supported_agents_snapshot: ["claude-code", "codex"],
      });

      // The new mode is accepted and new rows continue the id sequence.
      const pool = store.createInstanceUpstreamGroup({
        group_type: "custom",
        name: "claude pool",
        agents: ["claude-code-pool"],
        mode: "subscription_pool",
      });
      expect(pool.mode).toBe("subscription_pool");
      expect(pool.id).toBeGreaterThan(12);
    } finally {
      store.close();
    }

    const raw = new DatabaseSync(dbPath);
    try {
      // The singleton index must survive the rebuild.
      expect(() => raw.prepare(INSERT_OLD_GROUP).run(
        50, "dflt-second", "default", "x", "[]", 1, "official", "", "", "", "", 1, "[]",
      )).toThrow(/UNIQUE constraint failed/);
    } finally {
      raw.close();
    }
  });

  it("opens a table that already has the pool mode and an extra unused column", () => {
    seedOldDatabase(dbPath);
    const first = new SqliteMetadataStore(dbPath);
    first.init();
    first.close();

    // A database that an earlier build migrated has one more column than the current definition.
    const raw = new DatabaseSync(dbPath);
    raw.exec("ALTER TABLE meta_instance_upstream_config ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
    raw.close();

    const store = new SqliteMetadataStore(dbPath);
    store.init();
    try {
      expect(store.listInstanceUpstreamGroups()).toHaveLength(3);
      const pool = store.createInstanceUpstreamGroup({
        group_type: "custom",
        name: "claude pool",
        agents: ["claude-code-pool"],
        mode: "subscription_pool",
      });
      const updated = store.updateInstanceUpstreamGroup({
        group_id: pool.group_id,
        expected_group_type: "custom",
        description: "changed",
      });
      expect(updated.description).toBe("changed");
      expect(store.deleteInstanceUpstreamGroup({ group_id: pool.group_id })).toBe(true);
    } finally {
      store.close();
    }

    const check = new DatabaseSync(dbPath);
    try {
      const columns = check.prepare("SELECT name FROM pragma_table_info('meta_instance_upstream_config')").all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toContain("settings");
    } finally {
      check.close();
    }
  });

  it("does not rebuild again on the next start", () => {
    seedOldDatabase(dbPath);
    const first = new SqliteMetadataStore(dbPath);
    first.init();
    const pool = first.createInstanceUpstreamGroup({
      group_type: "custom",
      name: "claude pool",
      agents: ["claude-code-pool"],
      mode: "subscription_pool",
    });
    first.close();

    const second = new SqliteMetadataStore(dbPath);
    second.init();
    try {
      expect(second.getInstanceUpstreamGroup(pool.group_id)?.mode).toBe("subscription_pool");
      expect(second.listInstanceUpstreamGroups()).toHaveLength(4);
    } finally {
      second.close();
    }
  });

  it("keeps existing accounts when the group table is rebuilt", () => {
    // An account table that already points at the old group table. Dropping the old table with
    // foreign keys on would cascade and delete these rows.
    seedOldDatabase(dbPath, `
      CREATE TABLE meta_upstream_subscription_account (
        account_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('claude','codex')),
        display_name TEXT NOT NULL,
        account_label TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','exhausted','auth_error','disabled')),
        access_token TEXT NOT NULL DEFAULT '',
        refresh_token TEXT NOT NULL DEFAULT '',
        token_expires_at INTEGER,
        provider_account_id TEXT NOT NULL,
        usage_json TEXT NOT NULL DEFAULT '{"windows":[]}',
        usage_updated_at INTEGER,
        exhausted_until INTEGER,
        usage_fail_count INTEGER NOT NULL DEFAULT 0,
        refresh_fail_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (group_id) REFERENCES meta_instance_upstream_config(group_id) ON DELETE CASCADE,
        UNIQUE(group_id, provider_account_id),
        UNIQUE(group_id, display_name)
      );
      INSERT INTO meta_upstream_subscription_account
        (account_id, group_id, provider, display_name, provider_account_id, created_at, updated_at)
      VALUES ('sacc-old', 'grp-old-unified', 'claude', 'Old account', 'p-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

    const store = new SqliteMetadataStore(dbPath);
    store.init();
    try {
      expect(store.getSubscriptionAccount("sacc-old")?.display_name).toBe("Old account");
      // The foreign key still cascades after the rebuild.
      expect(store.deleteInstanceUpstreamGroup({ group_id: "grp-old-unified" })).toBe(true);
      expect(store.getSubscriptionAccount("sacc-old")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("keeps groups and accounts after the store is closed and opened again", () => {
    const first = new SqliteMetadataStore(dbPath);
    first.init();
    const group = first.createInstanceUpstreamGroup({
      group_type: "custom",
      name: "claude pool",
      agents: ["claude-code"],
      mode: "subscription_pool",
    });
    const { account } = first.upsertSubscriptionAccountByProviderId({
      group_id: group.group_id,
      provider: "claude",
      provider_account_id: "p-1",
      display_name: "Max 1",
      access_token: "access",
      refresh_token: "refresh",
      token_expires_at: 1_900_000_000_000,
    });
    first.close();

    const second = new SqliteMetadataStore(dbPath);
    second.init();
    try {
      expect(second.getInstanceUpstreamGroup(group.group_id)?.mode).toBe("subscription_pool");
      expect(second.getSubscriptionAccount(account.account_id)).toEqual(account);
    } finally {
      second.close();
    }
  });
});

describe("sqlite subscription account table from an earlier build", () => {
  it("adds the reset credit column and treats damaged stored JSON as no reading", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reset-credits-column-"));
    const dbPath = path.join(dir, "meta.sqlite");
    try {
      const first = new SqliteMetadataStore(dbPath);
      first.init();
      first.close();

      const raw = new DatabaseSync(dbPath);
      raw.exec("ALTER TABLE meta_upstream_subscription_account DROP COLUMN reset_credits_json");
      raw.close();

      const store = new SqliteMetadataStore(dbPath);
      store.init();
      try {
        const group = await store.createInstanceUpstreamGroup({
          group_type: "custom", name: "pool", agents: ["codex"], mode: "subscription_pool",
        });
        const { account } = await store.upsertSubscriptionAccountByProviderId({
          group_id: group.group_id, provider: "codex", provider_account_id: "acct-1", display_name: "One",
          access_token: "a", refresh_token: "r", token_expires_at: null,
        });
        expect(account.reset_credits).toBeNull();
      } finally {
        store.close();
      }

      const check = new DatabaseSync(dbPath);
      try {
        check.exec("UPDATE meta_upstream_subscription_account SET reset_credits_json = '{not json'");
      } finally {
        check.close();
      }
      const reopened = new SqliteMetadataStore(dbPath);
      reopened.init();
      try {
        expect((await reopened.listSubscriptionAccounts())[0]!.reset_credits).toBeNull();
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SqliteMetadataStore model source columns upgrade", () => {
  const SOURCE_COLUMNS = [
    "source_name", "source_provider", "source_formats", "source_agents", "source_enabled",
    "source_models", "source_models_fetched_at", "source_models_error",
  ];
  const OLD_COLUMNS = [
    "id", "group_id", "group_type", "name", "agents", "enabled", "mode", "base_url", "api_key",
    "model_id", "description", "version", "supported_agents_snapshot", "created_at", "updated_at",
  ];
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "meta-source-columns-"));
    dbPath = path.join(dir, "metadata.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readOldColumns(): unknown[] {
    const raw = new DatabaseSync(dbPath);
    try {
      return raw
        .prepare(`SELECT ${OLD_COLUMNS.join(", ")} FROM meta_instance_upstream_config ORDER BY id`)
        .all();
    } finally {
      raw.close();
    }
  }

  function columnNames(): string[] {
    const raw = new DatabaseSync(dbPath);
    try {
      return (raw.prepare("SELECT name FROM pragma_table_info('meta_instance_upstream_config')").all() as Array<{ name: string }>)
        .map((c) => c.name);
    } finally {
      raw.close();
    }
  }

  /** A table that already accepts the pool mode but has no source column. */
  function seedPoolAwareDatabase(): void {
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(
      OLD_GROUP_TABLE_DDL.replace(
        "'custom_passthrough')",
        "'custom_passthrough','subscription_pool')",
      ),
    );
    raw.prepare(INSERT_OLD_GROUP).run(
      9, "grp-old-unified", "custom", "unified group", '["cursor"]', 0, "custom_unified",
      "https://old.example.test", "old-secret-key", "old-model", "old description", 2, "[]",
    );
    raw.prepare(INSERT_OLD_GROUP).run(
      12, "grp-old-pool", "custom", "pool group", '["claude-code"]', 1, "subscription_pool",
      "", "", "", "", 3, "[]",
    );
    raw.close();
  }

  it("adds the source columns to a table that has none and keeps every old value", () => {
    seedPoolAwareDatabase();
    const before = readOldColumns();
    expect(columnNames()).not.toContain("source_name");

    const store = new SqliteMetadataStore(dbPath);
    store.init();
    try {
      expect(columnNames()).toEqual(expect.arrayContaining(SOURCE_COLUMNS));
      expect(readOldColumns()).toEqual(before);
      expect(store.getInstanceUpstreamGroup("grp-old-unified")).toMatchObject({
        source_name: "",
        source_provider: "",
        source_formats: [],
        source_agents: [],
        source_enabled: false,
        source_models: [],
        source_models_fetched_at: null,
        source_models_error: null,
        api_key: "old-secret-key",
        agents: ["cursor"],
      });

      // The unique index exists after the upgrade.
      store.updateInstanceUpstreamGroup({
        group_id: "grp-old-unified", expected_group_type: "custom", source_name: "api-old",
      });
      expect(() => store.updateInstanceUpstreamGroup({
        group_id: "grp-old-pool", expected_group_type: "custom", source_name: "api-old",
      })).toThrow(/source name/);
    } finally {
      store.close();
    }
  });

  it("adds only the columns that are missing and does not change data on the next start", () => {
    seedPoolAwareDatabase();
    const raw = new DatabaseSync(dbPath);
    raw.exec("ALTER TABLE meta_instance_upstream_config ADD COLUMN source_name TEXT NOT NULL DEFAULT ''");
    raw.exec("UPDATE meta_instance_upstream_config SET source_name = 'sub-claude' WHERE group_id = 'grp-old-pool'");
    raw.close();
    const before = readOldColumns();

    const first = new SqliteMetadataStore(dbPath);
    first.init();
    first.close();
    const second = new SqliteMetadataStore(dbPath);
    second.init();
    try {
      expect(columnNames().filter((n) => n === "source_name")).toHaveLength(1);
      expect(columnNames()).toEqual(expect.arrayContaining(SOURCE_COLUMNS));
      expect(readOldColumns()).toEqual(before);
      expect(second.getInstanceUpstreamGroup("grp-old-pool")).toMatchObject({
        source_name: "sub-claude",
        source_agents: [],
        source_enabled: false,
      });
    } finally {
      second.close();
    }
  });

  it("rebuilds a table without pool mode and still ends with the source columns", () => {
    seedOldDatabase(dbPath);
    const before = readOldColumns();

    const store = new SqliteMetadataStore(dbPath);
    store.init();
    try {
      expect(columnNames()).toEqual(expect.arrayContaining(SOURCE_COLUMNS));
      expect(readOldColumns()).toEqual(before);
    } finally {
      store.close();
    }
  });
});
