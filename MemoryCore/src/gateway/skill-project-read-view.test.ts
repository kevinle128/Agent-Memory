import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IDS,
  PROJECT_A,
  PROJECT_B,
  createSkillHarness,
  skillMd,
  type SkillHarness,
} from "../core/skill/__contract__/skill-core-harness.js";
import {
  handleCreate,
  handleFilesRead,
  handleFilesWrite,
  handleGet,
  handleGetByName,
  handleDelete,
  handleFilesRemove,
  handleList,
  handlePatch,
  handleUpdate,
  handleVersions,
  handleListing,
  handleSearch,
  type SkillRouterDeps,
} from "./skill-handlers.js";

const auth = { apiKey: "test", serviceId: "default" } as Parameters<typeof handleCreate>[1];

let h: SkillHarness;
const ids: Record<string, string> = {};

function deps(): SkillRouterDeps {
  return {
    getSkillCore: () => h.core,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as SkillRouterDeps;
}

async function create(name: string, project?: string): Promise<string> {
  const scope = project ? { scope: "project", project_hash: project, project_key: `git:${name}`, project_name: name } : {};
  const res = await handleCreate({ ...IDS, name, content: skillMd(name), ...scope }, auth, "r", deps());
  expect(res.code).toBe(0);
  const skillId = (res.data as { skill_id: string }).skill_id;
  const file = await handleFilesWrite(
    { ...IDS, skill_id: skillId, expected_version: 1, files: [{ path: "references/note.md", content: "note", encoding: "utf-8" }] },
    auth, "r", deps(),
  );
  expect(file.code).toBe(0);
  return skillId;
}

const names = (items: unknown): string[] => (items as Array<{ name: string }>).map((i) => i.name).sort();

beforeEach(async () => {
  h = createSkillHarness();
  ids.glob = await create("glob-skill");
  ids.a = await create("proj-a-skill", PROJECT_A);
  ids.b = await create("proj-b-skill", PROJECT_B);
});
afterEach(() => h?.dispose());

describe("list", () => {
  it("returns every skill without a project view", async () => {
    const res = await handleList({ ...IDS }, auth, "r", deps());
    expect(names((res.data as { items: unknown }).items)).toEqual(["glob-skill", "proj-a-skill", "proj-b-skill"]);
    expect(res.data).not.toHaveProperty("project_hash");
  });

  it("returns global and own project skills and echoes the hash", async () => {
    const res = await handleList({ ...IDS, project_hash: PROJECT_A }, auth, "r", deps());
    const data = res.data as { items: unknown; total: number; project_hash: string };
    expect(names(data.items)).toEqual(["glob-skill", "proj-a-skill"]);
    expect(data.total).toBe(2);
    expect(data.project_hash).toBe(PROJECT_A);
  });

  it("returns global skills only for scope_filter global_only", async () => {
    const res = await handleList({ ...IDS, scope_filter: "global_only" }, auth, "r", deps());
    expect(names((res.data as { items: unknown }).items)).toEqual(["glob-skill"]);
    expect(res.data).not.toHaveProperty("project_hash");
    expect((res.data as { scope_filter: string }).scope_filter).toBe("global_only");
  });

  it("filters before the limit", async () => {
    const res = await handleList({ ...IDS, project_hash: PROJECT_A, pagination: { limit: 1 } }, auth, "r", deps());
    const data = res.data as { items: unknown[]; total: number };
    expect(data.items).toHaveLength(1);
    expect(data.total).toBe(2);
  });

  it("rejects a malformed project_hash", async () => {
    const res = await handleList({ ...IDS, project_hash: "XYZ" }, auth, "r", deps());
    expect(res.code).toBe(40001);
  });
});

describe("search", () => {
  it("hides the skills of other projects", async () => {
    const all = await handleSearch({ ...IDS, query: "description" }, auth, "r", deps());
    expect(names((all.data as { items: unknown }).items)).toHaveLength(3);
    const own = await handleSearch({ ...IDS, query: "description", project_hash: PROJECT_B }, auth, "r", deps());
    expect(names((own.data as { items: unknown }).items)).toEqual(["glob-skill", "proj-b-skill"]);
    expect((own.data as { project_hash: string }).project_hash).toBe(PROJECT_B);
    const glob = await handleSearch({ ...IDS, query: "description", scope_filter: "global_only" }, auth, "r", deps());
    expect(names((glob.data as { items: unknown }).items)).toEqual(["glob-skill"]);
  });
});

describe("listing", () => {
  it("lists only visible skills and echoes the hash", async () => {
    const all = await handleListing({ ...IDS }, auth, "r", deps());
    expect((all.data as { hits: unknown[] }).hits).toHaveLength(3);
    expect(all.data).not.toHaveProperty("project_hash");

    const own = await handleListing({ ...IDS, project_hash: PROJECT_A }, auth, "r", deps());
    const data = own.data as { hits: Array<{ name: string }>; listing: string; project_hash: string };
    expect(names(data.hits)).toEqual(["glob-skill", "proj-a-skill"]);
    expect(data.listing).not.toContain("proj-b-skill");
    expect(data.project_hash).toBe(PROJECT_A);
  });

  it("lists global skills only for scope_filter global_only", async () => {
    const res = await handleListing({ ...IDS, scope_filter: "global_only" }, auth, "r", deps());
    const data = res.data as { hits: Array<{ name: string }>; listing: string };
    expect(names(data.hits)).toEqual(["glob-skill"]);
    expect(data.listing).not.toContain("proj-");
    expect((res.data as { scope_filter: string }).scope_filter).toBe("global_only");
  });

  it("filters search results of a query", async () => {
    const res = await handleListing({ ...IDS, query: "description", project_hash: PROJECT_A }, auth, "r", deps());
    expect(names((res.data as { hits: unknown }).hits)).toEqual(["glob-skill", "proj-a-skill"]);
  });
});

describe("get, get-by-name and files/read", () => {
  it("answers 40401 for a skill of another project", async () => {
    const get = await handleGet({ ...IDS, skill_id: ids.b, project_hash: PROJECT_A }, auth, "r", deps());
    expect(get.code).toBe(40401);
    const byName = await handleGetByName({ ...IDS, skill_name: "proj-b-skill", project_hash: PROJECT_A }, auth, "r", deps());
    expect(byName.code).toBe(40401);
    const file = await handleFilesRead({ ...IDS, skill_id: ids.b, path: "references/note.md", project_hash: PROJECT_A }, auth, "r", deps());
    expect(file.code).toBe(40401);
  });

  it("answers 40401 for a project skill when the view is global only", async () => {
    const get = await handleGet({ ...IDS, skill_id: ids.a, scope_filter: "global_only" }, auth, "r", deps());
    expect(get.code).toBe(40401);
  });

  it("serves global and own project skills ", async () => {
    const own = await handleGet({ ...IDS, skill_id: ids.a, project_hash: PROJECT_A }, auth, "r", deps());
    expect(own.code).toBe(0);
    // The detail keeps the own project of the skill; a global skill is never relabelled.
    expect((own.data as { project_hash: string }).project_hash).toBe(PROJECT_A);
    const glob = await handleGetByName({ ...IDS, skill_name: "glob-skill", project_hash: PROJECT_A }, auth, "r", deps());
    expect(glob.code).toBe(0);
    expect((glob.data as { project_hash: string }).project_hash).toBe("");
    const file = await handleFilesRead({ ...IDS, skill_id: ids.glob, path: "references/note.md", project_hash: PROJECT_A }, auth, "r", deps());
    expect(file.code).toBe(0);
  });

  it("serves every skill without a project view", async () => {
    const get = await handleGet({ ...IDS, skill_id: ids.b }, auth, "r", deps());
    expect(get.code).toBe(0);
    expect((get.data as { project_hash: string }).project_hash).toBe(PROJECT_B);
    const file = await handleFilesRead({ ...IDS, skill_id: ids.b, path: "references/note.md" }, auth, "r", deps());
    expect(file.code).toBe(0);
  });
});

describe("versions", () => {
  it("lists versions of visible skills, echoes the view and hides other projects", async () => {
    const own = await handleVersions({ ...IDS, skill_id: ids.a, project_hash: PROJECT_A }, auth, "r", deps());
    expect(own.code).toBe(0);
    expect((own.data as { project_hash: string }).project_hash).toBe(PROJECT_A);
    const other = await handleVersions({ ...IDS, skill_id: ids.b, project_hash: PROJECT_A }, auth, "r", deps());
    expect(other.code).toBe(40401);
    const globalOnly = await handleVersions({ ...IDS, skill_id: ids.a, scope_filter: "global_only" }, auth, "r", deps());
    expect(globalOnly.code).toBe(40401);
    const hub = await handleVersions({ ...IDS, skill_id: ids.b }, auth, "r", deps());
    expect(hub.code).toBe(0);
  });
});

describe("writes", () => {
  const edit = (name: string) => ({ expected_version: 2, content: skillMd(name, "Changed."), change_source: "manual" });

  it("refuses a skill hidden by the view and leaves it unchanged", async () => {
    const update = await handleUpdate({ ...IDS, skill_id: ids.b, ...edit("proj-b-skill"), project_hash: PROJECT_A }, auth, "r", deps());
    expect(update.code).toBe(40401);
    const patch = await handlePatch(
      { ...IDS, skill_id: ids.b, expected_version: 2, old_string: "Do the thing.", new_string: "x", project_hash: PROJECT_A },
      auth, "r", deps(),
    );
    expect(patch.code).toBe(40401);
    const remove = await handleFilesRemove(
      { ...IDS, skill_id: ids.b, expected_version: 2, paths: ["references/note.md"], scope_filter: "global_only" },
      auth, "r", deps(),
    );
    expect(remove.code).toBe(40401);
    const del = await handleDelete({ ...IDS, skill_id: ids.b, project_hash: PROJECT_A }, auth, "r", deps());
    expect(del.code).toBe(40401);
    const still = await handleGet({ ...IDS, skill_id: ids.b }, auth, "r", deps());
    expect(still.code).toBe(0);
    expect((still.data as { version: number }).version).toBe(2);
  });

  it("does not refuse a visible skill or a request without a view", async () => {
    const hub = await handleUpdate({ ...IDS, skill_id: ids.b, ...edit("proj-b-skill") }, auth, "r", deps());
    expect(hub.code).toBe(0);
    const own = await handleUpdate({ ...IDS, skill_id: ids.a, ...edit("proj-a-skill"), project_hash: PROJECT_A }, auth, "r", deps());
    expect(own.code).toBe(0);
  });
});
