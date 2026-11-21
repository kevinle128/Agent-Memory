/**
 * Writes a SQLite metadata database in the shape of the build before team-scoped pools: the group
 * table has no `team_id` column and the old source name index, and the account table has no
 * `threshold_pct` column. The definitions are copied here on purpose, so a change of the current
 * definitions does not change the old shape under test.
 */
import { createRequire } from "node:module";
import type { LegacyPoolSeed } from "./subscription-pool-migration.contract.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export const LEGACY_POOL_SCHEMA_DDL = `
  CREATE TABLE meta_teams (
    team_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    owner_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE meta_config_params (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL CHECK (scope IN ('global', 'user')),
    user_id TEXT,
    module TEXT NOT NULL,
    param_name TEXT NOT NULL,
    param_value TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (scope = 'global' AND user_id IS NULL) OR
      (scope = 'user' AND user_id IS NOT NULL)
    )
  );
  CREATE UNIQUE INDEX ux_meta_config_params_global
    ON meta_config_params(module, param_name) WHERE scope = 'global';
  CREATE TABLE meta_instance_upstream_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    group_type TEXT NOT NULL CHECK (group_type IN ('default','custom','extraction')),
    name TEXT NOT NULL DEFAULT '',
    agents TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    mode TEXT NOT NULL DEFAULT 'official' CHECK (mode IN ('official','custom_unified','custom_passthrough','subscription_pool')),
    base_url TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    supported_agents_snapshot TEXT NOT NULL DEFAULT '[]',
    source_name TEXT NOT NULL DEFAULT '',
    source_provider TEXT NOT NULL DEFAULT '',
    source_formats TEXT NOT NULL DEFAULT '[]',
    source_agents TEXT NOT NULL DEFAULT '[]',
    source_enabled INTEGER NOT NULL DEFAULT 0,
    source_models TEXT NOT NULL DEFAULT '[]',
    source_models_fetched_at TEXT,
    source_models_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(group_id)
  );
  CREATE UNIQUE INDEX ux_iuc_singleton_group_type
    ON meta_instance_upstream_config(group_type)
    WHERE group_type IN ('default','extraction');
  CREATE UNIQUE INDEX ux_iuc_source_name
    ON meta_instance_upstream_config(source_name)
    WHERE source_name != '';
  CREATE TABLE meta_upstream_subscription_account (
    account_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('claude','codex','antigravity')),
    display_name TEXT NOT NULL,
    account_label TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','exhausted','auth_error','disabled')),
    access_token TEXT NOT NULL DEFAULT '',
    refresh_token TEXT NOT NULL DEFAULT '',
    token_expires_at INTEGER,
    provider_account_id TEXT NOT NULL,
    project_id TEXT,
    usage_json TEXT NOT NULL DEFAULT '{"windows":[]}',
    reset_credits_json TEXT,
    usage_updated_at INTEGER,
    exhausted_until INTEGER,
    usage_fail_count INTEGER NOT NULL DEFAULT 0,
    refresh_fail_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    active_sessions INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (group_id) REFERENCES meta_instance_upstream_config(group_id) ON DELETE CASCADE,
    UNIQUE(group_id, provider_account_id),
    UNIQUE(group_id, display_name)
  );
`;

const OLD_TIME = "2026-01-01T00:00:00.000Z";

/**
 * Create the old schema in a new database file and write the seed rows. `ddl` can give an even
 * older shape of the same tables.
 */
export function seedLegacySqliteDatabase(dbPath: string, seed: LegacyPoolSeed, ddl = LEGACY_POOL_SCHEMA_DDL): void {
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(ddl);
    for (const t of seed.teams) {
      raw.prepare(
        `INSERT INTO meta_teams (team_id, name, owner_user_id, status, created_at, updated_at)
         VALUES (?, ?, 'usr-owner', ?, ?, ?)`,
      ).run(t.team_id, t.name, t.status ?? "active", t.created_at ?? OLD_TIME, t.created_at ?? OLD_TIME);
    }
    for (const g of seed.groups) {
      raw.prepare(
        `INSERT INTO meta_instance_upstream_config
          (id, group_id, group_type, name, agents, enabled, mode, version, supported_agents_snapshot, source_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, 3, ?, ?, ?, ?)`,
      ).run(
        g.id, g.group_id, g.group_type, g.name, JSON.stringify(g.agents), g.mode,
        g.group_type === "default" ? JSON.stringify(g.agents) : "[]", g.source_name ?? "", OLD_TIME, OLD_TIME,
      );
    }
    for (const a of seed.accounts) {
      raw.prepare(
        `INSERT INTO meta_upstream_subscription_account
          (account_id, group_id, provider, display_name, access_token, refresh_token, provider_account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        a.account_id, a.group_id, a.provider, a.display_name, `access-${a.account_id}`, `refresh-${a.account_id}`,
        a.provider_account_id, OLD_TIME, OLD_TIME,
      );
    }
    if (seed.globalThresholdPct !== undefined) {
      raw.prepare(
        `INSERT INTO meta_config_params (scope, user_id, module, param_name, param_value, description, created_at, updated_at)
         VALUES ('global', NULL, 'subscription_pool', 'threshold_pct', ?, 'threshold', ?, ?)`,
      ).run(seed.globalThresholdPct, OLD_TIME, OLD_TIME);
    }
  } finally {
    raw.close();
  }
}
