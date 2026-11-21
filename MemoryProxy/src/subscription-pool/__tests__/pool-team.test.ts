/**
 * The request team helper against the real session store, with primed pool rows and accounts.
 * No test here calls the network: a Core call that a rule must not make fails the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import { __resetSessionStoreForTests, getSessionStore } from "../../session/store.js";
import type { SessionInitState } from "../../session/types.js";
import type { BindingRepo } from "../../db/binding-repo.js";
import { setMetadataClient, type MetadataClient } from "../../meta/client.js";
import { initSystemUsers } from "../../systemUser.js";
import type { ProxyConfig } from "../../types.js";
import { __primeAccountCacheForTests, markAccountUnavailable } from "../account-cache.js";
import {
  __setTeamListFetcherForTests, clearTeamCaches, immediateTeamError, listMemberTeamIds, resolveRequestTeam,
  settleRequestTeam, settleTeamAfterInit, teamErrorResponse, type RequestTeamInput,
} from "../pool-team.js";
import type { PoolAccount } from "../types.js";
import { makeConfig, POOL_TEST_USER, resetPoolState, setPoolTestTeams, useRealSessionTeams } from "./test-harness.js";

const SPACE = "sp-team";
const NOW = Date.now();
const HOUR = 3_600_000;
const KEY = "sk-mem-user";

const defaultRow: InstanceUpstreamRow = {
  group_id: "d", group_type: "default", name: "default", agents: ["claude-code", "codex"], enabled: true,
  mode: "official", base_url: "", api_key: "", model_id: "",
};

function poolOf(team: string, partial: Partial<InstanceUpstreamRow> = {}): InstanceUpstreamRow {
  return {
    group_id: `pool-${team}`, group_type: "custom", name: `pool ${team}`, agents: ["claude-code"], enabled: true,
    mode: "subscription_pool", team_id: team, base_url: "", api_key: "", model_id: "", ...partial,
  };
}

function accountOf(team: string, partial: Partial<PoolAccount> = {}): PoolAccount {
  return {
    account_id: `acc-${team}`, group_id: `pool-${team}`, provider: "claude", provider_account_id: `p-${team}`,
    status: "active", enabled: true, access_token: `tok-${team}`, token_expires_at: NOW + HOUR,
    usage: { windows: [] }, exhausted_until: null, ...partial,
  };
}

const exhaustedAccount = (team: string, resetsInMs = HOUR): PoolAccount =>
  accountOf(team, { status: "exhausted", exhausted_until: NOW + resetsInMs });

function prime(rows: InstanceUpstreamRow[], accounts: PoolAccount[]): void {
  __primeCacheForTests(SPACE, [defaultRow, ...rows]);
  __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts });
}

let config: ProxyConfig;
/** The default (team, agent, task) that Core answers for the user. Null means no default; "throw" means Core is down. */
let userDefault: { team_id: string } | null | "throw";

function ask(partial: Partial<RequestTeamInput> = {}) {
  return resolveRequestTeam({
    config, spaceId: SPACE, userId: POOL_TEST_USER, userKey: KEY, agentSource: "claude-code",
    session: { keyId: "claude-code:s1", agentSource: "claude-code", sessionId: "s1" },
    lcHeaders: {}, model: "claude-x", sessionInitMayRun: false, now: NOW, ...partial,
  });
}

async function seed(state: Partial<SessionInitState> & { status: SessionInitState["status"] }, sessionId = "s1", userId = POOL_TEST_USER): Promise<void> {
  const keyId = `claude-code:${sessionId}`;
  await getSessionStore().set(keyId, { keyId, startedAt: Date.now(), attemptCount: 0, userId, ...state } as SessionInitState);
}

const registered = (team: string): Partial<SessionInitState> & { status: "initialized" } => ({
  status: "initialized",
  sessionInfo: { session_id: "s1", team_id: team, agent_id: "ag1", user_id: POOL_TEST_USER },
});

describe("request team helper", () => {
  beforeEach(() => {
    resetPoolState();
    useRealSessionTeams();
    setPoolTestTeams(["team-b", "team-a"]);
    config = makeConfig();
    userDefault = null;
    setMetadataClient({
      getUserSessionDefault: async () => {
        if (userDefault === "throw") throw new Error("core down");
        return userDefault;
      },
    } as unknown as MetadataClient);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => { throw new Error(`unexpected Core call: ${String(url)}`); }));
  });
  afterEach(() => {
    setMetadataClient(null);
    initSystemUsers([]);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetSessionStoreForTests();
    clearTeamCaches();
  });

  describe("gate", () => {
    it("returns null and changes nothing when no pool in the instance serves the client", async () => {
      prime([poolOf("team-a", { agents: ["codex"] })], [accountOf("team-a")]);
      expect(await ask()).toBeNull();
    });

    it("returns null when the only pool rows have no team", async () => {
      prime([poolOf("", { team_id: "" }), poolOf("x", { team_id: undefined })], []);
      expect(await ask()).toBeNull();
    });

    it("returns null for a request without a user and for a system user", async () => {
      prime([poolOf("team-a")], [accountOf("team-a")]);
      expect(await ask({ userId: "" })).toBeNull();
      expect(await ask({ userId: "anonymous" })).toBeNull();
      initSystemUsers([{ name: "memory", userId: "usr-system", userKey: "k", displayName: "Memory" }]);
      expect(await ask({ userId: "usr-system" })).toBeNull();
    });

    it("counts a model source prefix as a pool client, also when the pool is off", async () => {
      const source = poolOf("team-a", { agents: [], enabled: false, source_name: "sub-claude", source_agents: ["hermes"] });
      prime([source], []);
      config.modelSources = { enabled: true };
      await seed(registered("team-a"));
      const result = await ask({
        agentSource: "hermes", model: "sub-claude/claude-sonnet",
        session: { keyId: "claude-code:s1", agentSource: "claude-code", sessionId: "s1" },
      });
      expect(result).toEqual({ kind: "team", teamId: "team-a", source: "session" });
    });
  });

  describe("a known team", () => {
    it("takes the team of an initialized session", async () => {
      prime([poolOf("team-a")], [accountOf("team-a")]);
      await seed(registered("team-b"));
      expect(await ask()).toEqual({ kind: "team", teamId: "team-b", source: "session" });
    });

    it("gives the shared normal upstream to a known team without a pool, not the fallback", async () => {
      // Team A has a pool with a usable account and comes first in the list of this user.
      setPoolTestTeams(["team-a", "team-c"]);
      prime([poolOf("team-a")], [accountOf("team-a")]);
      await seed(registered("team-c"));
      expect(await ask()).toEqual({ kind: "team", teamId: "team-c", source: "session" });
    });

    it("uses the L2b binding of a woken session without a rebuild", async () => {
      prime([poolOf("team-a")], [accountOf("team-a")]);
      const getBinding = vi.fn(async () => ({ outcome: "initialized" as const, userId: POOL_TEST_USER, teamId: "team-b", agentSource: "claude-code" }));
      getSessionStore().setBindingRepo({ getBinding } as unknown as BindingRepo);
      expect(await ask()).toEqual({ kind: "team", teamId: "team-b", source: "session" });
      expect(getBinding).toHaveBeenCalledTimes(1);
      expect(getSessionStore().get("claude-code:s1")).toBeUndefined();
    });

    it("ignores an L2b binding of another user", async () => {
      prime([poolOf("team-a")], [accountOf("team-a")]);
      const getBinding = vi.fn(async () => ({ outcome: "initialized" as const, userId: "usr-other", teamId: "team-b", agentSource: "claude-code" }));
      getSessionStore().setBindingRepo({ getBinding } as unknown as BindingRepo);
      expect((await ask())).toMatchObject({ kind: "team", source: "fallback" });
    });

    it("takes the team a user chose in an open form", async () => {
      prime([poolOf("team-a")], [accountOf("team-a")]);
      await seed({ status: "pending_task_select", selectedTeamId: "team-b" });
      expect(await ask({ sessionInitMayRun: true })).toEqual({ kind: "team", teamId: "team-b", source: "pending" });
    });

    it("takes the team of the header preset when init will register it", async () => {
      prime([poolOf("team-a")], [accountOf("team-a")]);
      config.sessionInit = { ...config.sessionInit, enabled: true, headerAutoSelect: { enabled: true, teamHeader: "x-team-id", agentHeader: "x-agent-id", taskHeader: "x-task-id" } } as ProxyConfig["sessionInit"];
      expect(await ask({ sessionInitMayRun: true, lcHeaders: { "x-team-id": "team-b" } }))
        .toEqual({ kind: "team", teamId: "team-b", source: "preset" });
    });

    it("prefers the user default over the header preset, as session init does", async () => {
      prime([poolOf("team-a")], [accountOf("team-a")]);
      config.sessionInit = { ...config.sessionInit, enabled: true, headerAutoSelect: { enabled: true, teamHeader: "x-team-id", agentHeader: "x-agent-id", taskHeader: "x-task-id" } } as ProxyConfig["sessionInit"];
      userDefault = { team_id: "team-a" };
      expect(await ask({ sessionInitMayRun: true, lcHeaders: { "x-team-id": "team-b" } }))
        .toEqual({ kind: "team", teamId: "team-a", source: "default" });
    });

    it("falls to the preset when the team of the user default is not a team of the user", async () => {
      prime([poolOf("team-a")], [accountOf("team-a")]);
      config.sessionInit = { ...config.sessionInit, enabled: true, headerAutoSelect: { enabled: true, teamHeader: "x-team-id", agentHeader: "x-agent-id", taskHeader: "x-task-id" } } as ProxyConfig["sessionInit"];
      userDefault = { team_id: "team-gone" };
      expect(await ask({ sessionInitMayRun: true, lcHeaders: { "x-team-id": "team-b" } }))
        .toEqual({ kind: "team", teamId: "team-b", source: "preset" });
    });

    it("does not use the preset when init will not run for the request", async () => {
      prime([poolOf("team-a")], [accountOf("team-a")]);
      config.sessionInit = { ...config.sessionInit, enabled: true, headerAutoSelect: { enabled: true, teamHeader: "x-team-id", agentHeader: "x-agent-id", taskHeader: "x-task-id" } } as ProxyConfig["sessionInit"];
      expect(await ask({ sessionInitMayRun: false, lcHeaders: { "x-team-id": "team-b" } })).toMatchObject({ source: "fallback" });
    });

    it("takes the team of the user default, and caches it per user", async () => {
      prime([poolOf("team-a")], [accountOf("team-a")]);
      userDefault = { team_id: "team-b" };
      expect(await ask({ sessionInitMayRun: true })).toEqual({ kind: "team", teamId: "team-b", source: "default" });
      userDefault = { team_id: "team-a" };
      // The second answer comes from the cache, so the changed default is not read yet.
      expect(await ask({ sessionInitMayRun: true })).toEqual({ kind: "team", teamId: "team-b", source: "default" });
    });

    it("uses the fallback when the user default cannot be read", async () => {
      prime([poolOf("team-a")], [accountOf("team-a")]);
      userDefault = "throw";
      expect(await ask({ sessionInitMayRun: true })).toMatchObject({ kind: "team", source: "fallback" });
    });

    it("does not use the state of a session that belongs to another user", async () => {
      prime([poolOf("team-a")], [accountOf("team-a")]);
      await seed(registered("team-b"), "s1", "usr-other");
      expect(await ask()).toMatchObject({ kind: "team", teamId: "team-a", source: "fallback" });
    });

    it("treats a team that the user left as no known team", async () => {
      prime([poolOf("team-a")], [accountOf("team-a")]);
      await seed(registered("team-gone"));
      expect(await ask()).toMatchObject({ kind: "team", teamId: "team-a", source: "fallback" });
    });

    it("keeps the chosen team of a bypassed session even when an earlier team has a usable pool", async () => {
      setPoolTestTeams(["team-a", "team-c"]);
      prime([poolOf("team-a")], [accountOf("team-a")]);
      await seed({ status: "initialized", bypassed: true, sessionInfo: null, selectedTeamId: "team-c" });
      expect(await ask()).toEqual({ kind: "team", teamId: "team-c", source: "session" });
    });

    it("uses the fallback for a bypassed session without a chosen team", async () => {
      prime([poolOf("team-a")], [accountOf("team-a")]);
      await seed({ status: "initialized", bypassed: true, sessionInfo: null });
      expect(await ask({ sessionInitMayRun: true })).toMatchObject({ kind: "team", teamId: "team-a", source: "fallback" });
    });
  });

  describe("the ordered fallback", () => {
    it("takes the second team when the first team has no usable account", async () => {
      setPoolTestTeams(["team-b", "team-a"]);
      prime([poolOf("team-a"), poolOf("team-b")], [exhaustedAccount("team-b"), accountOf("team-a")]);
      expect(await ask({ session: null })).toEqual({ kind: "team", teamId: "team-a", source: "fallback" });
    });

    it("keeps the Core order: the newest team comes first", async () => {
      setPoolTestTeams(["team-b", "team-a"]);
      prime([poolOf("team-a"), poolOf("team-b")], [accountOf("team-a"), accountOf("team-b")]);
      expect(await ask({ session: null })).toEqual({ kind: "team", teamId: "team-b", source: "fallback" });
      clearTeamCaches();
      setPoolTestTeams(["team-a", "team-b"]);
      expect(await ask({ session: null })).toEqual({ kind: "team", teamId: "team-a", source: "fallback" });
    });

    it("skips a team whose account is above its own threshold", async () => {
      setPoolTestTeams(["team-b", "team-a"]);
      const busy = accountOf("team-b", { threshold_pct: 50, usage: { windows: [{ name: "w", model_scope: null, used_pct: 60, resets_at: NOW + HOUR, observed_at: NOW, source: "usage_api" }] } });
      // The account is above its threshold but below 100 %, so it still serves as a last resort:
      // it counts as usable and the first team wins.
      prime([poolOf("team-a"), poolOf("team-b")], [busy, accountOf("team-a")]);
      expect(await ask({ session: null })).toEqual({ kind: "team", teamId: "team-b", source: "fallback" });
    });

    it("answers pool_exhausted with the earliest reset when the teams have pools but no usable account", async () => {
      prime([poolOf("team-a"), poolOf("team-b")], [exhaustedAccount("team-b", 3 * HOUR), exhaustedAccount("team-a", HOUR)]);
      const result = await ask({ session: null });
      expect(result).toMatchObject({ kind: "error", code: "pool_exhausted", status: 429, resetAtMs: NOW + HOUR });
    });

    it("answers no_team_pool when no team of the user has a pool for the client", async () => {
      setPoolTestTeams(["team-a", "team-b"]);
      prime([poolOf("team-z")], [accountOf("team-z")]);
      const result = await ask({ session: null });
      expect(result).toMatchObject({ kind: "error", code: "no_team_pool", status: 403 });
      expect(JSON.stringify(result)).not.toContain(KEY);
    });

    it("answers no_active_team for a user with zero active teams", async () => {
      setPoolTestTeams([]);
      prime([poolOf("team-a")], [accountOf("team-a")]);
      expect(await ask({ session: null })).toMatchObject({ kind: "error", code: "no_active_team", status: 403 });
    });

    it("never gives the pool of a team that the user does not belong to", async () => {
      setPoolTestTeams(["team-a"]);
      prime([poolOf("team-x"), poolOf("team-a")], [accountOf("team-x"), exhaustedAccount("team-a")]);
      const result = await ask({ session: null });
      expect(result).toMatchObject({ kind: "error", code: "pool_exhausted" });
    });

    it("answers pool_unavailable when Core cannot list the pool accounts and no earlier list exists", async () => {
      __primeCacheForTests(SPACE, [defaultRow, poolOf("team-a")]);
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("core down"); }));
      expect(await ask({ session: null })).toMatchObject({ kind: "error", code: "pool_unavailable", status: 503 });
    });

    it("lets an error wait for the session stages whenever they can run", async () => {
      setPoolTestTeams([]);
      prime([poolOf("team-a")], [accountOf("team-a")]);
      expect(await ask({ session: null, sessionInitMayRun: true })).toMatchObject({ kind: "error", deferrable: false });
      expect(await ask({ sessionInitMayRun: true })).toMatchObject({ kind: "error", code: "no_active_team", deferrable: true });
      expect(await ask({ sessionInitMayRun: false })).toMatchObject({ kind: "error", code: "no_active_team", deferrable: false });
    });

    it("defers the error of a final session state so mem:session-reset and mem commands still run", async () => {
      setPoolTestTeams([]);
      prime([poolOf("team-a")], [accountOf("team-a")]);
      await seed({ status: "initialized", bypassed: true, sessionInfo: null });
      const first = await ask({ sessionInitMayRun: true });
      expect(first).toMatchObject({ kind: "error", code: "no_active_team", deferrable: true });
      expect(immediateTeamError(first)).toBeNull();
      // The error still stands right before the upstream is chosen.
      const settled = await settleRequestTeam({
        config, spaceId: SPACE, userId: POOL_TEST_USER, userKey: KEY, first,
        session: { keyId: "claude-code:s1", agentSource: "claude-code", sessionId: "s1" }, now: NOW,
      });
      expect(settled.error).toMatchObject({ code: "no_active_team" });
    });

    it("does not predict the user default team for a final session state", async () => {
      setPoolTestTeams(["team-b", "team-a"]);
      userDefault = { team_id: "team-b" };
      prime([poolOf("team-a")], [accountOf("team-a")]);
      await seed({ status: "initialized", bypassed: true, sessionInfo: null });
      expect(await ask({ sessionInitMayRun: true })).toEqual({ kind: "team", teamId: "team-a", source: "fallback" });
    });

    it("answers pool_unavailable, not pool_exhausted, when a below-quota account is on a refresh hold", async () => {
      setPoolTestTeams(["team-a"]);
      prime([poolOf("team-a")], [accountOf("team-a")]);
      markAccountUnavailable(SPACE, "acc-team-a", NOW + 60_000);
      expect(await ask({ session: null })).toMatchObject({ kind: "error", code: "pool_unavailable", status: 503 });
    });

    it("skips a team whose pool source does not allow the client or the model", async () => {
      setPoolTestTeams(["team-b", "team-a"]);
      config.modelSources = { enabled: true };
      const models = [{ id: "claude-sonnet", enabled: true }];
      prime([
        poolOf("team-b", { agents: [], source_name: "sub-claude", source_agents: [], source_models: models }),
        poolOf("team-a", { agents: [], source_name: "sub-claude", source_agents: ["hermes"], source_models: models }),
      ], [accountOf("team-b"), accountOf("team-a")]);
      const hermes = { agentSource: "hermes", model: "sub-claude/claude-sonnet", session: null };
      expect(await ask(hermes)).toEqual({ kind: "team", teamId: "team-a", source: "fallback" });
      expect(await ask({ ...hermes, model: "sub-claude/claude-other" })).toEqual({ kind: "team", teamId: "team-b", source: "fallback" });
    });

    it("treats x-memory-mode: off as a request without a registered team", async () => {
      setPoolTestTeams(["team-b", "team-a"]);
      prime([poolOf("team-a"), poolOf("team-b")], [exhaustedAccount("team-b"), accountOf("team-a")]);
      const result = await ask({ session: null, lcHeaders: { "x-memory-mode": "off" }, sessionInitMayRun: true });
      expect(result).toEqual({ kind: "team", teamId: "team-a", source: "fallback" });
    });
  });

  describe("team list cache", () => {
    it("answers team_list_unavailable 503 when Core is down and nothing is cached", async () => {
      clearTeamCaches();
      __setTeamListFetcherForTests(async () => { throw new Error("core down"); });
      prime([poolOf("team-a")], [accountOf("team-a")]);
      const result = await ask({ session: null });
      expect(result).toMatchObject({ kind: "error", code: "team_list_unavailable", status: 503 });
    });

    it("uses the last good list when Core is down, for ten minutes", async () => {
      clearTeamCaches();
      let down = false;
      __setTeamListFetcherForTests(async () => {
        if (down) throw new Error("core down");
        return [{ team_id: "team-a", status: "active" }];
      });
      expect(await listMemberTeamIds(config, SPACE, POOL_TEST_USER, KEY, NOW)).toEqual(["team-a"]);
      down = true;
      expect(await listMemberTeamIds(config, SPACE, POOL_TEST_USER, KEY, NOW + 2 * 60_000)).toEqual(["team-a"]);
      expect(await listMemberTeamIds(config, SPACE, POOL_TEST_USER, KEY, NOW + 11 * 60_000)).toBeNull();
    });

    it("reads again after 60 seconds, so a removed member falls to the fallback", async () => {
      clearTeamCaches();
      let teams = [{ team_id: "team-b", status: "active" }, { team_id: "team-a", status: "active" }];
      const fetcher = vi.fn(async () => teams);
      __setTeamListFetcherForTests(fetcher);
      expect(await listMemberTeamIds(config, SPACE, POOL_TEST_USER, KEY, NOW)).toEqual(["team-b", "team-a"]);
      teams = [{ team_id: "team-a", status: "active" }];
      expect(await listMemberTeamIds(config, SPACE, POOL_TEST_USER, KEY, NOW + 30_000)).toEqual(["team-b", "team-a"]);
      expect(await listMemberTeamIds(config, SPACE, POOL_TEST_USER, KEY, NOW + 61_000)).toEqual(["team-a"]);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("keeps active teams only and shares one call between concurrent requests", async () => {
      clearTeamCaches();
      const fetcher = vi.fn(async () => [
        { team_id: "team-a", status: "active" }, { team_id: "team-old", status: "archived" }, { team_id: "team-b" },
      ]);
      __setTeamListFetcherForTests(fetcher);
      const [first, second] = await Promise.all([
        listMemberTeamIds(config, SPACE, POOL_TEST_USER, KEY, NOW),
        listMemberTeamIds(config, SPACE, POOL_TEST_USER, KEY, NOW),
      ]);
      expect(first).toEqual(["team-a", "team-b"]);
      expect(second).toEqual(["team-a", "team-b"]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("keeps one cache entry per instance and user", async () => {
      clearTeamCaches();
      const fetcher = vi.fn(async (_c: unknown, space: string, user: string) => [{ team_id: `${space}-${user}`, status: "active" }]);
      __setTeamListFetcherForTests(fetcher);
      expect(await listMemberTeamIds(config, "s1", "u1", KEY, NOW)).toEqual(["s1-u1"]);
      expect(await listMemberTeamIds(config, "s1", "u2", KEY, NOW)).toEqual(["s1-u2"]);
      expect(await listMemberTeamIds(config, "s2", "u1", KEY, NOW)).toEqual(["s2-u1"]);
      expect(fetcher).toHaveBeenCalledTimes(3);
    });
  });

  describe("after session init", () => {
    it("lets the session team win over a fallback team while the user is a member of it", async () => {
      prime([poolOf("team-a"), poolOf("team-b")], [accountOf("team-a"), accountOf("team-b")]);
      const first = await ask({ session: null });
      expect(first).toMatchObject({ teamId: "team-b", source: "fallback" });
      const settled = await settleTeamAfterInit({ config, spaceId: SPACE, userId: POOL_TEST_USER, userKey: KEY, first, sessionTeamId: "team-a", now: NOW });
      expect(settled).toEqual({ teamId: "team-a", error: null, changed: true });
    });

    it("ignores a session team that the user left", async () => {
      prime([poolOf("team-a")], [accountOf("team-a")]);
      const first = await ask({ session: null });
      const settled = await settleTeamAfterInit({ config, spaceId: SPACE, userId: POOL_TEST_USER, userKey: KEY, first, sessionTeamId: "team-gone", now: NOW });
      expect(settled).toMatchObject({ teamId: "team-a", changed: false });
    });

    it("keeps a deferred error when init gives no team", async () => {
      setPoolTestTeams([]);
      prime([poolOf("team-a")], [accountOf("team-a")]);
      const first = await ask({ sessionInitMayRun: true });
      const settled = await settleTeamAfterInit({ config, spaceId: SPACE, userId: POOL_TEST_USER, userKey: KEY, first, sessionTeamId: null, now: NOW });
      expect(settled.error).toMatchObject({ code: "no_active_team" });
      expect(settled.teamId).toBeNull();
    });

    it("replaces a deferred error when init registered a team", async () => {
      setPoolTestTeams(["team-a"]);
      prime([poolOf("team-a")], [exhaustedAccount("team-a")]);
      const first = await ask({ sessionInitMayRun: true });
      expect(first).toMatchObject({ kind: "error", deferrable: true });
      const settled = await settleTeamAfterInit({ config, spaceId: SPACE, userId: POOL_TEST_USER, userKey: KEY, first, sessionTeamId: "team-a", now: NOW });
      expect(settled).toEqual({ teamId: "team-a", error: null, changed: true });
    });

    it("reads the session store again to find the registered team", async () => {
      prime([poolOf("team-a"), poolOf("team-b")], [accountOf("team-a"), accountOf("team-b")]);
      const session = { keyId: "claude-code:s1", agentSource: "claude-code", sessionId: "s1" };
      const first = await ask({ sessionInitMayRun: true });
      expect(first).toMatchObject({ teamId: "team-b", source: "fallback" });
      await seed(registered("team-a"));
      const settled = await settleRequestTeam({ config, spaceId: SPACE, userId: POOL_TEST_USER, userKey: KEY, first, session, now: NOW });
      expect(settled).toEqual({ teamId: "team-a", error: null, changed: true });
    });

    it("does nothing when the gate was closed", async () => {
      prime([], []);
      const settled = await settleRequestTeam({ config, spaceId: SPACE, userId: POOL_TEST_USER, userKey: KEY, first: null, session: null });
      expect(settled).toEqual({ teamId: null, error: null, changed: false });
    });
  });

  describe("error answers", () => {
    const ctx = (): import("hono").Context => ({
      json: (body: unknown, status: number, headers?: Record<string, string>) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }),
    }) as unknown as import("hono").Context;

    it("answers team_list_unavailable with Retry-After: 5 in the Anthropic and the OpenAI envelope", async () => {
      const err = { kind: "error", code: "team_list_unavailable", status: 503, message: "m", deferrable: false } as const;
      const anthropic = teamErrorResponse(ctx(), "anthropic", err);
      expect(anthropic.status).toBe(503);
      expect(anthropic.headers.get("retry-after")).toBe("5");
      expect(await anthropic.json()).toEqual({ type: "error", error: { type: "team_list_unavailable", message: "m" } });
      const openai = teamErrorResponse(ctx(), "openai", err);
      expect(await openai.json()).toEqual({ code: 503, error_code: "TEAM_LIST_UNAVAILABLE", message: "m" });
    });

    it("answers pool_exhausted with the pool's own 429 and reset time", async () => {
      const res = teamErrorResponse(ctx(), "anthropic", {
        kind: "error", code: "pool_exhausted", status: 429, message: "m", deferrable: false, resetAtMs: Date.now() + HOUR,
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("x-tdai-pool-status")).toBe("exhausted");
      expect(res.headers.get("x-tdai-pool-earliest-reset")).not.toBeNull();
    });

    it("answers a team without a pool with 403 and no key in the text", async () => {
      const res = teamErrorResponse(ctx(), "anthropic", {
        kind: "error", code: "no_team_pool", status: 403, message: "No team of this user has a subscription pool for claude-code.", deferrable: false,
      });
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("sk-");
    });
  });
});
