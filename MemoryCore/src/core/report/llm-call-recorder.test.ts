import { APICallError } from "ai";
import { describe, expect, it, vi } from "vitest";

import type { LLMRunner, LLMRunParams } from "../types.js";
import { DEFAULT_LLM_CALL_LOG_CONFIG, LlmCallRecordingRunner, type LlmCallLogConfig } from "./llm-call-recorder.js";
import type { LlmCallRecord, LlmCallStore } from "./llm-call-types.js";
import { MetricTrackingRunnerFactory } from "./metric-tracking-runner.js";

const logger = { warn: vi.fn(), debug: vi.fn() };

function makeStore(over: Partial<LlmCallStore> = {}): LlmCallStore & { rows: LlmCallRecord[]; pruned: number[] } {
  const rows: LlmCallRecord[] = [];
  const pruned: number[] = [];
  return { rows, pruned, insertLlmCall: (r) => { rows.push(r); }, pruneLlmCalls: (t) => { pruned.push(t); return 0; }, ...over };
}

function runnerOf(behavior: (p: LLMRunParams) => string | Error): LLMRunner {
  return { modelName: "model-x", run: vi.fn(async (p: LLMRunParams) => { const r = behavior(p); if (r instanceof Error) throw r; return r; }) };
}

function wrap(inner: LLMRunner, store: LlmCallStore | undefined, config: Partial<LlmCallLogConfig> = {}) {
  const getStore = vi.fn(() => store);
  const runner = new LlmCallRecordingRunner(inner, {
    config: { ...DEFAULT_LLM_CALL_LOG_CONFIG, ...config }, getStore, getInstanceId: () => "inst-1", logger,
  });
  return { runner, getStore };
}

const apiError = (status: number, body: object, headers: Record<string, string> = {}) =>
  new APICallError({ message: "failed", url: "https://x/v1", requestBodyValues: {}, statusCode: status, responseHeaders: headers, responseBody: JSON.stringify(body), isRetryable: false });

const params = (over: Partial<LLMRunParams> = {}): LLMRunParams => ({
  taskId: "l1-extraction", prompt: "SECRET USER TEXT", systemPrompt: "SYSTEM RULES", timeoutMs: 30_000,
  traceName: "memory.l1-extract", userId: "user-1", sessionId: "sess-1", tags: ["team:team-1", "agent:agent-1"], ...over,
});

describe("LlmCallRecordingRunner failures", () => {
  it("records a failed call with its kind and fields, and rethrows the same error", async () => {
    const err = apiError(429, { error: { type: "requests", code: "rate_limit_exceeded", message: "slow down" } }, { "retry-after": "7" });
    const store = makeStore();
    const { runner } = wrap(runnerOf(() => err), store);

    await expect(runner.run(params())).rejects.toBe(err);

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      outcome: "error", stage: "l1-extraction", trace_name: "memory.l1-extract", model: "model-x", instance_id: "inst-1",
      team_id: "team-1", agent_id: "agent-1", user_id: "user-1", session_id: "sess-1", timeout_ms: 30_000,
      error_kind: "rate_limit", http_status: 429, provider_error_type: "requests", provider_error_code: "rate_limit_exceeded",
      retry_after_ms: 7000, sdk_attempts: 1, error_class: "AI_APICallError", prompt_chars: "SECRET USER TEXT".length + "SYSTEM RULES".length,
    });
    expect(store.rows[0].id).toMatch(/^llmc_/);
    expect(store.rows[0].latency_ms).toBe(store.rows[0].finished_at_ms - store.rows[0].created_at_ms);
  });

  it("never stores the prompt text", async () => {
    const store = makeStore();
    const { runner } = wrap(runnerOf(() => new Error("boom")), store);
    await runner.run(params()).catch(() => {});
    expect(JSON.stringify(store.rows[0])).not.toMatch(/SECRET USER TEXT|SYSTEM RULES/);
  });

  it("keeps the project hash and correlation id from the hints", async () => {
    const store = makeStore();
    const { runner } = wrap(runnerOf(() => new Error("boom")), store);
    await runner.run(params({ tags: ["team:t", "project:abc123"], llmCall: { generationId: "mg_1", teamId: "t2" } })).catch(() => {});
    expect(store.rows[0]).toMatchObject({ project_hash: "abc123", generation_id: "mg_1", team_id: "t2" });
  });

  it("redacts credentials from the stored message and body", async () => {
    const store = makeStore();
    const { runner } = wrap(runnerOf(() => apiError(401, { error: { message: "Incorrect API key provided: sk-proj-abcdefghijklmnop1234" } })), store);
    await runner.run(params()).catch(() => {});
    expect(JSON.stringify(store.rows[0])).not.toContain("sk-proj-abcdefghijklmnop1234");
  });

  it("does not change the thrown error when the store fails, and logs it", async () => {
    logger.warn.mockClear();
    const err = new Error("llm down");
    const store = makeStore({ insertLlmCall: () => { throw new Error("db is locked"); } });
    const { runner } = wrap(runnerOf(() => err), store);
    await expect(runner.run(params())).rejects.toBe(err);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("db is locked"));
  });

  it("warns once and still rethrows when the store cannot keep records", async () => {
    logger.warn.mockClear();
    const { runner } = wrap(runnerOf(() => new Error("x")), {});
    await runner.run(params()).catch(() => {});
    await runner.run(params()).catch(() => {});
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("does not record a successful call by default", async () => {
    const store = makeStore();
    const { runner } = wrap(runnerOf(() => "fine"), store);
    expect(await runner.run(params())).toBe("fine");
    expect(store.rows).toHaveLength(0);
  });

  it("copes with a store that is resolved later", async () => {
    const store = makeStore();
    const runner = new LlmCallRecordingRunner(runnerOf(() => new Error("x")), {
      config: DEFAULT_LLM_CALL_LOG_CONFIG, getStore: async () => store, getInstanceId: () => "inst-1",
    });
    await runner.run(params()).catch(() => {});
    expect(store.rows).toHaveLength(1);
  });
});

describe("LlmCallRecordingRunner successes and unusable replies", () => {
  it("records a success that asks for it, with the verdict and the reply, and reports the id", async () => {
    const store = makeStore();
    const seen: string[] = [];
    const { runner } = wrap(runnerOf(() => '{"leaks": []}'), store);
    const text = await runner.run(params({
      taskId: "persona-scope-check",
      llmCall: { recordSuccess: true, annotate: () => ({ verdict: { outcome: "pass", leaks: [] } }), onRecorded: (id) => seen.push(id) },
    }));
    expect(text).toBe('{"leaks": []}');
    expect(store.rows[0]).toMatchObject({ outcome: "ok", error_kind: "", stage: "persona-scope-check", reply: '{"leaks": []}', verdict: '{"outcome":"pass","leaks":[]}' });
    expect(seen).toEqual([store.rows[0].id]);
  });

  it("records an unusable reply as an error of that kind and still returns the reply", async () => {
    const store = makeStore();
    const { runner } = wrap(runnerOf(() => "no json"), store);
    const text = await runner.run(params({ llmCall: { annotate: () => ({ errorKind: "unparseable" }) } }));
    expect(text).toBe("no json");
    expect(store.rows[0]).toMatchObject({ outcome: "error", error_kind: "unparseable", reply: "no json" });
  });

  it("records successes of the stages named in the config", async () => {
    const store = makeStore();
    const { runner } = wrap(runnerOf(() => "ok"), store, { recordSuccessStages: ["scene-extract"] });
    await runner.run(params({ taskId: "scene-extract" }));
    await runner.run(params({ taskId: "l1-extraction" }));
    expect(store.rows.map((r) => r.stage)).toEqual(["scene-extract"]);
  });

  it("does not report an id for a record the store refused", async () => {
    const seen: string[] = [];
    const store = makeStore({ insertLlmCall: () => { throw new Error("full"); } });
    const { runner } = wrap(runnerOf(() => "x"), store);
    await runner.run(params({ llmCall: { recordSuccess: true, onRecorded: (id) => seen.push(id) } }));
    expect(seen).toEqual([]);
  });

  it("bounds the stored reply", async () => {
    const store = makeStore();
    const { runner } = wrap(runnerOf(() => "é".repeat(20_000)), store);
    await runner.run(params({ llmCall: { recordSuccess: true } }));
    expect(store.rows[0].reply_truncated).toBe(true);
    expect(Buffer.byteLength(store.rows[0].reply, "utf8")).toBeLessThanOrEqual(16 * 1024);
  });

  it("a failing annotate does not break the call", async () => {
    const store = makeStore();
    const { runner } = wrap(runnerOf(() => "x"), store);
    await expect(runner.run(params({ llmCall: { recordSuccess: true, annotate: () => { throw new Error("bad"); } } }))).resolves.toBe("x");
  });
});

describe("the one switch", () => {
  it("records nothing and touches no store when it is off", async () => {
    const store = makeStore();
    const failing = wrap(runnerOf(() => new Error("down")), store, { enabled: false });
    await failing.runner.run(params()).catch(() => {});
    const judge = wrap(runnerOf(() => '{"leaks": []}'), store, { enabled: false });
    await judge.runner.run(params({ taskId: "persona-scope-check", llmCall: { recordSuccess: true } }));
    expect(store.rows).toHaveLength(0);
    expect(store.pruned).toHaveLength(0);
    expect(failing.getStore).not.toHaveBeenCalled();
    expect(judge.getStore).not.toHaveBeenCalled();
  });

  it("records when it is on", async () => {
    const store = makeStore();
    const { runner } = wrap(runnerOf(() => new Error("down")), store, { enabled: true });
    await runner.run(params()).catch(() => {});
    expect(store.rows).toHaveLength(1);
  });
});

describe("retention", () => {
  it("prunes at most once per hour per store, with the configured age", async () => {
    const store = makeStore();
    const { runner } = wrap(runnerOf(() => new Error("x")), store, { retentionDays: 10 });
    const before = Date.now();
    await runner.run(params()).catch(() => {});
    await runner.run(params()).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(store.pruned).toHaveLength(1);
    expect(store.pruned[0]).toBeLessThanOrEqual(Date.now() - 10 * 86_400_000);
    expect(store.pruned[0]).toBeGreaterThanOrEqual(before - 10 * 86_400_000 - 50);
  });
});

describe("coverage through the runner factory", () => {
  it("every runner the factory makes records failures, for each stage, and keeps credit and model helpers", async () => {
    const store = makeStore();
    const inner = runnerOf(() => new Error("down"));
    (inner as { lastUsage?: unknown }).lastUsage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    const factory = new MetricTrackingRunnerFactory({ createRunner: () => inner }, () => "inst-1", undefined, undefined, {
      config: DEFAULT_LLM_CALL_LOG_CONFIG, getStore: () => store, getInstanceId: () => "inst-1",
    });
    for (const opts of [{ enableTools: false }, { enableTools: true }]) {
      const runner = factory.createRunner(opts);
      expect(runner.modelName).toBe("model-x");
      for (const taskId of ["l1-extraction", "l1-conflict-detection", "scene-extraction", "persona-generation", "persona-scope-check", "skill-extraction"]) {
        await runner.run(params({ taskId })).catch(() => {});
      }
    }
    expect(store.rows.map((r) => r.stage)).toEqual([
      "l1-extraction", "l1-conflict-detection", "scene-extraction", "persona-generation", "persona-scope-check", "skill-extraction",
      "l1-extraction", "l1-conflict-detection", "scene-extraction", "persona-generation", "persona-scope-check", "skill-extraction",
    ]);
  });

  it("makes plain runners when no call log is given", async () => {
    const factory = new MetricTrackingRunnerFactory({ createRunner: () => runnerOf(() => "x") }, () => "inst-1");
    expect(await factory.createRunner().run(params())).toBe("x");
  });
});
