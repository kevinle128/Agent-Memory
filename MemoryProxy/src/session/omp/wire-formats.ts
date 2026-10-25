/**
 * Wire formats of the omp hook gate.
 *
 * omp talks to the proxy in three formats. For each one this table holds what
 * differs: the route, the tool names, how the conversation is read, how the
 * synthetic gate turns are removed and how the gate answers. The values were
 * captured from omp 18.6.3 (see the gate module header).
 *
 * The id of every gate tool call starts with `OMP_GATE_CALL_PREFIX`, in all
 * three formats. The result that omp sends back carries the same id.
 */

import { GATE_TEXT_MARKER } from "../hook-gate-core.js";
import { buildTextResponse as buildAnthropicText, buildToolUseResponse } from "../claude-code/form.js";

/** Id prefix of every gate tool call. */
export const OMP_GATE_CALL_PREFIX = "call_omp_hook_gate_";
const RESPONSES_ITEM_PREFIX = "fc_omp_hook_gate_";
const RESPONSES_TEXT_PREFIX = "msg_omp_hook_gate_";
/** The bash tool of omp requires `i` (a short statement of intent) beside `command`. */
const INTENT = "Install the Agent-Memory project hook";

export type OmpFormat = "anthropic-messages" | "openai-responses" | "openai-completions";

/** One message of the conversation, reduced to what the gate reads. Only gate ids are listed. */
export interface OmpEvent {
  /** `tool` marks a message that only carries tool results. `other` is anything else (system, reasoning). */
  role: "user" | "assistant" | "tool" | "other";
  /** Ids of gate tool calls in this message. */
  callIds: string[];
  /** Ids of gate tool calls that this message answers. */
  resultIds: string[];
  /** Text of the tool result, when `resultIds` is not empty. */
  resultText: string;
  /** The message is a text answer of the gate. */
  gateText: boolean;
}

export interface OmpFormatRules {
  /** Route of the format, without the query string. */
  pathRe: RegExp;
  /** Interactive requests offer the ask tool next to the shell tool. `-p`, rpc and SDK runs do not. */
  askTool: string;
  shellTool: string;
  events(body: Record<string, unknown>): OmpEvent[];
  strip(body: Record<string, unknown>): Record<string, unknown>;
  installCall(modelId: string, command: string): Response;
  text(modelId: string, text: string): Response;
}

type Raw = Record<string, unknown>;

const isGateId = (id: unknown): id is string => typeof id === "string" && id.startsWith(OMP_GATE_CALL_PREFIX);
const asObject = (v: unknown): Raw => (v && typeof v === "object" ? (v as Raw) : {});
const roleOf = (m: Raw): string => (typeof m.role === "string" ? m.role : "");
const blocksOf = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(asObject) : []);

/** Text parts of a content value: a string, or the `text` fields of an array of parts. */
function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  return blocksOf(content).flatMap((p) => (typeof p.text === "string" ? [p.text] : []));
}

/** The first text of a message starts with the marker. */
const startsWithMarker = (content: unknown): boolean => (textParts(content)[0] ?? "").startsWith(GATE_TEXT_MARKER);

const newId = (prefix: string): string => `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const installArgs = (command: string): Raw => ({ command, i: INTENT });

// ── openai-completions ─────────────────────────────────────────────────────────

const toolCallsOf = (m: Raw): Raw[] => (roleOf(m) === "assistant" && Array.isArray(m.tool_calls) ? (m.tool_calls as unknown[]).map(asObject) : []);

function chatEvents(body: Raw): OmpEvent[] {
  if (!Array.isArray(body.messages)) return [];
  return (body.messages as unknown[]).map((raw) => {
    const m = asObject(raw);
    const role = roleOf(m);
    const calls = toolCallsOf(m);
    const isResult = role === "tool" && isGateId(m.tool_call_id);
    return {
      role: role === "user" || role === "assistant" || role === "tool" ? role : "other",
      callIds: calls.map((tc) => tc.id).filter(isGateId),
      resultIds: isResult ? [m.tool_call_id as string] : [],
      resultText: isResult ? textParts(m.content).join("\n") : "",
      gateText: role === "assistant" && calls.length === 0 && startsWithMarker(m.content),
    };
  });
}

function chatStrip(body: Raw): Raw {
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const kept: unknown[] = [];
  for (const raw of body.messages as unknown[]) {
    const m = asObject(raw);
    const calls = toolCallsOf(m);
    const isResult = roleOf(m) === "tool" && isGateId(m.tool_call_id);
    const isText = roleOf(m) === "assistant" && calls.length === 0 && startsWithMarker(m.content);
    if (isResult || isText) {
      changed = true;
      continue;
    }
    if (calls.some((tc) => isGateId(tc.id))) {
      changed = true;
      const rest = calls.filter((tc) => !isGateId(tc.id));
      const hasText = (textParts(m.content)[0] ?? "").length > 0;
      if (rest.length === 0 && !hasText) continue;
      const next: Raw = { ...m, tool_calls: rest };
      if (rest.length === 0) delete next.tool_calls;
      kept.push(next);
      continue;
    }
    kept.push(raw);
  }
  return changed ? { ...body, messages: kept } : body;
}

function sseResponse(chunks: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } },
  );
}

function chunkOf(id: string, created: number, model: string, delta: Raw, finish: string | null, withUsage = false): Raw {
  return {
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(withUsage ? { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } : {}),
  };
}

function chatInstallCall(modelId: string, command: string): Response {
  const now = Date.now();
  const id = `chatcmpl-omp-hook-gate-${now}`;
  const created = Math.floor(now / 1000);
  const callId = newId(OMP_GATE_CALL_PREFIX);
  return sseResponse([
    chunkOf(id, created, modelId, {
      role: "assistant", content: null,
      tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "bash", arguments: "" } }],
    }, null),
    chunkOf(id, created, modelId, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(installArgs(command)) } }] }, null),
    chunkOf(id, created, modelId, {}, "tool_calls", true),
  ]);
}

function chatText(modelId: string, text: string): Response {
  const now = Date.now();
  const id = `chatcmpl-omp-hook-gate-${now}`;
  const created = Math.floor(now / 1000);
  return sseResponse([
    chunkOf(id, created, modelId, { role: "assistant", content: text }, null),
    chunkOf(id, created, modelId, {}, "stop", true),
  ]);
}

// ── anthropic-messages ─────────────────────────────────────────────────────────

/** Text of a `tool_result` block: a string, or an array of text parts. */
const resultBlockText = (b: Raw): string => textParts(b.content).join("\n");

function anthropicEvents(body: Raw): OmpEvent[] {
  if (!Array.isArray(body.messages)) return [];
  return (body.messages as unknown[]).map((raw) => {
    const m = asObject(raw);
    const role = roleOf(m);
    const blocks = blocksOf(m.content);
    const calls = blocks.filter((b) => b.type === "tool_use");
    const results = blocks.filter((b) => b.type === "tool_result" && isGateId(b.tool_use_id));
    const onlyResults = results.length > 0 && blocks.every((b) => b.type === "tool_result");
    return {
      role: role === "assistant" ? "assistant" : role === "user" ? (onlyResults ? "tool" : "user") : "other",
      callIds: calls.map((b) => b.id).filter(isGateId),
      resultIds: results.map((b) => b.tool_use_id as string),
      resultText: results.map(resultBlockText).join("\n"),
      gateText: role === "assistant" && calls.length === 0 && startsWithMarker(m.content),
    };
  });
}

function anthropicStrip(body: Raw): Raw {
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const kept: unknown[] = [];
  for (const raw of body.messages as unknown[]) {
    const m = asObject(raw);
    const role = roleOf(m);
    const blocks = blocksOf(m.content);
    const isCall = (b: Raw) => b.type === "tool_use" && isGateId(b.id);
    const isResult = (b: Raw) => b.type === "tool_result" && isGateId(b.tool_use_id);
    const isText = role === "assistant" && !blocks.some((b) => b.type === "tool_use") && startsWithMarker(m.content);
    if (isText) {
      changed = true;
      continue;
    }
    if (blocks.some((b) => isCall(b) || isResult(b))) {
      changed = true;
      const rest = (m.content as unknown[]).filter((b) => !isCall(asObject(b)) && !isResult(asObject(b)));
      if (rest.length > 0) kept.push({ ...m, content: rest });
      continue;
    }
    kept.push(raw);
  }
  return changed ? { ...body, messages: kept } : body;
}

// ── openai-responses ───────────────────────────────────────────────────────────

/** An assistant message item of Responses: `{type:"message", role:"assistant", content:[{type:"output_text"}]}`. */
const isAssistantMessageItem = (it: Raw): boolean => roleOf(it) === "assistant" && (it.type === undefined || it.type === "message");

function responsesEvents(body: Raw): OmpEvent[] {
  if (!Array.isArray(body.input)) return [];
  return (body.input as unknown[]).map((raw) => {
    const it = asObject(raw);
    const base = { callIds: [] as string[], resultIds: [] as string[], resultText: "", gateText: false };
    if (it.type === "function_call") return { ...base, role: "assistant", callIds: [it.call_id].filter(isGateId) };
    if (it.type === "function_call_output") {
      const gate = isGateId(it.call_id);
      return { ...base, role: "tool", resultIds: gate ? [it.call_id as string] : [], resultText: gate ? textParts(it.output).join("\n") : "" };
    }
    if (isAssistantMessageItem(it)) return { ...base, role: "assistant", gateText: startsWithMarker(it.content) };
    if (roleOf(it) === "user") return { ...base, role: "user" };
    return { ...base, role: "other" };
  });
}

function responsesStrip(body: Raw): Raw {
  if (!Array.isArray(body.input)) return body;
  const input = (body.input as unknown[]).filter((raw) => {
    const it = asObject(raw);
    if ((it.type === "function_call" || it.type === "function_call_output") && isGateId(it.call_id)) return false;
    return !(isAssistantMessageItem(it) && startsWithMarker(it.content));
  });
  return input.length === (body.input as unknown[]).length ? body : { ...body, input };
}

/** Answer with one output item as a Responses stream. `added` is the item as it opens, before its payload streams. */
function responsesItemStream(modelId: string, item: Raw, added: Raw, events: Array<[string, Raw]>): Response {
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const full = { id: `resp_omp_hook_gate_${Date.now()}`, object: "response", model: modelId, status: "completed", output: [item], usage };
  const open = { ...full, status: "in_progress", output: [] };
  const all: Array<[string, Raw]> = [
    ["response.created", { response: open }],
    ["response.in_progress", { response: open }],
    ["response.output_item.added", { output_index: 0, item: added }],
    ...events,
    ["response.output_item.done", { output_index: 0, item }],
    ["response.completed", { response: full }],
  ];
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        // The `type` field inside the data is what the client reads as the event type.
        for (const [event, data] of all) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } },
  );
}

function responsesInstallCall(modelId: string, command: string): Response {
  const args = JSON.stringify(installArgs(command));
  const itemId = newId(RESPONSES_ITEM_PREFIX);
  const item = { type: "function_call", id: itemId, call_id: newId(OMP_GATE_CALL_PREFIX), name: "bash", arguments: args, status: "completed" };
  return responsesItemStream(modelId, item, { ...item, arguments: "", status: "in_progress" }, [
    ["response.function_call_arguments.delta", { output_index: 0, item_id: itemId, delta: args }],
    ["response.function_call_arguments.done", { output_index: 0, item_id: itemId, arguments: args }],
  ]);
}

function responsesText(modelId: string, text: string): Response {
  const itemId = newId(RESPONSES_TEXT_PREFIX);
  const item = { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return responsesItemStream(modelId, item, { ...item, status: "in_progress", content: [] }, [
    ["response.output_text.delta", { output_index: 0, item_id: itemId, content_index: 0, delta: text }],
  ]);
}

// ── Table ──────────────────────────────────────────────────────────────────────

export const OMP_FORMATS: Record<OmpFormat, OmpFormatRules> = {
  "anthropic-messages": {
    pathRe: /^\/omp\/[^/]+\/(?:v1\/)?messages\/?$/,
    askTool: "_ask",
    shellTool: "_bash",
    events: anthropicEvents,
    strip: anthropicStrip,
    installCall: (modelId, command) => buildToolUseResponse("_bash", installArgs(command), OMP_GATE_CALL_PREFIX, modelId),
    text: (modelId, text) => buildAnthropicText(text, modelId),
  },
  "openai-responses": {
    pathRe: /^\/omp\/[^/]+\/(?:v1\/)?responses\/?$/,
    askTool: "ask",
    shellTool: "bash",
    events: responsesEvents,
    strip: responsesStrip,
    installCall: responsesInstallCall,
    text: responsesText,
  },
  "openai-completions": {
    pathRe: /^\/omp\/[^/]+\/(?:v1\/)?chat\/completions\/?$/,
    askTool: "ask",
    shellTool: "bash",
    events: chatEvents,
    strip: chatStrip,
    installCall: chatInstallCall,
    text: chatText,
  },
};

/** The format of an omp route path, or null for any other route. */
export function ompFormatOf(path: string): OmpFormat | null {
  for (const format of Object.keys(OMP_FORMATS) as OmpFormat[]) {
    if (OMP_FORMATS[format].pathRe.test(path)) return format;
  }
  return null;
}
