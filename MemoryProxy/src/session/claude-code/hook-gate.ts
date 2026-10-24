/**
 * Mandatory project hook for interactive Claude Code sessions.
 *
 * The proxy cannot see the client file system. It learns the project of a
 * session only from the client hook report (see project-scope/session-workspace.ts).
 * This gate asks the user, once per session, to install the hook on a machine
 * that has not installed it:
 *
 *   1. No hook report for the session: answer with an `AskUserQuestion` form
 *      ("Install now" / "Exit"). The request does not reach the model.
 *   2. "Install now": answer with a `Bash` tool call that runs the installer
 *      with `--session <id>`. The installer sends one report at once.
 *   3. The tool result comes back: read the report again (wait a short time).
 *      If it exists, remove the synthetic turns from the conversation and let
 *      the original prompt through. If not, answer with the error and the
 *      manual command.
 *   4. "Exit": every request of the session gets a fixed text answer.
 *
 * The state is the conversation itself. Claude Code replays every synthetic
 * turn in the next request, so the gate reads the form answer from the history
 * and needs no store of its own. A compaction that drops these turns makes the
 * gate ask again, which is the safe result.
 *
 * Which requests are gated
 * ------------------------
 * Only an interactive main-line request of Claude Code that can show a form, on
 * the route `/claude-code/<space>/v1/messages` (the route that has a matching
 * hook report route). Headless runs (`claude -p`, the SDK, CI) pass unchanged:
 * they have no project, which already means no project skills and no project
 * memory. The gate fails open: it is a setup aid, not a security control.
 *
 * Every pass removes the synthetic gate turns from the history first, so that a
 * fork, a resumed `-p` run, or a proxy with the gate switched off never sends
 * the placeholder thinking signature or the made-up tool calls to the model.
 *
 * Headless detection, captured with Claude Code 2.1.289 on a local capture
 * server (same prompt, same settings, one run per mode):
 *
 *   mode          User-Agent entrypoint   tools   AskUserQuestion   stream
 *   claude -p     (external, sdk-cli)     21      absent            true
 *   interactive   (external, cli)         24      present           true
 *
 * `x-app` is `cli` in both modes, so it is no signal. The entrypoint in the
 * User-Agent comes from the environment variable CLAUDE_CODE_ENTRYPOINT, so an
 * interactive session started from inside another Claude Code session also
 * reports `sdk-cli`. The User-Agent is therefore only supporting evidence. The
 * gate relies on the tool list: the form is an `AskUserQuestion` tool call, and
 * a client that does not offer that tool cannot show it. Title generation and
 * the model probe have no tools at all, so they are never gated, even when
 * request routing is off.
 *
 * The Agent SDK does offer `AskUserQuestion` (captured with
 * @anthropic-ai/claude-agent-sdk 0.2.117 `query()`, Claude Code 2.1.117):
 *
 *   mode           User-Agent entrypoint   tools   AskUserQuestion   stream
 *   SDK query()    (external, sdk-ts)      23      present           true
 *
 * so the tool list alone cannot tell an SDK host from a person. Two rules cover
 * this. First, a User-Agent entrypoint that starts with `sdk` always passes (the
 * entrypoint is never a reason to gate, only a reason to pass). Second, a retry
 * limit that does not depend on any detection: when the form result in the
 * history was an error or text the gate cannot read, twice, the gate stops
 * asking in that conversation. A host that denies the form on its own therefore
 * cannot loop.
 */

import { isSubagentRequest } from "../../session-trace/subagent.js";
import { getSessionWorkspaceStore, type SessionWorkspaceKey } from "../../project-scope/session-workspace.js";
import type { ProxyConfig } from "../../types.js";
import { extractAnswerFromJson } from "./extractor.js";
import {
  buildSyntheticAssistantSse,
  buildToolUseResponse,
  THINKING_SIGNATURE_PLACEHOLDER,
  type SyntheticBlock,
} from "./form.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const GATE_FORM_PREFIX = "toolu_cc_hook_gate_form_";
export const GATE_INSTALL_PREFIX = "toolu_cc_hook_gate_install_";
const GATE_PREFIX = "toolu_cc_hook_gate_";

/** First characters of every synthetic text answer, so later requests can remove it from the history. */
export const GATE_TEXT_MARKER = "[Agent-Memory hook gate]";

export const INSTALL_LABEL = "Install now";
export const EXIT_LABEL = "Exit";

const FORM_TOOL = "AskUserQuestion";
const BASH_TOOL = "Bash";
const SESSION_HEADER = "x-claude-code-session-id";
/** Unreadable form results (errors, free text) after which the gate stops asking. */
const MAX_UNREADABLE_ANSWERS = 2;
/** Route of the Claude Code messages API that has a hook report route beside it. */
const GATED_PATH_RE = /^\/claude-code\/[^/]+\/v1\/messages\/?$/;
const ORIGIN_RE = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/;
/** How long a "report present" lookup is trusted. A missing report is never cached. */
const INSTALLED_CACHE_MS = 60_000;
const DEFAULT_WAIT_MS = 3000;
const POLL_MS = 250;

/** Same limits as the hook report route, so the id can go into a shell command. */
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const HOST_RE = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/;

// ── Public API ─────────────────────────────────────────────────────────────────

export interface HookGateParams {
  config: { hookGate?: Partial<NonNullable<ProxyConfig["hookGate"]>>; storage?: ProxyConfig["storage"] };
  agentSource: string;
  /** True for a main-line request on a non-legacy route. */
  memoryTurn: boolean;
  /** Request path, for example `/claude-code/default/v1/messages`. */
  path: string;
  /** Lower-cased request header names. */
  headers: Record<string, string>;
  body: Record<string, unknown>;
  spaceId: string;
  /** The user id that the hook report route stores under: the verified id, or "anonymous". */
  userId: string;
  modelId: string;
  /** Proxy origin as the client reaches it, for example `https://proxy.example.com`. Null when unknown. */
  origin: string | null;
  /** How long to wait for the report after the installer ran. Default 3000. */
  waitMs?: number;
}

export type HookGateResult =
  /** Forward the request. `body` has the synthetic turns removed. */
  | { action: "pass"; body: Record<string, unknown>; reason: string }
  /** Answer the client with `response`. Nothing goes upstream and nothing is stored. */
  | { action: "respond"; response: Response; reason: string };

/** Decide what to do with one request. Never throws: a failed report lookup lets the request through. */
export async function runHookGate(params: HookGateParams): Promise<HookGateResult> {
  const { body } = params;
  // Other clients never receive gate turns, so their body stays untouched.
  if (params.agentSource !== "claude-code") return { action: "pass", body, reason: "not-claude-code" };
  const pass = (reason: string): HookGateResult => ({ action: "pass", body: stripGateTurns(body), reason });

  if (params.config.hookGate?.enabled === false) return pass("disabled");
  if (!params.memoryTurn) return pass("not-main-line");
  if (!GATED_PATH_RE.test(params.path)) return pass("other-route");
  if (isSubagentRequest("claude-code", params.headers, body)) return pass("subagent");

  const sessionId = params.headers[SESSION_HEADER];
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return pass("no-session-id");
  if (isSdkEntrypoint(params.headers["user-agent"])) return pass("sdk");
  if (!isInteractive(body)) return pass("non-interactive");

  const key: SessionWorkspaceKey = {
    spaceId: params.spaceId,
    userId: params.userId || "anonymous",
    agentSource: params.agentSource,
    sessionId,
  };
  const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];

  const known = await lookupReport(params, key);
  if (known === "installed") return pass("installed");
  if (known === "unavailable") return pass("lookup-failed");

  const command = buildInstallCommand(resolveOrigin(params), sessionId);
  const state = readGateState(messages);
  if (state.unreadable >= MAX_UNREADABLE_ANSWERS) return pass("retry-limit");
  const reply = (blocks: SyntheticBlock[], reason: string): HookGateResult => ({
    action: "respond",
    response: buildSyntheticAssistantSse(params.modelId, blocks, "msg_cc_hook_gate_"),
    reason,
  });
  const text = (t: string, reason: string) => reply([{ type: "text", text: `${GATE_TEXT_MARKER} ${t}` }], reason);

  if (state.exited) return text(exitText(command), "exited");

  if (state.pending === "install") {
    const waited = await waitForReport(params, key);
    if (waited) return pass("installed-in-session");
    return text(installFailedText(command), "install-failed");
  }

  const canRunBash = offersTool(body, BASH_TOOL);
  if (!canRunBash || !command) return text(manualInstallText(command), "no-bash");

  if (state.pending === "form") {
    if (state.answer === INSTALL_LABEL) {
      return {
        action: "respond",
        response: buildToolUseResponse(
          BASH_TOOL,
          { command, description: "Install the Agent-Memory project hook" },
          GATE_INSTALL_PREFIX,
          params.modelId,
        ),
        reason: "install-requested",
      };
    }
    if (state.answer === EXIT_LABEL) return text(exitText(command), "exit-chosen");
    return formResponse(params.modelId, true, "form-retry");
  }

  return formResponse(params.modelId, false, "form");
}

// ── Detection helpers ──────────────────────────────────────────────────────────

function toolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return [];
  return body.tools
    .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === "string");
}

function offersTool(body: Record<string, unknown>, name: string): boolean {
  return toolNames(body).includes(name);
}

/** True when the User-Agent entrypoint is an SDK value such as `sdk-ts`, `sdk-py` or `sdk-cli`. */
function isSdkEntrypoint(userAgent: string | undefined): boolean {
  const entrypoint = /\(\s*[^,)]*,\s*([^,)\s]+)/.exec(userAgent ?? "")?.[1];
  return entrypoint !== undefined && /^sdk/i.test(entrypoint);
}

/** A streaming request that offers the form tool. See the file header for the evidence. */
function isInteractive(body: Record<string, unknown>): boolean {
  return body.stream === true && offersTool(body, FORM_TOOL);
}

const installedCache = new Map<string, number>();
/** Upper bound on cached answers, so entries of ended sessions cannot grow memory without limit. */
const INSTALLED_CACHE_MAX = 10_000;

/** Forget every cached "report present" answer (tests). */
export function resetHookGateCache(): void {
  installedCache.clear();
}

async function lookupReport(params: HookGateParams, key: SessionWorkspaceKey): Promise<"installed" | "missing" | "unavailable"> {
  const cacheKey = `${key.spaceId}|${key.userId}|${key.agentSource}|${key.sessionId}`;
  const now = Date.now();
  const until = installedCache.get(cacheKey);
  if (until !== undefined) {
    if (until > now) return "installed";
    installedCache.delete(cacheKey);
  }
  try {
    const store = await getSessionWorkspaceStore(params.config);
    // A report without a project (folder outside git) still counts as installed.
    if (!(await store.get(key))) return "missing";
    installedCache.set(cacheKey, now + INSTALLED_CACHE_MS);
    if (installedCache.size > INSTALLED_CACHE_MAX) installedCache.delete(installedCache.keys().next().value as string);
    return "installed";
  } catch (err) {
    console.warn(
      `[hook-gate] report lookup failed session=${key.sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return "unavailable";
  }
}

async function waitForReport(params: HookGateParams, key: SessionWorkspaceKey): Promise<boolean> {
  const deadline = Date.now() + (params.waitMs ?? DEFAULT_WAIT_MS);
  for (;;) {
    const found = await lookupReport(params, key);
    if (found !== "missing") return true; // "unavailable" lets the request through, as at the first lookup
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// ── Conversation state ─────────────────────────────────────────────────────────

interface GateState {
  /** The form answer was "Exit" at some point in the history. */
  exited: boolean;
  /** What the last message answers: a form, an install tool call, or neither. */
  pending: "form" | "install" | null;
  /** The recognised answer label of the last form, or null when it was not one of ours. */
  answer: string | null;
  /** Form results in the history that were errors or text the gate cannot read. */
  unreadable: number;
}

interface RawBlock {
  type?: unknown;
  id?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  text?: unknown;
}

function blocksOf(message: unknown): RawBlock[] {
  const content = (message as { content?: unknown } | null)?.content;
  return Array.isArray(content) ? (content as RawBlock[]) : [];
}

function roleOf(message: unknown): string {
  return String((message as { role?: unknown } | null)?.role ?? "");
}

function toolResultText(block: RawBlock): string {
  const c = block.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return (c as RawBlock[])
    .map((x) => (x?.type === "text" && typeof x.text === "string" ? x.text : ""))
    .join("\n");
}

function recognisedAnswer(text: string): string | null {
  const answer = extractAnswerFromJson(text)?.trim();
  return answer === INSTALL_LABEL || answer === EXIT_LABEL ? answer : null;
}

function readGateState(messages: unknown[]): GateState {
  const state: GateState = { exited: false, pending: null, answer: null, unreadable: 0 };
  // Claude Code adds trailing `system` messages (for example the token budget
  // reminder). The conversation ends at the last user or assistant message.
  let lastTurn = -1;
  messages.forEach((message, index) => {
    const role = roleOf(message);
    if (role === "user" || role === "assistant") lastTurn = index;
  });
  messages.forEach((message, index) => {
    if (roleOf(message) !== "user") return;
    const isLast = index === lastTurn;
    for (const block of blocksOf(message)) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      if (block.tool_use_id.startsWith(GATE_FORM_PREFIX)) {
        const answer = recognisedAnswer(toolResultText(block));
        if (answer === EXIT_LABEL) state.exited = true;
        if (answer === null) state.unreadable++;
        if (isLast) {
          state.pending = "form";
          state.answer = answer;
        }
      } else if (isLast && block.tool_use_id.startsWith(GATE_INSTALL_PREFIX)) {
        state.pending = "install";
      }
    }
  });
  return state;
}

// ── History cleaning ───────────────────────────────────────────────────────────

function isGateAssistant(message: unknown): boolean {
  if (roleOf(message) !== "assistant") return false;
  const blocks = blocksOf(message);
  if (blocks.some((b) => b.type === "tool_use" && typeof b.id === "string" && b.id.startsWith(GATE_PREFIX))) return true;
  // A text answer of the gate has the marker and the placeholder thinking
  // signature that only the gate writes. A model reply that quotes the marker
  // has neither a placeholder signature nor a gate tool id.
  const first = blocks.find((b) => b.type === "text");
  const hasGateSignature = blocks.some(
    (b) => b.type === "thinking" && (b as { signature?: unknown }).signature === THINKING_SIGNATURE_PLACEHOLDER,
  );
  return hasGateSignature && typeof first?.text === "string" && first.text.startsWith(GATE_TEXT_MARKER);
}

/**
 * Remove every turn the gate made up (form, install call, text answers and the
 * tool results that answer them), so the model sees the original conversation.
 * Returns the same object when nothing needs removal.
 */
export function stripGateTurns(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const kept: unknown[] = [];
  for (const message of body.messages as unknown[]) {
    if (isGateAssistant(message)) {
      changed = true;
      continue;
    }
    if (roleOf(message) === "user") {
      const blocks = blocksOf(message);
      const isGateResult = (b: RawBlock) =>
        b.type === "tool_result" && typeof b.tool_use_id === "string" && b.tool_use_id.startsWith(GATE_PREFIX);
      if (blocks.some(isGateResult)) {
        changed = true;
        const rest = blocks.filter((b) => !isGateResult(b));
        if (rest.length > 0) kept.push({ ...(message as object), content: rest });
        continue;
      }
    }
    kept.push(message);
  }
  return changed ? { ...body, messages: kept } : body;
}

// ── Responses ──────────────────────────────────────────────────────────────────

function formResponse(modelId: string, retry: boolean, reason: string): HookGateResult {
  const prefix = retry ? "Could not read the answer. " : "";
  const input = {
    questions: [
      {
        question:
          `${prefix}Agent-Memory needs a small hook on this machine to know which project this session belongs to. ` +
          "Install it now? Claude Code asks you to approve one shell command. Custom text is not supported.",
        header: "Hook",
        options: [
          { label: INSTALL_LABEL, description: "Run the installer in this session, then answer your prompt" },
          { label: EXIT_LABEL, description: "Stop here. This session gets no model answer until the hook is installed" },
        ],
        multiSelect: false,
      },
    ],
  };
  return {
    action: "respond",
    response: buildToolUseResponse(FORM_TOOL, input, GATE_FORM_PREFIX, modelId),
    reason,
  };
}

function exitText(command: string | null): string {
  return (
    "The Agent-Memory project hook is not installed on this machine, so this session does not send requests to the model. " +
    "Install the hook with the command below, in a terminal or here by typing ! before it. " +
    "When the proxy has the report, send your prompt again: this session continues." +
    commandBlock(command)
  );
}

function installFailedText(command: string | null): string {
  return (
    "The installer did not finish: the proxy has no hook report for this session yet. " +
    "The command may have been blocked (for example by auto mode) or it failed (the installer needs curl and one of jq, python3 or node). " +
    "Run the command yourself, either in a terminal or here by typing ! before it, then send your prompt again." +
    commandBlock(command)
  );
}

function manualInstallText(command: string | null): string {
  return (
    "The Agent-Memory project hook is not installed on this machine, and this session cannot run the installer for you. " +
    "Run the command in a terminal, then send your prompt again." +
    (command ? commandBlock(command) : "\n\nAsk your Agent-Memory administrator for the installer command.")
  );
}

function commandBlock(command: string | null): string {
  return command ? `\n\n    ${command}` : "";
}

// ── Install command ────────────────────────────────────────────────────────────

let warnedBadOrigin = false;

/** The configured public origin when it is valid, else the origin derived from the request. */
function resolveOrigin(params: HookGateParams): string | null {
  const configured = params.config.hookGate?.publicOrigin?.trim().replace(/\/+$/, "");
  if (configured && ORIGIN_RE.test(configured)) return configured;
  if (configured && !warnedBadOrigin) {
    warnedBadOrigin = true;
    console.warn("[hook-gate] hookGate.publicOrigin is not a valid http(s) origin; using the request origin");
  }
  return params.origin;
}

/**
 * Proxy origin as the client reached it, from the forwarded headers, else from
 * the request URL. Returns null when the value could carry shell syntax: the
 * origin goes into a command that the client runs.
 */
export function resolveProxyOrigin(headers: Record<string, string>, requestUrl: string): string | null {
  const first = (v: string | undefined) => v?.split(",")[0]?.trim() || undefined;
  let proto = first(headers["x-forwarded-proto"]);
  let host = first(headers["x-forwarded-host"]) ?? first(headers["host"]);
  if (!proto || !host) {
    try {
      const u = new URL(requestUrl);
      proto = proto ?? u.protocol.replace(/:$/, "");
      host = host ?? u.host;
    } catch {
      return null;
    }
  }
  if ((proto !== "http" && proto !== "https") || !HOST_RE.test(host)) return null;
  return `${proto}://${host}`;
}

/** The installer command, or null when the origin or the session id is not safe to put in a shell command. */
export function buildInstallCommand(origin: string | null, sessionId: string): string | null {
  if (!origin || !SESSION_ID_RE.test(sessionId)) return null;
  return `curl -fsSL ${origin}/setup/hooks.sh | bash -s -- --client claude-code --session ${sessionId}`;
}
