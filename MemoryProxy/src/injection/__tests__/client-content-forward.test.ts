import { describe, expect, it } from "vitest";

import { AnthropicAdapter } from "../adapters/anthropic.js";
import { OpenAIAdapter } from "../adapters/openai.js";
import type { ProtocolAdapter } from "../adapters/interface.js";
import { InjectionPipeline } from "../pipeline.js";
import { HookRegistryImpl } from "../registry.js";
import type { AgentContextMetadata, ContextBlock, InjectionHook } from "../types.js";

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

function roundTrip(adapter: ProtocolAdapter, body: Record<string, unknown>, metadata: AgentContextMetadata) {
  return adapter.serialize(adapter.parse(body, metadata));
}

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
  const adapters = new Map<string, ProtocolAdapter>([[protocol, adapter]]);
  return new InjectionPipeline(registry, adapters);
}

const billing = { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.325", client_tag: "bill" };
const identity = {
  cache_control: { type: "ephemeral" },
  type: "text",
  text: "You are Claude Code.",
  client_tag: "id",
};
const core = {
  type: "text",
  text: "Core prompt",
  cache_control: { type: "ephemeral", ttl: "1h" },
  client_tag: "core",
};

describe("client content blocks stay intact", () => {
  it("keeps a Claude Code system array, including a block with no cache marker", () => {
    const system = [billing, identity, core];
    const body = {
      model: "claude",
      system,
      messages: [{ role: "user", content: "hello", client_tag: "user" }],
      tools: [] as unknown[],
    };
    const out = roundTrip(new AnthropicAdapter(), body, anthropicMeta);

    expect(out.system).toEqual(system);
    expect(JSON.stringify(out.system)).toBe(JSON.stringify(system));
    expect(out.messages).toEqual(body.messages);
    expect(out.tools).toEqual([]);
  });

  it("keeps a one-block system array that has no cache marker", () => {
    const system = [{ type: "text", text: "only", client_tag: "keep" }];
    const out = roundTrip(new AnthropicAdapter(), { system, messages: [] }, anthropicMeta);
    expect(out.system).toEqual(system);
  });

  it("keeps a system string as a string", () => {
    const out = roundTrip(new AnthropicAdapter(), { system: "Instructions", messages: [] }, anthropicMeta);
    expect(out.system).toBe("Instructions");
  });

  it("keeps unknown fields on tool_use, tool_result, and thinking blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig", client_tag: "th" },
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "/a", client_tag: "in" },
            caller: { type: "direct" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "no",
            is_error: false,
            client_tag: "tr",
          },
        ],
      },
    ];
    const out = roundTrip(new AnthropicAdapter(), { messages }, anthropicMeta);
    expect(out.messages).toEqual(messages);
  });

  it("keeps unknown fields when a hook changes only the text", () => {
    const adapter = new AnthropicAdapter();
    const system = [{ type: "text", text: "core", cache_control: { type: "ephemeral" }, client_tag: "core" }];
    const ctx = adapter.parse({ system, messages: [] }, anthropicMeta);
    ctx.messages[0].blocks[0].content = "core\nADDED";
    const out = adapter.serialize(ctx);
    expect(out.system).toEqual([
      { type: "text", text: "core\nADDED", cache_control: { type: "ephemeral" }, client_tag: "core" },
    ]);
  });

  it("returns the same body when no hook creates a block", async () => {
    const body = { system: [billing, identity, core], messages: [{ role: "user", content: "hi" }], extra: { n: 1 } };
    const out = await pipeline("anthropic").process(body, anthropicMeta);
    expect(out).toBe(body);

    const idle = await pipeline("anthropic", {
      id: "idle",
      point: "system.suffix",
      priority: 1,
      description: "idle",
      execute: () => [],
    }).process(body, anthropicMeta);
    expect(idle).toBe(body);
  });

  it("adds only the injected block and leaves the other system blocks unchanged", async () => {
    const system = [structuredClone(billing), structuredClone(identity), structuredClone(core)];
    const body = { model: "claude", system, messages: [{ role: "user", content: "hi", client_tag: "user" }] };
    const out = await pipeline("anthropic", suffixHook("INJECT")).process(body, anthropicMeta);
    const sent = out.system as unknown[];

    expect(sent).toHaveLength(4);
    expect(sent.slice(0, 3)).toEqual(system);
    expect(sent[3]).toEqual({ type: "text", text: "INJECT" });
    expect(out.messages).toEqual(body.messages);
  });

  it("keeps an OpenAI system array of text parts, including part fields", () => {
    const messages = [
      {
        role: "system",
        content: [
          { type: "text", text: "rules", cache_control: { type: "ephemeral" }, client_tag: "a" },
          { type: "text", text: "more", client_tag: "b" },
        ],
        client_tag: "msg",
      },
    ];
    const body = { model: "gpt", messages, tools: [] as unknown[] };
    const out = roundTrip(new OpenAIAdapter(), body, openaiMeta);
    expect(out.messages).toEqual(messages);
    expect(JSON.stringify(out.messages)).toBe(JSON.stringify(messages));
    expect(out.tools).toEqual([]);
  });

  it("keeps OpenAI tool, image, and empty-string fields", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{}" }, client_tag: "call" }],
      },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.test/a.png", detail: "low" }, client_tag: "img" }],
      },
    ];
    const tools = [{ type: "function", strict: true, function: { name: "lookup", description: "d", parameters: { type: "object" } } }];
    const out = roundTrip(new OpenAIAdapter(), { messages, tools }, openaiMeta);
    expect(out.messages).toEqual(messages);
    expect(out.tools).toEqual(tools);
  });

  it("keeps an assistant text-part array as an array", () => {
    const messages = [{
      role: "assistant",
      content: [
        { type: "text", text: "one", client_tag: "1" },
        { type: "text", text: "two", client_tag: "2" },
      ],
    }];
    expect(roundTrip(new OpenAIAdapter(), { messages }, openaiMeta).messages).toEqual(messages);
  });

  it("keeps OpenAI string content as a string after injection", async () => {
    const body = {
      messages: [
        { role: "system", content: "base", client_tag: "sys" },
        { role: "user", content: "." },
      ],
      model: "gpt",
    };
    const out = await pipeline("openai", suffixHook("INJECT")).process(body, openaiMeta);
    const system = (out.messages as Array<Record<string, unknown>>)[0];

    expect(typeof system.content).toBe("string");
    expect(system.content).toBe("base\nINJECT");
    expect(system.client_tag).toBe("sys");
  });

  it("appends an injected part and leaves the original text parts unchanged", async () => {
    const first = { type: "text", text: "rules", cache_control: { type: "ephemeral" }, client_tag: "a" };
    const second = { type: "text", text: "more", client_tag: "b" };
    const body = { messages: [{ role: "system", content: [first, second], client_tag: "msg" }] };
    const out = await pipeline("openai", suffixHook("INJECT")).process(body, openaiMeta);
    const system = (out.messages as Array<Record<string, unknown>>)[0];

    expect(system.client_tag).toBe("msg");
    expect(system.content).toEqual([first, second, { type: "text", text: "INJECT" }]);
  });
});
