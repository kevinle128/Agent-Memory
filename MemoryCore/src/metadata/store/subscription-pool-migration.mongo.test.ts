/**
 * Runs the subscription pool team migration contract on MongoDB. It needs a local `mongod` binary,
 * taken from MONGOMS_SYSTEM_BINARY or from PATH. Without one, the suite is skipped.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { MongoClient } from "mongodb";
import type { MongoMemoryServer } from "mongodb-memory-server";
import { MongoMetadataStore } from "./mongodb-adapter.js";
import {
  runSubscriptionPoolMigrationContract,
  type LegacyPoolSeed,
} from "./subscription-pool-migration.contract.js";

function findMongod(): string | null {
  if (process.env.MONGOMS_SYSTEM_BINARY) return process.env.MONGOMS_SYSTEM_BINARY;
  try {
    const found = execFileSync("which", ["mongod"], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}

const mongodPath = findMongod();
const OLD_TIME = "2026-01-01T00:00:00.000Z";

if (!mongodPath) {
  describe.skip("subscription pool team migration: mongodb (no mongod binary found)", () => {});
} else {
  let server: MongoMemoryServer;
  let client: MongoClient;
  let dbSeq = 0;

  beforeAll(async () => {
    process.env.MONGOMS_SYSTEM_BINARY = mongodPath;
    const { MongoMemoryServer: Server } = await import("mongodb-memory-server");
    server = await Server.create();
    client = new MongoClient(server.getUri());
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  /** Documents as the build before team-scoped pools wrote them: no `team_id`, no `threshold_pct`. */
  async function seedLegacy(dbName: string, seed: LegacyPoolSeed): Promise<void> {
    const db = client.db(dbName);
    if (seed.teams.length > 0) {
      await db.collection("meta_teams").insertMany(seed.teams.map((t) => ({
        team_id: t.team_id, name: t.name, description: null, owner_user_id: "usr-owner",
        status: t.status ?? "active", created_at: t.created_at ?? OLD_TIME, updated_at: t.created_at ?? OLD_TIME,
        metadata_json: "{}",
      })));
    }
    if (seed.groups.length > 0) await db.collection("meta_instance_upstream_config").insertMany(seed.groups.map((g) => ({
      id: g.id, group_id: g.group_id, group_type: g.group_type, name: g.name, agents: g.agents, enabled: true,
      mode: g.mode, base_url: "", api_key: "", model_id: "", description: "", version: 3,
      supported_agents_snapshot: g.group_type === "default" ? g.agents : [],
      source_name: g.source_name ?? "", source_provider: "", source_formats: [], source_agents: [],
      source_enabled: false, source_models: [], source_models_fetched_at: null, source_models_error: null,
      created_at: OLD_TIME, updated_at: OLD_TIME,
    })));
    // The index of the old build: a source name unique in the whole instance.
    await db.collection("meta_instance_upstream_config").createIndex(
      { source_name: 1 },
      { unique: true, partialFilterExpression: { source_name: { $gt: "" } }, name: "ux_source_name" },
    );
    if (seed.accounts.length > 0) {
      await db.collection("meta_upstream_subscription_account").insertMany(seed.accounts.map((a) => ({
        account_id: a.account_id, group_id: a.group_id, provider: a.provider, display_name: a.display_name,
        account_label: "", enabled: true, status: "active", access_token: `access-${a.account_id}`,
        refresh_token: `refresh-${a.account_id}`, token_expires_at: null, provider_account_id: a.provider_account_id,
        project_id: null, usage: { windows: [] }, reset_credits: null, usage_updated_at: null, exhausted_until: null,
        usage_fail_count: 0, refresh_fail_count: 0, last_error: null, active_sessions: 0, version: 1,
        created_at: OLD_TIME, updated_at: OLD_TIME,
      })));
    }
    if (seed.globalThresholdPct !== undefined) {
      await db.collection("meta_config_params").insertOne({
        id: 1, scope: "global", user_id: null, module: "subscription_pool", param_name: "threshold_pct",
        param_value: seed.globalThresholdPct, description: "threshold", created_at: OLD_TIME, updated_at: OLD_TIME,
      });
    }
  }

  async function open(dbName: string, options?: { defaultTeamName?: string; defaultTeamId?: string }): Promise<MongoMetadataStore> {
    // A standalone server has no transactions, so the store runs without them.
    const store = new MongoMetadataStore(client, dbName, {
      useTransactions: false,
      ownsClient: false,
      defaultTeamName: options?.defaultTeamName,
      defaultTeamId: options?.defaultTeamId,
    });
    await store.init();
    return store;
  }

  runSubscriptionPoolMigrationContract("mongodb", {
    async newDatabase() {
      dbSeq += 1;
      return `meta_pool_team_${dbSeq}`;
    },
    seedLegacy,
    open,
    async close(store) {
      await store.close();
    },
  });

  describe("subscription pool team indexes: mongodb", () => {
    it("replaces the old source name index with the team index", async () => {
      dbSeq += 1;
      const dbName = `meta_pool_team_${dbSeq}`;
      await seedLegacy(dbName, { teams: [], groups: [], accounts: [] });
      const store = await open(dbName);
      try {
        const names = (await client.db(dbName).collection("meta_instance_upstream_config").indexes()).map((i) => i.name);
        expect(names).toContain("ux_team_source_name");
        expect(names).not.toContain("ux_source_name");
      } finally {
        await store.close();
      }
    });

    it("passes the configured default team name from the store pool to the store", async () => {
      const { MetadataStorePool } = await import("./factory.js");
      const { resolveMetadataDbName } = await import("./db-name.js");
      const instanceId = `pool-team-${Date.now()}`;
      await seedLegacy(resolveMetadataDbName(instanceId), {
        teams: [{ team_id: "team-def", name: "default" }, { team_id: "team-main", name: "Main" }],
        groups: [
          { id: 1, group_id: "dflt-old", group_type: "default", name: "default", mode: "official", agents: [] },
          { id: 2, group_id: "grp-pool", group_type: "custom", name: "claude pool", mode: "subscription_pool", agents: ["claude-code"], source_name: "sub-claude" },
        ],
        accounts: [],
      });
      const pool = new MetadataStorePool({
        backend: "mongodb", mongoUri: server.getUri(), mongoTransactions: false, defaultTeamName: "Main",
      });
      try {
        const store = await pool.getStore(instanceId);
        expect((await store.getInstanceUpstreamGroup("grp-pool"))!.team_id).toBe("team-main");
      } finally {
        await pool.closeAll();
      }
    });

    it("creates the team index on a new database", async () => {
      dbSeq += 1;
      const dbName = `meta_pool_team_${dbSeq}`;
      const store = await open(dbName);
      try {
        const names = (await client.db(dbName).collection("meta_instance_upstream_config").indexes()).map((i) => i.name);
        expect(names).toContain("ux_team_source_name");
      } finally {
        await store.close();
      }
    });
  });
}
