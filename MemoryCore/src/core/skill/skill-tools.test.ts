import { afterEach, describe, expect, it } from "vitest";

import {
  IDS,
  PROJECT_A,
  createSkillHarness,
  skillMd,
  type SkillHarness,
} from "./__contract__/skill-core-harness.js";
import { createSkillTools, type ExtractedSkillCandidate } from "./skill-tools.js";

let h: SkillHarness;
afterEach(() => h?.dispose());

const NOTE = { change_reason: "Seen twice in the transcript", change_summary: ["Adds the steps"] };

function makeTools(project?: { project_key: string; project_hash: string; project_name: string }) {
  const auditSink: ExtractedSkillCandidate[] = [];
  const tools = createSkillTools({ core: h.core, ...IDS, source_session_id: "sess-7", project, auditSink });
  // `tool()` keeps `execute` on the object; the SDK passes a second argument that the tools ignore.
  const run = async (name: keyof typeof tools, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    JSON.parse(await (tools[name] as unknown as { execute: (a: unknown, o: unknown) => Promise<string> }).execute(args, {}));
  return { tools, run, auditSink };
}

describe("extractor tools", () => {
  it("ask for a reason and a summary on every write", () => {
    h = createSkillHarness({ mode: "code" });
    const { tools } = makeTools();
    for (const name of ["skill_create", "skill_update", "skill_patch", "skill_files_write"] as const) {
      const schema = (tools[name] as unknown as { inputSchema: { jsonSchema: { required: string[] } } }).inputSchema.jsonSchema;
      expect(schema.required, name).toEqual(expect.arrayContaining(["change_reason", "change_summary"]));
    }
  });

  it("create makes a project skill when the conversation has a verified project", async () => {
    h = createSkillHarness({ mode: "code" });
    const { run, auditSink } = makeTools({ project_key: "git:x/y", project_hash: PROJECT_A, project_name: "x/y" });
    const out = await run("skill_create", { name: "tool-made", content: skillMd("tool-made"), ...NOTE });
    expect(out.ok).toBe(true);
    const skill = await h.core.get({ ...IDS, skill_id: out.skill_id as string });
    expect(skill).toMatchObject({
      scope: "project", project_hash: PROJECT_A, origin: "extracted", change_source: "extracted",
      source_session_id: "sess-7", change_summary: NOTE.change_summary,
    });
    expect(auditSink).toHaveLength(1);
  });

  it("create without a project is refused in code mode and the model sees the code", async () => {
    h = createSkillHarness({ mode: "code" });
    const { run, auditSink } = makeTools();
    const out = await run("skill_create", { name: "no-proj", content: skillMd("no-proj"), ...NOTE });
    expect(out.error).toBe("SKILL_PROJECT_REQUIRED");
    expect(auditSink).toHaveLength(0);
  });

  it("update of a global skill answers 'proposed' and records no candidate", async () => {
    h = createSkillHarness({ mode: "code" });
    const g = await h.core.create({ ...IDS, name: "team-rules", content: skillMd("team-rules") });
    const { run, auditSink } = makeTools();
    const out = await run("skill_update", {
      skill_id: g.skill_id, content: skillMd("team-rules", "Better."), expected_version: 1, ...NOTE,
    });
    expect(out).toMatchObject({ ok: true, proposed: true, proposal_id: expect.stringMatching(/^prp-/) });
    expect(auditSink).toHaveLength(0);
    expect((await h.core.get({ ...IDS, skill_id: g.skill_id })).version).toBe(1);
    expect((await h.core.listProposals({ team_id: IDS.team_id, status: ["pending"] })).total).toBe(1);
  });

  it("update of a project skill is applied at once", async () => {
    h = createSkillHarness({ mode: "code" });
    const { run, auditSink } = makeTools({ project_key: "git:x/y", project_hash: PROJECT_A, project_name: "x/y" });
    const made = await run("skill_create", { name: "proj-skill", content: skillMd("proj-skill"), ...NOTE });
    const out = await run("skill_patch", {
      skill_id: made.skill_id, old_string: "Do the thing.", new_string: "Do it better.", expected_version: 1, ...NOTE,
    });
    expect(out).toMatchObject({ ok: true, version: 2 });
    expect(auditSink.map((c) => c.action)).toEqual(["create", "patch"]);
  });
});
