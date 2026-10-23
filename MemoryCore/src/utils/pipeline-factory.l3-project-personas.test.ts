/**
 * The L3 runner writes one memory document per project, after the user-global
 * persona of the same profile scope. These tests run the real trigger, the
 * real generator and the real storage views with a fake tool-enabled LLM
 * runner that writes through the storage it receives.
 */

import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as pf from "./pipeline-factory.js";
import type { PipelineLogger } from "./pipeline-factory.js";
import { formatSceneBlock } from "../core/scene/scene-format.js";
import { syncSceneIndex } from "../core/scene/scene-index.js";
import { FakeProfileRowStore } from "../core/storage/__contract__/fake-profile-row-store.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { CompositeStorageBackend } from "../core/storage/composite-backend.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";
import { ProfileRowStorageBackend } from "../core/storage/profile-row-backend.js";
import { createProjectScopedStorage } from "../core/storage/project-scoped-storage.js";
import { USER_GLOBAL_SCOPE_MARKER } from "../core/persona/user-global-scope.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { LLMRunParams, LLMRunner } from "../core/types.js";

const A = "0123456789abcdef";
const B = "fedcba9876543210";
const SCOPE = "team:team-1|agent:agent-1";
const OTHER_SCOPE = "team:team-1|agent:agent-2";
const SCOPE_DIR = `profiles/${encodeURIComponent(SCOPE)}`;
const OTHER_SCOPE_DIR = `profiles/${encodeURIComponent(OTHER_SCOPE)}`;
const ROOT_PERSONA = "# User Narrative Profile\n\n- Prefers evidence before conclusions.";
// File names, a path and a version: the user-global scope check would reject this text.
const PROJECT_DOC = "# Project Memory\n\nEntry point src/index.ts, release v1.2.3.";

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})));
});
async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "l3-project-personas-"));
  tmpDirs.push(dir);
  return dir;
}

interface LoggedLine { level: string; text: string }
function makeLogger(lines: LoggedLine[]): PipelineLogger {
  const at = (level: string) => (text: string) => { lines.push({ level, text }); };
  return { info: at("info"), warn: at("warn"), error: at("error"), debug: () => {} };
}

function scene(summary: string): string {
  return formatSceneBlock(
    { created: "2026-10-01T00:00:00.000Z", updated: "2026-10-02T00:00:00.000Z", summary, heat: 1 },
    `Body of ${summary}`,
  );
}

type CheckpointFields = { last_persona_time?: string; memories_since_last_persona?: number; scenes_processed?: number; total_processed?: number };

async function seedScope(
  rootDir: string,
  scopeDir: string,
  opts: { rootCheckpoint?: CheckpointFields; projects: Record<string, { tag: string; checkpoint?: CheckpointFields }> },
): Promise<StorageAdapter> {
  const scope = new StorageAdapter(new LocalStorageBackend(path.join(rootDir, scopeDir)));
  await scope.writeFile("scene_blocks/root-habits.md", scene("root habits"));
  await syncSceneIndex("", scope);
  await scope.writeFile(
    ".metadata/checkpoint.json",
    JSON.stringify({ scenes_processed: 1, memories_since_last_persona: 2, ...opts.rootCheckpoint }),
  );
  for (const [hash, { tag, checkpoint }] of Object.entries(opts.projects)) {
    const project = createProjectScopedStorage(scope, hash);
    await project.writeFile("scene_blocks/work.md", scene(`scene of ${tag}`));
    await syncSceneIndex("", project);
    await project.writeFile(
      ".metadata/checkpoint.json",
      JSON.stringify({ scenes_processed: 1, memories_since_last_persona: 2, ...checkpoint }),
    );
  }
  return scope;
}

interface Harness {
  rootDir: string;
  root: StorageAdapter;
  calls: LLMRunParams[];
  judgeCalls: number;
  lines: LoggedLine[];
  runner: LLMRunner;
}

/**
 * Runner stand-in. A call is a project call when it received the project
 * system prompt. `failFor` makes a project call throw; `failRoot` makes the
 * user-global call write nothing.
 */
async function makeHarness(opts: { failFor?: string[]; failRoot?: boolean } = {}): Promise<Harness> {
  const rootDir = await tmpDir();
  const root = new StorageAdapter(new LocalStorageBackend(rootDir));
  const harness: Harness = {
    rootDir, root, calls: [], judgeCalls: 0, lines: [],
    runner: {
      run: async (params) => {
        harness.calls.push(params);
        const isProject = params.systemPrompt!.includes("Project Memory Architect");
        if (isProject) {
          const tag = /scene of (\w)/.exec(params.prompt)?.[1] ?? "?";
          if (opts.failFor?.includes(tag)) throw new Error(`LLM failure for project ${tag}`);
          await params.storage!.writeFile(`${params.storagePrefix ?? ""}persona.md`, `${PROJECT_DOC}\nProject ${tag}`);
        } else if (!opts.failRoot) {
          await params.storage!.writeFile(`${params.storagePrefix ?? ""}persona.md`, ROOT_PERSONA);
        }
        return "";
      },
    },
  };
  return harness;
}

function runL3(
  h: Harness,
  extra: { context?: Parameters<ReturnType<typeof pf.createL3Runner>>[0]; vectorStore?: IMemoryStore; judge?: LLMRunner; diagnostics?: "metadata" } = {},
): Promise<void> {
  const judge: LLMRunner = extra.judge ?? {
    run: async () => { h.judgeCalls += 1; return '{"leaks": []}'; },
  };
  return pf.createL3Runner({
    pluginDataDir: h.rootDir,
    cfg: {
      persona: {
        model: "test-model",
        promptMode: "chat",
        triggerEveryN: 50,
        backupCount: 1,
        jev: { diagnostics: { mode: extra.diagnostics ?? "off" } },
      },
    } as never,
    openclawConfig: {},
    vectorStore: extra.vectorStore,
    logger: makeLogger(h.lines),
    storage: h.root,
    llmRunner: h.runner,
    scopeJudgeRunner: judge,
  })(extra.context);
}

/** Every file below `dir`, recursively. */
async function collectFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? collectFiles(full) : [full];
  }));
  return nested.flat();
}

const projectCalls = (h: Harness) => h.calls.filter((c) => c.systemPrompt!.includes("Project Memory Architect"));
const rootCalls = (h: Harness) => h.calls.filter((c) => !c.systemPrompt!.includes("Project Memory Architect"));

async function cp(scope: StorageAdapter, key: string): Promise<CheckpointFields & { last_persona_time: string }> {
  return JSON.parse((await scope.readFile(key))!);
}

describe("createL3Runner project personas", () => {
  it("writes one document per project from its own scenes and keeps the root persona user-global", async () => {
    const h = await makeHarness();
    const scope = await seedScope(h.rootDir, SCOPE_DIR, { projects: { [A]: { tag: "A" }, [B]: { tag: "B" } } });

    await runL3(h);

    // One user-global run, then one run per project.
    expect(rootCalls(h)).toHaveLength(1);
    expect(projectCalls(h)).toHaveLength(2);
    expect(h.calls.indexOf(rootCalls(h)[0])).toBeLessThan(h.calls.indexOf(projectCalls(h)[0]));

    const docA = (await scope.readFile(`project_personas/${A}.md`))!;
    const docB = (await scope.readFile(`project_personas/${B}.md`))!;
    expect(docA).toBe(`${PROJECT_DOC}\nProject A`);
    expect(docB).toBe(`${PROJECT_DOC}\nProject B`);
    const callA = projectCalls(h).find((c) => c.prompt.includes("scene of A"))!;
    const callB = projectCalls(h).find((c) => c.prompt.includes("scene of B"))!;
    expect(callA.prompt).not.toContain("scene of B");
    expect(callB.prompt).not.toContain("scene of A");
    expect(callA.prompt).not.toContain("root habits");

    // The root persona is still generated with the scope check and its marker, and holds no project text.
    const persona = (await scope.readFile("persona.md"))!;
    expect(persona.startsWith(USER_GLOBAL_SCOPE_MARKER)).toBe(true);
    expect(persona).toContain("Prefers evidence");
    expect(persona).not.toContain("Project");
    expect(rootCalls(h)[0].prompt).toContain("scene of A");
    // The judge ran for the user-global persona only.
    expect(h.judgeCalls).toBe(1);
    // Project documents carry no marker.
    expect(docA).not.toContain("agent-memory:scope");
  });

  it("advances the checkpoint of each project that ran, and the root one", async () => {
    const h = await makeHarness();
    const scope = await seedScope(h.rootDir, SCOPE_DIR, { projects: { [A]: { tag: "A" }, [B]: { tag: "B" } } });

    await runL3(h);

    for (const hash of [A, B]) {
      const project = await cp(scope, `.metadata/projects/${hash}/checkpoint.json`);
      expect(project.last_persona_time).not.toBe("");
      expect(project.memories_since_last_persona).toBe(0);
    }
    expect((await cp(scope, ".metadata/checkpoint.json")).last_persona_time).not.toBe("");
  });

  it("does not regenerate anything on a second run", async () => {
    const h = await makeHarness();
    await seedScope(h.rootDir, SCOPE_DIR, { projects: { [A]: { tag: "A" }, [B]: { tag: "B" } } });
    await runL3(h);
    const callsAfterFirstRun = h.calls.length;

    await runL3(h);

    // The project documents have no scope marker; that must not look like a pending migration.
    expect(h.calls.length).toBe(callsAfterFirstRun);
  });

  it("applies the trigger rules per project", async () => {
    const h = await makeHarness();
    // Root persona already accepted and its checkpoint is quiet, so only projects can trigger.
    const scope = await seedScope(h.rootDir, SCOPE_DIR, {
      rootCheckpoint: { scenes_processed: 5, memories_since_last_persona: 0, last_persona_time: "2026-10-01T12:00:00.000Z" } as CheckpointFields,
      projects: {
        // Cold start: scenes extracted, no document yet.
        [A]: { tag: "A" },
        // Document exists, below the threshold: no run.
        [B]: { tag: "B", checkpoint: { scenes_processed: 5, memories_since_last_persona: 10, last_persona_time: "2026-10-01T12:00:00.000Z" } },
      },
    });
    await scope.writeFile("persona.md", `${USER_GLOBAL_SCOPE_MARKER}\n${ROOT_PERSONA}`);
    await scope.writeFile(`project_personas/${B}.md`, "# Project Memory\n\nOld B");

    await runL3(h);

    // The user-global run did not trigger, but the project runs still happened.
    expect(rootCalls(h)).toHaveLength(0);
    expect(projectCalls(h)).toHaveLength(1);
    expect(projectCalls(h)[0].prompt).toContain("scene of A");
    expect(await scope.readFile(`project_personas/${B}.md`)).toBe("# Project Memory\n\nOld B");
    expect((await cp(scope, `.metadata/projects/${B}/checkpoint.json`)).memories_since_last_persona).toBe(10);

    // Raise B over the threshold and run again: only B runs.
    await scope.writeFile(
      `.metadata/projects/${B}/checkpoint.json`,
      JSON.stringify({ scenes_processed: 6, memories_since_last_persona: 50, last_persona_time: "2026-10-01T12:00:00.000Z" }),
    );
    h.calls.length = 0;
    await runL3(h);

    expect(projectCalls(h)).toHaveLength(1);
    expect(projectCalls(h)[0].prompt).toContain("scene of B");
    expect(projectCalls(h)[0].prompt).toContain("Old B");
    expect(projectCalls(h)[0].prompt).toContain("达到阈值");
    expect(await scope.readFile(`project_personas/${B}.md`)).toBe(`${PROJECT_DOC}\nProject B`);
  });

  it("honors an explicit persona update request of a project", async () => {
    const h = await makeHarness();
    const scope = await seedScope(h.rootDir, SCOPE_DIR, {
      rootCheckpoint: { scenes_processed: 5, memories_since_last_persona: 0, last_persona_time: "2026-10-01T12:00:00.000Z" } as CheckpointFields,
      projects: {
        [A]: {
          tag: "A",
          checkpoint: { scenes_processed: 5, memories_since_last_persona: 0, last_persona_time: "2026-10-01T12:00:00.000Z", request_persona_update: true } as CheckpointFields,
        },
      },
    });
    await scope.writeFile("persona.md", `${USER_GLOBAL_SCOPE_MARKER}\n${ROOT_PERSONA}`);
    await scope.writeFile(`project_personas/${A}.md`, "# Project Memory\n\nOld A");

    await runL3(h);

    expect(projectCalls(h)).toHaveLength(1);
    const after = await cp(scope, `.metadata/projects/${A}/checkpoint.json`) as CheckpointFields & { request_persona_update?: boolean };
    expect(after.request_persona_update).toBe(false);
  });

  it("keeps the other projects and the root running when one project fails, and leaves its checkpoint", async () => {
    const h = await makeHarness({ failFor: ["A"] });
    const scope = await seedScope(h.rootDir, SCOPE_DIR, { projects: { [A]: { tag: "A" }, [B]: { tag: "B" } } });

    await expect(runL3(h)).resolves.toBeUndefined();

    expect(await scope.exists(`project_personas/${A}.md`)).toBe(false);
    expect(await scope.readFile(`project_personas/${B}.md`)).toBe(`${PROJECT_DOC}\nProject B`);
    expect((await scope.readFile("persona.md"))!.startsWith(USER_GLOBAL_SCOPE_MARKER)).toBe(true);
    // The failed project can run again: its checkpoint did not move.
    const failed = await cp(scope, `.metadata/projects/${A}/checkpoint.json`);
    expect(failed.last_persona_time ?? "").toBe("");
    expect(failed.memories_since_last_persona).toBe(2);
    expect(h.lines.some((l) => l.level === "error" && l.text.includes(`project=${A}`))).toBe(true);
  });

  it("keeps the checkpoint of a project whose model wrote nothing", async () => {
    const h = await makeHarness();
    const scope = await seedScope(h.rootDir, SCOPE_DIR, { projects: { [A]: { tag: "A" } } });
    h.runner = { run: async (params) => { h.calls.push(params); if (!params.systemPrompt!.includes("Project Memory Architect")) await params.storage!.writeFile("persona.md", ROOT_PERSONA); return ""; } };

    await expect(runL3(h)).resolves.toBeUndefined();

    expect(await scope.exists(`project_personas/${A}.md`)).toBe(false);
    expect((await cp(scope, `.metadata/projects/${A}/checkpoint.json`)).memories_since_last_persona).toBe(2);
  });

  it("throws at once when the user-global run fails and starts no project run", async () => {
    const h = await makeHarness({ failRoot: true });
    const scope = await seedScope(h.rootDir, SCOPE_DIR, { projects: { [A]: { tag: "A" } } });

    await expect(runL3(h)).rejects.toThrow(/Persona generation failed/);

    expect(projectCalls(h)).toHaveLength(0);
    expect(await scope.exists(`project_personas/${A}.md`)).toBe(false);
    expect((await cp(scope, `.metadata/projects/${A}/checkpoint.json`)).memories_since_last_persona).toBe(2);
  });

  it("stops everything when the task is aborted", async () => {
    const h = await makeHarness();
    const scope = await seedScope(h.rootDir, SCOPE_DIR, { projects: { [A]: { tag: "A" } } });
    const controller = new AbortController();
    controller.abort(new Error("task aborted"));

    await expect(runL3(h, { context: { signal: controller.signal } as never })).rejects.toThrow("task aborted");

    expect(h.calls).toHaveLength(0);
    expect(await scope.exists(`project_personas/${A}.md`)).toBe(false);
  });

  it("leaves the user-global checkpoint unchanged when the task aborts during generation", async () => {
    const h = await makeHarness();
    const scope = await seedScope(h.rootDir, SCOPE_DIR, { projects: { [A]: { tag: "A" } } });
    const controller = new AbortController();
    const inner = h.runner;
    h.runner = { run: async (params) => { const out = await inner.run(params); controller.abort(new Error("task aborted")); return out; } };

    await expect(runL3(h, { context: { signal: controller.signal } as never })).rejects.toThrow("task aborted");

    const root = await cp(scope, ".metadata/checkpoint.json");
    expect(root.last_persona_time ?? "").toBe("");
    expect(root.memories_since_last_persona).toBe(2);
    expect(projectCalls(h)).toHaveLength(0);
  });

  it("leaves a project checkpoint unchanged when the task aborts during its generation", async () => {
    const h = await makeHarness();
    const scope = await seedScope(h.rootDir, SCOPE_DIR, {
      rootCheckpoint: { scenes_processed: 5, memories_since_last_persona: 0, last_persona_time: "2026-10-01T12:00:00.000Z" } as CheckpointFields,
      projects: { [A]: { tag: "A" }, [B]: { tag: "B" } },
    });
    await scope.writeFile("persona.md", `${USER_GLOBAL_SCOPE_MARKER}\n${ROOT_PERSONA}`);
    const controller = new AbortController();
    const inner = h.runner;
    h.runner = { run: async (params) => { const out = await inner.run(params); controller.abort(new Error("task aborted")); return out; } };

    await expect(runL3(h, { context: { signal: controller.signal } as never })).rejects.toThrow("task aborted");

    // The first project ran and was aborted; the second never started.
    expect(projectCalls(h)).toHaveLength(1);
    const first = await cp(scope, `.metadata/projects/${A}/checkpoint.json`);
    expect(first.last_persona_time ?? "").toBe("");
    expect(first.memories_since_last_persona).toBe(2);
    expect((await cp(scope, `.metadata/projects/${B}/checkpoint.json`)).memories_since_last_persona).toBe(2);
  });

  it("stays inside the originating scope for a task-scoped run", async () => {
    const h = await makeHarness();
    const scope = await seedScope(h.rootDir, SCOPE_DIR, { projects: { [A]: { tag: "A" } } });
    const other = await seedScope(h.rootDir, OTHER_SCOPE_DIR, { projects: { [B]: { tag: "B" } } });

    await runL3(h, { context: { teamId: "team-1", agentId: "agent-1", userId: "user-1" } as never });

    expect(await scope.exists(`project_personas/${A}.md`)).toBe(true);
    expect(await other.exists(`project_personas/${B}.md`)).toBe(false);
    expect(await other.exists("persona.md")).toBe(false);
  });

  it("walks every scope for an in-process run without a task", async () => {
    const h = await makeHarness();
    const scope = await seedScope(h.rootDir, SCOPE_DIR, { projects: { [A]: { tag: "A" } } });
    const other = await seedScope(h.rootDir, OTHER_SCOPE_DIR, { projects: { [B]: { tag: "B" } } });

    await runL3(h);

    expect(await scope.exists(`project_personas/${A}.md`)).toBe(true);
    expect(await other.exists(`project_personas/${B}.md`)).toBe(true);
  });

  it("emits checkpoint diagnostics with the project hash only for project runs", async () => {
    const h = await makeHarness();
    await seedScope(h.rootDir, SCOPE_DIR, { projects: { [A]: { tag: "A" } } });

    await runL3(h, { diagnostics: "metadata" });

    const checkpointEvents = h.lines
      .filter((l) => l.text.includes('"event":"memory.l3.checkpoint"'))
      .map((l) => JSON.parse(l.text.slice(l.text.indexOf("{"))) as Record<string, unknown>);
    const projectEvent = checkpointEvents.filter((e) => e.project_hash === A);
    expect(projectEvent).toHaveLength(1);
    expect(projectEvent[0]).toMatchObject({ generator_result: "generated", advance_reason: "generation_succeeded" });
    const rootEvent = checkpointEvents.filter((e) => e.project_hash === undefined);
    expect(rootEvent).toHaveLength(1);
  });

  it("records the project variant, not the prompt mode, in the project generation log", async () => {
    const h = await makeHarness();
    await seedScope(h.rootDir, SCOPE_DIR, { projects: { [A]: { tag: "A" } } });
    const fake = Object.assign(new FakeProfileRowStore(), { isDegraded: () => false });
    // The profile store makes the runs produce changed profiles, which is when a generation log is written.
    await runL3(h, { vectorStore: fake as unknown as IMemoryStore });

    const logs = (await collectFiles(h.rootDir))
      .filter((file) => path.basename(file).includes("lid=mgl_l3_") && !file.endsWith(".meta.json"))
      .map((file) => JSON.parse(readFileSync(file, "utf-8")) as { prompt_mode?: string; variant?: string; output_refs: Array<{ record_id: string }> });
    expect(logs).toHaveLength(2);
    const projectLog = logs.find((l) => l.variant === "project")!;
    expect(projectLog).toBeDefined();
    expect(projectLog.prompt_mode).toBeUndefined();
    const rootLog = logs.find((l) => l.variant === undefined)!;
    expect(rootLog.prompt_mode).toBe("chat");
  });

  it("skips a project without scene files and does nothing for a scope without projects", async () => {
    const h = await makeHarness();
    const scope = await seedScope(h.rootDir, SCOPE_DIR, { projects: {} });

    await runL3(h);

    expect(rootCalls(h)).toHaveLength(1);
    expect(projectCalls(h)).toHaveLength(0);
    expect(await scope.exists("project_personas")).toBe(false);
  });

  it("stores the project document as a project row next to the user-global row (row backend)", async () => {
    const fake = Object.assign(new FakeProfileRowStore(), { isDegraded: () => false });
    const isolation = { teamId: "team-1", agentId: "agent-1" };
    const othersDir = await tmpDir();
    const composite = new StorageAdapter(new CompositeStorageBackend({
      profileBackend: new ProfileRowStorageBackend({ store: fake.asStore(), isolation }),
      others: new LocalStorageBackend(othersDir),
    }));
    const rowView = new StorageAdapter(new ProfileRowStorageBackend({ store: fake.asStore(), isolation }));
    await rowView.writeFile("scene_blocks/root-habits.md", scene("root habits"));
    await rowView.writeFile(`scene_blocks/projects/${A}/work.md`, scene("scene of A"));
    const others = new LocalStorageBackend(othersDir);
    await others.putObject(".metadata/checkpoint.json", JSON.stringify({ scenes_processed: 1, memories_since_last_persona: 2 }));
    await others.putObject(`.metadata/projects/${A}/checkpoint.json`, JSON.stringify({ scenes_processed: 1, memories_since_last_persona: 2 }));
    const h = await makeHarness();
    h.root = composite;

    // A service task always names its agent; row scopes are bound from it.
    await runL3(h, {
      vectorStore: fake as unknown as IMemoryStore,
      context: { teamId: "team-1", agentId: "agent-1", userId: "user-1" } as never,
    });

    expect(projectCalls(h)).toHaveLength(1);
    const rows = (await fake.pullProfiles()).map((r) => `${r.type}:${r.filename}`).sort();
    expect(rows).toEqual([
      "l2:projects/" + A + "/work.md",
      "l2:root-habits.md",
      "l3:persona.md",
      `l3:project_personas/${A}.md`,
    ]);
    expect((await fake.pullProfiles()).find((r) => r.filename === `project_personas/${A}.md`)).toMatchObject({ teamId: "team-1", agentId: "agent-1" });
    expect(await rowView.readFile(`project_personas/${A}.md`)).toBe(`${PROJECT_DOC}\nProject A`);
    const rootDoc = (await rowView.readFile("persona.md"))!;
    expect(rootDoc.startsWith(USER_GLOBAL_SCOPE_MARKER)).toBe(true);
    expect(rootDoc).not.toContain("Project");
    expect(JSON.parse((await others.getObject(`.metadata/projects/${A}/checkpoint.json`))!.content.toString()).last_persona_time).not.toBe("");
  });
});
