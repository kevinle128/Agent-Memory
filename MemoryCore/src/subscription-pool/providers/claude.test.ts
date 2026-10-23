import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createClaudeAdapter, parseClaudeResetCredits, parseClaudeUsage } from "./claude.js";
import { SubscriptionProviderError, type SubscriptionFetch } from "./types.js";

interface Captured { url: string; init?: RequestInit }

function fetchReturning(status: number, body: unknown, calls: Captured[] = []): SubscriptionFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

function fetchByUrl(handlers: Record<string, { status: number; body: unknown }>, calls: Captured[] = []): SubscriptionFetch {
  return async (url, init) => {
    calls.push({ url, init });
    const match = handlers[url];
    if (!match) return new Response("missing", { status: 404 });
    return new Response(JSON.stringify(match.body), { status: match.status, headers: { "content-type": "application/json" } });
  };
}

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";
const CLI_USER_AGENT = "claude-cli/2.1.308 (external, cli)";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const GRANT_BLOCK = fixture("claude-cedar-ember-grant.json");
const NO_GRANT_BLOCK = fixture("claude-cedar-ember-no-grant.json");

describe("parseClaudeUsage", () => {
  const now = 1_800_000_000_000;

  it("reads the flat windows and skips ones the payload omits", () => {
    const windows = parseClaudeUsage({
      five_hour: { utilization: 42, resets_at: "2027-01-15T00:10:00.000Z" },
      seven_day: { utilization: 7, resets_at: null },
      seven_day_opus: { utilization: 90, resets_at: 1_800_001_000 },
    }, now);
    expect(windows).toEqual([
      { name: "five_hour", model_scope: null, used_pct: 42, resets_at: Date.parse("2027-01-15T00:10:00.000Z"), observed_at: now, source: "usage_api" },
      { name: "seven_day", model_scope: null, used_pct: 7, resets_at: null, observed_at: now, source: "usage_api" },
      { name: "seven_day_opus", model_scope: "opus", used_pct: 90, resets_at: 1_800_001_000_000, observed_at: now, source: "usage_api" },
    ]);
  });

  it("prefers limits[] and maps session and weekly windows onto the meter names", () => {
    const windows = parseClaudeUsage({
      five_hour: { utilization: 1, resets_at: null },
      limits: [
        { kind: "session", percent: 12, resets_at: "2027-01-15T01:00:00.000Z", is_active: true },
        { kind: "weekly_all", percent: 3, resets_at: null, is_active: true },
        { kind: "weekly_scoped", percent: 80, resets_at: 1_800_002_000, is_active: true, scope: { model: { id: "claude-opus-4-6", display_name: "Opus" } } },
        { kind: "weekly_scoped", percent: 99, is_active: false, scope: { model: { id: "claude-sonnet" } } },
        { kind: "weekly_scoped", group: "no-percent" },
      ],
    }, now);
    expect(windows).toEqual([
      { name: "five_hour", model_scope: null, used_pct: 12, resets_at: Date.parse("2027-01-15T01:00:00.000Z"), observed_at: now, source: "usage_api" },
      { name: "seven_day", model_scope: null, used_pct: 3, resets_at: null, observed_at: now, source: "usage_api" },
      { name: "weekly_scoped", model_scope: "claude-opus-4-6", used_pct: 80, resets_at: 1_800_002_000_000, observed_at: now, source: "usage_api" },
      { name: "weekly_scoped", model_scope: "claude-sonnet", used_pct: 99, resets_at: null, observed_at: now, source: "usage_api" },
    ]);
  });

  it("keeps inactive limits and scopes a model limit that has only a display name", () => {
    const windows = parseClaudeUsage({
      five_hour: { utilization: 16, resets_at: "2026-10-21T16:29:59.953971+00:00" },
      seven_day_opus: null,
      limits: [
        { kind: "session", group: "session", percent: 16, resets_at: "2026-10-21T16:29:59.953971+00:00", scope: null, is_active: true },
        { kind: "weekly_all", group: "weekly", percent: 5, resets_at: "2026-10-26T15:59:59.953992+00:00", scope: null, is_active: false },
        { kind: "weekly_scoped", group: "weekly", percent: 100, resets_at: "2026-10-26T16:00:00+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
        { kind: "weekly_scoped", group: "weekly", percent: 1, resets_at: null, scope: null, is_active: false },
      ],
    }, now);
    expect(windows).toEqual([
      { name: "five_hour", model_scope: null, used_pct: 16, resets_at: Date.parse("2026-10-21T16:29:59.953971+00:00"), observed_at: now, source: "usage_api" },
      { name: "seven_day", model_scope: null, used_pct: 5, resets_at: Date.parse("2026-10-26T15:59:59.953992+00:00"), observed_at: now, source: "usage_api" },
      { name: "weekly_scoped", model_scope: "Fable", used_pct: 100, resets_at: Date.parse("2026-10-26T16:00:00+00:00"), observed_at: now, source: "usage_api" },
      { name: "weekly_scoped", model_scope: "weekly_scoped", used_pct: 1, resets_at: null, observed_at: now, source: "usage_api" },
    ]);
  });

  it("returns nothing for an empty payload", () => {
    expect(parseClaudeUsage({})).toEqual([]);
    expect(parseClaudeUsage(null)).toEqual([]);
  });
});

describe("claude adapter", () => {
  it("exchanges a code as JSON and reads the account from the token response", async () => {
    const calls: Captured[] = [];
    const adapter = createClaudeAdapter(fetchReturning(200, {
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 28800,
      account: { uuid: "acct-claude", email_address: "pool@example.com" },
      organization: { organization_type: "claude_pro" },
    }, calls));

    const tokens = await adapter.exchangeCode({
      code: "code-1",
      codeVerifier: "verifier-1",
      redirectUri: "",
      state: "state-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TOKEN_URL);
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, string>;
    expect(body).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      code_verifier: "verifier-1",
      state: "state-1",
    });
    expect((calls[0].init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(tokens).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      providerAccountId: "acct-claude",
      accountLabel: "pool@example.com claude_pro",
    });
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it("loads the profile when the token response has no account id", async () => {
    const calls: Captured[] = [];
    const adapter = createClaudeAdapter(fetchByUrl({
      [TOKEN_URL]: { status: 200, body: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 } },
      [PROFILE_URL]: {
        status: 200,
        body: { account: { uuid: "acct-from-profile", email: "from-profile@example.com" }, organization: { organization_type: "claude_max" } },
      },
    }, calls));

    const tokens = await adapter.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "https://platform.claude.com/oauth/code/callback", state: "s" });

    expect(calls.map((call) => call.url)).toEqual([TOKEN_URL, PROFILE_URL]);
    expect((calls[1].init?.headers as Record<string, string>).authorization).toBe("Bearer access-1");
    expect(tokens.providerAccountId).toBe("acct-from-profile");
    expect(tokens.accountLabel).toBe("from-profile@example.com claude_max");
  });

  it("rejects a login that never yields an account id", async () => {
    const adapter = createClaudeAdapter(fetchByUrl({
      [TOKEN_URL]: { status: 200, body: { access_token: "access-1" } },
      [PROFILE_URL]: { status: 200, body: { account: {} } },
    }));
    await expect(adapter.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "https://x", state: "s" }))
      .rejects.toThrow("claude token has no account id");
  });

  it("refreshes with JSON and keeps a rotated refresh token", async () => {
    const calls: Captured[] = [];
    const adapter = createClaudeAdapter(fetchReturning(200, {
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 28800,
    }, calls));

    const tokens = await adapter.refresh("refresh-old");

    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, string>;
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("refresh-old");
    expect(body.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(body.scope).toContain("user:inference");
    expect(tokens.refreshToken).toBe("refresh-new");
    expect(tokens.accessToken).toBe("access-new");
    expect(tokens.providerAccountId).toBe("");
  });

  it("returns an empty refresh token when the provider omits one, so the stored token is kept", async () => {
    const adapter = createClaudeAdapter(fetchReturning(200, { access_token: "access-new", expires_in: 60 }));
    const tokens = await adapter.refresh("refresh-old");
    expect(tokens.refreshToken).toBe("");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it.each(["invalid_grant", "invalid_refresh_token"])("treats %s as a permanent refresh failure", async (code) => {
    const adapter = createClaudeAdapter(fetchReturning(400, { error: code }));
    const error = await adapter.refresh("r").catch((e: unknown) => e) as SubscriptionProviderError;
    expect(error).toBeInstanceOf(SubscriptionProviderError);
    expect(error.permanent).toBe(true);
  });

  it("treats a 400 without a known code and a 429 as transient", async () => {
    const malformed = await createClaudeAdapter(fetchReturning(400, { error: { message: "malformed" } })).refresh("r").catch((e: unknown) => e) as SubscriptionProviderError;
    const limited = await createClaudeAdapter(fetchReturning(429, { error: "rate_limited" })).refresh("r").catch((e: unknown) => e) as SubscriptionProviderError;
    expect(malformed.permanent).toBe(false);
    expect(limited.permanent).toBe(false);
  });

  it("calls the usage endpoint with the bearer token and the oauth beta", async () => {
    const calls: Captured[] = [];
    const adapter = createClaudeAdapter(fetchReturning(200, { five_hour: { utilization: 5, resets_at: 1_800_000_000 } }, calls));

    const reading = await adapter.fetchUsage("access-1", "unused");

    expect(calls[0].url).toBe(USAGE_URL);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-1");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(headers["user-agent"]).toBe(CLI_USER_AGENT);
    expect(reading.windows).toHaveLength(1);
    expect(reading.windows[0]?.name).toBe("five_hour");
    expect(reading.resetCredits).toBeNull();
  });

  it("reads windows and reset credits from one usage call", async () => {
    const calls: Captured[] = [];
    const adapter = createClaudeAdapter(fetchReturning(200, {
      five_hour: { utilization: 5, resets_at: 1_800_000_000 },
      cedar_ember: NO_GRANT_BLOCK,
    }, calls));

    const reading = await adapter.fetchUsage("access-1", "unused");

    expect(calls).toHaveLength(1);
    expect(reading.windows).toHaveLength(1);
    expect(reading.resetCredits).toMatchObject({ available: 0, note: "no_grant", credits: [] });
  });

  it("redeems through the organization route found in the profile", async () => {
    const calls: Captured[] = [];
    const adapter = createClaudeAdapter(async (url, init) => {
      calls.push({ url, init });
      if (url === PROFILE_URL) return new Response(JSON.stringify({ organization: { uuid: "org-1" } }), { status: 200 });
      return new Response(JSON.stringify({ result: "reset" }), { status: 200 });
    });

    const result = await adapter.redeemResetCredit("access-1", "unused", { creditId: "grant-1", requestId: "request-1" });

    expect(calls.map((call) => call.url)).toEqual([PROFILE_URL, "https://api.anthropic.com/api/organizations/org-1/reset_rate_limits"]);
    const profileHeaders = calls[0].init?.headers as Record<string, string>;
    expect(profileHeaders["user-agent"]).toBe(CLI_USER_AGENT);
    expect(profileHeaders["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(calls[1].init?.method).toBe("POST");
    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-1");
    expect(headers["user-agent"]).toBe(CLI_USER_AGENT);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ program: "cedar_ember", grant_id: "grant-1", request_id: "request-1" });
    expect(result).toEqual({ outcome: "reset", resetApplied: true, message: null });
  });

  it("keeps the raw text when the redeem response has no known result field", async () => {
    const adapter = createClaudeAdapter(async (url) => (
      url === PROFILE_URL
        ? new Response(JSON.stringify({ organization: { uuid: "org-1" } }), { status: 200 })
        : new Response("something new", { status: 200 })
    ));
    const result = await adapter.redeemResetCredit("a", "b", { creditId: "g", requestId: "r" });
    expect(result).toEqual({ outcome: "unknown", resetApplied: false, message: "something new" });
  });

  it("fails the redeem when the profile has no organization or the provider rejects", async () => {
    const noOrg = createClaudeAdapter(fetchReturning(200, { account: {} }));
    await expect(noOrg.redeemResetCredit("a", "b", { creditId: "g", requestId: "r" })).rejects.toThrow("organization");
    const rejected = createClaudeAdapter(async (url) => (
      url === PROFILE_URL
        ? new Response(JSON.stringify({ organization: { uuid: "org-1" } }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: "nope" } }), { status: 403 })
    ));
    const error = await rejected.redeemResetCredit("a", "b", { creditId: "g", requestId: "r" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubscriptionProviderError);
  });

  it("does not put a token into a provider error message", async () => {
    const adapter = createClaudeAdapter(fetchReturning(401, { error: { message: "token expired" } }));
    const error = await adapter.fetchUsage("access-secret", "acct").catch((e: unknown) => e) as Error;
    expect(error.message).not.toContain("access-secret");
    expect(error).toBeInstanceOf(SubscriptionProviderError);
    expect((error as SubscriptionProviderError).permanent).toBe(true);
  });
});

describe("parseClaudeResetCredits", () => {
  const now = 1_800_000_000_000;

  it("keeps only grants with resets left", () => {
    expect(parseClaudeResetCredits({ cedar_ember: GRANT_BLOCK }, now)).toEqual({
      available: 0, usable_now: 0, note: null, observed_at: now, credits: [],
    });
    const withLeft = { ...GRANT_BLOCK, grants: [
      { ...GRANT_BLOCK.grants[0], id: "late", resets_left: 1, usable_now: true, unavailable_reason: null, ends_at: "2026-11-30T00:00:00+00:00" },
      { ...GRANT_BLOCK.grants[0], id: "none", resets_left: 0 },
      { ...GRANT_BLOCK.grants[0], id: "soon", resets_left: 2, resets_total: 3, usable_now: false, ends_at: "2026-11-01T00:00:00+00:00" },
      { ...GRANT_BLOCK.grants[0], id: "never", resets_left: 1, ends_at: null },
    ] };
    const parsed = parseClaudeResetCredits({ cedar_ember: withLeft }, now)!;
    expect(parsed.credits.map((credit) => credit.id)).toEqual(["soon", "late", "never"]);
    expect(parsed.available).toBe(4);
    expect(parsed.usable_now).toBe(1);
    expect(parsed.credits[0]).toMatchObject({
      remaining: 2, total: 3, expires_at: Date.parse("2026-11-01T00:00:00+00:00"), usable_now: false, unavailable_reason: "unavailable",
    });
  });

  it("gives the ineligible reason as a note and no credit", () => {
    expect(parseClaudeResetCredits({ cedar_ember: NO_GRANT_BLOCK }, now)).toEqual({
      available: 0, usable_now: 0, note: "no_grant", observed_at: now, credits: [],
    });
  });

  it("gives null when the block is missing or has an unknown shape", () => {
    expect(parseClaudeResetCredits({}, now)).toBeNull();
    expect(parseClaudeResetCredits({ cedar_ember: "x" }, now)).toBeNull();
    expect(parseClaudeResetCredits({ cedar_ember: { eligible: true } }, now)).toBeNull();
    expect(parseClaudeResetCredits(null, now)).toBeNull();
  });
});
