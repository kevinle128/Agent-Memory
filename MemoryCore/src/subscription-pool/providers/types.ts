import type { SubscriptionProvider, SubscriptionQuotaWindow, SubscriptionResetCredits } from "../../metadata/types.js";

export interface ExchangedSubscriptionTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. Null when the provider omitted `expires_in`. */
  expiresAt: number | null;
  providerAccountId: string;
  accountLabel: string;
}

export interface SubscriptionCodeExchangeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  state: string;
}

export class SubscriptionProviderError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly status: number,
  ) {
    super(message);
    this.name = "SubscriptionProviderError";
  }
}

/** What one usage check reads. `resetCredits` is null when the provider gave no usable reading. */
export interface SubscriptionUsageReading {
  windows: SubscriptionQuotaWindow[];
  resetCredits: SubscriptionResetCredits | null;
}

export interface RedeemResetCreditInput {
  creditId: string;
  /** Made once per admin click. The provider uses it to ignore a repeat of the same click. */
  requestId: string;
}

export interface RedeemResetCreditResult {
  /** Provider result code, such as `reset`, `already_used` or `nothing_to_reset`. */
  outcome: string;
  /** True only when the provider cleared the usage limits. */
  resetApplied: boolean;
  message: string | null;
}

export interface SubscriptionProviderAdapter {
  readonly provider: SubscriptionProvider;
  exchangeCode(input: SubscriptionCodeExchangeInput): Promise<ExchangedSubscriptionTokens>;
  refresh(refreshToken: string): Promise<ExchangedSubscriptionTokens>;
  fetchUsage(accessToken: string, providerAccountId: string): Promise<SubscriptionUsageReading>;
  redeemResetCredit(
    accessToken: string,
    providerAccountId: string,
    input: RedeemResetCreditInput,
  ): Promise<RedeemResetCreditResult>;
}

export type SubscriptionFetch = (url: string, init?: RequestInit) => Promise<Response>;

export function parseResetTime(value: unknown, now = Date.now()): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (value.trim() !== "" && Number.isFinite(asNumber)) return parseResetTime(asNumber, now);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Longest provider text kept in a result message. */
const MAX_MESSAGE_LENGTH = 300;

export function shortMessage(text: string): string | null {
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, MAX_MESSAGE_LENGTH) : null;
}

/** Orders credits by expiry, soonest first, and puts credits without an expiry last. */
export function byExpiry<T extends { expires_at: number | null }>(a: T, b: T): number {
  if (a.expires_at === b.expires_at) return 0;
  if (a.expires_at === null) return 1;
  if (b.expires_at === null) return -1;
  return a.expires_at - b.expires_at;
}

/** Error codes that mean the refresh token is gone and the account needs a new login. */
const PERMANENT_ERROR_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

export async function readProviderError(response: Response): Promise<SubscriptionProviderError> {
  // A 400 alone can be a client bug; only a 401 or a known code means the login is gone.
  let permanent = response.status === 401;
  let message = `provider returned ${response.status}`;
  try {
    const body = await response.json() as { error?: string | { type?: string; code?: string; message?: string } };
    const error = body.error;
    const code = typeof error === "string" ? error : error?.code ?? error?.type;
    if (code && PERMANENT_ERROR_CODES.has(code)) permanent = true;
    message = typeof error === "string" ? error : error?.message || code || message;
  } catch {
    // A non-JSON body still classifies by status.
  }
  if (response.status >= 500 || response.status === 429 || response.status === 408) permanent = false;
  return new SubscriptionProviderError(message, permanent, response.status);
}
