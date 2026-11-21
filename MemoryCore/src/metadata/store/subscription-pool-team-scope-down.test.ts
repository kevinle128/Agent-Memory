/** The roll-back script for team-scoped subscription pools, run on SQLite databases made by the current store. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteMetadataStore } from "./sqlite-adapter.js";
import { MetadataService } from "../service/metadata-service.js";
import type { SupportedAgent } from "../types.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const SCRIPT = path.resolve(import.meta.dirname, "../../../scripts/ops/subscription-pool-team-scope-down.mjs");
const { runDownStep, DownStepRefused } = (await import(pathToFileURL(SCRIPT).href)) as {
  runDownStep: (o: { db: string; dryRun?: boolean; backupDir?: string }) => Record<string, any>;
  DownStepRefused: new (...a: any[]) => Error & { code: string };
};

const AGENTS: SupportedAgent[] = [
  { agent_source: "claude-code", protocol: "anthropic", display_name: "Claude Code" },
  { agent_source: "codex", protocol: "openai-responses", display_name: "Codex" },
];
const ACCESS_TOKEN = "access-secret-token-value";
const REFRESH_TOKEN = "refresh-secret-token-value";

describe("subscription pool team scope roll-back script", () => {
  let dir: string;
  let dbPath: string;
  let backups: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pool-down-"));
    dbPath = path.join(dir, "metadata.db");
    backups = path.join(dir, "backups");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A database in the new shape. Each listed team enables the pools in `providers`. */
  async function buildDatabase(pools: Array<{ team: string; providers: Array<"claude" | "codex"> }>): Promise<void> {
    const store = new SqliteMetadataStore(dbPath);
    store.init();
    await store.ensureDefaultSeeded(AGENTS);
    await store.createUser({ user_id: "usr-owner", username: "owner", auth_provider: "local", external_id: "owner", default_key_value: "owner-key", user_type: "normal" });
    const svc = new MetadataService(store, "default");
    for (const { team, providers } of pools) {
      await store.createTeam({ team_id: team, name: team, owner_user_id: "usr-owner" });
      for (const provider of providers) {
        await svc.enableSubscriptionPool(team, provider, AGENTS);
        await svc.updateSubscriptionPoolClients(team, provider, [provider === "claude" ? "claude-code" : "codex"], AGENTS);
        const [group] = (await store.listInstanceUpstreamGroups({ mode: "subscription_pool", team_id: team }, AGENTS))
          .filter((g) => g.name.includes(provider));
        await store.upsertSubscriptionAccountByProviderId({
          group_id: group!.group_id, provider, provider_account_id: `p-${team}-${provider}`, display_name: "acct",
          access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, token_expires_at: Date.now() + 3_600_000,
          threshold_pct: 80,
        });
      }
    }
    await store.close();
  }

  function query<T = Record<string, any>>(sql: string): T[] {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  }

  function exec(sql: string): void {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  }

  const fileHash = () => createHash("sha256").update(readFileSync(dbPath)).digest("hex");
  const defaultAgents = () => JSON.parse(query<{ agents: string }>("SELECT agents FROM meta_instance_upstream_config WHERE group_type = 'default'")[0]!.agents) as string[];
  const indexNames = () => query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'meta_instance_upstream_config'").map((r) => r.name);

  it("changes nothing on a dry run and reports the plan", async () => {
    await buildDatabase([{ team: "team-a", providers: ["claude", "codex"] }]);
    expect(defaultAgents()).toEqual(expect.arrayContaining(["claude-code", "codex"]));
    const before = fileHash();

    const result = runDownStep({ db: dbPath, dryRun: true, backupDir: backups });

    expect(result).toMatchObject({ dry_run: true, pool_rows: 2, teams_with_pools: 1, pool_team: "team-a", agents_removed: 2, backup: null });
    expect(fileHash()).toBe(before);
    expect(existsSync(backups)).toBe(false);
  });

  it("puts the old source name index back, removes the pooled agents from the default group and keeps the data", async () => {
    await buildDatabase([{ team: "team-a", providers: ["claude", "codex"] }]);
    const accountsBefore = query("SELECT account_id, group_id, access_token, refresh_token, threshold_pct FROM meta_upstream_subscription_account ORDER BY account_id");
    expect(indexNames()).toContain("ux_iuc_team_source_name");

    const result = runDownStep({ db: dbPath, backupDir: backups });

    expect(result).toMatchObject({ dry_run: false, pool_rows: 2, teams_with_pools: 1, agents_removed: 2, quick_check: "ok" });
    expect(defaultAgents()).not.toContain("claude-code");
    expect(defaultAgents()).not.toContain("codex");
    expect(indexNames()).toContain("ux_iuc_source_name");
    expect(indexNames()).not.toContain("ux_iuc_team_source_name");
    // The old code needs the source name to be unique over all groups.
    expect(() => exec(
      `INSERT INTO meta_instance_upstream_config (group_id, group_type, name, mode, source_name, created_at, updated_at)
       VALUES ('dup', 'custom', 'dup', 'custom_unified', 'sub-claude', 'x', 'x')`,
    )).toThrow(/UNIQUE/);
    // The columns of the new code and every account stay.
    const columns = query<{ name: string }>("SELECT name FROM pragma_table_info('meta_instance_upstream_config')").map((c) => c.name);
    expect(columns).toContain("team_id");
    expect(query("SELECT account_id, group_id, access_token, refresh_token, threshold_pct FROM meta_upstream_subscription_account ORDER BY account_id")).toEqual(accountsBefore);
    expect(query<{ team_id: string }>("SELECT team_id FROM meta_instance_upstream_config WHERE mode = 'subscription_pool'").map((r) => r.team_id)).toEqual(["team-a", "team-a"]);
  });

  it("copies the database files to a backup folder with mode 600 before it writes, and prints no token", async () => {
    await buildDatabase([{ team: "team-a", providers: ["claude"] }]);
    const before = fileHash();

    const result = runDownStep({ db: dbPath, backupDir: backups });

    const folder = result.backup as string;
    expect(path.dirname(folder)).toBe(backups);
    const copy = path.join(folder, "metadata.db");
    expect(createHash("sha256").update(readFileSync(copy)).digest("hex")).toBe(before);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(readdirSync(folder).every((f) => f.startsWith("metadata.db"))).toBe(true);
    const printed = JSON.stringify(result);
    expect(printed).not.toContain(ACCESS_TOKEN);
    expect(printed).not.toContain(REFRESH_TOKEN);
  });

  it("changes nothing on a second run", async () => {
    await buildDatabase([{ team: "team-a", providers: ["claude"] }]);
    runDownStep({ db: dbPath, backupDir: backups });
    const afterFirst = fileHash();

    const second = runDownStep({ db: dbPath, backupDir: backups });

    expect(second).toMatchObject({ agents_removed: 0, quick_check: "ok" });
    expect(fileHash()).toBe(afterFirst);
  });

  it("refuses when more than one team holds pools, and changes nothing", async () => {
    await buildDatabase([
      { team: "team-a", providers: ["claude"] },
      { team: "team-b", providers: ["claude"] },
    ]);
    const before = fileHash();

    expect(() => runDownStep({ db: dbPath, backupDir: backups })).toThrow(DownStepRefused);
    expect(() => runDownStep({ db: dbPath, backupDir: backups })).toThrow(/team-a, team-b/);
    expect(() => runDownStep({ db: dbPath, dryRun: true })).toThrow(/More than one team/);
    expect(fileHash()).toBe(before);
    expect(existsSync(backups)).toBe(false);
  });

  it("refuses when a source name is used twice, and changes nothing", async () => {
    await buildDatabase([{ team: "team-a", providers: ["claude"] }]);
    // The new index allows the same name in the instance scope and in a team scope.
    exec(
      `INSERT INTO meta_instance_upstream_config (group_id, group_type, name, mode, source_name, created_at, updated_at)
       VALUES ('api-dup', 'custom', 'api dup', 'custom_unified', 'sub-claude', 'x', 'x')`,
    );
    const before = fileHash();

    let thrown: (Error & { code?: string }) | null = null;
    try {
      runDownStep({ db: dbPath, backupDir: backups });
    } catch (e) {
      thrown = e as Error & { code?: string };
    }

    expect(thrown).toBeInstanceOf(DownStepRefused);
    expect(thrown!.code).toBe("duplicate_source_name");
    expect(thrown!.message).toContain("sub-claude");
    expect(fileHash()).toBe(before);
    expect(existsSync(backups)).toBe(false);
  });

  it("refuses when a pooled agent would stay in a second group", async () => {
    await buildDatabase([{ team: "team-a", providers: ["claude"] }]);
    exec(
      `INSERT INTO meta_instance_upstream_config (group_id, group_type, name, mode, agents, created_at, updated_at)
       VALUES ('api-overlap', 'custom', 'api overlap', 'custom_unified', '["claude-code"]', 'x', 'x')`,
    );

    expect(() => runDownStep({ db: dbPath, backupDir: backups })).toThrow(/claude-code in/);
    expect(existsSync(backups)).toBe(false);
  });

  it("rolls the whole step back when a write fails", async () => {
    await buildDatabase([{ team: "team-a", providers: ["claude"] }]);
    // A trigger makes the update of the default group fail, after the plan was accepted.
    exec("CREATE TRIGGER fail_update BEFORE UPDATE ON meta_instance_upstream_config BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
    const agentsBefore = defaultAgents();

    expect(() => runDownStep({ db: dbPath, backupDir: backups })).toThrow(/forced failure/);

    expect(defaultAgents()).toEqual(agentsBefore);
    expect(indexNames()).toContain("ux_iuc_team_source_name");
    expect(indexNames()).not.toContain("ux_iuc_source_name");
  });

  it("handles a disabled pool group: it has no clients, so no agent leaves the default group", async () => {
    await buildDatabase([{ team: "team-a", providers: ["claude", "codex"] }]);
    const store = new SqliteMetadataStore(dbPath);
    store.init();
    const svc = new MetadataService(store, "default");
    // A pool that still has clients cannot be disabled.
    await expect(svc.disableSubscriptionPool("team-a", "codex", AGENTS)).rejects.toBeDefined();
    await svc.updateSubscriptionPoolClients("team-a", "codex", [], AGENTS);
    await svc.disableSubscriptionPool("team-a", "codex", AGENTS);
    await store.close();
    expect(query<{ enabled: number; agents: string }>("SELECT enabled, agents FROM meta_instance_upstream_config WHERE mode = 'subscription_pool' AND name LIKE '%codex%'")).toEqual([{ enabled: 0, agents: "[]" }]);

    const result = runDownStep({ db: dbPath, backupDir: backups });

    // Only the claude pool still holds a client. The disabled row stays and counts as a pool group.
    expect(result).toMatchObject({ pool_rows: 2, teams_with_pools: 1, pool_team: "team-a", agents_removed: 1, agents: ["claude-code"] });
    expect(defaultAgents()).toContain("codex");
    expect(defaultAgents()).not.toContain("claude-code");
  });

  it("still refuses when the second team only has a disabled pool group, because the row stays", async () => {
    await buildDatabase([
      { team: "team-a", providers: ["claude"] },
      { team: "team-b", providers: ["codex"] },
    ]);
    const store = new SqliteMetadataStore(dbPath);
    store.init();
    const svc = new MetadataService(store, "default");
    await svc.updateSubscriptionPoolClients("team-b", "codex", [], AGENTS);
    await svc.disableSubscriptionPool("team-b", "codex", AGENTS);
    await store.close();

    expect(() => runDownStep({ db: dbPath, backupDir: backups })).toThrow(/Disabling a pool keeps its group/);
  });

  it("runs after the second team is deleted", async () => {
    await buildDatabase([
      { team: "team-a", providers: ["claude"] },
      { team: "team-b", providers: ["claude"] },
    ]);
    expect(() => runDownStep({ db: dbPath, backupDir: backups })).toThrow(DownStepRefused);
    const store = new SqliteMetadataStore(dbPath);
    store.init();
    await store.deleteTeams(["team-b"]);
    await store.close();

    expect(runDownStep({ db: dbPath, backupDir: backups })).toMatchObject({ pool_team: "team-a", teams_with_pools: 1, quick_check: "ok" });
  });

  it("needs a backup folder for a real run, and none for a dry run", async () => {
    await buildDatabase([{ team: "team-a", providers: ["claude"] }]);
    const before = fileHash();
    expect(() => runDownStep({ db: dbPath })).toThrow(/--backup-dir is required/);
    expect(fileHash()).toBe(before);
    expect(runDownStep({ db: dbPath, dryRun: true })).toMatchObject({ dry_run: true });
  });

  it("refuses a database that is not a Core metadata database", () => {
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE other (id INTEGER)");
    db.close();
    expect(() => runDownStep({ db: dbPath, backupDir: backups })).toThrow(/Core metadata database/);
  });
});
