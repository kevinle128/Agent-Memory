/**
 * Per-request memory switch.
 *
 * A client sends `x-memory-mode: off` to run a conversation without any memory feature:
 * no session init, no mem commands, no context injection, and no L0 or skill extraction.
 * Routing, compression, billing and tracing stay on. Eval and batch runs use it so that
 * the model sees only the request, and the run leaves no memory behind.
 *
 * The header can only turn features off, so it needs no extra authorization.
 */
import type { CcRequestKind } from "./cc-request-classifier.js";

export const MEMORY_MODE_HEADER = "x-memory-mode";

/** True when the header value asks for a conversation without memory. */
export function isMemoryModeOff(value: string | null | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "off";
}

export interface MemoryGates {
  /** The turn may touch memory: mem commands, session init, injection, L0 and skill. */
  memoryTurn: boolean;
  skipSessionInit: boolean;
  skipInjection: boolean;
}

/**
 * Memory gates of one Anthropic request. The legacy `/proxy/<spaceId>` route and the
 * `x-memory-mode: off` header close the same gates; a sidequery skips session init and
 * injection but is not a memory turn either.
 */
export function resolveMemoryGates(input: {
  requestKind: CcRequestKind;
  legacyProxy: boolean;
  memoryModeHeader: string | null | undefined;
}): MemoryGates {
  const memoryOff = input.legacyProxy || isMemoryModeOff(input.memoryModeHeader);
  const sidequery = input.requestKind === "sidequery";
  return {
    memoryTurn: input.requestKind === "main" && !memoryOff,
    skipSessionInit: sidequery || memoryOff,
    skipInjection: sidequery || memoryOff,
  };
}
