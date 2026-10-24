/**
 * The scope judge is called once per check. Its call is stored by the LLM call
 * log (success and failure), a failed call never becomes a rejection, and the
 * previous persona stays when the judge gives no verdict.
 */

import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { APICallError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LLM_CALL_LOG_CONFIG, LlmCallRecordingRunner } from "../report/llm-call-recorder.js";
import type { LlmCallRecord } from "../report/llm-call-types.js";
import type { LLMRunParams, LLMRunner } from "../types.js";
import { PersonaGenerator } from "./persona-generator.js";
import {
  USER_GLOBAL_REJECTED_MARKER,
  USER_GLOBAL_SCOPE_MARKER,
  checkUserGlobalPersona,
  isTechnicalScopeFailure,
} from "./user-global-scope.js";

const CLEAN = "# User Narrative Profile\n\n> **Sở thích dài hạn**\n- Ưu tiên bằng chứng quan sát được trước khi kết luận.";
const scenes = [{ filename: "video-pipeline.md", summary: "Shorts video pipeline" }];

type Step = string | Error;
function scripted(steps: Step[]): LLMRunner & { calls: LLMRunParams[] } {
  const calls: LLMRunParams[] = [];
  return {
    calls,
    modelName: "judge-model",
    run: vi.fn(async (params: LLMRunParams) => {
      calls.push(params);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (step instanceof Error) throw step;
      return step;
    }),
  };
}

/** A judge runner behind the LLM call log, with the rows it wrote. */
function loggedJudge(steps: Step[], opts: { failInsert?: boolean } = {}) {
  const inner = scripted(steps);
  const rows: LlmCallRecord[] = [];
  const runner = new LlmCallRecordingRunner(inner, {
    config: DEFAULT_LLM_CALL_LOG_CONFIG,
    getStore: () => ({ insertLlmCall: (r) => { if (opts.failInsert) throw new Error("db is locked"); rows.push(r); } }),
    getInstanceId: () => "inst",
    logger: { warn: vi.fn(), debug: vi.fn() },
  });
  return { runner, inner, rows };
}

const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const apiError = (status: number, body: object) =>
  new APICallError({ message: "failed", url: "https://x", requestBodyValues: {}, statusCode: status, responseBody: JSON.stringify(body), isRetryable: false });

describe("checkUserGlobalPersona", () => {
  it("makes one call and stores it as an ok row with the verdict when the judge passes", async () => {
    const { runner, inner, rows } = loggedJudge(['{"leaks": []}']);
    const result = await checkUserGlobalPersona({
      persona: CLEAN, sceneIndex: scenes, judge: runner,
      context: { teamId: "t1", agentId: "a1", userId: "u1", generationId: "mg_x", instanceId: "inst" },
    });
    expect(result).toMatchObject({ ok: true, callIds: [rows[0].id] });
    expect(inner.calls).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "ok", stage: "persona-scope-check", team_id: "t1", agent_id: "a1", user_id: "u1", generation_id: "mg_x",
      project_hash: "", model: "judge-model", error_kind: "", reply: '{"leaks": []}',
    });
    const verdict = JSON.parse(rows[0].verdict);
    expect(verdict).toMatchObject({ outcome: "pass", leaks: [], persona_chars: CLEAN.length, scene_index_count: 1 });
    expect(verdict.persona_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not retry a failed call: one call, one error row, a technical failure with its kind", async () => {
    const { runner, inner, rows } = loggedJudge([apiError(429, { error: { type: "requests", code: "rate_limit_exceeded", message: "slow" } })]);
    const result = await checkUserGlobalPersona({ persona: CLEAN, sceneIndex: scenes, judge: runner });
    expect(inner.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, leaks: [], reason: "judge-error", errorKind: "rate_limit" });
    expect(isTechnicalScopeFailure(result)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "error", error_kind: "rate_limit", http_status: 429, provider_error_code: "rate_limit_exceeded", timeout_ms: 60_000 });
  });

  it("names a timeout", async () => {
    const { runner, rows } = loggedJudge([timeoutError()]);
    const result = await checkUserGlobalPersona({ persona: CLEAN, sceneIndex: scenes, judge: runner });
    expect(result).toMatchObject({ reason: "judge-timeout", errorKind: "timeout" });
    expect(rows[0]).toMatchObject({ outcome: "error", error_kind: "timeout" });
  });

  it("names a reply that is not JSON and an empty reply, and stores the reply", async () => {
    const bad = loggedJudge(["I cannot do that"]);
    expect(await checkUserGlobalPersona({ persona: CLEAN, sceneIndex: scenes, judge: bad.runner })).toMatchObject({ reason: "judge-unparseable", errorKind: "unparseable" });
    expect(bad.rows[0]).toMatchObject({ outcome: "error", error_kind: "unparseable", reply: "I cannot do that" });
    expect(bad.inner.calls).toHaveLength(1);

    const empty = loggedJudge(["   "]);
    expect(await checkUserGlobalPersona({ persona: CLEAN, sceneIndex: scenes, judge: empty.runner })).toMatchObject({ errorKind: "empty_reply" });
    expect(empty.rows[0]).toMatchObject({ error_kind: "empty_reply" });
  });

  it("reports leaks as a verdict, not as an error", async () => {
    const { runner, rows } = loggedJudge(['{"leaks": ["Remotion"]}']);
    const result = await checkUserGlobalPersona({ persona: "- Thích dựng video bằng Remotion", sceneIndex: scenes, judge: runner });
    expect(result).toMatchObject({ ok: false, reason: "judge-leaks", leaks: ["Remotion"] });
    expect(isTechnicalScopeFailure(result)).toBe(false);
    expect(rows[0]).toMatchObject({ outcome: "ok", error_kind: "" });
    expect(JSON.parse(rows[0].verdict)).toMatchObject({ outcome: "leaks", leaks: ["Remotion"] });
  });

  it("makes no call and writes no row when the structural check fails first", async () => {
    const { runner, inner, rows } = loggedJudge(['{"leaks": []}']);
    const result = await checkUserGlobalPersona({ persona: "- Đang làm Agent-Memory", sceneIndex: scenes, judge: runner });
    expect(result.reason).toBe("structural");
    expect(inner.calls).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it("names the call for tracing", async () => {
    const { inner, runner } = loggedJudge(['{"leaks": []}']);
    await checkUserGlobalPersona({
      persona: CLEAN, sceneIndex: scenes, judge: runner,
      context: { teamId: "t1", agentId: "a1", userId: "u1", sessionId: "s1", instanceId: "inst" },
    });
    expect(inner.calls[0]).toMatchObject({
      taskId: "persona-scope-check", traceName: "memory.persona-scope-check", userId: "u1", sessionId: "s1",
      instanceId: "inst", tags: ["team:t1", "agent:a1", "scope:user-global"],
    });
  });
});

// ── generator level ─────────────────────────────────────────

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "persona-judge-"));
  mkdirSync(path.join(dir, "scene_blocks"));
  mkdirSync(path.join(dir, ".metadata"));
  writeFileSync(path.join(dir, "scene_blocks", "video-pipeline.md"), "-----META-START-----\nsummary: video\n-----META-END-----\nBuild a pipeline.");
  writeFileSync(
    path.join(dir, ".metadata", "scene_index.json"),
    JSON.stringify([{ filename: "video-pipeline.md", summary: "Shorts video pipeline", heat: 1, created: "2026-10-01T00:00:00Z", updated: "2026-10-01T00:00:00Z" }]),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const personaPath = () => path.join(dir, "persona.md");
const readPersona = () => readFileSync(personaPath(), "utf-8");

function writer(bodies: string[]): LLMRunner & { calls: LLMRunParams[] } {
  const calls: LLMRunParams[] = [];
  return {
    calls,
    run: vi.fn(async (params: LLMRunParams) => {
      calls.push(params);
      writeFileSync(personaPath(), `${bodies[Math.min(calls.length - 1, bodies.length - 1)]}\n${" ".repeat(calls.length)}`);
      return "";
    }),
  };
}

function gen(runner: LLMRunner, judge: LLMRunner) {
  return new PersonaGenerator({
    dataDir: dir, config: {}, llmRunner: runner, scopeJudge: judge, backupCount: 2,
    traceContext: { teamId: "t1", agentId: "a1", userId: "u1" }, instanceId: "inst", model: "model-x",
  });
}

describe("PersonaGenerator when the judge call fails", () => {
  const ACCEPTED = `${USER_GLOBAL_SCOPE_MARKER}\n# Old accepted persona\n- Ưu tiên bằng chứng.`;

  it("keeps the accepted persona byte for byte, writes no marker, and links the stored call", async () => {
    writeFileSync(personaPath(), ACCEPTED);
    const j = loggedJudge([apiError(503, { error: { message: "The server is overloaded" } })]);
    const g = gen(writer([CLEAN]), j.runner);

    const result = await g.generateLocalPersona("threshold");

    expect(result).toBe("judge_failed");
    expect(readPersona()).toBe(ACCEPTED);
    expect(j.inner.calls).toHaveLength(1);
    expect(j.rows).toHaveLength(1);
    expect(j.rows[0]).toMatchObject({ error_kind: "overloaded", http_status: 503, generation_id: g.generationId });
    expect(g.scopeCheckSummary).toMatchObject({
      result: "judge_failed", reason: "judge-error", error_kind: "overloaded", judge_attempts: 1, judge_record_ids: [j.rows[0].id],
    });
  });

  it("keeps a previous rejected persona unchanged", async () => {
    const rejected = `${USER_GLOBAL_REJECTED_MARKER}\n# Old text`;
    writeFileSync(personaPath(), rejected);
    expect(await gen(writer([CLEAN]), loggedJudge([timeoutError()]).runner).generateLocalPersona("threshold")).toBe("judge_failed");
    expect(readPersona()).toBe(rejected);
  });

  it("removes the unchecked file when there was no previous persona", async () => {
    expect(await gen(writer([CLEAN]), loggedJudge(["garbage"]).runner).generateLocalPersona("cold start")).toBe("judge_failed");
    expect(existsSync(personaPath())).toBe(false);
  });

  it("does not regenerate after a failed judge call", async () => {
    writeFileSync(personaPath(), ACCEPTED);
    const runner = writer([CLEAN]);
    await gen(runner, loggedJudge([new Error("503")]).runner).generateLocalPersona("threshold");
    expect(runner.calls).toHaveLength(1);
  });

  it("restores the original when the second check fails after a structural leak", async () => {
    writeFileSync(personaPath(), ACCEPTED);
    const runner = writer(["# Draft\n\n- Đang làm Agent-Memory.", CLEAN]);
    const j = loggedJudge([new Error("503")]);
    expect(await gen(runner, j.runner).generateLocalPersona("threshold")).toBe("judge_failed");
    expect(runner.calls).toHaveLength(2);
    expect(j.inner.calls).toHaveLength(1);
    expect(readPersona()).toBe(ACCEPTED);
  });

  it("lists only judge calls that reached the store", async () => {
    writeFileSync(personaPath(), `${USER_GLOBAL_SCOPE_MARKER}\n# Old`);
    const j = loggedJudge([new Error("503")], { failInsert: true });
    const g = gen(writer([CLEAN]), j.runner);
    await g.generateLocalPersona("threshold");
    expect(g.scopeCheckSummary).toMatchObject({ result: "judge_failed", judge_attempts: 1, judge_record_ids: [] });
  });
});

describe("PersonaGenerator when the judge reports leaks", () => {
  it("regenerates once and then writes the rejected marker", async () => {
    const j = loggedJudge(['{"leaks": ["bằng chứng"]}']);
    const runner = writer([CLEAN]);
    const g = gen(runner, j.runner);

    expect(await g.generateLocalPersona("migration")).toBe("generated");

    expect(runner.calls).toHaveLength(2);
    expect(readPersona().startsWith(USER_GLOBAL_REJECTED_MARKER)).toBe(true);
    expect(j.rows.map((r) => JSON.parse(r.verdict).outcome)).toEqual(["leaks", "leaks"]);
    expect(g.scopeCheckSummary).toMatchObject({ result: "rejected", reason: "judge-leaks", leaks: ["bằng chứng"], judge_attempts: 2, judge_record_ids: j.rows.map((r) => r.id) });
  });

  it("summarizes a pass", async () => {
    const j = loggedJudge(['{"leaks": []}']);
    const g = gen(writer([CLEAN]), j.runner);
    await g.generateLocalPersona("migration");
    expect(g.scopeCheckSummary).toMatchObject({ result: "passed", judge_attempts: 1, judge_record_ids: [j.rows[0].id] });
  });
});

describe("PersonaGenerator safety around the stored file", () => {
  it("generates when the store cannot keep the call", async () => {
    const g = gen(writer([CLEAN]), loggedJudge(['{"leaks": []}'], { failInsert: true }).runner);
    await expect(g.generateLocalPersona("migration")).resolves.toBe("generated");
    expect(readPersona().startsWith(USER_GLOBAL_SCOPE_MARKER)).toBe(true);
  });

  it("stops without any change when the stored file cannot be read", async () => {
    const { StorageAdapter } = await import("../storage/adapter.js");
    const { LocalStorageBackend } = await import("../storage/local-backend.js");
    writeFileSync(personaPath(), `${USER_GLOBAL_SCOPE_MARKER}\n# Old accepted`);
    const storage = new StorageAdapter(new LocalStorageBackend(dir));
    const write = vi.spyOn(storage, "writeFile");
    const unlink = vi.spyOn(storage, "unlink");
    vi.spyOn(storage, "readFile").mockImplementation(async (key: string) => {
      if (key === "persona.md") throw new Error("EIO: i/o error");
      return null;
    });
    const runner = writer([CLEAN]);
    const g = new PersonaGenerator({ dataDir: dir, config: {}, llmRunner: runner, scopeJudge: scripted(['{"leaks": []}']), storage });

    await expect(g.generateLocalPersona("threshold")).resolves.toBe("failed");
    expect(runner.calls).toHaveLength(0);
    expect(write).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(readPersona()).toContain("# Old accepted");
  });

  it("rewrites from all scenes when forced, even if the persona is accepted", async () => {
    writeFileSync(personaPath(), `${USER_GLOBAL_SCOPE_MARKER}\n# Old accepted persona`);
    const runner = writer([CLEAN]);
    const g = new PersonaGenerator({ dataDir: dir, config: {}, llmRunner: runner, scopeJudge: scripted(['{"leaks": []}']), forceFullRewrite: true });
    await g.generateLocalPersona("manual");
    expect(runner.calls[0].prompt).not.toContain("Old accepted persona");
  });
});
