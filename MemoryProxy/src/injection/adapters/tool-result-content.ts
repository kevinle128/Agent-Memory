/**
 * Shared tool-result content handling for the Anthropic and OpenAI adapters.
 *
 * Both protocols allow a tool result to be a string or an array of content
 * parts, where text parts have the shape `{ type: "text", text }`. Hooks work
 * on plain text, so the adapters expose only the joined text. The full array
 * is kept in block metadata, so non-text parts (image, document, file, ...)
 * reach the model unchanged.
 */

import type { ContextBlock } from "../types.js";

type Part = Record<string, unknown>;

export interface ParsedToolResultContent {
  text: string;
  /** Metadata to merge into the tool_result block. Empty for string content. */
  metadata: Record<string, unknown>;
}

export function parseToolResultContent(content: unknown): ParsedToolResultContent {
  if (typeof content === "string") return { text: content, metadata: {} };
  if (!Array.isArray(content)) return { text: JSON.stringify(content ?? ""), metadata: {} };
  const parts = content as Part[];
  const text = parts
    .filter((c) => c.type === "text")
    .map((c) => c.text as string)
    .join("\n");
  return { text, metadata: { raw_content: parts, parsed_text: text } };
}

/**
 * Rebuild tool-result content. If no hook changed the text, return the
 * original array. If a hook changed the text, put the new text first and keep
 * the non-text parts.
 */
export function serializeToolResultContent(block: ContextBlock | undefined): unknown {
  if (!block) return "";
  const raw = block.metadata?.raw_content as Part[] | undefined;
  if (!raw) return block.content;
  if (block.content === block.metadata?.parsed_text) return raw;
  const nonText = raw.filter((c) => c.type !== "text");
  if (nonText.length === 0) return block.content;
  return block.content ? [{ type: "text", text: block.content }, ...nonText] : nonText;
}
