import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleCoreCount, handleCoreRead } from "../../gateway/v2-router.js";
import type { V2RouterDeps } from "../../gateway/v2-router.js";
import { formatSceneBlock } from "../scene/scene-format.js";
import type { IMemoryStore } from "../store/types.js";
import { FakeProfileRowStore } from "./__contract__/fake-profile-row-store.js";
import { StorageAdapter } from "./adapter.js";
import { CompositeStorageBackend } from "./composite-backend.js";
import { LocalStorageBackend } from "./local-backend.js";
import { ProfileRowStorageBackend, classifyPath, rowToKey } from "./profile-row-backend.js";

const A = "0123456789abcdef";
const B = "fedcba9876543210";
const isolation = { teamId: "team-1", agentId: "agent-1" };

function scene(summary: string): string {
  return formatSceneBlock(
    { created: "2026-10-01T00:00:00.000Z", updated: "2026-10-02T00:00:00.000Z", summary, heat: 1 },
    `Body of ${summary}`,
  );
}

describe("classifyPath and rowToKey for project keys", () => {
  it("classifies a project persona as an L3 row named by the whole key", () => {
    expect(classifyPath(`project_personas/${A}.md`)).toEqual({ type: "l3", filename: `project_personas/${A}.md` });
  });

  it("classifies a project scene as an L2 row below projects/", () => {
    expect(classifyPath(`scene_blocks/projects/${A}/work.md`)).toEqual({
      type: "l2",
      filename: `projects/${A}/work.md`,
    });
  });

  it("rejects project persona keys that are not exactly <16 hex>.md", () => {
    for (const key of [
      "project_personas/",
      "project_personas/short.md",
      `project_personas/${A.toUpperCase()}.md`,
      `project_personas/${A}.txt`,
      `project_personas/${A}.md/extra`,
      `project_personas/sub/${A}.md`,
      `project_personas/../${A}.md`,
    ]) {
      expect(classifyPath(key), key).toBeNull();
    }
  });

  it("keeps persona.md as the user-global document", () => {
    expect(classifyPath("persona.md")).toEqual({ type: "l3", filename: "persona.md" });
  });

  it("round-trips every accepted key through rowToKey", () => {
    for (const key of ["persona.md", `project_personas/${A}.md`, "scene_blocks/work.md", `scene_blocks/projects/${A}/work.md`]) {
      const classified = classifyPath(key)!;
      expect(rowToKey(classified), key).toBe(key);
    }
  });
});

describe("rowfs backend with project rows", () => {
  let fake: FakeProfileRowStore;
  let backend: ProfileRowStorageBackend;
  let storage: StorageAdapter;

  beforeEach(async () => {
    fake = new FakeProfileRowStore();
    backend = new ProfileRowStorageBackend({ store: fake.asStore(), isolation, navigation: { readTool: "tdai_read_file" } });
    storage = new StorageAdapter(backend);
    await storage.writeFile("persona.md", "root persona");
    await storage.writeFile("scene_blocks/root.md", scene("root scene"));
    await storage.writeFile(`scene_blocks/projects/${A}/work.md`, scene("scene of A"));
    await storage.writeFile(`scene_blocks/projects/${B}/work.md`, scene("scene of B"));
    await storage.writeFile(`project_personas/${A}.md`, "persona of A");
  });

  it("lists project personas by prefix and does not mix them with persona.md", async () => {
    const all = await backend.listObjects(`project_personas/`);
    expect(all.entries.map((e) => e.key)).toEqual([`project_personas/${A}.md`]);

    const exact = await backend.listObjects(`project_personas/${A}`);
    expect(exact.entries.map((e) => e.key)).toEqual([`project_personas/${A}.md`]);

    const personaOnly = await backend.listObjects("persona.md");
    expect(personaOnly.entries.map((e) => e.key)).toEqual(["persona.md"]);
  });

  it("partial prefixes still reach both L3 families", async () => {
    const partial = await backend.listObjects("p", { recursive: true });
    expect(partial.entries.map((e) => e.key).sort()).toEqual(["persona.md", `project_personas/${A}.md`]);
  });

  it("lists everything for the empty prefix, as before", async () => {
    const all = await backend.listObjects("", { recursive: true, maxKeys: 100 });
    expect(all.entries.map((e) => e.key).sort()).toEqual([
      "persona.md",
      `project_personas/${A}.md`,
      "scene_blocks/projects/" + A + "/work.md",
      "scene_blocks/projects/" + B + "/work.md",
      "scene_blocks/root.md",
    ]);
  });

  it("shows project scenes below one directory entry in the user-global listing", async () => {
    const names = await storage.readdirNames("scene_blocks/", ".md");
    expect(names).toEqual(["root.md"]);
    const folded = await backend.listObjects("scene_blocks/");
    expect(folded.entries.filter((e) => e.isDirectory).map((e) => e.key)).toEqual(["scene_blocks/projects/"]);
  });

  it("derives a root index without project scenes", async () => {
    expect((await backend.deriveSceneIndex()).map((e) => e.filename)).toEqual(["root.md"]);
    expect((await backend.deriveSceneIndex({ projectHash: A })).map((e) => e.filename)).toEqual(["work.md"]);
  });

  it("serves the user-global persona with root scenes in its navigation only", async () => {
    const text = (await storage.readFile("persona.md"))!;
    expect(text).toContain("scene_blocks/root.md");
    expect(text).not.toContain("projects/");
  });

  it("serves a project persona with its own project's scenes in the navigation", async () => {
    const text = (await storage.readFile(`project_personas/${A}.md`))!;
    expect(text).toContain("persona of A");
    expect(text).toContain(`scene_blocks/projects/${A}/work.md`);
    expect(text).not.toContain(`projects/${B}/`);
    expect(text).not.toContain("scene_blocks/root.md");
  });

  it("deletes a project persona by key without touching persona.md", async () => {
    await storage.unlink(`project_personas/${A}.md`);
    expect(await storage.readFile(`project_personas/${A}.md`)).toBeNull();
    expect(await storage.readFile("persona.md")).toContain("root persona");
  });
});

describe("composite routing for project keys", () => {
  let othersDir: string;
  let fake: FakeProfileRowStore;
  let composite: CompositeStorageBackend;

  beforeEach(() => {
    othersDir = mkdtempSync(path.join(tmpdir(), "project-composite-"));
    fake = new FakeProfileRowStore();
    composite = new CompositeStorageBackend({
      profileBackend: new ProfileRowStorageBackend({ store: fake.asStore(), isolation }),
      others: new LocalStorageBackend(othersDir),
    });
  });
  afterEach(() => {
    rmSync(othersDir, { recursive: true, force: true });
  });

  it("routes project personas and project scenes to rows, metadata to the others leg", async () => {
    await composite.putObject(`project_personas/${A}.md`, "persona of A");
    await composite.putObject(`scene_blocks/projects/${A}/work.md`, scene("work"));
    await composite.putObject(`.metadata/projects/${A}/checkpoint.json`, "{}");
    await composite.putObject(`.backup/projects/${A}/persona/persona.1.md`, "backup");

    expect((await fake.pullProfiles()).map((r) => r.filename).sort()).toEqual([
      `project_personas/${A}.md`,
      `projects/${A}/work.md`,
    ]);
    const others = new LocalStorageBackend(othersDir);
    expect(await others.exists(`.metadata/projects/${A}/checkpoint.json`)).toBe(true);
    expect(await others.exists(`.backup/projects/${A}/persona/persona.1.md`)).toBe(true);
  });

  it("routes project persona prefixes to rows and the empty prefix to the others leg only", async () => {
    await composite.putObject(`project_personas/${A}.md`, "persona of A");
    await composite.putObject(".metadata/checkpoint.json", "{}");

    expect((await composite.listObjects("project_personas/")).entries.map((e) => e.key)).toEqual([`project_personas/${A}.md`]);
    // A partial spelling folds into a directory entry, like any non-recursive listing.
    expect((await composite.listObjects("project_pers")).entries.map((e) => e.key)).toEqual(["project_personas/"]);
    expect((await composite.listObjects("project_pers", { recursive: true })).entries.map((e) => e.key)).toEqual([`project_personas/${A}.md`]);
    expect((await composite.listObjects("", { recursive: true })).entries.map((e) => e.key)).toEqual([".metadata/checkpoint.json"]);
  });

  it("forwards the project argument of the derived scene index", async () => {
    await composite.putObject("scene_blocks/root.md", scene("root"));
    await composite.putObject(`scene_blocks/projects/${A}/work.md`, scene("work"));

    expect((await composite.deriveSceneIndex()).map((e) => e.filename)).toEqual(["root.md"]);
    expect((await composite.deriveSceneIndex({ projectHash: A })).map((e) => e.filename)).toEqual(["work.md"]);
  });
});

describe("core count", () => {
  function depsFor(store: IMemoryStore): V2RouterDeps {
    return {
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => undefined,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      deployMode: "standalone",
      requestIsolation: { ...isolation, userId: "user-1", sessionId: "session-1" },
    } as V2RouterDeps;
  }

  const auth = {} as Parameters<typeof handleCoreCount>[1];

  it("counts the user-global persona only, not project personas", async () => {
    const fake = new FakeProfileRowStore();
    const storage = new StorageAdapter(new ProfileRowStorageBackend({ store: fake.asStore(), isolation }));
    await storage.writeFile(`project_personas/${A}.md`, "persona of A");
    await storage.writeFile(`project_personas/${B}.md`, "persona of B");

    const none = await handleCoreCount({}, auth, "req-1", depsFor(fake as unknown as IMemoryStore));
    expect(none.data).toEqual({ total: 0 });

    await storage.writeFile("persona.md", "root persona");
    const one = await handleCoreCount({}, auth, "req-2", depsFor(fake as unknown as IMemoryStore));
    expect(one.data).toEqual({ total: 1 });
  });

  it("reads persona.md, not a project persona", async () => {
    const fake = new FakeProfileRowStore();
    const storage = new StorageAdapter(new ProfileRowStorageBackend({ store: fake.asStore(), isolation }));
    await storage.writeFile(`project_personas/${A}.md`, "persona of A");
    await storage.writeFile("persona.md", "root persona");
    const deps = { ...depsFor(fake as unknown as IMemoryStore), getStorage: () => storage };

    const read = await handleCoreRead({}, auth, "req-3", deps);
    expect((read.data as { content: string }).content).toContain("root persona");
  });
});
