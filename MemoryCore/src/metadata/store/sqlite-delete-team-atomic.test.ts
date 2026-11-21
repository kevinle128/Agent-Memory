import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteMetadataStore } from "./sqlite-adapter.js";
import { MetadataService } from "../service/metadata-service.js";
import type { SupportedAgent } from "../types.js";

const require = createRequire(import.meta.url);

const AGENTS: SupportedAgent[] = [
  { agent_source: "claude-code", protocol: "anthropic", display_name: "Claude Code" },
];
const TEAM = "team-del";

describe("SQLite team delete is one transaction", () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteMetadataStore;
  let accountId: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "meta-team-delete-"));
    dbPath = path.join(dir, "metadata.db");
    store = new SqliteMetadataStore(dbPath);
    store.init();
    await store.ensureDefaultSeeded(AGENTS);
    await store.createUser({ user_id: "usr-owner", username: "owner", auth_provider: "local", external_id: "owner", default_key_value: "owner-key", user_type: "normal" });
    await store.createTeam({ team_id: TEAM, name: "team del", owner_user_id: "usr-owner" });
    const svc = new MetadataService(store, "default");
    await svc.enableSubscriptionPool(TEAM, "claude", AGENTS);
    const [group] = await store.listInstanceUpstreamGroups({ mode: "subscription_pool", team_id: TEAM }, AGENTS);
    const { account } = await store.upsertSubscriptionAccountByProviderId({
      group_id: group!.group_id, provider: "claude", provider_account_id: "p-1", display_name: "one",
      access_token: "access-1", refresh_token: "refresh-1", token_expires_at: Date.now() + 3_600_000,
    });
    accountId = account.account_id;
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Make one statement fail from another connection, as a locked or full database would. */
  function failDeletesOn(table: string): void {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const other = new DatabaseSync(dbPath);
    try {
      other.exec(
        `CREATE TRIGGER fail_delete_${table} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'forced failure'); END`,
      );
    } finally {
      other.close();
    }
  }

  it("deletes the team, its pool groups and its accounts together", async () => {
    const result = await store.deleteTeams([TEAM]);
    expect(result.deleted_ids).toEqual([TEAM]);
    expect(result.deleted_pool_account_ids).toEqual([accountId]);
    expect(await store.getTeamById(TEAM)).toBeNull();
    expect(await store.getSubscriptionAccount(accountId)).toBeNull();
    expect(await store.listInstanceUpstreamGroups({ mode: "subscription_pool", team_id: TEAM }, AGENTS)).toEqual([]);
  });

  it("leaves the team, its members, its pool groups and its accounts when the pool delete fails", async () => {
    failDeletesOn("meta_instance_upstream_config");

    await expect(async () => store.deleteTeams([TEAM])).rejects.toThrow(/forced failure/);

    expect(await store.getTeamById(TEAM)).not.toBeNull();
    expect((await store.listTeamsByUser("usr-owner")).items.map((t) => t.team_id)).toEqual([TEAM]);
    expect(await store.getSubscriptionAccount(accountId)).not.toBeNull();
    expect(await store.listInstanceUpstreamGroups({ mode: "subscription_pool", team_id: TEAM }, AGENTS)).toHaveLength(1);
  });
});
