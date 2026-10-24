/**
 * User-global persona scope check.
 *
 * The proxy injects an agent's L3 into every session of that agent, in every
 * project. So the L3 must hold only facts that are true outside any project.
 * The persona generator marks the first line of persona.md with the result of
 * this check, and the proxy injects only an L3 with the accepted marker
 * (MemoryProxy `USER_GLOBAL_SCOPE_MARKER`; the strings must stay equal).
 *
 * States of persona.md:
 *   - accepted marker: passed both checks; the proxy injects it.
 *   - rejected marker: the checks found project facts twice; the proxy does not
 *     inject it, and the next regeneration waits for the normal trigger. A judge
 *     that fails for a technical reason never produces this marker.
 *   - no marker: written before this check existed; it is regenerated from all
 *     scenes as soon as the L3 trigger runs.
 *
 * Two checks, both fail closed:
 *   1. findStructuralLeaks: deterministic patterns (paths, hosts, file names,
 *      versions, code spans, identifiers).
 *   2. An LLM judge that also sees the scene index, so it can find project,
 *      product and tool names that no pattern can recognize.
 */

import { createHash } from "node:crypto";

import { buildTraceParams, type LLMRunner, type LlmCallHints, type Logger } from "../types.js";
import { classifyLlmError, classifyLlmReply, type LlmErrorKind } from "../report/llm-error-classifier.js";

export const USER_GLOBAL_SCOPE_MARKER = "<!-- agent-memory:scope=user-global v1 -->";
export const USER_GLOBAL_REJECTED_MARKER = "<!-- agent-memory:scope=user-global-rejected v1 -->";

export type UserGlobalScopeState = "accepted" | "rejected" | "none";

/** Scope state recorded on the first line of a persona. */
export function readScopeState(content: string): UserGlobalScopeState {
  const head = content.trimStart();
  if (head.startsWith(USER_GLOBAL_SCOPE_MARKER)) return "accepted";
  if (head.startsWith(USER_GLOBAL_REJECTED_MARKER)) return "rejected";
  return "none";
}

/**
 * Remove every scope marker, wherever the model or an older run put it. A line
 * that holds only markers is dropped. A marker that shares a line with text is
 * cut out and the text stays.
 */
export function stripScopeMarkers(content: string): string {
  const lines: string[] = [];
  for (const line of content.split("\n")) {
    const stripped = line.split(USER_GLOBAL_SCOPE_MARKER).join("").split(USER_GLOBAL_REJECTED_MARKER).join("");
    if (stripped === line) {
      lines.push(line);
    } else if (stripped.trim() !== "") {
      // The marker stood in front of the text: do not leave its spacing behind.
      lines.push(stripped.replace(/^[ \t]+/, ""));
    }
  }
  return lines.join("\n").trim();
}

const STRUCTURAL_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "path", re: /(?:~\/|\/(?:Users|home|opt|var|tmp|data|etc|private)\/|\b[A-Za-z]:\\)[^\s)`'"]*/g },
  { label: "url", re: /\bhttps?:\/\/[^\s)`'"]+/g },
  { label: "git-host", re: /\b(?:github|gitlab|bitbucket)(?:\.com)?\b|\bgit@[^\s]+/gi },
  {
    label: "file",
    re: /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|sh|json|ya?ml|toml|md|sql|env|lock|html|css|vue)\b/g,
  },
  // "v1.2" or "1.2.3". A bare "3.1" is a template section number and "2.000" is
  // a Vietnamese thousands separator, so two-part numbers are left to the judge.
  { label: "version", re: /\bv\d+(?:\.\d+)+\b|\b\d+\.\d+\.\d+(?:\.\d+)*\b/g },
  { label: "dimensions", re: /\b\d{2,5}\s*[×x]\s*\d{2,5}\b/g },
  { label: "code-span", re: /`[^`\n]+`/g },
  { label: "camel-case", re: /\b(?:[a-z]+[A-Z]|[A-Z][a-z]+[A-Z])[A-Za-z0-9]*\b/g },
  { label: "hyphen-name", re: /\b[A-Z][A-Za-z0-9]*-[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*\b/g },
];

/**
 * Deterministic project-fact patterns found in a persona body. Returns the
 * distinct matched strings; an empty array means no pattern matched.
 */
export function findStructuralLeaks(text: string): string[] {
  const found = new Set<string>();
  for (const { re } of STRUCTURAL_PATTERNS) {
    for (const m of text.matchAll(re)) found.add(m[0].trim());
  }
  return [...found].filter(Boolean);
}

export interface SceneIndexHint {
  filename: string;
  summary?: string;
}

const JUDGE_SYSTEM_PROMPT = `You check a user profile for project-specific content.
The profile is shown to an AI assistant in every working directory and every project of this user.
It may only contain facts that are true outside any single project: communication style, working
principles, decision logic, stable preferences, boundaries.

A leak is any text in the profile that names or describes:
- a project, product, repository, codebase, app, service, website or company product;
- a tool, library, framework, platform, programming language or model by name;
- a file, directory, command, version, resolution or other concrete technical value;
- a current task, current status, recent event, plan, phase or deadline;
- a subscription, account or purchase.

The scene index below lists the topics this user worked on. Names that appear there are project
names. Generic words (for example "evidence", "tests", "review", "deploy", "video") are not leaks
unless they name one specific project or product.

Reply with JSON only, no prose: {"leaks": ["<exact substring from the profile>", ...]}
Reply {"leaks": []} when there is no leak.`;

/** Build the judge prompt. Exposed for tests. */
export function buildScopeJudgePrompt(persona: string, sceneIndex: SceneIndexHint[]): { systemPrompt: string; prompt: string } {
  const index = sceneIndex.length > 0
    ? sceneIndex.map((e) => `- ${e.filename}${e.summary ? ` — ${e.summary}` : ""}`).join("\n")
    : "(empty)";
  return {
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    prompt: `## Scene index\n${index}\n\n## Profile\n\`\`\`markdown\n${persona}\n\`\`\``,
  };
}

/**
 * Parse the judge reply. Returns the leak list, or null when the reply is not
 * the expected JSON (the caller treats null as a failed check).
 */
export function parseJudgeLeaks(output: string): string[] | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as { leaks?: unknown };
    if (!Array.isArray(parsed.leaks)) return null;
    return parsed.leaks.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  } catch {
    return null;
  }
}

export interface ScopeCheckResult {
  ok: boolean;
  /** Strings that must be removed; empty when ok, or when the judge failed. */
  leaks: string[];
  /** Why the check failed; undefined when ok. */
  reason?: ScopeCheckFailureReason;
  /** Specific cause when the judge call failed. */
  errorKind?: LlmErrorKind;
  /** Ids of the LLM call log records of the judge call; empty when it was not stored or not made. */
  callIds?: string[];
}

export type ScopeCheckFailureReason =
  | "structural"
  | "judge-leaks"
  | "judge-unparseable"
  | "judge-error"
  | "judge-timeout";

/**
 * True when the judge could not give a verdict (error, timeout, unusable
 * reply). Such a result says nothing about the persona, so it must not be
 * turned into a rejection.
 */
export function isTechnicalScopeFailure(result: Pick<ScopeCheckResult, "ok" | "reason">): boolean {
  return !result.ok && (
    result.reason === "judge-unparseable" ||
    result.reason === "judge-error" ||
    result.reason === "judge-timeout"
  );
}

/** Who a judge call is recorded for. */
export interface ScopeJudgeContext {
  instanceId?: string;
  teamId?: string;
  agentId?: string;
  userId?: string;
  sessionId?: string;
  /** Empty or absent for the user-global persona. */
  projectHash?: string;
  /** Id of the L3 generation run, shared with its generation log. */
  generationId?: string;
  model?: string;
}

const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Run both checks on a persona body (marker and scene navigation already
 * removed). The structural check runs first, so a cheap failure skips the LLM.
 *
 * The judge is called once. A call that fails (error, timeout, reply that is
 * not the expected JSON) is reported as a technical failure with its specific
 * kind; it is never turned into a leak finding and never retried here. The
 * call is stored by the LLM call log (success and failure alike) through the
 * hints below; this function writes no record itself.
 */
export async function checkUserGlobalPersona(opts: {
  persona: string;
  sceneIndex: SceneIndexHint[];
  judge: LLMRunner;
  timeoutMs?: number;
  context?: ScopeJudgeContext;
  logger?: Logger;
}): Promise<ScopeCheckResult> {
  const structural = findStructuralLeaks(opts.persona);
  if (structural.length > 0) return { ok: false, leaks: structural, reason: "structural" };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
  const ctx = opts.context ?? {};
  const { systemPrompt, prompt } = buildScopeJudgePrompt(opts.persona, opts.sceneIndex);
  const traceParams = buildTraceParams("memory.persona-scope-check", {
    teamId: ctx.teamId, userId: ctx.userId, agentId: ctx.agentId, sessionId: ctx.sessionId,
  });
  const tags = [...(traceParams.tags ?? []), ctx.projectHash ? `project:${ctx.projectHash}` : "scope:user-global"];
  const callIds: string[] = [];
  const startedMs = Date.now();
  let output: string;
  let leaks: string[] | null;
  const llmCall: LlmCallHints = {
    generationId: ctx.generationId,
    projectHash: ctx.projectHash,
    teamId: ctx.teamId,
    agentId: ctx.agentId,
    recordSuccess: true,
    annotate: (reply) => {
      const parsed = parseJudgeLeaks(reply);
      const unusable = classifyLlmReply(reply, parsed !== null);
      return {
        ...(unusable ? { errorKind: unusable } : {}),
        verdict: {
          outcome: parsed === null ? "unparseable" : parsed.length > 0 ? "leaks" : "pass",
          leaks: parsed ?? [],
          persona_sha256: sha256Hex(opts.persona),
          persona_chars: opts.persona.length,
          scene_index_count: opts.sceneIndex.length,
        },
      };
    },
    onRecorded: (id) => callIds.push(id),
  };
  try {
    output = await opts.judge.run({
      systemPrompt,
      prompt,
      taskId: "persona-scope-check",
      timeoutMs,
      ...traceParams,
      tags,
      ...(ctx.instanceId ? { instanceId: ctx.instanceId } : {}),
      llmCall,
    });
    leaks = parseJudgeLeaks(output);
  } catch (err) {
    const failure = classifyLlmError(err, Date.now() - startedMs, timeoutMs);
    opts.logger?.warn(
      `[memory-tdai] [persona] scope judge call failed (kind=${failure.kind}, http=${failure.httpStatus || "-"}` +
      `${failure.message ? `, ${failure.message.slice(0, 200)}` : ""})`,
    );
    return {
      ok: false, leaks: [], callIds, errorKind: failure.kind,
      reason: failure.kind === "timeout" ? "judge-timeout" : "judge-error",
    };
  }
  if (leaks === null) {
    const kind = classifyLlmReply(output, false) ?? "unparseable";
    opts.logger?.warn(`[memory-tdai] [persona] scope judge reply is not usable (kind=${kind})`);
    return { ok: false, leaks: [], callIds, errorKind: kind, reason: "judge-unparseable" };
  }
  if (leaks.length > 0) return { ok: false, leaks, reason: "judge-leaks", callIds };
  return { ok: true, leaks: [], callIds };
}
