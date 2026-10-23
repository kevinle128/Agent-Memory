import type { SubscriptionQuotaWindow, SubscriptionResetCredit, SubscriptionResetCredits } from "../../metadata/types.js";
import {
  byExpiry,
  parseResetTime,
  shortMessage,
  readProviderError,
  type ExchangedSubscriptionTokens,
  type SubscriptionCodeExchangeInput,
  type SubscriptionFetch,
  type SubscriptionProviderAdapter,
} from "./types.js";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
// `cedar_ember=1` adds the reset credit block to the usage body. `skip_spend=1` leaves out the spend data we do not use.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";
const RESET_PROGRAM = "cedar_ember";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPE = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins";
const OAUTH_BETA = "oauth-2025-04-20";
/**
 * The server fills the reset credit block only for a Claude Code CLI client. For another client
 * it answers `ineligible_reason: "surface"` with no grants. The version is not checked, so this
 * value does not need to follow the CLI releases.
 */
const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.308 (external, cli)";

/** Flat window names of the older payload shape, with the model each one limits (null = shared). */
const FLAT_WINDOWS: ReadonlyArray<readonly [name: string, modelScope: string | null]> = [
  ["five_hour", null],
  ["seven_day", null],
  ["seven_day_oauth_apps", null],
  ["seven_day_opus", "opus"],
  ["seven_day_sonnet", "sonnet"],
  ["seven_day_fable", "fable"],
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === "string" && value) return value;
  return null;
}

function windowOf(name: string, raw: unknown, now: number, modelScope: string | null = null): SubscriptionQuotaWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { utilization?: number; percent?: number; resets_at?: unknown };
  const used = typeof value.utilization === "number" ? value.utilization : value.percent;
  if (typeof used !== "number") return null;
  return {
    name,
    model_scope: modelScope,
    used_pct: used,
    resets_at: parseResetTime(value.resets_at, now),
    observed_at: now,
    source: "usage_api",
  };
}

/**
 * Usage payload of the Claude OAuth usage API.
 * `limits[]` is the current shape. Flat windows are the older shape and are used only when
 * `limits` is absent.
 * `is_active` marks only the limit that binds now, so inactive rows are real windows and stay.
 * A `weekly_scoped` row always limits one model. The API can send `scope.model.id: null` with
 * only a display name, so the scope falls back to that name. It must never become a shared
 * window, because a full shared window stops the whole account.
 */
export function parseClaudeUsage(raw: unknown, now = Date.now()): SubscriptionQuotaWindow[] {
  const body = asRecord(raw);
  if (Array.isArray(body.limits) && body.limits.length > 0) {
    const windows: SubscriptionQuotaWindow[] = [];
    for (const item of body.limits) {
      const row = asRecord(item);
      const kind = String(row.kind ?? "");
      const scope = asRecord(row.scope);
      const model = asRecord(scope.model);
      const modelScope = firstText(model.id, model.display_name, scope.surface)
        ?? (kind === "weekly_scoped" ? kind : null);
      const shared = kind === "session" || kind === "weekly_all" || !modelScope;
      const name = kind === "session" ? "five_hour" : kind === "weekly_all" ? "seven_day" : (kind || "limit");
      const parsed = windowOf(name, { percent: row.percent, resets_at: row.resets_at }, now, shared ? null : modelScope);
      if (parsed) windows.push(parsed);
    }
    return windows;
  }
  return FLAT_WINDOWS
    .map(([name, modelScope]) => windowOf(name, body[name], now, modelScope))
    .filter((window): window is SubscriptionQuotaWindow => window !== null);
}

function parseGrant(raw: unknown): SubscriptionResetCredit | null {
  const grant = asRecord(raw);
  const id = firstText(grant.id);
  const remaining = grant.resets_left;
  if (!id || typeof remaining !== "number" || !Number.isFinite(remaining) || remaining <= 0) return null;
  return {
    id,
    label: firstText(grant.label),
    remaining,
    total: typeof grant.resets_total === "number" ? grant.resets_total : null,
    expires_at: parseResetTime(grant.ends_at),
    usable_now: typeof grant.usable_now === "boolean" ? grant.usable_now : null,
    unavailable_reason: firstText(grant.unavailable_reason),
  };
}

/**
 * Reset credits from the `cedar_ember` block of the usage payload. A missing or unknown block
 * gives null, so the usage check does not fail when the provider changes this block.
 * An account that is not eligible has no credit; the reason stays in `note`.
 */
export function parseClaudeResetCredits(raw: unknown, now = Date.now()): SubscriptionResetCredits | null {
  const block = asRecord(asRecord(raw)[RESET_PROGRAM]);
  if (typeof block.eligible !== "boolean") return null;
  if (!block.eligible) {
    return { available: 0, usable_now: 0, note: firstText(block.ineligible_reason) ?? "ineligible", observed_at: now, credits: [] };
  }
  if (!Array.isArray(block.grants)) return null;
  const credits = block.grants
    .map(parseGrant)
    .filter((credit): credit is SubscriptionResetCredit => credit !== null)
    .sort(byExpiry);
  return {
    available: credits.reduce((sum, credit) => sum + credit.remaining, 0),
    usable_now: credits.filter((credit) => credit.usable_now === true).length,
    note: null,
    observed_at: now,
    credits,
  };
}

async function postToken(fetchImpl: SubscriptionFetch, body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw await readProviderError(response);
  return await response.json() as Record<string, unknown>;
}

function labelOf(email: string, plan: string): string {
  return [email, plan].filter(Boolean).join(" ");
}

function identityFromTokenBody(body: Record<string, unknown>): { providerAccountId: string; accountLabel: string } {
  const account = asRecord(body.account);
  const organization = asRecord(body.organization);
  const email = String(account.email_address ?? account.email ?? "");
  const plan = String(organization.organization_type ?? "");
  return { providerAccountId: String(account.uuid ?? ""), accountLabel: labelOf(email, plan) };
}

function expiresAtOf(body: Record<string, unknown>, now: number): number | null {
  const expiresIn = Number(body.expires_in);
  return Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null;
}

function tokensFrom(
  body: Record<string, unknown>,
  identity: { providerAccountId: string; accountLabel: string },
  now: number,
): ExchangedSubscriptionTokens {
  return {
    accessToken: String(body.access_token ?? ""),
    refreshToken: String(body.refresh_token ?? ""),
    expiresAt: expiresAtOf(body, now),
    providerAccountId: identity.providerAccountId,
    accountLabel: identity.accountLabel,
  };
}

const ORGANIZATIONS_URL = "https://api.anthropic.com/api/organizations";

function apiHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "anthropic-beta": OAUTH_BETA,
    "user-agent": CLAUDE_CLI_USER_AGENT,
    accept: "application/json",
  };
}

export function createClaudeAdapter(fetchImpl: SubscriptionFetch = fetch): SubscriptionProviderAdapter {
  async function profileOf(accessToken: string): Promise<{ providerAccountId: string; accountLabel: string }> {
    const response = await fetchImpl(PROFILE_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw await readProviderError(response);
    const body = asRecord(await response.json());
    const account = asRecord(body.account);
    const organization = asRecord(body.organization);
    return {
      providerAccountId: String(account.uuid ?? ""),
      accountLabel: labelOf(String(account.email ?? account.display_name ?? ""), String(organization.organization_type ?? "")),
    };
  }

  return {
    provider: "claude",
    async exchangeCode(input: SubscriptionCodeExchangeInput) {
      const body = await postToken(fetchImpl, {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri || REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: input.codeVerifier,
        state: input.state,
      });
      let identity = identityFromTokenBody(body);
      const accessToken = String(body.access_token ?? "");
      if (!identity.providerAccountId && accessToken) identity = await profileOf(accessToken);
      if (!identity.providerAccountId) throw new Error("claude token has no account id");
      return tokensFrom(body, identity, Date.now());
    },
    async refresh(refreshToken: string) {
      const body = await postToken(fetchImpl, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        scope: SCOPE,
      });
      return tokensFrom(body, { providerAccountId: "", accountLabel: "" }, Date.now());
    },
    async fetchUsage(accessToken: string) {
      const response = await fetchImpl(USAGE_URL, {
        headers: apiHeaders(accessToken),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw await readProviderError(response);
      const body = await response.json();
      return { windows: parseClaudeUsage(body), resetCredits: parseClaudeResetCredits(body) };
    },
    async redeemResetCredit(accessToken: string, _providerAccountId: string, input) {
      // The redeem route is per organization, and the usage payload has no organization id.
      const profileResponse = await fetchImpl(PROFILE_URL, {
        headers: apiHeaders(accessToken),
        signal: AbortSignal.timeout(10_000),
      });
      if (!profileResponse.ok) throw await readProviderError(profileResponse);
      const organizationId = firstText(asRecord(asRecord(await profileResponse.json()).organization).uuid);
      if (!organizationId) throw new Error("claude profile has no organization id");

      const response = await fetchImpl(`${ORGANIZATIONS_URL}/${encodeURIComponent(organizationId)}/reset_rate_limits`, {
        method: "POST",
        headers: { ...apiHeaders(accessToken), "content-type": "application/json" },
        body: JSON.stringify({ program: RESET_PROGRAM, grant_id: input.creditId, request_id: input.requestId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw await readProviderError(response);
      const text = await response.text();
      let body: Record<string, unknown> = {};
      try {
        body = asRecord(JSON.parse(text));
      } catch {
        // A body that is not JSON stays in the message as it is.
      }
      const outcome = firstText(body.outcome, body.result, body.status, body.code) ?? "unknown";
      return { outcome, resetApplied: outcome === "reset", message: firstText(body.message) ?? (outcome === "unknown" ? shortMessage(text) : null) };
    },
  };
}

export const CLAUDE_OAUTH = {
  CLIENT_ID,
  REDIRECT_URI,
  SCOPE,
  AUTHORIZE_URL: "https://claude.com/cai/oauth/authorize",
  extraParams: { code: "true" } as Record<string, string>,
};
