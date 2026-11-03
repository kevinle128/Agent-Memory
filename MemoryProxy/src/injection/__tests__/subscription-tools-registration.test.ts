import { describe, expect, it } from "vitest";
import { getInjectionPipeline } from "../index.js";
import type { HookRegistry } from "../types.js";
import type { ProxyConfig } from "../../types.js";

/** The ids of the hooks that a pipeline built from `config` has registered. */
function hookIds(config: ProxyConfig): string[] {
  const registry = (getInjectionPipeline(config) as unknown as { registry: HookRegistry }).registry;
  return registry.getAll().map((hook) => hook.id);
}

function makeConfig(injectors: string[], port: number): ProxyConfig {
  return {
    server: { host: "127.0.0.1", port },
    injection: { enabled: true, injectors, externalGatewayUrl: "http://gateway.test:8096" },
    tdai: { enabled: false },
    coreSkill: { endpoint: "http://core.test", serviceToken: "svc", timeoutMs: 1000 },
    skillRuntime: { allowLlmWrite: false },
  } as unknown as ProxyConfig;
}

describe("subscription tools registration", () => {
  it("registers the block when only the skill injector is on", () => {
    expect(hookIds(makeConfig(["skill"], 18101))).toContain("subscription-tools-injector");
  });

  it("does not register the block when the injection pipeline has no tool injector", () => {
    expect(hookIds(makeConfig([], 18102))).not.toContain("subscription-tools-injector");
  });
});
