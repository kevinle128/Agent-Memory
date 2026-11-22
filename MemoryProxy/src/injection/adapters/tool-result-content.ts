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
 * Rebuild tool-result content. Unchanged text returns the original array.
 *
 * Changed text is one flat string (`ContextBlock.content`). It is written
 * into the first text part. Later text parts are removed, and their fields
 * are dropped. Non-text parts stay where they were relative to that first
 * text part. The new text is not split on newlines.
 *
 * When the array has no text part, the new text is a new part placed first.
 * That is where the previous builder put rewritten text, so the new text is
 * not dropped. Every original part then follows, in its original order.
 */
export function serializeToolResultContent(block: ContextBlock | undefined): unknown {
  if (!block) return "";
  const raw = block.metadata?.raw_content as Part[] | undefined;
  if (!raw) return block.content;
  if (block.content === block.metadata?.parsed_text) return raw;

  const firstText = raw.findIndex((part) => part.type === "text");
  if (firstText === -1) {
    return [{ type: "text", text: block.content }, ...raw];
  }
  const after = raw.slice(firstText + 1).filter((part) => part.type !== "text");
  return [
    ...raw.slice(0, firstText),
    { ...raw[firstText], text: block.content },
    ...after,
  ];
}
