/**
 * Remember the client object for each parsed block and message.
 * Serialize emits that object again when nothing it writes has changed.
 * A changed block keeps the original fields and replaces only the changed ones.
 */

import type { AgentContext, ContextBlock, ContextBlockType, ContextMessage, MessageRole } from "../types.js";

export type ContentShape = "string" | "array" | "null" | "absent";

/**
 * Block fields that serialize copies onto the provider request.
 * `type` and `content` are compared on their own. These are the metadata keys.
 */
export const BLOCK_WIRE_KEYS = [
  "tool_id",
  "tool_use_id",
  "is_error",
  "signature",
  "cache_control",
  "media_type",
  "source_type",
  "raw_source",
  "detail",
] as const;

export interface MessageWire {
  raw?: Record<string, unknown>;
  contentShape: ContentShape;
  blockCount: number;
  role: MessageRole;
  blocks: ContextBlock[];
  metadata?: Record<string, unknown>;
}

interface BlockWire {
  raw: Record<string, unknown>;
  originalText: string;
  textKey?: "text" | "thinking";
  type: ContextBlockType;
  wire: Record<string, unknown>;
}

const bodies = new WeakMap<AgentContext, Record<string, unknown>>();
const messageWires = new WeakMap<ContextMessage, MessageWire>();
const blockWires = new WeakMap<ContextBlock, BlockWire>();

export function rememberBody(ctx: AgentContext, body: Record<string, unknown>): void {
  bodies.set(ctx, body);
}

export function rememberedBody(ctx: AgentContext): Record<string, unknown> | undefined {
  return bodies.get(ctx);
}

export function rememberMessage(
  message: ContextMessage,
  wire: Pick<MessageWire, "raw" | "contentShape" | "blockCount">,
): void {
  messageWires.set(message, {
    ...wire,
    role: message.role,
    blocks: [...message.blocks],
    metadata: cloneJson(message.metadata),
  });
}

export function messageWire(message: ContextMessage): MessageWire | undefined {
  return messageWires.get(message);
}

export function rememberBlock(
  block: ContextBlock,
  raw: Record<string, unknown>,
  originalText: string,
  textKey?: "text" | "thinking",
): void {
  blockWires.set(block, {
    raw,
    originalText,
    textKey,
    type: block.type,
    wire: cloneJson(pickWire(block.metadata)) ?? {},
  });
}

export function blockWire(block: ContextBlock): { raw: Record<string, unknown>; originalText: string } | undefined {
  return blockWires.get(block);
}

/** True when type, content, or a metadata field that serialize writes has changed. */
export function blockChanged(block: ContextBlock): boolean {
  const src = blockWires.get(block);
  if (!src) return true;
  if (block.type !== src.type) return true;
  if (block.content !== src.originalText) return true;
  return !sameJson(pickWire(block.metadata), src.wire);
}

/**
 * True when the block list is the parsed list: same objects, same order,
 * and no block has a wire-field change.
 */
export function sameBlocks(current: ContextBlock[], original: ContextBlock[]): boolean {
  if (current.length !== original.length) return false;
  return current.every((block, index) => block === original[index] && !blockChanged(block));
}

/** The original block, or the original block with a new text field. */
export function preservedBlock(block: ContextBlock): Record<string, unknown> | undefined {
  const src = blockWires.get(block);
  if (!src) return undefined;
  if (!blockChanged(block)) return src.raw;
  const metaSame = sameJson(pickWire(block.metadata), src.wire);
  if (src.textKey && block.type === src.type && metaSame) {
    return { ...src.raw, [src.textKey]: block.content };
  }
  return undefined;
}

export function messageUnchanged(message: ContextMessage): boolean {
  const wire = messageWires.get(message);
  if (!wire?.raw) return false;
  if (message.role !== wire.role) return false;
  if (!sameBlocks(message.blocks, wire.blocks)) return false;
  return sameJson(message.metadata, wire.metadata);
}

function pickWire(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  if (!metadata) return wire;
  for (const key of BLOCK_WIRE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) wire[key] = metadata[key];
  }
  return wire;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function cloneJson<T>(value: T): T | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as T;
}
