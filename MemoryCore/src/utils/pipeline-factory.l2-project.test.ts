/**
 * The L2 runner partitions scene extraction per project inside one profile
 * scope. These tests run the real SceneExtractor with a fake LLM runner that
 * writes scene files through the storage tools it receives, so every key the
 * extractor, its file tools and its checkpoint use goes through the real
 * storage views.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as pf from "./pipeline-factory.js";
import type { PipelineLogger } from "./pipeline-factory.js";
import { formatSceneBlock } from "../core/scene/scene-format.js";
import { FakeProfileRowStore } from "../core/storage/__contract__/fake-profile-row-store.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { CompositeStorageBackend } from "../core/storage/composite-backend.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";
import { ProfileRowStorageBackend } from "../core/storage/profile-row-backend.js";
import type { IMemoryStore, L1RecordRow } from "../core/store/types.js";
import type { LLMRunParams, LLMRunner } from "../core/types.js";

const logger: PipelineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const A = "0123456789abcdef";
const B = "fedcba9876543210";
const SCOPE = "team:team-1|agent:agent-1";
const SESSION_KEY = `profile:${SCOPE}`;
/** Scope directory inside the root storage, as the local scope wrapper builds it. */
const SCOPE_DIR = `profiles/${encodeURIComponent(SCOPE)}`;
const PERSONA = "# Persona\n\n- Prefers evidence before conclusions.";

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "l2-project-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})));
});

function cfg() {
  return {
    persona: { model: "test-model", promptMode: "chat", maxScenes: 15, sceneBackupCount: 1 },
  } as never;
}

let rowCounter = 0;
function l1Row(name: string, projectHash?: string): L1RecordRow {
  rowCounter += 1;
  const stamp = new Date(Date.UTC(2026, 9, 1, 0, 0, rowCounter)).toISOString();
  return {
    record_id: `l1-${name}-${rowCounter}`,
    content: `memory-${name}`,
    type: "episodic",
    priority: 50,
    scene_name: "",
    session_key: "session-key-1",
    session_id: "session-1",
    team_id: "team-1",
    task_id: "",
    project_key: projectHash ? `project-of-${projectHash}` : "",
    project_hash: projectHash ?? "",
    user_id: "user-1",
    agent_id: "agent-1",
    version: 1,
    timestamp_str: stamp,
    timestamp_start: stamp,
    timestamp_end: stamp,
    created_time: stamp,
    updated_time: stamp,
    metadata_json: "{}",
  } as unknown as L1RecordRow;
}

function l1Store(rows: L1RecordRow[]): IMemoryStore {
  return { isDegraded: () => false, queryL1Records: async () => rows } as unknown as IMemoryStore;
}

/**
 * Fake tool-enabled LLM runner. It names the scene after the `memory-<name>`
 * marker of the batch and writes it through the storage tools it was given.
 */
function sceneWriter(calls: LLMRunParams[]): LLMRunner {
  return {
    run: async (params) => {
      calls.push(params);
      const name = /memory-(\w+)/.exec(params.prompt)?.[1] ?? "unknown";
      const body = formatSceneBlock(
        { created: "2026-10-01T00:00:00.000Z", updated: "2026-10-02T00:00:00.000Z", summary: `scene ${name}`, heat: 1 },
        `content ${name}`,
      );
      if (params.storage) {
        await params.storage.writeFile(`${params.storagePrefix ?? ""}${name}.md`, body);
      } else {
        await fs.mkdir(params.workspaceDir!, { recursive: true });
        await fs.writeFile(path.join(params.workspaceDir!, `${name}.md`), body);
      }
      return "";
    },
  };
}

interface Fixture {
  root: StorageAdapter;
  calls: LLMRunParams[];
  run: (rows: L1RecordRow[]) => Promise<unknown>;
}

async function localFixture(): Promise<Fixture> {
  const dataDir = await tmpDir();
  const root = new StorageAdapter(new LocalStorageBackend(await tmpDir()));
  const calls: LLMRunParams[] = [];
  const llmRunner = sceneWriter(calls);
  return {
    root,
    calls,
    run: (rows) => pf.createL2Runner({
      pluginDataDir: dataDir,
      cfg: cfg(),
      openclawConfig: {},
      vectorStore: l1Store(rows),
      logger,
      storage: root,
      llmRunner,
    })(SESSION_KEY),
  };
}

const scopeKey = (key: string) => `${SCOPE_DIR}/${key}`;
const readScope = (root: StorageAdapter, key: string) => root.readFile(scopeKey(key));
const scopeNames = (root: StorageAdapter, dir: string) => root.readdirNames(scopeKey(dir), ".md");
async function checkpoint(root: StorageAdapter, key: string): Promise<{ scenes_processed: number; memories_since_last_persona: number; total_memories_extracted: number } | null> {
  const raw = await readScope(root, key);
  return raw ? JSON.parse(raw) : null;
}

describe("createL2Runner with projects (local storage)", () => {
  it("extracts each project into its own prefix and keeps no-project memory in the root", async () => {
    const f = await localFixture();
    await f.root.writeFile(scopeKey("persona.md"), PERSONA);
    await f.root.writeFile(scopeKey(`project_personas/${A}.md`), "# Persona of A");
    await f.root.writeFile(scopeKey(`project_personas/${B}.md`), "# Persona of B");

    const result = await f.run([l1Row("alpha", A), l1Row("alpha", A), l1Row("beta", B), l1Row("plain")]);

    expect(result).toMatchObject({ latestCursor: expect.any(String) });
    expect(f.calls).toHaveLength(3);
    expect(await scopeNames(f.root, "scene_blocks/")).toEqual(["plain.md"]);
    expect(await scopeNames(f.root, `scene_blocks/projects/${A}/`)).toEqual(["alpha.md"]);
    expect(await scopeNames(f.root, `scene_blocks/projects/${B}/`)).toEqual(["beta.md"]);
    // The project batch carried both of its memories into one extraction call.
    expect(f.calls.map((c) => (c.prompt.match(/memory-alpha/g) ?? []).length)).toContain(2);

    // Per-project index and checkpoint live inside the project prefix.
    expect(await readScope(f.root, `.metadata/projects/${A}/scene_index.json`)).toContain("alpha.md");
    expect(await readScope(f.root, `.metadata/projects/${B}/scene_index.json`)).toContain("beta.md");
    expect((await checkpoint(f.root, `.metadata/projects/${A}/checkpoint.json`))?.memories_since_last_persona).toBe(2);
    expect((await checkpoint(f.root, `.metadata/projects/${B}/checkpoint.json`))?.memories_since_last_persona).toBe(1);

    // Scene navigation lands in the project persona, with project-relative paths.
    const personaA = (await readScope(f.root, `project_personas/${A}.md`))!;
    expect(personaA).toContain("# Persona of A");
    expect(personaA).toContain("scene_blocks/alpha.md");
    expect(personaA).not.toContain("beta");
    const personaB = (await readScope(f.root, `project_personas/${B}.md`))!;
    expect(personaB).toContain("scene_blocks/beta.md");
    expect(personaB).not.toContain("alpha");

    // The root index and navigation know the root scene only.
    expect(await readScope(f.root, ".metadata/scene_index.json")).toContain("plain.md");
    expect(await readScope(f.root, ".metadata/scene_index.json")).not.toContain("alpha");
    const root = (await readScope(f.root, "persona.md"))!;
    expect(root).toContain("scene_blocks/plain.md");
    expect(root).not.toContain("alpha");
    expect(root).not.toContain("beta");
  });

  it("extracts a memory with an invalid project hash into the root instead of failing the run", async () => {
    const f = await localFixture();
    await f.root.writeFile(scopeKey("persona.md"), PERSONA);

    const result = await f.run([l1Row("gamma", "NOT-A-HASH")]);

    expect(result).toMatchObject({ latestCursor: expect.any(String) });
    expect(await scopeNames(f.root, "scene_blocks/")).toEqual(["gamma.md"]);
  });

  it("leaves the root persona and root scenes untouched by a project-only run, and advances the root counters", async () => {
    const f = await localFixture();
    await f.root.writeFile(scopeKey("persona.md"), PERSONA);
    await f.root.writeFile(scopeKey("scene_blocks/existing.md"), formatSceneBlock(
      { created: "2026-09-01T00:00:00.000Z", updated: "2026-09-02T00:00:00.000Z", summary: "existing", heat: 1 }, "existing body",
    ));
    const personaBefore = await readScope(f.root, "persona.md");
    const sceneBefore = await readScope(f.root, "scene_blocks/existing.md");

    await f.run([l1Row("alpha", A), l1Row("alpha", A), l1Row("alpha", A)]);

    expect(await readScope(f.root, "persona.md")).toBe(personaBefore);
    expect(await readScope(f.root, "scene_blocks/existing.md")).toBe(sceneBefore);
    expect(await scopeNames(f.root, "scene_blocks/")).toEqual(["existing.md"]);
    expect(await readScope(f.root, ".metadata/scene_index.json")).toBeNull();

    // Persona trigger reads the root checkpoint: P4 counter and the scene counter used by cold start.
    const rootCheckpoint = await checkpoint(f.root, ".metadata/checkpoint.json");
    expect(rootCheckpoint).toMatchObject({ memories_since_last_persona: 3, scenes_processed: 1 });
    const projectCheckpoint = await checkpoint(f.root, `.metadata/projects/${A}/checkpoint.json`);
    expect(projectCheckpoint).toMatchObject({ memories_since_last_persona: 3, scenes_processed: 1 });

    await f.run([l1Row("alpha", A)]);
    expect(await checkpoint(f.root, ".metadata/checkpoint.json")).toMatchObject({ memories_since_last_persona: 4, scenes_processed: 2 });
  });

  it("a later user-global extraction does not list, merge, rewrite or delete project scenes", async () => {
    const f = await localFixture();
    await f.run([l1Row("alpha", A)]);
    // An empty file and a soft-delete marker would be removed by the root cleanup if it could see them.
    await f.root.writeFile(scopeKey(`scene_blocks/projects/${A}/empty.md`), "");
    await f.root.writeFile(scopeKey(`scene_blocks/projects/${A}/marked.md`), "[DELETED]");
    const alphaBefore = await readScope(f.root, `scene_blocks/projects/${A}/alpha.md`);
    const indexBefore = await readScope(f.root, `.metadata/projects/${A}/scene_index.json`);
    f.calls.length = 0;

    await f.run([l1Row("plain")]);

    expect(f.calls).toHaveLength(1);
    // The root prompt does not mention the project scene.
    expect(f.calls[0].prompt).not.toContain("alpha");
    expect(f.calls[0].systemPrompt ?? "").not.toContain("alpha");
    expect(await scopeNames(f.root, "scene_blocks/")).toEqual(["plain.md"]);
    expect(await readScope(f.root, `scene_blocks/projects/${A}/alpha.md`)).toBe(alphaBefore);
    expect(await f.root.exists(scopeKey(`scene_blocks/projects/${A}/empty.md`))).toBe(true);
    expect(await f.root.exists(scopeKey(`scene_blocks/projects/${A}/marked.md`))).toBe(true);
    expect(await readScope(f.root, `.metadata/projects/${A}/scene_index.json`)).toBe(indexBefore);
  });

  it("scopes the LLM file tools to the project prefix", async () => {
    const f = await localFixture();
    await f.run([l1Row("alpha", A)]);

    const params = f.calls[0];
    expect(params.storagePrefix).toBe("scene_blocks/");
    // A key written through the tools reaches the project prefix, never the root.
    await params.storage!.writeFile("scene_blocks/probe.md", "probe");
    expect(await f.root.exists(scopeKey(`scene_blocks/projects/${A}/probe.md`))).toBe(true);
    expect(await f.root.exists(scopeKey("scene_blocks/probe.md"))).toBe(false);
    await expect(params.storage!.writeFile("scene_blocks/../../persona.md", "x")).rejects.toThrow(/traversal/i);
  });
});

describe("createL2Runner with projects (no storage adapter)", () => {
  it("falls back to one user-global extraction for all memories", async () => {
    const dataDir = await tmpDir();
    const calls: LLMRunParams[] = [];
    const runner = pf.createL2Runner({
      pluginDataDir: dataDir,
      cfg: cfg(),
      openclawConfig: {},
      vectorStore: l1Store([l1Row("alpha", A), l1Row("beta", B), l1Row("plain")]),
      logger,
      llmRunner: sceneWriter(calls),
    });

    await runner(SESSION_KEY);

    // One batch, as before projects existed; no project directory is created.
    expect(calls).toHaveLength(1);
    const scopeDir = path.join(dataDir, "profiles", encodeURIComponent(SCOPE));
    const entries = await fs.readdir(scopeDir);
    expect(entries).not.toContain("projects");
    expect(await fs.readdir(path.join(scopeDir, "scene_blocks"))).toHaveLength(1);
  });
});

describe("createL2Runner with projects (row-view storage)", () => {
  it("writes project scenes as prefixed rows and keeps project metadata on the others leg", async () => {
    const isolation = { teamId: "team-1", agentId: "agent-1" };
    const fake = new FakeProfileRowStore();
    const othersDir = await tmpDir();
    const composite = new StorageAdapter(new CompositeStorageBackend({
      profileBackend: new ProfileRowStorageBackend({ store: fake.asStore(), isolation }),
      others: new LocalStorageBackend(othersDir),
    }));
    const rowView = new StorageAdapter(new ProfileRowStorageBackend({ store: fake.asStore(), isolation }));
    await rowView.writeFile("persona.md", PERSONA);
    await rowView.writeFile(`project_personas/${A}.md`, "# Persona of A");
    const calls: LLMRunParams[] = [];

    await pf.createL2Runner({
      pluginDataDir: await tmpDir(),
      cfg: cfg(),
      openclawConfig: {},
      vectorStore: l1Store([l1Row("alpha", A), l1Row("plain")]),
      logger,
      storage: composite,
      llmRunner: sceneWriter(calls),
    })(SESSION_KEY);

    const rows = (await fake.pullProfiles()).map((r) => `${r.type}:${r.filename}`).sort();
    expect(rows).toEqual([
      "l2:plain.md",
      `l2:projects/${A}/alpha.md`,
      "l3:persona.md",
      `l3:project_personas/${A}.md`,
    ]);
    // The root run updates the root navigation with the root scene only.
    const rootPersona = (await rowView.readFile("persona.md"))!;
    expect(rootPersona).toContain("scene_blocks/plain.md");
    expect(rootPersona).not.toContain("alpha");
    expect(await rowView.readFile(`project_personas/${A}.md`)).toContain("scene_blocks/alpha.md");
    const others = new LocalStorageBackend(othersDir);
    expect(await others.exists(`.metadata/projects/${A}/checkpoint.json`)).toBe(true);
    // Root extraction sees only the root scene.
    expect(calls.some((c) => c.prompt.includes("memory-plain") && !c.prompt.includes("alpha"))).toBe(true);
  });
});
