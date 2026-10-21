import { describe, expect, it } from "vitest";
import { extractTraceUserQuery } from "../trace-user-query.js";

describe("extractTraceUserQuery", () => {
  const previous = { role: "user", content: "Previous question" };

  it("extracts the latest text question and skips system/developer messages", () => {
    expect(extractTraceUserQuery([previous, { role: "user", content: "New question" },
      { role: "system", content: "Injected context" }, { role: "developer", content: "Instructions" }]))
      .toBe("New question");
  });

  it("keeps the question accompanying an Anthropic image, without serializing the image", () => {
    expect(extractTraceUserQuery([{ role: "user", content: [
      { type: "text", text: "<system-reminder>IDE context</system-reminder>" },
      { type: "text", text: "Describe this image" },
      { type: "image", source: { type: "base64", data: "image-data" } },
    ] }])).toBe("Describe this image");
  });

  it("extracts explicit user queries from client wrappers", () => {
    expect(extractTraceUserQuery([{ role: "user", content:
      "<additional_data>IDE context</additional_data><user_query>Fix the bug</user_query>" }]))
      .toBe("Fix the bug");
  });

  it("supports Responses input_text blocks", () => {
    expect(extractTraceUserQuery([{ type: "message", role: "user", content: [
      { type: "input_text", text: "First line" }, { type: "input_text", text: "Second line" },
    ] }])).toBe("First line\nSecond line");
  });

  it.each([
    { role: "user", content: [{ type: "tool_result", content: "file contents" }] },
    { role: "user", content: [{ type: "tool_result", content: "file contents" },
      { type: "text", text: "<system-reminder>Context</system-reminder>" }] },
    { role: "tool", content: "file contents" },
    { type: "function_call_output", output: "file contents" },
    { role: "assistant", content: "Answer" },
    { role: "user", content: [{ type: "image", source: { data: "image-data" } }] },
  ])("does not reuse a previous question for a continuation: %j", (continuation) => {
    expect(extractTraceUserQuery([previous, continuation])).toBe("");
  });

  it("retains a new question sent alongside a tool result", () => {
    expect(extractTraceUserQuery([previous, { role: "user", content: [
      { type: "tool_result", content: "file contents" }, { type: "text", text: "Now explain it" },
    ] }])).toBe("Now explain it");
  });

  it("ignores malformed messages and handles empty history", () => {
    expect(extractTraceUserQuery([])).toBe("");
    expect(extractTraceUserQuery([null, 42, { role: "user", content: [null, "bad", { type: "text", text: 7 }] }]))
      .toBe("");
  });
});
