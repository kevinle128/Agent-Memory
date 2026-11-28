/**
 * Types shared by the subscription pool modules. They mirror what Core sends through
 * `/v3/internal/meta/subscription-pool/accounts/list` (the proxy view of an account).
 */

/** One usage limit of an account. Times are epoch milliseconds. */
export interface PoolQuotaWindow {
  name: string;
  /** Model the window applies to. Null or absent means the window is shared by all models. */
  model_scope?: string | null;
  used_pct: number;
  /** Reset time of the window. Null when the provider did not tell it. */
  resets_at: number | null;
  observed_at: number;
  source: string;
  /** Display name of the quota group (AntiGravity). */
  group_label?: string;
  /** Model ids that this window stops (AntiGravity group). When set, it replaces the single-model scope. */
  shared_models?: string[];
}

/**
 * True when the window limits a request for `model`: a shared window, the model's own, or a group
 * that covers it. A group lists only the models this account reported, so a model it does not list
 * (offered by another account, released after the last sweep, or filtered out) still falls under
 * the AntiGravity rule: an id with `gemini` belongs to the Gemini group, any other id to `3p`.
 */
export function windowAppliesToModel(window: Pick<PoolQuotaWindow, "model_scope" | "shared_models">, model: string): boolean {
  if (window.shared_models) {
    if (!model) return false;
    if (window.shared_models.includes(model)) return true;
    const scope = (window.model_scope ?? "").toLowerCase();
    if (scope.includes("gemini") || scope === "3p") {
      return model.toLowerCase().includes("gemini") === scope.includes("gemini");
    }
    return false;
  }
  return !window.model_scope || window.model_scope === model;
}

export type PoolAccountStatus = "active" | "exhausted" | "auth_error" | "plan_error" | "disabled";

export interface PoolAccount {
  account_id: string;
  group_id: string;
  provider: "claude" | "codex" | "antigravity";
  /** Sent as the Codex `chatgpt-account-id` header together with the bearer token. */
  provider_account_id: string;
  /** Google Cloud project of an AntiGravity account. It goes into the request envelope. */
  project_id?: string;
  /** Name that the admin gave the account. Absent when Core is older than this field. */
  display_name?: string;
  /** E-mail and plan from the provider profile. Absent when Core is older than this field. */
  account_label?: string;
  status: PoolAccountStatus;
  enabled: boolean;
  access_token: string;
  /** Epoch milliseconds. */
  token_expires_at: number | null;
  usage: { windows: PoolQuotaWindow[] };
  /** Epoch milliseconds. The account counts as exhausted while `now < exhausted_until`. */
  exhausted_until: number | null;
  /**
   * Usage percentage at which this account stops getting new Session Bindings. Absent when Core
   * is older than this field; the snapshot threshold applies then.
   */
  threshold_pct?: number;
}

export interface PoolSnapshot {
  thresholdPct: number;
  accounts: PoolAccount[];
  /** True when Core could not be reached and no earlier list exists, so the pool state is unknown. */
  unavailable?: boolean;
}
