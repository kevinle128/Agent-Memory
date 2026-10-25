/**
 * oh-my-pi (omp) client adapter.
 *
 * omp sends plain-string or text-part user content and has no cache_control
 * markers or fork/sidequery concept, so every request is main.
 *
 * When omp sends the user content as an array of text parts, the first part is
 * a `<system-reminder>` block with the date and the working directory, and the
 * typed prompt follows. Those reminder parts are not user text, so they are
 * dropped.
 */
import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

/** A text part that holds only a `<system-reminder>` block. */
function isSystemReminder(part: unknown): boolean {
  const text = (part as { type?: unknown; text?: unknown } | null)?.text;
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  return trimmed.startsWith("<system-reminder>") && trimmed.endsWith("</system-reminder>");
}

export const ompAdapter: AgentAdapter = {
  agentKind: "omp",
  classifyRequest() {
    return "main";
  },
  extractUserText(content) {
    if (typeof content === "string") return content.length > 0 ? content : null;
    if (Array.isArray(content)) {
      const typed = content.filter((part) => !isSystemReminder(part));
      return defaultAdapter.extractUserText(typed);
    }
    return defaultAdapter.extractUserText(content);
  },
};
