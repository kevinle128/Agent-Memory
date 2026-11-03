/**
 * The subscription bridge against a mock Core, the real session store, the real binding store
 * (memory storage) and the real Codex runner. Covers the view, the switch, every refusal, and that
 * the bridge writes the same Session Binding that the next pool request reads.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import { __resetSessionStoreForTests, getSessionStore } from "../../session/store.js";
import type { SessionInitState } from "../../session/types.js";
import type { BindingRepo, SessionBinding as IdentityBinding } from "../../db/binding-repo.js";
import { getProxyStorage } from "../../storage/factory.js";
import type { ProxyConfig } from "../../types.js";
import { resetAccountSwitchAccessForTests } from "../account-switch-access.js";
import { markAccountExhausted } from "../account-cache.js";
import { BINDING_TTL_MS, getBinding, rebindSession, sessionBindingKey } from "../binding-store.js";
import { isSessionOnClientLogin, poolSessionKey, resetClientLoginMarkersForTests } from "../pool-request.js";
import { createSubscriptionBridgeHandler } from "../subscription-bridge.js";
import type { PoolAccount, PoolQuotaWindow } from "../types.js";
import { installFetch, jsonResponse, makeApp, makeConfig, resetPoolState, type RecordedCall } from "./test-harness.js";

const SPACE = "sp-pool";
const NOW = Date.now();
const HOUR = 3_600_000;

const defaultRow: InstanceUpstreamRow = {
  group_id: "d", group_type: "default", name: "default", agents: [], enabled: true,
  mode: "official", base_url: "", api_key: "", model_id: "",
};
const codexPoolRow: InstanceUpstreamRow = {
  group_id: "pool-codex", group_type: "custom", name: "Codex pool", agents: ["codex"], enabled: true,
  mode: "subscription_pool", base_url: "", api_key: "", model_id: "",
};
const claudePoolRow: InstanceUpstreamRow = {
  group_id: "pool-claude", group_type: "custom", name: "Claude pool", agents: ["claude-code"], enabled: true,
  mode: "subscription_pool", base_url: "", api_key: "", model_id: "",
};

function win(name: string, used: number, resetsIn: number, scope: string | null = null): PoolQuotaWindow {
  return { name, model_scope: scope, used_pct: used, resets_at: NOW + resetsIn, observed_at: NOW, source: "usage_api" };
}

function acct(id: string, label: string, partial: Partial<PoolAccount> = {}): PoolAccount {
  return {
    account_id: id, group_id: "pool-codex", provider: "codex", provider_account_id: `chatgpt-${id}`,
    display_name: `Plus ${id}`, account_label: label,
    status: "active", enabled: true, access_token: `secret-token-${id}`, token_expires_at: NOW + 5 * HOUR,
    usage: { windows: [win("primary_window", 10, HOUR)] }, exhausted_until: null, ...partial,
  };
}

const ALICE = acct("a", "alice@example.test (plus)");
const BOB = acct("b", "Bob@Example.test (pro)");

let poolAccounts: PoolAccount[];
let coreCalls: RecordedCall[];
let upstreamCalls: RecordedCall[];
let logs: string[];
let config: ProxyConfig;

function coreHandler(call: RecordedCall): Response {
  if (call.url.endsWith("/user/list-by-instance")) {
    const userId = (JSON.parse(call.body) as { user_ids: string[] }).user_ids[0];
    const items = userId === "u-admin" ? [{ user_id: userId, user_type: "system_admin" }] : [];
    return jsonResponse({ code: 0, data: { items, total: items.length, limit: 1, offset: 0 } });
  }
  if (call.url.endsWith("/subscription-pool/accounts/list")) {
    return jsonResponse({ code: 0, data: { threshold_pct: 95, accounts: poolAccounts } });
  }
  return jsonResponse({ code: 0, data: {} });
}

const sse = (): Response =>
  new Response("data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n", {
    status: 200, headers: { "content-type": "text/event-stream" },
  });

async function seedSession(agentSource: string, sessionId: string, userId = "u-admin", spaceId: string | undefined = SPACE): Promise<void> {
  const state: SessionInitState = {
    status: "initialized", keyId: `${agentSource}:${sessionId}`, startedAt: Date.now(), attemptCount: 1,
    sessionInfo: { session_id: sessionId, team_id: "t1", agent_id: "ag1", user_id: userId, space_id: spaceId },
  };
  await getSessionStore().set(`${agentSource}:${sessionId}`, state);
}

function bridge(): Hono {
  const app = new Hono();
  const handler = createSubscriptionBridgeHandler(config);
  app.all("/subscription-bridge/*", (c) => handler(c));
  return app;
}

/** Loose view of a bridge reply. The tests read nested fields that each case checks with matchers. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only reads of JSON fields
type BridgeReply = Record<string, any>;

async function callBridge(
  action: string,
  body: unknown = {},
  headers: Record<string, string> = { "x-conversation-id": "s1", "x-tdai-service-id": SPACE },
): Promise<{ status: number; json: BridgeReply; text: string }> {
  const res = await bridge().request(`/subscription-bridge/v1/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as BridgeReply, text };
}

/** One Codex dialogue turn through the real runner. */
async function codexTurn(sessionId: string, headers: Record<string, string> = {}): Promise<void> {
  const res = await makeApp(config).request(`/codex/${SPACE}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-tdai-user-key": "sk-mem-user",
      authorization: "Bearer chatgpt-own-token", "chatgpt-account-id": "own-acct", "session-id": sessionId, ...headers,
    },
    body: JSON.stringify({ model: "gpt-5-codex", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], stream: true }),
  });
  await res.text();
}

const codexKey = (sessionId: string): string => sessionBindingKey(SPACE, "codex", poolSessionKey(sessionId));

describe("subscription bridge", () => {
  beforeEach(() => {
    resetPoolState();
    resetAccountSwitchAccessForTests();
    resetClientLoginMarkersForTests();
    __resetSessionStoreForTests();
    config = makeConfig();
    poolAccounts = [ALICE, BOB];
    __primeCacheForTests(SPACE, [defaultRow, codexPoolRow, claudePoolRow]);
    logs = [];
    for (const method of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    }
    ({ coreCalls, upstreamCalls } = installFetch(() => sse(), coreHandler));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  describe("current", () => {
    it("shows the bound account", async () => {
      await seedSession("codex", "s1");
      await rebindSession(getProxyStorage(config.storage), codexKey("s1"), "b", Date.now());
      const { status, json } = await callBridge("current");
      expect(status).toBe(200);
      expect(json).toMatchObject({
        code: 0,
        data: {
          provider: "codex", state: "bound",
          account: { account_id: "b", email: "Bob@Example.test", display_name: "Plus b", account_label: "Bob@Example.test (pro)" },
        },
      });
    });

    it("shows no account before the first request", async () => {
      await seedSession("codex", "s1");
      const { status, json } = await callBridge("current");
      expect(status).toBe(200);
      expect(json.data).toEqual({ provider: "codex", state: "unbound", account: null });
      expect(json.message).toContain("No account is bound");
    });

    it("shows no account when the bound account was removed from the pool", async () => {
      await seedSession("codex", "s1");
      await rebindSession(getProxyStorage(config.storage), codexKey("s1"), "gone", Date.now());
      expect((await callBridge("current")).json.data.state).toBe("unbound");
    });

    it("shows own login after the pool fell back to the client login", async () => {
      poolAccounts = [acct("a", "alice@example.test", { status: "exhausted", exhausted_until: NOW + HOUR })];
      await seedSession("codex", "s1");
      await codexTurn("s1");
      expect(upstreamCalls.at(-1)?.headers["chatgpt-account-id"]).toBe("own-acct");
      const { json } = await callBridge("current");
      expect(json.data).toEqual({ provider: "codex", state: "own_login", account: null });
      expect(json.message).toBe("This conversation uses your own login, not the pool.");
    });

    it("uses the Claude pool for a Claude Code session", async () => {
      poolAccounts = [acct("c", "carol@example.test", { group_id: "pool-claude", provider: "claude" }), ALICE];
      await seedSession("claude-code", "s1");
      await rebindSession(getProxyStorage(config.storage), sessionBindingKey(SPACE, "claude", poolSessionKey("s1")), "c", Date.now());
      const { json } = await callBridge("current");
      expect(json.data).toMatchObject({ provider: "claude", state: "bound", account: { email: "carol@example.test" } });
    });

    it("follows the parent conversation for a subagent", async () => {
      await seedSession("codex", "parent-1");
      await rebindSession(getProxyStorage(config.storage), codexKey("parent-1"), "a", Date.now());
      const { json } = await callBridge("current", {}, {
        "x-conversation-id": "child-1", "x-parent-conversation-id": "parent-1", "x-tdai-service-id": SPACE,
      });
      expect(json.data).toMatchObject({ state: "bound", account: { account_id: "a" } });
    });
  });

  describe("switch", () => {
    it("switches and the next pool request uses the new account", async () => {
      await seedSession("codex", "s1");
      await codexTurn("s1");
      expect(upstreamCalls.at(-1)?.headers["chatgpt-account-id"]).toBe("chatgpt-a");

      const { status, json } = await callBridge("switch", { email: "BOB@example.TEST" });
      expect(status).toBe(200);
      expect(json).toEqual({
        code: 0, message: "ok",
        data: {
          provider: "codex", changed: true,
          previous: { email: "alice@example.test" },
          current: { email: "Bob@Example.test", display_name: "Plus b" },
        },
      });

      await codexTurn("s1");
      expect(upstreamCalls.at(-1)?.headers["chatgpt-account-id"]).toBe("chatgpt-b");
      expect(upstreamCalls.at(-1)?.headers["authorization"]).toBe("Bearer secret-token-b");
      expect(logs.some((line) => line.includes("[subscription-bridge] account switch space=sp-pool provider=codex from=a to=b"))).toBe(true);
    });

    it("still lets the pool move the session off the switched account when it runs out of quota", async () => {
      await seedSession("codex", "s1");
      await codexTurn("s1");
      expect((await callBridge("switch", { email: "bob@example.test" })).status).toBe(200);
      await codexTurn("s1");
      expect(upstreamCalls.at(-1)?.headers["chatgpt-account-id"]).toBe("chatgpt-b");

      // The pool does this when a limit error is confirmed for the account.
      markAccountExhausted(SPACE, "b", Date.now() + HOUR);
      await codexTurn("s1");
      expect(upstreamCalls.at(-1)?.headers["chatgpt-account-id"]).toBe("chatgpt-a");
      expect((await getBinding(getProxyStorage(config.storage), codexKey("s1"), Date.now()))?.account_id).toBe("a");
    });

    it("creates a binding when none exists", async () => {
      await seedSession("codex", "s1");
      const { status, json } = await callBridge("switch", { email: "alice@example.test" });
      expect(status).toBe(200);
      expect(json.data).toMatchObject({ changed: true, previous: null, current: { email: "alice@example.test" } });
      const stored = await getBinding(getProxyStorage(config.storage), codexKey("s1"), Date.now());
      expect(stored?.account_id).toBe("a");
    });

    it("keeps created_at and changes nothing when the account is already bound", async () => {
      await seedSession("codex", "s1");
      const storage = getProxyStorage(config.storage);
      await rebindSession(storage, codexKey("s1"), "a", NOW - 1000);
      const { json } = await callBridge("switch", { email: "alice@example.test" });
      expect(json.data).toMatchObject({ changed: false, current: { email: "alice@example.test" } });
      expect((await getBinding(storage, codexKey("s1"), Date.now()))?.last_used_at).toBe(NOW - 1000);

      await callBridge("switch", { email: "bob@example.test" });
      const moved = await getBinding(storage, codexKey("s1"), Date.now());
      expect(moved).toMatchObject({ account_id: "b", created_at: NOW - 1000 });
    });

    it("reports active sessions for the new and old account", async () => {
      await seedSession("codex", "s1");
      const storage = getProxyStorage(config.storage);
      await rebindSession(storage, codexKey("s1"), "a", Date.now());
      await rebindSession(storage, codexKey("other"), "b", Date.now());
      await callBridge("switch", { email: "bob@example.test" });
      await vi.waitFor(() => {
        expect(coreCalls.filter((call) => call.url.endsWith("/subscription-pool/report")).length).toBe(2);
      });
      const reports = coreCalls
        .filter((call) => call.url.endsWith("/subscription-pool/report"))
        .map((call) => JSON.parse(call.body) as Record<string, unknown>);
      expect(reports).toEqual(expect.arrayContaining([
        { account_id: "b", active_sessions: 2 },
        { account_id: "a", active_sessions: 0 },
      ]));
      expect(reports.every((report) => report.windows === undefined)).toBe(true);
    });

    it("moves a session off its own login and clears the mark", async () => {
      poolAccounts = [acct("a", "alice@example.test", { status: "exhausted", exhausted_until: NOW + HOUR })];
      await seedSession("codex", "s1");
      await codexTurn("s1");
      expect(isSessionOnClientLogin(codexKey("s1"), Date.now())).toBe(true);

      poolAccounts = [poolAccounts[0]!, BOB];
      const { json } = await callBridge("switch", { email: "bob@example.test" });
      expect(json.data).toMatchObject({ changed: true, current: { email: "Bob@Example.test" } });
      expect(isSessionOnClientLogin(codexKey("s1"), Date.now())).toBe(false);
      expect((await callBridge("current")).json.data.state).toBe("bound");
    });

    it("refuses a body that is not a JSON object", async () => {
      await seedSession("codex", "s1");
      const res = await bridge().request("/subscription-bridge/v1/switch", {
        method: "POST",
        headers: { "content-type": "application/json", "x-conversation-id": "s1", "x-tdai-service-id": SPACE },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 40001, reason: "invalid_json" });
    });

    it("refuses an unknown email", async () => {
      await seedSession("codex", "s1");
      const { status, json } = await callBridge("switch", { email: "nobody@example.test" });
      expect(status).toBe(404);
      expect(json).toMatchObject({ code: 40401, reason: "account_not_in_pool" });
      expect(json.message).toBe("No codex account with this email is in the pool of this conversation.");
    });

    it("refuses an account of another pool group or provider", async () => {
      poolAccounts = [ALICE, acct("c", "carol@example.test", { group_id: "pool-claude", provider: "claude" })];
      await seedSession("codex", "s1");
      expect((await callBridge("switch", { email: "carol@example.test" })).json.reason).toBe("account_not_in_pool");
    });

    it("refuses an ambiguous email", async () => {
      poolAccounts = [acct("d1", "dup@example.test (plus)"), acct("d2", "DUP@example.test (pro)")];
      await seedSession("codex", "s1");
      const { status, json } = await callBridge("switch", { email: "dup@example.test" });
      expect(status).toBe(409);
      expect(json).toMatchObject({ code: 40901, reason: "account_ambiguous" });
    });

    it.each([
      [{}, "missing"],
      [{ email: "" }, "empty"],
      [{ email: "no-at-sign" }, "without @"],
      [{ email: `${"x".repeat(250)}@e.test` }, "too long"],
      [{ email: 42 }, "not a string"],
    ] as Array<[unknown, string]>)("refuses an invalid email (%o, %s)", async (body) => {
      await seedSession("codex", "s1");
      const { status, json } = await callBridge("switch", body);
      expect(status).toBe(400);
      expect(json).toMatchObject({ code: 40001, reason: "invalid_email" });
    });

    it("refuses an exhausted account with its reset time", async () => {
      const until = NOW + 2 * HOUR;
      poolAccounts = [ALICE, acct("e", "erin@example.test", { status: "exhausted", exhausted_until: until })];
      await seedSession("codex", "s1");
      const { status, json } = await callBridge("switch", { email: "erin@example.test" });
      expect(status).toBe(409);
      expect(json).toMatchObject({
        code: 40901, reason: "account_exhausted",
        data: { resets_at: new Date(until).toISOString(), resets_at_ms: until },
      });
      expect(json.message).toBe(`The account is exhausted until ${new Date(until).toISOString()}.`);
      expect(await getBinding(getProxyStorage(config.storage), codexKey("s1"), Date.now())).toBeNull();
    });

    it("refuses an account above the threshold", async () => {
      poolAccounts = [ALICE, acct("f", "frank@example.test", { usage: { windows: [win("primary_window", 97, HOUR)] } })];
      await seedSession("codex", "s1");
      const { status, json } = await callBridge("switch", { email: "frank@example.test" });
      expect(status).toBe(409);
      expect(json).toMatchObject({
        reason: "account_above_threshold",
        data: { usage_pct: 97, threshold_pct: 95, resets_at_ms: NOW + HOUR, resets_at: new Date(NOW + HOUR).toISOString() },
      });
    });

    it.each([
      [{ enabled: false }, "account_disabled"],
      [{ status: "auth_error" as const }, "account_needs_login"],
    ])("refuses an account that the pool cannot use (%o)", async (partial, reason) => {
      poolAccounts = [ALICE, acct("g", "gina@example.test", partial)];
      await seedSession("codex", "s1");
      const { status, json } = await callBridge("switch", { email: "gina@example.test" });
      expect(status).toBe(409);
      expect(json.reason).toBe(reason);
    });

    it("reads the account list from Core again before a switch", async () => {
      await seedSession("codex", "s1");
      await callBridge("current");
      const before = coreCalls.filter((call) => call.url.endsWith("/accounts/list")).length;
      await callBridge("current");
      expect(coreCalls.filter((call) => call.url.endsWith("/accounts/list")).length).toBe(before);
      await callBridge("switch", { email: "alice@example.test" });
      expect(coreCalls.filter((call) => call.url.endsWith("/accounts/list")).length).toBe(before + 1);
    });
  });

  describe("refusals", () => {
    it("refuses a normal user", async () => {
      await seedSession("codex", "s1", "u-normal");
      for (const action of ["current", "switch"]) {
        const { status, json } = await callBridge(action, { email: "alice@example.test" });
        expect(status).toBe(403);
        expect(json).toMatchObject({ code: 40301, reason: "not_system_admin" });
      }
      expect(await getBinding(getProxyStorage(config.storage), codexKey("s1"), Date.now())).toBeNull();
    });

    it("refuses a session of another client", async () => {
      const repo: BindingRepo = {
        getBinding: async (): Promise<IdentityBinding> => ({ outcome: "initialized", userId: "u-admin", agentSource: "codebuddy" }),
        putBinding: async () => {}, deleteBinding: async () => {}, touchLastSeen: async () => {},
      };
      getSessionStore().setBindingRepo(repo);
      const { status, json } = await callBridge("current");
      expect(status).toBe(409);
      expect(json).toMatchObject({ code: 40901, reason: "not_pool_session" });
    });

    it("refuses a stored session without an agent instead of guessing one", async () => {
      const repo: BindingRepo = {
        getBinding: async (): Promise<IdentityBinding> => ({ outcome: "initialized", userId: "u-admin" }),
        putBinding: async () => {}, deleteBinding: async () => {}, touchLastSeen: async () => {},
      };
      getSessionStore().setBindingRepo(repo);
      expect((await callBridge("current")).json.reason).toBe("not_pool_session");
    });

    it("finds a stored Codex session by the space in the header", async () => {
      const getStored = vi.fn(async (): Promise<IdentityBinding> => ({ outcome: "initialized", userId: "u-admin", agentSource: "codex" }));
      getSessionStore().setBindingRepo({ getBinding: getStored, putBinding: async () => {}, deleteBinding: async () => {}, touchLastSeen: async () => {} });
      const { status, json } = await callBridge("current");
      expect(status).toBe(200);
      expect(json.data.provider).toBe("codex");
      expect(getStored).toHaveBeenCalledWith(SPACE, "s1");
    });

    it("answers 503 when the stored session identity cannot be read", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const failing = vi.fn(async (): Promise<IdentityBinding> => { throw new Error("storage down"); });
      getSessionStore().setBindingRepo({ getBinding: failing, putBinding: async () => {}, deleteBinding: async () => {}, touchLastSeen: async () => {} });
      const { status, json } = await callBridge("current");
      expect(status).toBe(503);
      expect(json).toMatchObject({ code: 50301, reason: "storage_unavailable" });
    });

    it("refuses an agent that the pool does not serve", async () => {
      __primeCacheForTests(SPACE, [defaultRow, codexPoolRow]);
      await seedSession("claude-code", "s1");
      const { status, json } = await callBridge("current");
      expect(status).toBe(409);
      expect(json.reason).toBe("not_pool_session");
    });

    it("refuses when the header names another space than the session", async () => {
      await seedSession("codex", "s1");
      const { status, json } = await callBridge("current", {}, { "x-conversation-id": "s1", "x-tdai-service-id": "sp-other" });
      expect(status).toBe(409);
      expect(json.reason).toBe("not_pool_session");
    });

    it("refuses without a conversation id or a known session", async () => {
      expect((await callBridge("current", {}, { "x-tdai-service-id": SPACE })).json).toMatchObject({ code: 40101, reason: "missing_conversation_id" });
      const unknown = await callBridge("current");
      expect(unknown.status).toBe(401);
      expect(unknown.json.reason).toBe("session_not_initialized");
    });

    it("answers 503 when Core cannot list the accounts", async () => {
      await seedSession("codex", "s1");
      installFetch(() => sse(), (call) => call.url.endsWith("/accounts/list") ? jsonResponse({ code: 500, message: "boom" }, 500) : coreHandler(call));
      const { status, json } = await callBridge("current");
      expect(status).toBe(503);
      expect(json).toMatchObject({ code: 50301, reason: "pool_unavailable" });
    });

    it("checks path, method and content type", async () => {
      await seedSession("codex", "s1");
      const app = bridge();
      expect((await app.request("/subscription-bridge/v1/other", { method: "POST", headers: { "content-type": "application/json" } })).status).toBe(404);
      expect((await app.request("/subscription-bridge/v1/current", { method: "GET" })).status).toBe(405);
      expect((await app.request("/subscription-bridge/v1/current", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    });
  });

  it("never returns access tokens or logs e-mails", async () => {
    await seedSession("codex", "s1");
    const texts = [
      (await callBridge("current")).text,
      (await callBridge("switch", { email: "bob@example.test" })).text,
      (await callBridge("current")).text,
      (await callBridge("switch", { email: "nobody@example.test" })).text,
    ];
    for (const text of texts) {
      expect(text).not.toContain("secret-token");
      expect(text).not.toContain("access_token");
      expect(text).not.toContain("svc-token");
    }
    const logText = logs.join("\n");
    expect(logText).not.toContain("secret-token");
    expect(logText).not.toMatch(/@example\.test/i);
  });

  it("forgets the own-login mark after the binding lifetime", async () => {
    poolAccounts = [acct("a", "alice@example.test", { status: "exhausted", exhausted_until: NOW + HOUR })];
    await seedSession("codex", "s1");
    await codexTurn("s1");
    expect(isSessionOnClientLogin(codexKey("s1"), Date.now())).toBe(true);
    expect(isSessionOnClientLogin(codexKey("s1"), Date.now() + BINDING_TTL_MS + 1)).toBe(false);
  });
});
