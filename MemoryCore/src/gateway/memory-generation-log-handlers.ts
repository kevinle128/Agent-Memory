import type { ZodError } from "zod";

import { errorEnvelope, successEnvelope } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { StorageAdapter } from "../core/storage/adapter.js";
import { encodeGenerationLogCursor, MemoryGenerationLogStore } from "../core/memory-generation-log/store.js";
import type {
  MemoryGenerationLayer,
  MemoryGenerationLog,
  MemoryGenerationLogListItem,
  MemoryGenerationStatus,
} from "../core/memory-generation-log/types.js";
import { memoryGenerationLogGetSchema, memoryGenerationLogListSchema } from "./memory-generation-log-schemas.js";

interface GenerationLogDeps {
  getStore?: () => IMemoryStore | undefined;
  getStorage?: () => StorageAdapter | undefined;
}

function formatZodErr(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
}

/** Most logs that one filtered list request reads. The caller continues with `next_cursor`. */
const MAX_SCANNED_LOGS = 500;
const SCAN_PAGE = 100;

interface LogFilter {
  team_id?: string;
  agent_id?: string;
  session_id?: string;
  output?: "empty" | "non_empty";
}

function logMatches(log: MemoryGenerationLog, f: LogFilter): boolean {
  if (f.team_id && log.team_id !== f.team_id) return false;
  if (f.agent_id && log.agent_id !== f.agent_id) return false;
  if (f.session_id && log.session_id !== f.session_id) return false;
  if (f.output) {
    const empty = log.status === "succeeded" && log.output_refs.length === 0;
    if ((f.output === "empty") !== empty) return false;
  }
  return true;
}

/**
 * List with filters on fields inside the logs. The object keys hold only
 * layer, status and time, so each listed log is read and checked. One request
 * reads at most MAX_SCANNED_LOGS logs; when it stops early, `next_cursor`
 * continues after the last log that it read, so no log is skipped.
 */
async function listWithLogs(
  store: MemoryGenerationLogStore,
  q: { layer?: MemoryGenerationLayer; status?: MemoryGenerationStatus; startTimeMs: number; endTimeMs: number; limit: number; cursor?: string },
  filter: LogFilter,
): Promise<{ items: Array<MemoryGenerationLogListItem & { log: MemoryGenerationLog }>; next_cursor?: string; scanned: number }> {
  const items: Array<MemoryGenerationLogListItem & { log: MemoryGenerationLog }> = [];
  let cursor = q.cursor;
  let scanned = 0;
  let lastRead: MemoryGenerationLogListItem | undefined;
  for (;;) {
    const page = await store.list({ ...q, limit: Math.min(SCAN_PAGE, MAX_SCANNED_LOGS - scanned), cursor });
    const logs = await Promise.all(page.items.map((item) => store.getByKey(item.key).catch(() => null)));
    for (let i = 0; i < page.items.length; i += 1) {
      const item = page.items[i];
      const log = logs[i];
      scanned += 1;
      lastRead = item;
      if (log && logMatches(log, filter)) items.push({ ...item, log });
      if (items.length >= q.limit) {
        return { items, next_cursor: encodeGenerationLogCursor(item), scanned };
      }
    }
    if (!page.next_cursor) return { items, scanned };
    if (scanned >= MAX_SCANNED_LOGS) {
      return { items, ...(lastRead ? { next_cursor: encodeGenerationLogCursor(lastRead) } : {}), scanned };
    }
    cursor = page.next_cursor;
  }
}

async function handleList(body: unknown, auth: V2AuthContext, requestId: string, rawDeps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = memoryGenerationLogListSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const deps = rawDeps as GenerationLogDeps;
  const storage = deps.getStorage?.();
  if (!storage) return errorEnvelope(503, "GENERATION_LOG_STORE_UNAVAILABLE", requestId);
  const now = Date.now();
  const start = parsed.data.start_time ? Date.parse(parsed.data.start_time) : now - 7 * 24 * 60 * 60 * 1000;
  const end = parsed.data.end_time ? Date.parse(parsed.data.end_time) : now;
  const { team_id, agent_id, session_id, output, include_log } = parsed.data;
  const query = {
    layer: parsed.data.layer,
    status: parsed.data.status,
    startTimeMs: start,
    endTimeMs: end,
    limit: parsed.data.limit,
    cursor: parsed.data.cursor,
  };
  const store = new MemoryGenerationLogStore(storage, auth.serviceId);
  try {
    if (team_id || agent_id || session_id || output || include_log) {
      return successEnvelope(await listWithLogs(store, query, { team_id, agent_id, session_id, output }), requestId);
    }
    return successEnvelope(await store.list(query), requestId);
  } catch {
    return errorEnvelope(400, "INVALID_GENERATION_LOG_CURSOR", requestId);
  }
}

async function handleGet(body: unknown, auth: V2AuthContext, requestId: string, rawDeps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = memoryGenerationLogGetSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const deps = rawDeps as GenerationLogDeps;
  const storage = deps.getStorage?.();
  const store = deps.getStore?.();
  if (!storage) return errorEnvelope(503, "GENERATION_LOG_STORE_UNAVAILABLE", requestId);
  const logStore = new MemoryGenerationLogStore(storage, auth.serviceId);

  if (parsed.data.log_id) {
    const log = await logStore.getByLogId(parsed.data.log_id);
    return log ? successEnvelope(log, requestId) : errorEnvelope(404, "MEMORY_GENERATION_LOG_NOT_FOUND", requestId);
  }

  if (!store) return errorEnvelope(503, "Store not available", requestId);
  if (!store.getMemoryGenerationRef) return errorEnvelope(503, "Generation reference store not available", requestId);
  const provenance = await store.getMemoryGenerationRef(parsed.data.layer!, parsed.data.memory_id!);
  if (!provenance) return errorEnvelope(404, "MEMORY_GENERATION_LOG_NOT_FOUND", requestId);
  const log = await logStore.getByKey(provenance.generation_log_key);
  if (!log || !log.output_refs.some((ref) => ref.record_id === parsed.data.memory_id)) {
    return errorEnvelope(404, "MEMORY_GENERATION_LOG_NOT_FOUND", requestId);
  }
  return successEnvelope(log, requestId);
}

type RouteHandler = (body: unknown, auth: V2AuthContext, requestId: string, deps: unknown) => Promise<ApiResponseEnvelope>;

export function makeMemoryGenerationLogRouteTable(): Record<string, RouteHandler> {
  return {
    "/v3/memory-generation-log/list": handleList,
    "/v3/memory-generation-log/get": handleGet,
  };
}
