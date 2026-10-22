import { describe, expect, it } from "vitest";

import { classifyCcRequest, detectCcSideRequest } from "../cc-request-classifier.js";

// Bodies below copy the shape of requests captured from Claude Code v2.1.289.
// Content is reduced to what the classifier reads.

const BILLING = { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.289; cc_entrypoint=cli;" };
const IDENTITY = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." };
const TOOLS = [{ name: "Bash" }, { name: "Read" }, { name: "Edit" }];
const cached = (text: string) => ({ type: "text", text, cache_control: { type: "ephemeral" } });

function titleRequest(): Record<string, unknown> {
  return {
    model: "claude-opus-4-8",
    max_tokens: 64000,
    stream: true,
    thinking: { type: "disabled" },
    system: [BILLING, IDENTITY, { type: "text", text: "You are naming a coding session so the user can pick it out of a long list of sessions." }],
    messages: [{ role: "user", content: [{ type: "text", text: "<session>fix the login bug</session>" }] }],
  };
}

function modelProbeRequest(): Record<string, unknown> {
  return {
    model: "claude-fable-5-1",
    max_tokens: 1,
    system: [BILLING, IDENTITY],
    messages: [{ role: "user", content: [cached("Hi")] }],
  };
}

function mainRequest(): Record<string, unknown> {
  return {
    model: "claude-opus-4-8",
    max_tokens: 64000,
    stream: true,
    thinking: { type: "adaptive" },
    tools: TOOLS,
    system: [BILLING, cached("You are Claude Code, Anthropic's official CLI for Claude.")],
    messages: [
      { role: "user", content: [{ type: "text", text: "<system-reminder>context</system-reminder>" }, cached("fix the login bug")] },
    ],
  };
}

describe("detectCcSideRequest", () => {
  it("detects the session-title request by its system prompt", () => {
    expect(detectCcSideRequest(titleRequest())).toBe("title");
  });

  it("detects the title marker when system is a plain string", () => {
    const body = { ...titleRequest(), system: "You are naming a coding session so the user can pick it out." };
    expect(detectCcSideRequest(body)).toBe("title");
  });

  it("detects the model probe by max_tokens 1 and no tools", () => {
    expect(detectCcSideRequest(modelProbeRequest())).toBe("model-probe");
  });

  it("does not treat a one-token request with tools as a probe", () => {
    expect(detectCcSideRequest({ ...modelProbeRequest(), tools: TOOLS })).toBeNull();
  });

  it("returns null for a main turn", () => {
    expect(detectCcSideRequest(mainRequest())).toBeNull();
  });

  it("returns null for a malformed body", () => {
    expect(detectCcSideRequest({ system: 42, max_tokens: "1" })).toBeNull();
  });
});

describe("classifyCcRequest", () => {
  it("classifies the session-title request as sidequery", () => {
    expect(classifyCcRequest(titleRequest())).toBe("sidequery");
  });

  it("classifies the session-title request as sidequery even when it carries a cache marker", () => {
    const body = titleRequest();
    body.messages = [{ role: "user", content: [cached("<session>fix the login bug</session>")] }];
    expect(classifyCcRequest(body)).toBe("sidequery");
  });

  it("classifies the model probe as sidequery although its message has a cache marker", () => {
    expect(classifyCcRequest(modelProbeRequest())).toBe("sidequery");
  });

  it("keeps a main turn with the marker on the last message as main", () => {
    expect(classifyCcRequest(mainRequest())).toBe("main");
  });

  it("keeps a turn with the marker on messages[n-2] as fork", () => {
    const body = mainRequest();
    body.messages = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [cached("answer")] },
      { role: "user", content: [{ type: "text", text: "suggest next step" }] },
    ];
    expect(classifyCcRequest(body)).toBe("fork");
  });
});
