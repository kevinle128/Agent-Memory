import { afterEach, describe, expect, it, vi } from "vitest";

import { TdaiClient } from "../client.js";
import {
  extractCurrentTurnUserMessage,
  extractLatestUserMessage,
  recordTdaiTurn,
  resolveL0Capture,
} from "../recorder.js";
import type { TdaiIdentity } from "../types.js";
import { isSubagentRequest } from "../../session-trace/subagent.js";

const identity: TdaiIdentity = {
  teamId: "t1", userId: "u1", agentId: "a1", sessionId: "s1",
  projectKey: "git:h/x/demo", projectHash: "0123456789abcdef",
};

const humanTurn = [{ role: "user", content: [{ type: "text", text: "fix the login bug" }] }];
const toolStep = [
  { role: "user", content: [{ type: "text", text: "fix the login bug" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] },
  { role: "system", content: [{ type: "text", text: "hook output" }] },
];

afterEach(() => vi.unstubAllGlobals());

function client(): { client: TdaiClient; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ code: 0, data: {} }));
  }));
  return {
    bodies,
    client: new TdaiClient({
      enabled: true, endpoint: "http://core.test", apiKey: "k", serviceId: "default",
      writeL0: true, recallL1: false, injectL2L3: false, l1Limit: 5, l2Limit: 3, timeoutMs: 1000,
    }),
  };
}

const capture = (
  agentSource: string,
  headers: Record<string, string>,
  messages: unknown[],
  format: "anthropic" | "openai" = "anthropic",
  sessionJustRegistered = false,
) =>
  resolveL0Capture({
    agentSource, headers, body: { messages }, messages, messageFormat: format, sessionJustRegistered,
    fallbackUserMessage: extractLatestUserMessage(messages),
  });

describe("extractCurrentTurnUserMessage", () => {
  it("returns the human query of the last user message", () => {
    expect(extractCurrentTurnUserMessage(humanTurn)).toEqual({ role: "user", content: "fix the login bug" });
  });

  it("returns null for a tool-loop step instead of the older prompt", () => {
    expect(extractCurrentTurnUserMessage(toolStep)).toBeNull();
    expect(extractLatestUserMessage(toolStep)).toEqual({ role: "user", content: "fix the login bug" });
  });
});

describe("isSubagentRequest", () => {
  it("is true only with the Claude Code agent id header", () => {
    expect(isSubagentRequest("claude-code", { "x-claude-code-agent-id": "a1" }, {})).toBe(true);
    expect(isSubagentRequest("claude-code", { "x-claude-code-session-id": "s1" }, {})).toBe(false);
  });

  it("is false for agents without a detector and for unknown agents", () => {
    expect(isSubagentRequest("codex", { "x-claude-code-agent-id": "a1" }, {})).toBe(false);
    expect(isSubagentRequest("nobody", {}, {})).toBe(false);
  });
});

describe("L0 write for Claude Code", () => {
  it("writes nothing for a subagent request", async () => {
    const cap = capture("claude-code", { "x-claude-code-agent-id": "a1" }, humanTurn);
    expect(cap.skip).toBe(true);
    const { client: c, bodies } = client();
    if (!cap.skip) await recordTdaiTurn(c, identity, cap.userMessage, "reply", { allowAssistantOnly: cap.allowAssistantOnly });
    expect(bodies).toHaveLength(0);
  });

  it("writes user and assistant rows with project fields for a human turn of the lead", async () => {
    const cap = capture("claude-code", { "x-claude-code-session-id": "s1" }, humanTurn);
    expect(cap.skip).toBe(false);
    const { client: c, bodies } = client();
    await recordTdaiTurn(c, identity, cap.userMessage, "on it", { allowAssistantOnly: cap.allowAssistantOnly });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ project_key: "git:h/x/demo", project_hash: "0123456789abcdef" });
    expect(bodies[0]!.messages).toEqual([
      { role: "user", content: "fix the login bug" },
      { role: "assistant", content: "on it" },
    ]);
  });

  it("writes only the assistant row for a tool-loop step", async () => {
    const cap = capture("claude-code", {}, toolStep);
    expect(cap.userMessage).toBeNull();
    const { client: c, bodies } = client();
    await recordTdaiTurn(c, identity, cap.userMessage, "reading the file", { allowAssistantOnly: cap.allowAssistantOnly });
    expect(bodies[0]!.messages).toEqual([{ role: "assistant", content: "reading the file" }]);
  });

  it("writes no row for a tool-loop step without assistant text", async () => {
    const cap = capture("claude-code", {}, toolStep);
    const { client: c, bodies } = client();
    await recordTdaiTurn(c, identity, cap.userMessage, "  ", { allowAssistantOnly: cap.allowAssistantOnly });
    await recordTdaiTurn(c, identity, cap.userMessage, null, { allowAssistantOnly: cap.allowAssistantOnly });
    expect(bodies).toHaveLength(0);
  });

  it("keeps the OpenAI-format fallback user message but still skips subagents", () => {
    const openai = [{ role: "user", content: "hi" }, { role: "tool", content: "out" }];
    const lead = capture("claude-code", {}, openai, "openai");
    expect(lead).toMatchObject({ skip: false, allowAssistantOnly: false, userMessage: { role: "user", content: "hi" } });
    expect(capture("claude-code", { "x-claude-code-agent-id": "a1" }, openai, "openai").skip).toBe(true);
  });
});

describe("L0 write for other agents", () => {
  it("keeps the fallback user message, never skips, and drops assistant-only writes", async () => {
    const cap = capture("codebuddy", { "x-agent-type": "subagent" }, toolStep);
    expect(cap).toEqual({
      skip: false,
      userMessage: { role: "user", content: "fix the login bug" },
      allowAssistantOnly: false,
    });
    const { client: c, bodies } = client();
    await recordTdaiTurn(c, identity, null, "text");
    expect(bodies).toHaveLength(0);
  });
});

describe("L0 human text edge cases for Claude Code", () => {
  const text = (t: string) => ({ type: "text", text: t });
  const toolResult = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "out" });

  it("keeps the first human prompt on the last request of session init", () => {
    const form = [
      { role: "user", content: [text("build the exporter")] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_q1", name: "AskUserQuestion", input: {} }] },
      { role: "user", content: [toolResult("toolu_q1")] },
    ];
    expect(capture("claude-code", {}, form).userMessage).toBeNull();
    expect(capture("claude-code", {}, form, "anthropic", true).userMessage)
      .toEqual({ role: "user", content: "build the exporter" });
  });

  it("keeps the human question when the last user message answers a proxy skill load", () => {
    const messages = [
      { role: "user", content: [text("deploy the service")] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_skload_1", name: "Skill", input: {} }] },
      { role: "user", content: [toolResult("toolu_skload_1")] },
    ];
    expect(capture("claude-code", {}, messages).userMessage).toEqual({ role: "user", content: "deploy the service" });
  });

  it("does not walk back for a mix of skill-load and client tool results", () => {
    const messages = [
      { role: "user", content: [text("deploy the service")] },
      { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] },
      { role: "user", content: [toolResult("toolu_skload_1"), toolResult("toolu_real")] },
    ];
    expect(capture("claude-code", {}, messages).userMessage).toBeNull();
  });

  it("does not re-write the old user text after a final assistant reply", () => {
    const messages = [
      { role: "user", content: [text("explain the cache")] },
      { role: "assistant", content: [text("final answer")] },
      { role: "system", content: [text("hook output")] },
    ];
    expect(extractCurrentTurnUserMessage(messages)).toBeNull();
  });

  it("drops the SKILL.md body that follows a tool result", () => {
    const messages = [
      { role: "user", content: [text("run the skill")] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Skill", input: {} }] },
      { role: "user", content: [toolResult("t1"), text("Base directory for this skill: /x/skills/demo\n\n# Demo\nDo things.")] },
    ];
    expect(extractCurrentTurnUserMessage(messages)).toBeNull();
  });

  it("drops a system-reminder text block that follows a tool result", () => {
    const messages = [
      { role: "user", content: [text("run it")] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [toolResult("t1"), text("<system-reminder>\nTask tools are idle.\n</system-reminder>")] },
    ];
    expect(extractCurrentTurnUserMessage(messages)).toBeNull();
  });

  it("keeps human text typed next to a skill body", () => {
    const messages = [
      { role: "user", content: [text("Base directory for this skill: /x\n# Demo"), text("now do it")] },
    ];
    expect(extractCurrentTurnUserMessage(messages)).toEqual({ role: "user", content: "now do it" });
  });
});
