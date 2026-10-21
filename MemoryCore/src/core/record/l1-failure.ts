/**
 * Classify an L1 extraction failure as transient or deterministic.
 *
 * - transient: the same input can succeed later (provider outage, rate limit,
 *   network fault, timeout, wrong credentials or endpoint). The runner keeps
 *   the batch and retries it without a limit, because an operator error must
 *   never cause data loss.
 * - deterministic: the same input will fail again (the model answer is not
 *   usable, or the provider rejects this input because of its size or its
 *   content). The runner quarantines the group after a small number of
 *   attempts, so that one bad group does not block the session for ever.
 *
 * This module is pure: no I/O and no imports of the `ai` package. It reads
 * error fields by duck typing, so it works with errors from any copy of the
 * SDK and with plain errors from other LLM runners.
 */

import type { L1FailureReason } from "./l1-extractor.js";

export type L1FailureClass = "transient" | "deterministic";

export interface L1FailureClassification {
  failureClass: L1FailureClass;
  /** Short text for logs and checkpoint state, for example `status=503`. */
  detail: string;
}

/** Maximum depth when the classifier follows `lastError` / `cause` links. */
const MAX_UNWRAP_DEPTH = 5;

/** Answer-shape reasons: the model will give the same kind of answer again. */
const DETERMINISTIC_REASONS: ReadonlySet<L1FailureReason> = new Set<L1FailureReason>([
  "no_json",
  "parse_fail",
  "not_array",
  "normalized_all_dropped",
]);

/**
 * Provider messages that mean "this input can never be accepted".
 * A bare `max_tokens` complaint is not here: it means the configured output
 * limit is wrong, which an operator can fix, so it must not drop data.
 */
const INPUT_REJECTED_PATTERN =
  /context.?length|maximum context|too many tokens|prompt is too long|input is too long|content.?(filter|policy)|safety|data_inspection/i;

/** Status codes that can carry an input rejection. */
const INPUT_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

const NETWORK_PATTERN = /fetch failed|ECONN[A-Z]*|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i;

interface ErrorFields {
  name?: string;
  message?: string;
  code?: string;
  statusCode?: number;
  responseBody?: string;
}

function readFields(value: unknown): ErrorFields {
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? { message: value } : {};
  }
  const v = value as Record<string, unknown>;
  const statusRaw = v.statusCode ?? v.status;
  return {
    name: typeof v.name === "string" ? v.name : undefined,
    message: typeof v.message === "string" ? v.message : undefined,
    code: typeof v.code === "string" ? v.code : undefined,
    statusCode: typeof statusRaw === "number" && Number.isFinite(statusRaw) ? statusRaw : undefined,
    responseBody: typeof v.responseBody === "string" ? v.responseBody : undefined,
  };
}

/**
 * Return the error chain, outermost first. The AI SDK wraps the final
 * attempt of a retried call in `AI_RetryError.lastError`; other wrappers use
 * the standard `cause` field.
 */
function unwrapChain(error: unknown): ErrorFields[] {
  const chain: ErrorFields[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth <= MAX_UNWRAP_DEPTH && current !== undefined && current !== null; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(readFields(current));
    if (typeof current !== "object") break;
    const obj = current as Record<string, unknown>;
    current = obj.name === "AI_RetryError" && obj.lastError !== undefined ? obj.lastError : obj.cause;
  }
  return chain;
}

function truncate(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Classify one failure.
 *
 * @param reason - `errorReason` from `extractL1Memories`, or undefined.
 * @param error - The thrown error, when there is one.
 */
export function classifyL1Failure(reason: L1FailureReason | undefined, error: unknown): L1FailureClassification {
  if (reason && DETERMINISTIC_REASONS.has(reason)) {
    return { failureClass: "deterministic", detail: reason };
  }

  const chain = unwrapChain(error);

  // Use the first link that has an HTTP status. It is the provider response.
  const withStatus = chain.find((f) => f.statusCode !== undefined);
  if (withStatus && withStatus.statusCode !== undefined) {
    const status = withStatus.statusCode;
    const detail = `status=${status}`;
    if (INPUT_REJECTION_STATUSES.has(status)) {
      const text = `${withStatus.message ?? ""} ${withStatus.responseBody ?? ""}`;
      if (INPUT_REJECTED_PATTERN.test(text)) {
        return { failureClass: "deterministic", detail: `${detail} ${truncate(withStatus.message ?? "input rejected")}` };
      }
    }
    // 408/409/429/5xx are retryable by definition. 401/403/404 and other 4xx
    // usually mean a configuration error (key, model, endpoint). The operator
    // can fix the configuration, so these failures must not drop data.
    return { failureClass: "transient", detail };
  }

  for (const f of chain) {
    if (f.name === "TimeoutError" || f.name === "AbortError") {
      return { failureClass: "transient", detail: f.name };
    }
    const text = `${f.code ?? ""} ${f.message ?? ""}`;
    if (NETWORK_PATTERN.test(text)) {
      return { failureClass: "transient", detail: `network: ${truncate(text.trim())}` };
    }
  }

  // Unknown errors (and reason "exception", for example a store or embedding
  // fault) are transient: retry them, never drop the batch.
  const first = chain[0];
  const fallback = first?.message ? truncate(first.message) : reason ?? "unknown";
  return { failureClass: "transient", detail: fallback };
}

/**
 * Return the retry delay of an L1 extraction failure (`L1ExtractionFailedError`,
 * transient or deterministic), or undefined for any other error. Schedulers
 * re-arm L1 for every such failure: the cursor did not move, and the runner
 * quarantine already bounds the retries of a deterministic group. The check
 * uses duck typing, so schedulers can call it without an import of
 * pipeline-factory (which would make an import cycle).
 */
export function l1RearmDelayMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { name?: unknown; retryAfterMs?: unknown };
  if (e.name !== "L1ExtractionFailedError") return undefined;
  return typeof e.retryAfterMs === "number" && Number.isFinite(e.retryAfterMs) && e.retryAfterMs >= 0
    ? e.retryAfterMs
    : DEFAULT_REARM_DELAY_MS;
}

/** Retry delay when an L1 failure does not carry its own delay. */
const DEFAULT_REARM_DELAY_MS = 60_000;
