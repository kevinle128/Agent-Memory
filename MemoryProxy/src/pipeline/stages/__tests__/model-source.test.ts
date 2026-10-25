import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __primeCacheForTests,
  clearCache,
  resolveForAgent,
  type InstanceUpstreamRow,
} from "../../../instance-upstream-cache.js";
import { DEFAULT_SUPPORTED_AGENTS } from "../../../supported-agents.js";
import { stageModelSource, type ModelSourceInput } from "../model-source.js";

const SPACE = "sp-source";

const defaultRow: InstanceUpstreamRow = {
  group_id: "d", group_type: "default", name: "default", enabled: true, mode: "official",
  agents: DEFAULT_SUPPORTED_AGENTS.map((a) => a.agent_source), base_url: "", api_key: "", model_id: "",
};

const apiSource: InstanceUpstreamRow = {
  group_id: "grp-api", group_type: "custom", name: "deepseek", agents: [], enabled: true,
  mode: "custom_unified", base_url: "http://api.test/v1", api_key: "group-key", model_id: "fixed-model",
  source_name: "api-deepseek", source_provider: "deepseek", source_formats: ["openai-chat"],
  source_agents: ["omp", "hermes"], source_enabled: true,
  source_models: [
    { id: "deepseek-chat", enabled: true, available: true },
    { id: "deepseek/deepseek-v4", enabled: true, available: true },
    { id: "off-model", enabled: false, available: true },
    { id: "gone-model", enabled: true, available: false },
  ],
};

const poolSource: InstanceUpstreamRow = {
  group_id: "grp-pool", group_type: "custom", name: "claude pool", agents: [], enabled: true,
  mode: "subscription_pool", base_url: "", api_key: "", model_id: "",
  source_name: "sub-claude", source_provider: "claude", source_formats: ["anthropic-messages"],
  source_agents: ["hermes"],
  source_models: [{ id: "claude-sonnet", enabled: true, available: true }],
};

function input(overrides: Partial<ModelSourceInput> = {}): ModelSourceInput {
  return {
    config: {
      coreSkill: { endpoint: "http://core.test", serviceToken: "t", serviceId: "default", timeoutMs: 1000 },
      instanceUpstream: { cacheTtlSec: 30 },
      modelSources: { enabled: true },
    },
    agent: "omp",
    spaceId: SPACE,
    format: "openai-chat",
    model: "api-deepseek/deepseek-chat",
    servesPool: false,
    ...overrides,
  } as ModelSourceInput;
}

describe("stageModelSource", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    clearCache();
    __primeCacheForTests(SPACE, [defaultRow, apiSource, poolSource]);
    fetchSpy = vi.fn(async () => { throw new Error("unexpected fetch"); });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => { vi.unstubAllGlobals(); clearCache(); });

  it("matches an API source and returns an override copy with the real model id", async () => {
    const result = await stageModelSource(input());
    expect(result.kind).toBe("matched");
    if (result.kind !== "matched") return;
    expect(result.upstreamModel).toBe("deepseek-chat");
    expect(result.clientModel).toBe("api-deepseek/deepseek-chat");
    expect(result.sourceType).toBe("api");
    expect(result.resolution.kind).toBe("override");
    expect(result.resolution.row.model_id).toBe("deepseek-chat");
    // the cached row keeps its own fixed model id
    expect(apiSource.model_id).toBe("fixed-model");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("splits at the first slash so ids that contain a slash still match", async () => {
    const result = await stageModelSource(input({ model: "api-deepseek/deepseek/deepseek-v4" }));
    expect(result.kind === "matched" && result.upstreamModel).toBe("deepseek/deepseek-v4");
  });

  it("reads the prefix case-insensitively and echoes the name the client sent", async () => {
    const result = await stageModelSource(input({ model: "API-DeepSeek/deepseek-chat" }));
    expect(result.kind).toBe("matched");
    if (result.kind === "matched") expect(result.clientModel).toBe("API-DeepSeek/deepseek-chat");
  });

  it("matches a subscription pool source as a pool resolution", async () => {
    const result = await stageModelSource(input({
      agent: "hermes", format: "anthropic-messages", model: "sub-claude/claude-sonnet", servesPool: true,
    }));
    expect(result.kind).toBe("matched");
    if (result.kind === "matched") {
      expect(result.sourceType).toBe("subscription");
      expect(result.resolution.kind).toBe("pool");
    }
  });

  it("returns none when the switch is off or absent, without reading the cache", async () => {
    for (const modelSources of [{ enabled: false }, undefined]) {
      const i = input();
      (i.config as { modelSources?: unknown }).modelSources = modelSources;
      expect(await stageModelSource(i)).toEqual({ kind: "none" });
    }
  });

  it("returns none for agents that are not multi-source, without any fetch", async () => {
    for (const agent of ["claude-code", "codex", "codebuddy", "workbuddy", "dsh", "opencode", undefined]) {
      expect(await stageModelSource(input({ agent }))).toEqual({ kind: "none" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns none for an agent outside modelSources.agents", async () => {
    const i = input();
    i.config.modelSources = { enabled: true, agents: ["hermes"] };
    expect(await stageModelSource(i)).toEqual({ kind: "none" });
  });

  it("returns none for a model without a slash, an unknown prefix, or a non-string model", async () => {
    expect(await stageModelSource(input({ model: "deepseek-chat" }))).toEqual({ kind: "none" });
    expect(await stageModelSource(input({ model: "unknown-source/deepseek-chat" }))).toEqual({ kind: "none" });
    expect(await stageModelSource(input({ model: "/deepseek-chat" }))).toEqual({ kind: "none" });
    expect(await stageModelSource(input({ model: undefined }))).toEqual({ kind: "none" });
  });

  it("does not treat a passthrough or non-custom group as a source", async () => {
    __primeCacheForTests(SPACE, [
      defaultRow,
      { ...apiSource, mode: "custom_passthrough" },
      { ...poolSource, group_type: "default", source_name: "sub-default" },
    ]);
    expect(await stageModelSource(input())).toEqual({ kind: "none" });
    expect(await stageModelSource(input({ model: "sub-default/x" }))).toEqual({ kind: "none" });
  });

  it("rejects an agent that is not in source_agents", async () => {
    const result = await stageModelSource(input({ agent: "openclaw" }));
    expect(result).toMatchObject({ kind: "error", code: "model_source_not_allowed" });
  });

  it("rejects an API source whose switch is off even if the group is enabled", async () => {
    __primeCacheForTests(SPACE, [defaultRow, { ...apiSource, source_enabled: false }]);
    expect(await stageModelSource(input())).toMatchObject({ kind: "error", code: "model_source_disabled" });
  });

  it("rejects a pool source when the pool is off", async () => {
    __primeCacheForTests(SPACE, [defaultRow, { ...poolSource, enabled: false }]);
    const result = await stageModelSource(input({
      agent: "hermes", format: "anthropic-messages", model: "sub-claude/claude-sonnet", servesPool: true,
    }));
    expect(result).toMatchObject({ kind: "error", code: "model_source_disabled" });
    if (result.kind === "error") expect(result.message).toContain("subscription pool is off");
  });

  it("rejects a format the source does not serve and names the served formats", async () => {
    const result = await stageModelSource(input({ format: "anthropic-messages" }));
    expect(result).toMatchObject({ kind: "error", code: "model_format_mismatch" });
    if (result.kind === "error") expect(result.detail.served_formats).toEqual(["openai-chat"]);
  });

  it("rejects a pool source on a runner that has no pool branch", async () => {
    const result = await stageModelSource(input({
      agent: "hermes", format: "anthropic-messages", model: "sub-claude/claude-sonnet", servesPool: false,
    }));
    expect(result).toMatchObject({ kind: "error", code: "model_format_mismatch" });
  });

  it("rejects models that are disabled, gone, or unknown", async () => {
    for (const model of ["off-model", "gone-model", "never-seen"]) {
      const result = await stageModelSource(input({ model: `api-deepseek/${model}` }));
      expect(result).toMatchObject({ kind: "error", code: "model_not_enabled" });
    }
  });

  it("does not change resolveForAgent for any supported agent when source groups are present", () => {
    const withoutSources = [defaultRow];
    const withSources = [defaultRow, apiSource, poolSource];
    for (const { agent_source } of DEFAULT_SUPPORTED_AGENTS) {
      expect(resolveForAgent(withSources, agent_source)).toEqual(resolveForAgent(withoutSources, agent_source));
    }
  });
});
