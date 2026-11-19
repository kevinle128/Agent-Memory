/**
 * Mandatory project hook for interactive AntiGravity (agy) sessions.
 *
 * agy talks to the proxy on `/antigravity/<space>/<key>/v1beta/models/<model>:streamGenerateContent`
 * and names its conversation in `labels.cascade_id`, the same id that its hooks report as
 * `conversationId`. The proxy learns the project of a session only from the client hook report (see
 * project-scope/session-workspace.ts and session/hook-gate-core.ts). A session without a report gets
 * no model answer: the proxy answers with a valid Gemini SSE stream that holds the install command.
 *
 * agy has no tool that the proxy can call on its behalf, so the answer is text only. The user runs
 * the command in a terminal and sends the prompt again. The next request finds the report (after a
 * short wait) and passes. After two answers in one conversation the gate lets requests through.
 *
 * The state is the conversation: agy replays its history, so the answers of the gate are found in
 * `contents` by their marker. The request body is never changed: the proxy only wraps the envelope.
 * The gate fails open. It is a setup aid, not a security control.
 */

import type { SessionWorkspaceKey } from "../../project-scope/session-workspace.js";
import {
  buildInstallCommand,
  GATE_TEXT_MARKER,
  installNotDoneText,
  isGateEnabled,
  lookupReport,
  manualInstallText,
  MAX_FAILED_ATTEMPTS,
  resolveOrigin,
  SESSION_ID_RE,
  waitForReport,
  type GateConfig,
} from "../hook-gate-core.js";

/** The hook report route keys reports by the first route segment. */
const REPORT_AGENT_SOURCE = "antigravity";

export interface AntigravityGateParams {
  config: GateConfig;
  /** Gemini request body, as agy sent it. */
  body: Record<string, unknown>;
  /** True for `:streamGenerateContent`. Other calls (title, summary) are never gated. */
  stream: boolean;
  /** `labels.cascade_id`. Null when the request has none. */
  sessionId: string | null;
  spaceId: string;
  /** The user id that the hook report route stores under: the verified id, or "anonymous". */
  userId: string;
  /** Proxy origin as the client reaches it. Null when unknown. */
  origin: string | null;
  /** How long to wait for the report after an earlier answer. Default 3000. */
  waitMs?: number;
}

export type AntigravityGateResult =
  | { action: "pass"; reason: string }
  | { action: "respond"; response: Response; reason: string };

/** A Gemini SSE stream with one model text and a STOP finish. */
export function geminiTextSse(text: string): Response {
  const chunk = { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

/** The same text as a Gemini answer: SSE for `:streamGenerateContent`, one JSON object for `:generateContent`. */
export function geminiTextResponse(text: string, stream: boolean): Response {
  if (stream) return geminiTextSse(text);
  return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Number of model turns in the history that the gate wrote earlier. */
export function countGateAnswers(body: Record<string, unknown>): number {
  const contents = Array.isArray(body.contents) ? body.contents : [];
  let count = 0;
  for (const turn of contents as Array<{ role?: unknown; parts?: unknown }>) {
    if (turn?.role !== "model" || !Array.isArray(turn.parts)) continue;
    const first = turn.parts[0] as { text?: unknown } | undefined;
    if (typeof first?.text === "string" && first.text.startsWith(GATE_TEXT_MARKER)) count++;
  }
  return count;
}

/** Decide what to do with one antigravity request. Never throws: a failed report lookup lets the request through. */
export async function runAntigravityHookGate(params: AntigravityGateParams): Promise<AntigravityGateResult> {
  if (!isGateEnabled(params.config)) return { action: "pass", reason: "disabled" };
  if (!params.stream) return { action: "pass", reason: "non-interactive" };
  const sessionId = params.sessionId;
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return { action: "pass", reason: "no-session-id" };

  const key: SessionWorkspaceKey = {
    spaceId: params.spaceId,
    userId: params.userId || "anonymous",
    agentSource: REPORT_AGENT_SOURCE,
    sessionId,
  };
  const attempts = countGateAnswers(params.body);
  if (attempts >= MAX_FAILED_ATTEMPTS) return { action: "pass", reason: "retry-limit" };

  if (attempts === 0) {
    const known = await lookupReport(params.config, key);
    if (known === "installed") return { action: "pass", reason: "installed" };
    if (known === "unavailable") return { action: "pass", reason: "lookup-failed" };
  } else if (await waitForReport(params.config, key, params.waitMs)) {
    return { action: "pass", reason: "installed-in-session" };
  }

  // `--base-url` pins the installer to the proxy that served it, as for the other gated clients.
  const origin = resolveOrigin(params.config, params.origin);
  const base = buildInstallCommand(origin, sessionId, "antigravity");
  const command = base ? `${base} --base-url ${origin}` : null;
  const text = attempts === 0 ? manualInstallText(command) : installNotDoneText(command, false);
  return {
    action: "respond",
    response: geminiTextSse(`${GATE_TEXT_MARKER} ${text}`),
    reason: attempts === 0 ? "install-requested" : "install-failed",
  };
}
