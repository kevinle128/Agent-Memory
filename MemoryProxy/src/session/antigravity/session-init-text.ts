/**
 * Session-init questions of AntiGravity (agy), asked as plain text turns.
 *
 * agy has no tool that the proxy can call to ask the user, so the shared session-init state machine
 * (session/codebuddy/init.ts) runs in its text mode (`capabilities.askUserQuestion === false`, the
 * mode WorkBuddy uses without its ask tool). The order is the same as for Claude Code and Codex:
 * account default, header preset, auto-select when only one choice exists, and only then a question.
 *
 *   - The question is a model turn, a Gemini answer that starts with `SESSION_INIT_MARKER`.
 *   - The reply of the user is the next user turn. The state machine reads it as the last user
 *     message, so `contentsToMessages` gives it the history of `contents`.
 *   - Questions and replies are removed from `contents` before the request goes upstream, on every
 *     request (a resumed conversation replays them too), so the model never sees them.
 */

import type { SessionInitResult } from "../index.js";
import type { FormData as TextFormData, FormStage } from "../workbuddy/form.js";
import { renderBypassNotice, renderTextForm } from "../workbuddy/text-form.js";
import { geminiTextResponse } from "./hook-gate.js";
import { isAgySystemNotice, userRequestText } from "./user-request.js";

/** First characters of every question turn, so later requests can find and remove it. */
export const SESSION_INIT_MARKER = "[Agent-Memory session init]";

type Content = { role?: unknown; parts?: unknown };

function textOf(turn: Content | undefined): string {
  if (!turn || !Array.isArray(turn.parts)) return "";
  return (turn.parts as Array<{ text?: unknown; thought?: unknown }>)
    .map((p) => (p && p.thought !== true && typeof p.text === "string" ? p.text : ""))
    .join("\n");
}

function isQuestionTurn(turn: Content | undefined): boolean {
  if (turn?.role !== "model" || !Array.isArray(turn.parts)) return false;
  const first = (turn.parts[0] as { text?: unknown } | undefined)?.text;
  return typeof first === "string" && first.startsWith(SESSION_INIT_MARKER);
}

/**
 * Chat messages of the conversation for the state machine; the last user message is the reply.
 * User turns carry only the typed text (agy adds tagged blocks around it).
 */
export function contentsToMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const contents = Array.isArray(body.contents) ? body.contents as Content[] : [];
  return contents.flatMap((turn) => {
    const isModel = turn.role === "model";
    const raw = textOf(turn);
    // A system notice of agy is not part of the dialogue, so the last user message stays the typed reply.
    if (!isModel && isAgySystemNotice(raw)) return [];
    const text = isModel ? raw : userRequestText(raw);
    if (!text) return [];
    return [{ role: isModel ? "assistant" : "user", content: text }];
  });
}

/**
 * The body without the question turns and every user turn that follows one, up to the next model
 * turn: the typed replies and the system notices that agy adds as further `user` entries. Returns
 * the same object when there is nothing to remove.
 */
export function stripSessionInitTurns(body: Record<string, unknown>): Record<string, unknown> {
  const contents = Array.isArray(body.contents) ? body.contents as Content[] : [];
  if (!contents.some(isQuestionTurn)) return body;
  const kept: Content[] = [];
  for (let i = 0; i < contents.length; i++) {
    if (isQuestionTurn(contents[i])) {
      while (contents[i + 1]?.role === "user") i++;
      continue;
    }
    kept.push(contents[i]!);
  }
  return { ...body, contents: kept };
}

/**
 * The text that the state machine wants to show, or null when it has nothing to say. A form comes
 * from `formData`; a bypass after too many unclear replies comes as an intercepted result with no form.
 */
export function renderSessionInitText(result: SessionInitResult): string | null {
  const fd = result.formData;
  if (fd) {
    const page = fd.stage === "team" ? fd.teamPage
      : fd.stage === "agent_select" ? fd.agentPage
        : fd.stage === "task_select" ? fd.taskPage : 0;
    const form: TextFormData = {
      teams: fd.teams,
      stage: fd.stage as FormStage,
      selectedTeamId: fd.selectedTeamId,
      selectedAgentId: fd.selectedAgentId,
      pageIndex: page,
      retry: fd.retry,
      stream: true,
      modelId: fd.modelId,
    };
    return `${SESSION_INIT_MARKER}\n${renderTextForm(form, { retry: fd.retry ? {} : undefined })}`;
  }
  if (result.intercepted && result.bypassed) return `${SESSION_INIT_MARKER}\n${renderBypassNotice()}`;
  return null;
}

/** The Gemini answer that holds the question, or null when the result needs no answer. */
export function sessionInitResponse(result: SessionInitResult, stream: boolean): Response | null {
  const text = renderSessionInitText(result);
  return text === null ? null : geminiTextResponse(text, stream);
}
