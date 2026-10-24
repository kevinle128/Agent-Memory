/**
 * The L3 runner with a failing, leaking or passing scope judge: the retry flag,
 * the generation log, the judge trace and the manual regeneration options.
 * Real trigger, generator, storage views and checkpoint; fake LLM runners.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import * as pf from "./pipeline-factory.js";
import { DEFAULT_LLM_CALL_LOG_CONFIG, LlmCallRecordingRunner } from "../core/report/llm-call-recorder.js";
import type { LlmCallRecord } from "../core/report/llm-call-types.js";
import type { PipelineLogger } from "./pipeline-factory.js";
import { MemoryGenerationLogStore } from "../core/memory-generation-log/store.js";
import type { MemoryGenerationLog } from "../core/memory-generation-log/types.js";
import type { L3GenerationReport } from "../core/persona/jev-gate.js";
import { USER_GLOBAL_REJECTED_MARKER, USER_GLOBAL_SCOPE_MARKER } from "../core/persona/user-global-scope.js";
import { formatSceneBlock } from "../core/scene/scene-format.js";
import { syncSceneIndex } from "../core/scene/scene-index.js";
import { FakeProfileRowStore } from "../core/storage/__contract__/fake-profile-row-store.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { CompositeStorageBackend } from "../core/storage/composite-backend.js";
import { ProfileRowStorageBackend } from "../core/storage/profile-row-backend.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";
import { createProjectScopedStorage } from "../core/storage/project-scoped-storage.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { LLMRunParams, LLMRunner } from "../core/types.js";

const A = "0123456789abcdef";
const SCOPE = "team:team-1|agent:agent-1";
const SCOPE_DIR = `profiles/${encodeURIComponent(SCOPE)}`;
const CLEAN = "# User Narrative Profile\n\n- Prefers evidence before conclusions.";
const ACCEPTED = `${USER_GLOBAL_SCOPE_MARKER}\n# Old accepted persona\n- Prefers small changes.`;

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})));
});

const logger = (lines: string[]): PipelineLogger => {
  const at = (level: string) => (text: string) => { lines.push(`${level}: ${text}`); };
  return { info: at("info"), warn: at("warn"), error: at("error"), debug: () => {} };
};

const scene = (summary: string) => formatSceneBlock(
  { created: "2026-10-01T00:00:00.000Z", updated: "2026-10-02T00:00:00.000Z", summary, heat: 1 },
  `Body of ${summary}`,
);

interface Fixture {
  rootDir: string;
  root: StorageAdapter;
  scope: StorageAdapter;
  lines: string[];
  rows: LlmCallRecord[];
  store: IMemoryStore;
  writes: number;
  runner: LLMRunner;
}

async function fixture(opts: { persona?: string; withProject?: boolean; checkpoint?: object } = {}): Promise<Fixture> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "l3-scope-judge-"));
  tmpDirs.push(rootDir);
  const root = new StorageAdapter(new LocalStorageBackend(rootDir));
  const scope = new StorageAdapter(new LocalStorageBackend(path.join(rootDir, SCOPE_DIR)));
  await scope.writeFile("scene_blocks/habits.md", scene("habits"));
  await syncSceneIndex("", scope);
  await scope.writeFile(".metadata/checkpoint.json", JSON.stringify({ scenes_processed: 1, memories_since_last_persona: 2, ...opts.checkpoint }));
  if (opts.persona) await scope.writeFile("persona.md", opts.persona);
  if (opts.withProject) {
    const project = createProjectScopedStorage(scope, A);
    await project.writeFile("scene_blocks/work.md", scene("scene of A"));
    await syncSceneIndex("", project);
    await project.writeFile(".metadata/checkpoint.json", JSON.stringify({ scenes_processed: 1, memories_since_last_persona: 2 }));
  }
  const rows: LlmCallRecord[] = [];
  const fx: Fixture = {
    rootDir, root, scope, lines: [], rows, writes: 0,
    store: { insertLlmCall: (r: LlmCallRecord) => { rows.push(r); } } as unknown as IMemoryStore,
    runner: {
      run: async (params: LLMRunParams) => {
        fx.writes += 1;
        const body = params.systemPrompt!.includes("Project Memory Architect") ? "# Project Memory\n\nnotes" : CLEAN;
        await params.storage!.writeFile(`${params.storagePrefix ?? ""}persona.md`, `${body}${" ".repeat(fx.writes)}`);
        return "";
      },
    },
  };
  return fx;
}

type Context = Parameters<ReturnType<typeof pf.createL3Runner>>[0];
function run(fx: Fixture, judge: LLMRunner, context?: Context, store: IMemoryStore | undefined = fx.store): Promise<void> {
  return pf.createL3Runner({
    pluginDataDir: fx.rootDir,
    cfg: { persona: { model: "test-model", promptMode: "chat", triggerEveryN: 50, backupCount: 1, jev: { diagnostics: { mode: "off" } } } } as never,
    openclawConfig: {},
    vectorStore: store,
    logger: logger(fx.lines),
    instanceId: "inst-1",
    storage: fx.root,
    llmRunner: fx.runner,
    scopeJudgeRunner: new LlmCallRecordingRunner(judge, {
      config: DEFAULT_LLM_CALL_LOG_CONFIG,
      getStore: () => store as never,
      getInstanceId: () => "inst-1",
      logger: logger(fx.lines),
    }),
  })(context ?? { teamId: "team-1", agentId: "agent-1", userId: "user-1" });
}

const failingJudge: LLMRunner = { run: async () => { throw new Error("upstream 503"); } };
const passingJudge: LLMRunner = { run: async () => '{"leaks": []}' };
const leakingJudge: LLMRunner = { run: async () => '{"leaks": ["habits"]}' };

async function logs(fx: Fixture): Promise<MemoryGenerationLog[]> {
  const store = new MemoryGenerationLogStore(fx.root, "inst-1");
  const page = await store.list({ startTimeMs: Date.now() - 3_600_000, endTimeMs: Date.now() + 60_000, limit: 50 });
  return Promise.all(page.items.map(async (item) => (await store.getByLogId(item.log_id))!));
}
const checkpoint = async (fx: Fixture) => JSON.parse((await fx.scope.readFile(".metadata/checkpoint.json"))!);

describe("createL3Runner with a judge that fails technically", () => {
  it("keeps the accepted persona, makes one judge call, and writes a failed log that points at the stored call", async () => {
    const fx = await fixture({ persona: ACCEPTED, checkpoint: { memories_since_last_persona: 60 } });

    await run(fx, failingJudge);

    expect(await fx.scope.readFile("persona.md")).toBe(ACCEPTED);
    const cp = await checkpoint(fx);
    expect(cp.request_persona_update).toBeFalsy();
    expect(fx.rows.map((r) => [r.outcome, r.error_kind])).toEqual([["error", "unknown"]]);
    const [log] = await logs(fx);
    expect(log).toMatchObject({
      status: "failed",
      error_code: "SCOPE_JUDGE_FAILED",
      scope_check: { result: "judge_failed", reason: "judge-error", error_kind: "unknown", judge_attempts: 1 },
    });
    expect(log.generation_id).toBe(fx.rows[0].generation_id);
    expect(log.scope_check!.judge_record_ids).toEqual(fx.rows.map((r) => r.id));
    expect(fx.lines.some((l) => l.startsWith("error:") && l.includes("Scope judge gave no verdict"))).toBe(true);
  });

  it("does not run again without the flag when nothing is pending", async () => {
    const fx = await fixture({ persona: ACCEPTED, checkpoint: { memories_since_last_persona: 0, scenes_processed: 2, last_persona_time: "2026-10-03T00:00:00.000Z", last_persona_at: 10 } });
    await run(fx, passingJudge);
    expect(fx.writes).toBe(0);
  });

  it("does not throw and lets the project documents run", async () => {
    const fx = await fixture({ persona: ACCEPTED, withProject: true });
    await expect(run(fx, failingJudge)).resolves.toBeUndefined();
    expect(await fx.scope.readFile(`project_personas/${A}.md`)).toContain("# Project Memory");
  });

  it("still generates when the store cannot keep LLM call records", async () => {
    const fx = await fixture();
    await run(fx, passingJudge, undefined, {} as IMemoryStore);
    expect((await fx.scope.readFile("persona.md"))!.startsWith(USER_GLOBAL_SCOPE_MARKER)).toBe(true);
    expect(fx.lines.some((l) => l.startsWith("warn:") && l.includes("cannot keep LLM call records"))).toBe(true);
  });

  it("still generates when the trace write fails, and logs it", async () => {
    const fx = await fixture();
    const broken = { insertLlmCall: () => { throw new Error("table is locked"); } } as unknown as IMemoryStore;
    await run(fx, passingJudge, undefined, broken);
    expect((await fx.scope.readFile("persona.md"))!.startsWith(USER_GLOBAL_SCOPE_MARKER)).toBe(true);
    expect(fx.lines.some((l) => l.startsWith("warn:") && l.includes("table is locked"))).toBe(true);
  });
});

describe("createL3Runner with a judge that reports leaks", () => {
  it("writes the rejected marker after one regeneration and logs the leaks", async () => {
    const fx = await fixture();
    await run(fx, leakingJudge);

    expect(fx.writes).toBe(2);
    expect((await fx.scope.readFile("persona.md"))!.startsWith(USER_GLOBAL_REJECTED_MARKER)).toBe(true);
    expect(fx.rows.map((r) => JSON.parse(r.verdict).outcome)).toEqual(["leaks", "leaks"]);
    const generated = (await logs(fx)).filter((l) => l.scope_check);
    expect(generated).toHaveLength(1);
    expect(generated[0].status).toBe("succeeded");
    expect(generated[0].scope_check).toMatchObject({ result: "rejected", reason: "judge-leaks", leaks: ["habits"], judge_attempts: 2 });
    expect((await checkpoint(fx)).request_persona_update).toBeFalsy();
  });

  it("logs a passed check on the generation log", async () => {
    const fx = await fixture();
    await run(fx, passingJudge);
    const [log] = (await logs(fx)).filter((l) => l.scope_check);
    expect(log.scope_check).toMatchObject({ result: "passed", judge_attempts: 1 });
    expect(log.generation_id).toBe(fx.rows[0].generation_id);
  });
});

describe("createL3Runner forced regeneration", () => {
  it("backs up the current persona, rewrites it from all scenes and reports the outcome", async () => {
    const fx = await fixture({ persona: ACCEPTED, checkpoint: { memories_since_last_persona: 0, last_persona_time: "2099-01-01T00:00:00.000Z" }, withProject: true });
    const reports: L3GenerationReport[] = [];
    let backup: string | null | undefined;

    await run(fx, passingJudge, {
      teamId: "team-1", agentId: "agent-1",
      forceRegenerate: { reason: "root cause check", generationId: "mg_fixed" },
      onGenerationSettled: (r) => reports.push(r),
      onBackupMade: (k) => { backup = k; },
    });

    expect(backup).toMatch(/^\.backup\/persona-manual\/persona-.*\.md$/);
    expect(await fx.scope.readFile(backup!)).toBe(ACCEPTED);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ scope: "user-global", outcome: "generated", generationId: "mg_fixed", backupKey: backup });
    expect(reports[0].scopeCheck).toMatchObject({ result: "passed" });
    expect(fx.rows[0].generation_id).toBe("mg_fixed");
    // Only the user-global document was touched.
    expect(await fx.scope.readFile(`project_personas/${A}.md`)).toBeNull();
  });

  it("reports a technical failure with the previous persona kept", async () => {
    const fx = await fixture({ persona: ACCEPTED });
    const reports: L3GenerationReport[] = [];
    await run(fx, failingJudge, { teamId: "team-1", agentId: "agent-1", forceRegenerate: { reason: "x" }, onGenerationSettled: (r) => reports.push(r) });
    expect(reports[0]).toMatchObject({ outcome: "judge_failed", scopeCheck: { result: "judge_failed", judge_attempts: 1 } });
    expect(await fx.scope.readFile("persona.md")).toBe(ACCEPTED);
  });

  it("reports the leaks of a rejected rewrite", async () => {
    const fx = await fixture({ persona: ACCEPTED });
    const reports: L3GenerationReport[] = [];
    await run(fx, leakingJudge, { teamId: "team-1", agentId: "agent-1", forceRegenerate: { reason: "x" }, onGenerationSettled: (r) => reports.push(r) });
    expect(reports[0].scopeCheck).toMatchObject({ result: "rejected", leaks: ["habits"] });
  });

  it("rewrites only the named project document", async () => {
    const fx = await fixture({ persona: ACCEPTED, withProject: true });
    const reports: L3GenerationReport[] = [];
    await run(fx, passingJudge, {
      teamId: "team-1", agentId: "agent-1", forceRegenerate: { reason: "x", projectHash: A }, onGenerationSettled: (r) => reports.push(r),
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ scope: "project", projectHash: A, outcome: "generated" });
    expect(await fx.scope.readFile("persona.md")).toBe(ACCEPTED);
    expect(await fx.scope.readFile(`project_personas/${A}.md`)).toContain("# Project Memory");
  });

  it("reports a project without scenes as skipped", async () => {
    const fx = await fixture({ persona: ACCEPTED });
    const reports: L3GenerationReport[] = [];
    await run(fx, passingJudge, {
      teamId: "team-1", agentId: "agent-1", forceRegenerate: { reason: "x", projectHash: A }, onGenerationSettled: (r) => reports.push(r),
    });
    expect(reports[0]).toMatchObject({ scope: "project", outcome: "skipped" });
  });
});

describe("createL3Runner scope judge on the row backend", () => {
  async function rowFixture(opts: { persona?: string } = {}) {
    const fake = Object.assign(new FakeProfileRowStore(), { isDegraded: () => false });
    const rows: LlmCallRecord[] = [];
    const store = Object.assign(fake, { insertLlmCall: (r: LlmCallRecord) => { rows.push(r); } });
    const isolation = { teamId: "team-1", agentId: "agent-1" };
    const othersDir = await fs.mkdtemp(path.join(os.tmpdir(), "l3-scope-judge-rows-"));
    tmpDirs.push(othersDir);
    const composite = new StorageAdapter(new CompositeStorageBackend({
      profileBackend: new ProfileRowStorageBackend({ store: fake.asStore(), isolation }),
      others: new LocalStorageBackend(othersDir),
    }));
    const rowView = new StorageAdapter(new ProfileRowStorageBackend({ store: fake.asStore(), isolation }));
    await rowView.writeFile("scene_blocks/habits.md", scene("habits"));
    if (opts.persona) await rowView.writeFile("persona.md", opts.persona);
    const others = new LocalStorageBackend(othersDir);
    await others.putObject(".metadata/checkpoint.json", JSON.stringify({ scenes_processed: 1, memories_since_last_persona: 2 }));
    const fx = await fixture();
    fx.root = composite;
    return { fx, store: store as unknown as IMemoryStore, rowView, others, rows };
  }
  const ctx = { teamId: "team-1", agentId: "agent-1", userId: "user-1" };

  it("keeps the accepted persona row when the judge fails, and removes an unchecked first persona", async () => {
    const withPrev = await rowFixture({ persona: ACCEPTED });
    await run(withPrev.fx, failingJudge, ctx, withPrev.store);
    expect(await withPrev.rowView.readFile("persona.md")).toBe(ACCEPTED);
    expect(withPrev.rows.map((r) => r.outcome)).toEqual(["error"]);

    const first = await rowFixture();
    await run(first.fx, failingJudge, ctx, first.store);
    expect(await first.rowView.readFile("persona.md")).toBeNull();
  });

  it("writes the manual backup outside the profile rows and returns a readable key", async () => {
    const { fx, store, rowView, others } = await rowFixture({ persona: ACCEPTED });
    let backup: string | null | undefined;
    await run(fx, passingJudge, { ...ctx, forceRegenerate: { reason: "x" }, onBackupMade: (k) => { backup = k; } }, store);
    expect(backup).toMatch(/^\.backup\/persona-manual\//);
    expect((await others.getObject(backup!))!.content.toString()).toBe(ACCEPTED);
    expect((await (store as unknown as FakeProfileRowStore).pullProfiles()).some((r) => r.filename.includes("persona-manual"))).toBe(false);
    expect((await rowView.readFile("persona.md"))!.startsWith(USER_GLOBAL_SCOPE_MARKER)).toBe(true);
  });
});

describe("a judge call that fails", () => {
  const OLD = { memories_since_last_persona: 60, scenes_processed: 2, last_persona_time: "2026-09-01T00:00:00.000Z", last_persona_at: 10 };

  it("is not retried and sets no retry request; the memory count restarts so the threshold decides", async () => {
    const fx = await fixture({ persona: ACCEPTED, checkpoint: { ...OLD, request_persona_update: true } });
    await run(fx, failingJudge);
    expect(fx.writes).toBe(1);
    expect(fx.rows).toHaveLength(1);
    expect(await checkpoint(fx)).toMatchObject({ request_persona_update: false, memories_since_last_persona: 0 });

    // Nothing is pending now: later passes start no run, and no judge call is made.
    await run(fx, passingJudge);
    await run(fx, passingJudge);
    expect(fx.writes).toBe(1);
    expect(fx.rows).toHaveLength(1);
    expect(await fx.scope.readFile("persona.md")).toBe(ACCEPTED);
  });

  it("runs again when the threshold is reached", async () => {
    const fx = await fixture({ persona: ACCEPTED, checkpoint: OLD });
    await run(fx, failingJudge);
    const cp = await checkpoint(fx);
    await fx.scope.writeFile(".metadata/checkpoint.json", JSON.stringify({ ...cp, memories_since_last_persona: 50 }));
    await run(fx, passingJudge);
    expect(fx.writes).toBe(2);
    expect((await fx.scope.readFile("persona.md"))!.startsWith(USER_GLOBAL_SCOPE_MARKER)).toBe(true);
  });

  it("does not add a backup when the persona is the same as the newest one", async () => {
    const fx = await fixture({ persona: ACCEPTED, checkpoint: OLD });
    await run(fx, failingJudge);
    const cp = await checkpoint(fx);
    await fx.scope.writeFile(".metadata/checkpoint.json", JSON.stringify({ ...cp, memories_since_last_persona: 60 }));
    await run(fx, failingJudge);
    expect(fx.writes).toBe(2);
    expect(await fx.scope.readdirNames(".backup/persona/", ".md")).toHaveLength(1);
  });
});
