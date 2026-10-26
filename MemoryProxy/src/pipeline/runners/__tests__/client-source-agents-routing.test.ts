/**
 * codebuddy, workbuddy, dsh and opencode choose a model source by the `<source>/<model>` name,
 * through the real route table. The upstream is a recording fetch. A request without a source
 * prefix must reach the upstream identically with the switch on and off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../../server.js";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../../instance-upstream-cache.js";
import { __primeAccountCacheForTests } from "../../../subscription-pool/account-cache.js";
import type { PoolAccount } from "../../../subscription-pool/types.js";
import {
  installFetch, jsonResponse, makeConfig, resetPoolState, type RecordedCall,
} from "../../../subscription-pool/__tests__/test-harness.js";
import type { ProxyConfig } from "../../../types.js";

const SPACE = "sp-clients";
const NOW = Date.now();
const AGENTS = ["codebuddy", "workbuddy", "dsh", "opencode"];

const defaultRow: InstanceUpstreamRow = {
  group_id: "d", group_type: "default", name: "default", enabled: true, mode: "official",
  agents: [...AGENTS, "claude-code", "codex"], base_url: "", api_key: "", model_id: "",
};
const apiRow = (format: string, name: string, url: string, key: string, agents = AGENTS): InstanceUpstreamRow => ({
  group_id: `grp-${name}`, group_type: "custom", name, agents: [], enabled: true,
  mode: "custom_unified", base_url: url, api_key: key, model_id: "ignored",
  source_name: name, source_provider: "x", source_formats: [format],
  source_agents: agents, source_enabled: true,
  source_models: [{ id: "x-model", enabled: true, available: true }],
});
const chatSource = apiRow("openai-chat", "api-chat", "http://chat-src.test/v1", "chat-key");
const messagesSource = apiRow("anthropic-messages", "api-msg", "http://msg-src.test/v1", "msg-key");
const responsesSource = apiRow("openai-responses", "api-resp", "http://resp-src.test/v1", "resp-key");
const poolSource: InstanceUpstreamRow = {
  group_id: "pool-src", group_type: "custom", name: "codex pool", agents: [], enabled: true,
  mode: "subscription_pool", base_url: "", api_key: "", model_id: "",
  source_name: "sub-openai", source_provider: "codex", source_formats: ["openai-responses"],
  source_agents: AGENTS,
  source_models: [{ id: "x-model", enabled: true, available: true }],
};

const poolAccount: PoolAccount = {
  account_id: "a", group_id: "pool-src", provider: "codex", provider_account_id: "chatgpt-a",
  status: "active", enabled: true, access_token: "token-a", token_expires_at: NOW + 3_600_000,
  usage: { windows: [] }, exhausted_until: null,
};

function prime(rows: InstanceUpstreamRow[]): void {
  __primeCacheForTests(SPACE, rows);
  __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts: [poolAccount] });
}

function configWith(enabled: boolean, agents?: string[]): ProxyConfig {
  const config = makeConfig();
  config.modelSources = { enabled, ...(agents ? { agents } : {}) };
  return config;
}

const completion = (model: string) => ({
  id: "c1", object: "chat.completion", model,
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
const message = (model: string) => ({
  id: "msg", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 1, output_tokens: 1 },
});
const responses = (model: string) => ({
  id: "resp_1", object: "response", model, status: "completed", output: [],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});

const chatBody = (model: string) => ({ model, messages: [{ role: "user", content: "hi" }] });
const messagesBody = (model: string) => ({ model, max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
const responsesBody = (model: string) => ({
  model, stream: false, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
});

function post(config: ProxyConfig, path: string, body: unknown) {
  return createApp(config).request(`/${path.replace(/^\//, "")}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-user-key": "sk-mem-user" },
    body: JSON.stringify(body),
  });
}

function quiet(): void {
  resetPoolState();
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
}

interface Wire { path: (agent: string) => string; body: (model: string) => unknown; reply: (model: string) => unknown; source: InstanceUpstreamRow; url: string; key: string }

const WIRES: Record<string, Wire> = {
  chat: { path: (a) => `${a}/${SPACE}/v1/chat/completions`, body: chatBody, reply: completion, source: chatSource, url: "http://chat-src.test/v1/chat/completions", key: "chat-key" },
  messages: { path: (a) => `${a}/${SPACE}/v1/messages`, body: messagesBody, reply: message, source: messagesSource, url: "http://msg-src.test/v1/messages", key: "msg-key" },
  responses: { path: (a) => `${a}/${SPACE}/v1/responses`, body: responsesBody, reply: responses, source: responsesSource, url: "http://resp-src.test/v1/responses", key: "resp-key" },
};

const CASES: Array<[string, keyof typeof WIRES]> = [
  ["codebuddy", "chat"], ["opencode", "chat"], ["dsh", "chat"], ["dsh", "messages"], ["workbuddy", "responses"],
];

describe("an API source of the client agents", () => {
  beforeEach(quiet);
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  for (const [agent, wireName] of CASES) {
    const wire = WIRES[wireName]!;
    it(`${agent} (${wireName}): goes to the group URL with the group key and the real model, answers with the prefixed model`, async () => {
      prime([defaultRow, wire.source]);
      const { upstreamCalls } = installFetch(() => jsonResponse(wire.reply("x-model")));
      const res = await post(configWith(true), wire.path(agent), wire.body(`${wire.source.source_name}/x-model`));
      expect(res.status).toBe(200);
      const calls = upstreamCalls.filter((c) => c.url.startsWith("http://") && !c.url.includes("core.test"));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(wire.url);
      expect(calls[0]!.headers["authorization"] ?? calls[0]!.headers["x-api-key"]).toContain(wire.key);
      expect(JSON.stringify(calls[0]!.headers)).not.toContain("sk-mem-user");
      expect(JSON.parse(calls[0]!.body).model).toBe("x-model");
      expect((await res.json() as { model: string }).model).toBe(`${wire.source.source_name}/x-model`);
    });

    it(`${agent} (${wireName}): switch off leaves a prefixed model on the old path`, async () => {
      prime([defaultRow, wire.source]);
      const { upstreamCalls } = installFetch(() => jsonResponse(wire.reply("x")));
      await post(configWith(false), wire.path(agent), wire.body(`${wire.source.source_name}/x-model`));
      for (const call of upstreamCalls) expect(call.url).not.toContain("-src.test");
    });

    it(`${agent} (${wireName}): a source the agent may not use answers 400 with no upstream call`, async () => {
      prime([defaultRow, { ...wire.source, source_agents: ["hermes"] }]);
      const { upstreamCalls } = installFetch(() => jsonResponse(wire.reply("x")));
      const res = await post(configWith(true), wire.path(agent), wire.body(`${wire.source.source_name}/x-model`));
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(/model_source_not_allowed|MODEL_SOURCE_NOT_ALLOWED/);
      expect(upstreamCalls).toHaveLength(0);
    });

    it(`${agent} (${wireName}): modelSources.agents without the agent keeps the old path`, async () => {
      prime([defaultRow, wire.source]);
      const { upstreamCalls } = installFetch(() => jsonResponse(wire.reply("x")));
      await post(configWith(true, ["omp"]), wire.path(agent), wire.body(`${wire.source.source_name}/x-model`));
      for (const call of upstreamCalls) expect(call.url).not.toContain("-src.test");
    });

    it(`${agent} (${wireName}): a model without a prefix reaches the upstream identically with the switch on and off`, async () => {
      const run = async (enabled: boolean) => {
        resetPoolState();
        prime([defaultRow, wire.source]);
        const { upstreamCalls } = installFetch(() => jsonResponse(wire.reply("gpt-plain")));
        const res = await post(configWith(enabled), wire.path(agent), wire.body("gpt-plain"));
        const text = await res.text();
        vi.unstubAllGlobals();
        const strip = (calls: RecordedCall[]) => calls.map((c) => ({ ...c, headers: { ...c.headers, "x-request-id": undefined } }));
        return { status: res.status, text, calls: strip(upstreamCalls) };
      };
      const off = await run(false);
      const on = await run(true);
      expect(off.calls.length).toBeGreaterThan(0);
      expect(on).toEqual(off);
    });
  }

  it("workbuddy: compact requests of a source also go to the source", async () => {
    prime([defaultRow, responsesSource]);
    const { upstreamCalls } = installFetch(() => jsonResponse(responses("x-model")));
    const res = await post(configWith(true), `workbuddy/${SPACE}/v1/responses/compact`, responsesBody("api-resp/x-model"));
    expect(res.status).toBe(200);
    expect(upstreamCalls[0]!.url).toBe("http://resp-src.test/v1/responses/compact");
    expect(JSON.parse(upstreamCalls[0]!.body).model).toBe("x-model");
  });

  it("workbuddy: a Codex pool source goes to the ChatGPT backend with the pool account and store false", async () => {
    prime([defaultRow, poolSource]);
    const { upstreamCalls } = installFetch(() => jsonResponse(responses("x-model")));
    const res = await post(configWith(true), `workbuddy/${SPACE}/v1/responses`, responsesBody("sub-openai/x-model"));
    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    const call = upstreamCalls[0]!;
    expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(call.headers["authorization"]).toBe("Bearer token-a");
    expect(call.headers["chatgpt-account-id"]).toBe("chatgpt-a");
    expect(JSON.stringify(call.headers)).not.toContain("sk-mem-user");
    expect(JSON.parse(call.body).model).toBe("x-model");
    expect(JSON.parse(call.body).store).toBe(false);
    expect((await res.json() as { model: string }).model).toBe("sub-openai/x-model");
  });

  it("dsh: a Claude subscription pool source on /v1/messages uses the pool account", async () => {
    const claudePool: InstanceUpstreamRow = {
      ...poolSource, group_id: "pool-claude", source_name: "sub-claude", source_provider: "claude",
      source_formats: ["anthropic-messages"],
    };
    __primeCacheForTests(SPACE, [defaultRow, claudePool]);
    __primeAccountCacheForTests(SPACE, {
      thresholdPct: 95,
      accounts: [{ ...poolAccount, group_id: "pool-claude", provider: "claude", access_token: "token-claude" }],
    });
    const { upstreamCalls } = installFetch(() => jsonResponse(message("x-model")));
    const res = await post(configWith(true), `dsh/${SPACE}/v1/messages`, messagesBody("sub-claude/x-model"));
    expect(res.status).toBe(200);
    expect(upstreamCalls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer token-claude");
  });
});

describe("GET /v1/models of the client agents", () => {
  beforeEach(quiet);
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const get = (config: ProxyConfig, agent: string) => createApp(config).request(`/${agent}/${SPACE}/v1/models`, {
    headers: { "x-tdai-user-key": "sk-mem-user", authorization: "Bearer sk-mem-user" },
  });
  const ids = async (res: Response) => (await res.json() as { data: Array<{ id: string }> }).data.map((m) => m.id);

  for (const agent of AGENTS) {
    it(`${agent}: lists the source models it may use`, async () => {
      prime([defaultRow, chatSource, { ...messagesSource, source_agents: ["omp"] }]);
      installFetch(() => jsonResponse({}));
      const res = await get(configWith(true), agent);
      expect(res.status).toBe(200);
      const list = await ids(res);
      expect(list).toContain("api-chat/x-model");
      expect(list).not.toContain("api-msg/x-model");
    });

    it(`${agent}: lists no source model when the switch is off`, async () => {
      prime([defaultRow, chatSource]);
      installFetch(() => jsonResponse({}));
      expect(await ids(await get(configWith(false), agent))).not.toContain("api-chat/x-model");
    });
  }

  it("claude-code does not list source models", async () => {
    prime([defaultRow, chatSource]);
    installFetch(() => jsonResponse({}));
    expect(await ids(await get(configWith(true), "claude-code"))).not.toContain("api-chat/x-model");
  });
});
