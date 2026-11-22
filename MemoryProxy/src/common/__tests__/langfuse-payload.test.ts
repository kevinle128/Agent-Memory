import { describe, expect, it, vi } from "vitest";
import { NodeSDK, tracing } from "@opentelemetry/sdk-node";
import { startObservation } from "@langfuse/tracing";

import {
  buildLangfuseRequestInput,
  langfuseOutputFromReply,
  langfuseReplyStatus,
  redactRequestPayload,
  scrubRequestCredentials,
} from "../langfuse-payload.js";
import {
  AnthropicMessageAssembler,
  OpenAIChatAssembler,
  ResponsesAssembler,
} from "../../session-trace/assemble.js";

describe("buildLangfuseRequestInput", () => {
  const messages = [
    { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(500), signature: "sig" }] },
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }] },
  ];
  const tools = [{ name: "Bash", input_schema: { type: "object" } }];

  it("keeps an Anthropic system block array with cache_control as a top-level field", () => {
    const system = [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }];
    const body = { model: "m", system, messages, tools, tool_choice: { type: "auto" }, max_tokens: 10, stream: true };
    const input = buildLangfuseRequestInput(body);
    expect(input).toEqual(body);
    expect(input.system).toEqual(system);
    expect(input.messages).toEqual(messages);
    expect(Object.keys(input)).toEqual(Object.keys(body));
  });

  it("keeps a string system as a string and adds no system message", () => {
    const body = { model: "m", system: "Be brief.", messages: [{ role: "user", content: "hi" }] };
    const input = buildLangfuseRequestInput(body);
    expect(input.system).toBe("Be brief.");
    expect(input.messages).toEqual(body.messages);
    expect((input.messages as Array<{ role: string }>).some((m) => m.role === "system")).toBe(false);
  });

  it("does not add or drop an empty or missing system", () => {
    const withEmpty = { system: [], messages: [{ role: "user", content: "hi" }] };
    expect(buildLangfuseRequestInput(withEmpty)).toEqual(withEmpty);
    const without = { messages: [{ role: "user", content: "hi" }] };
    expect(buildLangfuseRequestInput(without)).toEqual(without);
    expect(buildLangfuseRequestInput(without)).not.toHaveProperty("system");
  });

  it("keeps a real system message inside messages next to a top-level system", () => {
    const body = { system: "top", messages: [{ role: "system", content: "inner" }, { role: "user", content: "hi" }] };
    expect(buildLangfuseRequestInput(body)).toEqual(body);
  });

  it("passes a Responses body through whole", () => {
    const body = { model: "m", instructions: "i", input: [{ type: "message" }], tools: [{ name: "t" }], reasoning: { effort: "low" } };
    expect(buildLangfuseRequestInput(body)).toEqual(body);
  });

  it("drops credential-like top-level keys and keeps token limits", () => {
    const input = buildLangfuseRequestInput({
      messages: [], api_key: "k1", apiKey: "k2", Authorization: "Bearer k3", client_secret: "k4",
      access_token: "k5", max_tokens: 5, max_completion_tokens: 6,
    });
    expect(Object.keys(input).sort()).toEqual(["max_completion_tokens", "max_tokens", "messages"]);
  });
});

describe("nested credential scrub", () => {
  const conversation = [
    { role: "user", content: [{ type: "text", text: "my token is abc" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "secret-looking output sk-123" }] },
  ];

  it("redacts Anthropic mcp_servers authorization_token and keeps the shape", () => {
    const input = buildLangfuseRequestInput({
      model: "m", messages: conversation,
      mcp_servers: [{ type: "url", url: "https://mcp.example/sse", name: "x", authorization_token: "tok-1" }],
    });
    expect(input.mcp_servers).toEqual([{ type: "url", url: "https://mcp.example/sse", name: "x", authorization_token: "[redacted]" }]);
  });

  it("redacts Responses mcp tool authorization and header values, keeps header names", () => {
    const input = buildLangfuseRequestInput({
      model: "m", input: "hi",
      tools: [
        { type: "mcp", server_label: "s", server_url: "https://m.example", authorization: "oauth-1", headers: { "X-Key": "k1", Other: "k2" } },
        { type: "function", name: "f", parameters: { type: "object" } },
      ],
    });
    expect(input.tools).toEqual([
      { type: "mcp", server_label: "s", server_url: "https://m.example", authorization: "[redacted]", headers: { "X-Key": "[redacted]", Other: "[redacted]" } },
      { type: "function", name: "f", parameters: { type: "object" } },
    ]);
  });

  it("redacts headers on any tool definition, also when headers is not an object", () => {
    const input = buildLangfuseRequestInput({ messages: [], tools: [{ name: "a", headers: { A: "1" } }, { name: "b", headers: "Bearer z" }] });
    expect(input.tools).toEqual([{ name: "a", headers: { A: "[redacted]" } }, { name: "b", headers: "[redacted]" }]);
  });

  it("does not mutate the upstream body", () => {
    const body = {
      model: "m", messages: conversation,
      mcp_servers: [{ name: "x", authorization_token: "tok-1" }],
      tools: [{ type: "mcp", authorization: "o", headers: { K: "v" } }],
    };
    const before = structuredClone(body);
    const out = scrubRequestCredentials(body);
    buildLangfuseRequestInput(body);
    expect(body).toEqual(before);
    expect(out).not.toBe(body);
    expect(out.tools).not.toBe(body.tools);
  });

  it("returns the same body when nothing needs scrubbing", () => {
    const body = { messages: [], tools: [{ name: "t" }] };
    expect(scrubRequestCredentials(body)).toBe(body);
  });

  it("leaves conversation content untouched", () => {
    const input = buildLangfuseRequestInput({ messages: conversation, mcp_servers: [{ authorization_token: "t" }] });
    expect(input.messages).toEqual(conversation);
  });
});

describe("langfuseOutputFromReply keeps the provider fields", () => {
  const feed = (assembler: { push(e: Record<string, unknown>): void }, events: Array<Record<string, unknown>>) => {
    for (const e of events) assembler.push(e);
  };

  it("merges the id, model and full usage of an Anthropic stream", () => {
    const a = new AnthropicMessageAssembler();
    feed(a, [
      { type: "message_start", message: { id: "msg_2", type: "message", role: "assistant", model: "claude-x", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } },
    ]);
    expect(langfuseOutputFromReply(a.result(), "anthropic")).toEqual({
      id: "msg_2", type: "message", role: "assistant", model: "claude-x",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 9 },
    });
  });

  it("keeps the id, model and usage of OpenAI chat and Responses replies", () => {
    const o = new OpenAIChatAssembler();
    feed(o, [
      { id: "c1", object: "chat.completion.chunk", model: "m", created: 1, choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: "stop" }] },
      { id: "c1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
    ]);
    expect(langfuseOutputFromReply(o.result(), "openai")).toMatchObject({
      id: "c1", model: "m", created: 1, role: "assistant", content: "hi", finish_reason: "stop",
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });

    const r = new ResponsesAssembler();
    feed(r, [{ type: "response.completed", response: { id: "resp_1", model: "m", status: "completed", output: [{ type: "message" }], usage: { input_tokens: 1 } } }]);
    expect(langfuseOutputFromReply(r.result(), "responses")).toEqual({
      id: "resp_1", model: "m", status: "completed", output: [{ type: "message" }], usage: { input_tokens: 1 },
    });
  });
});

describe("langfuseOutputFromReply", () => {
  const feed = (assembler: { push(e: Record<string, unknown>): void }, events: Array<Record<string, unknown>>) => {
    for (const e of events) assembler.push(e);
  };

  it("never gives undefined for an Anthropic stream that only calls tools", () => {
    const a = new AnthropicMessageAssembler();
    feed(a, [
      { type: "message_start", message: { role: "assistant" } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "Bash", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"a\":1}" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ]);
    expect(langfuseOutputFromReply(a.result(), "anthropic")).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "t", name: "Bash", input: { a: 1 } }],
      stop_reason: "tool_use",
    });
  });

  it("names the stop field after the protocol", () => {
    const o = new OpenAIChatAssembler();
    feed(o, [{ choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }]);
    expect(langfuseOutputFromReply(o.result(), "openai")).toEqual({ role: "assistant", content: "hi", finish_reason: "stop" });

    const r = new ResponsesAssembler();
    feed(r, [{ type: "response.completed", response: { status: "completed", output: [{ type: "message" }] } }]);
    expect(langfuseOutputFromReply(r.result(), "responses")).toEqual({ output: [{ type: "message" }], status: "completed" });
  });

  it("gives undefined only when the upstream produced nothing", () => {
    expect(langfuseOutputFromReply(new AnthropicMessageAssembler().result(), "anthropic")).toBeUndefined();
    expect(langfuseOutputFromReply(new OpenAIChatAssembler().result(), "openai")).toBeUndefined();
    expect(langfuseOutputFromReply(new ResponsesAssembler().result(), "responses")).toBeUndefined();
    expect(langfuseOutputFromReply(null, "anthropic")).toBeUndefined();
  });
});

describe("Langfuse SDK attribute size", () => {
  it("does not cut a multi-megabyte input", async () => {
    // Same construction as initLangfuse (NodeSDK, default span limits; no
    // OTEL_*_LENGTH_LIMIT is configured). Export waits for async resource detection.
    const exporter = new tracing.InMemorySpanExporter();
    const sdk = new NodeSDK({ spanProcessors: [new tracing.SimpleSpanProcessor(exporter)] });
    sdk.start();
    try {
      const input = buildLangfuseRequestInput({
        model: "m",
        messages: [{ role: "user", content: [{ type: "text", text: "a".repeat(9 * 1024 * 1024) }] }],
        tools: [{ name: "t" }],
      });
      const generation = startObservation("big", { input }, { asType: "generation" });
      generation.end();
      await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(1));
      const attribute = exporter.getFinishedSpans()[0]!.attributes["langfuse.observation.input"] as string;
      expect(attribute.length).toBe(JSON.stringify(input).length);
    } finally {
      await sdk.shutdown();
    }
  });
});

describe("interrupted and failed streams", () => {
  const feedAll = (a: { push(e: Record<string, unknown>): void }, events: Array<Record<string, unknown>>) => {
    for (const e of events) a.push(e);
  };

  it("marks an Anthropic error event as ERROR and keeps the error object", () => {
    const a = new AnthropicMessageAssembler();
    feedAll(a, [
      { type: "message_start", message: { role: "assistant" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ]);
    const reply = a.result();
    const status = langfuseReplyStatus(reply);
    expect(status.level).toBe("ERROR");
    expect(status.metadata).toMatchObject({ stream_incomplete: true });
    expect(status.statusMessage).toContain("overloaded_error");
    expect(langfuseOutputFromReply(reply, "anthropic")).toMatchObject({
      content: [{ type: "text", text: "hello" }],
      error: { type: "overloaded_error", message: "Overloaded" },
    });
  });

  it("marks a stream with no stop event as WARNING", () => {
    const a = new AnthropicMessageAssembler();
    feedAll(a, [
      { type: "message_start", message: { role: "assistant" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cut" } },
    ]);
    const status = langfuseReplyStatus(a.result());
    expect(status.level).toBe("WARNING");
    expect(status.metadata).toMatchObject({ stream_incomplete: true });
  });

  it("marks a half received Anthropic tool call as WARNING even after a stop event", () => {
    const a = new AnthropicMessageAssembler();
    feedAll(a, [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "Bash", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"l" } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" } },
    ]);
    expect(langfuseReplyStatus(a.result()).level).toBe("WARNING");
  });

  it("marks Responses failed as ERROR with the error and incomplete as WARNING", () => {
    const failed = new ResponsesAssembler();
    feedAll(failed, [{ type: "response.failed", response: { status: "failed", output: [], error: { code: "server_error", message: "boom" } } }]);
    const fs = langfuseReplyStatus(failed.result());
    expect(fs.level).toBe("ERROR");
    expect(fs.statusMessage).toContain("server_error");
    expect(langfuseOutputFromReply(failed.result(), "responses")).toMatchObject({
      status: "failed", error: { code: "server_error", message: "boom" },
    });

    const incomplete = new ResponsesAssembler();
    feedAll(incomplete, [{ type: "response.incomplete", response: { status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } } }]);
    const is = langfuseReplyStatus(incomplete.result());
    expect(is.level).toBe("WARNING");
    expect(is.statusMessage).toContain("max_output_tokens");
  });

  it("marks a Responses stream that ended without a final event as WARNING", () => {
    const r = new ResponsesAssembler();
    feedAll(r, [{ type: "response.output_item.done", output_index: 0, item: { type: "message" } }]);
    expect(langfuseReplyStatus(r.result()).level).toBe("WARNING");
  });

  it("marks a Responses top-level error event as ERROR", () => {
    const r = new ResponsesAssembler();
    feedAll(r, [{ type: "error", code: "rate_limit", message: "slow down" }]);
    const s = langfuseReplyStatus(r.result());
    expect(s.level).toBe("ERROR");
    expect(s.statusMessage).toContain("rate_limit");
  });

  it("marks OpenAI chat streams with no finish_reason, half tool arguments or an error chunk", () => {
    const noFinish = new OpenAIChatAssembler();
    feedAll(noFinish, [{ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] }]);
    expect(langfuseReplyStatus(noFinish.result()).level).toBe("WARNING");

    const half = new OpenAIChatAssembler();
    feedAll(half, [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "f", arguments: "{\"a\":" } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
    expect(langfuseReplyStatus(half.result()).level).toBe("WARNING");

    const err = new OpenAIChatAssembler();
    feedAll(err, [
      { choices: [{ index: 0, delta: { role: "assistant", content: "a" } }] },
      { error: { message: "upstream died", type: "server_error" } },
    ]);
    const s = langfuseReplyStatus(err.result());
    expect(s.level).toBe("ERROR");
    expect(langfuseOutputFromReply(err.result(), "openai")).toMatchObject({ error: { message: "upstream died" } });
  });

  it("leaves a complete stream and a plain JSON reply unmarked", () => {
    const a = new AnthropicMessageAssembler();
    feedAll(a, [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "Bash", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"a\":1}" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ]);
    expect(langfuseReplyStatus(a.result())).toEqual({ metadata: {} });
    expect(langfuseReplyStatus(null)).toEqual({ metadata: {} });
  });
});

describe("redactRequestPayload", () => {
  it("drops top-level credential keys and redacts nested ones, keeping the shape", () => {
    const out = redactRequestPayload({
      model: "m", system: "s", messages: [], api_key: "k", max_tokens: 3,
      mcp_servers: [{ name: "m", authorization_token: "t" }],
    }) as Record<string, unknown>;
    expect(out).toEqual({ model: "m", system: "s", messages: [], max_tokens: 3, mcp_servers: [{ name: "m", authorization_token: "[redacted]" }] });
  });

  it("replaces a non-object body with a placeholder that carries its byte length", () => {
    expect(redactRequestPayload("not json {\"api_key\":\"sk-1\"}")).toBe("[unparsable request body: 27 bytes]");
    expect(redactRequestPayload("héllo")).toBe("[unparsable request body: 6 bytes]");
  });

  it("does not mutate its argument", () => {
    const body = { api_key: "k", tools: [{ authorization: "a" }] };
    redactRequestPayload(body);
    expect(body).toEqual({ api_key: "k", tools: [{ authorization: "a" }] });
  });
});
