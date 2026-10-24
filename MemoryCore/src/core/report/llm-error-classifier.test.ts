import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";

import { classifyLlmError, classifyLlmReply, parseRetryAfterMs, redactSecrets } from "./llm-error-classifier.js";

const api = (statusCode: number, body: unknown, headers: Record<string, string> = {}, message = "Provider error") =>
  new APICallError({
    message, url: "https://api.example.com/v1/chat/completions", requestBodyValues: {}, statusCode,
    responseHeaders: headers, responseBody: typeof body === "string" ? body : JSON.stringify(body), isRetryable: statusCode >= 500 || statusCode === 429,
  });
const openai = (type: string, code: string | null, message: string) => ({ error: { message, type, param: null, code } });
const anthropic = (type: string, message: string) => ({ type: "error", error: { type, message } });
const classify = (e: unknown, elapsed = 100, timeout = 60_000) => classifyLlmError(e, elapsed, timeout);

describe("classifyLlmError by provider response", () => {
  it("429 per-minute limit is rate_limit and reads Retry-After seconds", () => {
    const c = classify(api(429, openai("requests", "rate_limit_exceeded", "Rate limit reached for gpt-4o in organization org-x on requests per min (RPM): Limit 3, Used 3."), { "retry-after": "20" }));
    expect(c).toMatchObject({ kind: "rate_limit", httpStatus: 429, providerErrorType: "requests", providerErrorCode: "rate_limit_exceeded", retryAfterMs: 20_000, sdkAttempts: 1, errorClass: "AI_APICallError" });
  });

  it("reads Retry-After as an HTTP date and OpenAI reset headers", () => {
    const now = Date.parse("2026-10-24T12:00:00Z");
    expect(parseRetryAfterMs({ "Retry-After": "Sat, 24 Oct 2026 12:00:30 GMT" }, now)).toBe(30_000);
    expect(parseRetryAfterMs({ "retry-after-ms": "1500" })).toBe(1500);
    expect(parseRetryAfterMs({ "x-ratelimit-reset-requests": "6m0s" })).toBe(360_000);
    expect(parseRetryAfterMs({ "x-ratelimit-reset-tokens": "20ms" })).toBe(20);
    expect(parseRetryAfterMs({ "anthropic-ratelimit-requests-reset": "2026-10-24T12:01:00Z" }, now)).toBe(60_000);
    expect(parseRetryAfterMs({})).toBe(0);
  });

  it("Anthropic rate_limit_error is rate_limit", () => {
    expect(classify(api(429, anthropic("rate_limit_error", "This request would exceed your organization's rate limit of 50 requests per minute"), { "retry-after": "12" })))
      .toMatchObject({ kind: "rate_limit", providerErrorType: "rate_limit_error", retryAfterMs: 12_000 });
  });

  it("429 insufficient_quota is quota_exhausted, not rate_limit", () => {
    expect(classify(api(429, openai("insufficient_quota", "insufficient_quota", "You exceeded your current quota, please check your plan and billing details."))))
      .toMatchObject({ kind: "quota_exhausted", httpStatus: 429, providerErrorCode: "insufficient_quota" });
  });

  it("402 and a 403 or 400 about credit are quota_exhausted", () => {
    expect(classify(api(402, { error: { message: "Payment required" } })).kind).toBe("quota_exhausted");
    expect(classify(api(400, anthropic("invalid_request_error", "Your credit balance is too low to access the Anthropic API."))).kind).toBe("quota_exhausted");
    expect(classify(api(403, { error: { message: "Account balance insufficient, please recharge", code: "insufficient_balance" } })).kind).toBe("quota_exhausted");
  });

  it("529 and 503 and an overloaded body are overloaded", () => {
    expect(classify(api(529, anthropic("overloaded_error", "Overloaded"))).kind).toBe("overloaded");
    expect(classify(api(503, openai("server_error", null, "The server is overloaded or not ready yet."))).kind).toBe("overloaded");
    expect(classify(api(500, anthropic("overloaded_error", "Overloaded"))).kind).toBe("overloaded");
    expect(classify(api(503, "<html>Service Unavailable</html>")).kind).toBe("overloaded");
  });

  it("other 5xx are server_error", () => {
    for (const status of [500, 502, 504]) expect(classify(api(status, openai("server_error", null, "The server had an error"))).kind).toBe("server_error");
  });

  it("401 and a 403 that is not about quota are auth", () => {
    expect(classify(api(401, openai("invalid_request_error", "invalid_api_key", "Incorrect API key provided: sk-abc***"))).kind).toBe("auth");
    expect(classify(api(403, { error: { message: "Forbidden", type: "permission_error" } })).kind).toBe("auth");
  });

  it("400 context_length_exceeded and Anthropic prompt too long are context_too_long", () => {
    expect(classify(api(400, openai("invalid_request_error", "context_length_exceeded", "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens."))).kind).toBe("context_too_long");
    expect(classify(api(400, anthropic("invalid_request_error", "prompt is too long: 250000 tokens > 200000 maximum"))).kind).toBe("context_too_long");
  });

  it("a 429 with a rate-limit code or a per-minute limit is rate_limit even when the text mentions billing or quota", () => {
    expect(classify(api(429, openai("requests", "rate_limit_exceeded", "Rate limit reached. Visit https://platform.openai.com/account/billing to upgrade.")) ).kind).toBe("rate_limit");
    expect(classify(api(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric 'Generate Content API requests per minute'" } })).kind).toBe("rate_limit");
  });

  it("a 400 about the output token limit is bad_request, not context_too_long", () => {
    expect(classify(api(400, openai("invalid_request_error", null, "max_tokens is too large: the maximum allowed number of output tokens is 8192"))).kind).toBe("bad_request");
  });

  it("other 4xx are bad_request", () => {
    expect(classify(api(400, openai("invalid_request_error", null, "Unsupported parameter: 'foo'"))).kind).toBe("bad_request");
    expect(classify(api(404, openai("invalid_request_error", "model_not_found", "The model does not exist"))).kind).toBe("bad_request");
    expect(classify(api(422, "not json")).kind).toBe("bad_request");
  });

  it("unwraps a RetryError and records the SDK attempts", () => {
    const errors = [api(429, openai("requests", "rate_limit_exceeded", "slow down")), api(429, openai("requests", "rate_limit_exceeded", "slow down")), api(429, openai("requests", "rate_limit_exceeded", "slow down"))];
    const retry = new RetryError({ message: "Failed after 3 attempts. Last error: slow down", reason: "maxRetriesExceeded", errors });
    expect(classify(retry)).toMatchObject({ kind: "rate_limit", sdkAttempts: 3, httpStatus: 429 });
  });
});

describe("classifyLlmError without a response", () => {
  it("our deadline is timeout", () => {
    const e = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(classify(e)).toMatchObject({ kind: "timeout", errorClass: "TimeoutError", httpStatus: 0 });
  });

  it("an abort near the deadline is timeout, an early abort is not", () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(classify(abort, 59_000, 60_000).kind).toBe("timeout");
    expect(classify(abort, 1_000, 60_000).kind).toBe("aborted");
    // Without a known deadline an abort is never called a timeout.
    expect(classify(abort, 5_000, 0).kind).toBe("aborted");
  });

  it("connection failures are network", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
    const wrapped = new APICallError({
      message: "Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9", url: "http://127.0.0.1:9/v1/chat/completions",
      requestBodyValues: {}, cause: Object.assign(new TypeError("fetch failed"), { cause: refused }), isRetryable: true,
    });
    expect(classify(wrapped).kind).toBe("network");
    expect(classify(new RetryError({ message: "Failed after 3 attempts", reason: "maxRetriesExceeded", errors: [wrapped, wrapped, wrapped] }))).toMatchObject({ kind: "network", sdkAttempts: 3 });
    for (const msg of ["getaddrinfo ENOTFOUND api.example.com", "read ECONNRESET", "socket hang up", "fetch failed", "other side closed"]) {
      expect(classify(new Error(msg)).kind).toBe("network");
    }
  });

  it("anything else is unknown and keeps the class and message", () => {
    const c = classify(new RangeError("something odd"));
    expect(c).toMatchObject({ kind: "unknown", errorClass: "RangeError", message: "something odd" });
  });
});

describe("stored text is bounded and redacted", () => {
  it("cuts the body excerpt and redacts keys and bearer tokens", () => {
    const body = JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-abcdefghijklmnop1234", detail: "x".repeat(5000) }, authorization: "Bearer abc.def.ghi" });
    const c = classifyLlmError(api(401, body), 1, 1000, { excerptChars: 300 });
    expect(c.responseExcerpt.length).toBeLessThanOrEqual(303);
    expect(c.responseExcerpt).not.toContain("sk-proj-abcdefghijklmnop1234");
    expect(c.message).not.toMatch(/sk-proj/);
  });

  it("redacts common credential shapes", () => {
    const out = redactSecrets('Authorization: Bearer sk-live-1234567890abcdef, "api_key": "AbCd1234", x-api-key=secretvalue token abcdefghijklmnopqrstuvwxyz0123456789ABCD');
    expect(out).not.toMatch(/sk-live|AbCd1234|secretvalue|abcdefghijklmnopqrstuvwxyz0123456789ABCD/);
    const more = redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA== url=https://x.test/v1?key=AIzaSyA1234567890abcdefghijklmnopqrs&token=t0ps3cr3t");
    expect(more).not.toMatch(/dXNlcjpwYXNzd29yZA|AIzaSy|t0ps3cr3t/);
  });
});

describe("classifyLlmReply", () => {
  it("names an unusable reply", () => {
    expect(classifyLlmReply("", false)).toBe("empty_reply");
    expect(classifyLlmReply("  \n", false)).toBe("empty_reply");
    expect(classifyLlmReply("no json", false)).toBe("unparseable");
    expect(classifyLlmReply("{}", true)).toBeNull();
  });
});
