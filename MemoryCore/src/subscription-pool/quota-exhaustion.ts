import type { SubscriptionQuotaWindow } from "../metadata/types.js";

/** Recheck a full window whose provider did not supply a reset time. */
const UNKNOWN_RESET_RECHECK_MS = 15 * 60 * 1000;

/** All full shared windows must reset before the account can serve again. */
export function sharedQuotaExhaustedUntil(windows: SubscriptionQuotaWindow[], now: number): number | null {
  const resets = windows
    .filter((window) => !window.model_scope && window.used_pct >= 100
      && (window.resets_at === null || window.resets_at > now))
    .map((window) => window.resets_at ?? now + UNKNOWN_RESET_RECHECK_MS);
  return resets.length > 0 ? Math.max(...resets) : null;
}
