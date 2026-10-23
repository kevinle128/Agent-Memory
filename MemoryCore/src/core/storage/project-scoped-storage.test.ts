import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatSceneBlock } from "../scene/scene-format.js";
import { readSceneIndex, syncSceneIndex } from "../scene/scene-index.js";
import { FakeProfileRowStore } from "./__contract__/fake-profile-row-store.js";
import { StorageAdapter } from "./adapter.js";
import { CompositeStorageBackend } from "./composite-backend.js";
import { LocalStorageBackend } from "./local-backend.js";
import { ProfileRowStorageBackend } from "./profile-row-backend.js";
import {
  createAllProjectsSceneView,
  createProjectScopedStorage,
  hasProjectSceneFiles,
  listProjectHashes,
} from "./project-scoped-storage.js";

const A = "0123456789abcdef";
const B = "fedcba9876543210";

function scene(summary: string, heat = 1): string {
  return formatSceneBlock(
    { created: "2026-10-01T00:00:00.000Z", updated: "2026-10-02T00:00:00.000Z", summary, heat },
    `Body of ${summary}`,
  );
}

describe("project-scoped storage over a file backend", () => {
  let dir: string;
  let base: StorageAdapter;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "project-storage-"));
    base = new StorageAdapter(new LocalStorageBackend(dir));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps scene, metadata and backup keys below the project prefix", async () => {
    const project = createProjectScopedStorage(base, A);

    await project.writeFile("scene_blocks/work.md", "scene");
    await project.writeFile(".metadata/checkpoint.json", "{}");
    await project.writeFile(".backup/persona/persona.1.md", "backup");
    await project.writeFile(".backup/scene_blocks/3/work.md", "scene backup");

    expect(await base.readFile(`scene_blocks/projects/${A}/work.md`)).toBe("scene");
    expect(await base.readFile(`.metadata/projects/${A}/checkpoint.json`)).toBe("{}");
    expect(await base.readFile(`.backup/projects/${A}/persona/persona.1.md`)).toBe("backup");
    expect(await base.readFile(`.backup/projects/${A}/scene_blocks/3/work.md`)).toBe("scene backup");
    // Nothing reached the user-global key space.
    expect(await base.exists("scene_blocks/work.md")).toBe(false);
    expect(await base.exists(".metadata/checkpoint.json")).toBe(false);
    expect(await base.exists(".backup/persona/persona.1.md")).toBe(false);
  });

  it("maps persona.md to the project persona and never to the root persona", async () => {
    await base.writeFile("persona.md", "root persona");
    const project = createProjectScopedStorage(base, A);

    await project.writeFile("persona.md", "project persona");

    expect(await base.readFile(`project_personas/${A}.md`)).toBe("project persona");
    expect(await base.readFile("persona.md")).toBe("root persona");
    expect(await project.readFile("persona.md")).toBe("project persona");
    expect((await project.stat("persona.md"))?.key).toBe("persona.md");
  });

  it("maps keys with '.' and empty segments like their plain form", async () => {
    await base.writeFile("persona.md", "root persona");
    const project = createProjectScopedStorage(base, A);

    await project.writeFile("./persona.md", "project persona");
    await project.writeFile("scene_blocks/./work.md", "scene");
    await project.writeFile("scene_blocks//other.md", "scene 2");

    expect(await base.readFile("persona.md")).toBe("root persona");
    expect(await base.readFile(`project_personas/${A}.md`)).toBe("project persona");
    expect(await base.readFile(`scene_blocks/projects/${A}/work.md`)).toBe("scene");
    expect(await base.readFile(`scene_blocks/projects/${A}/other.md`)).toBe("scene 2");
  });

  it("keeps two projects apart", async () => {
    const a = createProjectScopedStorage(base, A);
    const b = createProjectScopedStorage(base, B);
    await a.writeFile("scene_blocks/same.md", "from a");
    await b.writeFile("scene_blocks/same.md", "from b");

    expect(await a.readFile("scene_blocks/same.md")).toBe("from a");
    expect(await b.readFile("scene_blocks/same.md")).toBe("from b");
  });

  it("lists only the project's files and returns keys without the prefix", async () => {
    await base.writeFile("scene_blocks/root.md", "root");
    const a = createProjectScopedStorage(base, A);
    const b = createProjectScopedStorage(base, B);
    await a.writeFile("scene_blocks/one.md", "1");
    await a.writeFile("scene_blocks/two.md", "2");
    await a.writeFile("scene_blocks/sub/three.md", "3");
    await b.writeFile("scene_blocks/other.md", "x");

    const names = await a.readdirNames("scene_blocks/", ".md");
    expect(names.sort()).toEqual(["one.md", "two.md"]);

    const listed = await a.getBackend().listObjects("scene_blocks/", { recursive: true });
    expect(listed.entries.map((e) => e.key).sort()).toEqual([
      "scene_blocks/one.md",
      "scene_blocks/sub/three.md",
      "scene_blocks/two.md",
    ]);

    const folded = await a.getBackend().listObjects("scene_blocks/");
    expect(folded.entries.find((e) => e.isDirectory)?.key).toBe("scene_blocks/sub/");
  });

  it("pages with markers in project-relative keys", async () => {
    const a = createProjectScopedStorage(base, A);
    for (const name of ["a.md", "b.md", "c.md"]) await a.writeFile(`scene_blocks/${name}`, name);

    const first = await a.getBackend().listObjects("scene_blocks/", { maxKeys: 2 });
    expect(first.entries.map((e) => e.key)).toEqual(["scene_blocks/a.md", "scene_blocks/b.md"]);
    expect(first.nextMarker).toBe("scene_blocks/b.md");

    const second = await a.getBackend().listObjects("scene_blocks/", { maxKeys: 2, marker: first.nextMarker });
    expect(second.entries.map((e) => e.key)).toEqual(["scene_blocks/c.md"]);
    expect(second.nextMarker).toBeUndefined();
  });

  it("deletes by prefix inside the project only", async () => {
    await base.writeFile("scene_blocks/root.md", "root");
    const a = createProjectScopedStorage(base, A);
    const b = createProjectScopedStorage(base, B);
    await a.writeFile("scene_blocks/one.md", "1");
    await b.writeFile("scene_blocks/two.md", "2");

    await a.rmdir("scene_blocks/");

    expect(await a.exists("scene_blocks/one.md")).toBe(false);
    expect(await b.exists("scene_blocks/two.md")).toBe(true);
    expect(await base.exists("scene_blocks/root.md")).toBe(true);
  });

  it("does not show project scenes to the user-global listing", async () => {
    await base.writeFile("scene_blocks/root.md", scene("root"));
    await createProjectScopedStorage(base, A).writeFile("scene_blocks/work.md", scene("work"));

    expect(await base.readdirNames("scene_blocks/", ".md")).toEqual(["root.md"]);
    const index = await syncSceneIndex("", base);
    expect(index.map((e) => e.filename)).toEqual(["root.md"]);
  });

  it("rejects traversal, absolute, NUL and directory-less keys", async () => {
    const project = createProjectScopedStorage(base, A);
    const bad = ["../x.md", "scene_blocks/../../x.md", "scene_blocks/..", "/abs.md", "\\abs.md", "scene_blocks/a\0.md", "plain.md", ""];
    for (const key of bad) {
      await expect(project.writeFile(key, "x"), `write ${JSON.stringify(key)}`).rejects.toThrow();
      await expect(project.readFile(key), `read ${JSON.stringify(key)}`).rejects.toThrow();
    }
    await expect(project.getBackend().listObjects("")).rejects.toThrow();
    await expect(project.getBackend().listObjects("scene_blocks/../")).rejects.toThrow();
  });

  it("rejects an invalid project hash", () => {
    for (const hash of ["", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "../0123456789ab", "0123456789abcdeg"]) {
      expect(() => createProjectScopedStorage(base, hash), hash).toThrow(/Invalid project hash/);
    }
  });

  it("builds a per-project scene index from the project's own index file", async () => {
    const project = createProjectScopedStorage(base, A);
    await project.writeFile("scene_blocks/work.md", scene("work summary"));
    await syncSceneIndex("", project);

    expect(await base.exists(`.metadata/projects/${A}/scene_index.json`)).toBe(true);
    expect(await base.exists(".metadata/scene_index.json")).toBe(false);
    expect((await readSceneIndex("", project)).map((e) => e.filename)).toEqual(["work.md"]);
    expect(await readSceneIndex("", base)).toEqual([]);
  });

  it("lists project hashes and detects project scene files", async () => {
    expect(await listProjectHashes(base)).toEqual([]);
    expect(await hasProjectSceneFiles(base)).toBe(false);

    await createProjectScopedStorage(base, B).writeFile("scene_blocks/x.md", scene("x"));
    await createProjectScopedStorage(base, A).writeFile("scene_blocks/y.md", scene("y"));

    expect(await listProjectHashes(base)).toEqual([A, B]);
    expect(await hasProjectSceneFiles(base)).toBe(true);
  });

  it("builds a union scene index with project filenames prefixed", async () => {
    await base.writeFile("scene_blocks/root.md", scene("root summary"));
    await syncSceneIndex("", base);
    const a = createProjectScopedStorage(base, A);
    await a.writeFile("scene_blocks/work.md", scene("work summary"));
    await syncSceneIndex("", a);

    const view = createAllProjectsSceneView(base);
    const index = await readSceneIndex("", view);

    expect(index.map((e) => e.filename).sort()).toEqual(["projects/" + A + "/work.md", "root.md"]);
    // Every indexed filename reads back through the same view.
    for (const entry of index) {
      expect(await view.readFile(`scene_blocks/${entry.filename}`)).toContain("Body of");
    }
    // Writes through the union view reach the root files.
    await view.writeFile("persona.md", "root persona");
    expect(await base.readFile("persona.md")).toBe("root persona");
  });
});

describe("project-scoped storage over the row view", () => {
  const isolation = { teamId: "team-1", agentId: "agent-1" };
  let fake: FakeProfileRowStore;
  let rows: StorageAdapter;
  let othersDir: string;
  let composite: StorageAdapter;

  beforeEach(() => {
    othersDir = mkdtempSync(path.join(tmpdir(), "project-storage-rowfs-"));
    fake = new FakeProfileRowStore();
    rows = new StorageAdapter(new ProfileRowStorageBackend({ store: fake.asStore(), isolation }));
    composite = new StorageAdapter(new CompositeStorageBackend({
      profileBackend: new ProfileRowStorageBackend({ store: fake.asStore(), isolation }),
      others: new LocalStorageBackend(othersDir),
    }));
  });
  afterEach(() => {
    rmSync(othersDir, { recursive: true, force: true });
  });

  it("writes project scenes and the project persona as rows with prefixed filenames", async () => {
    const a = createProjectScopedStorage(rows, A);
    await a.writeFile("scene_blocks/work.md", scene("work"));
    await a.writeFile("persona.md", "project persona");

    const stored = (await fake.pullProfiles()).map((r) => `${r.type}:${r.filename}`).sort();
    expect(stored).toEqual([`l2:projects/${A}/work.md`, `l3:project_personas/${A}.md`]);
    expect(await a.readFile("persona.md")).toBe("project persona");
    expect(await rows.readFile("persona.md")).toBeNull();
  });

  it("derives the project index with the prefix removed and the root index without projects", async () => {
    await rows.writeFile("scene_blocks/root.md", scene("root"));
    await createProjectScopedStorage(rows, A).writeFile("scene_blocks/work.md", scene("work A"));
    await createProjectScopedStorage(rows, B).writeFile("scene_blocks/work.md", scene("work B"));

    expect((await readSceneIndex("", rows)).map((e) => e.filename)).toEqual(["root.md"]);
    const indexA = await readSceneIndex("", createProjectScopedStorage(rows, A));
    expect(indexA.map((e) => [e.filename, e.summary])).toEqual([["work.md", "work A"]]);
    const indexB = await readSceneIndex("", createProjectScopedStorage(rows, B));
    expect(indexB.map((e) => [e.filename, e.summary])).toEqual([["work.md", "work B"]]);
  });

  it("keeps the row-view type so profile sync still skips it", () => {
    expect(createProjectScopedStorage(rows, A).type).toBe("rowfs");
    expect(createProjectScopedStorage(composite, A).type).toBe("rowfs");
  });

  it("serves project scenes and metadata through the composite router", async () => {
    const a = createProjectScopedStorage(composite, A);
    await a.writeFile("scene_blocks/work.md", scene("work"));
    await a.writeFile(".metadata/checkpoint.json", "{}");
    await a.writeFile("persona.md", "project persona");

    // Scene and persona are rows; metadata goes to the others leg.
    expect((await fake.pullProfiles()).map((r) => r.filename).sort()).toEqual([
      `project_personas/${A}.md`,
      `projects/${A}/work.md`,
    ]);
    expect(await new LocalStorageBackend(othersDir).exists(`.metadata/projects/${A}/checkpoint.json`)).toBe(true);
    expect(await a.readdirNames("scene_blocks/", ".md")).toEqual(["work.md"]);
    expect(await composite.readdirNames("scene_blocks/", ".md")).toEqual([]);
    expect((await readSceneIndex("", a)).map((e) => e.filename)).toEqual(["work.md"]);
    expect(await readSceneIndex("", composite)).toEqual([]);
  });

  it("builds the union index from rows with prefixed filenames the view can read", async () => {
    await rows.writeFile("scene_blocks/root.md", scene("root"));
    await createProjectScopedStorage(rows, A).writeFile("scene_blocks/work.md", scene("work A"));
    await createProjectScopedStorage(rows, B).writeFile("scene_blocks/work.md", scene("work B"));

    const view = createAllProjectsSceneView(rows);
    const index = await readSceneIndex("", view);

    expect(index.map((e) => e.filename).sort()).toEqual([
      "root.md",
      `projects/${A}/work.md`,
      `projects/${B}/work.md`,
    ].sort());
    expect(await view.readFile(`scene_blocks/projects/${B}/work.md`)).toContain("Body of work B");
    expect(await hasProjectSceneFiles(rows)).toBe(true);
    expect(await listProjectHashes(rows)).toEqual([A, B]);
  });
});
