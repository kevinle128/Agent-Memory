/**
 * Mandatory project hook for interactive oh-my-pi (omp) sessions.
 *
 * omp talks to the proxy on the omp route
 * (`/omp/<space>/v1/chat/completions`, or without `/v1`). The proxy learns the project of a session
 * only from the client hook report (see project-scope/session-workspace.ts and
 * session/hook-gate-core.ts). An omp terminal session without a report gets no
 * model answer. The proxy answers with a `bash` tool call that runs the
 * installer with `--client omp --session <id>`. omp runs it at once (its default
 * approval mode asks nothing), and the installer sends one report. There is no
 * form.
 *
 *   1. No report and no earlier gate call: answer with the install tool call.
 *   2. The tool result comes back: read the report again (wait a short time).
 *      If it exists, remove the synthetic turns and let the original prompt
 *      through. If the command was refused, or the report is still missing,
 *      answer with text that holds the manual command.
 *   3. After two failed attempts in one conversation, the gate lets requests
 *      through.
 *
 * The state is the conversation itself: omp replays every message, so the gate
 * needs no store of its own.
 *
 * Which requests are gated (captured with omp 18.6.3)
 * ---------------------------------------------------
 *   tools        `-p`, rpc and SDK runs do not offer `ask`. Only the terminal
 *                does, so the gate needs `ask` and `bash`.
 *   session id   omp sends no session header to a custom provider. With
 *                `compat.supportsPromptCacheKey: true` it sends the body field
 *                `prompt_cache_key`, which equals the id its extension reports.
 *                The caller resolves the id. Without one the gate does not run.
 *
 * The hook report route stores the report under the agent source `omp`, the
 * first segment of the route, so the lookup uses the same value.
 *
 * Every pass removes the synthetic gate turns from the history first, so that a
 * resumed session or a proxy with the gate switched off never sends the
 * made-up tool calls to the model. The text answers of the gate are found by
 * their marker at the start of an assistant message without tool calls: omp
 * keeps no message id and no other signal for them.
 */

import type { SessionWorkspaceKey } from "../../project-scope/session-workspace.js";
import {
  buildInstallCommand,
  GATE_TEXT_MARKER,
  installNotDoneText,
  isGateEnabled,
  looksRejected,
  lookupReport,
  manualInstallText,
  planGateStep,
  resolveOrigin,
  SESSION_ID_RE,
  waitForReport,
  type GateConfig,
  type GateHistory,
} from "../hook-gate-core.js";

// ── Constants ──────────────────────────────────────────────────────────────────

/** `tool_call_id` prefix of every gate tool call. The tool message that answers it carries the same id. */
export const OMP_GATE_CALL_PREFIX = "call_omp_hook_gate_";

/** The route of the omp agent that has a hook report route beside it. */
const GATED_PATH_RE = /^\/omp\/[^/]+\/(?:v1\/)?chat\/completions\/?$/;
/** The hook report route keys reports by the first route segment. */
const REPORT_AGENT_SOURCE = "omp";
const INTENT = "Install the Agent-Memory project hook";

// ── Public API ─────────────────────────────────────────────────────────────────

export interface OmpGateParams {
  config: GateConfig;
  /** Request path, for example `/omp/default/v1/chat/completions`. */
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

export type OmpGateResult =
  /** Forward the request. `body` has the synthetic turns removed. */
  | { action: "pass"; body: Record<string, unknown>; reason: string }
  /** Answer the client with `response`. Nothing goes upstream and nothing is stored. */
  | { action: "respond"; response: Response; reason: string };

let warnedNoSessionId = false;

/** Decide what to do with one omp-route request. Never throws: a failed report lookup lets the request through. */
export async function runOmpHookGate(params: OmpGateParams): Promise<OmpGateResult> {
  const { body } = params;
  const pass = (reason: string): OmpGateResult => ({ action: "pass", body: stripOmpGateTurns(body), reason });

  if (!isGateEnabled(params.config)) return pass("disabled");
  if (!GATED_PATH_RE.test(params.path)) return pass("other-route");
  if (body.stream !== true || !(offersTool(body, "ask") && offersTool(body, "bash"))) return pass("non-interactive");

  const sessionId = params.sessionId;
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
    if (!warnedNoSessionId) {
      warnedNoSessionId = true;
      console.warn(
        "[hook-gate] an omp request has no session id, so it is not gated. " +
        "Set compat.supportsPromptCacheKey: true on the proxy provider in models.yml.",
      );
    }
    console.debug("[hook-gate] omp request without a session id: not gated");
    return pass("no-session-id");
  }

  const key: SessionWorkspaceKey = {
    spaceId: params.spaceId,
    userId: params.userId || "anonymous",
    agentSource: REPORT_AGENT_SOURCE,
    sessionId,
  };
  const known = await lookupReport(params.config, key);
  if (known === "installed") return pass("installed");
  if (known === "unavailable") return pass("lookup-failed");

  const command = buildInstallCommand(resolveOrigin(params.config, params.origin), sessionId, "omp");
  const text = (t: string, reason: string): OmpGateResult => ({
    action: "respond",
    response: buildTextResponse(params.modelId, `${GATE_TEXT_MARKER} ${t}`),
    reason,
  });

  const history = readOmpHistory(Array.isArray(body.messages) ? (body.messages as unknown[]) : []);
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
        response: buildInstallCallResponse(params.modelId, command),
        reason: "install-requested",
      };
    }
  }
}

// ── Request inspection ─────────────────────────────────────────────────────────

/** Names of the offered tools. Chat Completions nests the name under `function`; other shapes keep it on the tool. */
function offersTool(body: Record<string, unknown>, name: string): boolean {
  if (!Array.isArray(body.tools)) return false;
  return (body.tools as Array<{ name?: unknown; function?: { name?: unknown } }>).some(
    (t) => (t?.function?.name ?? t?.name) === name,
  );
}

// ── Conversation state ─────────────────────────────────────────────────────────

interface RawMessage {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
}

interface RawToolCall {
  id?: unknown;
}

const roleOf = (m: RawMessage): string => (typeof m.role === "string" ? m.role : "");

function toolCallsOf(m: RawMessage): RawToolCall[] {
  return roleOf(m) === "assistant" && Array.isArray(m.tool_calls) ? (m.tool_calls as RawToolCall[]) : [];
}

const isGateCallId = (id: unknown): boolean => typeof id === "string" && id.startsWith(OMP_GATE_CALL_PREFIX);

const hasGateCall = (m: RawMessage): boolean => toolCallsOf(m).some((tc) => isGateCallId(tc?.id));

const isGateResult = (m: RawMessage): boolean => roleOf(m) === "tool" && isGateCallId(m.tool_call_id);

/** First text of a message: the string content, or the first text part of an array. */
function leadingText(m: RawMessage): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  const part = (m.content as Array<{ type?: unknown; text?: unknown }>).find((p) => p?.type === "text" && typeof p.text === "string");
  return typeof part?.text === "string" ? part.text : "";
}

function contentText(m: RawMessage): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return (m.content as Array<{ text?: unknown }>)
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("\n");
}

/** A text answer of the gate: an assistant message without tool calls that starts with the marker. */
function isGateText(m: RawMessage): boolean {
  return roleOf(m) === "assistant" && toolCallsOf(m).length === 0 && leadingText(m).startsWith(GATE_TEXT_MARKER);
}

function readOmpHistory(messages: unknown[]): GateHistory {
  const list = messages.filter((m): m is RawMessage => !!m && typeof m === "object");
  const history: GateHistory = { attempts: 0, resultIsLast: false, lastResult: null, lastAnswered: false };
  let lastCallId: string | undefined;
  for (const m of list) {
    for (const tc of toolCallsOf(m)) {
      if (isGateCallId(tc?.id)) {
        history.attempts++;
        lastCallId = tc.id as string;
      }
    }
  }
  if (!lastCallId) return history;
  const resultIndex = list.findIndex((m) => isGateResult(m) && m.tool_call_id === lastCallId);
  if (resultIndex < 0) return history;
  history.lastResult = contentText(list[resultIndex]);
  const after = list.slice(resultIndex + 1);
  // omp may add a trailing system message. The conversation ends at the last user, assistant or tool message.
  history.resultIsLast = after.every((m) => !["user", "assistant", "tool"].includes(roleOf(m)));
  history.lastAnswered = after.some(isGateText);
  return history;
}

// ── History cleaning ───────────────────────────────────────────────────────────

/**
 * Remove every turn the gate made up: the assistant message with the install
 * call, the tool message that answers it, and the text answers. Returns the
 * same object when nothing needs removal.
 */
export function stripOmpGateTurns(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const kept: unknown[] = [];
  for (const raw of body.messages as unknown[]) {
    const m = (raw && typeof raw === "object" ? raw : {}) as RawMessage;
    if (isGateResult(m) || isGateText(m)) {
      changed = true;
      continue;
    }
    if (hasGateCall(m)) {
      changed = true;
      const rest = toolCallsOf(m).filter((tc) => !isGateCallId(tc?.id));
      const hasText = leadingText(m).length > 0;
      if (rest.length === 0 && !hasText) continue;
      const next = { ...(raw as object), tool_calls: rest } as Record<string, unknown>;
      if (rest.length === 0) delete next.tool_calls;
      kept.push(next);
      continue;
    }
    kept.push(raw);
  }
  return changed ? { ...body, messages: kept } : body;
}

// ── Responses ──────────────────────────────────────────────────────────────────

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

function chunkOf(id: string, created: number, model: string, delta: Record<string, unknown>, finish: string | null, withUsage = false) {
  return {
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(withUsage ? { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } : {}),
  };
}

function buildInstallCallResponse(modelId: string, command: string): Response {
  const now = Date.now();
  const id = `chatcmpl-omp-hook-gate-${now}`;
  const created = Math.floor(now / 1000);
  const callId = `${OMP_GATE_CALL_PREFIX}${now}_${Math.random().toString(36).slice(2, 8)}`;
  // The bash tool of omp requires `i` (a short statement of intent) beside `command`.
  const args = JSON.stringify({ command, i: INTENT });
  return sseResponse([
    chunkOf(id, created, modelId, {
      role: "assistant", content: null,
      tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "bash", arguments: "" } }],
    }, null),
    chunkOf(id, created, modelId, { tool_calls: [{ index: 0, function: { arguments: args } }] }, null),
    chunkOf(id, created, modelId, {}, "tool_calls", true),
  ]);
}

function buildTextResponse(modelId: string, text: string): Response {
  const now = Date.now();
  const id = `chatcmpl-omp-hook-gate-${now}`;
  const created = Math.floor(now / 1000);
  return sseResponse([
    chunkOf(id, created, modelId, { role: "assistant", content: text }, null),
    chunkOf(id, created, modelId, {}, "stop", true),
  ]);
}
