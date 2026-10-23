import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ metadata: undefined as Record<string, unknown> | undefined }));

vi.mock("../../../injection/index.js", () => ({
  getInjectionPipeline: () => ({
    process: async (body: Record<string, unknown>, metadata: Record<string, unknown>) => {
      captured.metadata = metadata;
      return body;
    },
  }),
}));

import type { ProxyConfig } from "../../../types.js";
import { stageInjectionRunner } from "../injection-runner.js";

const config = { injection: { enabled: true, injectors: ["tdai-profile-memory-injector"] } } as unknown as ProxyConfig;

function run(projectHash?: string) {
  return stageInjectionRunner({
    skip: false, config, body: {}, protocol: "anthropic", messages: [],
    traceId: "t", keyId: "k", modelId: "m", isStream: false, agentSource: "claude-code",
    userId: "u1", spaceId: "space1", sessionKey: "s1", requestPath: "/p",
    sessionInfo: { session_id: "s1" },
    ...(projectHash ? { projectHash } : {}),
  });
}

beforeEach(() => {
  captured.metadata = undefined;
});

describe("stageInjectionRunner project threading", () => {
  it("puts the project hash of the session into metadata.custom", async () => {
    await run("aaaaaaaaaaaaaaaa");
    expect((captured.metadata?.custom as Record<string, unknown>).projectHash).toBe("aaaaaaaaaaaaaaaa");
  });

  it("leaves it out when the session has no known project", async () => {
    await run();
    expect((captured.metadata?.custom as Record<string, unknown>).projectHash).toBeUndefined();
  });
});
