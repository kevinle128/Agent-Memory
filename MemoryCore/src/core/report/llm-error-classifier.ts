/**
 * Names the cause of a failed LLM call from the real error object.
 *
 * Core LLM calls run through the Vercel AI SDK. A provider failure arrives as an
 * `APICallError` (status, response headers and body), often wrapped in a
 * `RetryError` after the SDK's own retries (`maxRetries`, default 2). The
 * classifier only reads the error; it never decides what to do about it.
 */

export type LlmErrorKind =
  | "timeout"
  | "aborted"
  | "rate_limit"
  | "quota_exhausted"
  | "overloaded"
  | "server_error"
  | "network"
  | "auth"
  | "context_too_long"
  | "bad_request"
  | "empty_reply"
  | "unparseable"
  | "unknown";

export interface ClassifiedLlmError {
  kind: LlmErrorKind;
  /** Constructor or `name` of the error that carried the cause. */
  errorClass: string;
  httpStatus: number;
  providerErrorType: string;
  providerErrorCode: string;
  /** Wait the provider asked for, in ms; 0 when it gave none. */
  retryAfterMs: number;
  /** Calls the SDK made inside the one runner call, when it says so; 0 when unknown. */
  sdkAttempts: number;
  /** Error text, redacted and bounded. */
  message: string;
  /** Provider response body, redacted and bounded; empty when there is none. */
  responseExcerpt: string;
}

const MAX_MESSAGE_CHARS = 2_048;
export const DEFAULT_EXCERPT_CHARS = 1_024;

/**
 * Remove values that look like credentials. Applied to everything that is
 * stored from a provider response or an error message.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/([?&](?:key|token|access_token|api_key)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted]")
    .replace(/("?(?:authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|secret|password)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1[redacted]")
    .replace(/\b(?:sk|pk|rk|key|tok)[-_][A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
}

function bounded(text: string, max: number): string {
  const clean = redactSecrets(text);
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  cause?: unknown;
  code?: unknown;
  statusCode?: unknown;
  responseHeaders?: unknown;
  responseBody?: unknown;
  lastError?: unknown;
  errors?: unknown;
}

/** Parse a duration such as "1s", "6m0s", "20ms" (OpenAI x-ratelimit-reset-*). */
function parseDurationMs(value: string): number {
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let matched = false;
  for (const m of value.matchAll(re)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "ms" ? n : m[2] === "s" ? n * 1_000 : m[2] === "m" ? n * 60_000 : n * 3_600_000;
  }
  return matched ? Math.round(total) : 0;
}

/** Wait asked for by the response headers, in ms; 0 when there is none. */
export function parseRetryAfterMs(headers: unknown, nowMs: number = Date.now()): number {
  if (!headers || typeof headers !== "object") return 0;
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) h[k.toLowerCase()] = String(v);
  if (h["retry-after-ms"] && Number.isFinite(Number(h["retry-after-ms"]))) return Math.max(0, Math.round(Number(h["retry-after-ms"])));
  const ra = h["retry-after"];
  if (ra) {
    if (/^\d+(\.\d+)?$/.test(ra.trim())) return Math.round(Number(ra) * 1_000);
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - nowMs);
  }
  for (const key of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "x-ratelimit-reset"]) {
    const v = h[key];
    if (!v) continue;
    const d = parseDurationMs(v);
    if (d > 0) return d;
    if (/^\d+$/.test(v.trim())) return Number(v) * 1_000;
  }
  // Anthropic: ISO timestamps of the next reset.
  for (const key of ["anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-reset", "anthropic-ratelimit-input-tokens-reset"]) {
    const v = h[key];
    const date = v ? Date.parse(v) : NaN;
    if (!Number.isNaN(date)) return Math.max(0, date - nowMs);
  }
  return 0;
}

interface ProviderBody { type: string; code: string; message: string }

/** Read `{error:{type,code,message}}` (OpenAI-style) and `{type:"error",error:{type,message}}` (Anthropic-style). */
function parseProviderBody(body: unknown): ProviderBody {
  const empty: ProviderBody = { type: "", code: "", message: "" };
  if (typeof body !== "string" || !body.trim()) return empty;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const err = (parsed.error && typeof parsed.error === "object" ? parsed.error : parsed) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
    return { type: str(err.type), code: str(err.code), message: str(err.message) };
  } catch {
    return { ...empty, message: body.slice(0, 500) };
  }
}

const NETWORK_CODES = /\b(ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)\b/i;
const NETWORK_TEXT = /socket hang up|fetch failed|network error|other side closed|cannot connect to api|connection (?:closed|reset|refused)/i;
const QUOTA_TEXT = /insufficient[_ ]quota|exceeded your current quota|billing|credit balance|out of credits?|credits? (?:are )?exhausted|quota (?:has been )?(?:exceeded|exhausted)|insufficient[_ ](?:balance|funds|credits?)|balance (?:is )?(?:insufficient|too low)|please recharge|payment required/i;
const CONTEXT_TEXT = /context[_ ]length|maximum context|context window|too many tokens|prompt is too long|reduce the length|maximum.{0,30}tokens/i;
/** The output limit, not the context window, was too small or too large. */
const OUTPUT_LIMIT_TEXT = /output tokens|max_tokens|max_completion_tokens|completion tokens/i;
/** A short-window limit (requests or tokens per second or minute), not a used-up quota. */
const SHORT_WINDOW_TEXT = /per[ _-]?(?:second|minute)|requests per|tokens per|\b(?:rpm|tpm|rps)\b/i;
const OVERLOAD_TEXT = /overloaded|server is overloaded|capacity/i;
const TIMEOUT_TEXT = /timed? ?out|timeout|aborted due to timeout/i;

function nameOf(e: ErrorLike): string {
  if (typeof e.name === "string" && e.name && e.name !== "Error") return e.name;
  const ctor = (e as { constructor?: { name?: string } }).constructor?.name;
  return ctor || (typeof e.name === "string" ? e.name : "") || "Error";
}

/**
 * Classify a thrown LLM call error.
 * @param elapsedMs time the call took, to tell a deadline abort from another abort
 * @param timeoutMs deadline of the call
 */
export function classifyLlmError(
  err: unknown,
  elapsedMs: number,
  timeoutMs: number,
  opts: { nowMs?: number; excerptChars?: number } = {},
): ClassifiedLlmError {
  const nowMs = opts.nowMs ?? Date.now();
  const excerptChars = opts.excerptChars ?? DEFAULT_EXCERPT_CHARS;
  // Peel RetryError wrappers: the last error is the one that ended the call.
  let sdkAttempts = 0;
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur && typeof cur === "object"; depth++) {
    const e = cur as ErrorLike;
    if (nameOf(e) === "AI_RetryError" || (e.lastError !== undefined && Array.isArray(e.errors))) {
      sdkAttempts = Array.isArray(e.errors) ? e.errors.length : sdkAttempts;
      cur = e.lastError ?? (Array.isArray(e.errors) ? e.errors[e.errors.length - 1] : undefined);
      continue;
    }
    break;
  }
  const core = (cur && typeof cur === "object" ? cur : { message: String(cur) }) as ErrorLike;
  if (sdkAttempts === 0 && core.statusCode !== undefined) sdkAttempts = 1;
  const errorClass = nameOf(core);
  const rawMessage = typeof core.message === "string" ? core.message : String(cur);
  const status = typeof core.statusCode === "number" ? core.statusCode : 0;
  const body = parseProviderBody(core.responseBody);
  const bodyText = typeof core.responseBody === "string" ? core.responseBody : "";
  const retryAfterMs = parseRetryAfterMs(core.responseHeaders, nowMs);
  const haystack = `${body.type} ${body.code} ${body.message || rawMessage}`;

  const base = {
    errorClass,
    httpStatus: status,
    providerErrorType: bounded(body.type, 128),
    providerErrorCode: bounded(body.code, 128),
    retryAfterMs,
    sdkAttempts,
    message: bounded(rawMessage, MAX_MESSAGE_CHARS),
    responseExcerpt: bodyText ? bounded(bodyText, excerptChars) : "",
  };
  const result = (kind: LlmErrorKind): ClassifiedLlmError => ({ kind, ...base });

  if (status > 0) {
    const codes = `${body.type} ${body.code}`;
    // The provider error code decides first; free text is only a fallback.
    if (status === 429 && /rate_limit/i.test(codes)) return result("rate_limit");
    const quota = /insufficient_quota/i.test(codes) || QUOTA_TEXT.test(haystack);
    if (status === 402) return result("quota_exhausted");
    if (status === 429 && quota && SHORT_WINDOW_TEXT.test(haystack)) return result("rate_limit");
    if ((status === 429 || status === 403 || status === 400) && quota) return result("quota_exhausted");
    if (status === 429) return result("rate_limit");
    if (status === 529 || status === 503 || OVERLOAD_TEXT.test(`${body.type} ${body.message}`)) return result("overloaded");
    if (status === 401 || status === 403) return result("auth");
    if ((status === 400 || status === 413 || status === 422) && (/context_length_exceeded/i.test(codes) || (CONTEXT_TEXT.test(haystack) && !OUTPUT_LIMIT_TEXT.test(haystack)))) {
      return result("context_too_long");
    }
    if (status >= 500) return result("server_error");
    if (status === 408) return result("server_error");
    if (status >= 400) return result("bad_request");
  }

  // No HTTP response: a timeout of our deadline, a network failure or something else.
  for (let c: unknown = cur, depth = 0; c && typeof c === "object" && depth < 5; depth++) {
    const e = c as ErrorLike;
    if (e.name === "TimeoutError") return result("timeout");
    c = e.cause;
  }
  // An abort is a timeout only when the deadline is known and was reached.
  // Other aborts (lost lock, shutdown) are kept apart.
  if (errorClass === "AbortError") return result(timeoutMs > 0 && elapsedMs >= timeoutMs * 0.9 ? "timeout" : "aborted");
  let chain = "";
  for (let c: unknown = cur, depth = 0; c && typeof c === "object" && depth < 5; depth++) {
    const e = c as ErrorLike;
    chain += ` ${typeof e.code === "string" ? e.code : ""} ${typeof e.message === "string" ? e.message : ""}`;
    c = e.cause;
  }
  if (NETWORK_CODES.test(chain) || NETWORK_TEXT.test(chain)) return result("network");
  if (TIMEOUT_TEXT.test(chain)) return result("timeout");
  return result("unknown");
}

/** Kind of a reply that arrived but is not usable, or null when it is usable. */
export function classifyLlmReply(output: string, usable: boolean): "empty_reply" | "unparseable" | null {
  if (usable) return null;
  return output.trim() === "" ? "empty_reply" : "unparseable";
}
