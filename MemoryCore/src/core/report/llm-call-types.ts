/**
 * Types of the LLM call log. One record is written for a failed LLM call of any
 * stage, and for a successful call of a stage that asks for it (the persona
 * scope judge). All records go through one wrapper around the LLM runner (see
 * llm-call-recorder.ts); no call site writes its own rows.
 */

export type LlmCallOutcome = "ok" | "error";

/** Largest reply kept in a record, in UTF-8 bytes. */
export const LLM_CALL_REPLY_MAX_BYTES = 16 * 1024;

export interface LlmCallRecord {
  id: string;
  /** Memory instance (space) that owns the record. */
  instance_id: string;
  created_at_ms: number;
  finished_at_ms: number;
  latency_ms: number;
  /** taskId of the call, for example l1-extraction, persona-generation, persona-scope-check. */
  stage: string;
  /** Langfuse trace name of the call, when it has one. */
  trace_name: string;
  model: string;
  team_id: string;
  agent_id: string;
  user_id: string;
  session_id: string;
  /** Empty for the user-global persona and for stages that have no project. */
  project_hash: string;
  /** Id shared with the L3 generation log of the same run; empty when the call is not part of one. */
  generation_id: string;
  outcome: LlmCallOutcome;
  /** Deadline given to the call, in ms; 0 when the runner default applied. */
  timeout_ms: number;
  /** Size of system prompt plus prompt in characters. The prompt text is never stored. */
  prompt_chars: number;
  /** Specific cause (see LlmErrorKind); empty for a call without a failure. */
  error_kind: string;
  /** Class or name of the error that carried the cause. */
  error_class: string;
  /** HTTP status of the provider response; 0 when there was none. */
  http_status: number;
  provider_error_type: string;
  provider_error_code: string;
  /** Wait the provider asked for (Retry-After and similar), in ms; 0 when none. */
  retry_after_ms: number;
  /** Calls the AI SDK made inside this one call (its own retries); 0 when unknown. */
  sdk_attempts: number;
  /** Error text, redacted and bounded. */
  error_message: string;
  /** Provider response body, redacted and bounded; empty when none. */
  response_excerpt: string;
  /** JSON text of the caller's verdict (the scope judge: outcome, leaks, persona size); empty for other stages. */
  verdict: string;
  /** The reply, cut to LLM_CALL_REPLY_MAX_BYTES; kept for recorded successes and unusable replies. */
  reply: string;
  reply_truncated: boolean;
}

export interface LlmCallListFilter {
  /** Only records of this memory instance. */
  instanceId?: string;
  stage?: string;
  outcome?: LlmCallOutcome;
  errorKind?: string;
  teamId?: string;
  agentId?: string;
  generationId?: string;
  startTimeMs: number;
  endTimeMs: number;
  limit: number;
  /** Return only records older than this position (newest first order). */
  before?: { createdAtMs: number; id: string };
}

export type LlmCallGroupBy = "error_kind" | "http_status" | "provider_error_code" | "stage" | "model" | "day" | "outcome";

export interface LlmCallStatsFilter {
  instanceId?: string;
  stage?: string;
  teamId?: string;
  agentId?: string;
  startTimeMs: number;
  endTimeMs: number;
  groupBy: LlmCallGroupBy;
}

export interface LlmCallStatsGroup {
  /** Group value; "none" for records that have no value (a success has no error kind). */
  key: string;
  count: number;
  first_seen_ms: number;
  last_seen_ms: number;
  /** Id of the newest record of the group. */
  example_id: string;
}

/** Optional store capability; a backend without it does not keep the log. */
export interface LlmCallStore {
  insertLlmCall?(record: LlmCallRecord): Promise<void> | void;
  /** Newest first, ordered by (created_at_ms, id) descending. */
  listLlmCalls?(filter: LlmCallListFilter): Promise<LlmCallRecord[]> | LlmCallRecord[];
  /** Counts per group, largest first. */
  statsLlmCalls?(filter: LlmCallStatsFilter): Promise<LlmCallStatsGroup[]> | LlmCallStatsGroup[];
  /** Delete records created before the cut-off time. Returns how many were deleted. */
  pruneLlmCalls?(olderThanMs: number): Promise<number> | number;
}

/** Cut text to a byte budget without splitting a UTF-8 character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // Step back to the start of a character: continuation bytes look like 10xxxxxx.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/** Group key of a record, with the same rules the stores apply in their queries. */
export function llmCallGroupKey(r: Pick<LlmCallRecord, "error_kind" | "http_status" | "provider_error_code" | "stage" | "model" | "created_at_ms" | "outcome">, by: LlmCallGroupBy): string {
  switch (by) {
    case "error_kind": return r.error_kind || "none";
    case "http_status": return r.http_status ? String(r.http_status) : "none";
    case "provider_error_code": return r.provider_error_code || "none";
    case "stage": return r.stage || "none";
    case "model": return r.model || "none";
    case "outcome": return r.outcome;
    case "day": return new Date(r.created_at_ms).toISOString().slice(0, 10);
  }
}

/** Group records in memory. Used by backends that cannot group in the database. */
export function aggregateLlmCalls(rows: LlmCallRecord[], by: LlmCallGroupBy): LlmCallStatsGroup[] {
  const groups = new Map<string, LlmCallStatsGroup & { newestId: string }>();
  for (const r of rows) {
    const key = llmCallGroupKey(r, by);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { key, count: 1, first_seen_ms: r.created_at_ms, last_seen_ms: r.created_at_ms, example_id: r.id, newestId: r.id });
      continue;
    }
    g.count++;
    g.first_seen_ms = Math.min(g.first_seen_ms, r.created_at_ms);
    if (r.created_at_ms > g.last_seen_ms || (r.created_at_ms === g.last_seen_ms && r.id > g.example_id)) {
      g.last_seen_ms = r.created_at_ms;
      g.example_id = r.id;
    }
  }
  return [...groups.values()]
    .map(({ newestId: _unused, ...g }) => g)
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
}
