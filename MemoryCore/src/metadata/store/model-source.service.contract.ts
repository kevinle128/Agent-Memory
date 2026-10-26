/**
 * Service-level rules for model sources on upstream groups. Backend independent: the sqlite and
 * mongodb test files each call it with their own store factory.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type * as http from "node:http";
import type { IMetadataStore } from "./interface.js";
import { MetadataService } from "../service/metadata-service.js";
import { handleV3MetaRoute } from "../router/v3-meta-router.js";
import type { SourceModelEntry, SupportedAgent } from "../types.js";

const AGENTS: SupportedAgent[] = [
  { agent_source: "claude-code", protocol: "anthropic", display_name: "Claude Code" },
  { agent_source: "codex", protocol: "openai-responses", display_name: "Codex" },
  { agent_source: "codebuddy", protocol: "openai-chat", display_name: "CodeBuddy" },
  { agent_source: "cursor", protocol: "openai-chat", display_name: "Cursor" },
  { agent_source: "omp", protocol: "openai-chat", display_name: "oh-my-pi", multi_source: true },
  { agent_source: "hermes", protocol: "anthropic", display_name: "Hermes", multi_source: true },
  { agent_source: "openclaw", protocol: "anthropic", display_name: "OpenClaw", multi_source: true },
];

const SOURCE_KEYS_AND_VALUES: [string, unknown][] = [
  ["source_name", "api-x"],
  ["source_provider", "deepseek"],
  ["source_formats", ["openai-chat"]],
  ["source_agents", ["omp"]],
  ["source_enabled", true],
  ["source_models", []],
];

function unified(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    agents: [] as string[],
    mode: "custom_unified" as const,
    base_url: "https://api.example.test",
    api_key: "sk-provider-secret-1234",
    ...extra,
  };
}

function model(id: string, enabled = false): SourceModelEntry {
  return { id, display_name: id, enabled, available: true, first_seen_at: "2026-10-26T00:00:00.000Z", last_seen_at: "2026-10-26T00:00:00.000Z" };
}

export function runModelSourceServiceContract(
  backend: string,
  makeStore: () => Promise<IMetadataStore>,
  closeStore: (store: IMetadataStore) => Promise<void>,
): void {
  describe(`model source rules: ${backend}`, () => {
    let store: IMetadataStore;
    let svc: MetadataService;

    beforeEach(async () => {
      store = await makeStore();
      await store.init?.();
      svc = new MetadataService(store, "default");
    });

    afterEach(async () => {
      await closeStore(store);
    });

    /** A custom group that already serves `agent`, set up as an operator would: the agent leaves the default group. */
    async function groupServing(agent: string, name: string, mode: "custom_unified" | "custom_passthrough" = "custom_unified"): Promise<{ group_id: string }> {
      await store.ensureDefaultSeeded(AGENTS);
      const def = (await store.listInstanceUpstreamGroups(undefined, AGENTS)).find((g) => g.group_type === "default")!;
      const result = await store.moveAgentBetweenUpstreamGroups({
        agent,
        from: [{ group_id: def.group_id }],
        to: { create: { name, mode, base_url: "https://api.example.test", api_key: "sk-provider-secret-1234" } },
      });
      return { group_id: result.to.group_id };
    }

    /** Makes the model list call of API-key sources answer with these ids, with no network. */
    function useModelList(ids: string[]): void {
      svc.setSubscriptionPoolHooks({
        sourceFetch: async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 }),
      });
    }

    const create = (input: ReturnType<typeof unified>) => svc.createInstanceUpstreamCustomGroup(input, AGENTS);
    const source = (name: string, extra: Record<string, unknown> = {}) =>
      create(unified(name, { source_name: name, source_agents: ["omp"], source_provider: "deepseek", ...extra }));

    describe("creating sources", () => {
      it("accepts a group with no agents when it is a named source", async () => {
        const group = await source("api-deepseek");
        expect(group).toMatchObject({
          agents: [],
          source_name: "api-deepseek",
          source_provider: "deepseek",
          source_formats: ["openai-chat"],
          source_agents: ["omp"],
          source_enabled: false,
        });
        expect(JSON.stringify(group)).not.toContain("sk-provider-secret-1234");
      });

      it("keeps rejecting a group with no agents and no source", async () => {
        await expect(create(unified("plain"))).rejects.toMatchObject({ code: "INVALID_AGENTS" });
        await expect(create(unified("plain", { source_agents: ["omp"] }))).rejects.toMatchObject({ code: "INVALID_SOURCE_NAME" });
        await expect(create(unified("plain", { source_name: "x", source_agents: [] }))).rejects.toMatchObject({ code: "INVALID_SOURCE_AGENTS" });
      });

      it("lets one group serve agents and be a source", async () => {
        const serving = await groupServing("codebuddy", "both");
        await svc.updateInstanceUpstreamGroup({ group_id: serving.group_id, group_type: "custom", model_id: "fixed-model" }, AGENTS);
        const group = await svc.updateInstanceUpstreamGroup({ group_id: serving.group_id, group_type: "custom", source_name: "api-both", source_agents: ["omp", "hermes"] }, AGENTS);
        expect(group).toMatchObject({ agents: ["codebuddy"], model_id: "fixed-model", source_agents: ["omp", "hermes"] });
      });

      it("allows the same multi-source agent in several sources", async () => {
        await source("api-one");
        await expect(source("api-two")).resolves.toMatchObject({ source_agents: ["omp"] });
      });

      it("requires source_agents when the name is first set", async () => {
        await expect(create(unified("a", { source_name: "api-a" }))).rejects.toMatchObject({ code: "INVALID_SOURCE_AGENTS" });
      });

      it.each(["claude-code", "codex", "codebuddy", "ghost"])("rejects %s in source_agents", async (agent) => {
        await expect(source("api-bad", { source_agents: [agent] })).rejects.toMatchObject({ code: "INVALID_SOURCE_AGENTS" });
      });

      it.each(["Upper", "has space", "a/b", "-lead", "trail-", "under_score", "x".repeat(41)])("rejects the source name %j", async (name) => {
        await expect(source("api-n", { source_name: name })).rejects.toMatchObject({ code: "INVALID_SOURCE_NAME" });
      });

      it("rejects a source name used by another group", async () => {
        await source("api-dup", { source_name: "shared" });
        await expect(source("api-dup-2", { source_name: "shared" })).rejects.toMatchObject({ code: "SOURCE_NAME_TAKEN" });
      });

      it("rejects model_id on a group that only serves as a source", async () => {
        await expect(source("api-m", { model_id: "gpt-x" })).rejects.toMatchObject({ code: "MODEL_ID_UNUSED" });
      });

      it("checks source_formats", async () => {
        await expect(source("api-f1", { source_formats: [] })).rejects.toMatchObject({ code: "INVALID_SOURCE_FORMATS" });
        await expect(source("api-f2", { source_formats: ["openai-chat", "grpc"] })).rejects.toMatchObject({ code: "INVALID_SOURCE_FORMATS" });
        await expect(source("api-f3", { source_formats: ["anthropic-messages", "openai-responses"] }))
          .resolves.toMatchObject({ source_formats: ["anthropic-messages", "openai-responses"] });
      });
    });

    describe("passthrough, default and extraction", () => {
      it.each(SOURCE_KEYS_AND_VALUES)("rejects %s on a custom_passthrough group", async (key, value) => {
        await expect(create({ ...unified("pass", { agents: ["cursor"], [key]: value }), mode: "custom_passthrough" } as never))
          .rejects.toMatchObject({ code: "SOURCE_MODE_NOT_ALLOWED" });
      });

      it("creates and updates a passthrough group without source fields as before", async () => {
        const created = await groupServing("cursor", "pass", "custom_passthrough");
        const updated = await svc.updateInstanceUpstreamGroup({ group_id: created.group_id, group_type: "custom", description: "note" }, AGENTS);
        expect(updated).toMatchObject({ description: "note", source_name: "" });
      });

      it("rejects turning a source into a passthrough group", async () => {
        const group = await source("api-pt") as { group_id: string };
        await expect(svc.updateInstanceUpstreamGroup({ group_id: group.group_id, group_type: "custom", mode: "custom_passthrough" }, AGENTS))
          .rejects.toMatchObject({ code: "SOURCE_MODE_NOT_ALLOWED" });
      });

      it("rejects a source field on the default group", async () => {
        await store.ensureDefaultSeeded(AGENTS);
        const def = (await store.listInstanceUpstreamGroups(undefined, AGENTS)).find((g) => g.group_type === "default")!;
        await expect(svc.updateInstanceUpstreamGroup({ group_id: def.group_id, group_type: "default", source_name: "nope", source_agents: ["omp"] }, AGENTS))
          .rejects.toMatchObject({ code: "SOURCE_MODE_NOT_ALLOWED" });
      });
    });

    describe("updating sources", () => {
      it("fixes the name after the first save", async () => {
        const group = await source("api-fix") as { group_id: string };
        await expect(svc.updateInstanceUpstreamGroup({ group_id: group.group_id, group_type: "custom", source_name: "other" }, AGENTS))
          .rejects.toMatchObject({ code: "SOURCE_NAME_IMMUTABLE" });
        await expect(svc.updateInstanceUpstreamGroup({ group_id: group.group_id, group_type: "custom", source_name: "api-fix", source_enabled: true }, AGENTS))
          .resolves.toMatchObject({ source_name: "api-fix", source_enabled: true });
      });

      it("turns an ordinary group into a source on update, once", async () => {
        const group = await groupServing("codebuddy", "late");
        await svc.updateInstanceUpstreamGroup({ group_id: group.group_id, group_type: "custom", model_id: "m" }, AGENTS);
        await expect(svc.updateInstanceUpstreamGroup({ group_id: group.group_id, group_type: "custom", source_name: "api-late" }, AGENTS))
          .rejects.toMatchObject({ code: "INVALID_SOURCE_AGENTS" });
        await expect(svc.updateInstanceUpstreamGroup({ group_id: group.group_id, group_type: "custom", source_name: "api-late", source_agents: ["hermes"] }, AGENTS))
          .resolves.toMatchObject({ source_name: "api-late", source_agents: ["hermes"], agents: ["codebuddy"], model_id: "m" });
      });

      it("keeps a source-only group valid and refuses to empty both lists", async () => {
        const group = await source("api-both-empty") as { group_id: string };
        await expect(svc.updateInstanceUpstreamGroup({ group_id: group.group_id, group_type: "custom", source_agents: [] }, AGENTS))
          .rejects.toMatchObject({ code: "INVALID_AGENTS" });
        await expect(svc.updateInstanceUpstreamGroup({ group_id: group.group_id, group_type: "custom", agents: [] }, AGENTS))
          .resolves.toMatchObject({ agents: [] });
      });

      it("rejects model_id once a group is source-only", async () => {
        const group = await source("api-mid") as { group_id: string };
        await expect(svc.updateInstanceUpstreamGroup({ group_id: group.group_id, group_type: "custom", model_id: "m" }, AGENTS))
          .rejects.toMatchObject({ code: "MODEL_ID_UNUSED" });
      });

      it("does not touch source fields when none are sent", async () => {
        const group = await source("api-keep", { source_enabled: true }) as { group_id: string };
        const updated = await svc.updateInstanceUpstreamGroup({ group_id: group.group_id, group_type: "custom", description: "d" }, AGENTS);
        expect(updated).toMatchObject({ source_name: "api-keep", source_agents: ["omp"], source_enabled: true, description: "d" });
      });
    });

    describe("suggested names", () => {
      it("proposes names and avoids taken ones", async () => {
        await expect(svc.suggestSourceName({ kind: "subscription", provider: "claude" })).resolves.toEqual({ source_name: "sub-claude" });
        await expect(svc.suggestSourceName({ kind: "subscription", provider: "openai" })).resolves.toEqual({ source_name: "sub-openai" });
        await expect(svc.suggestSourceName({ kind: "api", provider: "DeepSeek" })).resolves.toEqual({ source_name: "api-deepseek" });
        await source("api-deepseek");
        await source("api-deepseek-2");
        await expect(svc.suggestSourceName({ kind: "api", provider: "deepseek" })).resolves.toEqual({ source_name: "api-deepseek-3" });
      });

      it("rejects an unknown subscription provider", async () => {
        await expect(svc.suggestSourceName({ kind: "subscription", provider: "gemini" })).rejects.toMatchObject({ code: "INVALID_SOURCE_PROVIDER" });
      });
    });

    describe("source models", () => {
      it("ticks models on and off and rejects unknown ids", async () => {
        const group = await source("api-models", { source_models: [model("deepseek/v4"), model("plain")] }) as { group_id: string };
        const ticked = await svc.updateSourceModels({ group_id: group.group_id, models: [{ id: "deepseek/v4", enabled: true }] }) as { source_models: SourceModelEntry[] };
        expect(ticked.source_models.map((m) => [m.id, m.enabled])).toEqual([["deepseek/v4", true], ["plain", false]]);
        await expect(svc.updateSourceModels({ group_id: group.group_id, models: [{ id: "missing", enabled: true }] }))
          .rejects.toMatchObject({ code: "SOURCE_MODEL_NOT_FOUND" });
      });

      it("refuses a group that is not a source", async () => {
        const plain = await groupServing("codebuddy", "plain");
        await expect(svc.updateSourceModels({ group_id: plain.group_id, models: [{ id: "a", enabled: true }] }))
          .rejects.toMatchObject({ code: "SOURCE_NOT_CONFIGURED" });
        await expect(svc.updateSourceModels({ group_id: "grp-none", models: [{ id: "a", enabled: true }] }))
          .rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
      });

      it("reads the model list on refresh, and refuses passthrough", async () => {
        const group = await source("api-refresh") as { group_id: string };
        useModelList(["deepseek/v4", "plain"]);
        const refreshed = await svc.refreshSourceModels({ group_id: group.group_id }) as { source_models: SourceModelEntry[]; source_models_error: string | null };
        expect(refreshed.source_models.map((m) => [m.id, m.enabled, m.available])).toEqual([["deepseek/v4", false, true], ["plain", false, true]]);
        expect(refreshed.source_models_error).toBeNull();
        expect(JSON.stringify(refreshed)).not.toContain("sk-provider-secret-1234");
        const pass = await groupServing("cursor", "pass", "custom_passthrough");
        await expect(svc.refreshSourceModels({ group_id: pass.group_id })).rejects.toMatchObject({ code: "SOURCE_MODE_NOT_ALLOWED" });
      });
    });

    describe("subscription pool sources", () => {
      async function codexPool(): Promise<{ group_id: string }> {
        return await svc.enableSubscriptionPool("codex", AGENTS) as { group_id: string };
      }
      const attach = (group_id: string, extra: Record<string, unknown> = {}) =>
        svc.updateInstanceUpstreamGroup({ group_id, group_type: "custom", source_name: "sub-openai", source_agents: ["omp"], ...extra }, AGENTS);

      it("fixes provider and format by the pool provider", async () => {
        const pool = await codexPool();
        const attached = await attach(pool.group_id, { source_provider: "whatever", source_formats: ["openai-chat"] });
        expect(attached).toMatchObject({ source_name: "sub-openai", source_provider: "openai", source_formats: ["openai-responses"], agents: ["codex"] });
      });

      it("rejects source_enabled on a pool", async () => {
        const pool = await codexPool();
        await expect(attach(pool.group_id, { source_enabled: true })).rejects.toMatchObject({ code: "SOURCE_ENABLED_NOT_ALLOWED" });
        await expect(attach(pool.group_id, { source_enabled: false })).rejects.toMatchObject({ code: "SOURCE_ENABLED_NOT_ALLOWED" });
      });

      it("keeps the source through a pool off/on cycle and reports source_active", async () => {
        const pool = await codexPool();
        await attach(pool.group_id);
        const status = async () => {
          const result = await svc.getSubscriptionPoolStatus("codex") as { providers: { source: Record<string, unknown> | null }[] };
          return result.providers[0].source;
        };
        expect(await status()).toMatchObject({ source_name: "sub-openai", source_active: true });
        await svc.disableSubscriptionPool("codex", AGENTS);
        expect(await status()).toMatchObject({ source_name: "sub-openai", source_agents: ["omp"], source_active: false });
        await svc.enableSubscriptionPool("codex", AGENTS);
        expect(await status()).toMatchObject({ source_name: "sub-openai", source_agents: ["omp"], source_formats: ["openai-responses"], source_active: true });
      });

      it("lets a disabled pool keep its source agents and still change them", async () => {
        const pool = await codexPool();
        await attach(pool.group_id);
        await svc.disableSubscriptionPool("codex", AGENTS);
        await expect(svc.updateInstanceUpstreamGroup({ group_id: pool.group_id, group_type: "custom", source_agents: ["omp", "hermes"] }, AGENTS))
          .resolves.toMatchObject({ source_agents: ["omp", "hermes"], agents: [] });
      });

      it("has no source block before the pool group exists", async () => {
        const result = await svc.getSubscriptionPoolStatus("claude") as { providers: { source: unknown }[] };
        expect(result.providers[0].source).toBeNull();
      });

      it("sends the proxy the same account list with and without a source, pool on and off", async () => {
        const pool = await codexPool();
        await store.upsertSubscriptionAccountByProviderId({
          group_id: pool.group_id, provider: "codex", provider_account_id: "acct-1", display_name: "Plus",
          access_token: "access-secret", refresh_token: "refresh-secret", token_expires_at: 4_000_000_000_000,
        });
        const accounts = async () => JSON.stringify(await svc.listSubscriptionAccountsInternal());

        const onWithout = await accounts();
        await attach(pool.group_id);
        expect(await accounts()).toBe(onWithout);

        await svc.disableSubscriptionPool("codex", AGENTS);
        const offWith = await accounts();
        expect(JSON.parse(offWith).accounts).toEqual([]);
        await svc.updateInstanceUpstreamGroup({ group_id: pool.group_id, group_type: "custom", source_agents: ["hermes"] }, AGENTS);
        expect(await accounts()).toBe(offWith);

        await svc.enableSubscriptionPool("codex", AGENTS);
        expect(await accounts()).toBe(onWithout);
      });
    });

    describe("internal list", () => {
      it("carries the source columns with defaults for groups that are not sources", async () => {
        await groupServing("codebuddy", "plain");
        await source("api-int");
        const { items } = await svc.listInstanceUpstreamGroupsInternal(AGENTS);
        const plain = items.find((g) => g.name === "plain")!;
        expect(plain).toMatchObject({ source_name: "", source_provider: "", source_formats: [], source_agents: [], source_enabled: false, source_models: [] });
        expect(items.find((g) => g.name === "api-int")).toMatchObject({ source_name: "api-int", source_agents: ["omp"] });
      });
    });

    describe("routes", () => {
      async function post(userKey: string, action: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> & { code: number; message: string } }> {
        let status = 0;
        let parsed = { code: 0, message: "" } as Record<string, unknown> & { code: number; message: string };
        const handled = await handleV3MetaRoute(
          { headers: { "x-tdai-service-id": "default", "x-tdai-user-key": userKey } } as http.IncomingMessage,
          {} as http.ServerResponse,
          `/v3/meta/instance-upstream/${action}`,
          "POST",
          async () => body,
          (_res, code, payload) => {
            status = code;
            parsed = payload as typeof parsed;
          },
          { getMetadataService: () => svc, logger: {}, getSupportedAgents: () => AGENTS },
        );
        expect(handled).toBe(true);
        return { status, body: parsed };
      }

      beforeEach(async () => {
        await store.createUser({ username: "member", auth_provider: "local", external_id: "member", default_key_value: "member-key", user_type: "normal" });
        await store.createUser({ username: "admin", auth_provider: "local", external_id: "admin", default_key_value: "admin-key", user_type: "system_admin" });
      });

      it("shows custom groups without any key field to a member, and leaves out pools", async () => {
        await source("api-view", { source_models: [model("m1")] });
        await svc.enableSubscriptionPool("codex", AGENTS);
        const res = await post("member-key", "groups/view", {});
        expect(res.status).toBe(200);
        const text = JSON.stringify(res.body);
        expect(text).not.toMatch(/sk-provider|api_key_masked|"api_key"/);
        const items = (res.body.data as { items: Record<string, unknown>[] }).items;
        expect(items.map((g) => g.name)).toEqual(["api-view"]);
        expect(items[0]).toMatchObject({ api_key_configured: true, source_name: "api-view", base_url: "https://api.example.test" });
        expect((await post("", "groups/view", {})).status).toBe(401);
      });

      it("gives an admin only api_key_configured on create, update and list, never a part of the key", async () => {
        const created = await post("admin-key", "groups/create", {
          group_type: "custom", name: "admin-write", agents: [], source_name: "api-write", source_agents: ["omp"], mode: "custom_unified",
          base_url: "https://api.example.test", api_key: "sk-provider-secret-value",
        });
        expect(created.status).toBe(200);
        const group = created.body.data as Record<string, unknown>;
        expect(group.api_key_configured).toBe(true);
        const updated = await post("admin-key", "groups/update", {
          group_id: group.group_id, group_type: "custom", description: "changed",
        });
        expect(updated.status).toBe(200);
        const listed = await post("admin-key", "groups/list", {});
        expect(listed.status).toBe(200);
        for (const res of [created, updated, listed]) {
          expect(JSON.stringify(res.body)).not.toMatch(/sk-provider|api_key_masked|"api_key"/);
        }
      });

      it.each([
        ["groups/create", { group_type: "custom", ...unified("x"), source_name: "api-x", source_agents: ["omp"] }],
        ["groups/update", { group_id: "g", group_type: "custom", description: "d" }],
        ["groups/suggest-source-name", { kind: "api", provider: "x" }],
        ["groups/source-models/update", { group_id: "g", models: [{ id: "a", enabled: true }] }],
        ["groups/source-refresh", { group_id: "g" }],
      ])("denies a member on %s", async (action, body) => {
        const res = await post("member-key", action, body);
        expect(res.status).toBe(403);
        expect(res.body.message).toContain("permission_denied");
      });

      it("lets an admin create a source and maps the new error codes", async () => {
        const created = await post("admin-key", "groups/create", { group_type: "custom", ...unified("api-route"), source_name: "api-route", source_agents: ["omp"] });
        expect(created.status).toBe(200);
        const group = created.body.data as { group_id: string };

        expect((await post("admin-key", "groups/create", { group_type: "custom", ...unified("api-route-2"), source_name: "api-route", source_agents: ["omp"] })).status).toBe(409);
        expect((await post("admin-key", "groups/update", { group_id: group.group_id, group_type: "custom", source_name: "renamed" })).status).toBe(400);
        useModelList(["m1"]);
        const refreshed = await post("admin-key", "groups/source-refresh", { group_id: group.group_id });
        expect(refreshed.status).toBe(200);
        expect((refreshed.body.data as { source_models: SourceModelEntry[] }).source_models.map((m) => m.id)).toEqual(["m1"]);
        const suggested = await post("admin-key", "groups/suggest-source-name", { kind: "api", provider: "route" });
        expect(suggested.body.data).toEqual({ source_name: "api-route-2" });
      });
    });
  });
}
