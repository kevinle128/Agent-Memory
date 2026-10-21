import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../anthropic.js";
import type { AgentContextMetadata } from "../../types.js";

const metadata: AgentContextMetadata = {
  protocol: "anthropic", traceId: "test", keyId: "test", modelId: "test",
  stream: false, agentSource: "claude-code",
};

const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };

function toolResultBody(content: unknown) {
  return {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.png" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] },
    ],
  };
}

describe("Anthropic media round-trip", () => {
  it("keeps an image inside a tool_result", () => {
    const adapter = new AnthropicAdapter();
    const body = toolResultBody([image]);
    const result = adapter.serialize(adapter.parse(structuredClone(body), metadata));
    expect(result.messages).toEqual(body.messages);
  });

  it("keeps text and image order inside a tool_result", () => {
    const adapter = new AnthropicAdapter();
    const body = toolResultBody([{ type: "text", text: "caption" }, image]);
    const result = adapter.serialize(adapter.parse(structuredClone(body), metadata));
    expect(result.messages).toEqual(body.messages);
  });

  it("keeps the image when a hook changes the tool_result text", () => {
    const adapter = new AnthropicAdapter();
    const ctx = adapter.parse(toolResultBody([{ type: "text", text: "old" }, image]), metadata);
    ctx.messages[1].blocks[0].content = "new";
    const msgs = adapter.serialize(ctx).messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msgs[1].content[0].content).toEqual([{ type: "text", text: "new" }, image]);
  });

  it("keeps a plain string tool_result as a string", () => {
    const adapter = new AnthropicAdapter();
    const body = toolResultBody("file text");
    expect(adapter.serialize(adapter.parse(structuredClone(body), metadata)).messages).toEqual(body.messages);
  });

  it("keeps a url image source", () => {
    const adapter = new AnthropicAdapter();
    const body = { messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/a.png" } }] }] };
    expect(adapter.serialize(adapter.parse(structuredClone(body), metadata)).messages).toEqual(body.messages);
  });
});
