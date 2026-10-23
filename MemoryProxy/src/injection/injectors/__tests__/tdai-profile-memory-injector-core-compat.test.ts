import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetProjectEchoWarning } from "../../../tdai/project-echo.js";
import type { TdaiMemoryConfig } from "../../../tdai/types.js";
import type { AgentContext, ContextBlock } from "../../types.js";
import { TdaiProfileMemoryInjector, USER_GLOBAL_SCOPE_MARKER } from "../tdai-profile-memory-injector.js";

const HASH = "aaaaaaaaaaaaaaaa";
const GLOBAL_PERSONA = `${USER_GLOBAL_SCOPE_MARKER}\n# Profile\n- Prefers evidence before conclusions.`;

const config: TdaiMemoryConfig = {
  enabled: true, endpoint: "http://core.test", apiKey: "k", serviceId: "default",
  writeL0: false, recallL1: false, injectL2L3: true, l1Limit: 5, l2Limit: 10, timeoutMs: 1000,
  profileScopeMode: "scoped",
};

function context(projectHash?: string): AgentContext {
  return {
    messages: [], tools: [], requestParams: {},
    metadata: {
      protocol: "anthropic", traceId: "t", keyId: "k", modelId: "m", stream: false, agentSource: "claude-code",
      custom: {
        session: { session_id: "s1", team_id: "team1", user_id: "u1", agent_id: "agt-1", space_id: "default" },
        ...(projectHash ? { projectHash } : {}),
      },
    },
  } as unknown as AgentContext;
}

const textOf = (blocks: ContextBlock[]) => blocks.map((b) => (b.type === "text" ? b.content : "")).join("\n");

/**
 * Fake Core over the real TdaiClient. `echo: false` models a Core that does not
 * know project_hash: it ignores the field and serves the user-global data.
 */
function stubCore(echo: boolean): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { project_hash?: string };
    const project = Boolean(body.project_hash) && echo;
    const extra = project ? { project_hash: body.project_hash } : {};
    if (url.endsWith("/v3/core/read")) {
      return Response.json({ code: 0, data: { content: project ? "PROJECT PERSONA" : GLOBAL_PERSONA, ...extra } });
    }
    if (url.endsWith("/v3/scenario/ls")) {
      return Response.json({ code: 0, data: { entries: [{ path: project ? "work.md" : "root-habits.md" }], total: 1, ...extra } });
    }
    return Response.json({ code: 0, data: {} });
  }));
}

beforeEach(() => {
  resetProjectEchoWarning();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("scoped injection against Core versions", () => {
  it("renders the project block when Core echoes the project hash", async () => {
    stubCore(true);

    const out = textOf(await new TdaiProfileMemoryInjector(config).execute(context(HASH)));

    expect(out).toContain("\n<project_memory ");
    expect(out).toContain("PROJECT PERSONA");
    expect(out).toContain("- `work.md`");
  });

  it("renders the deny output and warns once when Core ignores project_hash", async () => {
    stubCore(false);
    const injector = new TdaiProfileMemoryInjector(config);

    const scoped = await injector.execute(context(HASH));
    await injector.execute(context(HASH));
    const deny = await new TdaiProfileMemoryInjector({ ...config, profileScopeMode: "deny" }).execute(context());

    expect(textOf(scoped)).toBe(textOf(deny));
    expect(textOf(scoped)).not.toContain("<project_memory ");
    expect(textOf(scoped)).not.toContain("root-habits.md");
    expect(scoped[0].metadata?.scope).toMatchObject({ scopesInjected: ["global-l3"], projectHash: HASH });
    const unsupported = vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes("does not support project_hash"));
    expect(unsupported).toHaveLength(1);
  });
});
