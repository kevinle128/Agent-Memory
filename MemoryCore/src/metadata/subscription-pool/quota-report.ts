import { mergeUsageWindows } from "../../subscription-pool/quota-merge.js";
import { sharedQuotaExhaustedUntil } from "../../subscription-pool/quota-exhaustion.js";
import type { SubscriptionAccountStatus, SubscriptionAccountUsage, SubscriptionQuotaWindow } from "../types.js";

export interface SubscriptionQuotaReport {
  windows?: SubscriptionQuotaWindow[];
  status_code?: number;
  retry_after?: number;
  active_sessions?: number;
}

export function applyQuotaReport(
  current: { status: SubscriptionAccountStatus; usage: SubscriptionAccountUsage; exhausted_until: number | null },
  report: SubscriptionQuotaReport,
  now: number,
): {
  status?: SubscriptionAccountStatus;
  usage?: SubscriptionAccountUsage;
  usage_updated_at?: number;
  exhausted_until?: number | null;
  active_sessions?: number;
} {
  const windows = report.windows ? mergeUsageWindows(current.usage.windows, report.windows) : current.usage.windows;
  const usageChanged = report.windows !== undefined;
  let exhausted_until = current.exhausted_until;
  // HTTP 429 and Retry-After alone are not evidence of exhausted subscription quota.
  // Transient throttling is handled by Proxy's retry coordinator, not account status.
  // A measured full shared window also stops the account, without waiting for a 429.
  // Preserve accounts that need a new login or were switched off.
  const servable = current.status === "active" || current.status === "exhausted";
  const quotaExhaustedUntil = sharedQuotaExhaustedUntil(windows, now);
  const fullQuota = servable && quotaExhaustedUntil !== null;
  if (fullQuota) exhausted_until = Math.max(exhausted_until ?? 0, quotaExhaustedUntil);
  return {
    status: fullQuota ? "exhausted" : undefined,
    usage: usageChanged ? { windows } : undefined,
    usage_updated_at: usageChanged ? now : undefined,
    exhausted_until: fullQuota ? exhausted_until : undefined,
    active_sessions: report.active_sessions,
  };
}
