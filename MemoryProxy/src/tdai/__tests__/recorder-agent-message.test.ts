import { describe, expect, it } from "vitest";
import { extractCurrentTurnUserMessage, extractLatestUserMessage, resolveL0Capture, stripAgentMessages, stripAgentMessagesFromContent } from "../recorder.js";

// Shape of the Paseo messages seen in production L0 rows.
const paseo = (body: string, kind = "agent-message") =>
  `<paseo-system version="1" kind="${kind}" source-agent-id="5f5db233" message-id="8f59b110" source-agent-title="lead">\n${body}\n</paseo-system>`;

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

describe("Paseo agent messages and L0", () => {
  it("does not take a delegated task as the human text of the turn", () => {
    expect(extractCurrentTurnUserMessage([user(paseo("Fix the upstream bug. End with Status: DONE."))])).toBeNull();
  });

  it("drops notifications too", () => {
    expect(extractCurrentTurnUserMessage([user(paseo("Agent finished.", "agent-notification"))])).toBeNull();
  });

  it("keeps human text written next to an agent message", () => {
    const msg = extractCurrentTurnUserMessage([user(`${paseo("task")}\nPlease also check the tests.`)]);
    expect(msg?.content).toBe("Please also check the tests.");
  });

  it("for L0, does not walk back to an older human message", () => {
    const messages = [user("an older human question"), assistant("answer"), user(paseo("task"))];
    expect(extractLatestUserMessage(messages, { forL0: true })).toBeNull();
  });

  it("keeps the agent message for other uses", () => {
    expect(extractLatestUserMessage([user(paseo("task body"))])?.content).toContain("task body");
  });

  it("writes no user row for a Claude Code worker turn that holds only an agent message", () => {
    const messages = [user(paseo("task"))];
    const capture = resolveL0Capture({
      agentSource: "claude-code", headers: {}, body: { messages }, messages, messageFormat: "anthropic",
      fallbackUserMessage: extractLatestUserMessage(messages, { forL0: true }),
    });
    expect(capture.skip).toBe(false);
    expect(capture.userMessage).toBeNull();
  });

  it("does not end a block at a closing tag quoted inside the task", () => {
    const text = `${paseo("Fix the regex for </paseo-system> tags.")}\nhuman note`;
    expect(stripAgentMessages(text).trim()).toBe("human note");
  });

  it("keeps human text between two blocks and an unclosed block", () => {
    expect(stripAgentMessages(`${paseo("a")}\nbetween\n${paseo("b")}`).trim()).toBe("between");
    const unclosed = "<paseo-system kind=\"agent-message\">no end";
    expect(stripAgentMessages(unclosed)).toBe(unclosed);
  });

  it("stays fast on many unclosed openers", () => {
    const big = "<paseo-system ".repeat(16_000);
    const t0 = Date.now();
    stripAgentMessages(big);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("strips text blocks of structured content", () => {
    expect(stripAgentMessagesFromContent([{ type: "text", text: `${paseo("x")}hi` }, { type: "image" }]))
      .toEqual([{ type: "text", text: "hi" }, { type: "image" }]);
  });
});
