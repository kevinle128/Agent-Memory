import { describe, expect, it, vi, afterEach } from "vitest";
import { shouldSkipRequestHeader, preserveRequestQuery } from "../../../common/constants.js";
import { createApp } from "../../../server.js";
import { ANTIGRAVITY_USER_AGENT } from "../antigravity.js";
import { applyPoolAuth } from "../../../subscription-pool/pool-request.js";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../../instance-upstream-cache.js";
import { __primeAccountCacheForTests } from "../../../subscription-pool/account-cache.js";
import type { PoolAccount } from "../../../subscription-pool/types.js";
import { makeConfig as makeBaseConfig, resetPoolState } from "../../../subscription-pool/__tests__/test-harness.js";

function makeConfig() {
  const cfg = makeBaseConfig();
  cfg.upstream.url = "https://api.anthropic.com";
  cfg.upstream.apiKey = "";
  cfg.auth.enabled = false;
  cfg.creditPricing = { models: [] };
  cfg.sessionInit = { enabled: false } as typeof cfg.sessionInit;
  cfg.injection = { enabled: false, injectors: [] } as typeof cfg.injection;
  cfg.hookGate = { enabled: false };
  return cfg;
}

describe("Claude Code request & header preservation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips proxy-internal and reverse-proxy headers while keeping all Claude Code headers", () => {
    // Stripped headers
    for (const h of [
      "host",
      "content-length",
      "transfer-encoding",
      "connection",
      "x-tdai-user-key",
      "X-Tdai-User-Token",
      "x-tdai-service-id",
      "x-memory-mode",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
      "forwarded",
      "via",
      "cf-connecting-ip",
      "cf-ray",
      "x-envoy-external-address",
    ]) {
      expect(shouldSkipRequestHeader(h), `expected ${h} to be stripped`).toBe(true);
    }

    // Preserved Claude Code headers
    for (const h of [
      "user-agent",
      "anthropic-version",
      "anthropic-beta",
      "anthropic-dangerous-direct-browser-access",
      "x-app",
      "x-claude-code-session-id",
      "x-stainless-lang",
      "x-stainless-package-version",
      "x-stainless-os",
      "x-stainless-arch",
      "x-stainless-runtime",
      "x-stainless-runtime-version",
      "x-stainless-retry-count",
      "x-stainless-timeout",
      "accept",
      "content-type",
    ]) {
      expect(shouldSkipRequestHeader(h), `expected ${h} to be preserved`).toBe(false);
    }
  });

  it("preserves ?beta=true query parameters on upstream Anthropic URLs", () => {
    expect(
      preserveRequestQuery(
        "https://api.anthropic.com/v1/messages",
        "http://proxy:8096/claude-code/space1/v1/messages?beta=true",
      ),
    ).toBe("https://api.anthropic.com/v1/messages?beta=true");

    expect(
      preserveRequestQuery(
        "https://api.anthropic.com/v1/messages",
        "http://proxy:8096/claude-code/space1/v1/messages",
      ),
    ).toBe("https://api.anthropic.com/v1/messages");
  });

  it("forwards Claude Code /v1/messages?beta=true without x-vertex-ai-session-id or proxy leaks", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.anthropic.com")) {
        capturedUrl = url;
        capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        capturedBody = typeof init?.body === "string" ? init.body : "";
      }
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const app = createApp(makeConfig());
    const payload = {
      model: "claude-sonnet-4-6",
      max_tokens: 16,
      stream: false,
      system: [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text", text: "# Harness\nRules", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };

    const res = await app.request("http://proxy.local/claude-code/space1/v1/messages?beta=true", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer sk-ant-oat01-client-token",
        "user-agent": "claude-cli/2.1.308 (external, cli)",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
        "x-app": "cli",
        "x-claude-code-session-id": "sess-1234",
        "x-stainless-lang": "js",
        "x-stainless-os": "MacOS",
        // Proxy / reverse-proxy headers that must NOT reach Anthropic
        "x-tdai-user-token": "tdai_secret",
        "x-tdai-user-key": "sk-mem-secret",
        "x-memory-mode": "off",
        "x-forwarded-for": "1.2.3.4",
        "x-real-ip": "1.2.3.4",
        "via": "1.1 nginx",
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages?beta=true");

    // Native Claude Code headers preserved verbatim
    expect(capturedHeaders["user-agent"]).toBe("claude-cli/2.1.308 (external, cli)");
    expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
    expect(capturedHeaders["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14");
    expect(capturedHeaders["x-app"]).toBe("cli");
    expect(capturedHeaders["x-claude-code-session-id"]).toBe("sess-1234");
    expect(capturedHeaders["x-stainless-lang"]).toBe("js");
    expect(capturedHeaders["x-stainless-os"]).toBe("MacOS");

    // No injected or leaked proxy headers
    expect(capturedHeaders["x-vertex-ai-session-id"]).toBeUndefined();
    expect(capturedHeaders["x-tdai-user-token"]).toBeUndefined();
    expect(capturedHeaders["x-tdai-user-key"]).toBeUndefined();
    expect(capturedHeaders["x-memory-mode"]).toBeUndefined();
    expect(capturedHeaders["x-forwarded-for"]).toBeUndefined();
    expect(capturedHeaders["x-real-ip"]).toBeUndefined();
    expect(capturedHeaders["via"]).toBeUndefined();

    // Original body preserved
    expect(JSON.parse(capturedBody)).toEqual(payload);
  });

  it("keeps anthropic-beta verbatim in applyPoolAuth when oauth beta is already present", () => {
    const beta = "claude-code-20250219, oauth-2025-04-20, interleaved-thinking-2025-05-14";
    const out = applyPoolAuth(
      { "anthropic-beta": beta, "user-agent": "claude-cli/2.1.308 (external, cli)" },
      new Headers(),
      { kind: "account", accountId: "a1", accessToken: "tok", providerAccountId: "p1" },
      "claude",
    );
    expect(out["anthropic-beta"]).toBe(beta);
    expect(out["user-agent"]).toBe("claude-cli/2.1.308 (external, cli)");
  });

  it("forwards Codex /responses preserving native headers & query string while stripping proxy headers", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://chatgpt.com")) {
        capturedUrl = url;
        capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      }
      return new Response(
        JSON.stringify({ id: "resp_1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const cfg = makeConfig();
    cfg.upstream.url = "https://chatgpt.com/backend-api/codex";
    const app = createApp(cfg);

    const res = await app.request("http://proxy.local/codex/space1/v1/responses?foo=bar", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer codex-client-token",
        "user-agent": "codex_cli_rs/0.120.0 (Mac OS 15.4.0; arm64)",
        "originator": "codex_cli_rs",
        "openai-beta": "responses=experimental",
        "session_id": "codex-sess-1",
        "chatgpt-account-id": "acct-123",
        // Proxy / reverse-proxy headers that must be stripped
        "x-tdai-user-token": "tdai_secret",
        "x-tdai-user-key": "sk-mem-secret",
        "x-memory-mode": "off",
        "x-forwarded-for": "1.2.3.4",
        "via": "1.1 nginx",
      },
      body: JSON.stringify({ model: "gpt-5.4", stream: false, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }),
    });

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/responses?foo=bar");
    expect(capturedHeaders["user-agent"]).toBe("codex_cli_rs/0.120.0 (Mac OS 15.4.0; arm64)");
    expect(capturedHeaders["originator"]).toBe("codex_cli_rs");
    expect(capturedHeaders["openai-beta"]).toBe("responses=experimental");
    expect(capturedHeaders["session_id"]).toBe("codex-sess-1");
    expect(capturedHeaders["chatgpt-account-id"]).toBe("acct-123");
    expect(capturedHeaders["x-tdai-user-token"]).toBeUndefined();
    expect(capturedHeaders["x-tdai-user-key"]).toBeUndefined();
    expect(capturedHeaders["x-memory-mode"]).toBeUndefined();
    expect(capturedHeaders["x-forwarded-for"]).toBeUndefined();
    expect(capturedHeaders["via"]).toBeUndefined();
  });

  it("forwards AntiGravity client headers and query params with the fixed user agent and without conflicting credentials", async () => {
    resetPoolState();
    const space = "sp-agy-preserve";
    const poolRow: InstanceUpstreamRow = {
      group_id: "pool-agy", group_type: "custom", name: "AGY pool", agents: ["antigravity"], enabled: true,
      mode: "subscription_pool", base_url: "", api_key: "", model_id: "",
    };
    const account: PoolAccount = {
      account_id: "a1", group_id: "pool-agy", provider: "antigravity", provider_account_id: "g-a1",
      project_id: "proj-a1", status: "active", enabled: true, access_token: "agy-oauth-token",
      token_expires_at: Date.now() + 3_600_000, usage: { windows: [] }, exhausted_until: null,
    };
    __primeCacheForTests(space, [poolRow]);
    __primeAccountCacheForTests(space, { thresholdPct: 95, accounts: [account] });

    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://daily-cloudcode-pa.googleapis.com")) {
        capturedUrl = url;
        capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      }
      return new Response(
        JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const app = createApp(makeConfig());
    const res = await app.request(
      `http://proxy.local/antigravity/${space}/sk-mem-key/v1beta/models/gemini-3.8-flash:generateContent?trace=1`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "antigravity/cli/2.0.0 (aidev_client; os_type=darwin; arch=arm64)",
          "x-goog-api-client": "gl-node/22.0.0",
          // Client headers that conflict with the pool account or that the proxy owns
          "x-goog-api-key": "client-api-key",
          "x-goog-user-project": "client-project",
          "cookie": "sid=client",
          "accept-encoding": "zstd",
          // Proxy / reverse-proxy headers that must be stripped
          "x-tdai-user-token": "tdai_secret",
          "x-forwarded-for": "1.2.3.4",
          "cf-connecting-ip": "1.2.3.4",
          "via": "1.1 nginx",
        },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      },
    );

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent?trace=1");
    expect(capturedHeaders["authorization"]).toBe("Bearer agy-oauth-token");
    expect(capturedHeaders["user-agent"]).toBe(ANTIGRAVITY_USER_AGENT);
    expect(capturedHeaders["x-goog-api-client"]).toBe("gl-node/22.0.0");
    expect(capturedHeaders["x-tdai-user-token"]).toBeUndefined();
    expect(capturedHeaders["x-forwarded-for"]).toBeUndefined();
    expect(capturedHeaders["cf-connecting-ip"]).toBeUndefined();
    expect(capturedHeaders["via"]).toBeUndefined();
    expect(capturedHeaders["x-goog-api-key"]).toBeUndefined();
    expect(capturedHeaders["x-goog-user-project"]).toBeUndefined();
    expect(capturedHeaders["cookie"]).toBeUndefined();
    expect(capturedHeaders["accept-encoding"]).toBeUndefined();
  });
});
