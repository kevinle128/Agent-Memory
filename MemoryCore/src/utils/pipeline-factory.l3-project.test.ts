/**
 * The user-global L3 run builds the persona from the scenes of every project.
 * A user who works only inside projects has no scene file in the root, so the
 * run must still start and must still write the root persona, not a project one.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as pf from "./pipeline-factory.js";
import type { PipelineLogger } from "./pipeline-factory.js";
import { formatSceneBlock } from "../core/scene/scene-format.js";
import { syncSceneIndex } from "../core/scene/scene-index.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";
import { createProjectScopedStorage } from "../core/storage/project-scoped-storage.js";
import { USER_GLOBAL_SCOPE_MARKER } from "../core/persona/user-global-scope.js";
import type { LLMRunParams, LLMRunner } from "../core/types.js";

const logger: PipelineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const A = "0123456789abcdef";
const SCOPE = "team:team-1|agent:agent-1";
const SCOPE_DIR = `profiles/${encodeURIComponent(SCOPE)}`;
const PERSONA = "# User Narrative Profile\n\n- Prefers evidence before conclusions.";

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})));
});

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "l3-project-test-"));
  tmpDirs.push(dir);
  return dir;
}

function runL3(root: StorageAdapter, pluginDataDir: string, llmRunner: LLMRunner) {
  const judge: LLMRunner = { run: async () => '{"leaks": []}' };
  return pf.createL3Runner({
    pluginDataDir,
    cfg: {
      persona: {
        model: "test-model",
        promptMode: "chat",
        triggerEveryN: 50,
        backupCount: 1,
        jev: { diagnostics: { mode: "off" } },
      },
    } as never,
    openclawConfig: {},
    logger,
    storage: root,
    llmRunner,
    scopeJudgeRunner: judge,
  })();
}

describe("createL3Runner with project scenes", () => {
  it("generates the user-global persona for a user who works only inside projects", async () => {
    const rootDir = await tmpDir();
    const root = new StorageAdapter(new LocalStorageBackend(rootDir));
    const scope = new StorageAdapter(new LocalStorageBackend(path.join(rootDir, SCOPE_DIR)));
    const project = createProjectScopedStorage(scope, A);
    await project.writeFile("scene_blocks/cache-layer.md", formatSceneBlock(
      { created: "2026-10-01T00:00:00.000Z", updated: "2026-10-02T00:00:00.000Z", summary: "cache layer design", heat: 1 },
      "Body of the cache layer design",
    ));
    await syncSceneIndex("", project);
    // One project extraction has run: the scene counter that cold start reads is set.
    await scope.writeFile(".metadata/checkpoint.json", JSON.stringify({ scenes_processed: 1, memories_since_last_persona: 2 }));

    const calls: LLMRunParams[] = [];
    const llmRunner: LLMRunner = {
      run: async (params) => {
        calls.push(params);
        await params.storage!.writeFile(`${params.storagePrefix ?? ""}persona.md`, PERSONA);
        return "";
      },
    };

    await runL3(root, await tmpDir(), llmRunner);

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain(`projects/${A}/cache-layer.md`);
    expect(calls[0].prompt).toContain("Body of the cache layer design");
    const persona = (await scope.readFile("persona.md"))!;
    expect(persona.startsWith(USER_GLOBAL_SCOPE_MARKER)).toBe(true);
    // Navigation of the user-global persona lists no project scene.
    expect(persona).not.toContain("cache-layer");
    expect(await scope.exists(`project_personas/${A}.md`)).toBe(false);
    // The run advanced the user-global checkpoint, not the project one.
    const checkpoint = JSON.parse((await scope.readFile(".metadata/checkpoint.json"))!);
    expect(checkpoint.last_persona_time).not.toBe("");
    expect(await scope.exists(`.metadata/projects/${A}/checkpoint.json`)).toBe(false);
  });

  it("skips generation when neither the root nor a project has a scene", async () => {
    const root = new StorageAdapter(new LocalStorageBackend(await tmpDir()));
    // The persona threshold is reached, so the run gets past the trigger and stops at the empty-scene guard.
    await root.writeFile(`${SCOPE_DIR}/.metadata/checkpoint.json`, JSON.stringify({ scenes_processed: 1, memories_since_last_persona: 100 }));
    const calls: LLMRunParams[] = [];

    await runL3(root, await tmpDir(), { run: async (params) => { calls.push(params); return ""; } });

    expect(calls).toHaveLength(0);
  });
});
