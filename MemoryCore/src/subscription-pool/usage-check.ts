import type { IMetadataStore } from "../metadata/store/interface.js";
import {
  SubscriptionAccountWriteConflictError,
  type SubscriptionAccountEntity,
  type SubscriptionQuotaWindow,
  type SubscriptionResetCredits,
  type UpdateSubscriptionAccountPatch,
} from "../metadata/types.js";
import type { SubscriptionProviderAdapter } from "./providers/types.js";
import { mergeUsageWindows } from "./quota-merge.js";
import { sharedQuotaExhaustedUntil } from "./quota-exhaustion.js";
import { withAccountLock } from "./token-refresher.js";

export const USAGE_CHECK_FAILED = "usage check failed";
/** Next check for a window at the threshold whose reset time is unknown or already past. */
export const RECHECK_MS = 15 * 60 * 1000;

export interface UsageCheckResult {
  account: SubscriptionAccountEntity;
  failed: boolean;
}

/** A window that is still at the limit after its reset time is checked again in 15 minutes. */
function withNextCheck(windows: SubscriptionQuotaWindow[], thresholdPct: number, now: number): SubscriptionQuotaWindow[] {
  return windows.map((window) => (
    window.used_pct >= thresholdPct && (window.resets_at === null || window.resets_at <= now)
      ? { ...window, resets_at: now + RECHECK_MS }
      : window
  ));
}

/**
 * Reads usage from the provider and stores it. A full shared window exhausts an active account
 * until all full shared windows reset. An exhausted account is released when no shared
 * window is full, even if usage is still above the new-session threshold.
 * When the provider call fails after the reset time, the account is
 * released by time.
 */
export async function checkAccountUsage(
  store: IMetadataStore,
  accountId: string,
  adapter: SubscriptionProviderAdapter,
  thresholdPct: number,
  now = Date.now(),
): Promise<UsageCheckResult> {
  const before = await store.getSubscriptionAccount(accountId);
  if (!before) throw new SubscriptionAccountWriteConflictError("account_not_found", `subscription account not found: ${accountId}`);

  let reading: SubscriptionQuotaWindow[] | null = null;
  let resetCredits: SubscriptionResetCredits | null = null;
  try {
    const usage = await adapter.fetchUsage(before.access_token, before.provider_account_id);
    reading = withNextCheck(usage.windows, thresholdPct, now);
    resetCredits = usage.resetCredits;
  } catch {
    reading = null;
  }

  return withAccountLock(accountId, async () => {
    const current = await store.getSubscriptionAccount(accountId);
    if (!current) throw new SubscriptionAccountWriteConflictError("account_not_found", `subscription account not found: ${accountId}`);
    const exhausted = current.status === "exhausted" || current.exhausted_until !== null;

    if (reading === null) {
      const patch: UpdateSubscriptionAccountPatch = { usage_fail_count: current.usage_fail_count + 1, last_error: USAGE_CHECK_FAILED };
      if (exhausted && (current.exhausted_until === null || current.exhausted_until <= now)) {
        patch.exhausted_until = null;
        if (current.status === "exhausted") patch.status = "active";
      }
      return { account: await store.updateSubscriptionAccount(accountId, patch), failed: true };
    }

    // Drop expired windows and old synthetic 429 windows absent from this provider reading.
    // A newer 429 arriving while the check was in flight must still be retained.
    // An older usage API row absent from this reading is dropped too: the usage API is the
    // authority for its own rows, so a window it no longer sends (or now sends under another
    // name) must not stay until its old reset time.
    const fresh = new Set(reading.map((window) => `${window.name}\0${window.model_scope ?? ""}`));
    const windows = mergeUsageWindows(current.usage.windows, reading).filter((window) => (
      fresh.has(`${window.name}\0${window.model_scope ?? ""}`)
      || (window.source !== "usage_api"
        && (window.source !== "429" || window.observed_at > now)
        && (window.resets_at === null || window.resets_at > now))
    ));
    const patch: UpdateSubscriptionAccountPatch = {
      usage: { windows },
      // A check without a credit reading clears the old one, so the Panel never shows a stale count.
      reset_credits: resetCredits,
      usage_updated_at: now,
      usage_fail_count: 0,
      last_error: current.last_error === USAGE_CHECK_FAILED ? null : undefined,
    };
    const quotaExhaustedUntil = sharedQuotaExhaustedUntil(windows, now);
    if (quotaExhaustedUntil !== null && (current.status === "active" || current.status === "exhausted")) {
      patch.status = "exhausted";
      patch.exhausted_until = quotaExhaustedUntil;
    } else if (exhausted) {
      patch.exhausted_until = null;
      if (current.status === "exhausted") patch.status = "active";
    }
    return { account: await store.updateSubscriptionAccount(accountId, patch), failed: false };
  });
}
