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

  it("renders the deny text in scoped mode without a project", () => {
    expect(renderTdaiMemoryToolsBlock(BASE, "s1", "default", "scoped")).toBe(
      renderTdaiMemoryToolsBlock(BASE, "s1", "default", "deny"),
    );
  });

  it("describes project and user-global scenes in scoped mode with a project", () => {
    const text = renderTdaiMemoryToolsBlock(BASE, "s1", "default", "scoped", true);
    expect(text).toContain("<project_memory>");
    // The text must hold when the project has no memory and no block is rendered.
    expect(text).toContain("if that project has memory");
    expect(text).toContain("if the block is absent, the project has no memory to inject yet");
    expect(text).not.toContain("already injected");
    expect(text).toContain('"scope": "?project|global"');
    expect(text).toContain("it looks for the path in the current project first");
    expect(renderTdaiMemoryToolsBlock(BASE, "s1", "default", "deny", true)).toBe(
      renderTdaiMemoryToolsBlock(BASE, "s1", "default", "deny"),
    );
  });

  it("keeps the earlier text in legacy mode", () => {
    expect(renderTdaiMemoryToolsBlock(BASE, "s1", "default", "legacy")).toContain(
      "The L3 (persona, long-term profile) and the L2 scene index (`<l2_scene_index>`) are already injected into the system prompt, so no query is needed;",
    );
  });
});

describe("TdaiMemoryToolsInjector cacheVariant", () => {
  it("uses a deny variant so text cached in legacy mode is not served", () => {
    expect(new TdaiMemoryToolsInjector({ proxyBaseUrl: BASE, profileScopeMode: "deny" }).cacheVariant).toBe("deny:v2");
  });

  it("uses a scoped variant by default, keyed by whether a project is known", () => {
    const injector = new TdaiMemoryToolsInjector({ proxyBaseUrl: BASE });
    expect(injector.cacheVariant).toBe("scoped:v1:none");
    expect(injector.cacheVariantFor(undefined)).toBe("scoped:v1:none");
    expect(injector.cacheVariantFor({ projectHash: "aaaaaaaaaaaaaaaa" })).toBe("scoped:v1:project");
  });

  it("keeps the bare cache id in legacy mode", () => {
    expect(new TdaiMemoryToolsInjector({ proxyBaseUrl: BASE, profileScopeMode: "legacy" }).cacheVariant).toBeUndefined();
  });
});
