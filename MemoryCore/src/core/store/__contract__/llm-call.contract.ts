/**
 * Conformance clauses of the LLM call log for one store backend.
 * Run by a thin harness per backend (see llm-call.*.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LlmCallRecord } from "../../report/llm-call-types.js";
import type { IMemoryStore } from "../types.js";

export interface LlmCallContractHarness {
  backend: string;
  createStore(): Promise<IMemoryStore>;
  disposeStore(store: IMemoryStore): Promise<void>;
}

export function llmCall(over: Partial<LlmCallRecord> & { id: string; created_at_ms: number }): LlmCallRecord {
  return {
    instance_id: "inst-1", finished_at_ms: over.created_at_ms + 5, latency_ms: 5, stage: "l1-extraction",
    trace_name: "memory.l1-extract", model: "model-x", team_id: "team-1", agent_id: "agent-1", user_id: "user-1",
    session_id: "", project_hash: "", generation_id: "", outcome: "error", timeout_ms: 60_000, prompt_chars: 1200,
    error_kind: "timeout", error_class: "TimeoutError", http_status: 0, provider_error_type: "", provider_error_code: "",
    retry_after_ms: 0, sdk_attempts: 1, error_message: "timed out", response_excerpt: "", verdict: "", reply: "",
    reply_truncated: false, ...over,
  };
}

export function runLlmCallContract(h: LlmCallContractHarness): void {
  describe(`LLM call log [${h.backend}]`, () => {
    let store: IMemoryStore;
    const base = Date.now() - 3_600_000;
    const wide = { startTimeMs: 0, endTimeMs: Date.now() + 60_000 };

    beforeAll(async () => {
      store = await h.createStore();
      await store.insertLlmCall!(llmCall({ id: "c_a", created_at_ms: base + 1 }));
      await store.insertLlmCall!(llmCall({
        id: "c_b", created_at_ms: base + 2, error_kind: "rate_limit", http_status: 429, provider_error_code: "rate_limit_exceeded",
        provider_error_type: "requests", retry_after_ms: 1000, response_excerpt: '{"error":{"code":"rate_limit_exceeded"}}',
      }));
      await store.insertLlmCall!(llmCall({
        id: "c_c", created_at_ms: base + 3, stage: "persona-scope-check", outcome: "ok", error_kind: "", error_class: "", error_message: "",
        timeout_ms: 60000, sdk_attempts: 0, generation_id: "mg_run2", verdict: '{"outcome":"leaks","leaks":["Remotion"]}', reply: '{"leaks":["Remotion"]}',
      }));
      await store.insertLlmCall!(llmCall({ id: "c_d", created_at_ms: base + 3, agent_id: "agent-2", error_kind: "rate_limit", http_status: 429, generation_id: "mg_run3" }));
      await store.insertLlmCall!(llmCall({ id: "c_e", created_at_ms: base + 4, instance_id: "inst-2", team_id: "team-2", error_kind: "server_error", http_status: 500 }));
    });

    afterAll(async () => { await h.disposeStore(store); });

    const ids = async (f: object) => (await store.listLlmCalls!({ ...wide, limit: 20, ...f })).map((r) => r.id);

    it("round-trips every field of a record", async () => {
      const [row] = await store.listLlmCalls!({ ...wide, generationId: "mg_run2", limit: 5 });
      expect(row).toEqual(llmCall({
        id: "c_c", created_at_ms: base + 3, stage: "persona-scope-check", outcome: "ok", error_kind: "", error_class: "", error_message: "",
        timeout_ms: 60000, sdk_attempts: 0, generation_id: "mg_run2", verdict: '{"outcome":"leaks","leaks":["Remotion"]}', reply: '{"leaks":["Remotion"]}',
      }));
    });

    it("lists newest first, ordered by time then id", async () => {
      expect(await ids({})).toEqual(["c_e", "c_d", "c_c", "c_b", "c_a"]);
    });

    it("filters by instance, stage, outcome, error kind, team, agent and generation", async () => {
      expect(await ids({ instanceId: "inst-1" })).toEqual(["c_d", "c_c", "c_b", "c_a"]);
      expect(await ids({ instanceId: "inst-2" })).toEqual(["c_e"]);
      expect(await ids({ stage: "persona-scope-check" })).toEqual(["c_c"]);
      expect(await ids({ outcome: "ok" })).toEqual(["c_c"]);
      expect(await ids({ errorKind: "rate_limit" })).toEqual(["c_d", "c_b"]);
      expect(await ids({ teamId: "team-2" })).toEqual(["c_e"]);
      expect(await ids({ teamId: "team-1", agentId: "agent-2" })).toEqual(["c_d"]);
      expect(await ids({ generationId: "mg_run3" })).toEqual(["c_d"]);
    });

    it("limits the time range on both ends", async () => {
      expect(await ids({ startTimeMs: base + 2, endTimeMs: base + 3 })).toEqual(["c_d", "c_c", "c_b"]);
    });

    it("pages with a position that breaks ties on equal times", async () => {
      const first = await store.listLlmCalls!({ ...wide, limit: 2 });
      expect(first.map((r) => r.id)).toEqual(["c_e", "c_d"]);
      const second = await store.listLlmCalls!({ ...wide, limit: 2, before: { createdAtMs: first[1].created_at_ms, id: first[1].id } });
      expect(second.map((r) => r.id)).toEqual(["c_c", "c_b"]);
      const third = await store.listLlmCalls!({ ...wide, limit: 2, before: { createdAtMs: second[1].created_at_ms, id: second[1].id } });
      expect(third.map((r) => r.id)).toEqual(["c_a"]);
    });

    it("groups by error kind, status, stage, outcome, model and day with first, last and example", async () => {
      const f = { ...wide, instanceId: "inst-1" };
      const byKind = await store.statsLlmCalls!({ ...f, groupBy: "error_kind" });
      expect(byKind.map((g) => [g.key, g.count])).toEqual([["rate_limit", 2], ["timeout", 1], ["none", 1]].sort((a, b) => (b[1] as number) - (a[1] as number) || (a[0] < b[0] ? -1 : 1)));
      const rate = byKind.find((g) => g.key === "rate_limit")!;
      expect(rate).toMatchObject({ first_seen_ms: base + 2, last_seen_ms: base + 3, example_id: "c_d" });
      expect((await store.statsLlmCalls!({ ...f, groupBy: "http_status" })).map((g) => [g.key, g.count])).toEqual([["429", 2], ["none", 2]]);
      expect((await store.statsLlmCalls!({ ...f, groupBy: "stage" })).map((g) => [g.key, g.count])).toEqual([["l1-extraction", 3], ["persona-scope-check", 1]]);
      expect((await store.statsLlmCalls!({ ...f, groupBy: "outcome" })).map((g) => [g.key, g.count])).toEqual([["error", 3], ["ok", 1]]);
      expect((await store.statsLlmCalls!({ ...f, groupBy: "model" })).map((g) => [g.key, g.count])).toEqual([["model-x", 4]]);
      expect((await store.statsLlmCalls!({ ...f, groupBy: "provider_error_code" })).map((g) => [g.key, g.count])).toEqual([["none", 3], ["rate_limit_exceeded", 1]]);
      const days = await store.statsLlmCalls!({ ...f, groupBy: "day" });
      expect(days.reduce((n, g) => n + g.count, 0)).toBe(4);
      expect(days[0].key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("scopes stats to the instance, the team and the time range", async () => {
      expect((await store.statsLlmCalls!({ ...wide, instanceId: "inst-2", groupBy: "error_kind" })).map((g) => g.key)).toEqual(["server_error"]);
      expect((await store.statsLlmCalls!({ ...wide, instanceId: "inst-1", agentId: "agent-2", groupBy: "error_kind" })).map((g) => g.count)).toEqual([1]);
      expect(await store.statsLlmCalls!({ startTimeMs: base + 10, endTimeMs: base + 20, groupBy: "error_kind" })).toEqual([]);
    });

    it("prunes records older than the cut-off and keeps newer ones", async () => {
      await store.insertLlmCall!(llmCall({ id: "c_old", created_at_ms: 1_000 }));
      expect(await store.pruneLlmCalls!(2_000)).toBe(1);
      expect(await ids({ startTimeMs: 0, endTimeMs: 10_000 })).toEqual([]);
      expect((await ids({})).length).toBe(5);
    });
  });
}
