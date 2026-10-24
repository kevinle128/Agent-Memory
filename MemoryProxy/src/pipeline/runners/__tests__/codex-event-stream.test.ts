import { describe, expect, it } from "vitest";
import { isEventStreamResponse } from "../codex.js";

describe("isEventStreamResponse", () => {
  it("accepts an explicit event-stream content type", () => {
    expect(isEventStreamResponse("text/event-stream; charset=utf-8", true)).toBe(true);
    expect(isEventStreamResponse("Text/Event-Stream", false)).toBe(true);
  });

  it("treats a missing content type as a stream when the request asked for one", () => {
    expect(isEventStreamResponse("", true)).toBe(true);
  });

  it("keeps a missing content type as a plain body for a non-stream request", () => {
    expect(isEventStreamResponse("", false)).toBe(false);
  });

  it("never treats JSON as a stream", () => {
    expect(isEventStreamResponse("application/json", true)).toBe(false);
  });
});
