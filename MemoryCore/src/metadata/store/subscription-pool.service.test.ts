import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type * as http from "node:http";
import { SqliteMetadataStore } from "./sqlite-adapter.js";
import { MetadataService, type SubscriptionAccountChange } from "../service/metadata-service.js";
import { SubscriptionProviderError } from "../../subscription-pool/providers/types.js";
import { fakeAdapter, tokens, usageReading, POOL_TEAM_ID, POOL_USER_ID } from "../../subscription-pool/test-support.js";
import { handleV3MetaRoute } from "../router/v3-meta-router.js";
import type { SupportedAgent } from "../types.js";

const AGENTS: SupportedAgent[] = [
  { agent_source: "claude-code", protocol: "anthropic", display_name: "Claude Code" },
  { agent_source: "codex", protocol: "openai-responses", display_name: "Codex" },
];

describe("subscription pool service", () => {
  let store: SqliteMetadataStore;
  let svc: MetadataService;

  beforeEach(() => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    svc = new MetadataService(store, "default");
  });

  afterEach(async () => {
    await store.close();
  });

  it("turns the codex pool on as a source without moving codex, and switches it off only while unused", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    const enabled = await store.listInstanceUpstreamGroups(undefined, AGENTS);
    const defaultGroup = enabled.find((group) => group.group_type === "default");
    const pool = enabled.find((group) => group.mode === "subscription_pool");
    expect(defaultGroup?.agents).toEqual(expect.arrayContaining(["codex", "claude-code"]));
    expect(pool).toMatchObject({ agents: [], enabled: true, source_name: "sub-openai", base_url: "", api_key: "", team_id: POOL_TEAM_ID });
    expect(await svc.getSubscriptionPoolStatus(POOL_TEAM_ID, "codex")).toMatchObject({ providers: [{ enabled: true, clients: [] }] });

    await svc.updateSubscriptionPoolClients(POOL_TEAM_ID, "codex", ["codex"], AGENTS);
    expect((await store.getInstanceUpstreamGroup(pool!.group_id))?.agents).toEqual(["codex"]);
    await expect(svc.disableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS)).rejects.toMatchObject({ code: "SOURCE_IN_USE", detail: { clients: ["codex"] } });
    // The client keeps its place in the instance group while it uses the pool.
    expect((await store.listInstanceUpstreamGroups(undefined, AGENTS)).find((group) => group.group_type === "default")?.agents).toContain("codex");

    await svc.updateSubscriptionPoolClients(POOL_TEAM_ID, "codex", [], AGENTS);
    const disabled = await svc.disableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    const after = await store.listInstanceUpstreamGroups(undefined, AGENTS);
    const defaultAfter = after.find((group) => group.group_type === "default");
    expect(defaultAfter?.group_id).toBe(defaultGroup?.group_id);
    expect(defaultAfter?.agents).toContain("codex");
    expect(disabled.default_group_id).toBe(defaultGroup?.group_id);
    expect(after.find((group) => group.group_id === pool?.group_id)).toMatchObject({ agents: [], enabled: false });
  });

  it("turns the pool on while the agent has a custom upstream and leaves the agent there", async () => {
    await store.ensureDefaultSeeded(AGENTS);
    const groups = await store.listInstanceUpstreamGroups(undefined, AGENTS);
    const fallback = groups.find((group) => group.group_type === "default")!;
    await store.moveAgentBetweenUpstreamGroups({
      agent: "codex",
      from: [{ group_id: fallback.group_id }],
      to: { create: { name: "office gateway", mode: "custom_unified", base_url: "https://gw.example.test", api_key: "secret" } },
    });
    await expect(svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS)).resolves.toMatchObject({ enabled: true, agents: [] });
    const still = await store.listInstanceUpstreamGroups(undefined, AGENTS);
    expect(still.find((group) => group.name === "office gateway")?.agents).toEqual(["codex"]);
  });

  it("refuses to create a subscription pool group through the generic group call", async () => {
    await expect(svc.createInstanceUpstreamCustomGroup({
      name: "claude subscription pool",
      agents: ["claude-code"],
      mode: "subscription_pool",
      base_url: "https://api.anthropic.com",
      api_key: "should-not-stick",
    }, AGENTS)).rejects.toMatchObject({ code: "POOL_GROUP_TEAM_SCOPED" });
    expect((await store.listInstanceUpstreamGroups({ mode: "subscription_pool" })).length).toBe(0);
  });

  it("hides tokens on the public status and shows the access token only to the proxy", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    const pool = (await store.listInstanceUpstreamGroups()).find((group) => group.mode === "subscription_pool")!;
    await store.upsertSubscriptionAccountByProviderId({
      group_id: pool.group_id,
      provider: "codex",
      provider_account_id: "acct-codex-1",
      display_name: "Plus 1",
      account_label: "plus1@example.test (plus)",
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      token_expires_at: Date.now() + 60 * 60 * 1000,
    });

    const status = JSON.stringify(await svc.getSubscriptionPoolStatus(POOL_TEAM_ID, "codex"));
    expect(status).not.toContain("access-secret");
    expect(status).not.toContain("refresh-secret");
    expect(status).not.toContain("access_token");
    expect(status).not.toContain("refresh_token");

    const listed = await svc.listSubscriptionAccountsInternal();
    expect(listed.accounts).toEqual([expect.objectContaining({
      access_token: "access-secret",
      provider_account_id: "acct-codex-1",
      display_name: "Plus 1",
      account_label: "plus1@example.test (plus)",
    })]);
    expect(listed.accounts[0]).not.toHaveProperty("refresh_token");
    expect(JSON.stringify(listed)).not.toContain("refresh-secret");
    expect(JSON.stringify(listed)).not.toContain("refresh_token");

    await svc.disableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    expect((await svc.listSubscriptionAccountsInternal()).accounts).toEqual([]);
  });

  it("keeps an account active when the proxy reports an unclassified 429", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    const pool = (await store.listInstanceUpstreamGroups()).find((group) => group.mode === "subscription_pool")!;
    const { account } = await store.upsertSubscriptionAccountByProviderId({
      group_id: pool.group_id,
      provider: "codex",
      provider_account_id: "acct-codex-1",
      display_name: "Max 1",
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      token_expires_at: null,
    });
    const reported = await svc.reportSubscriptionAccount(account.account_id, { status_code: 429 });
    expect(reported.status).toBe("active");
    expect(reported.exhausted_until).toBeNull();
    const stored = await store.getSubscriptionAccount(account.account_id);
    expect(stored?.status).toBe("active");
    expect(JSON.stringify(reported)).not.toContain("access-secret");
  });

  it("returns an authorize url without the code verifier", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    const started = svc.startSubscriptionOAuth(POOL_TEAM_ID, "codex", POOL_USER_ID);
    expect(started.authorize_url).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
    expect(started.authorize_url).toContain(`state=${started.state}`);
    expect(started.authorize_url).not.toContain("code_verifier");
    expect(JSON.stringify(started)).not.toContain("codeVerifier");
  });

  it("gives claude-code to the team pool and back without leaving the default group", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "claude", AGENTS);
    const enabled = await store.listInstanceUpstreamGroups(undefined, AGENTS);
    const defaultGroup = enabled.find((group) => group.group_type === "default");
    const pool = enabled.find((group) => group.mode === "subscription_pool");
    expect(defaultGroup?.agents).toEqual(expect.arrayContaining(["codex", "claude-code"]));
    expect(pool).toMatchObject({ agents: [], name: "claude subscription pool", source_name: "sub-claude" });

    const started = svc.startSubscriptionOAuth(POOL_TEAM_ID, "claude", POOL_USER_ID);
    const url = new URL(started.authorize_url);
    expect(url.origin + url.pathname).toBe("https://claude.com/cai/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(url.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
    expect(started.authorize_url).not.toContain("code_verifier");
    expect(JSON.stringify(started)).not.toContain("codeVerifier");

    await svc.updateSubscriptionPoolClients(POOL_TEAM_ID, "claude", ["claude-code"], AGENTS);
    expect((await store.getInstanceUpstreamGroup(pool!.group_id))?.agents).toEqual(["claude-code"]);
    expect((await store.listInstanceUpstreamGroups(undefined, AGENTS)).find((group) => group.group_type === "default")?.agents).toContain("claude-code");
    await expect(svc.disableSubscriptionPool(POOL_TEAM_ID, "claude", AGENTS)).rejects.toMatchObject({ code: "SOURCE_IN_USE" });
    await svc.updateSubscriptionPoolClients(POOL_TEAM_ID, "claude", [], AGENTS);
    await svc.disableSubscriptionPool(POOL_TEAM_ID, "claude", AGENTS);
    const disabled = await store.listInstanceUpstreamGroups(undefined, AGENTS);
    expect(disabled.find((group) => group.group_type === "default")?.agents).toContain("claude-code");
  });
});

describe("subscription pool provider calls", () => {
  let store: SqliteMetadataStore;
  let svc: MetadataService;
  let adapter: ReturnType<typeof fakeAdapter>;
  let changes: SubscriptionAccountChange[];

  beforeEach(async () => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    svc = new MetadataService(store, "default");
    adapter = fakeAdapter({
      exchangeCode: vi.fn(async () => tokens({ providerAccountId: "acct-9", accountLabel: "pool@example.com pro" })),
    });
    changes = [];
    svc.setSubscriptionPoolHooks({ adapterFor: () => adapter, onAccountChanged: (_instanceId, change) => { changes.push(change); } });
  });

  afterEach(async () => {
    await store.close();
  });

  async function login(redirect = true) {
    const started = svc.startSubscriptionOAuth(POOL_TEAM_ID, "codex", POOL_USER_ID);
    const input = redirect
      ? { redirect_url: `http://localhost:1455/auth/callback?code=code-1&state=${started.state}` }
      : { code: "code-1" };
    return { started, account: await svc.completeSubscriptionOAuth({ team_id: POOL_TEAM_ID, provider: "codex", state: started.state, ...input }, POOL_USER_ID) };
  }

  it("adds a claude account from a code#state paste and hides the tokens", async () => {
    adapter.fetchUsage.mockResolvedValue(usageReading([{
      name: "five_hour", model_scope: null, used_pct: 40, resets_at: null, observed_at: 1, source: "usage_api",
    }]));
    const started = svc.startSubscriptionOAuth(POOL_TEAM_ID, "claude", POOL_USER_ID);
    const account = await svc.completeSubscriptionOAuth({ team_id: POOL_TEAM_ID,
      provider: "claude",
      state: started.state,
      code: `code-1#${started.state}`,
    }, POOL_USER_ID);
    expect(account).toMatchObject({ provider: "claude", provider_account_id: "acct-9", created: true });
    expect(JSON.stringify(account)).not.toContain("access-new");
    expect(JSON.stringify(account)).not.toContain("refresh-new");
    const stored = (await store.listSubscriptionAccounts()).find((row) => row.account_id === account.account_id);
    expect(stored).toMatchObject({ provider: "claude", access_token: "access-new", refresh_token: "refresh-new" });
    expect(adapter.exchangeCode).toHaveBeenCalledWith(expect.objectContaining({
      code: "code-1",
      state: started.state,
      redirectUri: "https://platform.claude.com/oauth/code/callback",
    }));
    expect(adapter.fetchUsage).toHaveBeenCalledWith("access-new", "acct-9", { projectId: null });
    expect(account.usage).toMatchObject({ windows: [expect.objectContaining({ name: "five_hour", used_pct: 40 })] });
  });

  describe("antigravity login", () => {
    const REDIRECT = "http://localhost:51121/callback";

    beforeEach(() => {
      vi.stubEnv("ANTIGRAVITY_OAUTH_CLIENT_ID", "test-client-id.apps.googleusercontent.com");
      vi.stubEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET", "test-secret");
      adapter.exchangeCode.mockResolvedValue(tokens({
        providerAccountId: "pool@example.com", accountLabel: "pool@example.com", projectId: "proj-1",
      }));
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("uses the client id from the environment in the authorize URL", () => {
      const url = new URL(svc.startSubscriptionOAuth(POOL_TEAM_ID, "antigravity", POOL_USER_ID).authorize_url);
      expect(url.searchParams.get("client_id")).toBe("test-client-id.apps.googleusercontent.com");
    });

    it("refuses to start or finish a login without the OAuth client, and leaves claude and codex alone", async () => {
      const started = svc.startSubscriptionOAuth(POOL_TEAM_ID, "antigravity", POOL_USER_ID);
      vi.stubEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET", "");
      expect(() => svc.startSubscriptionOAuth(POOL_TEAM_ID, "antigravity", POOL_USER_ID)).toThrow("AntiGravity OAuth is not configured: set ANTIGRAVITY_OAUTH_CLIENT_ID and ANTIGRAVITY_OAUTH_CLIENT_SECRET");
      await expect(svc.completeSubscriptionOAuth({ team_id: POOL_TEAM_ID,
        provider: "antigravity", state: started.state, redirect_url: `${REDIRECT}?code=c&state=${started.state}`,
      }, POOL_USER_ID)).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
      expect(adapter.exchangeCode).not.toHaveBeenCalled();
      expect(() => svc.startSubscriptionOAuth(POOL_TEAM_ID, "claude", POOL_USER_ID)).not.toThrow();
      expect(() => svc.startSubscriptionOAuth(POOL_TEAM_ID, "codex", POOL_USER_ID)).not.toThrow();
    });

    it("stores the project, shows it in the public view and passes it to the usage check", async () => {
      const started = svc.startSubscriptionOAuth(POOL_TEAM_ID, "antigravity", POOL_USER_ID);
      const account = await svc.completeSubscriptionOAuth({ team_id: POOL_TEAM_ID,
        provider: "antigravity", state: started.state, redirect_url: `${REDIRECT}?code=code-1&state=${started.state}`,
      }, POOL_USER_ID);
      expect(account).toMatchObject({ provider: "antigravity", provider_account_id: "pool@example.com", project_id: "proj-1", created: true });
      expect(JSON.stringify(account)).not.toContain("access-new");
      expect(adapter.exchangeCode).toHaveBeenCalledWith(expect.objectContaining({ code: "code-1", codeVerifier: "", redirectUri: REDIRECT }));
      expect(adapter.fetchUsage).toHaveBeenCalledWith("access-new", "pool@example.com", { projectId: "proj-1" });
    });

    it("rejects a pasted code without the state, because nothing else binds it to this login", async () => {
      const started = svc.startSubscriptionOAuth(POOL_TEAM_ID, "antigravity", POOL_USER_ID);
      await expect(svc.completeSubscriptionOAuth({ team_id: POOL_TEAM_ID, provider: "antigravity", state: started.state, code: "code-1" }, POOL_USER_ID))
        .rejects.toMatchObject({ code: "INVALID_OAUTH_STATE" });
      expect(adapter.exchangeCode).not.toHaveBeenCalled();
    });

    it("rejects a pasted state that belongs to another login", async () => {
      const started = svc.startSubscriptionOAuth(POOL_TEAM_ID, "antigravity", POOL_USER_ID);
      await expect(svc.completeSubscriptionOAuth({ team_id: POOL_TEAM_ID,
        provider: "antigravity", state: started.state, redirect_url: `${REDIRECT}?code=code-1&state=other`,
      }, POOL_USER_ID)).rejects.toMatchObject({ code: "INVALID_OAUTH_STATE" });
    });

    it("keeps the stored project when a re-login finds none, and replaces it when one is found", async () => {
      const login = async () => {
        const started = svc.startSubscriptionOAuth(POOL_TEAM_ID, "antigravity", POOL_USER_ID);
        return svc.completeSubscriptionOAuth({ team_id: POOL_TEAM_ID,
          provider: "antigravity", state: started.state, redirect_url: `${REDIRECT}?code=c&state=${started.state}`,
        }, POOL_USER_ID);
      };
      const first = await login();
      adapter.exchangeCode.mockResolvedValue(tokens({ providerAccountId: "pool@example.com", accountLabel: "pool@example.com", projectId: null }));
      expect((await login()).project_id).toBe("proj-1");
      adapter.exchangeCode.mockResolvedValue(tokens({ providerAccountId: "pool@example.com", accountLabel: "pool@example.com", projectId: "proj-2" }));
      const third = await login();
      expect(third).toMatchObject({ account_id: first.account_id, project_id: "proj-2", created: false });
    });

    it("gives the proxy the project of an account in an enabled pool", async () => {
      await svc.enableSubscriptionPool(POOL_TEAM_ID, "antigravity", AGENTS);
      const started = svc.startSubscriptionOAuth(POOL_TEAM_ID, "antigravity", POOL_USER_ID);
      await svc.completeSubscriptionOAuth({ team_id: POOL_TEAM_ID,
        provider: "antigravity", state: started.state, redirect_url: `${REDIRECT}?code=c&state=${started.state}`,
      }, POOL_USER_ID);
      expect((await svc.listSubscriptionAccountsInternal()).accounts).toMatchObject([{ provider: "antigravity", project_id: "proj-1" }]);
    });
  });

  it("lists the antigravity pool as a gemini source next to the other two in the default status", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "antigravity", AGENTS);
    const status = await svc.getSubscriptionPoolStatus(POOL_TEAM_ID) as { providers: Array<{ provider: string; source: Record<string, unknown> | null }> };
    expect(status.providers.map((p) => p.provider)).toEqual(["claude", "codex", "antigravity"]);
    expect(status.providers[2]!.source).toMatchObject({ source_name: "sub-antigravity", source_provider: "antigravity", source_formats: ["gemini"] });
  });

  it("adds an account while the pool is off and keeps it from the proxy until the pool is on", async () => {
    const { account } = await login();

    const groups = await store.listInstanceUpstreamGroups(undefined, AGENTS);
    const pool = groups.find((group) => group.mode === "subscription_pool");
    expect(pool).toMatchObject({ enabled: false, agents: [] });
    expect(account.group_id).toBe(pool?.group_id);
    expect(groups.find((group) => group.group_type === "default")?.agents).toContain("codex");
    expect((await svc.listSubscriptionAccountsInternal()).accounts).toEqual([]);

    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);

    const enabled = (await store.listInstanceUpstreamGroups(undefined, AGENTS)).filter((group) => group.mode === "subscription_pool");
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toMatchObject({ group_id: pool?.group_id, enabled: true, agents: [] });
    expect((await svc.listSubscriptionAccountsInternal()).accounts).toHaveLength(1);
    const status = await svc.getSubscriptionPoolStatus(POOL_TEAM_ID, "codex") as { providers: Array<{ group_id: string | null; accounts: unknown[] }> };
    expect(status.providers[0]).toMatchObject({ group_id: pool?.group_id });
    expect(status.providers[0].accounts).toHaveLength(1);
  });

  it("creates an account from the pasted redirect url and returns it without tokens", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    const { started, account } = await login();

    expect(adapter.exchangeCode).toHaveBeenCalledWith(expect.objectContaining({ code: "code-1", state: started.state }));
    expect(account).toMatchObject({ provider: "codex", provider_account_id: "acct-9", display_name: "pool@example.com pro", created: true });
    expect(JSON.stringify(account)).not.toMatch(/access-new|refresh-new|access_token|refresh_token/);
    const stored = (await store.listSubscriptionAccounts())[0];
    expect(stored).toMatchObject({ access_token: "access-new", refresh_token: "refresh-new" });
    expect(changes.at(-1)?.account?.account_id).toBe(stored.account_id);
  });

  it("replaces the tokens of the same provider account and keeps its name", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    const { account } = await login();
    await svc.updateSubscriptionAccount(String(account.account_id), { display_name: "Pro A" });
    adapter.exchangeCode.mockResolvedValueOnce(tokens({ providerAccountId: "acct-9", accessToken: "access-2", refreshToken: "refresh-2" }));

    const again = await login();

    expect(again.account).toMatchObject({ account_id: account.account_id, display_name: "Pro A", created: false });
    expect((await store.listSubscriptionAccounts())[0]).toMatchObject({ access_token: "access-2", refresh_token: "refresh-2" });
  });

  it("returns an account that needed a new login to service after the re-login", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    const { account } = await login();
    const id = String(account.account_id);
    await store.updateSubscriptionAccount(id, { status: "auth_error", refresh_fail_count: 2, last_error: "re-login needed" });

    await login();

    expect(await store.getSubscriptionAccount(id)).toMatchObject({ status: "active", refresh_fail_count: 0, last_error: null });
    expect(changes.at(-1)?.account?.status).toBe("active");
  });

  it("keeps an admin switch-off through a re-login", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    const { account } = await login();
    await svc.updateSubscriptionAccount(String(account.account_id), { enabled: false });
    await login();
    expect((await store.getSubscriptionAccount(String(account.account_id)))?.enabled).toBe(false);
  });

  it("uses a login state only once", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    const { started } = await login();
    await expect(svc.completeSubscriptionOAuth({ team_id: POOL_TEAM_ID, provider: "codex", state: started.state, code: "code-1" }, POOL_USER_ID))
      .rejects.toMatchObject({ code: "INVALID_OAUTH_STATE" });
  });

  it("reports a failed code exchange without the provider body", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    adapter.exchangeCode.mockRejectedValueOnce(new SubscriptionProviderError("bad code", true, 400));
    await expect(login(false)).rejects.toMatchObject({ code: "OAUTH_EXCHANGE_FAILED" });
  });

  it("checks usage now and returns the account without tokens", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    const { account } = await login();
    adapter.fetchUsage.mockResolvedValueOnce(usageReading([{ name: "primary_window", model_scope: null, used_pct: 12, resets_at: null, observed_at: 1, source: "usage_api" }]));

    const checked = await svc.checkSubscriptionAccountUsage(String(account.account_id));

    expect(checked).toMatchObject({ account_id: account.account_id, usage: { windows: [expect.objectContaining({ used_pct: 12 })] } });
    expect(JSON.stringify(checked)).not.toContain("access-new");
  });

  describe("redeem reset credit", () => {
    const credits = {
      available: 1, usable_now: 1, note: null, observed_at: 1,
      credits: [{ id: "credit-1", label: "Full reset", remaining: 1, total: null, expires_at: 2, usable_now: true, unavailable_reason: null }],
    };

    it("redeems once, then reads usage again and returns the updated account", async () => {
      await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
      const { account } = await login();
      adapter.fetchUsage.mockClear();
      adapter.fetchUsage.mockResolvedValueOnce(usageReading([], credits));

      const result = await svc.redeemSubscriptionResetCredit(String(account.account_id), "credit-1", "request-12345");

      expect(adapter.redeemResetCredit).toHaveBeenCalledTimes(1);
      expect(adapter.redeemResetCredit).toHaveBeenCalledWith("access-new", "acct-9", { creditId: "credit-1", requestId: "request-12345" });
      expect(adapter.fetchUsage).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ outcome: "reset", reset_applied: true, message: null });
      expect(result.account).toMatchObject({ account_id: account.account_id, reset_credits: credits });
      expect(JSON.stringify(result)).not.toMatch(/access-new|refresh-new/);
    });

    it("refreshes a token that expires within a minute before the call, with no deadlock", async () => {
      await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
      const { account } = await login();
      await store.updateSubscriptionAccount(String(account.account_id), { token_expires_at: Date.now() + 10_000 });
      adapter.refresh.mockResolvedValueOnce(tokens({ accessToken: "access-fresh", expiresAt: Date.now() + 3_600_000 }));

      const result = await Promise.race([
        svc.redeemSubscriptionResetCredit(String(account.account_id), "credit-1", "request-12345"),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("redeem deadlocked")), 2_000)),
      ]);

      expect(adapter.refresh).toHaveBeenCalledTimes(1);
      expect(adapter.redeemResetCredit).toHaveBeenCalledWith("access-fresh", "acct-9", expect.anything());
      expect(result.reset_applied).toBe(true);
    });

    it("does not refresh a token that is valid for more than a minute", async () => {
      await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
      const { account } = await login();
      await svc.redeemSubscriptionResetCredit(String(account.account_id), "credit-1", "request-12345");
      expect(adapter.refresh).not.toHaveBeenCalled();
    });

    it("reports an outcome that did not reset as information, not an error", async () => {
      await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
      const { account } = await login();
      adapter.redeemResetCredit.mockResolvedValueOnce({ outcome: "nothing_to_reset", resetApplied: false, message: null });
      const result = await svc.redeemSubscriptionResetCredit(String(account.account_id), "credit-1", "request-12345");
      expect(result).toMatchObject({ outcome: "nothing_to_reset", reset_applied: false });
    });

    it("fails with a safe message when the provider rejects the redeem", async () => {
      await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
      const { account } = await login();
      adapter.redeemResetCredit.mockRejectedValueOnce(new SubscriptionProviderError("credit not found", false, 404));
      await expect(svc.redeemSubscriptionResetCredit(String(account.account_id), "credit-1", "request-12345"))
        .rejects.toMatchObject({ code: "RESET_CREDIT_REDEEM_FAILED", message: expect.stringContaining("credit not found") });

      adapter.redeemResetCredit.mockRejectedValueOnce(new Error("socket error with access-new"));
      const error = await svc.redeemSubscriptionResetCredit(String(account.account_id), "credit-1", "request-12345").catch((e: unknown) => e) as Error;
      expect(error).toMatchObject({ code: "RESET_CREDIT_REDEEM_FAILED" });
      expect(error.message).not.toContain("access-new");
    });

    it("fails without calling the provider when the token refresh fails", async () => {
      await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
      const { account } = await login();
      await store.updateSubscriptionAccount(String(account.account_id), { token_expires_at: Date.now() + 1_000 });
      adapter.refresh.mockRejectedValueOnce(new SubscriptionProviderError("invalid_grant", true, 400));
      await expect(svc.redeemSubscriptionResetCredit(String(account.account_id), "credit-1", "request-12345"))
        .rejects.toMatchObject({ code: "RESET_CREDIT_REDEEM_FAILED" });
      expect(adapter.redeemResetCredit).not.toHaveBeenCalled();
    });

    it("rejects an unknown account", async () => {
      await expect(svc.redeemSubscriptionResetCredit("sacc-missing", "credit-1", "request-12345"))
        .rejects.toMatchObject({ code: "account_not_found" });
    });
  });

  it("checks usage of every account", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    await login();
    adapter.exchangeCode.mockResolvedValueOnce(tokens({ providerAccountId: "acct-10" }));
    await login();

    const result = await svc.checkAllSubscriptionAccountUsage();

    expect(result).toMatchObject({ checked: 2, failed: 0 });
    // Each login checks usage once, then check-all checks both accounts again.
    expect(adapter.fetchUsage).toHaveBeenCalledTimes(4);
  });

  it("refreshes at once on a proxy 401 and returns the stored token to later callers", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    await login();
    const held = (await store.listSubscriptionAccounts())[0];
    adapter.refresh.mockResolvedValueOnce(tokens({ accessToken: "access-3", expiresAt: Date.now() + 9 * 24 * 3600 * 1000 }));

    const first = await svc.refreshSubscriptionAccount(held.account_id, held.token_expires_at);
    const second = await svc.refreshSubscriptionAccount(held.account_id, held.token_expires_at);

    expect(first.access_token).toBe("access-3");
    expect(second.access_token).toBe("access-3");
    expect(adapter.refresh).toHaveBeenCalledTimes(1);
  });

  it("fails the proxy refresh when the provider refuses the refresh token", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    await login();
    const held = (await store.listSubscriptionAccounts())[0];
    adapter.refresh.mockRejectedValueOnce(new SubscriptionProviderError("refresh_token_reused", true, 401));

    await expect(svc.refreshSubscriptionAccount(held.account_id, held.token_expires_at)).rejects.toMatchObject({ code: "token_refresh_failed" });
    expect((await store.getSubscriptionAccount(held.account_id))?.status).toBe("auth_error");
    expect(changes.at(-1)?.account?.status).toBe("auth_error");
  });

  it("tells the scheduler about reports, updates and deletes", async () => {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    await login();
    const id = (await store.listSubscriptionAccounts())[0].account_id;
    changes = [];

    await svc.reportSubscriptionAccount(id, { status_code: 429 });
    await svc.updateSubscriptionAccount(id, { enabled: false });
    await svc.deleteSubscriptionAccount(id);

    expect(changes.map((change) => change.account?.status ?? null)).toEqual(["active", "active", null]);
    expect(changes[1].account?.enabled).toBe(false);
    expect(changes[2].accountId).toBe(id);
  });
});

describe("subscription pool routes", () => {
  let store: SqliteMetadataStore;
  let svc: MetadataService;

  beforeEach(() => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    svc = new MetadataService(store, "default");
  });

  afterEach(async () => {
    await store.close();
  });

  async function post(userKey: string, body: unknown, action = "status"): Promise<{ status: number; body: { code: number; message: string } }> {
    let status = 0;
    let parsed: { code: number; message: string } = { code: 0, message: "" };
    const handled = await handleV3MetaRoute(
      { headers: { "x-tdai-service-id": "default", "x-tdai-user-key": userKey } } as http.IncomingMessage,
      {} as http.ServerResponse,
      `/v3/meta/subscription-pool/${action}`,
      "POST",
      async () => body,
      (_res, code, payload) => {
        status = code;
        parsed = payload as { code: number; message: string };
      },
      {
        getMetadataService: () => svc,
        logger: {},
        getSupportedAgents: () => AGENTS,
      },
    );
    expect(handled).toBe(true);
    return { status, body: parsed };
  }

  /** One team with an admin, a member and an outsider, plus a System Admin. */
  function seedTeam() {
    store.createUser({ user_id: "usr-owner", username: "owner", auth_provider: "local", external_id: "owner", default_key_value: "owner-key", user_type: "normal" });
    store.createUser({ user_id: "usr-member", username: "member", auth_provider: "local", external_id: "member", default_key_value: "member-key", user_type: "normal" });
    store.createUser({ user_id: "usr-outsider", username: "outsider", auth_provider: "local", external_id: "outsider", default_key_value: "outsider-key", user_type: "normal" });
    store.createUser({ username: "admin", auth_provider: "local", external_id: "admin", default_key_value: "admin-key", user_type: "system_admin" });
    store.createTeam({ team_id: POOL_TEAM_ID, name: "team a", owner_user_id: "usr-owner" });
    store.addTeamMember({ team_id: POOL_TEAM_ID, user_id: "usr-member", role: "member" });
  }

  async function seedPoolWithAccount(): Promise<string> {
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
    const pool = (await store.listInstanceUpstreamGroups()).find((group) => group.mode === "subscription_pool")!;
    const { account } = await store.upsertSubscriptionAccountByProviderId({
      group_id: pool.group_id, provider: "codex", provider_account_id: "acct-private",
      display_name: "Shared account", access_token: "access-secret", refresh_token: "refresh-secret",
      token_expires_at: null,
    });
    return account.account_id;
  }

  it("allows members of the team and system admins to view the team pool", async () => {
    seedTeam();
    await seedPoolWithAccount();

    const member = await post("member-key", { team_id: POOL_TEAM_ID });
    expect(member.status).toBe(200);
    expect(member.body.code).toBe(0);
    expect(JSON.stringify(member.body)).toContain("Shared account");
    expect(JSON.stringify(member.body)).not.toMatch(/access_token|refresh_token|access-secret|refresh-secret/);

    const allowed = await post("admin-key", { team_id: POOL_TEAM_ID });
    expect(allowed.status).toBe(200);
    expect(allowed.body.code).toBe(0);
    expect(JSON.stringify(allowed.body)).toContain("Shared account");
    expect(JSON.stringify(allowed.body)).not.toContain("access_token");
  });

  it("refuses status of a team the caller is not in", async () => {
    seedTeam();
    await seedPoolWithAccount();
    const outsider = await post("outsider-key", { team_id: POOL_TEAM_ID });
    expect(outsider.status).toBe(403);
    expect(JSON.stringify(outsider.body)).not.toContain("Shared account");
    expect((await post("member-key", { team_id: "team-that-does-not-exist" })).status).toBe(403);
    expect((await post("member-key", {})).status).toBe(400);
  });

  it.each(["", "invalid-key"])("rejects unauthenticated status requests (%s)", async (key) => {
    expect((await post(key, { team_id: POOL_TEAM_ID })).status).toBe(401);
  });

  it.each([
    ["enable", { team_id: POOL_TEAM_ID, provider: "codex" }],
    ["disable", { team_id: POOL_TEAM_ID, provider: "codex" }],
    ["clients/update", { team_id: POOL_TEAM_ID, provider: "codex", agents: [] }],
    ["account/oauth-start", { team_id: POOL_TEAM_ID, provider: "codex" }],
    ["account/oauth-complete", { team_id: POOL_TEAM_ID, provider: "codex", state: "test-state", code: "test-code" }],
    ["check-all", { team_id: POOL_TEAM_ID }],
  ])("rejects member mutation %s", async (action, body) => {
    seedTeam();
    const denied = await post("member-key", body, action as string);
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain("permission_denied");
  });

  it.each([
    ["settings/update", { threshold_pct: 90 }],
    ["check-all", {}],
  ])("keeps %s for the system admin only", async (action, body) => {
    seedTeam();
    for (const key of ["member-key", "owner-key"]) {
      const denied = await post(key, body, action as string);
      expect(denied.status).toBe(403);
      expect(denied.body.message).toContain("permission_denied");
    }
  });

  it.each([
    ["account/update", { enabled: false }],
    ["account/delete", {}],
    ["account/check-usage", {}],
    ["account/redeem-reset-credit", { credit_id: "credit-1", request_id: "request-12345" }],
  ])("answers not found to a member on account route %s", async (action, extra) => {
    seedTeam();
    const accountId = await seedPoolWithAccount();
    const denied = await post("member-key", { account_id: accountId, ...extra }, action as string);
    expect(denied.status).toBe(404);
    expect(denied.body.message).toContain("account_not_found");
    expect(await store.getSubscriptionAccount(accountId)).not.toBeNull();
  });

  it("lets the team admin and the system admin manage an account of the team", async () => {
    seedTeam();
    const accountId = await seedPoolWithAccount();
    for (const key of ["owner-key", "admin-key"]) {
      const updated = await post(key, { account_id: accountId, display_name: `by ${key}` }, "account/update");
      expect(updated.status).toBe(200);
    }
    expect((await store.getSubscriptionAccount(accountId))?.display_name).toBe("by admin-key");
  });
});

describe("subscription pool writes that race", () => {
  let store: SqliteMetadataStore;
  let svc: MetadataService;
  let adapter: ReturnType<typeof fakeAdapter>;

  beforeEach(async () => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    svc = new MetadataService(store, "default");
    adapter = fakeAdapter({ exchangeCode: async () => tokens({ providerAccountId: "acct-9", accessToken: "A-login", refreshToken: "R-login" }) });
    svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });
    await svc.enableSubscriptionPool(POOL_TEAM_ID, "codex", AGENTS);
  });

  afterEach(async () => {
    await store.close();
  });

  async function login() {
    const started = svc.startSubscriptionOAuth(POOL_TEAM_ID, "codex", POOL_USER_ID);
    return svc.completeSubscriptionOAuth({ team_id: POOL_TEAM_ID, provider: "codex", state: started.state, code: "c" }, POOL_USER_ID);
  }

  it("keeps a re-login that lands while a refresh is running", async () => {
    await login();
    const id = (await store.listSubscriptionAccounts())[0].account_id;
    let finishRefresh!: () => void;
    adapter.refresh.mockImplementationOnce(() => new Promise((resolve) => {
      finishRefresh = () => resolve(tokens({ accessToken: "A-old-family", refreshToken: "R-old-family" }));
    }));
    adapter.exchangeCode.mockResolvedValueOnce(tokens({ providerAccountId: "acct-9", accessToken: "A-relogin", refreshToken: "R-relogin" }));

    const refreshing = svc.runSubscriptionTokenRefresh(id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const relogin = login();
    await new Promise((resolve) => setTimeout(resolve, 10));
    finishRefresh();
    await Promise.all([refreshing, relogin]);

    expect(await store.getSubscriptionAccount(id)).toMatchObject({ access_token: "A-relogin", refresh_token: "R-relogin" });
  });

  it("does not undo a Panel change with a quota report", async () => {
    await login();
    const id = (await store.listSubscriptionAccounts())[0].account_id;
    await svc.updateSubscriptionAccount(id, { status: "disabled" });
    await svc.reportSubscriptionAccount(id, { active_sessions: 1 });
    expect((await store.getSubscriptionAccount(id))?.status).toBe("disabled");
  });

  it("rejects a malformed redirect url as a bad code", async () => {
    const started = svc.startSubscriptionOAuth(POOL_TEAM_ID, "codex", POOL_USER_ID);
    await expect(svc.completeSubscriptionOAuth({ team_id: POOL_TEAM_ID, provider: "codex", state: started.state, redirect_url: "http://[broken" }, POOL_USER_ID))
      .rejects.toMatchObject({ code: "INVALID_OAUTH_CODE" });
  });

  it("checks only accounts that can serve", async () => {
    await login();
    const id = (await store.listSubscriptionAccounts())[0].account_id;
    await store.updateSubscriptionAccount(id, { status: "auth_error", last_error: "re-login needed" });
    expect(await svc.checkAllSubscriptionAccountUsage()).toEqual({ checked: 0, failed: 0 });
    expect((await store.getSubscriptionAccount(id))?.last_error).toBe("re-login needed");
  });

  it("keeps the write when the scheduler hook throws", async () => {
    svc.setSubscriptionPoolHooks({ onAccountChanged: () => { throw new Error("hook"); } });
    await login();
    const id = (await store.listSubscriptionAccounts())[0].account_id;
    await expect(svc.reportSubscriptionAccount(id, { status_code: 429 })).resolves.toMatchObject({ status: "active" });
  });
});
