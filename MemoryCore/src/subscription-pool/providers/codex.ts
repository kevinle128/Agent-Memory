import type { SubscriptionQuotaWindow, SubscriptionResetCredit, SubscriptionResetCredits } from "../../metadata/types.js";
import { DEFAULT_CODEX_CLIENT_VERSION } from "../config.js";
import {
  byExpiry,
  parseResetTime,
  shortMessage,
  readProviderError,
  type ExchangedSubscriptionTokens,
  type SourceModelReading,
  type SubscriptionCodeExchangeInput,
  type SubscriptionFetch,
  type SubscriptionProviderAdapter,
} from "./types.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const REDEEM_RESET_CREDIT_URL = `${RESET_CREDITS_URL}/consume`;
const MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Codex refresh responses usually omit `expires_in`; the access token JWT `exp` is the source of truth then. */
function expiresAtOf(body: Record<string, unknown>, accessToken: string, now: number): number | null {
  const expiresIn = Number(body.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return now + expiresIn * 1000;
  const exp = Number(decodeJwtPayload(accessToken).exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

function identityFromIdToken(idToken: string): { providerAccountId: string; accountLabel: string } {
  const payload = decodeJwtPayload(idToken);
  const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const profile = payload["https://api.openai.com/profile"] as { email?: string } | undefined;
  const accountId = String(auth?.chatgpt_account_id ?? "");
  const plan = String(auth?.chatgpt_plan_type ?? "");
  const email = String(profile?.email ?? payload.email ?? "");
  return { providerAccountId: accountId, accountLabel: [email, plan].filter(Boolean).join(" ") };
}

function windowOf(name: string, raw: unknown, now: number): SubscriptionQuotaWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { used_percent?: number; reset_at?: unknown; reset_after_seconds?: number };
  // A row without a usage percent is a shape this parser does not know; storing it as 0 % would hide a limit.
  if (typeof value.used_percent !== "number") return null;
  const resetAt = parseResetTime(value.reset_at, now) ?? (
    typeof value.reset_after_seconds === "number" ? now + value.reset_after_seconds * 1000 : null
  );
  return {
    name,
    model_scope: null,
    used_pct: Number(value.used_percent ?? 0),
    resets_at: resetAt,
    observed_at: now,
    source: "usage_api",
  };
}

/**
 * Name of a rate-limit window by its length: about 5 hours is the "primary_window", about
 * 7 days is the "secondary_window". Null when the length is missing or between the two.
 */
function windowNameByLength(raw: unknown): "primary_window" | "secondary_window" | null {
  const seconds = (raw as { limit_window_seconds?: unknown } | null | undefined)?.limit_window_seconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds <= 24 * 3600) return "primary_window";
  if (seconds >= 6 * 24 * 3600) return "secondary_window";
  return null;
}

export function parseCodexUsage(raw: unknown, now = Date.now()): SubscriptionQuotaWindow[] {
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rate = body.rate_limit as { primary_window?: unknown; secondary_window?: unknown } | undefined;
  // A weekly-only plan (for example prolite) sends its weekly window as "primary_window". The
  // window length tells which window it is, so the weekly usage never shows as the 5-hour one.
  // Position stays the name when a length is unknown or both windows map to the same name.
  const parsed = [
    { position: "primary_window", raw: rate?.primary_window },
    { position: "secondary_window", raw: rate?.secondary_window },
  ].filter((item) => item.raw && typeof item.raw === "object");
  const lengthNames = parsed.map((item) => windowNameByLength(item.raw));
  const useLength = lengthNames.every((name) => name !== null) && new Set(lengthNames).size === lengthNames.length;
  const windows = parsed
    .map((item, index) => windowOf(useLength ? lengthNames[index]! : item.position, item.raw, now))
    .filter((window): window is SubscriptionQuotaWindow => window !== null);
  const extra = body.additional_rate_limits;
  if (Array.isArray(extra)) {
    for (const item of extra) {
      const row = item as { name?: string; limit_name?: string; model?: string; primary_window?: unknown; rate_limit?: { primary_window?: unknown } };
      const parsed = windowOf(String(row.limit_name ?? row.name ?? "additional"), row.rate_limit?.primary_window ?? row.primary_window ?? row, now);
      if (!parsed) continue;
      parsed.model_scope = row.model ?? null;
      windows.push(parsed);
    }
  }
  return windows;
}

/** How many reset credits can clear a limit now. The usage payload carries it; null when it is absent. */
function applicableCreditCount(usageBody: unknown): number | null {
  const block = (usageBody as { rate_limit_reset_credits?: { applicable_available_count?: unknown } } | null)?.rate_limit_reset_credits;
  const count = block?.applicable_available_count;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

/**
 * Reset credits from the credits endpoint. Only credits with status `available` count.
 * A credit is usable now when the plan supports it and at least one credit applies to a limit
 * that is in use; `applicableCount` comes from the usage payload. Null when the body has an
 * unknown shape.
 */
export function parseCodexResetCredits(raw: unknown, applicableCount: number | null, now = Date.now()): SubscriptionResetCredits | null {
  const list = (raw as { credits?: unknown } | null)?.credits;
  if (!Array.isArray(list)) return null;
  const credits: SubscriptionResetCredit[] = [];
  for (const item of list) {
    const credit = item as { id?: unknown; title?: unknown; status?: unknown; expires_at?: unknown; is_supported_by_plan?: unknown } | null;
    if (!credit || credit.status !== "available" || typeof credit.id !== "string" || !credit.id) continue;
    const supported = credit.is_supported_by_plan !== false;
    credits.push({
      id: credit.id,
      label: typeof credit.title === "string" && credit.title ? credit.title : null,
      remaining: 1,
      total: null,
      expires_at: parseResetTime(credit.expires_at),
      usable_now: applicableCount === null ? null : supported && applicableCount > 0,
      unavailable_reason: !supported ? "not_supported_by_plan" : applicableCount === 0 ? "not_applicable" : null,
    });
  }
  credits.sort(byExpiry);
  return { available: credits.length, usable_now: applicableCount, note: null, observed_at: now, credits };
}

async function postToken(fetchImpl: SubscriptionFetch, body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw await readProviderError(response);
  return await response.json() as Record<string, unknown>;
}

function tokensFrom(body: Record<string, unknown>, now: number, previousAccountId = ""): ExchangedSubscriptionTokens {
  const idToken = String(body.id_token ?? "");
  const identity = idToken ? identityFromIdToken(idToken) : { providerAccountId: previousAccountId, accountLabel: "" };
  const accessToken = String(body.access_token ?? "");
  return {
    accessToken,
    refreshToken: String(body.refresh_token ?? ""),
    expiresAt: expiresAtOf(body, accessToken, now),
    providerAccountId: identity.providerAccountId || previousAccountId,
    accountLabel: identity.accountLabel,
  };
}

/**
 * Models the Codex CLI offers: `visibility: "hide"` entries (internal ones such as the auto
 * reviewer) and entries the API cannot serve are dropped. A missing field keeps the entry.
 */
export function parseCodexModels(body: unknown): SourceModelReading[] {
  const list = body && typeof body === "object" ? (body as { models?: unknown }).models : undefined;
  const models = new Map<string, SourceModelReading>();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.slug === "string" ? record.slug.trim() : "";
    if (!id || record.visibility === "hide" || record.supported_in_api === false) continue;
    const name = typeof record.display_name === "string" ? record.display_name.trim() : "";
    models.set(id, { id, display_name: name || id });
  }
  return [...models.values()];
}

function apiHeaders(accessToken: string, providerAccountId: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": providerAccountId,
    accept: "application/json",
  };
}

export function createCodexAdapter(fetchImpl: SubscriptionFetch = fetch): SubscriptionProviderAdapter {
  return {
    provider: "codex",
    async exchangeCode(input: SubscriptionCodeExchangeInput) {
      const body = await postToken(fetchImpl, {
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: input.code,
        redirect_uri: input.redirectUri || REDIRECT_URI,
        code_verifier: input.codeVerifier,
      });
      const tokens = tokensFrom(body, Date.now());
      if (!tokens.providerAccountId) throw new Error("codex token has no chatgpt account id");
      return tokens;
    },
    async refresh(refreshToken: string) {
      const response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw await readProviderError(response);
      return tokensFrom(await response.json() as Record<string, unknown>, Date.now());
    },
    async fetchUsage(accessToken: string, providerAccountId: string) {
      const response = await fetchImpl(USAGE_URL, {
        headers: apiHeaders(accessToken, providerAccountId),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw await readProviderError(response);
      const body = await response.json();
      const windows = parseCodexUsage(body);

      // Credits are extra data. If this call fails, the usage reading stays valid.
      let resetCredits: SubscriptionResetCredits | null = null;
      try {
        const creditsResponse = await fetchImpl(RESET_CREDITS_URL, {
          headers: apiHeaders(accessToken, providerAccountId),
          signal: AbortSignal.timeout(10_000),
        });
        if (creditsResponse.ok) resetCredits = parseCodexResetCredits(await creditsResponse.json(), applicableCreditCount(body));
      } catch {
        resetCredits = null;
      }
      return { windows, resetCredits };
    },
    async fetchModels(accessToken: string, providerAccountId: string, options = {}) {
      const url = new URL(MODELS_URL);
      url.searchParams.set("client_version", options.codexClientVersion?.trim() || DEFAULT_CODEX_CLIENT_VERSION);
      const response = await fetchImpl(url.toString(), {
        headers: { ...apiHeaders(accessToken, providerAccountId), originator: "codex_cli_rs" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw await readProviderError(response);
      return parseCodexModels(await response.json());
    },
    async redeemResetCredit(accessToken: string, providerAccountId: string, input) {
      const response = await fetchImpl(REDEEM_RESET_CREDIT_URL, {
        method: "POST",
        headers: { ...apiHeaders(accessToken, providerAccountId), "content-type": "application/json" },
        body: JSON.stringify({ redeem_request_id: input.requestId, credit_id: input.creditId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw await readProviderError(response);
      const text = await response.text();
      let code: unknown;
      try {
        code = (JSON.parse(text) as { code?: unknown } | null)?.code;
      } catch {
        // A body that is not JSON stays in the message as it is.
      }
      const outcome = typeof code === "string" && code ? code : "unknown";
      return { outcome, resetApplied: outcome === "reset", message: outcome === "unknown" ? shortMessage(text) : null };
    },
  };
}

export const CODEX_OAUTH = {
  CLIENT_ID,
  REDIRECT_URI,
  SCOPE,
  AUTHORIZE_URL: "https://auth.openai.com/oauth/authorize",
  extraParams: {
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  } as Record<string, string>,
};
