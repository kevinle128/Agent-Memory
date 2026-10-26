import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const verifyUserKey = vi.hoisted(() => vi.fn());
vi.mock("../auth.js", () => ({ verifyUserKey }));

import {
  __primeCacheForTests,
  clearCache,
  type InstanceUpstreamRow,
} from "../instance-upstream-cache.js";
import {
  buildModelsResponse,
  handleHermesShow,
  handleModels,
  handleSourceModel,
} from "../modelsHandler.js";
import type { ProxyConfig } from "../types.js";

const SPACE = "sp-models";

const pricing = {
  models: [{ modelName: "legacy-model" }, { modelName: "shared/one" }],
} as unknown as ProxyConfig["creditPricing"];

function makeConfig(modelSources?: ProxyConfig["modelSources"]): ProxyConfig {
  return {
    creditPricing: pricing,
    costGuard: { enabled: false, options: {} },
    coreSkill: { endpoint: "http://core.test", serviceToken: "t", serviceId: "default", timeoutMs: 1000 },
    instanceUpstream: { cacheTtlSec: 30 },
    modelSources,
  } as unknown as ProxyConfig;
}

function makeApp(config: ProxyConfig): Hono {
  const app = new Hono();
  app.get("/:agent/:spaceId/v1/models", (c) => handleModels(c, config));
  app.get("/:agent/:spaceId/v1/models/:model{.+}", (c, next) => handleSourceModel(c, config, next));
  app.get("/hermes/:spaceId/api/v1/models", (c, next) => (
    config.modelSources?.enabled === true ? handleModels(c, config) : next()
  ));
  app.post("/hermes/:spaceId/api/show", (c, next) => handleHermesShow(c, config, next));
  return app;
}

const apiSource: InstanceUpstreamRow = {
  group_id: "g-api", group_type: "custom", name: "deepseek", agents: [], enabled: true,
  mode: "custom_unified", base_url: "http://api.test/v1", api_key: "secret-key", model_id: "",
  source_name: "api-deepseek", source_provider: "deepseek", source_formats: ["openai-chat"],
  source_agents: ["omp", "hermes"], source_enabled: true,
  source_models: [
    { id: "deepseek-chat", display_name: "DeepSeek Chat", enabled: true, available: true },
    { id: "shared/one", enabled: true, available: true },
    { id: "off-model", enabled: false, available: true },
    { id: "gone-model", enabled: true, available: false },
  ],
};

const poolSource: InstanceUpstreamRow = {
  group_id: "g-pool", group_type: "custom", name: "openai pool", agents: [], enabled: true,
  mode: "subscription_pool", base_url: "", api_key: "", model_id: "",
  source_name: "sub-openai", source_provider: "openai",
  source_formats: ["openai-responses", "openai-chat"],
  source_agents: ["omp", "openclaw"],
  source_models: [{ id: "gpt-6-sol", display_name: "GPT-6 Sol", enabled: true, available: true }],
};

const hiddenSource: InstanceUpstreamRow = {
  ...apiSource, group_id: "g-hidden", name: "hidden", source_name: "api-hidden",
  source_agents: ["openclaw"],
  source_models: [{ id: "only-openclaw", enabled: true, available: true }],
};

const switchedOff: InstanceUpstreamRow = {
  ...apiSource, group_id: "g-off", name: "off", source_name: "api-off", source_enabled: false,
  source_models: [{ id: "m", enabled: true, available: true }],
};

function prime(...rows: InstanceUpstreamRow[]): void {
  clearCache();
  __primeCacheForTests(SPACE, rows);
}

async function get(app: Hono, path: string): Promise<Response> {
  return app.request(path, { headers: { authorization: "Bearer sk-mem-test" } });
}

describe("GET /v1/models", () => {
  beforeEach(() => {
    verifyUserKey.mockReset();
    verifyUserKey.mockResolvedValue({ userId: "u", rejected: false });
    prime(apiSource, poolSource, hiddenSource, switchedOff);
  });
  afterEach(() => clearCache());

  it("lists source models for omp in the documented shape, legacy list after", async () => {
    const res = await get(makeApp(makeConfig({ enabled: true })), `/omp/${SPACE}/v1/models`);
    expect(res.status).toBe(200);
    const body = await res.json() as { object: string; data: Array<Record<string, unknown>> };
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toEqual([
      "api-deepseek/deepseek-chat",
      "api-deepseek/shared/one",
      "sub-openai/gpt-6-sol",
      "legacy-model",
      "shared/one",
    ]);
    expect(body.data[2]).toEqual({
      id: "sub-openai/gpt-6-sol", object: "model", created: 0, owned_by: "sub-openai",
      source: "sub-openai", source_type: "subscription", provider: "openai",
      format: "openai-responses", formats: ["openai-responses", "openai-chat"],
      upstream_model: "gpt-6-sol", display_name: "GPT-6 Sol",
    });
    expect(body.data[0]).toMatchObject({ source_type: "api", provider: "deepseek", format: "openai-chat" });
    expect(JSON.stringify(body)).not.toContain("secret-key");
    for (const m of body.data) expect(m).not.toHaveProperty("status");
  });

  it("hides disabled, unavailable, foreign-agent and switched-off sources", async () => {
    const ids = async (agent: string) => {
      const res = await get(makeApp(makeConfig({ enabled: true })), `/${agent}/${SPACE}/v1/models`);
      return ((await res.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
    };
    const omp = await ids("omp");
    expect(omp).not.toContain("api-deepseek/off-model");
    expect(omp).not.toContain("api-deepseek/gone-model");
    expect(omp).not.toContain("api-hidden/only-openclaw");
    expect(omp).not.toContain("api-off/m");
    expect(await ids("openclaw")).toEqual(["api-hidden/only-openclaw", "sub-openai/gpt-6-sol", "legacy-model", "shared/one"]);
    expect(await ids("hermes")).toEqual(["api-deepseek/deepseek-chat", "api-deepseek/shared/one", "legacy-model", "shared/one"]);
  });

  it("hides pool models while the pool is off and shows them again when it is on", async () => {
    const app = makeApp(makeConfig({ enabled: true }));
    prime(apiSource, { ...poolSource, enabled: false });
    let body = await (await get(app, `/omp/${SPACE}/v1/models`)).json() as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).not.toContain("sub-openai/gpt-6-sol");
    prime(apiSource, poolSource);
    body = await (await get(app, `/omp/${SPACE}/v1/models`)).json() as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toContain("sub-openai/gpt-6-sol");
  });

  it("answers the Hermes api/v1/models alias with the same list", async () => {
    const res = await get(makeApp(makeConfig({ enabled: true })), `/hermes/${SPACE}/api/v1/models`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ id: string }> };
    expect(body.data[0]!.id).toBe("api-deepseek/deepseek-chat");
  });

  it("keeps claude-code and codex byte-identical to the old response, switch on or off", async () => {
    const expected = JSON.stringify(buildModelsResponse(pricing));
    for (const modelSources of [undefined, { enabled: false }, { enabled: true }] as const) {
      for (const agent of ["claude-code", "codex"]) {
        const res = await get(makeApp(makeConfig(modelSources)), `/${agent}/${SPACE}/v1/models`);
        expect(await res.text()).toBe(expected);
      }
    }
  });

  it("returns the old response for omp when the switch is off", async () => {
    const expected = JSON.stringify(buildModelsResponse(pricing));
    for (const modelSources of [undefined, { enabled: false }]) {
      const res = await get(makeApp(makeConfig(modelSources)), `/omp/${SPACE}/v1/models`);
      expect(await res.text()).toBe(expected);
    }
  });

  it("respects the modelSources.agents narrowing", async () => {
    const res = await get(makeApp(makeConfig({ enabled: true, agents: ["hermes"] })), `/omp/${SPACE}/v1/models`);
    expect(await res.text()).toBe(JSON.stringify(buildModelsResponse(pricing)));
  });

  it("answers 401 without a valid user key", async () => {
    verifyUserKey.mockResolvedValue({ userId: "", rejected: true, rejectReason: "invalid user_key" });
    for (const path of [`/omp/${SPACE}/v1/models`, `/omp/${SPACE}/v1/models/api-deepseek/deepseek-chat`]) {
      const res = await get(makeApp(makeConfig({ enabled: true })), path);
      expect(res.status).toBe(401);
    }
  });
});

describe("GET /v1/models/:model", () => {
  beforeEach(() => {
    verifyUserKey.mockReset();
    verifyUserKey.mockResolvedValue({ userId: "u", rejected: false });
    prime(apiSource, poolSource);
  });
  afterEach(() => clearCache());

  it("returns one source entry, including ids that contain a slash", async () => {
    const app = makeApp(makeConfig({ enabled: true }));
    const one = await get(app, `/omp/${SPACE}/v1/models/sub-openai/gpt-6-sol`);
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ id: "sub-openai/gpt-6-sol", source: "sub-openai" });
    const nested = await get(app, `/omp/${SPACE}/v1/models/api-deepseek/shared/one`);
    expect(nested.status).toBe(200);
  });

  it("returns an OpenAI-style 404 for an unknown or hidden model", async () => {
    const res = await get(makeApp(makeConfig({ enabled: true })), `/omp/${SPACE}/v1/models/api-deepseek/off-model`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "model_not_found", param: "model" } });
  });

  it("falls through to the old routing for other agents and when the switch is off", async () => {
    const on = makeApp(makeConfig({ enabled: true }));
    expect((await get(on, `/claude-code/${SPACE}/v1/models/anything`)).status).toBe(404);
    const off = makeApp(makeConfig({ enabled: false }));
    expect((await get(off, `/omp/${SPACE}/v1/models/sub-openai/gpt-6-sol`)).status).toBe(404);
    expect(verifyUserKey).not.toHaveBeenCalled();
  });
});

describe("POST /hermes/:spaceId/api/show", () => {
  it("answers 404 locally when the switch is on", async () => {
    const app = makeApp(makeConfig({ enabled: true }));
    const res = await app.request(`/hermes/${SPACE}/api/show`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "model_not_found" } });
  });

  it("falls through when the switch is off", async () => {
    const app = makeApp(makeConfig({ enabled: false }));
    const res = await app.request(`/hermes/${SPACE}/api/show`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("model_not_found");
  });
});
