import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "./metadata-service.js";
import type { InstanceUpstreamConfigEntity, SourceModelEntry, SupportedAgent } from "../types.js";
import { SubscriptionProviderError } from "../../subscription-pool/providers/types.js";
import { fakeAdapter, tokens } from "../../subscription-pool/test-support.js";

const AGENTS: SupportedAgent[] = [
  { agent_source: "claude-code", protocol: "anthropic", display_name: "Claude Code" },
  { agent_source: "codex", protocol: "openai-responses", display_name: "Codex" },
  { agent_source: "cursor", protocol: "openai-chat", display_name: "Cursor" },
  { agent_source: "omp", protocol: "openai-chat", display_name: "oh-my-pi", multi_source: true },
];

const API_KEY = "sk-provider-secret-1234";

type Group = InstanceUpstreamConfigEntity & { group_id: string };

describe("model list fetch on a source", () => {
  let store: SqliteMetadataStore;
  let svc: MetadataService;
  let apiIds: string[];
  let apiCalls: string[];
  let apiStatus: number;

  beforeEach(() => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    svc = new MetadataService(store, "default");
    apiIds = ["m1", "m2"];
    apiCalls = [];
    apiStatus = 200;
    svc.setSubscriptionPoolHooks({
      sourceFetch: async (url) => {
        apiCalls.push(url);
        return apiStatus === 200
          ? new Response(JSON.stringify({ data: apiIds.map((id) => ({ id })) }), { status: 200 })
          : new Response(`bad request echo ${API_KEY}`, { status: apiStatus });
      },
    });
  });

  afterEach(() => store.close?.());

  async function apiSource(name = "api-test"): Promise<Group> {
    await store.ensureDefaultSeeded(AGENTS);
    return await svc.createInstanceUpstreamCustomGroup({
      name,
      agents: [],
      mode: "custom_unified",
      base_url: "https://api.example.test/v1",
      api_key: API_KEY,
      source_name: name,
      source_provider: "deepseek",
      source_agents: ["omp"],
    }, AGENTS) as unknown as Group;
  }

  /** A custom group that already serves an agent, set up as an operator would: the agent leaves the default group. */
  async function groupServing(agent: string, name: string, mode: "custom_unified" | "custom_passthrough"): Promise<Group> {
    await store.ensureDefaultSeeded(AGENTS);
    const def = (await store.listInstanceUpstreamGroups(undefined, AGENTS)).find((g) => g.group_type === "default")!;
    const result = await store.moveAgentBetweenUpstreamGroups({
      agent,
      from: [{ group_id: def.group_id }],
      to: { create: { name, mode, base_url: "https://api.example.test/v1", api_key: mode === "custom_unified" ? API_KEY : "" } },
    });
    return result.to as Group;
  }

  async function codexPool(): Promise<{ group_id: string }> {
    await svc.enableSubscriptionPool("codex", AGENTS);
    const pool = (await store.listInstanceUpstreamGroups()).find((g) => g.mode === "subscription_pool")!;
    await svc.updateInstanceUpstreamGroup({ group_id: pool.group_id, group_type: "custom", source_name: "sub-openai", source_agents: ["omp"] }, AGENTS);
    return { group_id: pool.group_id };
  }

  async function addAccount(groupId: string, n = 1, extra: Record<string, unknown> = {}) {
    const { account } = await store.upsertSubscriptionAccountByProviderId({
      group_id: groupId,
      provider: "codex",
      provider_account_id: `acct-${n}`,
      display_name: `Pro ${n}`,
      access_token: `access-${n}`,
      refresh_token: `refresh-${n}`,
      token_expires_at: Date.now() + 60 * 60 * 1000,
      ...extra,
    });
    return account;
  }

  const stored = async (groupId: string) => (await store.getInstanceUpstreamGroup(groupId))!;
  const ids = (models: SourceModelEntry[]) => models.map((m) => [m.id, m.enabled, m.available]);

  describe("API-key source", () => {
    it("lists the models off and calls <base_url>/models", async () => {
      const group = await apiSource();
      const result = await svc.refreshSourceModels({ group_id: group.group_id }) as unknown as Group;
      expect(apiCalls).toEqual(["https://api.example.test/v1/models"]);
      expect(ids(result.source_models)).toEqual([["m1", false, true], ["m2", false, true]]);
      expect(result.source_models_error).toBeNull();
      expect(result.source_models_fetched_at).not.toBeNull();
    });

    it("keeps the choice and starts models that appear later off", async () => {
      const group = await apiSource();
      await svc.refreshSourceModels({ group_id: group.group_id });
      await svc.updateSourceModels({ group_id: group.group_id, models: [{ id: "m1", enabled: true }] });
      apiIds = ["m1", "m3"];
      const result = await svc.refreshSourceModels({ group_id: group.group_id }) as unknown as Group;
      expect(ids(result.source_models)).toEqual([["m1", true, true], ["m3", false, true], ["m2", false, false]]);
    });

    it("changes none of the other fields of the group", async () => {
      const group = await apiSource();
      const before = await stored(group.group_id);
      await svc.refreshSourceModels({ group_id: group.group_id });
      const after = await stored(group.group_id);
      for (const key of ["agents", "enabled", "model_id", "api_key", "base_url", "mode", "name", "source_name", "source_agents", "source_enabled", "source_formats", "source_provider"] as const) {
        expect(after[key]).toEqual(before[key]);
      }
      expect(after.version).toBe(before.version + 1);
    });

    it("keeps the last good list on failure and stores a redacted reason", async () => {
      const group = await apiSource();
      const good = await svc.refreshSourceModels({ group_id: group.group_id }) as unknown as Group;
      apiStatus = 500;
      const failed = await svc.refreshSourceModels({ group_id: group.group_id }) as unknown as Group;
      expect(failed.source_models).toEqual(good.source_models);
      expect(failed.source_models_fetched_at).toBe(good.source_models_fetched_at);
      expect(failed.source_models_error).toBe("provider returned 500");
      expect(JSON.stringify(await stored(group.group_id))).not.toContain("echo");

      apiStatus = 200;
      expect((await svc.refreshSourceModels({ group_id: group.group_id }) as unknown as Group).source_models_error).toBeNull();
    });

    it("treats an empty list as a failure so the last list stays", async () => {
      const group = await apiSource();
      await svc.refreshSourceModels({ group_id: group.group_id });
      apiIds = [];
      const result = await svc.refreshSourceModels({ group_id: group.group_id }) as unknown as Group;
      expect(ids(result.source_models)).toEqual([["m1", false, true], ["m2", false, true]]);
      expect(result.source_models_error).toBe("provider returned an empty model list");
    });

    it("never stores the key in the error when the network call throws", async () => {
      const group = await apiSource();
      svc.setSubscriptionPoolHooks({ sourceFetch: async () => { throw new Error(`connect failed for ${API_KEY}`); } });
      const result = await svc.refreshSourceModels({ group_id: group.group_id }) as unknown as Group;
      expect(result.source_models_error).toBe("fetch failed (Error)");
      const row = await stored(group.group_id);
      expect(JSON.stringify([result, row.source_models_error, row.source_models])).not.toContain(API_KEY);
    });

    it("refuses a base URL that points at this server and records why", async () => {
      await store.ensureDefaultSeeded(AGENTS);
      const group = await svc.createInstanceUpstreamCustomGroup({
        name: "loop", agents: [], mode: "custom_unified", base_url: "http://memory-core:3000/v1", api_key: API_KEY,
        source_name: "api-loop", source_provider: "x", source_agents: ["omp"],
      }, AGENTS) as unknown as Group;
      const result = await svc.refreshSourceModels({ group_id: group.group_id }) as unknown as Group;
      expect(apiCalls).toEqual([]);
      expect(result.source_models_error).toBe("base_url points at an internal address");
    });

    it("keeps a model tick made while the fetch was running", async () => {
      const group = await apiSource();
      await svc.refreshSourceModels({ group_id: group.group_id });
      svc.setSubscriptionPoolHooks({
        sourceFetch: async () => {
          await svc.updateSourceModels({ group_id: group.group_id, models: [{ id: "m2", enabled: true }] });
          return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 });
        },
      });
      const result = await svc.refreshSourceModels({ group_id: group.group_id }) as unknown as Group;
      expect(ids(result.source_models)).toEqual([["m1", false, true], ["m2", true, true]]);
    });

    it("shares one fetch between two callers at the same time", async () => {
      const group = await apiSource();
      await Promise.all([svc.refreshSourceModels({ group_id: group.group_id }), svc.refreshSourceModels({ group_id: group.group_id })]);
      expect(apiCalls).toHaveLength(1);
    });
  });

  describe("subscription source", () => {
    it("starts every model on, also the ones that appear later, and passes the client version", async () => {
      const pool = await codexPool();
      await addAccount(pool.group_id);
      let listed = [{ id: "gpt-a", display_name: "A" }, { id: "gpt-b", display_name: "B" }];
      const adapter = fakeAdapter({ fetchModels: async () => listed });
      svc.setSubscriptionPoolHooks({ adapterFor: () => adapter, codexClientVersion: "0.170.0" });

      const first = await svc.refreshSourceModels({ group_id: pool.group_id }) as unknown as Group;
      expect(ids(first.source_models)).toEqual([["gpt-a", true, true], ["gpt-b", true, true]]);
      expect(adapter.fetchModels).toHaveBeenCalledWith("access-1", "acct-1", { codexClientVersion: "0.170.0" });

      await svc.updateSourceModels({ group_id: pool.group_id, models: [{ id: "gpt-b", enabled: false }] });
      listed = [...listed, { id: "gpt-c", display_name: "C" }];
      const second = await svc.refreshSourceModels({ group_id: pool.group_id }) as unknown as Group;
      expect(ids(second.source_models)).toEqual([["gpt-a", true, true], ["gpt-b", false, true], ["gpt-c", true, true]]);
    });

    it("leaves the pool switch and agents alone", async () => {
      const pool = await codexPool();
      await addAccount(pool.group_id);
      svc.setSubscriptionPoolHooks({ adapterFor: () => fakeAdapter({ fetchModels: async () => [{ id: "g", display_name: "g" }] }) });
      const before = await stored(pool.group_id);
      await svc.refreshSourceModels({ group_id: pool.group_id });
      const after = await stored(pool.group_id);
      expect([after.enabled, after.agents, after.mode]).toEqual([before.enabled, before.agents, before.mode]);
    });

    it("uses only enabled, active accounts and merges their lists", async () => {
      const pool = await codexPool();
      await addAccount(pool.group_id, 1);
      await addAccount(pool.group_id, 2);
      const disabled = await addAccount(pool.group_id, 3);
      await store.updateSubscriptionAccount(disabled.account_id, { enabled: false });
      const adapter = fakeAdapter({
        fetchModels: async (token) => {
          if (token === "access-3") throw new Error("a disabled account must not be called");
          return token === "access-1" ? [{ id: "a", display_name: "a" }] : [{ id: "b", display_name: "b" }];
        },
      });
      svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });
      const result = await svc.refreshSourceModels({ group_id: pool.group_id }) as unknown as Group;
      expect(result.source_models.map((m) => m.id).sort()).toEqual(["a", "b"]);
      expect(adapter.fetchModels).toHaveBeenCalledTimes(2);
    });

    it("refreshes the token once on a 401 and keeps working", async () => {
      const pool = await codexPool();
      await addAccount(pool.group_id);
      const adapter = fakeAdapter({
        fetchModels: async (token) => {
          if (token === "access-1") throw new SubscriptionProviderError("expired", true, 401);
          return [{ id: "g", display_name: "g" }];
        },
        refresh: async () => tokens({ accessToken: "access-renewed", refreshToken: "refresh-renewed" }),
      });
      svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });
      const result = await svc.refreshSourceModels({ group_id: pool.group_id }) as unknown as Group;
      expect(result.source_models.map((m) => m.id)).toEqual(["g"]);
      expect(adapter.refresh).toHaveBeenCalledTimes(1);
      expect(adapter.fetchModels.mock.calls.map((c) => c[0])).toEqual(["access-1", "access-renewed"]);
    });

    it("keeps the last list when every account fails and stores no token", async () => {
      const pool = await codexPool();
      await addAccount(pool.group_id, 1);
      await addAccount(pool.group_id, 2);
      let fail = false;
      const adapter = fakeAdapter({
        fetchModels: async (token) => {
          if (fail) throw new SubscriptionProviderError(`upstream said Bearer ${token}-xyz123456`, false, 503);
          return [{ id: "g", display_name: "g" }];
        },
      });
      svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });
      const good = await svc.refreshSourceModels({ group_id: pool.group_id }) as unknown as Group;
      fail = true;
      const failed = await svc.refreshSourceModels({ group_id: pool.group_id }) as unknown as Group;
      expect(failed.source_models).toEqual(good.source_models);
      expect(failed.source_models_fetched_at).toBe(good.source_models_fetched_at);
      expect(failed.source_models_error).toContain("upstream said Bearer [redacted]");
      expect(failed.source_models_error).not.toMatch(/access-\d/);
    });

    it("records an error for a pool with no usable account", async () => {
      const pool = await codexPool();
      const result = await svc.refreshSourceModels({ group_id: pool.group_id }) as unknown as Group;
      expect(result.source_models).toEqual([]);
      expect(result.source_models_error).toBe("no active account in the pool");
    });

    it("does not fetch while the pool is off", async () => {
      const pool = await codexPool();
      await addAccount(pool.group_id);
      const adapter = fakeAdapter({ fetchModels: async () => [{ id: "g", display_name: "g" }] });
      svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });
      await svc.updateInstanceUpstreamGroup({ group_id: pool.group_id, group_type: "custom", source_agents: [] }, AGENTS);
      const def = (await store.listInstanceUpstreamGroups(undefined, AGENTS)).find((g) => g.group_type === "default")!;
      await store.moveAgentBetweenUpstreamGroups({ agent: "codex", from: [{ group_id: pool.group_id }], to: { group_id: def.group_id } });
      await svc.disableSubscriptionPool("codex", AGENTS);
      await expect(svc.refreshSourceModels({ group_id: pool.group_id })).rejects.toMatchObject({ code: "SOURCE_DISABLED" });
      await svc.refreshAllSourceModels();
      expect(adapter.fetchModels).not.toHaveBeenCalled();
    });
  });

  describe("passthrough and groups that are not sources", () => {
    const passthrough = () => groupServing("cursor", "pass", "custom_passthrough");

    it("never fetches a passthrough group", async () => {
      const group = await passthrough();
      await expect(svc.refreshSourceModels({ group_id: group.group_id })).rejects.toMatchObject({ code: "SOURCE_MODE_NOT_ALLOWED" });
      await svc.refreshAllSourceModels();
      expect(apiCalls).toEqual([]);
    });

    it("skips a group with no source name", async () => {
      await groupServing("cursor", "plain", "custom_unified");
      await svc.refreshAllSourceModels();
      expect(apiCalls).toEqual([]);
    });
  });

  describe("periodic refresh of all sources", () => {
    it("fetches the enabled sources and skips the disabled one", async () => {
      const on = await apiSource("api-on");
      const off = await apiSource("api-off");
      await svc.updateInstanceUpstreamGroup({ group_id: on.group_id, group_type: "custom", source_enabled: true }, AGENTS);
      const pool = await codexPool();
      await addAccount(pool.group_id);
      svc.setSubscriptionPoolHooks({ adapterFor: () => fakeAdapter({ fetchModels: async () => [{ id: "g", display_name: "g" }] }) });

      expect(await svc.refreshAllSourceModels()).toEqual({ refreshed: 2, failed: 0 });
      expect((await stored(on.group_id)).source_models.map((m) => m.id)).toEqual(["m1", "m2"]);
      expect((await stored(off.group_id)).source_models).toEqual([]);
      expect((await stored(pool.group_id)).source_models.map((m) => m.id)).toEqual(["g"]);
    });

    it("counts a failing source and goes on with the next", async () => {
      const first = await apiSource("api-first");
      const second = await apiSource("api-second");
      for (const g of [first, second]) await svc.updateInstanceUpstreamGroup({ group_id: g.group_id, group_type: "custom", source_enabled: true }, AGENTS);
      apiStatus = 500;
      expect(await svc.refreshAllSourceModels()).toEqual({ refreshed: 0, failed: 2 });
      expect((await stored(second.group_id)).source_models_error).toBe("provider returned 500");
    });
  });

  describe("first attach", () => {
    it("tells the gateway once when a group becomes a source", async () => {
      const attached = vi.fn();
      svc.setSubscriptionPoolHooks({ onSourceAttached: attached });
      const group = await apiSource("api-attach");
      expect(attached).toHaveBeenCalledExactlyOnceWith(group.group_id);
      await svc.updateInstanceUpstreamGroup({ group_id: group.group_id, group_type: "custom", description: "changed", source_agents: ["omp"] }, AGENTS);
      expect(attached).toHaveBeenCalledTimes(1);
    });

    it("tells the gateway when an existing group gets its source name", async () => {
      const attached = vi.fn();
      svc.setSubscriptionPoolHooks({ onSourceAttached: attached });
      const plain = await groupServing("cursor", "later", "custom_unified");
      expect(attached).not.toHaveBeenCalled();
      await svc.updateInstanceUpstreamGroup({ group_id: plain.group_id, group_type: "custom", source_name: "api-later", source_agents: ["omp"] }, AGENTS);
      expect(attached).toHaveBeenCalledExactlyOnceWith(plain.group_id);
    });

    it("saves the group even when the hook throws", async () => {
      svc.setSubscriptionPoolHooks({ onSourceAttached: () => { throw new Error("boom"); } });
      await expect(apiSource("api-boom")).resolves.toMatchObject({ source_name: "api-boom" });
    });
  });
});
