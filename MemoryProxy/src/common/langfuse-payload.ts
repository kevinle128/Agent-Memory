/**
 * Langfuse generation payloads: the full, native request and reply of one LLM call.
 *
 * Every runner reports the same two things, whatever the protocol:
 *
 * - input  = the request body that goes upstream (build it after every rewrite:
 *            overrides, thinking cleanup, cache TTL), in its native shape (Anthropic, OpenAI chat or
 *            Responses), with nothing flattened, stringified or cut. Thinking
 *            blocks keep their full text and signature, `tool_use` and
 *            `tool_result` stay blocks, images stay as sent, and `cache_control`
 *            markers stay in place. The tool definitions and the request
 *            parameters (model, tool_choice, thinking, max_tokens, temperature, ...)
 *            travel with it.
 * - output = the full assistant message (see `langfuseOutputFromReply`).
 *
 * Why this input shape. Langfuse v4.82.0 reads it like this:
 *   - The OpenAI chat adapter claims any object `{messages: [...], tools?: [...]}`
 *     (loose schema: extra keys are allowed) and renders `messages` as a chat.
 *     It also attaches `tools` to the messages, so the UI shows a Tools section.
 *     A Responses body `{input, instructions, tools}` is claimed the same way.
 *   - Ingestion (`extractToolsBackend`) fills `toolDefinitions` from the top-level
 *     `tools` array. It accepts flat `{name, description}` tools. It reads the
 *     schema from `parameters`, `parameters_json_schema` or `inputSchema`, so an
 *     Anthropic `input_schema` is stored in the raw input but is not copied into
 *     the `toolDefinitions` column. Names and descriptions are.
 *   - Ingestion fills `toolCallNames` from `tool_use` content blocks, OpenAI
 *     `tool_calls` and Responses `function_call` items in the output.
 * The Anthropic `system` field has no place in that schema, so it becomes a
 * leading `{role: "system", content}` message. Its content stays native (a string
 * or the block array with `cache_control`).
 *
 * Credentials never travel with it. Top-level keys with a credential-like name
 * are dropped. Known nested credential fields are replaced with "[redacted]"
 * (the key stays, so the shape is still visible); see `scrubRequestCredentials`.
 * Conversation content is never touched. HTTP headers are not part of this payload.
 */

import type { ModelReply } from "../session-trace/assemble.js";

type Json = Record<string, unknown>;

/** Credential-like top-level key names. A request body does not carry these; this is a guard. */
const SENSITIVE_KEY = /(^|[_-])(api[_-]?key|apikey|authorization|secret|password|passwd|credentials?|access[_-]?token|auth[_-]?token|bearer)([_-]|$)/i;

export const REDACTED = "[redacted]";

/**
 * Known nested credential fields of a request body.
 *
 * Confirmed in the vendor docs (platform.claude.com MCP connector, developers.openai.com MCP and connectors):
 *   - Anthropic Messages: `mcp_servers[].authorization_token` (OAuth token of the MCP server).
 *   - OpenAI Responses: `tools[]` of type `mcp`: `authorization` (OAuth access token; mandatory for
 *     connectors). The API does not store it, so every request carries it.
 * Not in the docs, but scrubbed as a guard because MCP clients and gateways add them:
 *   - `headers` of any tool definition or `mcp_servers[]` entry (values only; keys stay).
 *   - `authorization_token` and `authorization` of any tool definition or `mcp_servers[]` entry.
 * Not scrubbed: `server_url` (routing, no secret by contract) and all conversation content.
 */
const CREDENTIAL_FIELDS = ["authorization_token", "authorization"] as const;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function redactHeaders(headers: unknown): unknown {
  if (!isRecord(headers)) return REDACTED;
  return Object.fromEntries(Object.keys(headers).map((k) => [k, REDACTED]));
}

/** Copy of one tool or MCP server entry with its credentials replaced; the same object when it has none. */
function scrubEntry(entry: unknown): unknown {
  if (!isRecord(entry)) return entry;
  let out: Json | undefined;
  for (const field of CREDENTIAL_FIELDS) {
    if (entry[field] !== undefined && entry[field] !== null) (out ??= { ...entry })[field] = REDACTED;
  }
  if (entry.headers !== undefined && entry.headers !== null) (out ??= { ...entry }).headers = redactHeaders(entry.headers);
  return out ?? entry;
}

function scrubList(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  let out: unknown[] | undefined;
  list.forEach((entry, i) => {
    const next = scrubEntry(entry);
    if (next !== entry) (out ??= [...list])[i] = next;
  });
  return out ?? list;
}

/**
 * Return the body with known nested credentials replaced by "[redacted]".
 * Copy on write: the argument (which the proxy forwards upstream) is never mutated.
 */
export function scrubRequestCredentials<T extends Json>(body: T): T {
  let out: Json | undefined;
  for (const key of ["tools", "mcp_servers"] as const) {
    const next = scrubList(body[key]);
    if (next !== body[key]) (out ??= { ...body })[key] = next;
  }
  return (out ?? body) as T;
}

/**
 * Return the body with credential-like top-level keys dropped and known nested
 * credentials replaced by "[redacted]". The shape is otherwise kept, so it suits
 * any sink (Langfuse, Opik). Copy on write: the argument is never mutated.
 */
export function redactRequestBody(body: Json): Json {
  const scrubbed = scrubRequestCredentials(body);
  if (!Object.keys(scrubbed).some((key) => SENSITIVE_KEY.test(key))) return scrubbed;
  return Object.fromEntries(Object.entries(scrubbed).filter(([key]) => !SENSITIVE_KEY.test(key)));
}

/**
 * Redact a request payload of unknown shape for a telemetry sink. An object is
 * redacted by `redactRequestBody`. Anything else (the raw text of a body that
 * did not parse) is never sent: a placeholder with its byte length replaces it,
 * because its secrets cannot be located.
 */
export function redactRequestPayload(payload: unknown): unknown {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return redactRequestBody(payload as Json);
  }
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  return `[unparsable request body: ${Buffer.byteLength(text)} bytes]`;
}

export interface LangfuseRequestParts {
  /**
   * Messages of the request when the caller holds a newer list than `body.messages`
   * (the proxy replaces them after memory injection). Defaults to `body.messages`.
   */
  messages?: unknown[];
  /** Anthropic top-level `system` (string or block array). Defaults to `body.system`. */
  system?: unknown;
}

function hasSystem(system: unknown): boolean {
  if (system === undefined || system === null || system === "") return false;
  return !(Array.isArray(system) && system.length === 0);
}

/**
 * Build the Langfuse `input` of one request from its native body.
 *
 * - Chat protocols (`messages`): `{messages: [system?, ...messages], tools?, ...params}`.
 * - Responses protocol (`input`): the body as is (`input`, `instructions`, `tools`, ...).
 */
export function buildLangfuseRequestInput(rawBody: Json, parts: LangfuseRequestParts = {}): Json {
  const body = redactRequestBody(rawBody);
  const messages = parts.messages ?? (Array.isArray(body.messages) ? body.messages : undefined);
  const system = parts.system !== undefined ? parts.system : body.system;
  const isChat = messages !== undefined;

  const out: Json = {};
  if (isChat) {
    out.messages = hasSystem(system) ? [{ role: "system", content: system }, ...messages] : [...messages];
  }
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (isChat && (key === "messages" || key === "system")) continue;
    out[key] = value;
  }
  return out;
}

export type ReplyKind = "anthropic" | "openai" | "responses";

const STOP_KEY: Record<ReplyKind, string> = {
  anthropic: "stop_reason",
  openai: "finish_reason",
  responses: "status",
};

/** True when the upstream produced nothing: no content, no tool call, no stop reason. */
function isEmptyReply(reply: ModelReply, kind: ReplyKind): boolean {
  if (reply.stopReason !== null || reply.incomplete?.error !== undefined) return false;
  const out = reply.output;
  if (kind === "anthropic") return !Array.isArray(out.content) || out.content.length === 0;
  if (kind === "responses") return !Array.isArray(out.output) || out.output.length === 0;
  const hasToolCalls = Array.isArray(out.tool_calls) && out.tool_calls.length > 0;
  const hasExtraFields = Object.keys(out).some((k) => k !== "role" && k !== "content" && k !== "tool_calls");
  const hasContent = out.content !== undefined && out.content !== null && out.content !== "";
  return !hasToolCalls && !hasExtraFields && !hasContent;
}

/**
 * Build the Langfuse `output` from a full model reply (streamed or not).
 *
 * The reply keeps its native shape: an Anthropic message `{role, content: [blocks]}`
 * with `stop_reason`, an OpenAI message (`content`, `tool_calls`, reasoning fields)
 * with `finish_reason`, or `{output: [items], status}` for Responses. A reply
 * that only calls tools is therefore never undefined. Only an upstream that
 * returned nothing at all (for example an aborted stream) gives `undefined`.
 */
export function langfuseOutputFromReply(reply: ModelReply | null | undefined, kind: ReplyKind): Json | undefined {
  if (!reply || isEmptyReply(reply, kind)) return undefined;
  const out: Json = { ...reply.output };
  if (reply.stopReason !== null) out[STOP_KEY[kind]] = reply.stopReason;
  if (reply.incomplete?.error !== undefined) out.error = reply.incomplete.error;
  return out;
}

/** Longest error text that goes into a Langfuse status message. */
const STATUS_MESSAGE_MAX = 500;

export interface LangfuseReplyStatus {
  level?: "WARNING" | "ERROR";
  statusMessage?: string;
  /** Merge into the observation metadata. Empty for a complete reply. */
  metadata: Record<string, unknown>;
}

/**
 * Level, status message and metadata for a reply that was cut or failed
 * (see `ModelReply.incomplete`). A complete reply gets none of them, so it
 * keeps the default level.
 */
export function langfuseReplyStatus(reply: ModelReply | null | undefined): LangfuseReplyStatus {
  const incomplete = reply?.incomplete;
  if (!incomplete) return { metadata: {} };
  const error = incomplete.error === undefined ? "" : ` ${JSON.stringify(incomplete.error)}`;
  return {
    level: incomplete.level,
    statusMessage: `stream incomplete: ${incomplete.reason}${error}`.slice(0, STATUS_MESSAGE_MAX),
    metadata: { stream_incomplete: true, stream_incomplete_reason: incomplete.reason },
  };
}
