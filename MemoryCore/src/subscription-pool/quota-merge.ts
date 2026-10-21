import type { SubscriptionQuotaWindow } from "../metadata/types.js";

function windowKey(window: SubscriptionQuotaWindow): string {
  return `${window.name}\0${window.model_scope ?? ""}`;
}

/** Newest observation wins per window, including fresh usage readings after a 429. */
export function mergeUsageWindows(current: SubscriptionQuotaWindow[], incoming: SubscriptionQuotaWindow[]): SubscriptionQuotaWindow[] {
  const byKey = new Map(current.map((window) => [windowKey(window), window]));
  for (const next of incoming) {
    const key = windowKey(next);
    const previous = byKey.get(key);
    if (!previous || next.observed_at >= previous.observed_at) byKey.set(key, next);
  }
  return [...byKey.values()];
}
