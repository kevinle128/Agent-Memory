import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const profile = vi.hoisted(() => ({
  l3: null as { content: string } | null,
  l2: [] as Array<{ path: string; summary?: string }>,
  listL2Calls: 0,
  projectL3: null as { content: string } | null,
  projectL2: [] as Array<{ path: string; summary?: string }>,
  /** Project hash of each client read, in call order; undefined for a user-global read. */
  reads: [] as Array<{ kind: "l3" | "l2"; projectHash?: string }>,
}));

vi.mock("../../../tdai/client.js", () => ({
  TdaiClient: class {
    async readL3ForCtx(_ctx: unknown, projectHash?: string) {
      profile.reads.push({ kind: "l3", projectHash });
      return projectHash ? profile.projectL3 : profile.l3;
    }
    async listL2ForCtx(_ctx: unknown, projectHash?: string) {
      profile.listL2Calls++;
      profile.reads.push({ kind: "l2", projectHash });
      return projectHash ? profile.projectL2 : profile.l2;
    }
  },
}));

import type { TdaiMemoryConfig } from "../../../tdai/types.js";
import type { AgentContext, ContextBlock } from "../../types.js";
import {
  MEMORY_TOOLS_GUIDE,
  MEMORY_TOOLS_GUIDE_PROJECT,
  MEMORY_TOOLS_GUIDE_USER_GLOBAL,
  TdaiProfileMemoryInjector,
  USER_GLOBAL_SCOPE_MARKER,
} from "../tdai-profile-memory-injector.js";

const PROJECT_PERSONA = "# User Narrative Profile\n- Đang làm việc với Agent-Memory, quy trình video Shorts.";
const GLOBAL_PERSONA = `${USER_GLOBAL_SCOPE_MARKER}\n# User Narrative Profile\n- Prefers evidence before conclusions.`;
const PROJECT_SCENES = [{ path: "Agent-Memory-Chay-Local.md", summary: "Agent-Memory local run" }];

const HASH_A = "aaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbb";

function config(mode?: "legacy" | "deny" | "scoped"): TdaiMemoryConfig {
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

function context(projectHash?: string): AgentContext {
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
      custom: {
        session: { session_id: "s1", team_id: "team1", user_id: "u1", agent_id: "agt-1", space_id: "default" },
        ...(projectHash ? { projectHash } : {}),
      },
    },
  } as unknown as AgentContext;
}

const textOf = (blocks: ContextBlock[]) => blocks.map((b) => (b.type === "text" ? b.content : "")).join("\n");

beforeEach(() => {
  profile.l3 = null;
  profile.l2 = [];
  profile.listL2Calls = 0;
  profile.projectL3 = null;
  profile.projectL2 = [];
  profile.reads = [];
});

describe("TdaiProfileMemoryInjector in deny mode", () => {
  it("keeps the deny cache id and ignores a known project", async () => {
    profile.l3 = { content: GLOBAL_PERSONA };
    profile.projectL3 = { content: "PROJECT_FACT" };
    const injector = new TdaiProfileMemoryInjector(config("deny"));

    const out = textOf(await injector.execute(context(HASH_A)));

    expect(injector.cacheVariant).toBe("deny:v2");
    expect(injector.cacheVariantFor({ projectHash: HASH_A })).toBe("deny:v2");
    expect(out).not.toContain("PROJECT_FACT");
    expect(profile.reads.every((r) => r.projectHash === undefined)).toBe(true);
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

describe("USER_GLOBAL_SCOPE_MARKER", () => {
  it("is the same string that the MemoryCore persona generator writes", () => {
    const core = readFileSync(
      new URL("../../../../../MemoryCore/src/core/persona/user-global-scope.ts", import.meta.url),
      "utf-8",
    );
    expect(core).toContain(`export const USER_GLOBAL_SCOPE_MARKER = "${USER_GLOBAL_SCOPE_MARKER}";`);
  });
});

describe("TdaiProfileMemoryInjector in scoped mode", () => {
  it("is the default when the config has no profileScopeMode", () => {
    const injector = new TdaiProfileMemoryInjector(config());

    expect(injector.cacheVariant).toBe("scoped:v1:none");
    expect(injector.cacheVariantFor({ projectHash: HASH_A })).toBe(`scoped:v1:${HASH_A}`);
    expect(injector.cacheVariantFor(undefined)).toBe("scoped:v1:none");
  });

  it("ignores a malformed project hash in the cache id and the reads", async () => {
    profile.l3 = { content: GLOBAL_PERSONA };
    const injector = new TdaiProfileMemoryInjector(config("scoped"));

    expect(injector.cacheVariantFor({ projectHash: "../../etc" })).toBe("scoped:v1:none");
    await injector.execute({ ...context(), metadata: { ...context().metadata, custom: { ...context().metadata.custom, projectHash: "../../etc" } } });
    expect(profile.reads.every((r) => r.projectHash === undefined)).toBe(true);
  });

  it.each([
    ["a persona with the marker", { content: GLOBAL_PERSONA }],
    ["a persona without the marker", { content: PROJECT_PERSONA }],
    ["no persona", null],
  ])("renders the same text as deny without a project, with %s", async (_name, l3) => {
    profile.l3 = l3;
    profile.l2 = PROJECT_SCENES;
    profile.projectL3 = { content: "PROJECT_FACT" };
    profile.projectL2 = [{ path: "work.md", summary: "PROJECT_SCENE" }];

    const scoped = await new TdaiProfileMemoryInjector(config("scoped")).execute(context());
    const deny = await new TdaiProfileMemoryInjector(config("deny")).execute(context());

    expect(textOf(scoped)).toBe(textOf(deny));
    expect(scoped[0].metadata?.scope).toMatchObject({ mode: "scoped" });
    expect(scoped[0].metadata?.scope).not.toHaveProperty("projectHash");
    expect(profile.reads.every((r) => r.projectHash === undefined)).toBe(true);
  });

  it("injects the global persona, the project persona and the project scene index in labeled blocks", async () => {
    profile.l3 = { content: GLOBAL_PERSONA };
    profile.projectL3 = { content: "Project persona: runs MemoryProxy tests." };
    profile.projectL2 = [{ path: "work.md", summary: "local run" }, { path: "notes/deep.md" }];
    profile.l2 = [{ path: "root-habits.md", summary: "ROOT_SCENE" }];

    const blocks = await new TdaiProfileMemoryInjector(config("scoped")).execute(context(HASH_A));
    const out = textOf(blocks);

    const globalAt = out.indexOf("\n<user_global_memory>\n");
    const projectAt = out.indexOf("\n<project_memory ");
    expect(globalAt).toBeGreaterThan(-1);
    expect(projectAt).toBeGreaterThan(globalAt);
    expect(out.slice(globalAt, projectAt)).toContain("Prefers evidence before conclusions.");
    expect(out.slice(globalAt, projectAt)).not.toContain("Project persona");
    expect(out).not.toContain(USER_GLOBAL_SCOPE_MARKER);
    const projectPart = out.slice(projectAt, out.indexOf("\n</project_memory>"));
    expect(projectPart).toContain('project="aaaaaaaa"');
    expect(projectPart).toContain("Project persona: runs MemoryProxy tests.");
    expect(projectPart).toContain("- `work.md` — local run");
    expect(projectPart).toContain("- `notes/deep.md`");
    expect(out).not.toContain("root-habits.md");
    expect(out).not.toContain(HASH_A);
    expect(out).toContain(MEMORY_TOOLS_GUIDE_PROJECT);
    expect(blocks[0].metadata?.scope).toEqual({
      mode: "scoped",
      scopesInjected: ["global-l3", "project-l3", "project-l2"],
      deniedAgentCount: 0,
      projectHash: HASH_A,
    });
    expect(profile.reads).toContainEqual({ kind: "l3", projectHash: HASH_A });
    expect(profile.reads).toContainEqual({ kind: "l2", projectHash: HASH_A });
    expect(profile.reads).not.toContainEqual({ kind: "l2", projectHash: undefined });
  });

  it("injects the project persona although it has no marker, and denies a global persona without marker", async () => {
    profile.l3 = { content: PROJECT_PERSONA };
    profile.projectL3 = { content: "Project persona without marker." };

    const blocks = await new TdaiProfileMemoryInjector(config("scoped")).execute(context(HASH_A));
    const out = textOf(blocks);

    expect(out).toContain("Project persona without marker.");
    expect(out).not.toContain("\n<user_global_memory>\n");
    expect(out).not.toContain("Agent-Memory");
    expect(blocks[0].metadata?.scope).toMatchObject({
      scopesInjected: ["project-l3"],
      deniedAgentCount: 1,
      deniedReason: "no-user-global-l3",
      projectHash: HASH_A,
    });
  });

  it("injects only the project scene index when the project has no persona", async () => {
    profile.l3 = { content: GLOBAL_PERSONA };
    profile.projectL2 = [{ path: "work.md" }];

    const blocks = await new TdaiProfileMemoryInjector(config("scoped")).execute(context(HASH_A));

    expect(textOf(blocks)).toContain("<l2_scene_index scope=\"project\">");
    expect(blocks[0].metadata?.scope).toMatchObject({ scopesInjected: ["global-l3", "project-l2"] });
  });

  it("adds no project block when the project has no memory", async () => {
    profile.l3 = { content: GLOBAL_PERSONA };

    const scoped = await new TdaiProfileMemoryInjector(config("scoped")).execute(context(HASH_A));
    const deny = await new TdaiProfileMemoryInjector(config("deny")).execute(context());

    expect(textOf(scoped)).toBe(textOf(deny));
    expect(textOf(scoped)).not.toContain("\n<project_memory ");
    expect(scoped[0].metadata?.scope).toMatchObject({ scopesInjected: ["global-l3"], projectHash: HASH_A });
  });

  it("keeps project memory of one project out of another project's blocks", async () => {
    profile.l3 = { content: GLOBAL_PERSONA };
    const injector = new TdaiProfileMemoryInjector(config("scoped"));
    profile.projectL2 = [{ path: "work.md", summary: "of A" }];
    const a = textOf(await injector.execute(context(HASH_A)));
    profile.projectL2 = [];
    const b = textOf(await injector.execute(context(HASH_B)));

    expect(a).toContain("of A");
    expect(b).not.toContain("of A");
    expect(injector.cacheVariantFor({ projectHash: HASH_A })).not.toBe(injector.cacheVariantFor({ projectHash: HASH_B }));
  });

  it("prewarm, which has no project, renders the deny text", async () => {
    profile.l3 = { content: GLOBAL_PERSONA };
    profile.projectL3 = { content: "PROJECT_FACT" };
    const input = {
      keyId: "k1",
      userId: "u1",
      agentSource: "claude-code",
      sessionInfo: { session_id: "s1", team_id: "team1", user_id: "u1", agent_id: "agt-1", space_id: "default" },
      agentDetail: null,
      taskDetail: null,
    } as never;

    const warmed = await new TdaiProfileMemoryInjector(config("scoped")).prewarm(input);
    const deny = await new TdaiProfileMemoryInjector(config("deny")).prewarm(input);

    expect(textOf(warmed)).toBe(textOf(deny));
    expect(textOf(warmed)).not.toContain("PROJECT_FACT");
  });
});
