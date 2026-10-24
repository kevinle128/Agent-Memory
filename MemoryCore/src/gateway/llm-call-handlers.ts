/**
 * Read routes of the LLM call log:
 *   POST /v3/llm-call/list   - records, newest first
 *   POST /v3/llm-call/stats  - counts per group
 *
 * Both use the service-token auth of the other management routes and are
 * scoped to the instance named by the token's `x-tdai-service-id`.
 */

import type { ZodError } from "zod";

import { errorEnvelope, successEnvelope } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import { MAX_LIST_RANGE_MS, llmCallListSchema, llmCallStatsSchema } from "./llm-call-schemas.js";
import type { IMemoryStore } from "../core/store/types.js";

type RouteHandler = (body: unknown, auth: V2AuthContext, requestId: string, deps: unknown) => Promise<ApiResponseEnvelope>;

interface LlmCallDeps {
  getStore?: () => IMemoryStore | undefined;
}

const DEFAULT_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

function formatZodErr(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
}

function encodeCursor(createdAtMs: number, id: string): string {
  return Buffer.from(JSON.stringify({ c: createdAtMs, i: id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAtMs: number; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== "number" || !Number.isFinite(parsed.c) || typeof parsed.i !== "string") return null;
    return { createdAtMs: parsed.c, id: parsed.i };
  } catch {
    return null;
  }
}

/** Time range of a request; a lookup by generation id defaults to the longest range. */
function timeRange(q: { start_time?: string; end_time?: string; generation_id?: string }): { start: number; end: number } | string {
  const end = q.end_time ? Date.parse(q.end_time) : Date.now();
  const start = q.start_time ? Date.parse(q.start_time) : end - (q.generation_id ? MAX_LIST_RANGE_MS : DEFAULT_RANGE_MS);
  if (start > end) return "start_time must not be after end_time";
  if (end - start > MAX_LIST_RANGE_MS) return "time range must not exceed 90 days";
  return { start, end };
}

async function handleList(body: unknown, auth: V2AuthContext, requestId: string, rawDeps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = llmCallListSchema.safeParse(body ?? {});
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const q = parsed.data;
  const store = (rawDeps as LlmCallDeps).getStore?.();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  if (!store.listLlmCalls) return errorEnvelope(503, "The LLM call log is not supported by this store", requestId);
  let before: { createdAtMs: number; id: string } | undefined;
  if (q.cursor) {
    before = decodeCursor(q.cursor) ?? undefined;
    if (!before) return errorEnvelope(400, "INVALID_LLM_CALL_CURSOR", requestId);
  }
  const range = timeRange(q);
  if (typeof range === "string") return errorEnvelope(400, range, requestId);
  // One extra row tells whether another page exists.
  const rows = await store.listLlmCalls({
    // The service id names the instance; another instance's rows stay out of reach.
    instanceId: auth.serviceId,
    stage: q.stage,
    outcome: q.outcome,
    errorKind: q.error_kind,
    teamId: q.team_id,
    agentId: q.agent_id,
    generationId: q.generation_id,
    startTimeMs: range.start,
    endTimeMs: range.end,
    limit: q.limit + 1,
    before,
  });
  const items = rows.slice(0, q.limit);
  const last = items[items.length - 1];
  return successEnvelope({
    items,
    ...(rows.length > q.limit && last ? { next_cursor: encodeCursor(last.created_at_ms, last.id) } : {}),
  }, requestId);
}

async function handleStats(body: unknown, auth: V2AuthContext, requestId: string, rawDeps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = llmCallStatsSchema.safeParse(body ?? {});
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const q = parsed.data;
  const store = (rawDeps as LlmCallDeps).getStore?.();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  if (!store.statsLlmCalls) return errorEnvelope(503, "The LLM call log is not supported by this store", requestId);
  const range = timeRange(q);
  if (typeof range === "string") return errorEnvelope(400, range, requestId);
  const groups = await store.statsLlmCalls({
    instanceId: auth.serviceId,
    stage: q.stage,
    teamId: q.team_id,
    agentId: q.agent_id,
    startTimeMs: range.start,
    endTimeMs: range.end,
    groupBy: q.group_by,
  });
  return successEnvelope({
    group_by: q.group_by,
    start_time: new Date(range.start).toISOString(),
    end_time: new Date(range.end).toISOString(),
    total: groups.reduce((n, g) => n + g.count, 0),
    groups,
  }, requestId);
}

export function makeLlmCallRouteTable(): Record<string, RouteHandler> {
  return {
    "/v3/llm-call/list": handleList,
    "/v3/llm-call/stats": handleStats,
  };
}
