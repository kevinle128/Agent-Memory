import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IDS,
  PROJECT_A,
  createSkillHarness,
  skillMd,
  type SkillHarness,
} from "../core/skill/__contract__/skill-core-harness.js";
import {
  handleCreate,
  handleProposalApprove,
  handleProposalReject,
  handleProposalsList,
  handleRollback,
  handleUpdate,
  handleVersions,
  handleVersionsDiff,
  makeSkillRouteTable,
  type SkillRouterDeps,
} from "./skill-handlers.js";

const auth = { apiKey: "test", serviceId: "default" } as Parameters<typeof handleCreate>[1];

let h: SkillHarness;
afterEach(() => h?.dispose());

function deps(extra: Partial<SkillRouterDeps> = {}): SkillRouterDeps {
  return {
    getSkillCore: () => h.core,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...extra,
  } as unknown as SkillRouterDeps;
}

const EXTRACTED = {
  change_source: "extracted",
  change_reason: "Seen in the transcript",
  change_summary: ["Adds the steps"],
};

async function createGlobal(name = "team-rules"): Promise<{ skill_id: string; version: number }> {
  const res = await handleCreate({ ...IDS, name, content: skillMd(name) }, auth, "r", deps());
  expect(res.code).toBe(0);
  return res.data as { skill_id: string; version: number };
}

/** A proposal on a global skill, made the way the extractor makes it. */
async function propose(skillId: string, name = "team-rules"): Promise<string> {
  const res = await handleUpdate(
    { ...IDS, skill_id: skillId, expected_version: 1, content: skillMd(name, "Proposed."), ...EXTRACTED },
    auth, "r", deps(),
  );
  expect(res.code).toBe(0);
  const data = res.data as { applied: boolean; proposal: { proposal_id: string } };
  expect(data.applied).toBe(false);
  return data.proposal.proposal_id;
}

describe("route table", () => {
  it("serves the new routes", () => {
    const table = makeSkillRouteTable();
    for (const path of [
      "/v3/skill/rollback", "/v3/skill/versions/diff", "/v3/skill/proposals/list",
      "/v3/skill/proposals/approve", "/v3/skill/proposals/reject",
    ]) expect(table[path], path).toBeTypeOf("function");
  });
});

describe("create and update", () => {
  it("keeps the earlier response fields and adds scope and audit fields", async () => {
    h = createSkillHarness({ mode: "code" });
    const res = await handleCreate({ ...IDS, name: "team-rules", content: skillMd("team-rules") }, auth, "r", deps());
    expect(res.code).toBe(0);
    expect(res.data).toMatchObject({
      name: "team-rules", version: 1, is_head: true, status: "active", owner_agent_id: IDS.agent_id, team_id: IDS.team_id,
      scope: "global", origin: "manual", change_source: "manual", approved_by: IDS.user_id,
      project_hash: "", change_summary: expect.any(Array),
    });
  });

  it("creates a project skill from the request", async () => {
    h = createSkillHarness({ mode: "code" });
    const res = await handleCreate(
      { ...IDS, name: "proj-skill", content: skillMd("proj-skill"), scope: "project", project_hash: PROJECT_A, project_key: "git:x/y", project_name: "x/y" },
      auth, "r", deps(),
    );
    expect(res.data).toMatchObject({ scope: "project", project_hash: PROJECT_A, project_name: "x/y", origin: "manual" });
  });

  it("answers 42205 for a project skill without a valid hash, and 40001 for a malformed hash", async () => {
    h = createSkillHarness({ mode: "code" });
    const noHash = await handleCreate({ ...IDS, name: "p", content: skillMd("p"), scope: "project" }, auth, "r", deps());
    expect(noHash.code).toBe(42205);
    const bad = await handleCreate({ ...IDS, name: "p", content: skillMd("p"), scope: "project", project_hash: "XYZ" }, auth, "r", deps());
    expect(bad.code).toBe(40001);
  });

  it("answers 42205 for an extracted skill without a project in code mode", async () => {
    h = createSkillHarness({ mode: "code" });
    const res = await handleCreate({ ...IDS, name: "x", content: skillMd("x"), ...EXTRACTED }, auth, "r", deps());
    expect(res.code).toBe(42205);
  });

  it("answers 42204 when the name is used in another scope", async () => {
    h = createSkillHarness({ mode: "code" });
    await createGlobal("shared");
    const res = await handleCreate(
      { ...IDS, name: "shared", content: skillMd("shared"), scope: "project", project_hash: PROJECT_A }, auth, "r", deps(),
    );
    expect(res.code).toBe(42204);
    const dup = await handleCreate({ ...IDS, name: "shared", content: skillMd("shared") }, auth, "r", deps());
    expect(dup.code).toBe(42201);
  });

  it("answers success with applied=false and the proposal when a system change needs approval", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    const res = await handleUpdate(
      { ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Proposed."), ...EXTRACTED },
      auth, "r", deps(),
    );
    expect(res.code).toBe(0);
    expect(res.data).toMatchObject({
      applied: false, skill_id: g.skill_id,
      proposal: { status: "pending", base_version: 1, change_reason: EXTRACTED.change_reason, change_summary: EXTRACTED.change_summary },
    });
  });
});

describe("versions", () => {
  it("returns scope and audit columns for every version", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    await handleUpdate(
      { ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Two."), change_reason: "Why", change_summary: ["One"] },
      auth, "r", deps(),
    );
    const res = await handleVersions({ ...IDS, skill_id: g.skill_id }, auth, "r", deps());
    const items = (res.data as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((i) => i.version)).toEqual([2, 1]);
    expect(items[0]).toMatchObject({
      scope: "global", origin: "manual", change_source: "manual", change_reason: "Why", change_summary: ["One"],
      approved_by: IDS.user_id, base_version: 1, proposal_id: "", is_expired: false,
    });
    expect(items[0]).toHaveProperty("approved_at_ms");
    expect(items[0]).toHaveProperty("source_session_id");
  });
});

describe("rollback", () => {
  it("creates a new version from an old one", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    await handleUpdate({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Two.") }, auth, "r", deps());
    const res = await handleRollback({ ...IDS, skill_id: g.skill_id, target_version: 1, reason: "Two was wrong" }, auth, "r", deps());
    expect(res.code).toBe(0);
    expect(res.data).toMatchObject({
      version: 3, change_source: "rollback", change_reason: "Two was wrong", change_summary: ["Restored content of v1"], base_version: 2,
    });
  });

  it("answers 40001 without a reason, and for the current version", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    await handleUpdate({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Two.") }, auth, "r", deps());
    expect((await handleRollback({ ...IDS, skill_id: g.skill_id, target_version: 1 }, auth, "r", deps())).code).toBe(40001);
    expect((await handleRollback({ ...IDS, skill_id: g.skill_id, target_version: 1, reason: "" }, auth, "r", deps())).code).toBe(40001);
    expect((await handleRollback({ ...IDS, skill_id: g.skill_id, target_version: 2, reason: "x" }, auth, "r", deps())).code).toBe(40001);
  });

  it("answers 40401 for a version or skill that does not exist, 40901 when the head moved", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    expect((await handleRollback({ ...IDS, skill_id: g.skill_id, target_version: 7, reason: "x" }, auth, "r", deps())).code).toBe(40401);
    expect((await handleRollback({ ...IDS, skill_id: "skl-none", target_version: 1, reason: "x" }, auth, "r", deps())).code).toBe(40401);
    await handleUpdate({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Two.") }, auth, "r", deps());
    const stale = await handleRollback({ ...IDS, skill_id: g.skill_id, target_version: 1, reason: "x", expected_version: 1 }, auth, "r", deps());
    expect(stale.code).toBe(40901);
  });

  it("checks the quota before it writes", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    await handleUpdate({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Two.") }, auth, "r", deps());
    const quotaManager = { checkMemoryQuota: vi.fn(async () => ({ allowed: false, current: 5, limit: 5 })) };
    const res = await handleRollback(
      { ...IDS, skill_id: g.skill_id, target_version: 1, reason: "x" }, auth, "r", deps({ quotaManager } as never),
    );
    expect(res.code).toBe(4291);
    expect((await h.core.get({ ...IDS, skill_id: g.skill_id })).version).toBe(2);
  });
});

describe("versions/diff", () => {
  it("returns lines and counts", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    await handleUpdate({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Two.") }, auth, "r", deps());
    const res = await handleVersionsDiff({ ...IDS, skill_id: g.skill_id, from_version: 1, to_version: 2 }, auth, "r", deps());
    expect(res.code).toBe(0);
    expect(res.data).toMatchObject({ skill_id: g.skill_id, from_version: 1, to_version: 2, added: 1, removed: 1, approximate: false });
    const lines = (res.data as { lines: Array<{ type: string; text: string }> }).lines;
    expect(lines.filter((l) => l.type === "added").map((l) => l.text)).toEqual(["Two."]);
    expect(lines.filter((l) => l.type === "removed").map((l) => l.text)).toEqual(["Do the thing."]);
  });

  it("answers 40001 for a bad body and 40401 for a missing version", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    expect((await handleVersionsDiff({ ...IDS, skill_id: g.skill_id, from_version: 0, to_version: 1 }, auth, "r", deps())).code).toBe(40001);
    expect((await handleVersionsDiff({ ...IDS, skill_id: g.skill_id, from_version: 1, to_version: 9 }, auth, "r", deps())).code).toBe(40401);
  });
});

describe("proposals", () => {
  it("lists by status and agent", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    const id = await propose(g.skill_id);
    const pending = await handleProposalsList({ team_id: IDS.team_id, agent_id: IDS.agent_id, status: ["pending"] }, auth, "r", deps());
    expect(pending.data).toMatchObject({ total: 1, items: [{ proposal_id: id, status: "pending", skill_id: g.skill_id }] });
    const other = await handleProposalsList({ team_id: IDS.team_id, agent_id: "agent-x" }, auth, "r", deps());
    expect((other.data as { total: number }).total).toBe(0);
    const approved = await handleProposalsList({ team_id: IDS.team_id, status: ["approved"] }, auth, "r", deps());
    expect((approved.data as { total: number }).total).toBe(0);
  });

  it("approve applies and answers with the new version", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    const id = await propose(g.skill_id);
    const res = await handleProposalApprove({ team_id: IDS.team_id, user_id: "approver", proposal_id: id }, auth, "r", deps());
    expect(res.code).toBe(0);
    expect(res.data).toMatchObject({
      applied: true,
      proposal: { status: "approved", result_version: 2, decided_by: "approver" },
      skill: { version: 2, proposal_id: id, approved_by: "approver", change_source: "extracted", change_summary: EXTRACTED.change_summary },
    });
  });

  it("a proposal made stale by a later change cannot be approved, only rejected", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    const id = await propose(g.skill_id);
    await handleUpdate({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "By hand.") }, auth, "r", deps());
    expect((await handleProposalApprove({ team_id: IDS.team_id, user_id: "approver", proposal_id: id }, auth, "r", deps())).code).toBe(40902);
    expect((await h.core.get({ ...IDS, skill_id: g.skill_id })).version).toBe(2);
    const rejected = await handleProposalReject({ team_id: IDS.team_id, user_id: "approver", proposal_id: id }, auth, "r", deps());
    expect(rejected.data).toMatchObject({ proposal: { status: "rejected" } });
  });

  it("approve answers 40901 with the current version when the base is gone and the sweep missed it", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    await handleUpdate({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "By hand.") }, auth, "r", deps());
    await h.store.insertProposal({
      proposal_id: "prp-late", team_id: IDS.team_id, owner_agent_id: IDS.agent_id, skill_id: g.skill_id, skill_name: "team-rules",
      base_version: 1, proposed_content: skillMd("team-rules", "Old."), proposed_description: "d",
      proposed_files: { write: [], remove: [] }, change_reason: "r", change_summary: ["s"], source_session_id: "",
      created_by: "", status: "pending", created_at_ms: Date.now(), decided_at_ms: 0, decided_by: "", result_version: 0,
    });
    const res = await handleProposalApprove({ team_id: IDS.team_id, user_id: "approver", proposal_id: "prp-late" }, auth, "r", deps());
    expect(res.code).toBe(40901);
    expect(res.data).toMatchObject({ current_version: 2, proposal: { status: "stale" } });
  });

  it("proposals/list requires team_id", async () => {
    h = createSkillHarness({ mode: "code" });
    expect((await handleProposalsList({ agent_id: IDS.agent_id }, auth, "r", deps())).code).toBe(40001);
  });

  it("a second decision answers 40902", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    const id = await propose(g.skill_id);
    expect((await handleProposalReject({ team_id: IDS.team_id, user_id: "u", proposal_id: id }, auth, "r", deps())).code).toBe(0);
    expect((await handleProposalReject({ team_id: IDS.team_id, user_id: "u", proposal_id: id }, auth, "r", deps())).code).toBe(40902);
    expect((await handleProposalApprove({ team_id: IDS.team_id, user_id: "u", proposal_id: id }, auth, "r", deps())).code).toBe(40902);
  });

  it("needs team_id and user_id; a proposal of another team is not found", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    const id = await propose(g.skill_id);
    expect((await handleProposalApprove({ team_id: IDS.team_id, proposal_id: id }, auth, "r", deps())).code).toBe(40001);
    expect((await handleProposalApprove({ user_id: "u", proposal_id: id }, auth, "r", deps())).code).toBe(40001);
    expect((await handleProposalApprove({ team_id: "other", user_id: "u", proposal_id: id }, auth, "r", deps())).code).toBe(40401);
    expect((await handleProposalReject({ team_id: "other", user_id: "u", proposal_id: id }, auth, "r", deps())).code).toBe(40401);
  });

  it("asks the asset ACL when a metadata service is wired, and refuses a user without write access", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    const id = await propose(g.skill_id);
    const checkAssetPermission = vi.fn(async ({ user_id }: { user_id: string }) => ({ allowed: user_id === "owner", reason: "x" }));
    const withAcl = deps({ getMetadataService: async () => ({ checkAssetPermission }) as never });

    const denied = await handleProposalApprove({ team_id: IDS.team_id, user_id: "stranger", proposal_id: id }, auth, "r", withAcl);
    expect(denied.code).toBe(40301);
    expect(checkAssetPermission).toHaveBeenCalledWith({ user_id: "stranger", asset_id: g.skill_id, action: "write" });
    const deniedReject = await handleProposalReject({ team_id: IDS.team_id, user_id: "stranger", proposal_id: id }, auth, "r", withAcl);
    expect(deniedReject.code).toBe(40301);
    // The refusals changed nothing.
    expect((await h.core.getProposal(id, IDS.team_id))?.status).toBe("pending");

    const ok = await handleProposalApprove({ team_id: IDS.team_id, user_id: "owner", proposal_id: id }, auth, "r", withAcl);
    expect(ok.code).toBe(0);
  });

  it("without a metadata service, an agent_id that is not the owner is refused", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobal();
    const id = await propose(g.skill_id);
    const res = await handleProposalApprove({ team_id: IDS.team_id, user_id: "u", agent_id: "agent-x", proposal_id: id }, auth, "r", deps());
    expect(res.code).toBe(40301);
  });
});
