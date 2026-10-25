/**
 * Mandatory project hook for interactive oh-my-pi (omp) sessions.
 *
 * omp talks to the proxy on the omp route in three formats:
 * `/omp/<space>/v1/messages` (anthropic-messages), `/v1/responses`
 * (openai-responses) and `/v1/chat/completions` (openai-completions); the `/v1`
 * part is optional. The proxy learns the project of a session only from the
 * client hook report (see project-scope/session-workspace.ts and
 * session/hook-gate-core.ts). An omp terminal session without a report gets no
 * model answer. The proxy answers with a shell tool call that runs the
 * installer with `--client omp --session <id> --base-url <origin>`. omp runs it
 * at once (its default approval mode asks nothing), and the installer sends one
 * report. There is no form.
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
 * Which requests are gated (captured with omp 18.6.3, see wire-formats.ts)
 * ------------------------------------------------------------------------
 *   tools        `-p`, rpc and SDK runs do not offer the ask tool. Only the
 *                terminal does, so the gate needs the ask tool and the shell
 *                tool: `_ask` and `_bash` in the Anthropic format (omp prefixes
 *                its tool names there), `ask` and `bash` in the other two. No
 *                header tells the terminal from `-p`; the user agent is
 *                `claude-cli/...` (Anthropic) or `omp/...` and is not read.
 *   session id   Anthropic: header `x-claude-code-session-id`. Responses and
 *                chat: omp sends no session header to a custom provider; with
 *                `compat.supportsPromptCacheKey: true` it sends the body field
 *                `prompt_cache_key`. Both equal the id its extension reports.
 *                The caller resolves the id. Without one the gate does not run.
 *   title call   The terminal sends a title request without any tools. It has
 *                no ask tool, so it is not gated.
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
  OMP_FORMATS,
  OMP_GATE_CALL_PREFIX,
  ompFormatOf,
  type OmpEvent,
  type OmpFormat,
} from "./wire-formats.js";
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

export { OMP_GATE_CALL_PREFIX };

/** The hook report route keys reports by the first route segment. */
const REPORT_AGENT_SOURCE = "omp";
const INTENT = "Install the Agent-Memory project hook";

// ── Public API ─────────────────────────────────────────────────────────────────

export interface OmpGateParams {
  config: GateConfig;
  /** Request path, for example `/omp/default/v1/responses`. It selects the wire format. */
  path: string;
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
  const format = ompFormatOf(params.path);
  const pass = (reason: string): OmpGateResult => ({ action: "pass", body: stripOmpGateTurns(body, format ?? undefined), reason });

  if (!isGateEnabled(params.config)) return pass("disabled");
  if (!format) return pass("other-route");
  const rules = OMP_FORMATS[format];
  if (body.stream !== true || !(offersTool(body, rules.askTool) && offersTool(body, rules.shellTool))) return pass("non-interactive");

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

  // `--base-url` pins the installer to the proxy that served it, so it never rewrites another origin in models.yml.
  const origin = resolveOrigin(params.config, params.origin);
  const base = buildInstallCommand(origin, sessionId, "omp");
  const command = base ? `${base} --base-url ${origin}` : null;
  const text = (t: string, reason: string): OmpGateResult => ({
    action: "respond",
    response: rules.text(params.modelId, `${GATE_TEXT_MARKER} ${t}`),
    reason,
  });

  const history = readOmpHistory(rules.events(body));
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
        response: rules.installCall(params.modelId, command),
        reason: "install-requested",
      };
    }
  }
}

// ── Request inspection ─────────────────────────────────────────────────────────

/** True when the request offers a tool of this name. Chat Completions nests the name under `function`; the other formats keep it on the tool. */
function offersTool(body: Record<string, unknown>, name: string): boolean {
  if (!Array.isArray(body.tools)) return false;
  return (body.tools as Array<{ name?: unknown; function?: { name?: unknown } }>).some(
    (t) => (t?.function?.name ?? t?.name) === name,
  );
}

// ── Conversation state ─────────────────────────────────────────────────────────

function readOmpHistory(events: OmpEvent[]): GateHistory {
  const history: GateHistory = { attempts: 0, resultIsLast: false, lastResult: null, lastAnswered: false };
  let lastCallId: string | undefined;
  for (const e of events) {
    for (const id of e.callIds) {
      history.attempts++;
      lastCallId = id;
    }
  }
  if (!lastCallId) return history;
  const resultIndex = events.findIndex((e) => e.resultIds.includes(lastCallId as string));
  if (resultIndex < 0) return history;
  history.lastResult = events[resultIndex].resultText;
  const after = events.slice(resultIndex + 1);
  // omp may add a trailing system message. The conversation ends at the last user, assistant or tool message.
  history.resultIsLast = after.every((e) => e.role === "other");
  history.lastAnswered = after.some((e) => e.gateText);
  return history;
}

// ── History cleaning ───────────────────────────────────────────────────────────

/**
 * Remove every turn the gate made up: the assistant message with the install
 * call, the message that answers it, and the text answers. Returns the same
 * object when nothing needs removal. The format defaults to chat completions.
 */
export function stripOmpGateTurns(body: Record<string, unknown>, format: OmpFormat = "openai-completions"): Record<string, unknown> {
  return OMP_FORMATS[format].strip(body);
}
