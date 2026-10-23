/**
 * The project variant of the L3 generator and trigger: the document lives in
 * the project's own key space, needs no user-global scope check and carries no
 * scope marker.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatSceneBlock } from "../scene/scene-format.js";
import { syncSceneIndex } from "../scene/scene-index.js";
import { StorageAdapter } from "../storage/adapter.js";
import { LocalStorageBackend } from "../storage/local-backend.js";
import { createProjectScopedStorage } from "../storage/project-scoped-storage.js";
import type { LLMRunParams, LLMRunner } from "../types.js";
import { PersonaGenerator } from "./persona-generator.js";
import { PersonaTrigger } from "./persona-trigger.js";
import {
  USER_GLOBAL_REJECTED_MARKER,
  USER_GLOBAL_SCOPE_MARKER,
} from "./user-global-scope.js";

const A = "0123456789abcdef";
const B = "fedcba9876543210";
// Holds a file name, a path and a version: the user-global scope check would reject it.
const PROJECT_DOC = "# Project Memory\n\nEntry point is src/index.ts, version v1.2.3, run `npm test`.";

function scene(summary: string): string {
  return formatSceneBlock(
    { created: "2026-10-01T00:00:00.000Z", updated: "2026-10-02T00:00:00.000Z", summary, heat: 1 },
    `Body of ${summary}`,
  );
}

let dir: string;
let scopeStore: StorageAdapter;
let project: StorageAdapter;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "project-persona-variant-"));
  scopeStore = new StorageAdapter(new LocalStorageBackend(dir));
  project = createProjectScopedStorage(scopeStore, A);
  await project.writeFile("scene_blocks/cache-layer.md", scene("cache layer design"));
  await syncSceneIndex("", project);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Tool-enabled runner stand-in that writes `content` to persona.md through the storage it gets. */
function writerRunner(content: string | ((call: number) => string)) {
  const calls: LLMRunParams[] = [];
  const runner: LLMRunner = {
    run: vi.fn(async (params: LLMRunParams) => {
      calls.push(params);
      const text = typeof content === "function" ? content(calls.length) : content;
      await params.storage!.writeFile(`${params.storagePrefix ?? ""}persona.md`, text);
      return "";
    }),
  };
  return { runner, calls };
}

function failingJudge() {
  return { run: vi.fn(async () => { throw new Error("the project variant must not call the judge"); }) } as LLMRunner & { run: ReturnType<typeof vi.fn> };
}

describe("PersonaGenerator project variant", () => {
  it("writes the project document without a judge call, a marker or navigation", async () => {
    const { runner, calls } = writerRunner(PROJECT_DOC);
    const judge = failingJudge();
    const generator = new PersonaGenerator({
      dataDir: "", config: {}, llmRunner: runner, scopeJudge: judge, storage: project, variant: "project",
    });

    await expect(generator.generateLocalPersona("test")).resolves.toBe("generated");

    expect(judge.run).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].systemPrompt).toContain("Project Memory Architect");
    expect(calls[0].prompt).toContain("Body of cache layer design");
    const doc = (await scopeStore.readFile(`project_personas/${A}.md`))!;
    expect(doc).toBe(PROJECT_DOC);
    expect(doc).not.toContain(USER_GLOBAL_SCOPE_MARKER);
    expect(doc).not.toContain("Scene Navigation");
    // The root persona slot is untouched.
    expect(await scopeStore.exists("persona.md")).toBe(false);
  });

  it("strips a scope marker and navigation that the model writes", async () => {
    const { runner } = writerRunner(
      `${USER_GLOBAL_SCOPE_MARKER}\n${PROJECT_DOC}\n\n${USER_GLOBAL_REJECTED_MARKER}`,
    );
    const generator = new PersonaGenerator({
      dataDir: "", config: {}, llmRunner: runner, scopeJudge: failingJudge(), storage: project, variant: "project",
    });

    await generator.generateLocalPersona("test");

    const doc = (await scopeStore.readFile(`project_personas/${A}.md`))!;
    expect(doc).not.toContain("agent-memory:scope");
    expect(doc).toContain("Entry point is");
  });

  it("keeps the text when the model puts a marker in front of it on the same line", async () => {
    const { runner } = writerRunner(`${USER_GLOBAL_SCOPE_MARKER} # Project Memory\n\nEntry point src/index.ts.`);
    const generator = new PersonaGenerator({
      dataDir: "", config: {}, llmRunner: runner, scopeJudge: failingJudge(), storage: project, variant: "project",
    });

    await generator.generateLocalPersona("test");

    expect(await scopeStore.readFile(`project_personas/${A}.md`)).toBe("# Project Memory\n\nEntry point src/index.ts.");
  });

  it("does not change the prompt with promptMode code", async () => {
    const chat = writerRunner(PROJECT_DOC);
    await new PersonaGenerator({
      dataDir: "", config: {}, llmRunner: chat.runner, storage: project, variant: "project", promptMode: "chat",
    }).generateLocalPersona("test");
    await scopeStore.unlink(`project_personas/${A}.md`);
    const code = writerRunner(PROJECT_DOC);
    await new PersonaGenerator({
      dataDir: "", config: {}, llmRunner: code.runner, storage: project, variant: "project", promptMode: "code",
    }).generateLocalPersona("test");

    expect(code.calls[0].systemPrompt).toBe(chat.calls[0].systemPrompt);
  });

  it("composes a custom memory prompt onto the project prompt", async () => {
    const { runner, calls } = writerRunner(PROJECT_DOC);
    const generator = new PersonaGenerator({
      dataDir: "", config: {}, llmRunner: runner, storage: project, variant: "project",
      memoryPrompt: { memory_prompt_id: "mp-1", prompt: "CUSTOM-RULE-XYZ", layer: "l3", source: "agent", version: 1 },
    });

    await generator.generateLocalPersona("test");

    expect(calls[0].systemPrompt).toContain("Project Memory Architect");
    expect(calls[0].systemPrompt).toContain("CUSTOM-RULE-XYZ");
  });

  it("updates an existing document incrementally even without a marker", async () => {
    await scopeStore.writeFile(`project_personas/${A}.md`, "# Project Memory\n\nOld decision body");
    const { runner, calls } = writerRunner("# Project Memory\n\nNew decision body");
    const generator = new PersonaGenerator({
      dataDir: "", config: {}, llmRunner: runner, storage: project, variant: "project",
    });

    await generator.generateLocalPersona("test");

    expect(calls[0].prompt).toContain("Old decision body");
    expect(calls[0].prompt).toContain("迭代更新");
    expect(await scopeStore.readFile(`project_personas/${A}.md`)).toBe("# Project Memory\n\nNew decision body");
  });

  it("keeps the backup and the checkpoint inside the project", async () => {
    await scopeStore.writeFile(`project_personas/${A}.md`, "# Project Memory\n\nOld body");
    const { runner } = writerRunner("# Project Memory\n\nNew body");
    const generator = new PersonaGenerator({
      dataDir: "", config: {}, llmRunner: runner, storage: project, variant: "project",
    });

    await generator.generateLocalPersona("test");
    await generator.generate("test");

    const backups = await scopeStore.readdirNames(`.backup/projects/${A}/persona/`, ".md");
    expect(backups.length).toBeGreaterThan(0);
    expect(await scopeStore.exists(".backup/persona")).toBe(false);
    expect(await scopeStore.exists(".metadata/checkpoint.json")).toBe(false);
  });

  it("reports a failed run when the model writes nothing", async () => {
    const runner: LLMRunner = { run: vi.fn(async () => "") };
    const generator = new PersonaGenerator({
      dataDir: "", config: {}, llmRunner: runner, storage: project, variant: "project",
    });

    await expect(generator.generateLocalPersona("test")).resolves.toBe("failed");
    expect(await scopeStore.exists(`project_personas/${A}.md`)).toBe(false);
  });

  it("reads only its own project's scenes", async () => {
    const other = createProjectScopedStorage(scopeStore, B);
    await other.writeFile("scene_blocks/secret.md", scene("secret of B"));
    await syncSceneIndex("", other);
    const { runner, calls } = writerRunner(PROJECT_DOC);

    await new PersonaGenerator({
      dataDir: "", config: {}, llmRunner: runner, storage: project, variant: "project",
    }).generateLocalPersona("test");

    expect(calls[0].prompt).toContain("cache-layer.md");
    expect(calls[0].prompt).not.toContain("secret");
  });
});

describe("PersonaTrigger project variant", () => {
  const trigger = (variant?: "project") =>
    new PersonaTrigger({ dataDir: "", interval: 50, storage: project, ...(variant ? { variant } : {}) });

  it("cold-starts on the project's own checkpoint and scenes", async () => {
    await project.writeFile(".metadata/checkpoint.json", JSON.stringify({ scenes_processed: 2 }));

    const result = await trigger("project").shouldGenerate();

    expect(result.should).toBe(true);
    expect(result.reason).toContain("冷启动");
  });

  it("does not fire without a project checkpoint, even when another scope has one", async () => {
    await scopeStore.writeFile(".metadata/checkpoint.json", JSON.stringify({ scenes_processed: 5, memories_since_last_persona: 99 }));

    await expect(trigger("project").shouldGenerate()).resolves.toMatchObject({ should: false });
  });

  it("does not run the scope migration for a document without a marker", async () => {
    await scopeStore.writeFile(`project_personas/${A}.md`, PROJECT_DOC);
    await project.writeFile(
      ".metadata/checkpoint.json",
      JSON.stringify({ scenes_processed: 5, last_persona_at: 3, last_persona_time: "2026-10-01T00:00:00.000Z" }),
    );

    // The user-global variant would regenerate here: no accepted marker.
    await expect(trigger().shouldGenerate()).resolves.toMatchObject({ should: true });
    await expect(trigger("project").shouldGenerate()).resolves.toMatchObject({ should: false });
  });

  it("fires at the threshold and on an explicit request", async () => {
    await scopeStore.writeFile(`project_personas/${A}.md`, PROJECT_DOC);
    await project.writeFile(
      ".metadata/checkpoint.json",
      JSON.stringify({ scenes_processed: 5, last_persona_at: 3, last_persona_time: "2026-10-01T00:00:00.000Z", memories_since_last_persona: 50 }),
    );
    expect((await trigger("project").shouldGenerate()).reason).toContain("达到阈值");

    await project.writeFile(
      ".metadata/checkpoint.json",
      JSON.stringify({ scenes_processed: 5, last_persona_at: 3, last_persona_time: "2026-10-01T00:00:00.000Z", request_persona_update: true, persona_update_reason: "new rules" }),
    );
    expect((await trigger("project").shouldGenerate()).reason).toContain("主动请求");
  });

  it("recovers a missing document that was generated before", async () => {
    await project.writeFile(
      ".metadata/checkpoint.json",
      JSON.stringify({ scenes_processed: 5, last_persona_at: 3, last_persona_time: "2026-10-01T00:00:00.000Z" }),
    );

    expect((await trigger("project").shouldGenerate()).reason).toContain("恢复");
  });
});
