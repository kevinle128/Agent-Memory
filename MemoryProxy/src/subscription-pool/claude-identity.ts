/**
 * Claude subscription accounts (OAuth) answer only requests whose system prompt starts with
 * the Claude Code identity line; any other request gets a 429 `rate_limit_error` that looks
 * like an exhausted account. Claude Code and clients that copy it (omp) already send the line.
 * Other multi-source agents (hermes, openclaw) do not, so the line is put first for them.
 */

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function startsWithIdentity(text: unknown): boolean {
  return typeof text === "string" && text.trimStart().startsWith(CLAUDE_CODE_IDENTITY);
}

/** Returns the body with the identity block first in `system`; an existing identity is kept. */
export function withClaudeCodeIdentity(body: Record<string, unknown>): Record<string, unknown> {
  const system = body.system;
  const identity = { type: "text", text: CLAUDE_CODE_IDENTITY };
  if (system === undefined || system === null || system === "") {
    return { ...body, system: [identity] };
  }
  if (typeof system === "string") {
    if (startsWithIdentity(system)) return body;
    return { ...body, system: [identity, { type: "text", text: system }] };
  }
  if (Array.isArray(system)) {
    const first = system[0] as { text?: unknown } | undefined;
    if (first && startsWithIdentity(first.text)) return body;
    return { ...body, system: [identity, ...system] };
  }
  return body;
}
