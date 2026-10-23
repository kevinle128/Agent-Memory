import type { ProfileScopeMode } from "./types.js";

/**
 * Effective profile scope mode for a raw config value.
 *
 * A missing value (undefined or null) is the default, "scoped". A value that
 * is present but not recognized fails closed to "deny": a typo must neither
 * restore the legacy leak nor silently turn on project memory.
 */
export function resolveProfileScopeMode(raw: unknown): ProfileScopeMode {
  if (raw === undefined || raw === null) return "scoped";
  return raw === "legacy" || raw === "deny" || raw === "scoped" ? raw : "deny";
}
