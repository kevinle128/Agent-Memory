/**
 * api/subscription-pool.ts — Subscription Pool (meta/subscription-pool/*).
 *
 * Every pool belongs to one team. A call about a pool names the team with `team_id`; a call about an
 * account names the account, and Core finds the team from the account. A team member views the pool;
 * a team admin or a System Admin manages it. Core enforces these roles.
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
  /** Stop new sessions on this account at this percent of either window (50-100). */
  threshold_pct: number;
  status: PoolAccountStatus;
  token_expires_at: number | null;
  provider_account_id: string;
  /** Google Cloud project of an AntiGravity account. Absent or null for other providers. */
  project_id?: string | null;
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
  /** True when the pool of the team is on. */
  enabled: boolean;
  /** Agent ids of the clients that use the pool of the team. */
  clients: string[];
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
  team_id: string;
  /** Start value for new accounts. It does not change existing accounts. */
  default_threshold_pct: number;
  providers: SubscriptionPoolProviderStatus[];
}

export interface OAuthStart {
  state: string;
  authorize_url: string;
  /** Epoch ms. The login must finish before this time. */
  expires_at: number;
}

export const subscriptionPoolApi = {
  status: (teamId: string, provider?: PoolProvider) =>
    metaPost<SubscriptionPoolStatus>('subscription-pool/status', provider ? { team_id: teamId, provider } : { team_id: teamId }),

  enable: (teamId: string, provider: PoolProvider) =>
    metaPost<unknown>('subscription-pool/enable', { team_id: teamId, provider }),

  disable: (teamId: string, provider: PoolProvider) =>
    metaPost<unknown>('subscription-pool/disable', { team_id: teamId, provider }),

  /** Replaces the clients of the team pool. System Admin or team admin. */
  updateClients: (teamId: string, provider: PoolProvider, agents: string[]) =>
    metaPost<{ provider: PoolProvider; team_id: string; group_id: string | null; clients: string[] }>(
      'subscription-pool/clients/update',
      { team_id: teamId, provider, agents },
    ),

  /** Start value for new accounts. System Admin only. It does not change existing accounts. */
  updateThreshold: (thresholdPct: number) =>
    metaPost<unknown>('subscription-pool/settings/update', { threshold_pct: thresholdPct }),

  oauthStart: (teamId: string, provider: PoolProvider) =>
    metaPost<OAuthStart>('subscription-pool/account/oauth-start', { team_id: teamId, provider }),

  /** Give either `code` or `redirect_url`. A login of an existing provider account keeps its row and name. */
  oauthComplete: (teamId: string, input: {
    provider: PoolProvider;
    state: string;
    code?: string;
    redirect_url?: string;
    display_name?: string;
    /** Empty uses the start value. */
    threshold_pct?: number;
  }) =>
    metaPost<SubscriptionAccount & { created: boolean }>('subscription-pool/account/oauth-complete', {
      team_id: teamId,
      ...input,
    }),

  updateAccount: (input: {
    account_id: string;
    display_name?: string;
    enabled?: boolean;
    status?: 'active';
    threshold_pct?: number;
    expected_version?: number;
  }) => metaPost<SubscriptionAccount>('subscription-pool/account/update', input),

  deleteAccount: (accountId: string) =>
    metaPost<{ deleted: boolean }>('subscription-pool/account/delete', { account_id: accountId }),

  checkUsage: (accountId: string) =>
    metaPost<SubscriptionAccount>('subscription-pool/account/check-usage', { account_id: accountId }),

  /** `requestId` makes one click safe to retry: the provider spends the credit once per id. */
  redeemResetCredit: (input: { account_id: string; credit_id: string; request_id: string }) =>
    metaPost<RedeemResetCreditResult>('subscription-pool/account/redeem-reset-credit', input),

  checkAll: (teamId: string) =>
    metaPost<{ checked: number; failed: number }>('subscription-pool/check-all', { team_id: teamId }),
};
