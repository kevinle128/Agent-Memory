/**
 * Team scope of the subscription pools at the service and route level. Backend independent: the
 * sqlite and mongodb test files each call it with their own store factory.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type * as http from "node:http";
import type { IMetadataStore } from "./interface.js";
import { MetadataService, type SubscriptionAccountChange } from "../service/metadata-service.js";
import { handleV3MetaRoute } from "../router/v3-meta-router.js";
import type { SupportedAgent } from "../types.js";
import { ConfigParamService } from "../service/config-param-service.js";
import { loadDefaultRegistry } from "../config/param-registry.js";
import { fakeAdapter, tokens, usageReading } from "../../subscription-pool/test-support.js";

const AGENTS: SupportedAgent[] = [
  { agent_source: "claude-code", protocol: "anthropic", display_name: "Claude Code" },
  { agent_source: "codex", protocol: "openai-responses", display_name: "Codex" },
  { agent_source: "omp", protocol: "openai-chat", display_name: "oh-my-pi", multi_source: true, formats: ["anthropic-messages", "openai-responses", "openai-chat"] },
  { agent_source: "codebuddy", protocol: "openai-chat", display_name: "CodeBuddy", multi_source: true, formats: ["openai-chat"] },
];

const TEAM_A = "team-a";
const TEAM_B = "team-b";
const POOL_ROUTES = "/v3/meta/subscription-pool/";
const INSTANCE_ROUTES = "/v3/meta/instance-upstream/";

interface Reply {
  status: number;
  body: { code: number; message: string; data?: any };
}

export function runSubscriptionPoolTeamScopeContract(
  backend: string,
  makeStore: () => Promise<IMetadataStore>,
  closeStore: (store: IMetadataStore) => Promise<void>,
): void {
  describe(`subscription pool team scope: ${backend}`, () => {
    let store: IMetadataStore;
    let svc: MetadataService;
    let adapter: ReturnType<typeof fakeAdapter>;

    beforeEach(async () => {
      store = await makeStore();
      await store.init?.();
      svc = new MetadataService(store, "default");
      adapter = fakeAdapter();
      svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });
      // The start value of a new account comes from the config params, as in production.
      const registry = loadDefaultRegistry();
      const configParams = new ConfigParamService(store, registry);
      await configParams.initDefaults(registry);
      svc.setConfigParamService(configParams);
      await store.ensureDefaultSeeded(AGENTS);
      for (const [id, type] of [["usr-a-admin", "normal"], ["usr-a-member", "normal"], ["usr-b-admin", "normal"], ["usr-outsider", "normal"], ["usr-root", "system_admin"]] as const) {
        await store.createUser({ user_id: id, username: id, auth_provider: "local", external_id: id, default_key_value: `${id}-key`, user_type: type });
      }
      await store.createTeam({ team_id: TEAM_A, name: "team a", owner_user_id: "usr-a-admin" });
      await store.createTeam({ team_id: TEAM_B, name: "team b", owner_user_id: "usr-b-admin" });
      await store.addTeamMember({ team_id: TEAM_A, user_id: "usr-a-member", role: "member" });
    });

    afterEach(async () => {
      await closeStore(store);
    });

    async function call(prefix: string, userKey: string, action: string, body: unknown): Promise<Reply> {
      let status = 0;
      let parsed: Reply["body"] = { code: 0, message: "" };
      const handled = await handleV3MetaRoute(
        { headers: { "x-tdai-service-id": "default", "x-tdai-user-key": userKey } } as unknown as http.IncomingMessage,
        {} as http.ServerResponse,
        `${prefix}${action}`,
        "POST",
        async <T>() => body as T,
        (_res, code, payload) => {
          status = code;
          parsed = payload as Reply["body"];
        },
        { getMetadataService: () => svc, logger: { info() {}, warn() {}, error() {} }, getSupportedAgents: () => AGENTS },
      );
      expect(handled).toBe(true);
      return { status, body: parsed };
    }
    const pool = (key: string, action: string, body: unknown) => call(POOL_ROUTES, key, action, body);
    const instance = (key: string, action: string, body: unknown) => call(INSTANCE_ROUTES, key, action, body);

    const groupOf = async (teamId: string, name: string) =>
      (await store.listInstanceUpstreamGroups({ mode: "subscription_pool", team_id: teamId }, AGENTS)).find((g) => g.name === name)!;

    async function addAccount(groupId: string, providerAccountId: string, provider: "codex" | "claude" = "claude", extra: Record<string, unknown> = {}) {
      const { account } = await store.upsertSubscriptionAccountByProviderId({
        group_id: groupId, provider, provider_account_id: providerAccountId, display_name: `name ${providerAccountId}`,
        access_token: `access-${providerAccountId}`, refresh_token: `refresh-${providerAccountId}`, token_expires_at: Date.now() + 3_600_000,
        ...extra,
      });
      return account;
    }

    /** Both teams own a claude pool with one account each. */
    async function twoTeamPools() {
      await svc.enableSubscriptionPool(TEAM_A, "claude", AGENTS);
      await svc.enableSubscriptionPool(TEAM_B, "claude", AGENTS);
      const a = await groupOf(TEAM_A, "claude subscription pool");
      const b = await groupOf(TEAM_B, "claude subscription pool");
      return { a, b, accountA: await addAccount(a.group_id, "acct-a"), accountB: await addAccount(b.group_id, "acct-b") };
    }

    type Status = { default_threshold_pct: number; providers: { provider: string; enabled: boolean; group_id: string | null; clients: string[]; accounts: { account_id: string; threshold_pct: number }[] }[] };
    const statusOf = async (teamId: string, provider: "claude" | "codex" = "claude") =>
      (await svc.getSubscriptionPoolStatus(teamId, provider) as unknown as Status).providers[0]!;

    describe("authorization", () => {
      it("a team admin manages the pool of the team; a member only views it", async () => {
        expect((await pool("usr-a-admin-key", "enable", { team_id: TEAM_A, provider: "claude" })).status).toBe(200);
        expect((await pool("usr-a-member-key", "enable", { team_id: TEAM_A, provider: "codex" })).status).toBe(403);
        expect((await pool("usr-a-member-key", "disable", { team_id: TEAM_A, provider: "claude" })).status).toBe(403);
        expect((await pool("usr-a-member-key", "clients/update", { team_id: TEAM_A, provider: "claude", agents: ["claude-code"] })).status).toBe(403);

        const viewed = await pool("usr-a-member-key", "status", { team_id: TEAM_A, provider: "claude" });
        expect(viewed.status).toBe(200);
        expect(viewed.body.data.providers[0]).toMatchObject({ enabled: true });

        const set = await pool("usr-a-admin-key", "clients/update", { team_id: TEAM_A, provider: "claude", agents: ["claude-code"] });
        expect(set.status).toBe(200);
        expect(set.body.data.clients).toEqual(["claude-code"]);
        expect((await pool("usr-root-key", "status", { team_id: TEAM_A, provider: "claude" })).status).toBe(200);
      });

      it("refuses the pool calls of a team the caller is not in, for every team call", async () => {
        const { accountA } = await twoTeamPools();
        for (const [action, body] of [
          ["status", { team_id: TEAM_A }],
          ["enable", { team_id: TEAM_A, provider: "codex" }],
          ["disable", { team_id: TEAM_A, provider: "claude" }],
          ["clients/update", { team_id: TEAM_A, provider: "claude", agents: [] }],
          ["account/oauth-start", { team_id: TEAM_A, provider: "codex" }],
          ["account/oauth-complete", { team_id: TEAM_A, provider: "codex", state: "x", code: "y" }],
          ["check-all", { team_id: TEAM_A }],
        ] as const) {
          const denied = await pool("usr-b-admin-key", action, body);
          expect(denied.status, action).toBe(403);
          expect(JSON.stringify(denied.body)).not.toContain(accountA.account_id);
        }
        expect(await groupOf(TEAM_A, "codex subscription pool")).toBeUndefined();
      });

      it("a team admin of another team gets not found for every account route", async () => {
        const { accountA } = await twoTeamPools();
        for (const [action, extra] of [
          ["account/update", { enabled: false, threshold_pct: 60 }],
          ["account/delete", {}],
          ["account/check-usage", {}],
          ["account/redeem-reset-credit", { credit_id: "credit-1", request_id: "request-12345" }],
        ] as const) {
          const missing = await pool("usr-b-admin-key", action, { account_id: "sacc-missing", ...extra });
          const foreign = await pool("usr-b-admin-key", action, { account_id: accountA.account_id, ...extra });
          expect(foreign.status, action).toBe(404);
          expect(foreign.body.message, action).toContain("account_not_found");
          // An id of another team answers like an id that does not exist.
          expect({ status: foreign.status, code: foreign.body.code }).toEqual({ status: missing.status, code: missing.body.code });
        }
        expect(await store.getSubscriptionAccount(accountA.account_id)).toMatchObject({ enabled: true, threshold_pct: 95 });
      });

      it("gives the model list calls of a pool group one answer for a foreign group and a missing group", async () => {
        const { a } = await twoTeamPools();
        for (const action of ["groups/source-refresh", "groups/source-models/update"] as const) {
          const body = (group_id: string) => (action === "groups/source-refresh" ? { group_id } : { group_id, models: [{ id: "m1", enabled: true }] });
          const foreign = await instance("usr-b-admin-key", action, body(a.group_id));
          const missing = await instance("usr-b-admin-key", action, body("grp-missing"));
          expect(foreign.status, action).toBe(403);
          expect({ status: foreign.status, message: foreign.body.message }).toEqual({ status: missing.status, message: missing.body.message });
          expect((await instance("usr-a-member-key", action, body(a.group_id))).status, action).toBe(403);
        }
        expect((await instance("usr-a-admin-key", "groups/source-refresh", { group_id: a.group_id })).status).toBe(200);
      });

      it("refuses a blank team before it reaches the store", async () => {
        await expect(svc.enableSubscriptionPool("  ", "claude", AGENTS)).rejects.toMatchObject({ code: "team_required" });
        await expect(svc.getSubscriptionPoolStatus("", "claude")).rejects.toMatchObject({ code: "team_required" });
        await expect(svc.disableSubscriptionPool("", "claude", AGENTS)).rejects.toMatchObject({ code: "team_required" });
        expect(await store.listInstanceUpstreamGroups({ mode: "subscription_pool" }, AGENTS)).toEqual([]);
        expect((await pool("usr-root-key", "status", { team_id: "" })).status).toBe(400);
      });

      it("makes the System Admin name an existing team before a pool is created", async () => {
        const reply = await pool("usr-root-key", "enable", { team_id: "team-ghost", provider: "claude" });
        expect(reply.status).toBe(404);
        expect(reply.body.message).toContain("team_not_found");
        expect(await store.listInstanceUpstreamGroups({ mode: "subscription_pool" }, AGENTS)).toEqual([]);
      });
    });

    describe("isolation", () => {
      it("two teams each enable a claude pool and see only their own accounts", async () => {
        const { a, b, accountA, accountB } = await twoTeamPools();
        expect(a.group_id).not.toBe(b.group_id);
        expect([a.source_name, b.source_name]).toEqual(["sub-claude", "sub-claude"]);
        expect((await statusOf(TEAM_A)).accounts.map((x) => x.account_id)).toEqual([accountA.account_id]);
        expect((await statusOf(TEAM_B)).accounts.map((x) => x.account_id)).toEqual([accountB.account_id]);
        const asMemberOfA = await pool("usr-a-member-key", "status", { team_id: TEAM_A });
        expect(JSON.stringify(asMemberOfA.body)).not.toContain(accountB.account_id);
      });

      it("status of a team without a pool returns no account", async () => {
        await twoTeamPools();
        await store.createTeam({ team_id: "team-empty", name: "empty", owner_user_id: "usr-outsider" });
        const status = await svc.getSubscriptionPoolStatus("team-empty") as unknown as Status;
        expect(status.providers.map((p) => [p.provider, p.enabled, p.group_id, p.accounts])).toEqual([
          ["claude", false, null, []], ["codex", false, null, []], ["antigravity", false, null, []],
        ]);
      });

      it("keeps the pool clients of one team out of the other team", async () => {
        await twoTeamPools();
        await svc.updateSubscriptionPoolClients(TEAM_A, "claude", ["claude-code", "omp"], AGENTS);
        await svc.updateSubscriptionPoolClients(TEAM_B, "claude", ["claude-code"], AGENTS);
        expect((await statusOf(TEAM_A)).clients.sort()).toEqual(["claude-code", "omp"]);
        expect((await statusOf(TEAM_B)).clients).toEqual(["claude-code"]);
        expect((await groupOf(TEAM_A, "claude subscription pool"))).toMatchObject({ agents: ["claude-code"], source_agents: ["omp"] });
        await expect(svc.disableSubscriptionPool(TEAM_B, "claude", AGENTS)).rejects.toMatchObject({ code: "SOURCE_IN_USE", detail: { clients: ["claude-code"] } });
      });

      it("check-all of a team checks only that team's accounts", async () => {
        const { accountA, accountB } = await twoTeamPools();
        adapter.fetchUsage.mockImplementation(async () => usageReading([]));
        const sawTokens = () => adapter.fetchUsage.mock.calls.map((call) => call[0]);
        svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });

        expect(await svc.checkAllSubscriptionAccountUsage(TEAM_A)).toEqual({ checked: 1, failed: 0 });
        expect(sawTokens()).toEqual([accountA.access_token]);
        expect(await svc.checkAllSubscriptionAccountUsage(TEAM_B)).toEqual({ checked: 1, failed: 0 });
        expect(sawTokens()).toEqual([accountA.access_token, accountB.access_token]);
        expect(await svc.checkAllSubscriptionAccountUsage("team-empty")).toEqual({ checked: 0, failed: 0 });

        const everyone = await pool("usr-root-key", "check-all", {});
        expect(everyone.body.data).toEqual({ checked: 2, failed: 0 });
        expect((await pool("usr-a-admin-key", "check-all", {})).status).toBe(403);
      });

      it("the generic group routes refuse pool groups", async () => {
        const { a } = await twoTeamPools();
        const refused = (reply: Reply) => {
          expect(reply.status).toBe(400);
          expect(reply.body.message).toContain("POOL_GROUP_TEAM_SCOPED");
        };
        // The create schema has no pool mode, so a pool create stops at the schema; the service refuses it as well.
        expect((await instance("usr-root-key", "groups/create", { group_type: "custom", name: "claude subscription pool", agents: ["claude-code"], mode: "subscription_pool", base_url: "https://x.test" })).status).toBe(400);
        await expect(svc.createInstanceUpstreamCustomGroup({ name: "claude subscription pool", agents: ["claude-code"], mode: "subscription_pool", base_url: "" }, AGENTS))
          .rejects.toMatchObject({ code: "POOL_GROUP_TEAM_SCOPED" });
        refused(await instance("usr-root-key", "groups/update", { group_id: a.group_id, group_type: "custom", agents: ["claude-code"] }));
        refused(await instance("usr-root-key", "groups/update", { group_id: a.group_id, group_type: "custom", mode: "subscription_pool" }));
        refused(await instance("usr-root-key", "groups/toggle", { group_id: a.group_id, enabled: false }));
        refused(await instance("usr-root-key", "groups/delete", { group_id: a.group_id }));
        expect(await store.getInstanceUpstreamGroup(a.group_id)).toMatchObject({ enabled: true, agents: [], team_id: TEAM_A });
        const listed = await instance("usr-root-key", "groups/list", {});
        expect(listed.body.data.items.filter((item: { mode: string }) => item.mode === "subscription_pool").map((item: { team_id: string }) => item.team_id).sort()).toEqual([TEAM_A, TEAM_B]);
        const view = await instance("usr-a-member-key", "groups/view", {});
        expect(view.body.data.items).toEqual([]);
      });

      it("client-sources list hides pool sources, and update does not take a pool name", async () => {
        await twoTeamPools();
        await svc.updateSubscriptionPoolClients(TEAM_A, "claude", ["omp"], AGENTS);
        const listed = await instance("usr-a-member-key", "client-sources/list", {});
        expect(listed.status).toBe(200);
        expect(listed.body.data.sources).toEqual([]);
        for (const agent of listed.body.data.agents as { selected: string[] }[]) expect(agent.selected).toEqual([]);
        const update = await instance("usr-root-key", "client-sources/update", { agent: "omp", sources: ["sub-claude"] });
        expect(update.status).toBe(404);
        expect(update.body.message).toContain("SOURCE_NOT_FOUND");
      });

      it("the internal list gives a team id on every row", async () => {
        const { a, b } = await twoTeamPools();
        const { items } = await svc.listInstanceUpstreamGroupsInternal(AGENTS);
        for (const row of items) expect(typeof row.team_id).toBe("string");
        expect(items.filter((row) => row.mode === "subscription_pool").map((row) => [row.group_id, row.team_id]).sort())
          .toEqual([[a.group_id, TEAM_A], [b.group_id, TEAM_B]].sort());
        expect(items.filter((row) => row.mode !== "subscription_pool").every((row) => row.team_id === "")).toBe(true);
      });
    });

    describe("login", () => {
      const exchange = (providerAccountId: string) => adapter.exchangeCode.mockResolvedValueOnce(tokens({ providerAccountId, accountLabel: providerAccountId }));
      const finish = (teamId: string, userId: string, state: string, extra: Record<string, unknown> = {}) =>
        svc.completeSubscriptionOAuth({ team_id: teamId, provider: "codex", state, code: "code-1", ...extra }, userId);

      it("a login started for one team cannot finish in another team or by another user", async () => {
        const started = svc.startSubscriptionOAuth(TEAM_A, "codex", "usr-a-admin");
        exchange("acct-1");
        await expect(finish(TEAM_B, "usr-a-admin", started.state)).rejects.toMatchObject({ code: "INVALID_OAUTH_STATE" });
        await expect(finish(TEAM_A, "usr-root", started.state)).rejects.toMatchObject({ code: "INVALID_OAUTH_STATE" });
        expect(adapter.exchangeCode).not.toHaveBeenCalled();
        // A wrong caller does not use up the login of its owner.
        const account = await finish(TEAM_A, "usr-a-admin", started.state);
        expect(account).toMatchObject({ provider_account_id: "acct-1", created: true });
        const group = await groupOf(TEAM_A, "codex subscription pool");
        expect(account.group_id).toBe(group.group_id);
        expect(await groupOf(TEAM_B, "codex subscription pool")).toBeUndefined();
        expect(group).toMatchObject({ enabled: false, team_id: TEAM_A });
      });

      it("refuses the login routes of a team the caller does not manage", async () => {
        const started = await pool("usr-a-admin-key", "account/oauth-start", { team_id: TEAM_A, provider: "codex" });
        expect(started.status).toBe(200);
        const stolen = await pool("usr-b-admin-key", "account/oauth-complete", { team_id: TEAM_B, provider: "codex", state: started.body.data.state, code: "code-1" });
        expect(stolen.status).toBe(400);
        expect(stolen.body.message).toContain("INVALID_OAUTH_STATE");
        expect(adapter.exchangeCode).not.toHaveBeenCalled();
      });

      it("a new account takes the threshold from the login request, else the global start value", async () => {
        await svc.updateSubscriptionPoolSettings(80);
        exchange("acct-default");
        const first = await finish(TEAM_A, "usr-a-admin", svc.startSubscriptionOAuth(TEAM_A, "codex", "usr-a-admin").state);
        expect(first.threshold_pct).toBe(80);

        exchange("acct-own");
        const second = await finish(TEAM_A, "usr-a-admin", svc.startSubscriptionOAuth(TEAM_A, "codex", "usr-a-admin").state, { threshold_pct: 60 });
        expect(second.threshold_pct).toBe(60);

        // A login of an account that exists keeps the stored value.
        exchange("acct-own");
        const again = await finish(TEAM_A, "usr-a-admin", svc.startSubscriptionOAuth(TEAM_A, "codex", "usr-a-admin").state, { threshold_pct: 99 });
        expect(again).toMatchObject({ created: false, threshold_pct: 60 });
      });

      it("a changed start value reaches the next read at once, also after an earlier read", async () => {
        const { accountA } = await twoTeamPools();
        // The first read fills the cache of the config parameter service.
        expect(((await svc.getSubscriptionPoolStatus(TEAM_A)) as unknown as Status).default_threshold_pct).toBe(95);
        await svc.updateSubscriptionPoolSettings(80);
        expect(((await svc.getSubscriptionPoolStatus(TEAM_A)) as unknown as Status).default_threshold_pct).toBe(80);
        exchange("acct-after-change");
        const created = await finish(TEAM_A, "usr-a-admin", svc.startSubscriptionOAuth(TEAM_A, "codex", "usr-a-admin").state);
        expect(created.threshold_pct).toBe(80);
        expect((await store.getSubscriptionAccount(accountA.account_id))?.threshold_pct).toBe(95);
      });

      it("rejects a threshold outside 50-100 before the login is used up", async () => {
        const started = svc.startSubscriptionOAuth(TEAM_A, "codex", "usr-a-admin");
        for (const threshold_pct of [49, 101, 90.5, Number.NaN]) {
          await expect(finish(TEAM_A, "usr-a-admin", started.state, { threshold_pct })).rejects.toMatchObject({ code: "INVALID_THRESHOLD" });
        }
        expect(adapter.exchangeCode).not.toHaveBeenCalled();
        exchange("acct-ok");
        await expect(finish(TEAM_A, "usr-a-admin", started.state, { threshold_pct: 50 })).resolves.toMatchObject({ threshold_pct: 50 });
      });
    });

    describe("threshold", () => {
      it("a team admin sets the threshold of an account of the team; a member and another team's admin cannot", async () => {
        const { accountA } = await twoTeamPools();
        const set = (key: string, threshold_pct: number) => pool(key, "account/update", { account_id: accountA.account_id, threshold_pct });
        expect((await set("usr-a-member-key", 60)).status).toBe(404);
        expect((await set("usr-b-admin-key", 60)).status).toBe(404);
        expect((await set("usr-outsider-key", 60)).status).toBe(404);
        expect((await store.getSubscriptionAccount(accountA.account_id))?.threshold_pct).toBe(95);

        const own = await set("usr-a-admin-key", 60);
        expect(own.status).toBe(200);
        expect(own.body.data.threshold_pct).toBe(60);
        expect((await set("usr-root-key", 75)).body.data.threshold_pct).toBe(75);
        expect((await statusOf(TEAM_A)).accounts[0]?.threshold_pct).toBe(75);
      });

      it("rejects a threshold outside 50-100", async () => {
        const { accountA } = await twoTeamPools();
        // The service checks the value by itself; the route schema checks it first on the wire.
        for (const value of [49, 101, 75.5, Number.NaN, 0, -1]) {
          await expect(svc.updateSubscriptionAccount(accountA.account_id, { threshold_pct: value })).rejects.toMatchObject({ code: "INVALID_THRESHOLD" });
          expect((await pool("usr-a-admin-key", "account/update", { account_id: accountA.account_id, threshold_pct: value })).status).toBe(400);
        }
        for (const value of [50, 100]) {
          await expect(svc.updateSubscriptionAccount(accountA.account_id, { threshold_pct: value })).resolves.toMatchObject({ threshold_pct: value });
        }
        await expect(svc.updateSubscriptionPoolSettings(49)).rejects.toMatchObject({ code: "INVALID_THRESHOLD" });
      });

      it("changing the global value does not change existing accounts", async () => {
        const { accountA, accountB } = await twoTeamPools();
        await svc.updateSubscriptionAccount(accountB.account_id, { threshold_pct: 70 });
        await svc.updateSubscriptionPoolSettings(55);
        expect((await store.getSubscriptionAccount(accountA.account_id))?.threshold_pct).toBe(95);
        expect((await store.getSubscriptionAccount(accountB.account_id))?.threshold_pct).toBe(70);
        expect(((await svc.getSubscriptionPoolStatus(TEAM_A)) as unknown as Status).default_threshold_pct).toBe(55);
        expect((await pool("usr-a-admin-key", "settings/update", { threshold_pct: 60 })).status).toBe(403);
        expect((await pool("usr-root-key", "settings/update", { threshold_pct: 60 })).status).toBe(200);
      });

      it("the internal account list gives each account its threshold", async () => {
        const { accountA, accountB } = await twoTeamPools();
        await svc.updateSubscriptionAccount(accountB.account_id, { threshold_pct: 65 });
        const listed = await svc.listSubscriptionAccountsInternal();
        expect(Object.fromEntries(listed.accounts.map((account) => [account.account_id, account.threshold_pct])))
          .toEqual({ [accountA.account_id]: 95, [accountB.account_id]: 65 });
        expect(listed.threshold_pct).toBe(95);
      });
    });

    describe("clients", () => {
      it("stores a single-source client in agents and a multi-source client in source_agents", async () => {
        await svc.enableSubscriptionPool(TEAM_A, "claude", AGENTS);
        await expect(svc.updateSubscriptionPoolClients(TEAM_A, "claude", ["claude-code", "omp", "claude-code"], AGENTS))
          .resolves.toMatchObject({ team_id: TEAM_A, clients: ["claude-code", "omp"] });
        expect(await groupOf(TEAM_A, "claude subscription pool")).toMatchObject({ agents: ["claude-code"], source_agents: ["omp"] });
        // The choice replaces the old one.
        await svc.updateSubscriptionPoolClients(TEAM_A, "claude", ["omp"], AGENTS);
        expect(await groupOf(TEAM_A, "claude subscription pool")).toMatchObject({ agents: [], source_agents: ["omp"] });
        // The client stays in its instance group.
        const instanceGroup = (await store.listInstanceUpstreamGroups({ group_type: "default" }, AGENTS))[0]!;
        expect(instanceGroup.agents).toContain("claude-code");
      });

      it("refuses a client whose format the pool does not serve, an unknown client and a pool that is off", async () => {
        await svc.enableSubscriptionPool(TEAM_A, "claude", AGENTS);
        await expect(svc.updateSubscriptionPoolClients(TEAM_A, "claude", ["codex"], AGENTS)).rejects.toMatchObject({ code: "SOURCE_FORMAT_MISMATCH" });
        await expect(svc.updateSubscriptionPoolClients(TEAM_A, "claude", ["codebuddy"], AGENTS)).rejects.toMatchObject({ code: "SOURCE_FORMAT_MISMATCH" });
        await expect(svc.updateSubscriptionPoolClients(TEAM_A, "claude", ["ghost"], AGENTS)).rejects.toMatchObject({ code: "INVALID_AGENTS" });
        await expect(svc.updateSubscriptionPoolClients(TEAM_A, "codex", ["codex"], AGENTS)).rejects.toMatchObject({ code: "SOURCE_DISABLED" });
        expect(await groupOf(TEAM_A, "claude subscription pool")).toMatchObject({ agents: [], source_agents: [] });
        const noPool = await svc.updateSubscriptionPoolClients(TEAM_A, "codex", [], AGENTS);
        expect(noPool).toMatchObject({ group_id: null, clients: [] });
        expect(await groupOf(TEAM_A, "codex subscription pool")).toBeUndefined();
      });
    });

    describe("team delete", () => {
      it("deleting a team removes its pool accounts and tells the scheduler", async () => {
        const { accountA, accountB } = await twoTeamPools();
        const changes: SubscriptionAccountChange[] = [];
        svc.setSubscriptionPoolHooks({ onAccountChanged: (_instance, change) => { changes.push(change); } });

        const result = await svc.deleteTeams([TEAM_B]);

        expect(result).not.toHaveProperty("deleted_pool_account_ids");
        expect(await store.getSubscriptionAccount(accountB.account_id)).toBeNull();
        expect(await store.getSubscriptionAccount(accountA.account_id)).not.toBeNull();
        expect(await groupOf(TEAM_B, "claude subscription pool")).toBeUndefined();
        expect(await groupOf(TEAM_A, "claude subscription pool")).toBeDefined();
        expect(changes).toEqual([{ accountId: accountB.account_id, account: null }]);
      });

      it("drops the open logins of a deleted team, and the route response carries no account ids", async () => {
        await twoTeamPools();
        const started = svc.startSubscriptionOAuth(TEAM_B, "codex", "usr-b-admin");
        const reply = await call("/v3/meta/", "usr-b-admin-key", "team/delete", { team_ids: [TEAM_B] });
        expect(reply.status).toBe(200);
        expect(JSON.stringify(reply.body)).not.toContain("deleted_pool_account_ids");
        await expect(svc.completeSubscriptionOAuth({ team_id: TEAM_B, provider: "codex", state: started.state, code: "c" }, "usr-b-admin"))
          .rejects.toMatchObject({ code: "INVALID_OAUTH_STATE" });
      });
    });
  });
}
