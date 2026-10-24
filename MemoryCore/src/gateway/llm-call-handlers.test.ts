import type http from "node:http";
import { describe, expect, it } from "vitest";

import { aggregateLlmCalls, type LlmCallListFilter, type LlmCallRecord, type LlmCallStatsFilter } from "../core/report/llm-call-types.js";
import type { IMemoryStore } from "../core/store/types.js";
import { makeLlmCallRouteTable } from "./llm-call-handlers.js";
import { makePersonaRegenerateRouteTable } from "./persona-regenerate-handlers.js";
import { handleV2Route, type V2RouterDeps } from "./v2-router.js";
import type { V2AuthContext } from "./v2-schemas.js";

const routes = makeLlmCallRouteTable();
const list = routes["/v3/llm-call/list"];
const stats = routes["/v3/llm-call/stats"];
const auth = { apiKey: "k", serviceId: "inst-1" } as V2AuthContext;
const now = Date.now();

function row(id: string, createdAt: number, over: Partial<LlmCallRecord> = {}): LlmCallRecord {
  return {
    id, instance_id: "inst-1", created_at_ms: createdAt, finished_at_ms: createdAt + 1, latency_ms: 1, stage: "l1-extraction",
    trace_name: "", model: "m", team_id: "team-1", agent_id: "agent-1", user_id: "", session_id: "", project_hash: "",
    generation_id: "", outcome: "error", timeout_ms: 0, prompt_chars: 10, error_kind: "timeout", error_class: "TimeoutError",
    http_status: 0, provider_error_type: "", provider_error_code: "", retry_after_ms: 0, sdk_attempts: 0, error_message: "",
    response_excerpt: "", verdict: "", reply: "", reply_truncated: false, ...over,
  };
}

/** In-memory store with the newest-first, keyset and grouping behaviour of the real stores. */
function fakeStore(rows: LlmCallRecord[]) {
  const listFilters: LlmCallListFilter[] = [];
  const statsFilters: LlmCallStatsFilter[] = [];
  const sorted = [...rows].sort((a, b) => b.created_at_ms - a.created_at_ms || (a.id < b.id ? 1 : -1));
  const match = (f: Partial<LlmCallListFilter> & { startTimeMs: number; endTimeMs: number }) => sorted
    .filter((r) => r.created_at_ms >= f.startTimeMs && r.created_at_ms <= f.endTimeMs)
    .filter((r) => !f.instanceId || r.instance_id === f.instanceId)
    .filter((r) => !f.stage || r.stage === f.stage)
    .filter((r) => !f.outcome || r.outcome === f.outcome)
    .filter((r) => !f.errorKind || r.error_kind === f.errorKind)
    .filter((r) => !f.teamId || r.team_id === f.teamId)
    .filter((r) => !f.agentId || r.agent_id === f.agentId)
    .filter((r) => !f.generationId || r.generation_id === f.generationId);
  const store = {
    listLlmCalls: (f: LlmCallListFilter) => {
      listFilters.push(f);
      return match(f)
        .filter((r) => !f.before || r.created_at_ms < f.before.createdAtMs || (r.created_at_ms === f.before.createdAtMs && r.id < f.before.id))
        .slice(0, f.limit);
    },
    statsLlmCalls: (f: LlmCallStatsFilter) => { statsFilters.push(f); return aggregateLlmCalls(match(f), f.groupBy); },
  } as unknown as IMemoryStore;
  return { store, listFilters, statsFilters };
}

describe("POST /v3/llm-call/list", () => {
  const rows = [1, 2, 3, 4, 5].map((n) => row(`c_${n}`, now - 10_000 + n, {
    error_kind: n % 2 ? "timeout" : "rate_limit", agent_id: n === 5 ? "agent-2" : "agent-1", stage: n === 4 ? "persona-generation" : "l1-extraction",
  }));

  it("returns the newest rows first with the stored fields", async () => {
    const { store } = fakeStore(rows);
    const res = await list({}, auth, "r", { getStore: () => store });
    const data = res.data as { items: LlmCallRecord[]; next_cursor?: string };
    expect(data.items.map((i) => i.id)).toEqual(["c_5", "c_4", "c_3", "c_2", "c_1"]);
    expect(data.items[0]).toHaveProperty("provider_error_code");
    expect(data.next_cursor).toBeUndefined();
  });

  it("reads only the rows of the instance named by the service id", async () => {
    const { store, listFilters } = fakeStore([...rows, row("c_other", now, { instance_id: "inst-2" })]);
    const own = (await list({}, auth, "r", { getStore: () => store })).data as { items: Array<{ id: string }> };
    expect(own.items.map((i) => i.id)).not.toContain("c_other");
    expect(listFilters[0].instanceId).toBe("inst-1");
    const other = (await list({}, { ...auth, serviceId: "inst-2" }, "r", { getStore: () => store })).data as { items: Array<{ id: string }> };
    expect(other.items.map((i) => i.id)).toEqual(["c_other"]);
    const none = (await list({}, { ...auth, serviceId: "inst-3" }, "r", { getStore: () => store })).data as { items: unknown[] };
    expect(none.items).toEqual([]);
  });

  it("filters by stage, outcome, error kind, team, agent and generation", async () => {
    const { store, listFilters } = fakeStore(rows);
    const deps = { getStore: () => store };
    const ids = async (b: object) => ((await list(b, auth, "r", deps)).data as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(await ids({ stage: "persona-generation" })).toEqual(["c_4"]);
    expect(await ids({ error_kind: "rate_limit" })).toEqual(["c_4", "c_2"]);
    expect(await ids({ agent_id: "agent-2" })).toEqual(["c_5"]);
    expect(await ids({ outcome: "ok" })).toEqual([]);
    await list({ team_id: "team-1", generation_id: "mg_1", outcome: "error" }, auth, "r", deps);
    expect(listFilters.at(-1)).toMatchObject({ teamId: "team-1", generationId: "mg_1", outcome: "error" });
  });

  it("pages with a cursor and ends without one", async () => {
    const { store } = fakeStore(rows);
    const deps = { getStore: () => store };
    const p1 = (await list({ limit: 2 }, auth, "r", deps)).data as { items: Array<{ id: string }>; next_cursor?: string };
    expect(p1.items.map((i) => i.id)).toEqual(["c_5", "c_4"]);
    const p2 = (await list({ limit: 2, cursor: p1.next_cursor }, auth, "r", deps)).data as typeof p1;
    expect(p2.items.map((i) => i.id)).toEqual(["c_3", "c_2"]);
    const p3 = (await list({ limit: 2, cursor: p2.next_cursor }, auth, "r", deps)).data as typeof p1;
    expect(p3.items.map((i) => i.id)).toEqual(["c_1"]);
    expect(p3.next_cursor).toBeUndefined();
  });

  it("limits the time range", async () => {
    const { store } = fakeStore(rows);
    const res = await list({ start_time: new Date(now - 10_000 + 2).toISOString(), end_time: new Date(now - 10_000 + 3).toISOString() }, auth, "r", { getStore: () => store });
    expect((res.data as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(["c_3", "c_2"]);
  });

  it("rejects bad input", async () => {
    const deps = { getStore: () => fakeStore(rows).store };
    for (const body of [{ outcome: "nope" }, { error_kind: "made_up" }, { limit: 0 }, { limit: 201 }, { extra: 1 }, { cursor: "not-a-cursor" },
      { start_time: "2026-01-01T00:00:00Z", end_time: "2026-09-01T00:00:00Z" }, { start_time: "2026-02-01T00:00:00Z", end_time: "2026-01-01T00:00:00Z" }]) {
      expect((await list(body, auth, "r", deps)).code).toBe(400);
    }
  });

  it("answers 503 when the store keeps no records", async () => {
    expect((await list({}, auth, "r", { getStore: () => ({}) as IMemoryStore })).code).toBe(503);
    expect((await list({}, auth, "r", { getStore: () => undefined })).code).toBe(503);
  });
});

describe("POST /v3/llm-call/stats", () => {
  const rows = [
    row("c_1", now - 3 * 86_400_000, { error_kind: "rate_limit", http_status: 429 }),
    row("c_2", now - 2 * 86_400_000, { error_kind: "rate_limit", http_status: 429 }),
    row("c_3", now - 86_400_000, { error_kind: "timeout" }),
    row("c_4", now - 1_000, { outcome: "ok", error_kind: "", stage: "persona-scope-check" }),
    row("c_old", now - 20 * 86_400_000, { error_kind: "network" }),
    row("c_x", now - 1_000, { instance_id: "inst-2", error_kind: "auth" }),
  ];

  it("groups by error kind over the last 7 days by default, scoped to the instance", async () => {
    const { store, statsFilters } = fakeStore(rows);
    const res = await stats({}, auth, "r", { getStore: () => store });
    const data = res.data as { group_by: string; total: number; groups: Array<{ key: string; count: number; example_id: string; first_seen_ms: number; last_seen_ms: number }> };
    expect(data.group_by).toBe("error_kind");
    expect(data.total).toBe(4);
    expect(data.groups.map((g) => [g.key, g.count])).toEqual([["rate_limit", 2], ["none", 1], ["timeout", 1]]);
    expect(data.groups[0]).toMatchObject({ example_id: "c_2", first_seen_ms: rows[0].created_at_ms, last_seen_ms: rows[1].created_at_ms });
    expect(statsFilters[0].instanceId).toBe("inst-1");
    expect(statsFilters[0].endTimeMs - statsFilters[0].startTimeMs).toBe(7 * 86_400_000);
  });

  it("groups by every supported key", async () => {
    const { store } = fakeStore(rows);
    const deps = { getStore: () => store };
    const keys = async (group_by: string) => ((await stats({ group_by }, auth, "r", deps)).data as { groups: Array<{ key: string }> }).groups.map((g) => g.key);
    expect(await keys("http_status")).toEqual(["429", "none"]);
    expect(await keys("stage")).toEqual(expect.arrayContaining(["l1-extraction", "persona-scope-check"]));
    expect(await keys("outcome")).toEqual(["error", "ok"]);
    expect(await keys("model")).toEqual(["m"]);
    expect((await keys("day")).every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))).toBe(true);
    expect(await keys("provider_error_code")).toEqual(["none"]);
  });

  it("honours the time range and the team and stage filters", async () => {
    const { store } = fakeStore(rows);
    const deps = { getStore: () => store };
    const wide = await stats({ start_time: new Date(now - 30 * 86_400_000).toISOString(), end_time: new Date(now).toISOString() }, auth, "r", deps);
    expect((wide.data as { total: number }).total).toBe(5);
    const stage = await stats({ stage: "persona-scope-check" }, auth, "r", deps);
    expect((stage.data as { total: number }).total).toBe(1);
    expect(((await stats({ team_id: "nobody" }, auth, "r", deps)).data as { total: number }).total).toBe(0);
  });

  it("does not show another instance's rows", async () => {
    const { store } = fakeStore(rows);
    const res = await stats({}, { ...auth, serviceId: "inst-2" }, "r", { getStore: () => store });
    expect((res.data as { groups: Array<{ key: string }> }).groups.map((g) => g.key)).toEqual(["auth"]);
  });

  it("rejects bad input and a store without the log", async () => {
    const deps = { getStore: () => fakeStore(rows).store };
    expect((await stats({ group_by: "nope" }, auth, "r", deps)).code).toBe(400);
    expect((await stats({ start_time: "2026-01-01T00:00:00Z", end_time: "2026-09-01T00:00:00Z" }, auth, "r", deps)).code).toBe(400);
    expect((await stats({}, auth, "r", { getStore: () => ({}) as IMemoryStore })).code).toBe(503);
  });
});

// ── dispatcher: auth and routing ────────────────────────────

function fakeReq(headers: Record<string, string>, body: unknown): http.IncomingMessage {
  return { headers, url: "/x", method: "POST", __body: body } as unknown as http.IncomingMessage;
}

async function dispatch(pathname: string, headers: Record<string, string>, body: unknown, deps: object) {
  const sent: Array<{ status: number; body: { code: number; data?: unknown } }> = [];
  const handled = await handleV2Route(
    fakeReq(headers, body), {} as http.ServerResponse, pathname, "POST",
    (async (req: http.IncomingMessage) => (req as unknown as { __body: unknown }).__body) as never,
    ((_res: unknown, status: number, b: unknown) => { sent.push({ status, body: b as never }); }) as never,
    { getStore: () => undefined, getEmbedding: () => undefined, getStorage: () => undefined, logger: { info() {}, warn() {}, error() {}, debug() {} }, deployMode: "standalone", ...deps } as unknown as V2RouterDeps,
    { ...routes, ...makePersonaRegenerateRouteTable() } as never,
  );
  return { handled, sent };
}

describe("service-token auth on the LLM call routes", () => {
  const deps = { getStore: () => fakeStore([]).store };

  it("refuses a request without a bearer token or without a service id", async () => {
    for (const p of ["/v3/llm-call/list", "/v3/llm-call/stats", "/v3/persona/regenerate"]) {
      const { handled, sent } = await dispatch(p, { "x-tdai-service-id": "inst-1" }, {}, deps);
      expect(handled).toBe(true);
      expect(sent[0].status).toBe(401);
    }
    const { sent } = await dispatch("/v3/llm-call/list", { authorization: "Bearer t" }, {}, deps);
    expect(sent[0].status).toBe(401);
  });

  it("serves an authenticated caller without the memory isolation fields", async () => {
    for (const p of ["/v3/llm-call/list", "/v3/llm-call/stats"]) {
      const { sent } = await dispatch(p, { authorization: "Bearer t", "x-tdai-service-id": "inst-1" }, {}, deps);
      expect(sent[0].status).toBe(200);
      expect(sent[0].body.code).toBe(0);
    }
  });
});
