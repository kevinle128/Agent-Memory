/**
 * Claude Code requests of an agent in a subscription pool group. The proxy swaps the bearer
 * and adds the OAuth beta. It does not rewrite the body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import { __primeAccountCacheForTests, markAccountExhausted } from "../account-cache.js";
import { installFetch, jsonResponse, makeApp, makeConfig, resetPoolState } from "./test-harness.js";
import type { PoolAccount } from "../types.js";

const SPACE = "sp-claude";
const NOW = Date.now();

const defaultRow: InstanceUpstreamRow = {
  group_id: "d", group_type: "default", name: "default", agents: ["codex"], enabled: true,
  mode: "official", base_url: "", api_key: "", model_id: "",
};
const poolRow: InstanceUpstreamRow = {
  group_id: "pool-claude", group_type: "custom", name: "claude subscription pool", agents: ["claude-code"], enabled: true,
  mode: "subscription_pool", base_url: "", api_key: "", model_id: "",
};

function acct(id: string): PoolAccount {
  return {
    account_id: id, group_id: "pool-claude", provider: "claude", provider_account_id: `acct-${id}`,
    status: "active", enabled: true, access_token: `secret-token-${id}`, token_expires_at: NOW + 3_600_000,
    usage: { windows: [] }, exhausted_until: null,
  };
}

function prime(accounts: PoolAccount[]): void {
  __primeCacheForTests(SPACE, [defaultRow, poolRow]);
  __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts });
}

const message = { id: "msg", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };

function post(headers: Record<string, string>, body: unknown = { model: "claude-x", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }) {
  return makeApp(makeConfig()).request(`/claude-code/${SPACE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-user-key": "sk-mem-user", ...headers },
    body: JSON.stringify(body),
  });
}

describe("claude pool forwarding", () => {
  let logs: string[];
  beforeEach(() => {
    resetPoolState();
    logs = [];
    for (const method of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    }
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("sends the account bearer to api.anthropic.com and keeps the client body", async () => {
    prime([acct("a"), acct("b")]);
    const { upstreamCalls } = installFetch(() => jsonResponse(message));
    const res = await post({
      authorization: "Bearer client-oauth",
      "anthropic-beta": "claude-code-20250219",
      "x-claude-code-session-id": "sess-1",
      "user-agent": "claude-cli/2.1.303",
    });
    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    const call = upstreamCalls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["authorization"]).toBe("Bearer secret-token-a");
    expect(call.headers["x-api-key"]).toBeUndefined();
    expect(call.headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20");
    expect(call.headers["user-agent"]).toBe("claude-cli/2.1.303");
    expect(JSON.parse(call.body)).toMatchObject({ model: "claude-x", messages: [{ role: "user", content: "hi" }] });
    expect(JSON.stringify(call.headers)).not.toContain("sk-mem-user");
    const clientBody = await res.text();
    expect(clientBody).not.toContain("secret-token-a");
    expect(logs.join("\n")).not.toContain("secret-token-a");
  });

  it("keeps a session on its account", async () => {
    prime([acct("a"), acct("b")]);
    const { upstreamCalls } = installFetch(() => jsonResponse(message));
    const app = makeApp(makeConfig());
    for (const session of ["s1", "s1", "s2"]) {
      const res = await app.request(`/claude-code/${SPACE}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tdai-user-key": "sk-mem-user",
          "x-claude-code-session-id": session,
        },
        body: JSON.stringify({ model: "claude-x", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
      });
      await res.text();
    }
    expect(upstreamCalls.map((call) => call.headers["authorization"])).toEqual([
      "Bearer secret-token-a",
      "Bearer secret-token-a",
      "Bearer secret-token-b",
    ]);
  });

  it("uses the new Check now result immediately instead of rejecting from an old cached cooldown", async () => {
    const account = acct("a");
    prime([account]);
    markAccountExhausted(SPACE, account.account_id, Date.now() + 15 * 60_000, Date.now() - 1000);
    const checked = {
      ...account,
      usage: { windows: [{ name: "five_hour", model_scope: null, used_pct: 2, resets_at: Date.now() + 3_600_000, observed_at: Date.now(), source: "usage_api" }] },
    };
    const { upstreamCalls, coreCalls } = installFetch(() => jsonResponse(message), (call) => {
      if (call.url.endsWith("/accounts/list")) return jsonResponse({ code: 0, data: { threshold_pct: 95, accounts: [checked] } });
      return jsonResponse({ code: 0, data: {} });
    });

    const response = await post({ "x-claude-code-session-id": "check-now-session" });

    expect(response.status).toBe(200);
    expect(coreCalls.filter((call) => call.url.endsWith("/accounts/list"))).toHaveLength(1);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.headers.authorization).toBe("Bearer secret-token-a");
  });

  it("keeps Claude session on its account when a 429 resolves on retry", async () => {
    vi.useFakeTimers();
    prime([acct("a"), acct("b")]);
    let n = 0;
    const { upstreamCalls, coreCalls } = installFetch(() => ++n === 1
      ? jsonResponse({ type: "error", error: { type: "rate_limit_error", message: "Error" } }, 429)
      : jsonResponse(message));
    const pending = post({ "x-claude-code-session-id": "s1" });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).status).toBe(200);
    expect(upstreamCalls.map((call) => call.headers.authorization)).toEqual(["Bearer secret-token-a", "Bearer secret-token-a"]);
    expect(coreCalls.some((call) => call.url.endsWith("/check-usage"))).toBe(false);
  });

  it("logs the original 429 and honors Retry-After without exposing credentials", async () => {
    vi.useFakeTimers();
    prime([acct("a"), acct("b")]);
    installFetch((call) => jsonResponse({
      error: { type: "rate_limit_error", message: `Too many requests: ${call.headers["authorization"]}` },
    }, 429, { "request-id": `upstream-${call.headers["authorization"]?.endsWith("a") ? "a" : "b"}`, "retry-after": "60" }));
    const pending = post({ "x-request-id": "client-request" });
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await pending;
    expect(res.status).toBe(429);
    const errors = logs.filter((line) => line.startsWith('[subscription-pool] {'))
      .map((line) => JSON.parse(line.slice('[subscription-pool] '.length)));
    expect(errors).toHaveLength(1);
    expect(errors.map((row) => row.account_id)).toEqual(["a"]);
    expect(errors.map((row) => row.upstream_request_id)).toEqual(["upstream-a"]);
    for (const row of errors) {
      expect(row.request_id).toBe("client-request");
      expect(row.body).toContain("Too many requests");
      expect(row.body).not.toContain("secret-token");
    }
    expect(logs.join("\n")).not.toContain("secret-token-");
  });

  it("does not send a codex account token to Anthropic", async () => {
    __primeCacheForTests(SPACE, [defaultRow, poolRow]);
    __primeAccountCacheForTests(SPACE, {
      thresholdPct: 95,
      accounts: [{ ...acct("codex"), provider: "codex", group_id: "pool-claude" }, acct("a")],
    });
    const { upstreamCalls } = installFetch(() => jsonResponse(message));
    const res = await post({});
    expect(res.status).toBe(200);
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer secret-token-a");
    expect(upstreamCalls[0]!.headers["chatgpt-account-id"]).toBeUndefined();
  });
});
