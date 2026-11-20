/**
 * Mandatory project hook for interactive Codex sessions.
 *
 * The proxy learns the project of a session only from the client hook report
 * (see project-scope/session-workspace.ts and session/hook-gate-core.ts). A
 * Codex terminal session without a report gets no model answer. The proxy
 * answers with a shell tool call that runs the installer with `--session <id>`,
 * and the installer sends one report at once. There is no form: Codex asks the
 * user to approve the command itself, because the call requests escalation.
 *
 *   1. No report and no earlier gate call: answer with the install tool call.
 *   2. The tool result comes back: read the report again (wait a short time).
 *      If it exists, remove the synthetic turns and let the original prompt
 *      through. If the command was refused, or the report is still missing,
 *      answer with text that holds the manual command.
 *   3. After two failed attempts in one conversation, the gate lets requests
 *      through.
 *
 * The state is the conversation itself. Codex replays every item in the next
 * request, so the gate needs no store of its own.
 *
 * Which requests are gated (captured with Codex 0.164.0)
 * -----------------------------------------------------
 * Only a request with the `originator` header `codex-tui` that offers a shell
 * tool. `codex exec` runs with approval `never` and cannot approve an escalated
 * command, and app-server hosts and SDKs have unknown approval screens, so these
 * pass. The shell tool depends on the model:
 *
 *   most models   tools[]: function `exec_command` (argument `cmd`)
 *   gpt-6 family  no tools[]; an `additional_tools` input item lists the custom
 *                 tool `exec`, which runs JavaScript that calls
 *                 `tools.exec_command({...})`
 *
 * The thread title request of the terminal has no shell tool (its tool list
 * holds `apply_patch` only) and passes. It is also a side request.
 *
 * Only a turn with `thread_source: "user"` (header `x-codex-turn-metadata`) is
 * gated. A child agent of the multi-agent feature, captured with Codex 0.164:
 * `originator: codex-tui`, the SAME `session-id` as its parent, `thread_source:
 * subagent`, `x-openai-subagent: collab_spawn`, `x-codex-parent-thread-id: <parent>`.
 * It passes, so a child never gets the install call instead of its work.
 *
 * Compaction: after `/responses/compact` the gate items are gone from the
 * history, so a session that failed open (two failed attempts) is asked again
 * on its next prompt. The gate keeps no state of its own.
 *
 * Every pass removes the synthetic gate items from the history first, so that a
 * resumed session, a fork, or a proxy with the gate switched off never sends
 * the made-up tool calls to the model.
 */

import { codexThreadSource } from "../../agent-adapters/codex.js";
import type { SessionWorkspaceKey } from "../../project-scope/session-workspace.js";
import {
  buildInstallCommand,
  installNotDoneText,
  isGateEnabled,
  looksRejected,
  lookupReport,
  manualInstallText,
  planGateStep,
  resolveOrigin,
  SESSION_ID_RE,
  waitForReport,
  GATE_TEXT_MARKER,
  type GateConfig,
  type GateHistory,
} from "../hook-gate-core.js";

// ── Constants ──────────────────────────────────────────────────────────────────

/** `call_id` prefix of every gate tool call. The result of the call carries the same `call_id`. */
export const CODEX_GATE_CALL_PREFIX = "call_codex_hook_gate_";
const FUNCTION_ITEM_PREFIX = "fc_codex_hook_gate_";
const CUSTOM_ITEM_PREFIX = "ctc_codex_hook_gate_";
/** Item id prefix of the gate text answers. Codex keeps the id of an assistant item in the history. */
export const CODEX_GATE_TEXT_PREFIX = "msg_codex_hook_gate_";

const TUI_ORIGINATOR = "codex-tui";
/** The routes that have a hook report route beside them. */
const GATED_PATH_RE = /^\/codex\/[^/]+\/(?:v1\/)?responses\/?$/;
const JUSTIFICATION = "Install the Agent-Memory project hook (writes ~/.codex/config.toml and ~/.agent-memory)";

// ── Public API ─────────────────────────────────────────────────────────────────

export interface CodexGateParams {
  config: GateConfig;
  /** Request path, for example `/codex/default/v1/responses`. */
  path: string;
  /** Lower-cased request header names. */
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** Session id of the request, as the hook report route stores it. Null when the request has none. */
  sessionId: string | null;
  spaceId: string;
  /** The user id that the hook report route stores under: the verified id, or "anonymous". */
  userId: string;
  modelId: string;
  /** Proxy origin as the client reaches it. Null when unknown. */
  origin: string | null;
  /** How long to wait for the report after the installer ran. Default 3000. */
  waitMs?: number;
}

export type CodexGateResult =
  /** Forward the request. `body` has the synthetic items removed. */
  | { action: "pass"; body: Record<string, unknown>; reason: string }
  /** Answer the client with `response`. Nothing goes upstream and nothing is stored. */
  | { action: "respond"; response: Response; reason: string };

/** Decide what to do with one Codex request. Never throws: a failed report lookup lets the request through. */
export async function runCodexHookGate(params: CodexGateParams): Promise<CodexGateResult> {
  const { body } = params;
  const pass = (reason: string): CodexGateResult => ({ action: "pass", body: stripCodexGateTurns(body), reason });

  if (!isGateEnabled(params.config)) return pass("disabled");
  // Cost-guard and analyse routes have no hook report route beside them, so they are not gated.
  if (!GATED_PATH_RE.test(params.path)) return pass("other-route");
  if (params.headers["originator"] !== TUI_ORIGINATOR) return pass("not-tui");
  // Only a turn that the user typed. Child agents (thread_source "subagent", header x-openai-subagent) and
  // every thread kind that is not known pass.
  if (codexThreadSource(params.headers, body) !== "user") return pass("not-user-turn");
  if (params.headers["x-openai-subagent"] || params.headers["x-codex-parent-thread-id"]) return pass("subagent");
  const shell = pickShellTool(body);
  if (!shell) return pass("no-shell-tool");

  const sessionId = params.sessionId;
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return pass("no-session-id");

  const key: SessionWorkspaceKey = {
    spaceId: params.spaceId,
    userId: params.userId || "anonymous",
    agentSource: "codex",
    sessionId,
  };
  const known = await lookupReport(params.config, key);
  if (known === "installed") return pass("installed");
  if (known === "unavailable") return pass("lookup-failed");

  const stream = body.stream !== false;
  const command = buildInstallCommand(resolveOrigin(params.config, params.origin), sessionId, "codex");
  const text = (t: string, reason: string): CodexGateResult => ({
    action: "respond",
    response: buildTextResponse(params.modelId, `${GATE_TEXT_MARKER} ${t}`, stream),
    reason,
  });

  const history = readCodexHistory(Array.isArray(body.input) ? (body.input as unknown[]) : []);
  switch (planGateStep(history)) {
    case "retry-limit":
      return pass("retry-limit");
    case "rejected":
      return text(installNotDoneText(command, true), "install-rejected");
    case "check-result": {
      // The report decides first: a tool output can hold words like "denied" although the install worked.
      // A refused command gets one lookup and no wait.
      const refused = looksRejected(history.lastResult ?? "");
      if (await waitForReport(params.config, key, refused ? 0 : params.waitMs)) return pass("installed-in-session");
      return text(installNotDoneText(command, refused), refused ? "install-rejected" : "install-failed");
    }
    case "call": {
      if (!command) return text(manualInstallText(command), "no-command");
      return {
        action: "respond",
        response: buildInstallCallResponse(params.modelId, shell, command, stream),
        reason: "install-requested",
      };
    }
  }
}

// ── Request inspection ─────────────────────────────────────────────────────────

type ShellTool = "function" | "code";

interface ToolEntry {
  type?: unknown;
  name?: unknown;
  tools?: unknown;
}

/** Collect the tool entries of `tools[]` and of every `additional_tools` input item, including namespaces. */
function collectTools(body: Record<string, unknown>): ToolEntry[] {
  const found: ToolEntry[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 4) return;
    const entry = node as ToolEntry;
    if (typeof entry.name === "string") found.push(entry);
    if (Array.isArray(entry.tools)) for (const child of entry.tools) visit(child, depth + 1);
  };
  if (Array.isArray(body.tools)) for (const t of body.tools) visit(t, 0);
  if (Array.isArray(body.input)) {
    for (const item of body.input as ToolEntry[]) {
      if (item && (item as { type?: unknown }).type === "additional_tools") visit({ tools: item.tools }, 0);
    }
  }
  return found;
}

/** The way this request can run a shell command, or null when it cannot. */
function pickShellTool(body: Record<string, unknown>): ShellTool | null {
  const tools = collectTools(body);
  if (tools.some((t) => t.type === "function" && t.name === "exec_command")) return "function";
  if (tools.some((t) => t.type === "custom" && t.name === "exec")) return "code";
  return null;
}

// ── Conversation state ─────────────────────────────────────────────────────────

interface RawItem {
  type?: unknown;
  role?: unknown;
  id?: unknown;
  call_id?: unknown;
  output?: unknown;
  content?: unknown;
}

const CALL_TYPES = new Set(["function_call", "custom_tool_call"]);
const RESULT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);

const isGateCall = (item: RawItem) =>
  typeof item.type === "string" && CALL_TYPES.has(item.type) && typeof item.call_id === "string" && item.call_id.startsWith(CODEX_GATE_CALL_PREFIX);
const isGateResult = (item: RawItem) =>
  typeof item.type === "string" && RESULT_TYPES.has(item.type) && typeof item.call_id === "string" && item.call_id.startsWith(CODEX_GATE_CALL_PREFIX);
const isGateText = (item: RawItem) =>
  item.type === "message" && item.role === "assistant" && typeof item.id === "string" && item.id.startsWith(CODEX_GATE_TEXT_PREFIX);

/** The user message Codex adds after an interrupted turn. */
function isTurnAborted(item: RawItem): boolean {
  if (item.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) return false;
  const parts = item.content as Array<{ text?: unknown }>;
  // Every part must be the marker: a message that also holds a typed prompt is not removed.
  return parts.length > 0 && parts.every((part) => typeof part?.text === "string" && part.text.trimStart().startsWith("<turn_aborted>"));
}

/** Text of a tool result: a string for functions, an array of `input_text` parts for custom tools. */
function resultText(item: RawItem): string {
  const out = item.output;
  if (typeof out === "string") return out;
  if (!Array.isArray(out)) return "";
  return (out as Array<{ text?: unknown }>)
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n");
}

function readCodexHistory(input: unknown[]): GateHistory {
  const items = input.filter((i): i is RawItem => !!i && typeof i === "object");
  const history: GateHistory = { attempts: 0, resultIsLast: false, lastResult: null, lastAnswered: false };
  let lastCall: RawItem | undefined;
  for (const item of items) {
    if (isGateCall(item)) {
      history.attempts++;
      lastCall = item;
    }
  }
  if (!lastCall) return history;
  const resultIndex = items.findIndex((i) => isGateResult(i) && i.call_id === lastCall!.call_id);
  if (resultIndex < 0) return history;
  history.lastResult = resultText(items[resultIndex]);
  const after = items.slice(resultIndex + 1);
  history.resultIsLast = after.every(isTurnAborted);
  history.lastAnswered = after.some(isGateText);
  return history;
}

// ── History cleaning ───────────────────────────────────────────────────────────

/**
 * Remove every item the gate made up: the install call, its result, the text
 * answers, and the `<turn_aborted>` message that follows a refused result.
 * Returns the same object when nothing needs removal.
 */
export function stripCodexGateTurns(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.input)) return body;
  const kept: unknown[] = [];
  let removed = false;
  let afterGateResult = false;
  for (const raw of body.input as unknown[]) {
    const item = (raw && typeof raw === "object" ? raw : {}) as RawItem;
    if (isGateCall(item) || isGateResult(item) || isGateText(item) || (afterGateResult && isTurnAborted(item))) {
      removed = true;
      afterGateResult = isGateResult(item) || (afterGateResult && isTurnAborted(item));
      continue;
    }
    afterGateResult = false;
    kept.push(raw);
  }
  return removed ? { ...body, input: kept } : body;
}

// ── Responses ──────────────────────────────────────────────────────────────────

type OutputItem = Record<string, unknown>;

function uniqueSuffix(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildInstallCallResponse(modelId: string, shell: ShellTool, command: string, stream: boolean): Response {
  const suffix = uniqueSuffix();
  const callId = CODEX_GATE_CALL_PREFIX + suffix;
  const args = { cmd: command, sandbox_permissions: "require_escalated", justification: JUSTIFICATION };
  if (shell === "function") {
    const argsJson = JSON.stringify(args);
    const item: OutputItem = { type: "function_call", id: FUNCTION_ITEM_PREFIX + suffix, name: "exec_command", arguments: argsJson, call_id: callId };
    return respondWithItem(modelId, item, stream, { arguments: argsJson });
  }
  // The code tool runs JavaScript. The command goes in as a JSON string literal.
  const script = `const r = await tools.exec_command(${JSON.stringify(args)}); text(r);`;
  const item: OutputItem = { type: "custom_tool_call", id: CUSTOM_ITEM_PREFIX + suffix, name: "exec", input: script, call_id: callId };
  return respondWithItem(modelId, item, stream, { input: script });
}

function buildTextResponse(modelId: string, text: string, stream: boolean): Response {
  const item: OutputItem = {
    type: "message",
    id: CODEX_GATE_TEXT_PREFIX + uniqueSuffix(),
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return respondWithItem(modelId, item, stream, { text });
}

/**
 * Answer with one output item, as a Responses API stream or one JSON body.
 * `payload` names the field that a real server streams in pieces, so the
 * `added` event can carry it empty.
 */
function respondWithItem(
  modelId: string,
  item: OutputItem,
  stream: boolean,
  payload: { arguments?: string; input?: string; text?: string },
): Response {
  const responseId = `resp_codex_hook_gate_${Date.now()}`;
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const full = { id: responseId, object: "response", model: modelId, status: "completed", output: [item], usage };
  if (!stream) {
    return new Response(JSON.stringify(full), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const encoder = new TextEncoder();
  // The `type` field inside the data is required: Codex reads the event type from it.
  const sse = (event: string, data: Record<string, unknown>) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  const open = { ...full, status: "in_progress", output: [] };
  const itemId = item.id as string;
  const added: OutputItem = { ...item };
  if (payload.arguments !== undefined) added.arguments = "";
  if (payload.input !== undefined) added.input = "";
  if (payload.text !== undefined) added.content = [];

  const events: Uint8Array[] = [
    sse("response.created", { response: open }),
    sse("response.in_progress", { response: open }),
    sse("response.output_item.added", { output_index: 0, item: added }),
  ];
  if (payload.arguments !== undefined) {
    events.push(sse("response.function_call_arguments.delta", { output_index: 0, item_id: itemId, delta: payload.arguments }));
    events.push(sse("response.function_call_arguments.done", { output_index: 0, item_id: itemId, arguments: payload.arguments }));
  }
  if (payload.text !== undefined) {
    events.push(sse("response.output_text.delta", { output_index: 0, item_id: itemId, content_index: 0, delta: payload.text }));
  }
  events.push(sse("response.output_item.done", { output_index: 0, item }));
  events.push(sse("response.completed", { response: full }));

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const e of events) controller.enqueue(e);
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } },
  );
}
