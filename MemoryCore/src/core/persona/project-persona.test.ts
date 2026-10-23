import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatSceneBlock } from "../scene/scene-format.js";
import { syncSceneIndex } from "../scene/scene-index.js";
import { StorageAdapter } from "../storage/adapter.js";
import { LocalStorageBackend } from "../storage/local-backend.js";
import { createAllProjectsSceneView, createProjectScopedStorage } from "../storage/project-scoped-storage.js";
import type { LLMRunParams, LLMRunner } from "../types.js";
import { PersonaGenerator } from "./persona-generator.js";
import { PersonaTrigger } from "./persona-trigger.js";
import { USER_GLOBAL_SCOPE_MARKER } from "./user-global-scope.js";

const A = "0123456789abcdef";
const CLEAN_PERSONA = "# User Narrative Profile\n\n- Prefers evidence before conclusions.";

function scene(summary: string): string {
  return formatSceneBlock(
    { created: "2026-10-01T00:00:00.000Z", updated: "2026-10-02T00:00:00.000Z", summary, heat: 1 },
    `Body of ${summary}`,
  );
}

let dir: string;
let base: StorageAdapter;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "project-persona-"));
  base = new StorageAdapter(new LocalStorageBackend(dir));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function seedProjectScene(): Promise<void> {
  const project = createProjectScopedStorage(base, A);
  await project.writeFile("scene_blocks/cache-layer.md", scene("cache layer design"));
  await syncSceneIndex("", project);
}

async function seedRootScene(): Promise<void> {
  await base.writeFile("scene_blocks/shell-habits.md", scene("shell habits"));
  await syncSceneIndex("", base);
}

describe("PersonaTrigger with project scenes", () => {
  const trigger = () => new PersonaTrigger({ dataDir: "", interval: 50, storage: base });

  it("does not cold-start without any scene file", async () => {
    await base.writeFile(".metadata/checkpoint.json", JSON.stringify({ scenes_processed: 1 }));
    // P3 needs memories_since_last_persona > 0, so nothing fires here.
    await expect(trigger().shouldGenerate()).resolves.toMatchObject({ should: false });
  });

  it("cold-starts the user-global persona when only project scenes exist", async () => {
    await seedProjectScene();
    await base.writeFile(".metadata/checkpoint.json", JSON.stringify({ scenes_processed: 1 }));

    const result = await trigger().shouldGenerate();

    expect(result.should).toBe(true);
    expect(result.reason).toContain("冷启动");
  });

  it("migrates a persona without scope marker when only project scenes exist", async () => {
    await seedProjectScene();
    await base.writeFile("persona.md", "# Legacy persona without a scope marker");
    await base.writeFile(".metadata/checkpoint.json", JSON.stringify({ scenes_processed: 5, last_persona_at: 1, last_persona_time: "2026-10-01T00:00:00.000Z" }));

    const result = await trigger().shouldGenerate();

    expect(result.should).toBe(true);
    expect(result.reason).toContain("迁移");
  });
});

describe("PersonaGenerator over the all-projects scene view", () => {
  /** Tool-enabled runner stand-in: writes the persona through the storage it receives. */
  function writerRunner(): LLMRunner & { calls: LLMRunParams[] } {
    const calls: LLMRunParams[] = [];
    return {
      calls,
      run: vi.fn(async (params: LLMRunParams) => {
        calls.push(params);
        await params.storage!.writeFile(`${params.storagePrefix ?? ""}persona.md`, `${CLEAN_PERSONA}\n${" ".repeat(calls.length)}`);
        return "";
      }),
    };
  }

  const judge: LLMRunner = { run: vi.fn(async () => '{"leaks": []}') };

  it("reads root and project scenes, writes the root persona, and lists only root scenes in the navigation", async () => {
    await seedRootScene();
    await seedProjectScene();
    const runner = writerRunner();
    const generator = new PersonaGenerator({
      dataDir: "",
      config: {},
      llmRunner: runner,
      scopeJudge: judge,
      storage: createAllProjectsSceneView(base),
    });

    const result = await generator.generateLocalPersona("test");

    expect(result).toBe("generated");
    const prompt = runner.calls[0].prompt;
    expect(prompt).toContain("shell-habits.md");
    expect(prompt).toContain(`projects/${A}/cache-layer.md`);
    expect(prompt).toContain("Body of cache layer design");

    const persona = (await base.readFile("persona.md"))!;
    expect(persona.startsWith(USER_GLOBAL_SCOPE_MARKER)).toBe(true);
    expect(persona).toContain("scene_blocks/shell-habits.md");
    expect(persona).not.toContain("cache-layer");
    expect(persona).not.toContain("projects/");
    // The project persona slot stays empty.
    expect(await base.exists(`project_personas/${A}.md`)).toBe(false);
  });
});
