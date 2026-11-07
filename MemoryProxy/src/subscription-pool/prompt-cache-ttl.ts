/**
 * Prompt cache TTL for Anthropic Messages requests sent to a subscription account.
 *
 * Claude Code asks for the 1-hour cache only when it is logged in to a
 * subscription. Behind the proxy it sends `cache_control: {type: "ephemeral"}`
 * without `ttl`, and Anthropic then applies 5 minutes. This module adds
 * `ttl: "1h"` to those breakpoints.
 *
 * Rules:
 *   - Only an `ephemeral` cache_control without `ttl` changes. No new breakpoint is added.
 *   - Anthropic rejects a request where a 1h entry comes after a 5m entry. When the
 *     request has an explicit `ttl: "5m"`, the request stays unchanged.
 *   - The input is never changed. The result is a new object, or the input itself
 *     when there is nothing to change.
 *
 * Visited positions: top-level `cache_control`, `tools[]`, `system[]` blocks,
 * `messages[].content[]` blocks, and the blocks in `tool_result.content[]`.
 * Other fields (for example `tool_use.input`) hold free JSON and are not visited.
 */

export type PromptCacheTtl = "default" | "1h";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Scan {
  hasExplicit5m: boolean;
  hasUpgradable: boolean;
}

function scanMarker(marker: unknown, scan: Scan): void {
  if (!isObject(marker) || marker.type !== "ephemeral") return;
  if (marker.ttl === "5m") scan.hasExplicit5m = true;
  else if (marker.ttl === undefined) scan.hasUpgradable = true;
}

function upgradeMarker(marker: unknown): unknown {
  if (!isObject(marker) || marker.type !== "ephemeral" || marker.ttl !== undefined) return marker;
  return { ...marker, ttl: "1h" };
}

/** Calls `visit` for each block in the visited positions of `body`. */
function forEachBlockList(body: Json, visit: (blocks: unknown[]) => void): void {
  if (Array.isArray(body.tools)) visit(body.tools);
  if (Array.isArray(body.system)) visit(body.system);
  if (!Array.isArray(body.messages)) return;
  for (const message of body.messages) {
    if (!isObject(message) || !Array.isArray(message.content)) continue;
    visit(message.content);
    for (const block of message.content) {
      if (isObject(block) && block.type === "tool_result" && Array.isArray(block.content)) visit(block.content);
    }
  }
}

function upgradeBlock(block: unknown): unknown {
  if (!isObject(block)) return block;
  let out: Json = block;
  if ("cache_control" in block) {
    const marker = upgradeMarker(block.cache_control);
    if (marker !== block.cache_control) out = { ...out, cache_control: marker };
  }
  if (block.type === "tool_result" && Array.isArray(block.content)) {
    const content = upgradeBlocks(block.content);
    if (content !== block.content) out = { ...out, content };
  }
  return out;
}

function upgradeBlocks(blocks: unknown[]): unknown[] {
  let changed = false;
  const next = blocks.map((block) => {
    const upgraded = upgradeBlock(block);
    if (upgraded !== block) changed = true;
    return upgraded;
  });
  return changed ? next : blocks;
}

/**
 * Returns `body` with `ttl: "1h"` on each ephemeral cache_control that has no ttl.
 * Returns `body` itself when `ttl` is "default", when there is no such breakpoint,
 * or when an explicit `ttl: "5m"` is present.
 */
export function applyPromptCacheTtl(body: Json, ttl: PromptCacheTtl): Json {
  if (ttl !== "1h") return body;

  const scan: Scan = { hasExplicit5m: false, hasUpgradable: false };
  scanMarker(body.cache_control, scan);
  forEachBlockList(body, (blocks) => {
    for (const block of blocks) if (isObject(block)) scanMarker(block.cache_control, scan);
  });
  if (scan.hasExplicit5m || !scan.hasUpgradable) return body;

  const out: Json = { ...body };
  if ("cache_control" in body) out.cache_control = upgradeMarker(body.cache_control);
  if (Array.isArray(body.tools)) out.tools = upgradeBlocks(body.tools);
  if (Array.isArray(body.system)) out.system = upgradeBlocks(body.system);
  if (Array.isArray(body.messages)) {
    out.messages = body.messages.map((message: unknown) => {
      if (!isObject(message) || !Array.isArray(message.content)) return message;
      const content = upgradeBlocks(message.content);
      return content === message.content ? message : { ...message, content };
    });
  }
  return out;
}
