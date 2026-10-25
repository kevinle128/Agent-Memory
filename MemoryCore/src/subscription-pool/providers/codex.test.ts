import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCodexAdapter, parseCodexModels, parseCodexResetCredits, parseCodexUsage } from "./codex.js";
import { SubscriptionProviderError, type SubscriptionFetch } from "./types.js";

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

const ID_TOKEN = fakeJwt({
  email: "pool-1@example.com",
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-123", chatgpt_plan_type: "pro" },
});

const USAGE_FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/codex-usage-prolite.json", import.meta.url), "utf8"));
const CREDITS_FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/codex-reset-credits.json", import.meta.url), "utf8"));

interface Captured { url: string; init?: RequestInit }

function fetchReturning(status: number, body: unknown, calls: Captured[] = []): SubscriptionFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

describe("parseCodexUsage", () => {
  it("reads both windows and named extra limits from the usage payload", () => {
    const now = 1_800_000_000_000;
    const windows = parseCodexUsage({
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_after_seconds: 600, reset_at: 1_800_000_600 },
        secondary_window: { used_percent: 7, limit_window_seconds: 604800, reset_after_seconds: 3600, reset_at: null },
      },
      additional_rate_limits: [{ limit_name: "bengalfox", model: "gpt-5-codex", primary_window: { used_percent: 90, reset_at: 1_800_001_000 } }],
    }, now);

    expect(windows).toEqual([
      { name: "primary_window", model_scope: null, used_pct: 42, resets_at: 1_800_000_600_000, observed_at: now, source: "usage_api" },
      { name: "secondary_window", model_scope: null, used_pct: 7, resets_at: now + 3_600_000, observed_at: now, source: "usage_api" },
      { name: "bengalfox", model_scope: "gpt-5-codex", used_pct: 90, resets_at: 1_800_001_000_000, observed_at: now, source: "usage_api" },
    ]);
  });

  it("names a weekly-only window by its length, not by its position", () => {
    const now = 1_793_000_000_000;
    const prolite = JSON.parse(readFileSync(new URL("./fixtures/codex-usage-prolite.json", import.meta.url), "utf8"));
    expect(parseCodexUsage(prolite, now)).toEqual([
      { name: "secondary_window", model_scope: null, used_pct: 14, resets_at: 1_793_083_080_000, observed_at: now, source: "usage_api" },
    ]);
  });

  it("keeps position names when lengths are missing or equal", () => {
    const window = (used: number, seconds?: number) => ({ used_percent: used, limit_window_seconds: seconds, reset_at: null });
    const names = (rate: unknown) => parseCodexUsage({ rate_limit: rate }, 1).map((item) => item.name);
    expect(names({ primary_window: window(1), secondary_window: window(2) })).toEqual(["primary_window", "secondary_window"]);
    expect(names({ primary_window: window(1, 604800), secondary_window: window(2, 604800) })).toEqual(["primary_window", "secondary_window"]);
    expect(names({ primary_window: window(1, 18000) })).toEqual(["primary_window"]);
    expect(names({ primary_window: window(1, 172800) })).toEqual(["primary_window"]);
  });

  it("skips null windows", () => {
    expect(parseCodexUsage({ rate_limit: { primary_window: null, secondary_window: null } })).toEqual([]);
  });
});

describe("codex adapter", () => {
  it("exchanges a code with a form body and reads the account id from the id token", async () => {
    const calls: Captured[] = [];
    const adapter = createCodexAdapter(fetchReturning(200, {
      id_token: ID_TOKEN,
      access_token: fakeJwt({ exp: 1_900_000_000 }),
      refresh_token: "refresh-1",
    }, calls));

    const tokens = await adapter.exchangeCode({ code: "code-1", codeVerifier: "verifier-1", redirectUri: "", state: "s" });

    expect(calls[0].url).toBe("https://auth.openai.com/oauth/token");
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(tokens.providerAccountId).toBe("acct-123");
    expect(tokens.accountLabel).toBe("pool-1@example.com pro");
    expect(tokens.refreshToken).toBe("refresh-1");
    expect(tokens.expiresAt).toBe(1_900_000_000_000);
  });

  it("takes the expiry from the access token when the refresh response has no expires_in", async () => {
    const calls: Captured[] = [];
    const adapter = createCodexAdapter(fetchReturning(200, { access_token: fakeJwt({ exp: 1_900_000_100 }) }, calls));

    const tokens = await adapter.refresh("refresh-old");

    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, string>;
    expect(body).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-old" });
    expect(body.scope).toBeUndefined();
    expect(tokens.expiresAt).toBe(1_900_000_100_000);
    expect(tokens.refreshToken).toBe("");
  });

  it.each(["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"])(
    "treats %s as a permanent refresh failure",
    async (code) => {
      const adapter = createCodexAdapter(fetchReturning(403, { error: { code, message: "no" } }));
      const error = await adapter.refresh("r").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SubscriptionProviderError);
      expect((error as SubscriptionProviderError).permanent).toBe(true);
    },
  );

  it("treats a 5xx refresh failure as transient", async () => {
    const adapter = createCodexAdapter(fetchReturning(502, { error: "bad gateway" }));
    const error = await adapter.refresh("r").catch((e: unknown) => e) as SubscriptionProviderError;
    expect(error.permanent).toBe(false);
  });

  it("calls the usage endpoint with the bearer token and account header", async () => {
    const calls: Captured[] = [];
    const adapter = createCodexAdapter(fetchReturning(200, { rate_limit: { primary_window: { used_percent: 5, reset_at: 1_800_000_000 } } }, calls));

    const reading = await adapter.fetchUsage("access-1", "acct-123");

    expect(calls[0].url).toBe("https://chatgpt.com/backend-api/wham/usage");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-1");
    expect(headers["chatgpt-account-id"]).toBe("acct-123");
    expect(reading.windows).toHaveLength(1);
  });

  it("reads reset credits from the credits endpoint after the usage call", async () => {
    const calls: Captured[] = [];
    const adapter = createCodexAdapter(async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(url.endsWith("/wham/usage") ? USAGE_FIXTURE : CREDITS_FIXTURE), { status: 200 });
    });

    const reading = await adapter.fetchUsage("access-1", "acct-123");

    expect(calls.map((call) => call.url)).toEqual([
      "https://chatgpt.com/backend-api/wham/usage",
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    ]);
    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-1");
    expect(headers["chatgpt-account-id"]).toBe("acct-123");
    expect(reading.windows).toHaveLength(1);
    expect(reading.resetCredits).toMatchObject({ available: 3, usable_now: 0, note: null });
  });

  it("keeps the usage reading when the credits call fails", async () => {
    const failing = createCodexAdapter(async (url) => (
      url.endsWith("/wham/usage")
        ? new Response(JSON.stringify(USAGE_FIXTURE), { status: 200 })
        : new Response("down", { status: 500 })
    ));
    const throwing = createCodexAdapter(async (url) => {
      if (!url.endsWith("/wham/usage")) throw new Error("network down");
      return new Response(JSON.stringify(USAGE_FIXTURE), { status: 200 });
    });
    for (const adapter of [failing, throwing]) {
      const reading = await adapter.fetchUsage("access-1", "acct-123");
      expect(reading.windows).toHaveLength(1);
      expect(reading.resetCredits).toBeNull();
    }
  });

  it("redeems a credit with a JSON body and reports the outcome", async () => {
    const calls: Captured[] = [];
    const adapter = createCodexAdapter(fetchReturning(200, { code: "reset", windows_reset: ["primary"] }, calls));

    const result = await adapter.redeemResetCredit("access-1", "acct-123", { creditId: "credit-1", requestId: "request-1" });

    expect(calls[0].url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-1");
    expect(headers["chatgpt-account-id"]).toBe("acct-123");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ redeem_request_id: "request-1", credit_id: "credit-1" });
    expect(result).toEqual({ outcome: "reset", resetApplied: true, message: null });
  });

  it("does not count other outcomes as a reset, and fails on a provider error", async () => {
    const none = await createCodexAdapter(fetchReturning(200, { code: "nothing_to_reset" }))
      .redeemResetCredit("a", "b", { creditId: "c", requestId: "r" });
    expect(none).toMatchObject({ outcome: "nothing_to_reset", resetApplied: false });
    const error = await createCodexAdapter(fetchReturning(403, { error: { message: "no" } }))
      .redeemResetCredit("a", "b", { creditId: "c", requestId: "r" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubscriptionProviderError);
  });

  it("does not put a token into a provider error message", async () => {
    const adapter = createCodexAdapter(fetchReturning(401, { error: { message: "token expired" } }));
    const error = await adapter.fetchUsage("access-secret", "acct").catch((e: unknown) => e) as Error;
    expect(error.message).not.toContain("access-secret");
  });

  it("treats a 400 without a known error code as transient", async () => {
    const adapter = createCodexAdapter(fetchReturning(400, { error: { message: "malformed" } }));
    const error = await adapter.refresh("r").catch((e: unknown) => e) as SubscriptionProviderError;
    expect(error.permanent).toBe(false);
  });

  it("treats invalid_grant and a 401 as permanent", async () => {
    const grant = await createCodexAdapter(fetchReturning(400, { error: "invalid_grant" })).refresh("r").catch((e: unknown) => e) as SubscriptionProviderError;
    const unauthorized = await createCodexAdapter(fetchReturning(401, {})).refresh("r").catch((e: unknown) => e) as SubscriptionProviderError;
    expect([grant.permanent, unauthorized.permanent]).toEqual([true, true]);
  });

  it("skips extra limit rows without a usage percent and reads nested rate limits", () => {
    const windows = parseCodexUsage({
      additional_rate_limits: [
        { limit_name: "unknown-shape", metered_feature: "x" },
        { limit_name: "nested", rate_limit: { primary_window: { used_percent: 55, reset_at: 1_800_000_000 } } },
      ],
    }, 1);
    expect(windows).toEqual([expect.objectContaining({ name: "nested", used_pct: 55 })]);
  });
});

describe("parseCodexResetCredits", () => {
  const now = 1_793_000_000_000;

  it("lists available credits by expiry and marks them unusable when no limit applies", () => {
    const credits = parseCodexResetCredits(CREDITS_FIXTURE, 0, now);
    expect(credits?.available).toBe(3);
    expect(credits?.usable_now).toBe(0);
    expect(credits?.observed_at).toBe(now);
    expect(credits?.credits.map((credit) => credit.expires_at)).toEqual([
      Date.parse("2026-10-22T18:47:23.536914Z"),
      Date.parse("2026-10-29T18:37:36.265852Z"),
      Date.parse("2026-11-06T22:55:00.186289Z"),
    ]);
    expect(credits?.credits[0]).toMatchObject({
      id: "RateLimitResetCredit_42d4ee458b4481918c1d2779d413f6d6",
      label: "Full reset",
      remaining: 1,
      total: null,
      usable_now: false,
      unavailable_reason: "not_applicable",
    });
  });

  it("marks credits usable when a limit applies, and unknown when the count is missing", () => {
    expect(parseCodexResetCredits(CREDITS_FIXTURE, 2, now)?.credits.every((credit) => credit.usable_now === true)).toBe(true);
    const unknown = parseCodexResetCredits(CREDITS_FIXTURE, null, now);
    expect(unknown?.usable_now).toBeNull();
    expect(unknown?.credits[0]?.usable_now).toBeNull();
  });

  it("skips credits that are not available and gives null for an unknown shape", () => {
    const body = { credits: [
      { id: "used", status: "redeemed", expires_at: "2026-10-30T00:00:00Z" },
      { id: "plan", status: "available", is_supported_by_plan: false, expires_at: null },
    ] };
    const credits = parseCodexResetCredits(body, 1, now);
    expect(credits?.credits).toEqual([expect.objectContaining({ id: "plan", usable_now: false, unavailable_reason: "not_supported_by_plan", expires_at: null })]);
    expect(parseCodexResetCredits({ nope: true }, 1, now)).toBeNull();
    expect(parseCodexResetCredits(null, 1, now)).toBeNull();
  });
});

describe("codex model list", () => {
  const MODELS = JSON.parse(readFileSync(new URL("./fixtures/codex-models.json", import.meta.url), "utf8"));

  it("calls the Codex models endpoint with the account headers and the configured client version", async () => {
    const calls: Captured[] = [];
    const adapter = createCodexAdapter(fetchReturning(200, MODELS, calls));
    await adapter.fetchModels("access-1", "acct-9", { codexClientVersion: "0.170.1" });

    expect(calls[0].url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.170.1");
    expect(calls[0].init?.headers).toMatchObject({
      authorization: "Bearer access-1",
      "chatgpt-account-id": "acct-9",
      originator: "codex_cli_rs",
    });
    expect(calls[0].init?.redirect).toBe("error");
  });

  it("falls back to the default client version", async () => {
    const calls: Captured[] = [];
    await createCodexAdapter(fetchReturning(200, MODELS, calls)).fetchModels("a", "b");
    expect(calls[0].url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.164.0");
  });

  it("keeps the 7 listed models and drops the hidden ones", async () => {
    const models = await createCodexAdapter(fetchReturning(200, MODELS)).fetchModels("a", "b");
    expect(models.map((m) => m.id)).toEqual([
      "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
    ]);
    expect(models[0].display_name).toBe("GPT-6.1 Sol");
  });

  it("keeps a model with no visibility and drops one the API cannot serve", () => {
    expect(parseCodexModels({
      models: [
        { slug: "no-visibility" },
        { slug: "api-off", visibility: "list", supported_in_api: false },
        { slug: "hidden", visibility: "hide" },
        { slug: "named", display_name: "Named One" },
        { display_name: "no slug" },
      ],
    })).toEqual([
      { id: "no-visibility", display_name: "no-visibility" },
      { id: "named", display_name: "Named One" },
    ]);
    expect(parseCodexModels({})).toEqual([]);
  });

  it("raises a provider error when the call is refused", async () => {
    const error = await createCodexAdapter(fetchReturning(403, { error: "forbidden" })).fetchModels("a", "b").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubscriptionProviderError);
    expect((error as SubscriptionProviderError).status).toBe(403);
  });
});
