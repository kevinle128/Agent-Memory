import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StorageAdapter } from "../storage/adapter.js";
import { LocalStorageBackend } from "../storage/local-backend.js";
import type { LLMRunParams, LLMRunner } from "../types.js";
import { MAX_INLINED_SCENE_CHARS, PersonaGenerator } from "./persona-generator.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import { PersonaTrigger } from "./persona-trigger.js";
import { USER_GLOBAL_REJECTED_MARKER, USER_GLOBAL_SCOPE_MARKER } from "./user-global-scope.js";

const LEGACY_PERSONA = "# User Narrative Profile\n\n> **Thông tin cơ bản**\n- Đang làm việc với Agent-Memory, quy trình video Shorts.";
const CLEAN_PERSONA = "# User Narrative Profile\n\n> **Sở thích dài hạn**\n- Ưu tiên bằng chứng quan sát được trước khi kết luận.";
const LEAKY_PERSONA = "# User Narrative Profile\n\n- Đang làm việc với Agent-Memory.";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "persona-scope-"));
  mkdirSync(path.join(dir, "scene_blocks"));
  mkdirSync(path.join(dir, ".metadata"));
  writeFileSync(path.join(dir, "scene_blocks", "agent-memory-local.md"), "-----META-START-----\nsummary: local run\n-----META-END-----\nRun Agent-Memory locally.");
  writeFileSync(path.join(dir, "scene_blocks", "video-pipeline.md"), "-----META-START-----\nsummary: video\n-----META-END-----\nBuild a Shorts pipeline.");
  writeFileSync(
    path.join(dir, ".metadata", "scene_index.json"),
    JSON.stringify([
      { filename: "agent-memory-local.md", summary: "Agent-Memory local run", heat: 1, created: "2026-10-01T00:00:00Z", updated: "2026-10-01T00:00:00Z" },
      { filename: "video-pipeline.md", summary: "Shorts video pipeline", heat: 1, created: "2026-10-01T00:00:00Z", updated: "2026-10-01T00:00:00Z" },
    ]),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writePersona = (content: string) => writeFileSync(path.join(dir, "persona.md"), content);
const readPersona = () => readFileSync(path.join(dir, "persona.md"), "utf-8");

/** Tool-enabled runner stand-in: each call writes the next persona body to persona.md. */
function writerRunner(bodies: string[]): LLMRunner & { calls: LLMRunParams[] } {
  const calls: LLMRunParams[] = [];
  return {
    calls,
    run: vi.fn(async (params: LLMRunParams) => {
      calls.push(params);
      const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
      // Different length on each write so the write marker always changes.
      writeFileSync(path.join(dir, "persona.md"), `${body}\n${" ".repeat(calls.length)}`);
      return "";
    }),
  };
}

function judge(...replies: string[]): LLMRunner {
  let i = 0;
  return { run: vi.fn(async () => replies[Math.min(i++, replies.length - 1)]) };
}

function generator(runner: LLMRunner, scopeJudge: LLMRunner): PersonaGenerator {
  return new PersonaGenerator({ dataDir: dir, config: {}, llmRunner: runner, scopeJudge, backupCount: 2 });
}

describe("PersonaTrigger scope migration", () => {
  const trigger = () => new PersonaTrigger({ dataDir: dir, interval: 50 });

  it("triggers when the persona has no scope marker", async () => {
    writePersona(LEGACY_PERSONA);
    await expect(trigger().shouldGenerate()).resolves.toMatchObject({ should: true });
  });

  it("does not trigger for an accepted persona below the threshold", async () => {
    writePersona(`${USER_GLOBAL_SCOPE_MARKER}\n${CLEAN_PERSONA}`);
    await expect(trigger().shouldGenerate()).resolves.toMatchObject({ should: false });
  });

  it("does not trigger for a rejected persona, so a failing persona is not regenerated in a loop", async () => {
    writePersona(`${USER_GLOBAL_REJECTED_MARKER}\n${LEAKY_PERSONA}`);
    await expect(trigger().shouldGenerate()).resolves.toMatchObject({ should: false });
  });
});

describe("PersonaTrigger after a failed scope judge", () => {
  const trigger = () => new PersonaTrigger({ dataDir: dir, interval: 50 });
  const cp = (extra: Record<string, unknown>) => writeFileSync(
    path.join(dir, ".metadata", "recall_checkpoint.json"),
    JSON.stringify({ scenes_processed: 3, persona_judge_failed: true, memories_since_last_persona: 0, ...extra }),
  );
  const cpManager = () => new CheckpointManager(dir);

  it("does not run again for cold start, recovery or scope migration below the threshold", async () => {
    // Cold start: no persona yet.
    cp({});
    await expect(trigger().shouldGenerate()).resolves.toMatchObject({ should: false });
    // Recovery: a persona existed, the body is empty now.
    cp({ last_persona_time: "2026-10-24T00:00:00Z" });
    writePersona("");
    await expect(trigger().shouldGenerate()).resolves.toMatchObject({ should: false });
    // Scope migration: the persona has no scope marker.
    cp({});
    writePersona(LEGACY_PERSONA);
    await expect(trigger().shouldGenerate()).resolves.toMatchObject({ should: false });
  });

  it("runs again when the threshold is reached", async () => {
    cp({ memories_since_last_persona: 50 });
    writePersona(LEGACY_PERSONA);
    await expect(trigger().shouldGenerate()).resolves.toMatchObject({ should: true });
  });

  it("a finished generation clears the mark and an automatic failure restarts the count", async () => {
    cp({ memories_since_last_persona: 7, request_persona_update: true });
    await cpManager().dropPendingPersonaRun({ keepSchedule: true });
    expect(await cpManager().read()).toMatchObject({ persona_judge_failed: true, memories_since_last_persona: 7, request_persona_update: true });
    await cpManager().dropPendingPersonaRun();
    expect(await cpManager().read()).toMatchObject({ persona_judge_failed: true, memories_since_last_persona: 0, request_persona_update: false });
    await cpManager().markPersonaGenerated(10);
    expect((await cpManager().read()).persona_judge_failed).toBe(false);
    writePersona(LEGACY_PERSONA);
    await expect(trigger().shouldGenerate()).resolves.toMatchObject({ should: true });
  });
});

describe("PersonaGenerator user-global scope", () => {
  it("rewrites a persona without marker from all scenes and does not show it to the model", async () => {
    writePersona(LEGACY_PERSONA);
    const runner = writerRunner([CLEAN_PERSONA]);

    const result = await generator(runner, judge('{"leaks": []}')).generateLocalPersona("migration");

    expect(result).toBe("generated");
    const prompt = runner.calls[0].prompt;
    expect(prompt).toContain("首次生成");
    expect(prompt).not.toContain("Đang làm việc với Agent-Memory, quy trình video Shorts");
    expect(prompt).toContain("agent-memory-local.md");
    expect(prompt).toContain("video-pipeline.md");
    expect(readPersona().startsWith(`${USER_GLOBAL_SCOPE_MARKER}\n# User Narrative Profile`)).toBe(true);
  });

  it("writes exactly one marker on line 1 when the model puts markers inline in its text", async () => {
    writePersona(LEGACY_PERSONA);
    const inline = `${USER_GLOBAL_REJECTED_MARKER} ${USER_GLOBAL_SCOPE_MARKER} ${CLEAN_PERSONA}`;
    const runner = writerRunner([inline]);

    await generator(runner, judge('{"leaks": []}')).generateLocalPersona("migration");

    const written = readPersona();
    expect(written.split("\n")[0]).toBe(USER_GLOBAL_SCOPE_MARKER);
    expect(written.split(USER_GLOBAL_SCOPE_MARKER)).toHaveLength(2);
    expect(written).not.toContain(USER_GLOBAL_REJECTED_MARKER);
    expect(written.split("\n")[1]).toBe("# User Narrative Profile");
  });

  it("retries once with the findings and accepts a clean second version", async () => {
    writePersona(LEGACY_PERSONA);
    const runner = writerRunner([LEAKY_PERSONA, CLEAN_PERSONA]);

    await generator(runner, judge('{"leaks": []}')).generateLocalPersona("migration");

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1].prompt).toContain("作用域检查未通过");
    expect(runner.calls[1].prompt).toContain("- Agent-Memory");
    expect(readPersona().startsWith(USER_GLOBAL_SCOPE_MARKER)).toBe(true);
  });

  it("writes the rejected marker when both versions leak", async () => {
    writePersona(LEGACY_PERSONA);
    const runner = writerRunner([LEAKY_PERSONA, LEAKY_PERSONA]);

    const result = await generator(runner, judge('{"leaks": []}')).generateLocalPersona("migration");

    expect(result).toBe("generated");
    expect(readPersona().startsWith(USER_GLOBAL_REJECTED_MARKER)).toBe(true);
  });

  it("rejects when the judge finds names that no pattern sees", async () => {
    writePersona(LEGACY_PERSONA);
    const runner = writerRunner([CLEAN_PERSONA]);

    await generator(runner, judge('{"leaks": ["bằng chứng"]}')).generateLocalPersona("migration");

    expect(runner.calls).toHaveLength(2);
    expect(readPersona().startsWith(USER_GLOBAL_REJECTED_MARKER)).toBe(true);
  });

  it("updates an accepted persona incrementally without showing the marker to the model", async () => {
    writePersona(`${USER_GLOBAL_SCOPE_MARKER}\n${CLEAN_PERSONA}`);
    const runner = writerRunner([`${CLEAN_PERSONA}\n- Thay đổi nhỏ, có đường lui.`]);

    await generator(runner, judge('{"leaks": []}')).generateLocalPersona("threshold");

    const prompt = runner.calls[0].prompt;
    expect(prompt).toContain("迭代更新");
    expect(prompt).toContain("Ưu tiên bằng chứng quan sát được");
    expect(prompt).not.toContain(USER_GLOBAL_SCOPE_MARKER);
    expect(readPersona().startsWith(USER_GLOBAL_SCOPE_MARKER)).toBe(true);
  });

  it("removes a marker that the model wrote itself before checking", async () => {
    writePersona(LEGACY_PERSONA);
    const runner = writerRunner([`${USER_GLOBAL_SCOPE_MARKER}\n${LEAKY_PERSONA}`]);

    await generator(runner, judge('{"leaks": []}')).generateLocalPersona("migration");

    const written = readPersona();
    expect(written.startsWith(USER_GLOBAL_REJECTED_MARKER)).toBe(true);
    expect(written).not.toContain(USER_GLOBAL_SCOPE_MARKER);
  });
});

describe("PersonaGenerator backup in storage mode", () => {
  it("keeps a copy of the overwritten persona under .backup/persona/ and rotates old copies", async () => {
    writePersona(LEGACY_PERSONA);
    const storage = new StorageAdapter(new LocalStorageBackend(dir));
    const runner: LLMRunner = {
      run: vi.fn(async () => {
        await storage.writeFile("persona.md", `${CLEAN_PERSONA}\n${Date.now()}`);
        return "";
      }),
    };
    const gen = () => new PersonaGenerator({
      dataDir: dir, config: {}, llmRunner: runner, scopeJudge: judge('{"leaks": []}'), backupCount: 2, storage,
    });

    await gen().generateLocalPersona("migration");
    const firstBackups = await storage.readdirNames(".backup/persona/", ".md");
    expect(firstBackups).toHaveLength(1);
    expect(await storage.readFile(`.backup/persona/${firstBackups[0]}`)).toBe(LEGACY_PERSONA);

    await gen().generateLocalPersona("threshold");
    await gen().generateLocalPersona("threshold");
    expect(await storage.readdirNames(".backup/persona/", ".md")).toHaveLength(2);
  });
});

describe("PersonaGenerator scene size budget", () => {
  it("inlines the newest scenes up to the budget and lists the rest by summary", async () => {
    const big = "x".repeat(Math.ceil(MAX_INLINED_SCENE_CHARS / 3));
    const entries = [];
    for (let i = 0; i < 6; i++) {
      const name = `big-${i}.md`;
      writeFileSync(path.join(dir, "scene_blocks", name), `-----META-START-----\nsummary: summary ${i}\n-----META-END-----\n${big}`);
      entries.push({ filename: name, summary: `summary ${i}`, heat: 1, created: "2026-10-01T00:00:00Z", updated: `2026-10-0${i + 1}T00:00:00Z` });
    }
    writeFileSync(path.join(dir, ".metadata", "scene_index.json"), JSON.stringify(entries));
    writePersona(LEGACY_PERSONA);
    const runner = writerRunner([CLEAN_PERSONA]);

    await generator(runner, judge('{"leaks": []}')).generateLocalPersona("migration");

    const prompt = runner.calls[0].prompt;
    expect(prompt.length).toBeLessThan(MAX_INLINED_SCENE_CHARS * 1.6);
    // The newest scene is inlined; the oldest is listed by summary only.
    expect(prompt).toContain("### [1] big-5.md");
    expect(prompt).toContain("- big-0.md — summary 0");
  });
});
