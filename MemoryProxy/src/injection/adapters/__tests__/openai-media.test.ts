import { describe, expect, it } from "vitest";
import { OpenAIAdapter } from "../openai.js";
import type { AgentContextMetadata } from "../../types.js";

const metadata: AgentContextMetadata = {
  protocol: "openai", traceId: "test", keyId: "test", modelId: "test",
  stream: false, agentSource: "test",
};

const image = { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } };

function toolBody(content: unknown) {
  return {
    messages: [
      {
        role: "assistant", content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content },
    ],
  };
}

function roundTrip(body: Record<string, unknown>) {
  const adapter = new OpenAIAdapter();
  return adapter.serialize(adapter.parse(structuredClone(body), metadata));
}

describe("OpenAI media round-trip", () => {
  it("keeps an image inside a tool message", () => {
    const body = toolBody([{ type: "text", text: "caption" }, image]);
    expect(roundTrip(body).messages).toEqual(body.messages);
  });

  it("keeps a text-part array tool message as an array", () => {
    const body = toolBody([{ type: "text", text: "a" }, { type: "text", text: "b" }]);
    expect(roundTrip(body).messages).toEqual(body.messages);
  });

  it("keeps a plain string tool message as a string", () => {
    const body = toolBody("file text");
    expect(roundTrip(body).messages).toEqual(body.messages);
  });

  it("keeps the image when a hook changes the tool text", () => {
    const adapter = new OpenAIAdapter();
    const ctx = adapter.parse(toolBody([{ type: "text", text: "old" }, image]), metadata);
    ctx.messages[1].blocks[0].content = "new";
    const msgs = adapter.serialize(ctx).messages as Array<Record<string, unknown>>;
    expect(msgs[1].content).toEqual([{ type: "text", text: "new" }, image]);
  });

  it("keeps unknown user content parts unchanged", () => {
    const body = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "listen" },
          { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } },
        ],
      }],
    };
    expect(roundTrip(body).messages).toEqual(body.messages);
  });
});
