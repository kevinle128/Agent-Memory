/**
 * Read routes with and without `project_hash`: the hash selects the files of
 * one project inside the profile scope. Without it, a route serves the
 * user-global files only, as before projects existed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeProfileRowStore } from "../core/storage/__contract__/fake-profile-row-store.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";
import { ProfileRowStorageBackend } from "../core/storage/profile-row-backend.js";
import { createProjectScopedStorage } from "../core/storage/project-scoped-storage.js";
import { formatSceneBlock } from "../core/scene/scene-format.js";
import { syncSceneIndex } from "../core/scene/scene-index.js";
import type { IMemoryStore } from "../core/store/types.js";
import {
  handleCoreRead,
  handleScenarioCount,
  handleScenarioLs,
  handleScenarioRead,
  type V2RouterDeps,
} from "./v2-router.js";

const A = "0123456789abcdef";
const B = "fedcba9876543210";
const isolation = { teamId: "team-1", agentId: "agent-1" };
const SCOPE_DIR = `profiles/${encodeURIComponent("team:team-1|agent:agent-1")}`;
const auth = {} as Parameters<typeof handleCoreRead>[1];

function scene(summary: string): string {
  return formatSceneBlock(
    { created: "2026-10-01T00:00:00.000Z", updated: "2026-10-02T00:00:00.000Z", summary, heat: 1 },
    `Body of ${summary}`,
  );
}

function depsFor(storage: StorageAdapter, store?: IMemoryStore): V2RouterDeps {
  return {
    getStore: () => store,
    getEmbedding: () => undefined,
    getStorage: () => storage,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    deployMode: "standalone",
    requestIsolation: { ...isolation, userId: "user-1", sessionId: "session-1" },
  } as V2RouterDeps;
}

/** Seed a scope with root files and two projects. `scope` is the profile-scope view. */
async function seed(scope: StorageAdapter): Promise<void> {
  await scope.writeFile("persona.md", "root persona");
  await scope.writeFile("scene_blocks/root-habits.md", scene("root habits"));
  await syncSceneIndex("", scope);
  for (const [hash, tag] of [[A, "A"], [B, "B"]] as const) {
    const project = createProjectScopedStorage(scope, hash);
    await project.writeFile("scene_blocks/work.md", scene(`work of ${tag}`));
    await project.writeFile("scene_blocks/notes/deep.md", scene(`deep note of ${tag}`));
    await syncSceneIndex("", project);
  }
  await scope.writeFile(`project_personas/${A}.md`, "persona of A");
}

describe("project_hash on the L2 and L3 read routes (file backend)", () => {
  let dir: string;
  let scope: StorageAdapter;
  let deps: V2RouterDeps;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "gateway-project-read-"));
    const root = new StorageAdapter(new LocalStorageBackend(dir));
    scope = new StorageAdapter(new LocalStorageBackend(path.join(dir, SCOPE_DIR)));
    await seed(scope);
    deps = depsFor(root);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("core/read", () => {
    it("reads the user-global persona without project_hash, with an empty or missing body", async () => {
      for (const body of [{}, undefined, null]) {
        const res = await handleCoreRead(body, auth, "r", deps);
        expect(res.code).toBe(0);
        expect((res.data as { content: string }).content).toBe("root persona");
      }
    });

    it("reads the project document with project_hash", async () => {
      const res = await handleCoreRead({ project_hash: A }, auth, "r", deps);

      expect(res.code).toBe(0);
      expect(res.data).toMatchObject({ content: "persona of A", team_id: "team-1", agent_id: "agent-1" });
      expect((res.data as { updated_at: string }).updated_at).toMatch(/^\d{4}-/);
    });

    it("answers null content when the project has no document", async () => {
      const res = await handleCoreRead({ project_hash: B }, auth, "r", deps);

      expect(res.code).toBe(0);
      expect(res.data).toMatchObject({ content: null });
    });

    it("rejects a malformed project_hash with 400", async () => {
      for (const project_hash of ["", "short", A.toUpperCase(), `${A}0`, "../../etc/passwd", 123]) {
        const res = await handleCoreRead({ project_hash }, auth, "r", deps);
        expect(res.code, String(project_hash)).toBe(400);
        expect(res.message).toContain("project_hash");
      }
    });
  });

  describe("scenario/ls", () => {
    const paths = (res: { data?: unknown }) => (res.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path).sort();

    it("lists only user-global scenes without project_hash", async () => {
      const res = await handleScenarioLs({}, auth, "r", deps);

      expect(res.code).toBe(0);
      expect(paths(res)).toEqual(["root-habits.md"]);
    });

    it("lists only that project's scenes, relative to the project", async () => {
      const res = await handleScenarioLs({ project_hash: A }, auth, "r", deps);

      expect(res.code).toBe(0);
      expect(paths(res)).toEqual(["notes/deep.md", "work.md"]);
      const entries = (res.data as { entries: Array<{ path: string; summary?: string; team_id?: string }> }).entries;
      expect(entries.find((e) => e.path === "work.md")).toMatchObject({ summary: "work of A", team_id: "team-1" });
      expect(JSON.stringify(res.data)).not.toContain("projects/");
      expect(JSON.stringify(res.data)).not.toContain("of B");
    });

    it("applies path_prefix inside the project", async () => {
      const res = await handleScenarioLs({ project_hash: B, path_prefix: "notes/" }, auth, "r", deps);

      expect(paths(res)).toEqual(["notes/deep.md"]);
    });

    it("lists nothing for a project without scenes", async () => {
      const res = await handleScenarioLs({ project_hash: "1111111111111111" }, auth, "r", deps);

      expect(res.code).toBe(0);
      expect(res.data).toEqual({ entries: [], total: 0 });
    });

    it("keeps hiding project paths named by path_prefix, with or without project_hash", async () => {
      for (const body of [{ path_prefix: `projects/${A}/` }, { path_prefix: "projects/", project_hash: A }]) {
        const res = await handleScenarioLs(body, auth, "r", deps);
        expect(res.data).toEqual({ entries: [], total: 0 });
      }
    });

    it("treats a prefix that normalizes to empty as the whole project", async () => {
      for (const path_prefix of ["", ".", "./", "./.", "././"]) {
        const res = await handleScenarioLs({ project_hash: A, path_prefix }, auth, "r", deps);
        expect(res.code, path_prefix).toBe(0);
        expect(paths(res), path_prefix).toEqual(["notes/deep.md", "work.md"]);
      }
      const nested = await handleScenarioLs({ project_hash: A, path_prefix: "./notes/" }, auth, "r", deps);
      expect(paths(nested)).toEqual(["notes/deep.md"]);
    });

    it("rejects an invalid hash and a traversing prefix with 400", async () => {
      expect((await handleScenarioLs({ project_hash: "xyz" }, auth, "r", deps)).code).toBe(400);
      expect((await handleScenarioLs({ project_hash: A, path_prefix: "../" }, auth, "r", deps)).code).toBe(400);
      expect((await handleScenarioLs({ project_hash: A, path_prefix: "/etc" }, auth, "r", deps)).code).toBe(400);
    });
  });

  describe("scenario/read", () => {
    it("reads a user-global scene without project_hash and never a project scene", async () => {
      const root = await handleScenarioRead({ path: "root-habits.md" }, auth, "r", deps);
      expect((root.data as { content: string }).content).toContain("Body of root habits");

      const viaPrefix = await handleScenarioRead({ path: `projects/${A}/work.md` }, auth, "r", deps);
      expect(viaPrefix.code).toBe(0);
      expect(viaPrefix.data).toMatchObject({ content: null });
      const bare = await handleScenarioRead({ path: "work.md" }, auth, "r", deps);
      expect(bare.data).toMatchObject({ content: null });
    });

    it("reads a scene of the selected project, by project-relative path", async () => {
      const a = await handleScenarioRead({ path: "work.md", project_hash: A }, auth, "r", deps);
      const b = await handleScenarioRead({ path: "work.md", project_hash: B }, auth, "r", deps);
      const deep = await handleScenarioRead({ path: "notes/deep.md", project_hash: A }, auth, "r", deps);

      expect(a.data).toMatchObject({ path: "work.md", created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-02T00:00:00.000Z" });
      expect((a.data as { content: string }).content).toContain("Body of work of A");
      expect((b.data as { content: string }).content).toContain("Body of work of B");
      expect((deep.data as { content: string }).content).toContain("Body of deep note of A");
    });

    it("answers null content for a root scene read inside a project", async () => {
      const res = await handleScenarioRead({ path: "root-habits.md", project_hash: A }, auth, "r", deps);

      expect(res.code).toBe(0);
      expect(res.data).toMatchObject({ content: null });
    });

    it("rejects a path that names the project directory with 400, and accepts a leading ./", async () => {
      for (const path of [".", "./", "./.", "././"]) {
        const res = await handleScenarioRead({ path, project_hash: A }, auth, "r", deps);
        expect(res.code, path).toBe(400);
        expect(res.message).toContain("path");
      }
      const res = await handleScenarioRead({ path: "./work.md", project_hash: A }, auth, "r", deps);
      expect(res.code).toBe(0);
      expect((res.data as { content: string }).content).toContain("Body of work of A");
    });

    it("refuses a projects/ prefix and traversal inside a project", async () => {
      const prefixed = await handleScenarioRead({ path: `projects/${B}/work.md`, project_hash: A }, auth, "r", deps);
      expect(prefixed.data).toMatchObject({ content: null });
      expect((await handleScenarioRead({ path: "../work.md", project_hash: A }, auth, "r", deps)).code).toBe(400);
      expect((await handleScenarioRead({ path: "work.md", project_hash: "bad" }, auth, "r", deps)).code).toBe(400);
    });
  });

  describe("scenario/count", () => {
    const total = (res: { data?: unknown }) => (res.data as { total: number }).total;

    it("counts user-global scenes only without project_hash", async () => {
      expect(total(await handleScenarioCount({}, auth, "r", deps))).toBe(1);
    });

    it("counts the scenes of the selected project", async () => {
      expect(total(await handleScenarioCount({ project_hash: A }, auth, "r", deps))).toBe(2);
      expect(total(await handleScenarioCount({ project_hash: A, path_prefix: "notes/" }, auth, "r", deps))).toBe(1);
      expect(total(await handleScenarioCount({ project_hash: "1111111111111111" }, auth, "r", deps))).toBe(0);
    });

    it("treats a prefix that normalizes to empty as the whole project", async () => {
      for (const path_prefix of ["", ".", "./", "./."]) {
        expect(total(await handleScenarioCount({ project_hash: A, path_prefix }, auth, "r", deps)), path_prefix).toBe(2);
      }
    });

    it("rejects an invalid hash with 400", async () => {
      expect((await handleScenarioCount({ project_hash: "nope" }, auth, "r", deps)).code).toBe(400);
    });
  });
});

describe("project_hash on the L2 and L3 read routes (row backend)", () => {
  let fake: FakeProfileRowStore;
  let storage: StorageAdapter;
  let deps: V2RouterDeps;

  beforeEach(async () => {
    fake = new FakeProfileRowStore();
    storage = new StorageAdapter(new ProfileRowStorageBackend({ store: fake.asStore(), isolation }));
    await storage.writeFile("persona.md", "root persona");
    await storage.writeFile("scene_blocks/root-habits.md", scene("root habits"));
    await storage.writeFile(`scene_blocks/projects/${A}/work.md`, scene("work of A"));
    await storage.writeFile(`scene_blocks/projects/${A}/more.md`, scene("more of A"));
    await storage.writeFile(`scene_blocks/projects/${B}/work.md`, scene("work of B"));
    await storage.writeFile(`project_personas/${A}.md`, "persona of A");
    deps = depsFor(storage, fake as unknown as IMemoryStore);
  });

  it("lists project rows by project-relative path with the version of the project row", async () => {
    const rows = await fake.pullProfiles();
    const rowA = rows.find((r) => r.filename === `projects/${A}/work.md`)!;
    const rowB = rows.find((r) => r.filename === `projects/${B}/work.md`)!;
    expect(rowA).toBeDefined();

    const res = await handleScenarioLs({ project_hash: A }, auth, "r", deps);

    const entries = (res.data as { entries: Array<{ path: string; version: number; summary?: string }> }).entries;
    expect(entries.map((e) => e.path).sort()).toEqual(["more.md", "work.md"]);
    expect(entries.find((e) => e.path === "work.md")).toMatchObject({ version: rowA.version, summary: "work of A" });
    expect(rowB.filename).not.toBe(rowA.filename);
    expect(JSON.stringify(res.data)).not.toContain("work of B");
  });

  it("keeps the root list free of project rows", async () => {
    const res = await handleScenarioLs({}, auth, "r", deps);

    expect((res.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path)).toEqual(["root-habits.md"]);
  });

  it("treats . as the whole project for ls and count, and resolves ./name to the project row", async () => {
    const rowA = (await fake.pullProfiles()).find((r) => r.filename === `projects/${A}/work.md`)!;

    const ls = await handleScenarioLs({ project_hash: A, path_prefix: "." }, auth, "r", deps);
    const entries = (ls.data as { entries: Array<{ path: string }> }).entries;
    expect(entries.map((e) => e.path).sort()).toEqual(["more.md", "work.md"]);
    expect((await handleScenarioCount({ project_hash: A, path_prefix: "./" }, auth, "r", deps)).data).toEqual({ total: 2 });
    const read = await handleScenarioRead({ path: "./work.md", project_hash: A }, auth, "r", deps);
    expect(read.data).toMatchObject({ version: rowA.version });
    expect((await handleScenarioRead({ path: ".", project_hash: A }, auth, "r", deps)).code).toBe(400);
  });

  it("reads a project scene and counts a project's rows", async () => {
    const read = await handleScenarioRead({ path: "work.md", project_hash: B }, auth, "r", deps);
    expect((read.data as { content: string }).content).toContain("Body of work of B");

    const countA = await handleScenarioCount({ project_hash: A }, auth, "r", deps);
    const countAPrefix = await handleScenarioCount({ project_hash: A, path_prefix: "w" }, auth, "r", deps);
    const countRoot = await handleScenarioCount({}, auth, "r", deps);
    expect(countA.data).toEqual({ total: 2 });
    expect(countAPrefix.data).toEqual({ total: 1 });
    expect(countRoot.data).toEqual({ total: 1 });
  });

  it("reads the project document and reports the version of its row", async () => {
    const row = (await fake.pullProfiles()).find((r) => r.filename === `project_personas/${A}.md`)!;

    const res = await handleCoreRead({ project_hash: A }, auth, "r", deps);

    expect(res.data).toMatchObject({ content: "persona of A", version: row.version });
    const root = await handleCoreRead({}, auth, "r", deps);
    expect((root.data as { content: string }).content).toBe("root persona");
  });
});
