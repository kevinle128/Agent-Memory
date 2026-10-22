import { describe, expect, it } from "vitest";

import { TdaiMemoryToolsInjector, renderTdaiMemoryToolsBlock } from "../tdai-tools-injector.js";

const BASE = "http://proxy.test:8096";

describe("renderTdaiMemoryToolsBlock coverage text", () => {
  it("does not claim an injected L2 index in deny mode", () => {
    const text = renderTdaiMemoryToolsBlock(BASE, "s1", "default", "deny");
    expect(text).not.toContain("<l2_scene_index>");
    expect(text).toContain("tdai_scenario_ls");
  });

  it("defaults to the deny text", () => {
    expect(renderTdaiMemoryToolsBlock(BASE, "s1", "default")).not.toContain("<l2_scene_index>");
  });

  it("keeps the earlier text in legacy mode", () => {
    expect(renderTdaiMemoryToolsBlock(BASE, "s1", "default", "legacy")).toContain(
      "L3（persona 长期画像）与 L2 场景索引（`<l2_scene_index>`）已直接注入 system，无需查询；",
    );
  });
});

describe("TdaiMemoryToolsInjector cacheVariant", () => {
  it("uses a deny variant so text cached in legacy mode is not served", () => {
    expect(new TdaiMemoryToolsInjector({ proxyBaseUrl: BASE }).cacheVariant).toBe("deny:v2");
  });

  it("keeps the bare cache id in legacy mode", () => {
    expect(new TdaiMemoryToolsInjector({ proxyBaseUrl: BASE, profileScopeMode: "legacy" }).cacheVariant).toBeUndefined();
  });
});
