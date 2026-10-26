/**
 * api/subscription-pool.ts — Subscription Pool (meta/subscription-pool/*).
 *
 * Authenticated users may view status; mutations require System Admin in the kernel.
 * Account rows are the masked public view:
 * Core never returns login tokens, and this module has no field for them.
 */
import { metaPost } from './base';
import type { PoolSourceView } from './model-providers';
import type { PoolAccountStatus, PoolProvider, PoolResetCredits, PoolWindow } from '../subscription-pool-display';

export type { PoolProvider } from '../subscription-pool-display';

export interface SubscriptionAccount {
  account_id: string;
  group_id: string;
  provider: PoolProvider;
  display_name: string;
  /** E-mail and plan from the provider profile. */
  account_label: string;
  enabled: boolean;
  status: PoolAccountStatus;
  token_expires_at: number | null;
  provider_account_id: string;
  usage: { windows: PoolWindow[] };
  usage_updated_at: number | null;
  /** Null until the first usage check reads the credits, or when the provider gives none. */
  reset_credits: PoolResetCredits | null;
  exhausted_until: number | null;
  usage_fail_count: number;
  refresh_fail_count: number;
  last_error: string | null;
  active_sessions: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RedeemResetCreditResult {
  /** Provider outcome, for example "reset" or "nothing_to_reset". */
  outcome: string;
  reset_applied: boolean;
  message: string | null;
  account: SubscriptionAccount;
}

export interface SubscriptionPoolProviderStatus {
  provider: PoolProvider;
  /** True when the agent of this provider uses the pool. */
  enabled: boolean;
  /** Null until the pool is turned on for the first time. */
  group_id: string | null;
  accounts: SubscriptionAccount[];
  summary: {
    total: number;
    available: number;
    active_sessions: number;
    earliest_reset: number | null;
  };
  /** Source part of the pool group. Null until the pool is turned on for the first time. */
  source: PoolSourceView | null;
}

export interface SubscriptionPoolStatus {
  threshold_pct: number;
  providers: SubscriptionPoolProviderStatus[];
}

export interface OAuthStart {
  state: string;
  authorize_url: string;
  /** Epoch ms. The login must finish before this time. */
  expires_at: number;
}

export const subscriptionPoolApi = {
  status: (provider?: PoolProvider) =>
    metaPost<SubscriptionPoolStatus>('subscription-pool/status', provider ? { provider } : {}),

  enable: (provider: PoolProvider) => metaPost<unknown>('subscription-pool/enable', { provider }),

  disable: (provider: PoolProvider) => metaPost<unknown>('subscription-pool/disable', { provider }),

  updateThreshold: (thresholdPct: number) =>
    metaPost<unknown>('subscription-pool/settings/update', { threshold_pct: thresholdPct }),

  oauthStart: (provider: PoolProvider) =>
    metaPost<OAuthStart>('subscription-pool/account/oauth-start', { provider }),

  /** Give either `code` or `redirect_url`. A login of an existing provider account keeps its row and name. */
  oauthComplete: (input: {
    provider: PoolProvider;
    state: string;
    code?: string;
    redirect_url?: string;
    display_name?: string;
  }) =>
    metaPost<SubscriptionAccount & { created: boolean }>('subscription-pool/account/oauth-complete', input),

  updateAccount: (input: {
    account_id: string;
    display_name?: string;
    enabled?: boolean;
    expected_version?: number;
  }) => metaPost<SubscriptionAccount>('subscription-pool/account/update', input),

  deleteAccount: (accountId: string) =>
    metaPost<{ deleted: boolean }>('subscription-pool/account/delete', { account_id: accountId }),

  checkUsage: (accountId: string) =>
    metaPost<SubscriptionAccount>('subscription-pool/account/check-usage', { account_id: accountId }),

  /** `requestId` makes one click safe to retry: the provider spends the credit once per id. */
  redeemResetCredit: (input: { account_id: string; credit_id: string; request_id: string }) =>
    metaPost<RedeemResetCreditResult>('subscription-pool/account/redeem-reset-credit', input),

  checkAll: () => metaPost<{ checked: number; failed: number }>('subscription-pool/check-all', {}),
};
