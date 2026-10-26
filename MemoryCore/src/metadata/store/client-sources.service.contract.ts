/**
 * Service and route rules for the sources each client uses. Backend independent: the sqlite and
 * mongodb test files each call it with their own store factory.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type * as http from "node:http";
import type { IMetadataStore } from "./interface.js";
import { MetadataService } from "../service/metadata-service.js";
import { handleV3MetaRoute } from "../router/v3-meta-router.js";
import type { SupportedAgent } from "../types.js";

const AGENTS: SupportedAgent[] = [
  { agent_source: "claude-code", protocol: "anthropic", display_name: "Claude Code" },
  { agent_source: "codex", protocol: "openai-responses", display_name: "Codex" },
  { agent_source: "codebuddy", protocol: "openai-chat", display_name: "CodeBuddy", multi_source: true },
  { agent_source: "omp", protocol: "openai-chat", display_name: "oh-my-pi", multi_source: true },
];

const API_KEY = "sk-provider-secret-1234";

export function runClientSourcesServiceContract(
  backend: string,
  makeStore: () => Promise<IMetadataStore>,
  closeStore: (store: IMetadataStore) => Promise<void>,
): void {
  describe(`client sources: ${backend}`, () => {
    let store: IMetadataStore;
    let svc: MetadataService;

    beforeEach(async () => {
      store = await makeStore();
      await store.init?.();
      svc = new MetadataService(store, "default");
      await store.ensureDefaultSeeded(AGENTS);
    });

    afterEach(async () => {
      await closeStore(store);
    });

    /** An API-key source with no client yet. `formats` defaults to openai-chat. */
    function apiSource(name: string, extra: Record<string, unknown> = {}) {
      return svc.createInstanceUpstreamCustomGroup(
        {
          name,
          agents: [],
          mode: "custom_unified",
          base_url: "https://api.example.test",
          api_key: API_KEY,
          source_name: name,
          source_provider: "deepseek",
          source_enabled: true,
          ...extra,
        } as Parameters<MetadataService["createInstanceUpstreamCustomGroup"]>[0],
        AGENTS,
      );
    }

    const update = (agent: string, sources: string[]) => svc.updateClientSources({ agent, sources }, AGENTS);
    const entry = async (agent: string) => (await svc.listClientSources(AGENTS)).agents.find((a) => a.agent === agent)!;
    const groupOf = async (agent: string) =>
      (await store.listInstanceUpstreamGroups(undefined, AGENTS)).find((g) => g.agents.includes(agent))!;

    describe("list", () => {
      it("returns every agent with its mode, format and selected sources, and every source", async () => {
        await apiSource("api-chat", { source_models: [model("a", true), model("b")] });
        await apiSource("api-off", { source_enabled: false });
        await svc.enableSubscriptionPool("claude", AGENTS);
        await update("omp", ["api-chat"]);
        const res = await svc.listClientSources(AGENTS);
        expect(res.agents).toEqual([
          { agent: "claude-code", display_name: "Claude Code", mode: "single", format: "anthropic-messages", selected: ["sub-claude"] },
          { agent: "codex", display_name: "Codex", mode: "single", format: "openai-responses", selected: [] },
          { agent: "codebuddy", display_name: "CodeBuddy", mode: "multi", selected: [] },
          { agent: "omp", display_name: "oh-my-pi", mode: "multi", selected: ["api-chat"] },
        ]);
        expect(res.sources).toEqual([
          { source_name: "api-chat", source_type: "api", provider: "deepseek", formats: ["openai-chat"], enabled: true, models_on: 1, models_total: 2 },
          { source_name: "api-off", source_type: "api", provider: "deepseek", formats: ["openai-chat"], enabled: false, models_on: 0, models_total: 0 },
          expect.objectContaining({ source_name: "sub-claude", source_type: "subscription", provider: "claude", formats: ["anthropic-messages"], enabled: true }),
        ]);
        expect(JSON.stringify(res)).not.toContain(API_KEY);
      });

      it("leaves a single agent empty while it uses the official group", async () => {
        await apiSource("api-chat");
        expect((await entry("codex")).selected).toEqual([]);
      });
    });

    describe("update for a multi-source client", () => {
      it("adds and removes the client so the membership equals the request", async () => {
        await apiSource("api-one");
        await apiSource("api-two");
        await expect(update("omp", ["api-one", "api-two"])).resolves.toMatchObject({ selected: ["api-one", "api-two"] });
        await expect(update("omp", ["api-two"])).resolves.toMatchObject({ selected: ["api-two"] });
        await expect(update("omp", [])).resolves.toMatchObject({ selected: [] });
        expect((await entry("codebuddy")).selected).toEqual([]);
      });

      it("rejects an unknown source and a source that is off, and changes nothing", async () => {
        await apiSource("api-on");
        await apiSource("api-off", { source_enabled: false });
        await expect(update("omp", ["api-on", "ghost"])).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
        await expect(update("omp", ["api-on", "api-off"])).rejects.toMatchObject({ code: "SOURCE_DISABLED" });
        expect((await entry("omp")).selected).toEqual([]);
      });

      it("rejects an unknown agent", async () => {
        await expect(update("ghost", [])).rejects.toMatchObject({ code: "INVALID_AGENTS" });
      });
    });

    describe("update for a single-source client", () => {
      it("moves claude-code from the pool to an Anthropic source and back", async () => {
        await apiSource("api-anthropic", { source_formats: ["anthropic-messages"] });
        await svc.enableSubscriptionPool("claude", AGENTS);
        expect((await groupOf("claude-code")).mode).toBe("subscription_pool");

        await expect(update("claude-code", ["api-anthropic"])).resolves.toMatchObject({ selected: ["api-anthropic"] });
        expect((await groupOf("claude-code")).source_name).toBe("api-anthropic");
        const pool = (await store.listInstanceUpstreamGroups(undefined, AGENTS)).find((g) => g.mode === "subscription_pool")!;
        expect(pool.agents).toEqual([]);

        await expect(update("claude-code", ["sub-claude"])).resolves.toMatchObject({ selected: ["sub-claude"] });
        expect((await groupOf("claude-code")).mode).toBe("subscription_pool");
      });

      it("moves codex from the official group to a Responses source", async () => {
        await apiSource("api-resp", { source_formats: ["openai-responses"] });
        await expect(update("codex", ["api-resp"])).resolves.toMatchObject({ selected: ["api-resp"] });
        const def = (await store.listInstanceUpstreamGroups(undefined, AGENTS)).find((g) => g.group_type === "default")!;
        expect(def.agents).not.toContain("codex");
        await expect(update("codex", ["api-resp"])).resolves.toMatchObject({ selected: ["api-resp"] });
      });

      it("rejects a wrong format, a source that is off, an unknown source and a wrong count", async () => {
        await apiSource("api-chat");
        await apiSource("api-resp", { source_formats: ["openai-responses"], source_enabled: false });
        await expect(update("claude-code", ["api-chat"])).rejects.toMatchObject({ code: "SOURCE_FORMAT_MISMATCH" });
        await expect(update("codex", ["api-resp"])).rejects.toMatchObject({ code: "SOURCE_DISABLED" });
        await expect(update("codex", ["ghost"])).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
        await expect(update("codex", [])).rejects.toMatchObject({ code: "INVALID_SOURCES" });
        await apiSource("api-chat-2");
        await expect(update("codex", ["api-chat", "api-chat-2"])).rejects.toMatchObject({ code: "INVALID_SOURCES" });
        expect((await groupOf("codex")).group_type).toBe("default");
      });
    });

    describe("in-use guard", () => {
      const inUse = (code = "SOURCE_IN_USE") => expect.objectContaining({ code });

      it("keeps a source that a multi-source client uses on and undeleted", async () => {
        const group = await apiSource("api-used");
        await update("omp", ["api-used"]);
        const toggle = svc.toggleInstanceUpstreamGroup({ group_id: group.group_id as string, enabled: false }, AGENTS);
        await expect(toggle).rejects.toMatchObject({ code: "SOURCE_IN_USE", detail: { clients: ["omp"] } });
        await expect(svc.updateInstanceUpstreamGroup({ group_id: group.group_id as string, group_type: "custom", source_enabled: false }, AGENTS))
          .rejects.toEqual(inUse());
        await expect(svc.updateInstanceUpstreamGroup({ group_id: group.group_id as string, group_type: "custom", enabled: false }, AGENTS))
          .rejects.toEqual(inUse());
        await expect(svc.deleteInstanceUpstreamGroup({ group_id: group.group_id as string }, AGENTS)).rejects.toEqual(inUse());
      });

      it("keeps a source that claude-code or codex uses", async () => {
        const group = await apiSource("api-resp", { source_formats: ["openai-responses"] });
        await update("codex", ["api-resp"]);
        await expect(svc.toggleInstanceUpstreamGroup({ group_id: group.group_id as string, enabled: false }, AGENTS))
          .rejects.toMatchObject({ code: "SOURCE_IN_USE", detail: { clients: ["codex"] } });
        await expect(svc.deleteInstanceUpstreamGroup({ group_id: group.group_id as string }, AGENTS)).rejects.toEqual(inUse());
      });

      it("allows turning off and deleting once no client uses the source", async () => {
        const group = await apiSource("api-free");
        await update("omp", ["api-free"]);
        await update("omp", []);
        await expect(svc.updateInstanceUpstreamGroup({ group_id: group.group_id as string, group_type: "custom", source_enabled: false }, AGENTS))
          .resolves.toMatchObject({ source_enabled: false });
        await expect(svc.toggleInstanceUpstreamGroup({ group_id: group.group_id as string, enabled: false }, AGENTS)).resolves.toMatchObject({ enabled: false });
        await expect(svc.deleteInstanceUpstreamGroup({ group_id: group.group_id as string }, AGENTS)).resolves.toMatchObject({ deleted: true });
      });

      it("keeps turning a source on allowed", async () => {
        const group = await apiSource("api-late", { source_enabled: false });
        await expect(svc.updateInstanceUpstreamGroup({ group_id: group.group_id as string, group_type: "custom", source_enabled: true }, AGENTS))
          .resolves.toMatchObject({ source_enabled: true });
      });

      it("refuses to disable a pool that claude-code or a multi-source client uses", async () => {
        await svc.enableSubscriptionPool("claude", AGENTS);
        await expect(svc.disableSubscriptionPool("claude", AGENTS)).rejects.toMatchObject({ code: "SOURCE_IN_USE", detail: { clients: ["claude-code"] } });
        const pool = (await store.listInstanceUpstreamGroups(undefined, AGENTS)).find((g) => g.mode === "subscription_pool")!;
        await expect(svc.toggleInstanceUpstreamGroup({ group_id: pool.group_id, enabled: false }, AGENTS)).rejects.toMatchObject({ code: "SOURCE_IN_USE" });
        await expect(svc.deleteInstanceUpstreamGroup({ group_id: pool.group_id }, AGENTS)).rejects.toMatchObject({ code: "SOURCE_IN_USE" });
      });

      it("disables a pool nobody uses", async () => {
        await svc.enableSubscriptionPool("codex", AGENTS);
        await apiSource("api-resp", { source_formats: ["openai-responses"] });
        await update("codex", ["api-resp"]);
        await update("omp", ["sub-openai"]);
        await expect(svc.disableSubscriptionPool("codex", AGENTS)).rejects.toMatchObject({ code: "SOURCE_IN_USE", detail: { clients: ["omp"] } });
        await update("omp", []);
        await expect(svc.disableSubscriptionPool("codex", AGENTS)).resolves.toMatchObject({ disabled: true });
        const pool = (await store.listInstanceUpstreamGroups(undefined, AGENTS)).find((g) => g.mode === "subscription_pool")!;
        expect(pool.enabled).toBe(false);
        await expect(update("codex", ["sub-openai"])).rejects.toMatchObject({ code: "SOURCE_DISABLED" });
        await expect(svc.disableSubscriptionPool("codex", AGENTS)).rejects.toMatchObject({ code: "POOL_NOT_ENABLED" });
      });
    });

    describe("creating sources", () => {
      it("needs no source_agents, and still refuses an agent that is not multi-source", async () => {
        await expect(apiSource("api-none")).resolves.toMatchObject({ source_name: "api-none", source_agents: [], agents: [] });
        await expect(apiSource("api-empty", { source_agents: [] })).resolves.toMatchObject({ source_agents: [] });
        await expect(apiSource("api-bad", { source_agents: ["claude-code"] })).rejects.toMatchObject({ code: "INVALID_SOURCE_AGENTS" });
      });

      it("gives the pool groups their fixed source names", async () => {
        await expect(svc.enableSubscriptionPool("claude", AGENTS)).resolves.toMatchObject({
          source_name: "sub-claude", source_provider: "claude", source_formats: ["anthropic-messages"],
        });
        await expect(svc.enableSubscriptionPool("codex", AGENTS)).resolves.toMatchObject({
          source_name: "sub-openai", source_provider: "openai", source_formats: ["openai-responses"],
        });
        await svc.enableSubscriptionPool("claude", AGENTS);
        const names = (await store.listInstanceUpstreamGroups(undefined, AGENTS)).map((g) => g.source_name).filter(Boolean).sort();
        expect(names).toEqual(["sub-claude", "sub-openai"]);
      });

      it("does not take over a source name another group holds", async () => {
        await apiSource("sub-claude");
        await expect(svc.enableSubscriptionPool("claude", AGENTS)).rejects.toMatchObject({ code: "SOURCE_NAME_TAKEN" });
        expect((await groupOf("claude-code")).group_type).toBe("default");
      });
    });

    describe("routes", () => {
      async function post(userKey: string, action: string, body: unknown): Promise<{ status: number; body: Record<string, any> }> {
        let status = 0;
        let parsed: Record<string, any> = {};
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

      it("lets a member read the list without any key, but not change it", async () => {
        await apiSource("api-route");
        const list = await post("member-key", "client-sources/list", {});
        expect(list.status).toBe(200);
        expect(list.body.data.agents).toHaveLength(AGENTS.length);
        expect(list.body.data.sources).toHaveLength(1);
        expect(JSON.stringify(list.body)).not.toContain(API_KEY);
        const denied = await post("member-key", "client-sources/update", { agent: "omp", sources: ["api-route"] });
        expect(denied.status).toBe(403);
      });

      it("lets an admin update, and answers 409 SOURCE_IN_USE with the clients", async () => {
        const group = await apiSource("api-route");
        const ok = await post("admin-key", "client-sources/update", { agent: "omp", sources: ["api-route"] });
        expect(ok.status).toBe(200);
        expect(ok.body.data).toMatchObject({ agent: "omp", mode: "multi", selected: ["api-route"] });
        const busy = await post("admin-key", "groups/toggle", { group_id: group.group_id, enabled: false });
        expect(busy.status).toBe(409);
        expect(busy.body.message).toContain("SOURCE_IN_USE");
        expect(busy.body.data).toMatchObject({ clients: ["omp"] });
        const missing = await post("admin-key", "client-sources/update", { agent: "omp", sources: ["ghost"] });
        expect(missing.status).toBe(404);
      });
    });
  });
}

function model(id: string, enabled = false) {
  return { id, display_name: id, enabled, available: true, first_seen_at: "2026-10-26T00:00:00.000Z", last_seen_at: "2026-10-26T00:00:00.000Z" };
}
