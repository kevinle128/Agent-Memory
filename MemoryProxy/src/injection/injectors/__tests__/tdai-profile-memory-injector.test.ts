import { beforeEach, describe, expect, it, vi } from "vitest";

const profile = vi.hoisted(() => ({
  l3: null as { content: string } | null,
  l2: [] as Array<{ path: string; summary?: string }>,
  listL2Calls: 0,
}));

vi.mock("../../../tdai/client.js", () => ({
  TdaiClient: class {
    async readL3ForCtx() {
      return profile.l3;
    }
    async listL2ForCtx() {
      profile.listL2Calls++;
      return profile.l2;
    }
  },
}));

import type { TdaiMemoryConfig } from "../../../tdai/types.js";
import type { AgentContext, ContextBlock } from "../../types.js";
import {
  MEMORY_TOOLS_GUIDE,
  MEMORY_TOOLS_GUIDE_USER_GLOBAL,
  TdaiProfileMemoryInjector,
  USER_GLOBAL_SCOPE_MARKER,
} from "../tdai-profile-memory-injector.js";

const PROJECT_PERSONA = "# User Narrative Profile\n- Đang làm việc với Agent-Memory, quy trình video Shorts.";
const GLOBAL_PERSONA = `${USER_GLOBAL_SCOPE_MARKER}\n# User Narrative Profile\n- Prefers evidence before conclusions.`;
const PROJECT_SCENES = [{ path: "Agent-Memory-Chay-Local.md", summary: "Agent-Memory local run" }];

function config(mode?: "legacy" | "deny"): TdaiMemoryConfig {
  return {
    enabled: true,
    endpoint: "http://core.test",
    apiKey: "test",
    serviceId: "default",
    writeL0: false,
    recallL1: false,
    injectL2L3: true,
    l1Limit: 5,
    l2Limit: 3,
    timeoutMs: 1000,
    ...(mode ? { profileScopeMode: mode } : {}),
  };
}

function context(): AgentContext {
  return {
    messages: [],
    tools: [],
    requestParams: {},
    metadata: {
      protocol: "anthropic",
      traceId: "t1",
      keyId: "k1",
      modelId: "m1",
      stream: false,
      agentSource: "claude-code",
      custom: { session: { session_id: "s1", team_id: "team1", user_id: "u1", agent_id: "agt-1", space_id: "default" } },
    },
  } as unknown as AgentContext;
}

const textOf = (blocks: ContextBlock[]) => blocks.map((b) => (b.type === "text" ? b.content : "")).join("\n");

beforeEach(() => {
  profile.l3 = null;
  profile.l2 = [];
  profile.listL2Calls = 0;
});

describe("TdaiProfileMemoryInjector in deny mode", () => {
  it("is the default when the config has no profileScopeMode", async () => {
    profile.l3 = { content: PROJECT_PERSONA };
    profile.l2 = PROJECT_SCENES;
    const injector = new TdaiProfileMemoryInjector(config());

    const out = textOf(await injector.execute(context()));

    expect(injector.cacheVariant).toBe("deny:v2");
    expect(out).not.toContain("Agent-Memory");
  });

  it("injects only the tools guide when the persona has no user-global marker", async () => {
    profile.l3 = { content: PROJECT_PERSONA };
    profile.l2 = PROJECT_SCENES;

    const blocks = await new TdaiProfileMemoryInjector(config("deny")).execute(context());

    expect(textOf(blocks)).toBe(MEMORY_TOOLS_GUIDE_USER_GLOBAL);
    expect(blocks[0].metadata?.scope).toEqual({
      mode: "deny",
      scopesInjected: [],
      deniedAgentCount: 1,
      deniedReason: "no-user-global-l3",
    });
  });

  it("never lists or loads the L2 scene index", async () => {
    profile.l3 = { content: GLOBAL_PERSONA };
    profile.l2 = PROJECT_SCENES;

    const out = textOf(await new TdaiProfileMemoryInjector(config("deny")).execute(context()));

    expect(out).not.toContain("<l2_scene_index>");
    expect(out).not.toContain("Agent-Memory-Chay-Local.md");
    expect(profile.listL2Calls).toBe(0);
  });

  it("injects a user-global persona without its marker", async () => {
    profile.l3 = { content: GLOBAL_PERSONA };

    const blocks = await new TdaiProfileMemoryInjector(config("deny")).execute(context());
    const out = textOf(blocks);

    expect(out).toContain("Prefers evidence before conclusions.");
    expect(out).not.toContain(USER_GLOBAL_SCOPE_MARKER);
    expect(blocks[0].metadata?.scope).toMatchObject({ mode: "deny", scopesInjected: ["global-l3"] });
  });

  it("uses a tools guide that does not claim an injected L2 index", () => {
    expect(MEMORY_TOOLS_GUIDE_USER_GLOBAL).not.toEqual(MEMORY_TOOLS_GUIDE);
    expect(MEMORY_TOOLS_GUIDE_USER_GLOBAL).not.toContain("L2 场景索引已直接注入");
  });
});

describe("TdaiProfileMemoryInjector in legacy mode", () => {
  it("keeps the bare cache id and injects persona plus L2 index as before", async () => {
    profile.l3 = { content: PROJECT_PERSONA };
    profile.l2 = PROJECT_SCENES;
    const injector = new TdaiProfileMemoryInjector(config("legacy"));

    const out = textOf(await injector.execute(context()));

    expect(injector.cacheVariant).toBeUndefined();
    expect(out).toContain("Agent-Memory");
    expect(out).toContain("Agent-Memory-Chay-Local.md");
    expect(out).toContain(MEMORY_TOOLS_GUIDE);
  });
});
