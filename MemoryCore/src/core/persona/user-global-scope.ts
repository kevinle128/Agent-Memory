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
 *   - rejected marker: failed the checks; the proxy does not inject it, and
 *     the next regeneration waits for the normal trigger.
 *   - no marker: written before this check existed; it is regenerated from all
 *     scenes as soon as the L3 trigger runs.
 *
 * Two checks, both fail closed:
 *   1. findStructuralLeaks: deterministic patterns (paths, hosts, file names,
 *      versions, code spans, identifiers).
 *   2. An LLM judge that also sees the scene index, so it can find project,
 *      product and tool names that no pattern can recognize.
 */

import type { LLMRunner } from "../types.js";

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
  reason?: "structural" | "judge-leaks" | "judge-unparseable" | "judge-error";
}

/**
 * Run both checks on a persona body (marker and scene navigation already
 * removed). The structural check runs first, so a cheap failure skips the LLM.
 */
export async function checkUserGlobalPersona(opts: {
  persona: string;
  sceneIndex: SceneIndexHint[];
  judge: LLMRunner;
  timeoutMs?: number;
}): Promise<ScopeCheckResult> {
  const structural = findStructuralLeaks(opts.persona);
  if (structural.length > 0) return { ok: false, leaks: structural, reason: "structural" };

  let output: string;
  try {
    const { systemPrompt, prompt } = buildScopeJudgePrompt(opts.persona, opts.sceneIndex);
    output = await opts.judge.run({
      systemPrompt,
      prompt,
      taskId: "persona-scope-check",
      timeoutMs: opts.timeoutMs ?? 60_000,
    });
  } catch {
    return { ok: false, leaks: [], reason: "judge-error" };
  }
  const leaks = parseJudgeLeaks(output);
  if (leaks === null) return { ok: false, leaks: [], reason: "judge-unparseable" };
  if (leaks.length > 0) return { ok: false, leaks, reason: "judge-leaks" };
  return { ok: true, leaks: [] };
}
