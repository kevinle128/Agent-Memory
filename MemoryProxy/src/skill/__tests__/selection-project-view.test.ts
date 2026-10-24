import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoreSkillClient, GetSkillResult, ListingInput, SearchSkillsInput } from "../core-client.js";
import { SkillCandidateProvider } from "../candidate-provider.js";
import { SkillLoader } from "../skill-loader.js";
import { resetProjectEchoWarning } from "../../tdai/project-echo.js";
import type { CoreSkillConfig } from "../../types.js";

const HASH = "aaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbb";
const coreSkill = { endpoint: "http://core.test", serviceToken: "t", serviceId: "default", timeoutMs: 1000 } as CoreSkillConfig;
const candidate = { skill_id: "skl-1", version: 1, name: "one", description: "first" };

beforeEach(() => {
  resetProjectEchoWarning();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

/** `honor` models a Core that applies the view and echoes it. */
function stubClient(honor: boolean) {
  const listing: ListingInput[] = [];
  const search: SearchSkillsInput[] = [];
  const echo = (i: { project_hash?: string; scope_filter?: "global_only" }) => (honor ? {
    ...(i.project_hash ? { project_hash: i.project_hash } : {}),
    ...(i.scope_filter ? { scope_filter: i.scope_filter } : {}),
  } : {});
  const client = {
    listListing: vi.fn(async (i: ListingInput) => {
      listing.push(i);
      return { mode: "full", listing: "", hits: [], candidates: [candidate], ...echo(i) };
    }),
    searchSkills: vi.fn(async (i: SearchSkillsInput) => {
      search.push(i);
      return { items: [{ ...candidate, score: 1 }], ...echo(i) };
    }),
  } as unknown as CoreSkillClient;
  return { client, listing, search };
}

const base = { agentDetail: null, taskDetail: null, maxCandidates: 5 };

describe("SkillCandidateProvider project view", () => {
  it("sends the view in a listing call and keeps the candidates", async () => {
    const { client, listing } = stubClient(true);
    const provider = new SkillCandidateProvider(coreSkill, undefined, client);
    const set = await provider.get({ ...base, scope: { team_id: "t", agent_id: "a", view: { project_hash: HASH } } });
    expect(listing[0]).toMatchObject({ project_hash: HASH });
    expect(set.candidates).toHaveLength(1);
  });

  it("sends the view in a conversation search", async () => {
    const { client, search } = stubClient(true);
    const provider = new SkillCandidateProvider(coreSkill, undefined, client);
    const set = await provider.get({ ...base, conversationQuery: "deploy", scope: { team_id: "t", agent_id: "a", view: { scope_filter: "global_only" } } });
    expect(search[0]).toMatchObject({ scope_filter: "global_only" });
    expect(set.candidates).toHaveLength(1);
  });

  it("drops the candidates of an old Core that ignored the view", async () => {
    const { client } = stubClient(false);
    const provider = new SkillCandidateProvider(coreSkill, undefined, client);
    const listed = await provider.get({ ...base, scope: { team_id: "t", agent_id: "a", view: { project_hash: HASH } } });
    expect(listed.candidates).toEqual([]);
    const searched = await provider.get({ ...base, conversationQuery: "deploy", scope: { team_id: "t", agent_id: "a", view: { scope_filter: "global_only" } } });
    expect(searched.candidates).toEqual([]);
  });

  it("does not share cached candidates between views", async () => {
    const { client, listing } = stubClient(true);
    const provider = new SkillCandidateProvider(coreSkill, undefined, client);
    await provider.get({ ...base, scope: { team_id: "t", agent_id: "a", view: { project_hash: HASH } } });
    await provider.get({ ...base, scope: { team_id: "t", agent_id: "a", view: { project_hash: OTHER } } });
    await provider.get({ ...base, scope: { team_id: "t", agent_id: "a" } });
    expect(listing).toHaveLength(3);
    expect(listing[2]).not.toHaveProperty("project_hash");
  });
});

describe("SkillLoader project view", () => {
  const detail = (extra: Partial<GetSkillResult>): GetSkillResult =>
    ({ skill_id: "skl-1", version: 1, name: "one", content: "body", ...extra }) as GetSkillResult;
  const loaderWith = (result: GetSkillResult) => {
    const getSkill = vi.fn(async (_input: Record<string, unknown>) => result);
    return { loader: new SkillLoader(coreSkill, { getSkill } as unknown as CoreSkillClient), getSkill };
  };
  const args = { skillId: "skl-1", version: 1, contentCharBudget: 1000 };

  it("sends the view and loads a global or own project skill", async () => {
    const { loader, getSkill } = loaderWith(detail({ scope: "project", project_hash: HASH }));
    const out = await loader.load({ ...args, scope: { team_id: "t", agent_id: "a", view: { project_hash: HASH } } });
    expect(out.kind).toBe("loaded");
    expect(getSkill.mock.calls[0]![0]).toMatchObject({ project_hash: HASH });
  });

  it("refuses a skill of another project that an old Core served", async () => {
    const { loader } = loaderWith(detail({ scope: "project", project_hash: OTHER }));
    const out = await loader.load({ ...args, scope: { team_id: "t", agent_id: "a", view: { project_hash: HASH } } });
    expect(out).toEqual({ kind: "failed", reason: "not_visible" });
    const globalOnly = await loader.load({ ...args, scope: { team_id: "t", agent_id: "a", view: { scope_filter: "global_only" } } });
    expect(globalOnly).toEqual({ kind: "failed", reason: "not_visible" });
  });

  it("keeps the earlier read without a view", async () => {
    const { loader, getSkill } = loaderWith(detail({ scope: "project", project_hash: OTHER }));
    const out = await loader.load({ ...args, scope: { team_id: "t", agent_id: "a" } });
    expect(out.kind).toBe("loaded");
    expect(getSkill.mock.calls[0]![0]).not.toHaveProperty("project_hash");
  });
});
