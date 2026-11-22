/**
 * Contract tests for the start-up migration of team-scoped subscription pools. Each case writes a
 * database in the shape of the build before pool groups had a team and accounts had a threshold,
 * then opens the store on it. The same cases run on SQLite and on MongoDB.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IMetadataStore } from "./interface.js";
import type { SubscriptionProvider, UpstreamMode } from "../types.js";

export interface LegacyTeamSeed {
  team_id: string;
  name: string;
  status?: string;
  created_at?: string;
}

export interface LegacyGroupSeed {
  id: number;
  group_id: string;
  group_type: "default" | "custom";
  name: string;
  mode: UpstreamMode;
  agents: string[];
  source_name?: string;
}

export interface LegacyAccountSeed {
  account_id: string;
  group_id: string;
  provider: SubscriptionProvider;
  provider_account_id: string;
  display_name: string;
}

/** Rows of a database that an earlier build wrote: no group team, no account threshold. */
export interface LegacyPoolSeed {
  teams: LegacyTeamSeed[];
  groups: LegacyGroupSeed[];
  accounts: LegacyAccountSeed[];
  /** Stored global start value of the threshold. Absent: no stored value. */
  globalThresholdPct?: string;
}

/** Default team settings of a store (env TDAI_METADATA_DEFAULT_TEAM_NAME). */
export interface PoolMigrationOpenOptions {
  defaultTeamName?: string;
}

export interface PoolMigrationHarness {
  /** A key for a new, empty database. */
  newDatabase(): Promise<string>;
  /** Write the seed into the database in the old shape. Runs before any store opens it. */
  seedLegacy(db: string, seed: LegacyPoolSeed): Promise<void>;
  /** Open and initialize a store on the database. */
  open(db: string, options?: PoolMigrationOpenOptions): Promise<IMetadataStore>;
  close(store: IMetadataStore): Promise<void>;
}

const OLD_TIME = "2026-01-01T00:00:00.000Z";

function team(team_id: string, name: string, over: Partial<LegacyTeamSeed> = {}): LegacyTeamSeed {
  return { team_id, name, created_at: OLD_TIME, ...over };
}

/**
 * A database with one default group, a claude and a codex pool whose agents are only in the
 * pools (the old rule moved them out of the default group), an API group, and three accounts.
 */
function legacySeed(teams: LegacyTeamSeed[], over: Partial<LegacyPoolSeed> = {}): LegacyPoolSeed {
  return {
    teams,
    groups: [
      { id: 1, group_id: "dflt-old", group_type: "default", name: "default", mode: "official", agents: ["codebuddy"] },
      { id: 2, group_id: "grp-pool-claude", group_type: "custom", name: "claude subscription pool", mode: "subscription_pool", agents: ["claude-code"], source_name: "sub-claude" },
      { id: 3, group_id: "grp-pool-codex", group_type: "custom", name: "codex subscription pool", mode: "subscription_pool", agents: ["codex"], source_name: "sub-openai" },
      { id: 4, group_id: "grp-api", group_type: "custom", name: "api group", mode: "custom_unified", agents: ["cursor"] },
    ],
    accounts: [
      { account_id: "sacc-c1", group_id: "grp-pool-claude", provider: "claude", provider_account_id: "p-c1", display_name: "Max 1" },
      { account_id: "sacc-c2", group_id: "grp-pool-claude", provider: "claude", provider_account_id: "p-c2", display_name: "Max 2" },
      { account_id: "sacc-x1", group_id: "grp-pool-codex", provider: "codex", provider_account_id: "p-x1", display_name: "Pro 1" },
    ],
    ...over,
  };
}

const POOL_IDS = ["grp-pool-claude", "grp-pool-codex"];

export function runSubscriptionPoolMigrationContract(name: string, harness: PoolMigrationHarness): void {
  describe(`subscription pool team migration: ${name}`, () => {
    const opened: IMetadataStore[] = [];

    async function openStore(db: string, options?: PoolMigrationOpenOptions): Promise<IMetadataStore> {
      const store = await harness.open(db, options);
      opened.push(store);
      return store;
    }

    async function closeStore(store: IMetadataStore): Promise<void> {
      opened.splice(opened.indexOf(store), 1);
      await harness.close(store);
    }

    async function migrated(seed: LegacyPoolSeed, options?: PoolMigrationOpenOptions): Promise<{ db: string; store: IMetadataStore }> {
      const db = await harness.newDatabase();
      await harness.seedLegacy(db, seed);
      return { db, store: await openStore(db, options) };
    }

    async function poolTeams(store: IMetadataStore): Promise<Record<string, string>> {
      const out: Record<string, string> = {};
      for (const id of POOL_IDS) out[id] = (await store.getInstanceUpstreamGroup(id))!.team_id;
      return out;
    }

    const allPools = (teamId: string) => Object.fromEntries(POOL_IDS.map((id) => [id, teamId]));

    afterEach(async () => {
      vi.restoreAllMocks();
      for (const store of opened.splice(0)) await harness.close(store);
    });

    it("assigns existing pool groups to the only default team and gives their agents back to the default group", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const { store } = await migrated(legacySeed([team("team-def", "default"), team("team-game", "GAME")]));

      expect(await poolTeams(store)).toEqual(allPools("team-def"));
      const def = (await store.getInstanceUpstreamGroup("dflt-old"))!;
      expect(def.agents).toEqual(["codebuddy", "claude-code", "codex"]);
      expect(def.team_id).toBe("");
      // The pool keeps its agents: the team pool is a layer over the instance group.
      expect((await store.getInstanceUpstreamGroup("grp-pool-claude"))!.agents).toEqual(["claude-code"]);
      expect((await store.getInstanceUpstreamGroup("grp-api"))!).toMatchObject({ team_id: "", agents: ["cursor"] });
      expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("team backfill"))).toEqual([
        "[subscription-pool] team backfill team=team-def groups=2 agents_restored=claude-code,codex",
      ]);
    });

    it("assigns pool groups to the team named default", async () => {
      const { store } = await migrated(legacySeed([team("team-def", "default"), team("team-new", "default-team")]));
      expect(await poolTeams(store)).toEqual(allPools("team-def"));
    });

    it("uses default-team when no team is named default", async () => {
      const { store } = await migrated(legacySeed([team("team-fresh", "default-team"), team("team-game", "GAME")]));
      expect(await poolTeams(store)).toEqual(allPools("team-fresh"));
    });

    it("ignores a team named default that is not active", async () => {
      const { store } = await migrated(legacySeed([
        team("team-old", "default", { status: "archived" }),
        team("team-fresh", "default-team"),
      ]));
      expect(await poolTeams(store)).toEqual(allPools("team-fresh"));
    });

    it("uses only the configured name when it is set, and ignores default and default-team", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const teams = [team("team-def", "default"), team("team-fresh", "default-team"), team("team-main", "Main")];
      const first = await migrated(legacySeed(teams), { defaultTeamName: "Missing" });
      expect(await poolTeams(first.store)).toEqual(allPools(""));
      await closeStore(first.store);

      const second = await openStore(first.db, { defaultTeamName: "Main" });
      expect(await poolTeams(second)).toEqual(allPools("team-main"));
    });

    it("stops at two teams named default and does not try default-team", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { store } = await migrated(legacySeed([
        team("team-b", "default"),
        team("team-a", "default"),
        team("team-fresh", "default-team"),
      ]));

      expect(await poolTeams(store)).toEqual(allPools(""));
      const line = error.mock.calls.map((c) => String(c[0])).find((l) => l.includes("team backfill")) ?? "";
      expect(line).toContain("reason=ambiguous");
      expect(line).toContain("candidates=team-a,team-b");
      expect(line).not.toContain("default");
      expect((await store.getInstanceUpstreamGroup("dflt-old"))!.agents).toEqual(["codebuddy", "claude-code", "codex"]);
    });

    it("leaves pool groups unassigned but still gives their agents back to the default group when no default team is found", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { store } = await migrated(legacySeed([team("team-game", "GAME")]));

      expect(await poolTeams(store)).toEqual(allPools(""));
      expect((await store.getInstanceUpstreamGroup("dflt-old"))!.agents).toEqual(["codebuddy", "claude-code", "codex"]);
      expect(error.mock.calls.some((c) => String(c[0]).includes("reason=not_found candidates=none"))).toBe(true);

      // A pool without a team is in no scope, so it does not block an instance write.
      const moved = await store.moveAgentBetweenUpstreamGroups({
        agent: "claude-code", from: [{ group_id: "dflt-old" }], to: { group_id: "grp-api" },
      });
      expect(moved.to.agents).toEqual(["cursor", "claude-code"]);
      // A group without a team stays editable.
      const renamed = await store.updateInstanceUpstreamGroup({
        group_id: "grp-pool-claude", expected_group_type: "custom", description: "kept for later",
      });
      expect(renamed).toMatchObject({ team_id: "", description: "kept for later" });
    });

    it("runs the team backfill again without a change", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const { db, store } = await migrated(legacySeed([team("team-def", "default")]));
      const before = await store.listInstanceUpstreamGroups();
      const accountsBefore = await store.listSubscriptionAccounts();
      await closeStore(store);
      log.mockClear();

      const again = await openStore(db);
      expect(await again.listInstanceUpstreamGroups()).toEqual(before);
      expect(await again.listSubscriptionAccounts()).toEqual(accountsBefore);
      expect(log.mock.calls.filter((c) => String(c[0]).includes("team backfill"))).toEqual([]);
    });

    it("keeps the accounts of a pool group when the group moves to the default team", async () => {
      const { store } = await migrated(legacySeed([team("team-def", "default")]));
      expect((await store.listSubscriptionAccounts("grp-pool-claude")).map((a) => a.account_id)).toEqual(["sacc-c1", "sacc-c2"]);
      expect((await store.listSubscriptionAccounts("grp-pool-codex")).map((a) => a.account_id)).toEqual(["sacc-x1"]);
      expect(await store.getSubscriptionAccount("sacc-c1")).toMatchObject({
        group_id: "grp-pool-claude", provider: "claude", provider_account_id: "p-c1", display_name: "Max 1",
        access_token: "access-sacc-c1", refresh_token: "refresh-sacc-c1",
      });
    });

    it("lets a second team create a pool with the same source name after the migration", async () => {
      const { store } = await migrated(legacySeed([team("team-def", "default")]));
      const second = await store.createInstanceUpstreamGroup({
        group_type: "custom", team_id: "team-other", name: "claude subscription pool", agents: ["claude-code"],
        mode: "subscription_pool", source_name: "sub-claude",
      });
      expect(second).toMatchObject({ team_id: "team-other", source_name: "sub-claude" });
    });

    it("copies the global threshold into every existing account when the threshold column is added", async () => {
      const { store } = await migrated(legacySeed([team("team-def", "default")], { globalThresholdPct: "80" }));
      expect((await store.listSubscriptionAccounts()).map((a) => a.threshold_pct)).toEqual([80, 80, 80]);
    });

    it("uses 95 when no global threshold is stored", async () => {
      const { store } = await migrated(legacySeed([team("team-def", "default")]));
      expect((await store.listSubscriptionAccounts()).map((a) => a.threshold_pct)).toEqual([95, 95, 95]);
    });

    it("uses 95 when the stored global threshold is not valid", async () => {
      const { store } = await migrated(legacySeed([team("team-def", "default")], { globalThresholdPct: "40" }));
      expect((await store.listSubscriptionAccounts()).map((a) => a.threshold_pct)).toEqual([95, 95, 95]);
    });

    it("does not copy the global value again on the next start", async () => {
      const { db, store } = await migrated(legacySeed([team("team-def", "default")], { globalThresholdPct: "80" }));
      await store.updateSubscriptionAccount("sacc-c2", { threshold_pct: 70 });
      await store.upsertConfigParam({
        scope: "global", user_id: null, module: "subscription_pool", param_name: "threshold_pct",
        param_value: "60", description: "Usage threshold for new subscription pool sessions",
      });
      await closeStore(store);

      const again = await openStore(db);
      const byId = Object.fromEntries((await again.listSubscriptionAccounts()).map((a) => [a.account_id, a.threshold_pct]));
      expect(byId).toEqual({ "sacc-c1": 80, "sacc-c2": 70, "sacc-x1": 80 });
    });
  });
}
