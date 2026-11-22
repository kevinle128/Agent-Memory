import { describe, expect, it } from "vitest";

import { AnthropicAdapter } from "../adapters/anthropic.js";
import { OpenAIAdapter } from "../adapters/openai.js";
import type { ProtocolAdapter } from "../adapters/interface.js";
import { InjectionPipeline } from "../pipeline.js";
import { HookRegistryImpl } from "../registry.js";
import type { AgentContextMetadata, ContextBlock, InjectionHook } from "../types.js";
import { injectCodexAssets } from "../../pipeline/runners/codex.js";
import { injectWorkbuddyAssets } from "../../pipeline/runners/workbuddy.js";

const anthropicMeta: AgentContextMetadata = {
  protocol: "anthropic",
  traceId: "t",
  keyId: "k",
  modelId: "m",
  stream: false,
  agentSource: "claude-code",
};

const openaiMeta: AgentContextMetadata = {
  protocol: "openai",
  traceId: "t",
  keyId: "k",
  modelId: "m",
  stream: false,
  agentSource: "codex",
};

function suffixHook(text: string): InjectionHook {
  return {
    id: "suffix-hook",
    point: "system.suffix",
    priority: 1,
    description: "append one text block",
    execute: () => [{ type: "text", content: text } satisfies ContextBlock],
  };
}

function pipeline(protocol: "anthropic" | "openai", hook?: InjectionHook) {
  const registry = new HookRegistryImpl();
  if (hook) registry.register(hook);
  const adapter = protocol === "anthropic" ? new AnthropicAdapter() : new OpenAIAdapter();
  return new InjectionPipeline(registry, new Map<string, ProtocolAdapter>([[protocol, adapter]]));
}

const textPart = {
  type: "text",
  text: "result",
  cache_control: { type: "ephemeral" },
  client_tag: "part",
};
const imagePart = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "aaaa", client_tag: "src" },
  client_tag: "img",
};

describe("acceptance evidence for forwarded content", () => {
  it("keeps Responses input parts and only appends the Codex injection", () => {
    const rules = { type: "input_text", text: "Follow the tool rules.", cache_control: { type: "ephemeral" }, client_tag: "rules" };
    const user = { type: "input_text", text: "hi", client_tag: "user" };
    const later = { type: "message", role: "user", content: [user], client_tag: "turn" };
    const body = {
      model: "gpt-5",
      input: [
        { type: "message", role: "developer", content: [rules], client_tag: "dev" },
        later,
      ],
    };

    const sent = injectCodexAssets(body, { raw: "INJECT" });
    const input = sent.input as Array<Record<string, unknown>>;
    const content = input[0].content as unknown[];

    expect(content).toHaveLength(2);
    expect(content[0]).toBe(rules);
    expect(input[1]).toBe(later);
    expect(input[0].client_tag).toBe("dev");
    expect((content[1] as { text: string }).text).toContain("INJECT");
    expect(body.input[0]).not.toBe(input[0]);
  });

  it("leaves Codex input unchanged when the first item has no content array", () => {
    const body = { input: [{ type: "function_call", name: "lookup", client_tag: "call" }] };
    expect(injectCodexAssets(body, { raw: "INJECT" })).toBe(body);
  });

  it("keeps Responses input parts and only appends the WorkBuddy injection", () => {
    const rules = { type: "input_text", text: "WorkBuddy rules.", cache_control: { type: "ephemeral" }, client_tag: "rules" };
    const later = { type: "message", role: "user", content: [{ type: "input_text", text: "hi", client_tag: "user" }] };
    const body = {
      model: "gpt-5",
      input: [
        { type: "message", role: "developer", content: [rules], client_tag: "dev" },
        later,
      ],
    };

    const sent = injectWorkbuddyAssets(body, { raw: "INJECT" });
    const input = sent.input as Array<Record<string, unknown>>;
    const content = input[0].content as unknown[];

    expect(content[0]).toBe(rules);
    expect(input[1]).toBe(later);
    expect(content).toHaveLength(2);
    expect((content[1] as { text: string }).text).toContain("INJECT");
  });

  it("leaves WorkBuddy input unchanged when the first item has no content array", () => {
    const body = { input: [{ type: "function_call", name: "lookup", client_tag: "call" }] };
    expect(injectWorkbuddyAssets(body, { raw: "INJECT" })).toBe(body);
  });

  it("keeps an unchanged Anthropic tool_result content array", () => {
    const toolResult = {
      type: "tool_result",
      tool_use_id: "t1",
      is_error: false,
      client_tag: "tr",
      content: [textPart, imagePart],
    };
    const messages = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }] },
      { role: "user", content: [toolResult], client_tag: "user" },
    ];
    const adapter = new AnthropicAdapter();
    expect(adapter.serialize(adapter.parse({ messages }, anthropicMeta)).messages).toEqual(messages);
  });

  it("keeps an unchanged OpenAI tool message, string or array", () => {
    const messages = [
      { role: "tool", tool_call_id: "c1", content: "plain", client_tag: "s" },
      { role: "tool", tool_call_id: "c2", content: [textPart], client_tag: "a", name: "reader" },
    ];
    const adapter = new OpenAIAdapter();
    expect(adapter.serialize(adapter.parse({ messages }, openaiMeta)).messages).toEqual(messages);
  });

  it("returns the same OpenAI body when no hook creates a block", async () => {
    const body = {
      model: "gpt",
      messages: [{ role: "system", content: [{ type: "text", text: "rules", client_tag: "a" }], client_tag: "msg" }],
    };
    const out = await pipeline("openai").process(body, openaiMeta);
    expect(out).toBe(body);
  });

  it("turns an Anthropic system string plus one injected block into an array", async () => {
    const body = { system: "Core prompt", messages: [{ role: "user", content: "hi" }] };
    const out = await pipeline("anthropic", suffixHook("INJECT")).process(body, anthropicMeta);
    expect(out.system).toEqual([
      { type: "text", text: "Core prompt" },
      { type: "text", text: "INJECT" },
    ]);
  });

  it("keeps an unchanged Anthropic image block and an unknown block", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aaaa", client_tag: "src" },
      cache_control: { type: "ephemeral" },
      client_tag: "img",
    };
    const custom = { type: "document", source: { type: "file", file_id: "f1" }, client_tag: "doc" };
    const messages = [{ role: "user", content: [image, custom] }];
    const adapter = new AnthropicAdapter();
    expect(adapter.serialize(adapter.parse({ messages }, anthropicMeta)).messages).toEqual(messages);
  });
});

describe("a changed block keeps every field except the edited one", () => {
  it("keeps unknown fields when an Anthropic tool_use input changes", () => {
    const block = {
      type: "tool_use",
      id: "t1",
      name: "Read",
      input: { file_path: "/a", client_tag: "in" },
      caller: { type: "direct" },
      client_tag: "tu",
    };
    const adapter = new AnthropicAdapter();
    const ctx = adapter.parse({ messages: [{ role: "assistant", content: [block] }] }, anthropicMeta);
    const parsed = JSON.parse(ctx.messages[0].blocks[0].content) as { name: string; arguments: string };
    parsed.arguments = JSON.stringify({ file_path: "/b", client_tag: "in" });
    ctx.messages[0].blocks[0].content = JSON.stringify(parsed);

    const out = adapter.serialize(ctx).messages as Array<{ content: Record<string, unknown>[] }>;
    expect(out[0].content[0]).toEqual({ ...block, input: { file_path: "/b", client_tag: "in" } });
  });

  it("drops removed OpenAI tool calls and keeps the calls that remain", () => {
    const callA = { id: "a", type: "function", function: { name: "one", arguments: "{}" }, client_tag: "a" };
    const callB = { id: "b", type: "function", function: { name: "two", arguments: "{}" }, client_tag: "b" };
    const adapter = new OpenAIAdapter();
    const ctx = adapter.parse({
      messages: [{ role: "assistant", content: null, tool_calls: [callA, callB], client_tag: "m" }],
    }, openaiMeta);
    ctx.messages[0].blocks = ctx.messages[0].blocks.filter((block) => block.metadata?.tool_id !== "a");

    const oneLeft = (adapter.serialize(ctx).messages as Array<Record<string, unknown>>)[0];
    expect(oneLeft.client_tag).toBe("m");
    expect(oneLeft.content).toBeNull();
    expect(oneLeft.tool_calls).toEqual([callB]);

    ctx.messages[0].blocks = [];
    const none = (adapter.serialize(ctx).messages as Array<Record<string, unknown>>)[0];
    expect(none.tool_calls).toBeUndefined();
    expect(none.client_tag).toBe("m");
    expect(none.content).toBeNull();
  });

  it("keeps tool_result part fields when the text changes", () => {
    const anthropic = new AnthropicAdapter();
    const messages = [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        is_error: false,
        client_tag: "tr",
        content: [textPart, imagePart],
      }],
    }];
    const ctx = anthropic.parse({ messages }, anthropicMeta);
    ctx.messages[0].blocks[0].content = "rewritten";
    const sent = anthropic.serialize(ctx).messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(sent[0].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "t1",
      is_error: false,
      client_tag: "tr",
      content: [{ ...textPart, text: "rewritten" }, imagePart],
    });

    const openai = new OpenAIAdapter();
    const toolCtx = openai.parse({
      messages: [{ role: "tool", tool_call_id: "c", content: [textPart], client_tag: "msg" }],
    }, openaiMeta);
    toolCtx.messages[0].blocks[0].content = "rewritten";
    expect(openai.serialize(toolCtx).messages).toEqual([{
      role: "tool",
      tool_call_id: "c",
      content: [{ ...textPart, text: "rewritten" }],
      client_tag: "msg",
    }]);
  });

  it("keeps a new tool_result text when the original array has no text part", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "qq" }, client_tag: "img" };
    const adapter = new AnthropicAdapter();
    const ctx = adapter.parse({
      messages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: [image] }],
      }],
    }, anthropicMeta);
    ctx.messages[0].blocks[0].content = "kept";
    const sent = adapter.serialize(ctx).messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(sent[0].content[0].content).toEqual([{ type: "text", text: "kept" }, image]);
  });

  it("writes the whole new text into the first text part", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "qq" }, client_tag: "img" };
    const first = { type: "text", text: "one\ntwo", cache_control: { type: "ephemeral" }, client_tag: "t1" };
    const second = { type: "text", text: "three", client_tag: "t2" };
    const adapter = new AnthropicAdapter();
    const ctx = adapter.parse({
      messages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: [image, first, second] }],
      }],
    }, anthropicMeta);
    ctx.messages[0].blocks[0].content = "AA\nBB";
    const sent = adapter.serialize(ctx).messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(sent[0].content[0].content).toEqual([
      image,
      { ...first, text: "AA\nBB" },
    ]);
  });

  it("sends a new tool id when only the id changes", () => {
    const block = {
      type: "tool_use",
      id: "old",
      name: "Read",
      input: { file_path: "/a" },
      caller: { type: "direct" },
      client_tag: "tu",
    };
    const anthropic = new AnthropicAdapter();
    const ctx = anthropic.parse({ messages: [{ role: "assistant", content: [block] }] }, anthropicMeta);
    ctx.messages[0].blocks[0].metadata = { ...ctx.messages[0].blocks[0].metadata, tool_id: "new" };
    const out = anthropic.serialize(ctx).messages as Array<{ content: Record<string, unknown>[] }>;
    expect(out[0].content[0]).toEqual({ ...block, id: "new" });

    const call = { id: "old", type: "function", function: { name: "Read", arguments: "{}" }, client_tag: "c" };
    const openai = new OpenAIAdapter();
    const toolCtx = openai.parse({
      messages: [{ role: "assistant", content: null, tool_calls: [call] }],
    }, openaiMeta);
    toolCtx.messages[0].blocks[0].metadata = { ...toolCtx.messages[0].blocks[0].metadata, tool_id: "new" };
    const sent = openai.serialize(toolCtx).messages as Array<Record<string, unknown>>;
    expect(sent[0].tool_calls).toEqual([{ ...call, id: "new" }]);
  });

  it("sends tool calls in the edited order", () => {
    const callA = { id: "a", type: "function", function: { name: "one", arguments: "{}" }, client_tag: "a" };
    const callB = { id: "b", type: "function", function: { name: "two", arguments: "{}" }, client_tag: "b" };
    const openai = new OpenAIAdapter();
    const ctx = openai.parse({
      messages: [{ role: "assistant", content: null, tool_calls: [callA, callB], client_tag: "m" }],
    }, openaiMeta);
    ctx.messages[0].blocks = [ctx.messages[0].blocks[1], ctx.messages[0].blocks[0]];
    const sent = openai.serialize(ctx).messages as Array<Record<string, unknown>>;
    expect(sent[0].tool_calls).toEqual([callB, callA]);
    expect(sent[0].client_tag).toBe("m");

    const blockA = { type: "tool_use", id: "a", name: "one", input: {}, client_tag: "a" };
    const blockB = { type: "tool_use", id: "b", name: "two", input: {}, client_tag: "b" };
    const anthropic = new AnthropicAdapter();
    const anth = anthropic.parse({
      messages: [{ role: "assistant", content: [blockA, blockB] }],
    }, anthropicMeta);
    anth.messages[0].blocks = [anth.messages[0].blocks[1], anth.messages[0].blocks[0]];
    const out = anthropic.serialize(anth).messages as Array<{ content: Record<string, unknown>[] }>;
    expect(out[0].content).toEqual([blockB, blockA]);
  });
});
