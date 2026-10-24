import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTO_SUMMARY_PREFIX } from "./skill-change-service.js";
import { SkillApprovalRequiredError, SkillCoreError } from "./skill-errors.js";
import {
  IDS,
  PROJECT_A,
  PROJECT_B,
  createSkillHarness,
  skillMd,
  type SkillHarness,
} from "./__contract__/skill-core-harness.js";
import type { Skill } from "./types.js";

const EXTRACTED = {
  change_source: "extracted" as const,
  change_reason: "The transcript shows the steps twice",
  change_summary: ["Adds the deploy steps"],
};

let h: SkillHarness;
afterEach(() => h?.dispose());

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof SkillCoreError ? e.code : `other:${(e as Error).message}`;
  }
  return "no-error";
}

async function createProjectSkill(name = "deploy-steps", hash = PROJECT_A): Promise<Skill> {
  return h.core.create({
    ...IDS,
    name,
    content: skillMd(name),
    ...EXTRACTED,
    scope: "project",
    project_key: `git:example/${hash}`,
    project_hash: hash,
    project_name: "example/app",
    source_session_id: "sess-1",
  });
}

async function createGlobalManual(name = "team-rules"): Promise<Skill> {
  return h.core.create({ ...IDS, name, content: skillMd(name), change_reason: "Written by hand" });
}

describe("scope rule", () => {
  it("code mode: an extracted skill without a project is refused", async () => {
    h = createSkillHarness({ mode: "code" });
    const code = await errorCode(h.core.create({ ...IDS, name: "no-project", content: skillMd("no-project"), ...EXTRACTED }));
    expect(code).toBe("SKILL_PROJECT_REQUIRED");
    expect((await h.core.list({ ...IDS })).total).toBe(0);
  });

  it("code mode: a project skill with an invalid hash is refused", async () => {
    h = createSkillHarness({ mode: "code" });
    for (const bad of ["", "ABCDEF0123456789", "abc", "zzzzzzzzzzzzzzzz"]) {
      const code = await errorCode(
        h.core.create({ ...IDS, name: "bad-hash", content: skillMd("bad-hash"), ...EXTRACTED, scope: "project", project_hash: bad }),
      );
      expect(code, `hash '${bad}'`).toBe("SKILL_PROJECT_REQUIRED");
    }
  });

  it("code mode: an extracted skill with a valid project is stored as a project skill", async () => {
    h = createSkillHarness({ mode: "code" });
    const s = await createProjectSkill();
    expect(s).toMatchObject({
      scope: "project",
      origin: "extracted",
      project_hash: PROJECT_A,
      project_name: "example/app",
      source_session_id: "sess-1",
      change_source: "extracted",
      change_reason: EXTRACTED.change_reason,
      change_summary: EXTRACTED.change_summary,
      base_version: 0,
      approved_by: "",
      approved_at_ms: 0,
      version: 1,
    });
  });

  it("chat mode: the rule does not apply; an extracted skill is global", async () => {
    h = createSkillHarness({ mode: "chat" });
    const s = await h.core.create({ ...IDS, name: "chat-skill", content: skillMd("chat-skill"), change_source: "extracted" });
    expect(s).toMatchObject({ scope: "global", origin: "extracted", project_hash: "" });
  });

  it("a manual global skill is allowed in code mode and has origin manual", async () => {
    h = createSkillHarness({ mode: "code" });
    const s = await createGlobalManual();
    expect(s).toMatchObject({ scope: "global", origin: "manual", change_source: "manual", approved_by: IDS.user_id });
    expect(s.approved_at_ms).toBeGreaterThan(0);
  });

  it("a project skill needs a valid hash in chat mode too", async () => {
    h = createSkillHarness({ mode: "chat" });
    const code = await errorCode(
      h.core.create({ ...IDS, name: "p", content: skillMd("p"), scope: "project" }),
    );
    expect(code).toBe("SKILL_PROJECT_REQUIRED");
  });
});

describe("name conflicts", () => {
  it("a name used in another scope gives SKILL_NAME_SCOPE_CONFLICT", async () => {
    h = createSkillHarness({ mode: "code" });
    await createGlobalManual("shared-name");
    expect(await errorCode(createProjectSkill("shared-name"))).toBe("SKILL_NAME_SCOPE_CONFLICT");
  });

  it("a name used in another project gives SKILL_NAME_SCOPE_CONFLICT", async () => {
    h = createSkillHarness({ mode: "code" });
    await createProjectSkill("build-steps", PROJECT_A);
    expect(await errorCode(createProjectSkill("build-steps", PROJECT_B))).toBe("SKILL_NAME_SCOPE_CONFLICT");
  });

  it("the same name in the same scope stays SKILL_NAME_DUPLICATE", async () => {
    h = createSkillHarness({ mode: "code" });
    await createProjectSkill("build-steps", PROJECT_A);
    expect(await errorCode(createProjectSkill("build-steps", PROJECT_A))).toBe("SKILL_NAME_DUPLICATE");
    await createGlobalManual("one");
    expect(await errorCode(createGlobalManual("one"))).toBe("SKILL_NAME_DUPLICATE");
  });
});

describe("reason and summary", () => {
  it("code mode: an extracted change without reason or summary is refused", async () => {
    h = createSkillHarness({ mode: "code" });
    const base = { ...IDS, name: "need-note", content: skillMd("need-note"), change_source: "extracted" as const, scope: "project" as const, project_hash: PROJECT_A };
    expect(await errorCode(h.core.create({ ...base, change_summary: ["x"] }))).toBe("SKILL_CHANGE_INVALID");
    expect(await errorCode(h.core.create({ ...base, change_reason: "why" }))).toBe("SKILL_CHANGE_INVALID");
    expect((await h.core.list({ ...IDS })).total).toBe(0);
  });

  it("chat mode keeps asking for nothing", async () => {
    h = createSkillHarness({ mode: "chat" });
    await expect(
      h.core.create({ ...IDS, name: "quiet", content: skillMd("quiet"), change_source: "extracted" }),
    ).resolves.toBeTruthy();
  });

  it("a manual change without a summary gets one, marked as written by the system", async () => {
    h = createSkillHarness({ mode: "code" });
    const v1 = await createGlobalManual();
    const v2 = await h.core.update({ ...IDS, skill_id: v1.skill_id, expected_version: 1, content: skillMd("team-rules", "New body.") });
    expect(v2.change_summary.length).toBeGreaterThan(0);
    expect(v2.change_summary.every((s) => s.startsWith(AUTO_SUMMARY_PREFIX))).toBe(true);
    expect(v2.base_version).toBe(1);
  });

  it("a manual change keeps the summary the person wrote", async () => {
    h = createSkillHarness({ mode: "code" });
    const v1 = await createGlobalManual();
    const v2 = await h.core.update({
      ...IDS, skill_id: v1.skill_id, expected_version: 1, content: skillMd("team-rules", "x"),
      change_reason: "Fix typo", change_summary: ["Fixes a typo"],
    });
    expect(v2).toMatchObject({ change_reason: "Fix typo", change_summary: ["Fixes a typo"] });
  });

  it("an unchanged update writes no version", async () => {
    h = createSkillHarness({ mode: "code" });
    const v1 = await createGlobalManual();
    const same = await h.core.update({ ...IDS, skill_id: v1.skill_id, expected_version: 1, content: v1.content });
    expect(same.version).toBe(1);
  });
});

describe("approval policy through the service", () => {
  it("a change of the extractor to a project skill applies at once, without an approver", async () => {
    h = createSkillHarness({ mode: "code" });
    const v1 = await createProjectSkill();
    const v2 = await h.core.update({
      ...IDS, skill_id: v1.skill_id, expected_version: 1, content: skillMd("deploy-steps", "Better."),
      ...EXTRACTED, source_session_id: "sess-2",
    });
    expect(v2).toMatchObject({
      version: 2, scope: "project", project_hash: PROJECT_A, origin: "extracted",
      change_source: "extracted", approved_by: "", base_version: 1, source_session_id: "sess-2",
    });
  });

  it("a change of the extractor to a global skill becomes a pending proposal and no version", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobalManual();
    const err = await h.core
      .update({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Proposed."), ...EXTRACTED, source_session_id: "sess-9" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillApprovalRequiredError);
    const proposal = (err as SkillApprovalRequiredError).proposal;
    expect(proposal).toMatchObject({
      status: "pending", skill_id: g.skill_id, skill_name: "team-rules", base_version: 1,
      change_reason: EXTRACTED.change_reason, change_summary: EXTRACTED.change_summary,
      source_session_id: "sess-9", team_id: IDS.team_id, owner_agent_id: IDS.agent_id, result_version: 0,
    });
    expect(proposal.proposed_content).toContain("Proposed.");
    const head = await h.core.get({ ...IDS, skill_id: g.skill_id });
    expect(head.version).toBe(1);
    expect((await h.core.listVersions({ ...IDS, skill_id: g.skill_id })).total).toBe(1);
  });

  it("a manual change to a global skill applies, and the person is the approver", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobalManual();
    const v2 = await h.core.update({ ...IDS, user_id: "user-2", skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Edited.") });
    expect(v2).toMatchObject({ version: 2, change_source: "manual", approved_by: "user-2" });
  });

  it("chat mode: a change of the extractor to a global skill applies", async () => {
    h = createSkillHarness({ mode: "chat" });
    const g = await h.core.create({ ...IDS, name: "chat-global", content: skillMd("chat-global"), change_source: "extracted" });
    const v2 = await h.core.update({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("chat-global", "More."), change_source: "extracted" });
    expect(v2.version).toBe(2);
  });

  it("a skill that predates scope (global, extracted) can still be edited by a person in code mode", async () => {
    h = createSkillHarness({ mode: "code" });
    // Written through the store without scope fields, like a row from before the migration.
    const legacy = await h.store.appendVersion({
      skill_id: "skl-legacy", name: "legacy-skill", description: "d", content: skillMd("legacy-skill"),
      content_hash: "h", manifest: [], storage_dir: "skills/skl-legacy/v1", ...IDS, owner_agent_id: IDS.agent_id,
    });
    expect(legacy).toMatchObject({ scope: "global", origin: "extracted" });
    const v2 = await h.core.update({ ...IDS, skill_id: "skl-legacy", expected_version: 1, content: skillMd("legacy-skill", "Edited.") });
    expect(v2).toMatchObject({ version: 2, scope: "global", origin: "extracted", change_source: "manual" });
  });
});

function stuckProposal(skillId: string, over: Record<string, unknown> = {}) {
  return {
    proposal_id: "prp-old", team_id: IDS.team_id, owner_agent_id: IDS.agent_id, skill_id: skillId, skill_name: "team-rules",
    base_version: 1, proposed_content: skillMd("team-rules", "Old."), proposed_description: "d",
    proposed_files: { write: [], remove: [] }, change_reason: "r", change_summary: ["s"], source_session_id: "",
    created_by: "", status: "pending" as const, created_at_ms: Date.now(), decided_at_ms: 0, decided_by: "", result_version: 0,
    ...over,
  };
}

describe("proposals", () => {
  async function proposeOnGlobal(body = "Proposed."): Promise<{ g: Skill; proposalId: string }> {
    const g = await createGlobalManual();
    const err = (await h.core
      .update({ ...IDS, skill_id: g.skill_id, expected_version: g.version, content: skillMd("team-rules", body), ...EXTRACTED })
      .catch((e: unknown) => e)) as SkillApprovalRequiredError;
    return { g, proposalId: err.proposal.proposal_id };
  }

  it("approve applies in the same call and copies the proposal into the version", async () => {
    h = createSkillHarness({ mode: "code" });
    const { g, proposalId } = await proposeOnGlobal();
    const r = await h.core.approveProposal({ proposal_id: proposalId, team_id: IDS.team_id, user_id: "approver-1" });
    expect(r.status).toBe("approved");
    if (r.status !== "approved") return;
    expect(r.skill).toMatchObject({
      version: 2, content: skillMd("team-rules", "Proposed."), proposal_id: proposalId, approved_by: "approver-1",
      base_version: 1, change_source: "extracted", change_reason: EXTRACTED.change_reason,
      change_summary: EXTRACTED.change_summary,
    });
    expect(r.skill.approved_at_ms).toBeGreaterThan(0);
    expect(r.proposal).toMatchObject({ status: "approved", result_version: 2, decided_by: "approver-1" });
    expect((await h.core.get({ ...IDS, skill_id: g.skill_id })).version).toBe(2);
  });

  it("approving twice is refused: the second call finds the proposal decided", async () => {
    h = createSkillHarness({ mode: "code" });
    const { proposalId } = await proposeOnGlobal();
    await h.core.approveProposal({ proposal_id: proposalId, team_id: IDS.team_id, user_id: "a" });
    expect(await errorCode(h.core.approveProposal({ proposal_id: proposalId, team_id: IDS.team_id, user_id: "a" })))
      .toBe("SKILL_PROPOSAL_STATE_INVALID");
    const versions = await h.core.listVersions({ ...IDS, skill_id: (await h.core.list({ ...IDS })).items[0]!.skill_id });
    expect(versions.total).toBe(2);
  });

  it("goes stale as soon as the skill changes; nothing is applied and only reject is left", async () => {
    h = createSkillHarness({ mode: "code" });
    const { g, proposalId } = await proposeOnGlobal();
    await h.core.update({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Edited by hand.") });

    expect((await h.core.getProposal(proposalId, IDS.team_id))?.status).toBe("stale");
    expect(await errorCode(h.core.approveProposal({ proposal_id: proposalId, team_id: IDS.team_id, user_id: "a" })))
      .toBe("SKILL_PROPOSAL_STATE_INVALID");
    expect((await h.core.get({ ...IDS, skill_id: g.skill_id })).content).toContain("Edited by hand.");
    expect((await h.core.listVersions({ ...IDS, skill_id: g.skill_id })).total).toBe(2);
    const rejected = await h.core.rejectProposal({ proposal_id: proposalId, team_id: IDS.team_id, user_id: "a" });
    expect(rejected.status).toBe("rejected");
  });

  it("approve finds a pending proposal whose base is gone (missed sweep) and marks it stale", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobalManual();
    await h.core.update({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Two.") });
    await h.store.insertProposal(stuckProposal(g.skill_id, { base_version: 1 }));
    const r = await h.core.approveProposal({ proposal_id: "prp-old", team_id: IDS.team_id, user_id: "a" });
    expect(r).toMatchObject({ status: "stale", current_version: 2 });
    expect((await h.core.listVersions({ ...IDS, skill_id: g.skill_id })).total).toBe(2);
  });

  it("keeps one pending proposal per skill: a newer one stales the older", async () => {
    h = createSkillHarness({ mode: "code" });
    const { g, proposalId: first } = await proposeOnGlobal("One.");
    const err = (await h.core
      .update({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Two."), ...EXTRACTED })
      .catch((e: unknown) => e)) as SkillApprovalRequiredError;
    expect((await h.core.getProposal(first, IDS.team_id))?.status).toBe("stale");
    expect(err.proposal.status).toBe("pending");
    expect((await h.core.listProposals({ team_id: IDS.team_id, status: ["pending"] })).total).toBe(1);
  });

  it("an applied change stales pending proposals of that skill with another base", async () => {
    h = createSkillHarness({ mode: "code" });
    const { g, proposalId } = await proposeOnGlobal();
    await h.core.rollback({ ...IDS, skill_id: g.skill_id, target_version: 1, reason: "noop?" }).catch(() => undefined);
    await h.core.writeFiles({ ...IDS, skill_id: g.skill_id, expected_version: 1, files: [{ path: "a.txt", content: "a", encoding: "utf-8" }] });
    expect((await h.core.getProposal(proposalId, IDS.team_id))?.status).toBe("stale");
  });

  it("repairs an approval that was claimed but never applied", async () => {
    let t = 1_000_000;
    h = createSkillHarness({ mode: "code", coreOptions: { now: () => t } });
    const g = await createGlobalManual();
    await h.store.insertProposal(stuckProposal(g.skill_id, { status: "approved", decided_at_ms: t, result_version: 0 }));
    await h.store.insertProposal(stuckProposal(g.skill_id, { proposal_id: "prp-done", status: "approved", decided_at_ms: t, result_version: 2 }));
    expect(await h.core.changes.repairStuckApprovals()).toBe(0); // too recent
    t += 6 * 60 * 1000;
    expect(await h.core.changes.repairStuckApprovals()).toBe(1);
    expect((await h.core.getProposal("prp-old", IDS.team_id))?.status).toBe("stale");
    expect((await h.core.getProposal("prp-done", IDS.team_id))?.status).toBe("approved");
  });

  it("the list sweep expires old pending proposals", async () => {
    let t = 1_000_000;
    h = createSkillHarness({ mode: "code", coreOptions: { now: () => t } });
    const g = await createGlobalManual();
    await h.store.insertProposal(stuckProposal(g.skill_id, { created_at_ms: t }));
    t += 31 * 24 * 60 * 60 * 1000;
    const r = await h.core.listProposals({ team_id: IDS.team_id, status: ["expired"] });
    expect(r.total).toBe(1);
  });

  it("reject moves pending to rejected and leaves the skill alone", async () => {
    h = createSkillHarness({ mode: "code" });
    const { g, proposalId } = await proposeOnGlobal();
    const rejected = await h.core.rejectProposal({ proposal_id: proposalId, team_id: IDS.team_id, user_id: "r1" });
    expect(rejected).toMatchObject({ status: "rejected", decided_by: "r1" });
    expect((await h.core.get({ ...IDS, skill_id: g.skill_id })).version).toBe(1);
    // Terminal: no second decision.
    expect(await errorCode(h.core.rejectProposal({ proposal_id: proposalId, team_id: IDS.team_id, user_id: "r1" })))
      .toBe("SKILL_PROPOSAL_STATE_INVALID");
    expect(await errorCode(h.core.approveProposal({ proposal_id: proposalId, team_id: IDS.team_id, user_id: "r1" })))
      .toBe("SKILL_PROPOSAL_STATE_INVALID");
  });

  it("a proposal of another team is not found", async () => {
    h = createSkillHarness({ mode: "code" });
    const { proposalId } = await proposeOnGlobal();
    expect(await errorCode(h.core.approveProposal({ proposal_id: proposalId, team_id: "other-team", user_id: "a" })))
      .toBe("SKILL_PROPOSAL_NOT_FOUND");
    expect(await errorCode(h.core.rejectProposal({ proposal_id: "prp-missing", team_id: IDS.team_id, user_id: "a" })))
      .toBe("SKILL_PROPOSAL_NOT_FOUND");
  });

  it("lists proposals by status and agent, newest first", async () => {
    h = createSkillHarness({ mode: "code" });
    const first = await proposeOnGlobal("One.");
    const g2 = await createGlobalManual("second-rules");
    await h.core
      .update({ ...IDS, skill_id: g2.skill_id, expected_version: 1, content: skillMd("second-rules", "Two."), ...EXTRACTED })
      .catch(() => undefined);
    await h.core.rejectProposal({ proposal_id: first.proposalId, team_id: IDS.team_id, user_id: "r" });

    const pending = await h.core.listProposals({ ...IDS, status: ["pending"] });
    expect(pending.total).toBe(1);
    expect(pending.items[0]!.skill_id).toBe(g2.skill_id);
    const all = await h.core.listProposals({ team_id: IDS.team_id });
    expect(all.total).toBe(2);
    expect((await h.core.listProposals({ team_id: IDS.team_id, agent_id: "other-agent" })).total).toBe(0);
    expect((await h.core.listProposals({ team_id: IDS.team_id, skill_id: first.g.skill_id })).total).toBe(1);
  });

  it("puts the proposal back to pending when the apply fails", async () => {
    h = createSkillHarness({ mode: "code" });
    const { proposalId } = await proposeOnGlobal();
    const spy = vi
      .spyOn((h.core.changes as unknown as { versioning: { appendNextVersion: () => unknown } }).versioning, "appendNextVersion")
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(h.core.approveProposal({ proposal_id: proposalId, team_id: IDS.team_id, user_id: "a" })).rejects.toThrow("disk full");
    spy.mockRestore();
    const [p] = (await h.core.listProposals({ team_id: IDS.team_id })).items;
    expect(p).toMatchObject({ status: "pending", decided_by: "", result_version: 0 });
    // After the cause is fixed, the same proposal can be approved.
    const r = await h.core.approveProposal({ proposal_id: proposalId, team_id: IDS.team_id, user_id: "a" });
    expect(r.status).toBe("approved");
  });

  it("applies the file part of a proposal", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobalManual();
    const err = (await h.core
      .writeFiles({
        ...IDS, skill_id: g.skill_id, expected_version: 1,
        files: [{ path: "scripts/run.sh", content: "echo hi", encoding: "utf-8" }], ...EXTRACTED,
      })
      .catch((e: unknown) => e)) as SkillApprovalRequiredError;
    expect(err.proposal.proposed_files.write).toHaveLength(1);
    const r = await h.core.approveProposal({ proposal_id: err.proposal.proposal_id, team_id: IDS.team_id, user_id: "a" });
    expect(r.status).toBe("approved");
    const file = await h.core.readFile({ ...IDS, skill_id: g.skill_id, path: "scripts/run.sh" });
    expect(file.content).toBe("echo hi");
  });

  it("expires pending proposals older than the cutoff", async () => {
    h = createSkillHarness({ mode: "code" });
    const { proposalId } = await proposeOnGlobal();
    expect(await h.core.changes.expirePending(Date.now() - 60_000)).toBe(0);
    expect(await h.core.changes.expirePending(Date.now() + 60_000)).toBe(1);
    const p = await h.core.getProposal(proposalId, IDS.team_id);
    expect(p?.status).toBe("expired");
    expect(await errorCode(h.core.approveProposal({ proposal_id: proposalId, team_id: IDS.team_id, user_id: "a" })))
      .toBe("SKILL_PROPOSAL_STATE_INVALID");
  });
});

describe("rollback", () => {
  it("creates a new version with the old content and keeps the whole history", async () => {
    h = createSkillHarness({ mode: "code" });
    const v1 = await createGlobalManual();
    await h.core.update({ ...IDS, skill_id: v1.skill_id, expected_version: 1, content: skillMd("team-rules", "Second.") });
    await h.core.update({ ...IDS, skill_id: v1.skill_id, expected_version: 2, content: skillMd("team-rules", "Third.") });

    const v4 = await h.core.rollback({ ...IDS, user_id: "user-7", skill_id: v1.skill_id, target_version: 1, reason: "Third broke the build" });
    expect(v4).toMatchObject({
      version: 4, content: v1.content, change_source: "rollback", change_reason: "Third broke the build",
      change_summary: ["Restored content of v1"], base_version: 3, approved_by: "user-7", is_head: true,
    });
    const versions = await h.core.listVersions({ ...IDS, skill_id: v1.skill_id });
    expect(versions.items.map((v) => v.version)).toEqual([4, 3, 2, 1]);
    expect(versions.items.filter((v) => v.is_head)).toHaveLength(1);
    expect(versions.items.find((v) => v.version === 3)!.content).toContain("Third.");
  });

  it("needs a reason, and refuses the current version as target", async () => {
    h = createSkillHarness({ mode: "code" });
    const v1 = await createGlobalManual();
    await h.core.update({ ...IDS, skill_id: v1.skill_id, expected_version: 1, content: skillMd("team-rules", "Second.") });
    expect(await errorCode(h.core.rollback({ ...IDS, skill_id: v1.skill_id, target_version: 1, reason: "  " }))).toBe("SKILL_CHANGE_INVALID");
    expect(await errorCode(h.core.rollback({ ...IDS, skill_id: v1.skill_id, target_version: 2, reason: "x" }))).toBe("SKILL_CHANGE_INVALID");
    expect(await errorCode(h.core.rollback({ ...IDS, skill_id: v1.skill_id, target_version: 9, reason: "x" }))).toBe("SKILL_NOT_FOUND");
    expect(await errorCode(h.core.rollback({ ...IDS, skill_id: v1.skill_id, target_version: 1, reason: "x", expected_version: 1 })))
      .toBe("SKILL_VERSION_STALE");
  });

  it("restores the files of the target version", async () => {
    h = createSkillHarness({ mode: "code" });
    const v1 = await h.core.create({
      ...IDS, name: "with-files", content: skillMd("with-files"),
      resources: [{ path: "docs/a.txt", content: "first", encoding: "utf-8" }],
    });
    await h.core.removeFiles({ ...IDS, skill_id: v1.skill_id, expected_version: 1, paths: ["docs/a.txt"] });
    await h.core.writeFiles({ ...IDS, skill_id: v1.skill_id, expected_version: 2, files: [{ path: "docs/b.txt", content: "other", encoding: "utf-8" }] });

    const v4 = await h.core.rollback({ ...IDS, skill_id: v1.skill_id, target_version: 1, reason: "Bring back a.txt" });
    expect(v4.manifest.map((m) => m.path)).toEqual(["docs/a.txt"]);
    expect((await h.core.readFile({ ...IDS, skill_id: v1.skill_id, path: "docs/a.txt" })).content).toBe("first");
  });

  it("applies to a global skill in code mode: a rollback is a person's change", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobalManual();
    await h.core.update({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Second.") });
    await expect(h.core.rollback({ ...IDS, skill_id: g.skill_id, target_version: 1, reason: "undo" })).resolves.toMatchObject({ version: 3 });
  });

  it("keeps the scope of the skill", async () => {
    h = createSkillHarness({ mode: "code" });
    const p = await createProjectSkill();
    await h.core.update({ ...IDS, skill_id: p.skill_id, expected_version: 1, content: skillMd("deploy-steps", "Second."), ...EXTRACTED });
    const v3 = await h.core.rollback({ ...IDS, skill_id: p.skill_id, target_version: 1, reason: "undo" });
    expect(v3).toMatchObject({ scope: "project", project_hash: PROJECT_A, origin: "extracted" });
  });
});

describe("diff", () => {
  it("compares any two versions in either order", async () => {
    h = createSkillHarness({ mode: "code" });
    const v1 = await createGlobalManual();
    await h.core.update({ ...IDS, skill_id: v1.skill_id, expected_version: 1, content: skillMd("team-rules", "Second.") });
    const fwd = await h.core.diffVersions({ ...IDS, skill_id: v1.skill_id, from_version: 1, to_version: 2 });
    expect(fwd).toMatchObject({ from_version: 1, to_version: 2, added: 1, removed: 1 });
    const back = await h.core.diffVersions({ ...IDS, skill_id: v1.skill_id, from_version: 2, to_version: 1 });
    expect(back.lines.find((l) => l.type === "added")!.text).toBe("Do the thing.");
    expect(await errorCode(h.core.diffVersions({ ...IDS, skill_id: v1.skill_id, from_version: 1, to_version: 5 }))).toBe("SKILL_NOT_FOUND");
  });
});

describe("promotion and template marking", () => {
  it("promotes a project skill to a global skill the person owns", async () => {
    h = createSkillHarness({ mode: "code" });
    const p = await createProjectSkill();
    const r = await h.core.changes.promote(p, { ...IDS, user_id: "user-9" });
    expect(r.outcome).toBe("applied");
    expect(r.skill).toMatchObject({
      version: 2, scope: "global", origin: "manual", project_key: "", project_hash: "", project_name: "",
      change_source: "promotion", approved_by: "user-9", base_version: 1, content: p.content,
    });
    // Earlier versions keep the project they had.
    const versions = await h.core.listVersions({ ...IDS, skill_id: p.skill_id });
    expect(versions.items.find((v) => v.version === 1)).toMatchObject({ scope: "project", project_hash: PROJECT_A });
    // The extractor now only proposes changes to it.
    const err = await h.core
      .update({ ...IDS, skill_id: p.skill_id, expected_version: 2, content: skillMd("deploy-steps", "Auto."), ...EXTRACTED })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillApprovalRequiredError);
  });

  it("refuses to promote a skill that is already global", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobalManual();
    expect(() => h.core.changes.promote(g, IDS)).toThrow(/already global/);
  });

  it("marks a skill as a template: global, origin template", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobalManual();
    const r = await h.core.changes.markTemplate(g, IDS);
    expect(r.skill).toMatchObject({ version: 2, scope: "global", origin: "template", change_source: "template" });
  });
});

describe("concurrent writers on the same base", () => {
  async function filesSkill(): Promise<Skill> {
    return h.core.create({
      ...IDS, name: "with-files", content: skillMd("with-files"),
      resources: [{ path: "a.txt", content: "a", encoding: "utf-8" }],
    });
  }

  it("approve vs a manual write on the same base: one version wins, the loser fails, files stay readable", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await filesSkill();
    const err = (await h.core
      .update({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("with-files", "Proposed."), ...EXTRACTED })
      .catch((e: unknown) => e)) as SkillApprovalRequiredError;
    const id = err.proposal.proposal_id;

    const results = await Promise.allSettled([
      h.core.approveProposal({ proposal_id: id, team_id: IDS.team_id, user_id: "a" }),
      h.core.writeFiles({ ...IDS, skill_id: g.skill_id, expected_version: 1, files: [{ path: "b.txt", content: "b", encoding: "utf-8" }] }),
    ]);
    const versions = await h.core.listVersions({ ...IDS, skill_id: g.skill_id });
    expect(versions.items.map((v) => v.version)).toEqual([2, 1]);
    expect(results.filter((r) => r.status === "fulfilled" && (r.value as { status?: string }).status !== "stale" ).length).toBeGreaterThanOrEqual(1);

    const head = versions.items[0]!;
    for (const m of head.manifest) {
      const f = await h.core.readFile({ ...IDS, skill_id: g.skill_id, path: m.path });
      expect(f.content.length).toBeGreaterThan(0);
    }
    expect((await h.core.getProposal(id, IDS.team_id))?.status).not.toBe("pending");
  });

  it("two writers with the same expected version: exactly one lands", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await filesSkill();
    const results = await Promise.allSettled([
      h.core.writeFiles({ ...IDS, skill_id: g.skill_id, expected_version: 1, files: [{ path: "b.txt", content: "b", encoding: "utf-8" }] }),
      h.core.writeFiles({ ...IDS, skill_id: g.skill_id, expected_version: 1, files: [{ path: "c.txt", content: "c", encoding: "utf-8" }] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as SkillCoreError).code).toBe("SKILL_VERSION_STALE");
    const head = await h.core.get({ ...IDS, skill_id: g.skill_id });
    expect(head.version).toBe(2);
    for (const m of head.manifest) {
      expect((await h.core.readFile({ ...IDS, skill_id: g.skill_id, path: m.path })).content).toBeTruthy();
    }
  });

  it("two approvals on the same base: one applies, the other does not touch the winner's files", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await filesSkill();
    const mk = async (path: string) => {
      const ids = await h.store.listProposals({ team_id: IDS.team_id, skill_id: g.skill_id, status: ["pending"] });
      void ids;
      const base = stuckProposal(g.skill_id, {
        proposal_id: `prp-${path}`, skill_name: "with-files", proposed_content: skillMd("with-files", path),
        proposed_files: { write: [{ path, content: path, encoding: "utf-8" }], remove: [] },
      });
      await h.store.insertProposal(base);
      return base.proposal_id;
    };
    const p1 = await mk("one.txt");
    const p2 = await mk("two.txt");
    const results = await Promise.allSettled([
      h.core.approveProposal({ proposal_id: p1, team_id: IDS.team_id, user_id: "a" }),
      h.core.approveProposal({ proposal_id: p2, team_id: IDS.team_id, user_id: "a" }),
    ]);
    const applied = results.filter((r) => r.status === "fulfilled" && (r.value as { status: string }).status === "approved");
    expect(applied).toHaveLength(1);
    const head = await h.core.get({ ...IDS, skill_id: g.skill_id });
    expect(head.version).toBe(2);
    for (const m of head.manifest) {
      expect((await h.core.readFile({ ...IDS, skill_id: g.skill_id, path: m.path })).content).toBeTruthy();
    }
    const loser = [p1, p2].find((id) => id !== (applied[0] as PromiseFulfilledResult<{ proposal: { proposal_id: string } }>).value.proposal.proposal_id)!;
    expect((await h.core.getProposal(loser, IDS.team_id))?.status).toBe("stale");
  });

  it("an update with a stale expected version fails after an approve", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobalManual();
    const err = (await h.core
      .update({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Proposed."), ...EXTRACTED })
      .catch((e: unknown) => e)) as SkillApprovalRequiredError;
    await h.core.approveProposal({ proposal_id: err.proposal.proposal_id, team_id: IDS.team_id, user_id: "a" });
    expect(await errorCode(h.core.update({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Late.") })))
      .toBe("SKILL_VERSION_STALE");
  });

  it("the store refuses an append whose expected head version is old", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await createGlobalManual();
    await h.core.update({ ...IDS, skill_id: g.skill_id, expected_version: 1, content: skillMd("team-rules", "Two.") });
    await expect(
      h.store.appendVersion({
        skill_id: g.skill_id, name: g.name, description: "d", content: "x", content_hash: "x", manifest: [],
        storage_dir: "skills/x/v2", team_id: IDS.team_id, expected_head_version: 1,
      }),
    ).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
  });
});
