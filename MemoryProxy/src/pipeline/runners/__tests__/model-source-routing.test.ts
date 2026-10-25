/**
 * `<source>/<model>` routing through the real anthropic and openai-chat runners, with the
 * upstream replaced by a recording fetch. Claude Code and Codex requests must reach the upstream
 * identically whether the switch is on or off.
 */
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../../instance-upstream-cache.js";
import { __primeAccountCacheForTests } from "../../../subscription-pool/account-cache.js";
import type { PoolAccount } from "../../../subscription-pool/types.js";
import {
  installFetch, jsonResponse, makeApp, makeConfig, resetPoolState, type RecordedCall,
} from "../../../subscription-pool/__tests__/test-harness.js";
import { withClientFacingModel } from "../../../response-model-mask.js";
import { runAnthropicPipeline } from "../anthropic.js";
import { runOpenaiChatPipeline } from "../openai-chat.js";
import type { ProxyConfig } from "../../../types.js";

const SPACE = "sp-route";
const NOW = Date.now();

const defaultRow: InstanceUpstreamRow = {
  group_id: "d", group_type: "default", name: "default", enabled: true, mode: "official",
  agents: ["hermes", "openclaw", "codex", "codebuddy"], base_url: "", api_key: "", model_id: "",
};
const claudePoolForCode: InstanceUpstreamRow = {
  group_id: "pool-code", group_type: "custom", name: "claude code pool", agents: ["claude-code"], enabled: true,
  mode: "subscription_pool", base_url: "", api_key: "", model_id: "",
};
const apiForBuddy: InstanceUpstreamRow = {
  group_id: "grp-buddy", group_type: "custom", name: "buddy upstream", agents: ["codebuddy"], enabled: true,
  mode: "custom_unified", base_url: "http://buddy.test/v1", api_key: "buddy-key", model_id: "buddy-fixed",
};
const apiSource: InstanceUpstreamRow = {
  group_id: "grp-api", group_type: "custom", name: "deepseek", agents: [], enabled: true,
  mode: "custom_unified", base_url: "http://deepseek.test/v1", api_key: "deepseek-key", model_id: "ignored-fixed",
  source_name: "api-deepseek", source_provider: "deepseek", source_formats: ["openai-chat"],
  source_agents: ["hermes", "openclaw"], source_enabled: true,
  source_models: [{ id: "deepseek-chat", enabled: true, available: true }],
};
const poolSource: InstanceUpstreamRow = {
  group_id: "pool-src", group_type: "custom", name: "claude source pool", agents: [], enabled: true,
  mode: "subscription_pool", base_url: "", api_key: "", model_id: "",
  source_name: "sub-claude", source_provider: "claude", source_formats: ["anthropic-messages"],
  source_agents: ["hermes"],
  source_models: [{ id: "claude-sonnet", enabled: true, available: true }],
};

function account(id: string, group: string): PoolAccount {
  return {
    account_id: id, group_id: group, provider: "claude", provider_account_id: `acct-${id}`,
    status: "active", enabled: true, access_token: `token-${id}`, token_expires_at: NOW + 3_600_000,
    usage: { windows: [] }, exhausted_until: null,
  };
}

function prime(rows: InstanceUpstreamRow[]): void {
  __primeCacheForTests(SPACE, rows);
  __primeAccountCacheForTests(SPACE, {
    thresholdPct: 95,
    accounts: [account("code", "pool-code"), account("src", "pool-src")],
  });
}

function configWith(enabled: boolean): ProxyConfig {
  const config = makeConfig();
  config.modelSources = { enabled };
  return config;
}

/** The harness app plus the routes of the multi-source agents, wrapped like server.ts. */
function appFor(config: ProxyConfig): Hono {
  const app = makeApp(config);
  const messages = withClientFacingModel(runAnthropicPipeline);
  const chat = withClientFacingModel(runOpenaiChatPipeline);
  for (const agent of ["hermes", "openclaw"]) {
    app.post(`/${agent}/:spaceId/v1/messages`, (c) => messages(c, config));
    app.post(`/${agent}/:spaceId/v1/chat/completions`, (c) => chat(c, config));
  }
  return app;
}

const message = (model: string) => ({
  id: "msg", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 1, output_tokens: 1 },
});
const completion = (model: string) => ({
  id: "c1", object: "chat.completion", model,
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

function send(app: Hono, agent: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`/${agent}/${SPACE}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-user-key": "sk-mem-user", ...headers },
    body: JSON.stringify(body),
  });
}

const anthropicBody = (model: string) => ({ model, max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
const chatBody = (model: string) => ({ model, messages: [{ role: "user", content: "hi" }] });

describe("model source routing in the runners", () => {
  beforeEach(() => {
    resetPoolState();
    for (const method of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete process.env.TDAI_PROXY_MAIN_MODEL_FILE; });

  it("hermes with a subscription source goes to api.anthropic.com with the account bearer and shows the prefixed model", async () => {
    prime([defaultRow, claudePoolForCode, poolSource]);
    const { upstreamCalls } = installFetch(() => jsonResponse(message("claude-sonnet")));
    const res = await send(appFor(configWith(true)), "hermes", "v1/messages", anthropicBody("sub-claude/claude-sonnet"));
    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    const call = upstreamCalls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["authorization"]).toBe("Bearer token-src");
    expect(JSON.parse(call.body).model).toBe("claude-sonnet");
    expect(JSON.stringify(call.headers)).not.toContain("sk-mem-user");
    expect((await res.json() as { model: string }).model).toBe("sub-claude/claude-sonnet");
  });

  it("openclaw with an API source goes to the group base URL with the group key and the real model id", async () => {
    prime([defaultRow, apiSource]);
    const { upstreamCalls } = installFetch(() => jsonResponse(completion("deepseek-chat")));
    const res = await send(appFor(configWith(true)), "openclaw", "v1/chat/completions", chatBody("api-deepseek/deepseek-chat"));
    expect(res.status).toBe(200);
    const call = upstreamCalls[0]!;
    expect(call.url).toBe("http://deepseek.test/v1/chat/completions");
    expect(call.headers["authorization"]).toBe("Bearer deepseek-key");
    expect(JSON.parse(call.body).model).toBe("deepseek-chat");
    expect((await res.json() as { model: string }).model).toBe("api-deepseek/deepseek-chat");
  });

  it("a source request is not overwritten by the main model file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "model-source-"));
    try {
      const file = join(dir, "main.json");
      writeFileSync(file, JSON.stringify({ model: "pinned-model" }));
      process.env.TDAI_PROXY_MAIN_MODEL_FILE = file;
      prime([defaultRow, apiSource]);
      const { upstreamCalls } = installFetch(() => jsonResponse(completion("deepseek-chat")));
      await send(appFor(configWith(true)), "openclaw", "v1/chat/completions", chatBody("api-deepseek/deepseek-chat"));
      expect(JSON.parse(upstreamCalls[0]!.body).model).toBe("deepseek-chat");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers 400 model_source_disabled without an upstream call when the pool is off", async () => {
    prime([defaultRow, { ...poolSource, enabled: false }]);
    const { upstreamCalls } = installFetch(() => jsonResponse(message("x")));
    const res = await send(appFor(configWith(true)), "hermes", "v1/messages", anthropicBody("sub-claude/claude-sonnet"));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { type: string } }).error.type).toBe("model_source_disabled");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("answers 400 model_format_mismatch in the envelope of each endpoint, with no upstream call", async () => {
    prime([defaultRow, apiSource, poolSource]);
    const { upstreamCalls } = installFetch(() => jsonResponse(message("x")));
    const app = appFor(configWith(true));
    const anthropic = await send(app, "hermes", "v1/messages", anthropicBody("api-deepseek/deepseek-chat"));
    expect(anthropic.status).toBe(400);
    expect((await anthropic.json() as { error: { type: string } }).error.type).toBe("model_format_mismatch");
    const chat = await send(app, "hermes", "v1/chat/completions", chatBody("sub-claude/claude-sonnet"));
    expect(chat.status).toBe(400);
    expect((await chat.json() as { error_code: string }).error_code).toBe("MODEL_FORMAT_MISMATCH");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("answers 400 model_not_enabled for a model the source does not list", async () => {
    prime([defaultRow, apiSource]);
    const { upstreamCalls } = installFetch(() => jsonResponse(completion("x")));
    const res = await send(appFor(configWith(true)), "openclaw", "v1/chat/completions", chatBody("api-deepseek/other"));
    expect(res.status).toBe(400);
    expect((await res.json() as { error_code: string }).error_code).toBe("MODEL_NOT_ENABLED");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("switch off: a prefixed model takes the old path untouched", async () => {
    prime([defaultRow, apiSource]);
    const { upstreamCalls } = installFetch(() => jsonResponse(completion("x")));
    await send(appFor(configWith(false)), "openclaw", "v1/chat/completions", chatBody("api-deepseek/deepseek-chat"));
    expect(upstreamCalls[0]!.url).toBe("http://global-upstream.test/v1/chat/completions");
    expect(JSON.parse(upstreamCalls[0]!.body).model).toBe("api-deepseek/deepseek-chat");
  });
});

interface Scenario {
  name: string;
  rows: InstanceUpstreamRow[];
  call: (app: Hono) => Promise<Response> | Response;
}

const compactBody = JSON.stringify({ model: "gpt-5", input: [{ type: "message", role: "user", content: [] }] });

const scenarios: Scenario[] = [
  {
    name: "claude-code in a subscription pool",
    rows: [defaultRow, claudePoolForCode, apiSource, poolSource],
    call: (app) => send(app, "claude-code", "v1/messages", anthropicBody("claude-x"), { "x-claude-code-session-id": "s1" }),
  },
  {
    name: "claude-code sending a source-looking model name",
    rows: [defaultRow, claudePoolForCode, apiSource, poolSource],
    call: (app) => send(app, "claude-code", "v1/messages", anthropicBody("sub-claude/claude-sonnet"), { "x-claude-code-session-id": "s2" }),
  },
  {
    name: "codebuddy on a custom group sending a source-looking model name",
    rows: [defaultRow, apiForBuddy, apiSource, poolSource],
    call: (app) => send(app, "codebuddy", "v1/chat/completions", chatBody("api-deepseek/deepseek-chat")),
  },
  {
    name: "codex compact on the official upstream",
    rows: [defaultRow, apiSource, poolSource],
    call: (app) => app.request(`/codex/${SPACE}/v1/responses/compact`, {
      method: "POST",
      headers: { authorization: "Bearer client-key", "content-type": "application/json", "x-tdai-user-key": "sk-mem-user" },
      body: compactBody,
    }),
  },
  {
    name: "openclaw with a model that has no prefix",
    rows: [defaultRow, apiSource, poolSource],
    call: (app) => send(app, "openclaw", "v1/chat/completions", chatBody("gpt-plain")),
  },
];

describe("requests of other agents are identical with the switch on and off", () => {
  beforeEach(() => {
    resetPoolState();
    for (const method of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function run(scenario: Scenario, enabled: boolean): Promise<{ status: number; text: string; calls: RecordedCall[] }> {
    resetPoolState();
    prime(scenario.rows);
    const { upstreamCalls } = installFetch(() => jsonResponse(scenario.name.startsWith("codex") ? { ok: true } : message("claude-x")));
    const res = await scenario.call(appFor(configWith(enabled)));
    const text = await res.text();
    vi.unstubAllGlobals();
    return { status: res.status, text, calls: upstreamCalls };
  }

  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const off = await run(scenario, false);
      const on = await run(scenario, true);
      expect(off.calls.length).toBeGreaterThan(0);
      expect(on.status).toBe(off.status);
      expect(on.text).toBe(off.text);
      const strip = (calls: RecordedCall[]) => calls.map((c) => ({ ...c, headers: { ...c.headers, "x-request-id": undefined } }));
      expect(strip(on.calls)).toEqual(strip(off.calls));
    });
  }
});
