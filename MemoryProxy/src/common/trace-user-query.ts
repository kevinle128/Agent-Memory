import { extractUserQueryText } from "./user-query-extractor.js";

/** Extract a fresh human query without requiring the optional routing extension. */
export function extractTraceUserQuery(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const value = messages[i];
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, unknown>;
    if (message.role === "system" || message.role === "developer") continue;
    // Never scan past a tool result or assistant message into a previous turn.
    if (message.role !== "user") return "";
    if (typeof message.content === "string") return extractUserQueryText(message.content);
    if (!Array.isArray(message.content)) return "";
    return message.content.flatMap((value: unknown) => {
      if (!value || typeof value !== "object") return [];
      const part = value as Record<string, unknown>;
      if ((part.type !== "text" && part.type !== "input_text") || typeof part.text !== "string") return [];
      const text = extractUserQueryText(part.text);
      return text ? [text] : [];
    }).join("\n");
  }
  return "";
}
