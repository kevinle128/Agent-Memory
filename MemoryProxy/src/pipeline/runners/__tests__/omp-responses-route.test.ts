/**
 * omp, hermes and openclaw on the Responses wire, through the real route table: the routes reach
 * the codex runner as their own agent, model sources work on `openai-responses`, the Responses
 * events carry the prefixed model name, and `/pi/` answers 410. The upstream is a recording fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../../server.js";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../../instance-upstream-cache.js";
import { __primeAccountCacheForTests } from "../../../subscription-pool/account-cache.js";
import type { PoolAccount } from "../../../subscription-pool/types.js";
import {
  installFetch, jsonResponse, makeConfig, resetPoolState, type RecordedCall,
} from "../../../subscription-pool/__tests__/test-harness.js";
import { resolveCodexRunnerAgent } from "../codex.js";
import { joinUrl } from "../../../guard-adapter.js";
import { extractSpaceIdFromPath } from "../../../credit-reporter.js";
import { maskJsonText, maskResponseModel } from "../../../response-model-mask.js";
import type { ProxyConfig } from "../../../types.js";

const SPACE = "sp-omp";
const NOW = Date.now();
const CHATGPT = "https://chatgpt.com/backend-api/codex";

const defaultRow: InstanceUpstreamRow = {
  group_id: "d", group_type: "default", name: "default", enabled: true, mode: "official",
  agents: ["omp", "hermes", "openclaw", "codex"], base_url: "", api_key: "", model_id: "",
};
const apiSource: InstanceUpstreamRow = {
  group_id: "grp-api", group_type: "custom", name: "api", agents: [], enabled: true,
  mode: "custom_unified", base_url: "http://api-src.test/v1", api_key: "group-key", model_id: "ignored",
  source_name: "api-x", source_provider: "x", source_formats: ["openai-responses"],
  source_agents: ["omp"], source_enabled: true,
  source_models: [{ id: "x-model", enabled: true, available: true }],
};
const poolSource: InstanceUpstreamRow = {
  group_id: "pool-src", group_type: "custom", name: "codex pool", agents: [], enabled: true,
  mode: "subscription_pool", base_url: "", api_key: "", model_id: "",
  source_name: "sub-openai", source_provider: "codex", source_formats: ["openai-responses"],
  source_agents: ["omp"],
  source_models: [{ id: "gpt-6-astra", enabled: true, available: true }],
};

function account(id: string): PoolAccount {
  return {
    account_id: id, group_id: "pool-src", provider: "codex", provider_account_id: `chatgpt-${id}`,
    status: "active", enabled: true, access_token: `token-${id}`, token_expires_at: NOW + 3_600_000,
    usage: { windows: [] }, exhausted_until: null,
  };
}

function prime(rows: InstanceUpstreamRow[] = [defaultRow, apiSource, poolSource]): void {
  __primeCacheForTests(SPACE, rows);
  __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts: [account("a"), account("b")] });
}

function configWith(enabled = true): ProxyConfig {
  const config = makeConfig();
  config.modelSources = { enabled };
  return config;
}

const responsesJson = (model: string) => ({
  id: "resp_1", object: "response", model, status: "completed", output: [],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});
const sseEvents = (model: string) =>
  `data: ${JSON.stringify({ type: "response.created", response: { id: "r", model } })}\n\n`
  + `data: ${JSON.stringify({ type: "response.completed", response: { id: "r", model, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`;
const sse = (model: string) =>
  new Response(sseEvents(model), { status: 200, headers: { "content-type": "text/event-stream" } });

function post(path: string, body: unknown, config = configWith(), headers: Record<string, string> = {}) {
  return createApp(config).request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-user-key": "sk-mem-user", ...headers },
    body: JSON.stringify(body),
  });
}

const responsesBody = (model: string, extra: Record<string, unknown> = {}) => ({
  model, stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], ...extra,
});

describe("omp, hermes and openclaw Responses and chat routes", () => {
  beforeEach(() => {
    resetPoolState();
    for (const method of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const suffixes: Array<[string, string]> = [
    ["responses", "/responses"],
    ["v1/responses", "/responses"],
    ["responses/compact", "/responses/compact"],
    ["v1/responses/compact", "/responses/compact"],
  ];
  for (const agent of ["omp", "hermes", "openclaw"]) {
    for (const [suffix, upstreamPath] of suffixes) {
      it(`${agent}: /${suffix} reaches the Responses endpoint of the upstream`, async () => {
        prime();
        const { upstreamCalls } = installFetch(() => jsonResponse(responsesJson("gpt-plain")));
        const res = await post(`/${agent}/${SPACE}/${suffix}`, responsesBody("gpt-plain", { stream: false }));
        expect(res.status).toBe(200);
        // The official upstream is billed, so a credit report follows the model call.
        const modelCalls = upstreamCalls.filter((c) => c.url.startsWith("http://global-upstream.test/"));
        expect(modelCalls).toHaveLength(1);
        expect(modelCalls[0]!.url).toBe(`http://global-upstream.test/v1${upstreamPath}`);
      });
    }

    it(`${agent}: /chat/completions without /v1 reaches the chat runner`, async () => {
      prime();
      const { upstreamCalls } = installFetch(() => jsonResponse({
        id: "c", object: "chat.completion", model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      const res = await post(`/${agent}/${SPACE}/chat/completions`, { model: "m", messages: [{ role: "user", content: "hi" }] });
      expect(res.status).toBe(200);
      expect(upstreamCalls[0]!.url).toBe("http://global-upstream.test/v1/chat/completions");
    });
  }

  it("/proxy/<space>/responses keeps its own handler", async () => {
    prime();
    const { upstreamCalls } = installFetch(() => jsonResponse(responsesJson("m")));
    const res = await post(`/proxy/${SPACE}/responses`, responsesBody("m", { stream: false }));
    expect(res.status).toBe(200);
    expect(upstreamCalls[0]!.url).toBe("http://global-upstream.test/v1/responses");
  });

  it("an API source on openai-responses goes to the group base URL with the group key and the real model", async () => {
    prime();
    const { upstreamCalls } = installFetch(() => jsonResponse(responsesJson("x-model")));
    const res = await post(`/omp/${SPACE}/v1/responses`, responsesBody("api-x/x-model", { stream: false }));
    expect(res.status).toBe(200);
    const call = upstreamCalls[0]!;
    expect(call.url).toBe("http://api-src.test/v1/responses");
    expect(call.headers["authorization"]).toBe("Bearer group-key");
    expect(JSON.parse(call.body).model).toBe("x-model");
    expect(JSON.stringify(call.headers)).not.toContain("sk-mem-user");
    expect((await res.json() as { model: string }).model).toBe("api-x/x-model");
  });

  it("the SSE events carry the prefixed model in response.model", async () => {
    prime();
    installFetch(() => sse("x-model"));
    const res = await post(`/omp/${SPACE}/responses`, responsesBody("api-x/x-model"));
    const text = await res.text();
    expect(text).toContain('"model":"api-x/x-model"');
    expect(text).not.toContain('"model":"x-model"');
  });

  it("a Codex subscription source goes to the ChatGPT backend with the real model and store false", async () => {
    prime();
    const { upstreamCalls } = installFetch(() => sse("gpt-6-astra"));
    const res = await post(`/omp/${SPACE}/v1/responses`, responsesBody("sub-openai/gpt-6-astra", { prompt_cache_key: "s1" }));
    expect((await res.text())).toContain("sub-openai/gpt-6-astra");
    const call = upstreamCalls[0]!;
    expect(call.url).toBe(`${CHATGPT}/responses`);
    expect(call.headers["authorization"]).toMatch(/^Bearer token-/);
    const sent = JSON.parse(call.body) as { model: string; store: boolean };
    expect(sent.model).toBe("gpt-6-astra");
    expect(sent.store).toBe(false);
    expect(JSON.stringify(call.headers)).not.toContain("sk-mem-user");
  });

  it("binds the pool account to prompt_cache_key", async () => {
    prime();
    const { upstreamCalls } = installFetch(() => sse("gpt-6-astra"));
    const accountOf = (c: RecordedCall) => c.headers["authorization"];
    for (const key of ["k1", "k2", "k1"]) {
      await (await post(`/omp/${SPACE}/v1/responses`, responsesBody("sub-openai/gpt-6-astra", { prompt_cache_key: key }))).text();
    }
    const [first, second, third] = upstreamCalls.map(accountOf);
    expect(first).not.toBe(second);
    expect(third).toBe(first);
  });

  it("answers 400 model_not_enabled in an envelope that carries error.type, with no upstream call", async () => {
    prime();
    const { upstreamCalls } = installFetch(() => sse("x"));
    const res = await post(`/omp/${SPACE}/v1/responses`, responsesBody("api-x/other"));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { type: string } }).error.type).toBe("model_not_enabled");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("answers 400 model_source_not_allowed for an agent outside source_agents", async () => {
    prime();
    const { upstreamCalls } = installFetch(() => sse("x"));
    const res = await post(`/hermes/${SPACE}/v1/responses`, responsesBody("api-x/x-model"));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { type: string } }).error.type).toBe("model_source_not_allowed");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("switch off: a prefixed model takes the old path untouched", async () => {
    prime();
    const { upstreamCalls } = installFetch(() => jsonResponse(responsesJson("x")));
    await post(`/omp/${SPACE}/v1/responses`, responsesBody("api-x/x-model", { stream: false }), configWith(false));
    expect(upstreamCalls[0]!.url).toBe("http://global-upstream.test/v1/responses");
    expect(JSON.parse(upstreamCalls[0]!.body).model).toBe("api-x/x-model");
  });

  it("codex never routes a source name, with the switch on", async () => {
    prime([{ ...defaultRow }, { ...apiSource, source_agents: ["omp", "codex"] }]);
    const { upstreamCalls } = installFetch(() => jsonResponse(responsesJson("x")));
    await post(`/codex/${SPACE}/v1/responses`, responsesBody("api-x/x-model", { stream: false }));
    expect(upstreamCalls[0]!.url).toBe("http://global-upstream.test/v1/responses");
    expect(JSON.parse(upstreamCalls[0]!.body).model).toBe("api-x/x-model");
  });

  it("omp does not run the codex-only gates and session-init", async () => {
    prime();
    const config = configWith(true);
    config.sessionInit = { ...(config.sessionInit ?? {}), enabled: true } as typeof config.sessionInit;
    const { upstreamCalls, coreCalls } = installFetch(() => jsonResponse(responsesJson("gpt-plain")));
    const res = await post(
      `/omp/${SPACE}/v1/responses`,
      responsesBody("gpt-plain", { stream: false, prompt_cache_key: "01a16eab-0b03-708d-8d4f-4bba152cad8e" }),
      config,
      { "session-id": "01a16eab-0b03-708d-8d4f-4bba152cad8e" },
    );
    expect(res.status).toBe(200);
    expect(upstreamCalls.filter((c) => c.url.startsWith("http://global-upstream.test/"))).toHaveLength(1);
    expect(coreCalls.filter((c) => /session/i.test(c.url))).toHaveLength(0);
    expect(JSON.stringify(await res.json())).not.toContain("request_user_input");
  });
});

describe("/pi/ is retired", () => {
  beforeEach(() => {
    resetPoolState();
    for (const method of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const cases: Array<[string, string, string]> = [
    ["POST", `/pi/${SPACE}/v1/chat/completions`, `http://localhost/omp/${SPACE}`],
    ["GET", `/pi/${SPACE}/v1/models`, `http://localhost/omp/${SPACE}`],
    ["POST", `/pi/${SPACE}/v1/messages`, `http://localhost/omp/${SPACE}`],
    ["POST", `/pi/${SPACE}/v3/other`, `http://localhost/omp/${SPACE}`],
    ["POST", `/pi/${SPACE}/v3/hook/report`, `http://localhost/omp/${SPACE}`],
    ["POST", "/pi/v1/chat/completions", "http://localhost/omp"],
  ];
  for (const [method, path, newBase] of cases) {
    it(`${method} ${path} answers 410 with the new base URL, no upstream call and no Core call`, async () => {
      prime();
      const { upstreamCalls, coreCalls } = installFetch(() => jsonResponse({}));
      const res = await createApp(configWith(true)).request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify({ model: "m", messages: [] }) : undefined,
      });
      expect(res.status).toBe(410);
      const body = await res.json() as { error: Record<string, string>; detail: { new_base_url: string } };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("agent_route_moved");
      expect(body.error.message).toContain(newBase);
      expect(body.detail.new_base_url).toBe(newBase);
      expect(upstreamCalls).toHaveLength(0);
      expect(coreCalls).toHaveLength(0);
    });
  }

  it("uses the forwarded origin and ignores an unsafe space id", async () => {
    const app = createApp(configWith(true));
    const ok = await app.request(`/pi/${SPACE}/v1/models`, {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "mem.example.com" },
    });
    expect((await ok.json() as { detail: { new_base_url: string } }).detail.new_base_url).toBe(`https://mem.example.com/omp/${SPACE}`);
    const bad = await app.request("/pi/%3Cscript%3E/v1/models");
    expect((await bad.json() as { detail: { new_base_url: string } }).detail.new_base_url).toBe("http://localhost/omp");
  });
});

describe("rename keeps behavior", () => {
  it("resolveCodexRunnerAgent keeps codex for every path but the listed agents", () => {
    expect(resolveCodexRunnerAgent("/codex/s/v1/responses")).toBe("codex");
    expect(resolveCodexRunnerAgent("/proxy/s/responses")).toBe("codex");
    expect(resolveCodexRunnerAgent("/v1/responses")).toBe("codex");
    expect(resolveCodexRunnerAgent("/omp/s/responses")).toBe("omp");
    expect(resolveCodexRunnerAgent("/hermes/s/v1/responses")).toBe("hermes");
    expect(resolveCodexRunnerAgent("/openclaw/s/responses/compact")).toBe("openclaw");
    expect(resolveCodexRunnerAgent("/pi/s/responses")).toBe("codex");
  });

  it("joinUrl maps the omp, hermes and openclaw paths to the upstream endpoint", () => {
    const base = "http://up.test/v1";
    for (const agent of ["omp", "hermes", "openclaw"]) {
      expect(joinUrl(base, `/${agent}/s/responses`)).toBe(`${base}/responses`);
      expect(joinUrl(base, `/${agent}/s/v1/responses`)).toBe(`${base}/responses`);
      expect(joinUrl(base, `/${agent}/s/v1/responses/compact`)).toBe(`${base}/responses/compact`);
      expect(joinUrl(base, `/${agent}/s/v1/messages`)).toBe(`${base}/messages`);
      expect(joinUrl(base, `/${agent}/s/v1/chat/completions`)).toBe(`${base}/chat/completions`);
      expect(joinUrl(base, `/${agent}/s/chat/completions`)).toBe(`${base}/chat/completions`);
    }
  });

  it("extractSpaceIdFromPath knows omp and no longer pi", () => {
    expect(extractSpaceIdFromPath("/omp/sp-1/v1/responses")).toBe("sp-1");
    expect(extractSpaceIdFromPath("/hermes/sp-1/responses")).toBe("sp-1");
    expect(extractSpaceIdFromPath("/pi/sp-1/v1/chat/completions")).toBeNull();
  });

  it("the model mask rewrites response.model of Responses events and leaves other payloads alone", async () => {
    const json = JSON.parse(maskJsonText(JSON.stringify({ type: "response.completed", response: { model: "real", id: "r" } }), "src/real"));
    expect(json.response.model).toBe("src/real");
    expect(maskJsonText(JSON.stringify({ id: "x", output: [] }), "src/real")).toBe(JSON.stringify({ id: "x", output: [] }));
    const masked = await maskResponseModel(sse("real"), "src/real");
    const text = await masked.text();
    expect(text).toContain('"model":"src/real"');
    expect(text).not.toContain('"model":"real"');
  });
});
