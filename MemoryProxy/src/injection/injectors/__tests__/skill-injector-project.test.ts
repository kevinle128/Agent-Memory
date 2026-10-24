import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetProjectEchoWarning } from "../../../tdai/project-echo.js";
import type { CoreSkillClient, ListingInput, ListingResult } from "../../../skill/core-client.js";
import type { CoreSkillConfig } from "../../../types.js";
import type { AgentContext, PrewarmInput } from "../../types.js";
import { SkillInjector } from "../skill-injector.js";

const HASH = "aaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbb";
const LISTING = "<available_skills>\n- id=skl-1, name=one, desc=first\n</available_skills>";

const coreSkill = { endpoint: "http://core.test", serviceToken: "t", serviceId: "default", timeoutMs: 1000 } as CoreSkillConfig;

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

/** Core stub. `honor` models a Core that applies the view and echoes it. */
function stubClient(honor: boolean): { client: CoreSkillClient; calls: ListingInput[] } {
  const calls: ListingInput[] = [];
  const client = {
    listListing: vi.fn(async (input: ListingInput): Promise<ListingResult> => {
      calls.push(input);
      return {
        mode: "full", listing: LISTING, hits: [{ skill_id: "skl-1", version: 1, name: "one" }],
        ...(honor && input.project_hash ? { project_hash: input.project_hash } : {}),
        ...(honor && input.scope_filter ? { scope_filter: input.scope_filter } : {}),
      };
    }),
  } as unknown as CoreSkillClient;
  return { client, calls };
}

beforeEach(() => {
  resetProjectEchoWarning();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("SkillInjector project view", () => {
  it("asks for the project of the session and injects the catalog", async () => {
    const { client, calls } = stubClient(true);
    const blocks = await new SkillInjector({ coreSkill, profileScopeMode: "scoped" }, client).execute(context(HASH));
    expect(calls[0]).toMatchObject({ project_hash: HASH });
    expect(calls[0]).not.toHaveProperty("scope_filter");
    expect(blocks).toHaveLength(1);
  });

  it("asks for global skills only when the session has no project", async () => {
    const { client, calls } = stubClient(true);
    const blocks = await new SkillInjector({ coreSkill }, client).execute(context());
    expect(calls[0]).toMatchObject({ scope_filter: "global_only" });
    expect(calls[0]).not.toHaveProperty("project_hash");
    expect(blocks).toHaveLength(1);
  });

  it("asks for global skills only at prewarm, where no project is known", async () => {
    const { client, calls } = stubClient(true);
    const input = {
      sessionInfo: { team_id: "team1", agent_id: "agt-1", space_id: "default", session_id: "s1" },
    } as unknown as PrewarmInput;
    await new SkillInjector({ coreSkill, profileScopeMode: "scoped" }, client).prewarm(input);
    expect(calls[0]).toMatchObject({ scope_filter: "global_only" });
  });

  it("injects nothing when an old Core does not echo the project", async () => {
    const { client } = stubClient(false);
    expect(await new SkillInjector({ coreSkill }, client).execute(context(HASH))).toEqual([]);
  });

  it("injects nothing when an old Core ignores the global-only filter", async () => {
    const { client } = stubClient(false);
    expect(await new SkillInjector({ coreSkill }, client).execute(context())).toEqual([]);
  });

  it("keeps the earlier request and catalog in legacy mode", async () => {
    const { client, calls } = stubClient(false);
    const injector = new SkillInjector({ coreSkill, profileScopeMode: "legacy" }, client);
    const blocks = await injector.execute(context(HASH));
    expect(calls[0]).not.toHaveProperty("project_hash");
    expect(calls[0]).not.toHaveProperty("scope_filter");
    expect(blocks).toHaveLength(1);
    expect(injector.cacheVariantFor({ projectHash: HASH })).toBeUndefined();
  });

  it("changes the cache variant with the project and drops the earlier catalog id", () => {
    const injector = new SkillInjector({ coreSkill });
    const none = injector.cacheVariantFor(undefined);
    const a = injector.cacheVariantFor({ projectHash: HASH });
    const b = injector.cacheVariantFor({ projectHash: OTHER });
    expect(new Set([none, a, b]).size).toBe(3);
    expect(none).toBe(injector.cacheVariant);
    expect(a).toContain(HASH);
    expect(injector.cacheVariantFor({ projectHash: "not-a-hash" })).toBe(none);
  });
});
