import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { classifyL1Failure, l1RearmDelayMs } from "./l1-failure.js";

function apiError(statusCode: number | undefined, message = "error", responseBody?: string): APICallError {
  return new APICallError({ message, url: "https://llm.example/v1/chat", requestBodyValues: {}, statusCode, responseBody });
}

function retryError(last: unknown): RetryError {
  return new RetryError({ message: "Failed after 3 attempts", reason: "maxRetriesExceeded", errors: [last] });
}

describe("classifyL1Failure", () => {
  it.each(["no_json", "parse_fail", "not_array", "normalized_all_dropped"] as const)(
    "classifies answer-shape reason %s as deterministic",
    (reason) => {
      expect(classifyL1Failure(reason, undefined)).toEqual({ failureClass: "deterministic", detail: reason });
    },
  );

  it.each([408, 409, 429, 500, 502, 503, 504])("classifies status %i as transient", (status) => {
    expect(classifyL1Failure("llm_error", apiError(status)).failureClass).toBe("transient");
  });

  it.each([401, 403, 404, 418])("classifies configuration-type status %i as transient (never drops data)", (status) => {
    expect(classifyL1Failure("llm_error", apiError(status, "Unauthorized")).failureClass).toBe("transient");
  });

  it("unwraps AI_RetryError.lastError", () => {
    const result = classifyL1Failure("llm_error", retryError(apiError(429, "Too Many Requests")));
    expect(result).toEqual({ failureClass: "transient", detail: "status=429" });
  });

  it.each([
    [400, "This model's maximum context length is 128000 tokens", undefined],
    [400, "Bad Request", '{"error":{"code":"context_length_exceeded"}}'],
    [413, "Request too large: too many tokens", undefined],
    [422, "Unprocessable", '{"error":"content_filter triggered"}'],
    [400, "Input data may contain inappropriate content", '{"code":"data_inspection_failed"}'],
    [400, "blocked by safety system", undefined],
    [400, "prompt is too long: 210000 tokens > 200000 maximum", undefined],
  ])("classifies input rejection status %i (%s) as deterministic", (status, message, body) => {
    const result = classifyL1Failure("llm_error", apiError(status, message, body));
    expect(result.failureClass).toBe("deterministic");
    expect(result.detail).toContain(`status=${status}`);
  });

  it("classifies an input rejection inside AI_RetryError as deterministic", () => {
    const err = retryError(apiError(400, "maximum context length exceeded"));
    expect(classifyL1Failure("llm_error", err).failureClass).toBe("deterministic");
  });

  it("classifies a plain 400 without an input-rejection message as transient", () => {
    expect(classifyL1Failure("llm_error", apiError(400, "Bad Request", "{}")).failureClass).toBe("transient");
  });

  it("classifies an oversized max_tokens setting as transient", () => {
    const err = apiError(400, "max_tokens is too large: 200000. This model supports at most 8192 completion tokens");
    expect(classifyL1Failure("llm_error", err).failureClass).toBe("transient");
  });

  it("classifies a context-length text on a 5xx as transient", () => {
    expect(classifyL1Failure("llm_error", apiError(503, "maximum context overloaded")).failureClass).toBe("transient");
  });

  it.each(["TimeoutError", "AbortError"])("classifies %s as transient", (name) => {
    const err = Object.assign(new Error("The operation was aborted"), { name });
    expect(classifyL1Failure("llm_error", err)).toEqual({ failureClass: "transient", detail: name });
  });

  it("classifies network faults found in the cause chain as transient", () => {
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }) });
    const result = classifyL1Failure("llm_error", err);
    expect(result.failureClass).toBe("transient");
    expect(result.detail).toMatch(/^network:/);
  });

  it("finds a status deep in the cause chain", () => {
    const inner = apiError(400, "context_length_exceeded");
    const err = new Error("wrapper 1", { cause: new Error("wrapper 2", { cause: inner }) });
    expect(classifyL1Failure("llm_error", err).failureClass).toBe("deterministic");
  });

  it("stops after a bounded depth and on cycles", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b", { cause: a });
    a.cause = b;
    expect(classifyL1Failure("llm_error", a).failureClass).toBe("transient");

    let deep: unknown = apiError(400, "context_length_exceeded");
    for (let i = 0; i < 10; i++) deep = new Error(`w${i}`, { cause: deep });
    // The status is too deep to see, so the error stays transient (safe).
    expect(classifyL1Failure("llm_error", deep).failureClass).toBe("transient");
  });

  it("classifies unknown errors and reason exception as transient", () => {
    expect(classifyL1Failure("llm_error", new Error("boom")).failureClass).toBe("transient");
    expect(classifyL1Failure("exception", new Error("store down")).failureClass).toBe("transient");
    expect(classifyL1Failure("exception", undefined)).toEqual({ failureClass: "transient", detail: "exception" });
    expect(classifyL1Failure(undefined, "plain string").failureClass).toBe("transient");
  });
});

describe("l1RearmDelayMs", () => {
  it("returns the delay of a transient L1ExtractionFailedError", () => {
    const err = Object.assign(new Error("x"), { name: "L1ExtractionFailedError", failureClass: "transient", retryAfterMs: 1234 });
    expect(l1RearmDelayMs(err)).toBe(1234);
  });

  it("returns the delay of a deterministic L1ExtractionFailedError too", () => {
    const det = Object.assign(new Error("x"), { name: "L1ExtractionFailedError", failureClass: "deterministic", retryAfterMs: 60_000 });
    expect(l1RearmDelayMs(det)).toBe(60_000);
  });

  it("uses a default when the delay is missing or invalid", () => {
    const err = Object.assign(new Error("x"), { name: "L1ExtractionFailedError", failureClass: "transient", retryAfterMs: Number.NaN });
    expect(l1RearmDelayMs(err)).toBe(60_000);
  });

  it("returns undefined for other errors", () => {
    expect(l1RearmDelayMs(new Error("x"))).toBeUndefined();
    expect(l1RearmDelayMs(Object.assign(new Error("x"), { name: "AI_APICallError", retryAfterMs: 5 }))).toBeUndefined();
    expect(l1RearmDelayMs(undefined)).toBeUndefined();
  });
});
