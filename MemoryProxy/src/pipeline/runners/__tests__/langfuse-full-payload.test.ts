/**
 * What the runners hand to Langfuse: the full native request as input and the
 * full native reply as output, for streamed and plain replies and for failures.
 * The tests stop at the report call, so a runner that misses a call site fails here.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LangfuseFailureReport, LangfuseGenerationReport } from "../../../langfuse.js";
import { runWorkbuddyPipeline } from "../workbuddy.js";
import { __primeCacheForTests } from "../../../instance-upstream-cache.js";
import { __primeAccountCacheForTests } from "../../../subscription-pool/account-cache.js";
import { handleSystemUserPassthrough } from "../../../systemUserPassthrough.js";
import { CORE_URL, POOL_TEST_TEAM, installFetch, jsonResponse, makeApp, makeConfig, resetPoolState } from "../../../subscription-pool/__tests__/test-harness.js";

const SESSION = "01a16c99-623a-7cc3-b2c4-91528f4f0665";

const generations: LangfuseGenerationReport[] = [];
const failures: LangfuseFailureReport[] = [];
/** When true, every Langfuse report call throws after it is recorded. */
let reporterThrows = false;
/** Body overrides the mocked cost guard hands to every forward target. */
let bodyOverrides: Record<string, unknown> | null = null;

vi.mock("../../../langfuse.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../langfuse.js")>()),
  langfuseReportGeneration: (r: LangfuseGenerationReport) => {
    generations.push(r);
    if (reporterThrows) throw new Error("langfuse is down");
  },
  langfuseReportFailure: (r: LangfuseFailureReport) => {
    failures.push(r);
    if (reporterThrows) throw new Error("langfuse is down");
  },
}));

/** What the passthrough hands to Opik: trace input and span input messages. */
const opikInputs: unknown[] = [];

vi.mock("../../../opik.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../opik.js")>()),
  opikCreateTrace: (_config: unknown, p: { input?: unknown }) => { opikInputs.push(p.input); return undefined; },
  opikCreateLlmSpan: (_config: unknown, p: { inputMessages?: unknown }) => { opikInputs.push(p.inputMessages); },
}));

vi.mock("../../../guard-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../guard-adapter.js")>();
  return {
    ...actual,
    resolveForwardTarget: async (...args: Parameters<typeof actual.resolveForwardTarget>) => {
      const target = await actual.resolveForwardTarget(...args);
      return bodyOverrides ? { ...target, bodyOverrides } : target;
    },
  };
});

vi.mock("../../../auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../auth.js")>()),
  verifyUserKey: async () => ({ userId: "usr-1", rejected: false }),
}));

vi.mock("../../stages/session-init-orchestrate.js", () => ({
  stageSessionInitOrchestrate: async () => ({
    proceed: true,
    response: null,
    wentThroughStateMachine: false,
    initResult: {
      intercepted: false,
      bypassed: false,
      justRegistered: false,
      sessionInfo: { team_id: "t1", user_id: "u1", agent_id: "a1", session_id: SESSION },
    },
  }),
}));

beforeEach(() => {
  resetPoolState();
  generations.length = 0;
  failures.length = 0;
  reporterThrows = false;
  bodyOverrides = null;
  opikInputs.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function config() {
  const c = makeConfig();
  c.sessionInit = { ...(c.sessionInit ?? {}), enabled: true } as typeof c.sessionInit;
  c.injection = { ...(c.injection ?? {}), enabled: false } as typeof c.injection;
  c.tdai = { ...c.tdai, enabled: false, endpoint: CORE_URL };
  return c;
}

const sse = (events: Array<[string, unknown]>) => new Response(
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

async function post(path: string, body: unknown, headers: Record<string, string>): Promise<void> {
  const res = await makeApp(config()).request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  await res.text();
  await vi.waitFor(() => expect(generations.length + failures.length).toBeGreaterThan(0));
}

// ── Anthropic ────────────────────────────────────────────────────────────────

const tools = [{
  name: "Bash", description: "Run a command",
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
}];
const VALID_SIGNATURE = "A".repeat(60); // the proxy keeps a thinking block only when its signature looks real
const longThinking = "step ".repeat(200); // more than the old 200-character cut
const anthropicBody = {
  model: "claude-opus-4-8", max_tokens: 4096, temperature: 0.2,
  thinking: { type: "enabled", budget_tokens: 2048 },
  tool_choice: { type: "auto" },
  system: [{ type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } }],
  tools,
  messages: [
    { role: "user", content: [{ type: "text", text: "list the files", cache_control: { type: "ephemeral" } }] },
    { role: "assistant", content: [
      { type: "thinking", thinking: longThinking, signature: VALID_SIGNATURE },
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "a.txt" }] },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
    ] },
  ],
};
const anthropicHeaders = { "x-api-key": "sk-ant-secret", "x-claude-code-session-id": SESSION };

function expectNativeAnthropicInput(input: unknown): void {
  const i = input as Record<string, unknown>;
  // `system` stays a top-level field as sent; no system message is added to `messages`.
  expect(i.system).toEqual(anthropicBody.system);
  expect(i.messages).toEqual(anthropicBody.messages);
  expect(i.tools).toEqual(tools);
  expect(i).toMatchObject({
    model: "claude-opus-4-8", max_tokens: 4096, temperature: 0.2,
    thinking: anthropicBody.thinking, tool_choice: { type: "auto" },
  });
  expect(JSON.stringify(input)).not.toContain("sk-ant-secret");
}

describe("anthropic runner Langfuse payload", () => {
  it("reports the native request and a tool-only streamed reply in full", async () => {
    installFetch(() => sse([
      ["message_start", { type: "message_start", message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 5, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "need to read" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_2", name: "Bash", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\":" } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"pwd\"}" } }],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }],
      ["message_stop", { type: "message_stop" }],
    ]));
    await post("/claude-code/default/v1/messages", { ...anthropicBody, stream: true }, anthropicHeaders);

    expect(generations).toHaveLength(1);
    const g = generations[0]!;
    expectNativeAnthropicInput(g.input);
    expect(g.output).toEqual({
      id: "m",
      role: "assistant",
      usage: { input_tokens: 5, output_tokens: 9 },
      content: [
        { type: "thinking", thinking: "need to read", signature: "sig-1" },
        { type: "tool_use", id: "tu_2", name: "Bash", input: { command: "pwd" } },
      ],
      stop_reason: "tool_use",
    });
    expect(g.traceOutput).toEqual(g.output);
  });

  it("reports the native request and the full non-stream reply", async () => {
    const content = [
      { type: "thinking", thinking: "plan", signature: "sig-9" },
      { type: "text", text: "running it" },
      { type: "tool_use", id: "tu_3", name: "Bash", input: { command: "date" } },
    ];
    installFetch(() => jsonResponse({
      id: "m", type: "message", role: "assistant", model: "claude-opus-4-8", content,
      stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
    }));
    await post("/claude-code/default/v1/messages", { ...anthropicBody, stream: false }, anthropicHeaders);

    const g = generations[0]!;
    expectNativeAnthropicInput(g.input);
    expect(g.output).toEqual({
      id: "m", type: "message", role: "assistant", model: "claude-opus-4-8", content,
      stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  it("reports a 2xx non-stream reply without a content array as received", async () => {
    installFetch(() => jsonResponse({ id: "m", type: "message", usage: { input_tokens: 1, output_tokens: 0 } }));
    await post("/claude-code/default/v1/messages", { ...anthropicBody, stream: false }, anthropicHeaders);

    expect(generations[0]!.output).toEqual({ id: "m", type: "message", usage: { input_tokens: 1, output_tokens: 0 } });
  });

  it("adds the provider request-id header to the observation metadata", async () => {
    installFetch(() => new Response(JSON.stringify({
      id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_abc123" } }));
    await post("/claude-code/default/v1/messages", { ...anthropicBody, stream: false }, anthropicHeaders);

    expect(generations[0]!.observationMetadata).toMatchObject({ upstream_request_id: "req_abc123" });
  });

  it("redacts mcp_servers authorization_token in a failure report", async () => {
    installFetch(() => jsonResponse({ error: { message: "overloaded" } }, 529));
    const mcp = [{ type: "url", url: "https://m.example", name: "m", authorization_token: "mcp-secret" }];
    await post("/claude-code/default/v1/messages", { ...anthropicBody, stream: false, mcp_servers: mcp }, anthropicHeaders);

    expect(failures).toHaveLength(1);
    const input = failures[0]!.input as Record<string, unknown>;
    expect(input.mcp_servers).toEqual([{ type: "url", url: "https://m.example", name: "m", authorization_token: "[redacted]" }]);
    expect(JSON.stringify(input)).not.toContain("mcp-secret");
  });

  it("gives a failed upstream call the full request", async () => {
    installFetch(() => jsonResponse({ error: { message: "overloaded" } }, 529));
    await post("/claude-code/default/v1/messages", { ...anthropicBody, stream: false }, anthropicHeaders);

    expect(failures).toHaveLength(1);
    expectNativeAnthropicInput(failures[0]!.input);
  });
});

// ── OpenAI chat ──────────────────────────────────────────────────────────────

const openaiTools = [{
  type: "function",
  function: { name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
}];
const openaiBody = {
  model: "gpt-x", temperature: 0.5, tool_choice: "auto", tools: openaiTools,
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: [{ type: "text", text: "weather in Hue?" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Hue\"}" } }] },
    { role: "tool", tool_call_id: "c0", content: "rain" },
  ],
};
const openaiHeaders = { authorization: "Bearer sk-openai-secret", "x-codebuddy-request": "1" };

function expectNativeOpenaiInput(input: unknown): void {
  const i = input as Record<string, unknown>;
  const messages = i.messages as Array<Record<string, unknown>>;
  // The runner may add messages (memory injection is off here), but every client message stays native.
  expect(messages.slice(-4)).toEqual(openaiBody.messages);
  expect(i.tools).toEqual(openaiTools);
  expect(i).toMatchObject({ model: "gpt-x", temperature: 0.5, tool_choice: "auto" });
  expect(JSON.stringify(input)).not.toContain("sk-openai-secret");
}

describe("openai-chat runner Langfuse payload", () => {
  it("reports a tool-only streamed reply with complete tool_calls and finish_reason", async () => {
    const chunk = (delta: unknown, finish: string | null = null) => ({
      id: "c", object: "chat.completion.chunk", model: "gpt-x", choices: [{ index: 0, delta, finish_reason: finish }],
    });
    installFetch(() => sse([
      ["", chunk({ role: "assistant", reasoning_content: "think " })],
      ["", chunk({ reasoning_content: "hard" })],
      ["", chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_weather", arguments: "{\"city\":" } }] })],
      ["", chunk({ tool_calls: [{ index: 0, function: { arguments: "\"Hanoi\"}" } }] })],
      ["", chunk({}, "tool_calls")],
      ["", { id: "c", choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }],
    ]));
    await post("/codebuddy/default/v1/chat/completions", { ...openaiBody, stream: true, stream_options: { include_usage: true } }, openaiHeaders);

    const g = generations[0]!;
    expectNativeOpenaiInput(g.input);
    expect(g.output).toEqual({
      id: "c",
      object: "chat.completion.chunk",
      model: "gpt-x",
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      role: "assistant",
      content: null,
      reasoning_content: "think hard",
      tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Hanoi\"}" } }],
      finish_reason: "tool_calls",
    });
    expect(g.traceOutput).toEqual(g.output);
  });

  it("reports the non-stream reply JSON as received, choices included", async () => {
    const message = {
      role: "assistant", content: null,
      tool_calls: [{ id: "c9", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Hue\"}" } }],
    };
    const reply = {
      id: "c", object: "chat.completion", model: "gpt-x",
      choices: [{ index: 0, finish_reason: "tool_calls", logprobs: null, message }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    installFetch(() => jsonResponse(reply));
    await post("/codebuddy/default/v1/chat/completions", { ...openaiBody, stream: false }, openaiHeaders);

    const g = generations[0]!;
    expectNativeOpenaiInput(g.input);
    expect(g.output).toEqual(reply);
  });

  it("gives a failed upstream call the full request", async () => {
    installFetch(() => jsonResponse({ error: { message: "bad" } }, 500));
    await post("/codebuddy/default/v1/chat/completions", { ...openaiBody, stream: false }, openaiHeaders);

    expect(failures).toHaveLength(1);
    expectNativeOpenaiInput(failures[0]!.input);
  });
});

// ── Codex (Responses) ────────────────────────────────────────────────────────

describe("codex runner Langfuse payload", () => {
  const responsesTools = [{ type: "function", name: "shell", description: "Run", parameters: { type: "object" } }];
  const codexBody = {
    model: "gpt-5-codex", stream: true, instructions: "You are Codex.", tools: responsesTools,
    tool_choice: "auto", reasoning: { effort: "high" },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "run ls" }] }],
  };

  it("reports the whole request and a tool-only reply with status", async () => {
    const call = { type: "function_call", call_id: "fc_1", name: "shell", arguments: "{\"cmd\":\"ls\"}" };
    installFetch(() => sse([
      ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } }],
      ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: call }],
      ["response.completed", { type: "response.completed", response: { id: "r", status: "completed", output: [call], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }],
    ]));
    await post("/codex/default/v1/responses", codexBody, { authorization: "Bearer sk-codex-secret", "session-id": SESSION });

    const g = generations[0]!;
    expect(g.input).toMatchObject({
      model: "gpt-5-codex", instructions: "You are Codex.", tools: responsesTools,
      tool_choice: "auto", reasoning: { effort: "high" }, input: codexBody.input,
    });
    expect(JSON.stringify(g.input)).not.toContain("sk-codex-secret");
    expect(g.output).toEqual({
      id: "r", output: [call], status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  });
});

// ── WorkBuddy (Responses) ────────────────────────────────────────────────────

describe("workbuddy runner Langfuse payload", () => {
  it("reports the whole request and the full streamed output", async () => {
    const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] };
    installFetch(() => sse([
      ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
      ["response.completed", { type: "response.completed", response: { id: "r", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }],
    ]));
    const app = new Hono();
    app.post("/workbuddy/:spaceId/v1/responses", (c) => runWorkbuddyPipeline(c, config()));
    const tools = [{ type: "function", name: "shell", parameters: { type: "object" } }];
    const res = await app.request("/workbuddy/default/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-wb-secret", "session-id": SESSION },
      body: JSON.stringify({
        model: "gpt-5", stream: true, instructions: "Be brief.", tools, tool_choice: "auto",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }),
    });
    await res.text();
    await vi.waitFor(() => expect(generations.length).toBeGreaterThan(0));

    const g = generations[0]!;
    expect(g.input).toMatchObject({ model: "gpt-5", instructions: "Be brief.", tools, tool_choice: "auto" });
    expect(JSON.stringify(g.input)).not.toContain("sk-wb-secret");
    expect(g.output).toEqual({
      id: "r", output: [item], status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  });
});

// ── System user passthrough ──────────────────────────────────────────────────

describe("system user passthrough Langfuse payload", () => {
  const match = { name: "memory", userId: "sys-1", displayName: "Memory" };
  const run = async (path: string, body: Record<string, unknown>) => {
    const app = new Hono();
    app.post("/:agent/:spaceId/*", (c) => handleSystemUserPassthrough(c, config(), match, body));
    const res = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify(body),
    });
    await res.text();
    await vi.waitFor(() => expect(generations.length).toBeGreaterThan(0));
    return generations[0]!;
  };

  it("rebuilds a streamed Anthropic reply instead of keeping cut SSE text", async () => {
    installFetch(() => sse([
      ["message_start", { type: "message_start", message: { role: "assistant", usage: { input_tokens: 2, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "extract", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"facts\":[1]}" } }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }],
    ]));
    const body = { model: "m", stream: true, system: "s", tools: [{ name: "extract" }], messages: [{ role: "user", content: "x" }] };
    const g = await run("/system/default/v1/messages", body);
    expect(g.input).toEqual(body);
    expect(g.output).toEqual({
      role: "assistant",
      usage: { input_tokens: 2, output_tokens: 3 },
      content: [{ type: "tool_use", id: "t", name: "extract", input: { facts: [1] } }],
      stop_reason: "tool_use",
    });
  });

  it("rebuilds a streamed chat-completions reply", async () => {
    installFetch(() => sse([
      ["", { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }],
      ["", { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }],
    ]));
    const g = await run("/system/default/v1/chat/completions", { model: "m", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(g.output).toEqual({
      role: "assistant", content: "ok", finish_reason: "stop",
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });

  it("redacts known nested credentials in the Langfuse input only", async () => {
    let upstreamBody = "";
    installFetch((call) => {
      upstreamBody = call.body;
      return sse([["", { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }]]);
    });
    const body = {
      model: "m", stream: true, messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "mcp", server_label: "s", authorization: "oauth-secret", headers: { "X-Key": "hdr-secret" } }],
    };
    const g = await run("/system/default/v1/chat/completions", body);
    expect(JSON.stringify(g.input)).not.toMatch(/oauth-secret|hdr-secret/);
    expect((g.input as { tools: unknown[] }).tools).toEqual([
      { type: "mcp", server_label: "s", authorization: "[redacted]", headers: { "X-Key": "[redacted]" } },
    ]);
    expect(upstreamBody).toContain("oauth-secret");
    expect(body.tools[0]!.authorization).toBe("oauth-secret");
  });

  it("drops top-level credential keys from the Langfuse input and the Opik copy", async () => {
    let upstreamBody = "";
    installFetch((call) => {
      upstreamBody = call.body;
      return sse([["", { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }]]);
    });
    const body = {
      model: "m", stream: true, api_key: "top-secret", messages: [{ role: "user", content: "hi" }],
      mcp_servers: [{ name: "m", authorization_token: "mcp-secret" }],
    };
    const g = await run("/system/default/v1/chat/completions", body);
    expect(g.input).toEqual({
      model: "m", stream: true, messages: [{ role: "user", content: "hi" }],
      mcp_servers: [{ name: "m", authorization_token: "[redacted]" }],
    });
    expect(g.traceInput).toEqual(g.input);
    expect(opikInputs.length).toBeGreaterThan(0);
    expect(JSON.stringify(opikInputs)).not.toMatch(/top-secret|mcp-secret/);
    expect(upstreamBody).toContain("top-secret");
    expect(upstreamBody).toContain("mcp-secret");
  });

  it("does not send an unparsable request body raw", async () => {
    installFetch(() => jsonResponse({ id: "x", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    const raw = "this is not json, api_key=sk-LEAK";
    const app = new Hono();
    app.post("/:agent/:spaceId/*", (c) => handleSystemUserPassthrough(c, config(), match));
    const res = await app.request("/system/default/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer k" }, body: raw,
    });
    await res.text();
    await vi.waitFor(() => expect(generations.length + failures.length).toBeGreaterThan(0));
    const reported = [...generations, ...failures][0]!;
    expect(reported.input).toBe(`[unparsable request body: ${Buffer.byteLength(raw)} bytes]`);
    expect(JSON.stringify([reported, opikInputs])).not.toContain("sk-LEAK");
  });

  it("falls back to the raw text when no event can be assembled", async () => {
    installFetch(() => new Response("data: not json\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
    const g = await run("/system/default/v1/chat/completions", { model: "m", stream: true, messages: [] });
    expect(g.output).toBe("data: not json\n\n");
  });
});

// ── What the model is sent is what Langfuse gets ─────────────────────────────

async function send(path: string, body: unknown, headers: Record<string, string>, cfg = config()) {
  const res = await makeApp(cfg).request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { res, text };
}

/** The reported input must be the forwarded body: the same keys, in the same order, with the same values. */
function expectInputMatchesUpstream(input: unknown, upstreamJson: Record<string, unknown>): void {
  expect(input).toEqual(upstreamJson);
  expect(Object.keys(input as object)).toEqual(Object.keys(upstreamJson));
}

describe("the reported input is the body sent upstream", () => {
  it("anthropic: shows body overrides and the thinking blocks the proxy stripped", async () => {
    bodyOverrides = { max_tokens: 111, temperature: 0.9 };
    const { upstreamCalls } = installFetch(() => jsonResponse({
      id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const body = {
      ...anthropicBody, stream: false,
      messages: [
        ...anthropicBody.messages,
        { role: "assistant", content: [{ type: "thinking", thinking: "forged", signature: "sig-bad" }, { type: "text", text: "done" }] },
        { role: "user", content: "next" },
      ],
    };
    await send("/claude-code/default/v1/messages", body, anthropicHeaders);
    await vi.waitFor(() => expect(generations).toHaveLength(1));

    const sent = JSON.parse(upstreamCalls[0]!.body) as Record<string, unknown>;
    expect(sent).toMatchObject({ max_tokens: 111, temperature: 0.9 });
    expect(upstreamCalls[0]!.body).not.toContain("sig-bad");
    expectInputMatchesUpstream(generations[0]!.input, sent);
    expect(JSON.stringify(generations[0]!.input)).not.toContain("sig-bad");
  });

  it("anthropic: a failure report shows the forwarded body too", async () => {
    bodyOverrides = { max_tokens: 222 };
    const { upstreamCalls } = installFetch(() => jsonResponse({ error: { message: "overloaded" } }, 529));
    await send("/claude-code/default/v1/messages", { ...anthropicBody, stream: false }, anthropicHeaders);
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expectInputMatchesUpstream(failures[0]!.input, JSON.parse(upstreamCalls[0]!.body));
    expect((failures[0]!.input as Record<string, unknown>).max_tokens).toBe(222);
  });

  it("anthropic: shows the 1h cache ttl a subscription account is sent", async () => {
    resetPoolState();
    const now = Date.now();
    __primeCacheForTests("sp-ttl", [
      { group_id: "d", group_type: "default", name: "default", agents: ["codex"], enabled: true, mode: "official", base_url: "", api_key: "", model_id: "" },
      { group_id: "pool-claude", group_type: "custom", name: "pool", agents: ["claude-code"], enabled: true, mode: "subscription_pool", team_id: POOL_TEST_TEAM, base_url: "", api_key: "", model_id: "" },
    ]);
    __primeAccountCacheForTests("sp-ttl", {
      thresholdPct: 95,
      accounts: [{
        account_id: "a", group_id: "pool-claude", provider: "claude", provider_account_id: "acct-a",
        status: "active", enabled: true, access_token: "secret-token-a", token_expires_at: now + 3_600_000,
        usage: { windows: [] }, exhausted_until: null,
      }],
    });
    const cfg = config();
    cfg.subscriptionPool = { ...(cfg.subscriptionPool ?? {}), promptCacheTtl: "1h" } as typeof cfg.subscriptionPool;
    const { upstreamCalls } = installFetch(() => jsonResponse({
      id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }));
    await send("/claude-code/sp-ttl/v1/messages", { ...anthropicBody, stream: false }, { ...anthropicHeaders, "x-tdai-user-key": "sk-mem-user" }, cfg);
    await vi.waitFor(() => expect(generations).toHaveLength(1));

    const sent = JSON.parse(upstreamCalls[0]!.body) as Record<string, unknown>;
    expect(upstreamCalls[0]!.body).toContain("\"ttl\":\"1h\"");
    expectInputMatchesUpstream(generations[0]!.input, sent);
    expect(JSON.stringify(generations[0]!.input)).toContain("\"ttl\":\"1h\"");
  });

  it("openai-chat: shows body overrides", async () => {
    bodyOverrides = { temperature: 0.1, max_tokens: 7 };
    const { upstreamCalls } = installFetch(() => jsonResponse({
      id: "c", object: "chat.completion", model: "gpt-x",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    await send("/codebuddy/default/v1/chat/completions", { ...openaiBody, stream: false }, openaiHeaders);
    await vi.waitFor(() => expect(generations).toHaveLength(1));

    const sent = JSON.parse(upstreamCalls[0]!.body) as Record<string, unknown>;
    expect(sent).toMatchObject({ temperature: 0.1, max_tokens: 7 });
    expectInputMatchesUpstream(generations[0]!.input, sent);
  });
});

describe("reporting leaves the upstream request and the client reply alone", () => {
  const secretTools = [{ type: "mcp", server_label: "s", authorization: "oauth-secret", headers: { "X-Key": "hdr-secret" } }];

  it("anthropic sends the body untouched, secrets included", async () => {
    const body = { ...anthropicBody, stream: false, mcp_servers: [{ type: "url", url: "https://m.example", name: "m", authorization_token: "mcp-secret" }] };
    const { upstreamCalls } = installFetch(() => jsonResponse({
      id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }));
    await send("/claude-code/default/v1/messages", body, anthropicHeaders);
    await vi.waitFor(() => expect(generations).toHaveLength(1));
    expect(upstreamCalls[0]!.body).toBe(JSON.stringify(body));
    expect(JSON.stringify(generations[0]!.input)).not.toContain("mcp-secret");
  });

  it("openai-chat sends the body untouched, secrets included", async () => {
    const body = { ...openaiBody, stream: false, tools: [...openaiTools, ...secretTools] };
    const { upstreamCalls } = installFetch(() => jsonResponse({
      id: "c", object: "chat.completion", model: "gpt-x",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    await send("/codebuddy/default/v1/chat/completions", body, openaiHeaders);
    await vi.waitFor(() => expect(generations).toHaveLength(1));
    expect(upstreamCalls[0]!.body).toBe(JSON.stringify(body));
    expect(JSON.stringify(generations[0]!.input)).not.toMatch(/oauth-secret|hdr-secret/);
  });

  it("codex sends the body untouched, secrets included", async () => {
    const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] };
    const body = {
      model: "gpt-5-codex", stream: true, instructions: "You are Codex.", tools: secretTools,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "run ls" }] }],
    };
    const { upstreamCalls } = installFetch(() => sse([
      ["response.completed", { type: "response.completed", response: { id: "r", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }],
    ]));
    await send("/codex/default/v1/responses", body, { authorization: "Bearer sk-codex-secret", "session-id": SESSION });
    await vi.waitFor(() => expect(generations).toHaveLength(1));
    const sent = JSON.parse(upstreamCalls[0]!.body) as Record<string, unknown>;
    expect(sent.tools).toEqual(secretTools);
    expect(sent.input).toEqual(body.input);
    expect(JSON.stringify(generations[0]!.input)).not.toMatch(/oauth-secret|hdr-secret/);
  });

  it("workbuddy sends the body untouched, secrets included", async () => {
    const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] };
    const { upstreamCalls } = installFetch(() => sse([
      ["response.completed", { type: "response.completed", response: { id: "r", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }],
    ]));
    const app = new Hono();
    app.post("/workbuddy/:spaceId/v1/responses", (c) => runWorkbuddyPipeline(c, config()));
    const body = {
      model: "gpt-5", stream: true, instructions: "Be brief.", tools: secretTools,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    };
    const res = await app.request("/workbuddy/default/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-wb-secret", "session-id": SESSION },
      body: JSON.stringify(body),
    });
    await res.text();
    await vi.waitFor(() => expect(generations).toHaveLength(1));
    const sent = JSON.parse(upstreamCalls[0]!.body) as Record<string, unknown>;
    expect(sent.tools).toEqual(secretTools);
    expect(JSON.stringify(generations[0]!.input)).not.toMatch(/oauth-secret|hdr-secret/);
  });
});

describe("a Langfuse reporter that throws does not break the request", () => {
  const anthropicOk = () => jsonResponse({
    id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
  });

  it("anthropic non-stream, stream and upstream failure", async () => {
    reporterThrows = true;
    installFetch(anthropicOk);
    const plain = await send("/claude-code/default/v1/messages", { ...anthropicBody, stream: false }, anthropicHeaders);
    expect(plain.res.status).toBe(200);
    expect(JSON.parse(plain.text)).toMatchObject({ content: [{ type: "text", text: "ok" }] });

    const streamEvents: Array<[string, unknown]> = [
      ["message_start", { type: "message_start", message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hey" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
      ["message_stop", { type: "message_stop" }],
    ];
    installFetch(() => sse(streamEvents));
    const streamed = await send("/claude-code/default/v1/messages", { ...anthropicBody, stream: true }, anthropicHeaders);
    expect(streamed.res.status).toBe(200);
    expect(streamed.text).toContain("\"text\":\"hey\"");

    installFetch(() => jsonResponse({ error: { message: "overloaded" } }, 529));
    const failed = await send("/claude-code/default/v1/messages", { ...anthropicBody, stream: false }, anthropicHeaders);
    expect(failed.res.status).toBe(529);
    // The stream generation is reported by a background tap; wait for it.
    await vi.waitFor(() => expect(generations.length + failures.length).toBeGreaterThanOrEqual(3));
  });

  it("openai-chat stream", async () => {
    reporterThrows = true;
    const chunk = (delta: unknown, finish: string | null = null) => ({
      id: "c", object: "chat.completion.chunk", model: "gpt-x", choices: [{ index: 0, delta, finish_reason: finish }],
    });
    installFetch(() => sse([
      ["", chunk({ role: "assistant", content: "yo" })],
      ["", chunk({}, "stop")],
      ["", { id: "c", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }],
    ]));
    const out = await send("/codebuddy/default/v1/chat/completions", { ...openaiBody, stream: true, stream_options: { include_usage: true } }, openaiHeaders);
    expect(out.res.status).toBe(200);
    expect(out.text).toContain("\"content\":\"yo\"");
    await vi.waitFor(() => expect(generations.length).toBeGreaterThan(0));
  });

  it("codex stream", async () => {
    reporterThrows = true;
    const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] };
    installFetch(() => sse([
      ["response.completed", { type: "response.completed", response: { id: "r", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }],
    ]));
    const out = await send("/codex/default/v1/responses", {
      model: "gpt-5-codex", stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }],
    }, { authorization: "Bearer sk-codex-secret", "session-id": SESSION });
    expect(out.res.status).toBe(200);
    expect(out.text).toContain("response.completed");
    // Wait for the background tap, so its report does not leak into the next test.
    await vi.waitFor(() => expect(generations).toHaveLength(1));
  });
});

// ── Cut or failed streams ────────────────────────────────────────────────────

describe("a cut or failed stream does not look like a normal generation", () => {
  it("anthropic: an error event gives level ERROR and keeps the error", async () => {
    installFetch(() => sse([
      ["message_start", { type: "message_start", message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "part" } }],
      ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
    ]));
    await post("/claude-code/default/v1/messages", { ...anthropicBody, stream: true }, anthropicHeaders);
    const g = generations[0]!;
    expect(g.level).toBe("ERROR");
    expect(g.observationMetadata).toMatchObject({ stream_incomplete: true });
    expect(g.statusMessage).toContain("overloaded_error");
    expect(g.output).toMatchObject({ error: { type: "overloaded_error" } });
  });

  it("anthropic: an error event before message_start is still reported (no usage)", async () => {
    installFetch(() => sse([
      ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
    ]));
    await post("/claude-code/default/v1/messages", { ...anthropicBody, stream: true }, anthropicHeaders);
    await vi.waitFor(() => expect(generations).toHaveLength(1));
    const g = generations[0]!;
    expect(g.level).toBe("ERROR");
    expect(g.usage).toBeUndefined();
    expect(g.observationMetadata).toMatchObject({ stream_incomplete: true });
  });

  it("anthropic: a streamed 5xx reply is a failure with its status, not a cut generation", async () => {
    installFetch(() => jsonResponse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, 529));
    await post("/claude-code/default/v1/messages", { ...anthropicBody, stream: true }, anthropicHeaders);
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(generations).toHaveLength(0);
    expect(failures[0]!.status).toBe(529);
    expect(failures[0]!.statusMessage).toContain("overloaded_error");
    expect(failures[0]!.extraTags).toContain("error");
  });

  it("anthropic: a stream whose read fails gives level ERROR", async () => {
    const enc = new TextEncoder();
    installFetch(() => new Response(new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(enc.encode(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`));
        ctrl.error(new Error("socket reset"));
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await makeApp(config()).request("/claude-code/default/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...anthropicHeaders },
      body: JSON.stringify({ ...anthropicBody, stream: true }),
    });
    await res.text().catch(() => undefined);
    await vi.waitFor(() => expect(generations).toHaveLength(1));
    const g = generations[0]!;
    expect(g.level).toBe("ERROR");
    expect(g.statusMessage).toContain("socket reset");
    expect(g.observationMetadata).toMatchObject({ stream_incomplete: true, stream_incomplete_reason: "stream read failed" });
  });

  it("anthropic: a stream that ends before the stop event gives level WARNING", async () => {
    installFetch(() => sse([
      ["message_start", { type: "message_start", message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "Bash", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"l" } }],
    ]));
    await post("/claude-code/default/v1/messages", { ...anthropicBody, stream: true }, anthropicHeaders);
    const g = generations[0]!;
    expect(g.level).toBe("WARNING");
    expect(g.observationMetadata).toMatchObject({ stream_incomplete: true });
  });

  it("anthropic: a complete stream keeps the default level and has no marker", async () => {
    installFetch(() => sse([
      ["message_start", { type: "message_start", message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fine" } }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
      ["message_stop", { type: "message_stop" }],
    ]));
    await post("/claude-code/default/v1/messages", { ...anthropicBody, stream: true }, anthropicHeaders);
    const g = generations[0]!;
    expect(g.level).toBeUndefined();
    expect(g.observationMetadata).not.toHaveProperty("stream_incomplete");
  });

  it("codex: response.failed gives level ERROR and keeps the error", async () => {
    installFetch(() => sse([
      ["response.failed", { type: "response.failed", response: { id: "r", status: "failed", output: [], error: { code: "server_error", message: "boom" } } }],
    ]));
    await post("/codex/default/v1/responses", {
      model: "gpt-5-codex", stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }],
    }, { authorization: "Bearer sk-codex-secret", "session-id": SESSION });
    const g = generations[0]!;
    expect(g.level).toBe("ERROR");
    expect(g.observationMetadata).toMatchObject({ stream_incomplete: true });
    expect(g.output).toMatchObject({ status: "failed", error: { code: "server_error" } });
  });

  it("openai-chat: a stream cut inside a tool call gives level WARNING", async () => {
    const chunk = (delta: unknown, finish: string | null = null) => ({
      id: "c", object: "chat.completion.chunk", model: "gpt-x", choices: [{ index: 0, delta, finish_reason: finish }],
    });
    installFetch(() => sse([
      ["", chunk({ role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_weather", arguments: "{\"city\":" } }] })],
      ["", { id: "c", choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }],
    ]));
    await post("/codebuddy/default/v1/chat/completions", { ...openaiBody, stream: true, stream_options: { include_usage: true } }, openaiHeaders);
    const g = generations[0]!;
    expect(g.level).toBe("WARNING");
    expect(g.observationMetadata).toMatchObject({ stream_incomplete: true });
  });

  it("openai-chat: a client that disconnects mid-stream still gets its partial reply reported", async () => {
    const encoder = new TextEncoder();
    const first = `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "gpt-x", choices: [{ index: 0, delta: { role: "assistant", content: "par" }, finish_reason: null }] })}\n\n`;
    installFetch(() => new Response(
      new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(first)); } }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const res = await makeApp(config()).request("/codebuddy/default/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...openaiHeaders },
      body: JSON.stringify({ ...openaiBody, stream: true, stream_options: { include_usage: true } }),
    });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel("client went away");
    await vi.waitFor(() => expect(generations).toHaveLength(1));
    const g = generations[0]!;
    expect(g.level).toBe("WARNING");
    expect(g.observationMetadata).toMatchObject({ stream_incomplete: true });
    expect(g.output).toMatchObject({ content: "par" });
  });
});
