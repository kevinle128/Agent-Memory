import type { SubscriptionAccountEntity } from "../types.js";

/**
 * Reads stored reset credits. A value of an unknown shape gives null, so a damaged row shows as
 * "no reading" and the next usage check replaces it.
 */
export function parseStoredResetCredits(value: unknown): SubscriptionAccountEntity["reset_credits"] {
  if (!value || typeof value !== "object") return null;
  const stored = value as Partial<NonNullable<SubscriptionAccountEntity["reset_credits"]>>;
  if (!Array.isArray(stored.credits)) return null;
  if (typeof stored.available !== "number" || typeof stored.observed_at !== "number") return null;
  return {
    available: stored.available,
    usable_now: typeof stored.usable_now === "number" ? stored.usable_now : null,
    note: typeof stored.note === "string" ? stored.note : null,
    observed_at: stored.observed_at,
    credits: stored.credits,
  };
}
