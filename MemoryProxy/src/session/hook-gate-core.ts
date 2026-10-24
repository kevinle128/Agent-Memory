/**
 * Shared parts of the mandatory project hook gate.
 *
 * The proxy cannot see the client file system. It learns the project of a
 * session only from the client hook report (see project-scope/session-workspace.ts).
 * Every interactive client that the gate covers (Claude Code, Codex, oh-my-pi)
 * needs the same four things, and they live here:
 *
 *   - the report lookup, with a short cache and a short wait after the installer ran;
 *   - the install command, with the client name and the session id;
 *   - the retry limit and the choice of the next step, read from the conversation;
 *   - the plain text answers for a failed or rejected install.
 *
 * What differs per client is the wire format: which requests are gated, how the
 * synthetic tool call looks, and how it is found again in the history. Each
 * client has its own module for that.
 *
 * The gate fails open. It is a setup aid, not a security control.
 */

import { getSessionWorkspaceStore, type SessionWorkspaceKey } from "../project-scope/session-workspace.js";
import type { ProxyConfig } from "../types.js";
import { SESSION_ID_RE } from "./session-id-pattern.js";

export { SESSION_ID_RE };

// ── Constants ──────────────────────────────────────────────────────────────────

/** First characters of every synthetic text answer, so later requests can remove it from the history. */
export const GATE_TEXT_MARKER = "[Agent-Memory hook gate]";

/** Failed install attempts in one conversation after which the gate stops asking. */
export const MAX_FAILED_ATTEMPTS = 2;

const HOST_RE = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/;
const ORIGIN_RE = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/;

/** How long a "report present" lookup is trusted. A missing report is never cached. */
const INSTALLED_CACHE_MS = 60_000;
/** Upper bound on cached answers, so entries of ended sessions cannot grow memory without limit. */
const INSTALLED_CACHE_MAX = 10_000;
export const DEFAULT_WAIT_MS = 3000;
const POLL_MS = 250;

export type GateClient = "claude-code" | "codex" | "omp";

export interface GateConfig {
  hookGate?: Partial<NonNullable<ProxyConfig["hookGate"]>>;
  storage?: ProxyConfig["storage"];
}

/** The one switch for all clients: `hookGate.enabled`, on unless it is set to false. */
export function isGateEnabled(config: GateConfig): boolean {
  return config.hookGate?.enabled !== false;
}

// ── Report lookup ──────────────────────────────────────────────────────────────

const installedCache = new Map<string, number>();

/** Forget every cached "report present" answer (tests). */
export function resetHookGateCache(): void {
  installedCache.clear();
}

export async function lookupReport(
  config: GateConfig,
  key: SessionWorkspaceKey,
): Promise<"installed" | "missing" | "unavailable"> {
  const cacheKey = `${key.spaceId}|${key.userId}|${key.agentSource}|${key.sessionId}`;
  const now = Date.now();
  const until = installedCache.get(cacheKey);
  if (until !== undefined) {
    if (until > now) return "installed";
    installedCache.delete(cacheKey);
  }
  try {
    const store = await getSessionWorkspaceStore(config);
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

/** True when the report exists after the wait, or when the lookup is unavailable (the request then passes). */
export async function waitForReport(config: GateConfig, key: SessionWorkspaceKey, waitMs = DEFAULT_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const found = await lookupReport(config, key);
    if (found !== "missing") return true; // "unavailable" lets the request through, as at the first lookup
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// ── Install command ────────────────────────────────────────────────────────────

let warnedBadOrigin = false;

/** The configured public origin when it is valid, else the origin derived from the request. */
export function resolveOrigin(config: GateConfig, requestOrigin: string | null): string | null {
  const configured = config.hookGate?.publicOrigin?.trim().replace(/\/+$/, "");
  if (configured && ORIGIN_RE.test(configured)) return configured;
  if (configured && !warnedBadOrigin) {
    warnedBadOrigin = true;
    console.warn("[hook-gate] hookGate.publicOrigin is not a valid http(s) origin; using the request origin");
  }
  return requestOrigin;
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
export function buildInstallCommand(origin: string | null, sessionId: string, client: GateClient = "claude-code"): string | null {
  if (!origin || !SESSION_ID_RE.test(sessionId)) return null;
  return `curl -fsSL ${origin}/setup/hooks.sh | bash -s -- --client ${client} --session ${sessionId}`;
}

// ── Conversation state ─────────────────────────────────────────────────────────

/** What the history of a conversation says about earlier install attempts of the gate. */
export interface GateHistory {
  /** Gate tool calls in the history. */
  attempts: number;
  /** The result of the latest gate call is the end of the conversation: no later user prompt follows it. */
  resultIsLast: boolean;
  /** Text of the result of the latest gate call. Null when the history has no result for it. */
  lastResult: string | null;
  /** The gate already answered the latest result with a text reply. */
  lastAnswered: boolean;
}

export type GateStep =
  /** Too many failed attempts: let the request through. */
  | "retry-limit"
  /** Answer with the install tool call. */
  | "call"
  /** The result of the install call just came back: check it and the report. */
  | "check-result"
  /** The user refused the install call earlier and the gate has not told them what to do: answer with text. */
  | "rejected";

const REJECTED_RE = /aborted by user|reject|denied|declined|not allowed|unsupported call|user (?:cancel|interrupt)/i;

/** True when a tool result says that the command did not run because it was refused. */
export function looksRejected(result: string): boolean {
  return REJECTED_RE.test(result);
}

export function planGateStep(h: GateHistory): GateStep {
  if (h.resultIsLast) return "check-result";
  if (h.attempts >= MAX_FAILED_ATTEMPTS) return "retry-limit";
  if (h.attempts > 0 && h.lastResult !== null && !h.lastAnswered && looksRejected(h.lastResult)) return "rejected";
  return "call";
}

// ── Text answers ───────────────────────────────────────────────────────────────

function commandBlock(command: string | null): string {
  return command ? `\n\n    ${command}` : "";
}

/** The session cannot run the installer (no shell tool, or no safe command). */
export function manualInstallText(command: string | null): string {
  return (
    "The Agent-Memory project hook is not installed on this machine, and this session cannot run the installer for you. " +
    "Run the command in a terminal, then send your prompt again." +
    (command ? commandBlock(command) : "\n\nAsk your Agent-Memory administrator for the installer command.")
  );
}

/** The install command was refused or did not leave a report. */
export function installNotDoneText(command: string | null, rejected: boolean): string {
  return (
    (rejected
      ? "The Agent-Memory project hook was not installed: the command was not approved. "
      : "The installer did not finish: the proxy has no hook report for this session yet. " +
        "The command may have been blocked or it failed (the installer needs curl and one of jq, python3 or node). ") +
    "Run the command in a terminal, then send your prompt again." +
    commandBlock(command)
  );
}
