import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANTIGRAVITY_OAUTH,
  ANTIGRAVITY_OAUTH_NOT_CONFIGURED,
  AntigravityOAuthNotConfiguredError,
  createAntigravityAdapter,
  parseAntigravityModels,
  parseAntigravityUsage,
} from "./antigravity.js";
import { SubscriptionProviderError, type SubscriptionFetch } from "./types.js";

const MODELS_FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/antigravity-available-models.json", import.meta.url), "utf8"));

interface Captured { url: string; init?: RequestInit }
type Reply = { status?: number; body: unknown };

/** Answers each call from the queue in order and records every request. */
function scripted(replies: Reply[], calls: Captured[] = []): SubscriptionFetch {
  const queue = [...replies];
  return async (url, init) => {
    calls.push({ url, init });
    const reply = queue.shift();
    if (!reply) throw new Error(`unexpected call to ${url}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  };
}

const TOKEN_REPLY = { body: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3599 } };
const USERINFO_REPLY = { body: { email: "pool-1@example.com" } };
const noSleep = async () => {};
const TEST_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const TEST_CLIENT_SECRET = "test-secret";

beforeEach(() => {
  vi.stubEnv("ANTIGRAVITY_OAUTH_CLIENT_ID", TEST_CLIENT_ID);
  vi.stubEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET", TEST_CLIENT_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("antigravity Cloud Code host", () => {
  it("uses the daily host for every Cloud Code call by default", async () => {
    const calls: Captured[] = [];
    const adapter = createAntigravityAdapter(scripted([
      TOKEN_REPLY, USERINFO_REPLY, { body: {} }, { body: { done: true, response: { cloudaicompanionProject: "p" } } },
      { body: MODELS_FIXTURE }, { body: MODELS_FIXTURE },
    ], calls));
    await adapter.exchangeCode({ code: "c", codeVerifier: "", redirectUri: "", state: "s" });
    await adapter.fetchUsage("a", "x", { projectId: "p" });
    await adapter.fetchModels("a", "x", { projectId: "p" });
    expect(calls.slice(2).map((call) => call.url)).toEqual([
      "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    ]);
  });

  it("takes the host from ANTIGRAVITY_CLOUD_CODE_URL and ignores a trailing slash", async () => {
    vi.stubEnv("ANTIGRAVITY_CLOUD_CODE_URL", "https://cloudcode-pa.googleapis.com/");
    const calls: Captured[] = [];
    const adapter = createAntigravityAdapter(scripted([{ body: MODELS_FIXTURE }], calls));
    await adapter.fetchModels("a", "x", { projectId: "p" });
    expect(calls[0]!.url).toBe("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
  });

  it("reports the current CLI version in the user agent", async () => {
    const calls: Captured[] = [];
    await createAntigravityAdapter(scripted([{ body: MODELS_FIXTURE }], calls)).fetchModels("a", "x");
    expect((calls[0]!.init!.headers as Record<string, string>)["user-agent"]).toContain("antigravity/cli/1.5.13 (aidev_client;");
    expect((calls[0]!.init!.headers as Record<string, string>)["user-agent"]).toContain("cl=1025641825;");
  });
});

describe("antigravity OAuth client from the environment", () => {
  it("reads the client id at call time", () => {
    expect(ANTIGRAVITY_OAUTH.CLIENT_ID).toBe(TEST_CLIENT_ID);
    vi.stubEnv("ANTIGRAVITY_OAUTH_CLIENT_ID", "other-id");
    expect(ANTIGRAVITY_OAUTH.CLIENT_ID).toBe("other-id");
  });

  it.each(["ANTIGRAVITY_OAUTH_CLIENT_ID", "ANTIGRAVITY_OAUTH_CLIENT_SECRET"])("fails with a clear error when %s is missing", async (name) => {
    vi.stubEnv(name, "");
    const adapter = createAntigravityAdapter(scripted([]));
    for (const failure of [
      adapter.exchangeCode({ code: "c", codeVerifier: "", redirectUri: "", state: "s" }),
      adapter.refresh("r"),
    ]) {
      const error = await failure.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AntigravityOAuthNotConfiguredError);
      expect((error as Error).message).toBe(ANTIGRAVITY_OAUTH_NOT_CONFIGURED);
      expect(error).toMatchObject({ permanent: false });
    }
  });

  it("names both variables in the message", () => {
    expect(ANTIGRAVITY_OAUTH_NOT_CONFIGURED).toBe("AntiGravity OAuth is not configured: set ANTIGRAVITY_OAUTH_CLIENT_ID and ANTIGRAVITY_OAUTH_CLIENT_SECRET");
  });
});

describe("ANTIGRAVITY_OAUTH", () => {
  it("logs in without PKCE through the fixed local callback and asks for offline access", () => {
    expect(ANTIGRAVITY_OAUTH.PKCE).toBe(false);
    expect(ANTIGRAVITY_OAUTH.REDIRECT_URI).toBe("http://localhost:51121/callback");
    expect(ANTIGRAVITY_OAUTH.extraParams).toEqual({ access_type: "offline", prompt: "consent" });
    expect(ANTIGRAVITY_OAUTH.SCOPE).toContain("https://www.googleapis.com/auth/cloud-platform");
  });
});

describe("antigravity exchangeCode", () => {
  it("exchanges the code with the client secret, then reads the e-mail and the project", async () => {
    const calls: Captured[] = [];
    const adapter = createAntigravityAdapter(scripted([
      TOKEN_REPLY,
      USERINFO_REPLY,
      { body: { cloudaicompanionProject: "aicode-consumers", currentTier: { id: "free-tier" } } },
    ], calls));
    const result = await adapter.exchangeCode({ code: "code-1", codeVerifier: "", redirectUri: "http://localhost:51121/callback", state: "s" });
    expect(result).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      providerAccountId: "pool-1@example.com",
      accountLabel: "pool-1@example.com",
      projectId: "aicode-consumers",
    });
    expect(result.expiresAt).toBeGreaterThan(Date.now());

    const form = new URLSearchParams(String(calls[0]!.init!.body));
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "http://localhost:51121/callback",
    });
    expect(form.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(form.get("client_secret")).toBe(TEST_CLIENT_SECRET);
    expect(form.has("code_verifier")).toBe(false);
    expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe("Bearer access-1");

    const load = calls[2]!;
    expect(load.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
    expect(JSON.parse(String(load.init!.body))).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
    expect((load.init!.headers as Record<string, string>)["user-agent"]).toMatch(/^antigravity\/cli\/[\d.]+ \(aidev_client; os_type=\w+; arch=\w+; cl=\d+; auth_method=consumer\)$/);
  });

  it("reads a project that comes as an object", async () => {
    const adapter = createAntigravityAdapter(scripted([TOKEN_REPLY, USERINFO_REPLY, { body: { cloudaicompanionProject: { id: "proj-obj" } } }]));
    expect((await adapter.exchangeCode({ code: "c", codeVerifier: "", redirectUri: "", state: "s" })).projectId).toBe("proj-obj");
  });

  it("onboards the user with the default tier until the project arrives", async () => {
    const calls: Captured[] = [];
    const adapter = createAntigravityAdapter(scripted([
      TOKEN_REPLY,
      USERINFO_REPLY,
      { body: { allowedTiers: [{ id: "other" }, { id: "free-tier", isDefault: true }] } },
      { body: { done: false } },
      { body: { done: true, response: { cloudaicompanionProject: { id: "proj-new" } } } },
    ], calls), { onboardDelayMs: 0, sleep: noSleep });
    const result = await adapter.exchangeCode({ code: "c", codeVerifier: "", redirectUri: "", state: "s" });
    expect(result.projectId).toBe("proj-new");
    expect(calls[3]!.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser");
    expect(JSON.parse(String(calls[3]!.init!.body))).toEqual({ tierId: "free-tier", metadata: { ideType: "ANTIGRAVITY" } });
  });

  it("fails the login when onboarding never yields a project", async () => {
    const adapter = createAntigravityAdapter(scripted([
      TOKEN_REPLY,
      USERINFO_REPLY,
      { body: {} },
      { body: { done: false } },
      { body: { done: false } },
    ]), { onboardAttempts: 2, onboardDelayMs: 0, sleep: noSleep });
    await expect(adapter.exchangeCode({ code: "c", codeVerifier: "", redirectUri: "", state: "s" })).rejects.toThrow("no cloud project");
  });

  it("fails the login when userinfo has no e-mail", async () => {
    const adapter = createAntigravityAdapter(scripted([TOKEN_REPLY, { body: {} }]));
    await expect(adapter.exchangeCode({ code: "c", codeVerifier: "", redirectUri: "", state: "s" })).rejects.toThrow("no email");
  });

  it("marks invalid_grant as permanent and never puts tokens in the error", async () => {
    const adapter = createAntigravityAdapter(scripted([{ status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } }]));
    const error = await adapter.exchangeCode({ code: "c", codeVerifier: "", redirectUri: "", state: "s" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubscriptionProviderError);
    expect(error).toMatchObject({ permanent: true, status: 400 });
  });
});

describe("antigravity refresh", () => {
  it("sends the client secret and leaves the refresh token empty when Google returns none", async () => {
    const calls: Captured[] = [];
    const adapter = createAntigravityAdapter(scripted([{ body: { access_token: "access-2", expires_in: 3600 } }], calls));
    const result = await adapter.refresh("refresh-1");
    expect(result).toMatchObject({ accessToken: "access-2", refreshToken: "" });
    const form = new URLSearchParams(String(calls[0]!.init!.body));
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1" });
    expect(form.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(form.get("client_secret")).toBe(TEST_CLIENT_SECRET);
  });

  it("keeps a rotated refresh token", async () => {
    const adapter = createAntigravityAdapter(scripted([{ body: { access_token: "a", refresh_token: "r2", expires_in: 10 } }]));
    expect((await adapter.refresh("r1")).refreshToken).toBe("r2");
  });

  it("treats a revoked refresh token as permanent and a server error as transient", async () => {
    const revoked = createAntigravityAdapter(scripted([{ status: 400, body: { error: "invalid_grant" } }]));
    await expect(revoked.refresh("r")).rejects.toMatchObject({ permanent: true });
    const flaky = createAntigravityAdapter(scripted([{ status: 503, body: {} }]));
    await expect(flaky.refresh("r")).rejects.toMatchObject({ permanent: false, status: 503 });
  });
});

describe("parseAntigravityUsage", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");

  it("maps every model with quota info to its own scoped window", () => {
    const windows = parseAntigravityUsage(MODELS_FIXTURE, now);
    expect(windows.map((w) => w.model_scope)).toEqual(["claude-opus-5-5-high", "gemini-4-carbon-low", "claude-sonnet-5-5-low"]);
    expect(windows.every((w) => w.name === "quota" && w.source === "usage_api" && w.observed_at === now)).toBe(true);
    expect(windows[0]).toMatchObject({ used_pct: 75, resets_at: Date.parse("2026-11-19T03:00:00Z") });
    expect(windows[1]).toMatchObject({ used_pct: 0 });
  });

  it("reads a model with quota info but no remaining fraction as used up", () => {
    const windows = parseAntigravityUsage(MODELS_FIXTURE, now);
    expect(windows[2]).toMatchObject({ used_pct: 100, resets_at: Date.parse("2026-11-19T04:30:00Z") });
  });

  it("leaves out helper and image ids, as the model list does", () => {
    const scopes = parseAntigravityUsage(MODELS_FIXTURE, now).map((w) => w.model_scope);
    expect(scopes).not.toContain("tab_jump_flash_lite_preview");
    expect(scopes).not.toContain("gemini-3-pro-image");
    expect(scopes).not.toContain("chat_internal_1");
  });

  it("never produces a shared window, so one drained model cannot stop the account", () => {
    expect(parseAntigravityUsage(MODELS_FIXTURE, now).every((w) => Boolean(w.model_scope))).toBe(true);
  });

  it("returns nothing for an unknown payload", () => {
    expect(parseAntigravityUsage(null)).toEqual([]);
    expect(parseAntigravityUsage({ models: [] })).toEqual([]);
  });
});

describe("parseAntigravityModels", () => {
  it("lists the models by id and drops internal ones", () => {
    expect(parseAntigravityModels(MODELS_FIXTURE)).toEqual([
      { id: "claude-opus-5-5-high", display_name: "Claude Opus 5.5 (High)" },
      { id: "gemini-4-carbon-low", display_name: "Gemini 4 Carbon (Low)" },
      { id: "claude-sonnet-5-5-low", display_name: "Claude Sonnet 5.5 (Low)" },
    ]);
  });

  it.each(["chat_20706", "tab_flash_lite", "gemini-4-disabled", "gemini-4-tiered", "gemini-3-sonar", "gemini-3-pro-image"])(
    "drops the non-chat id %s",
    (id) => {
      expect(parseAntigravityModels({ models: { [id]: { displayName: "x" }, "gemini-4-carbon-low": {} } }).map((m) => m.id))
        .toEqual(["gemini-4-carbon-low"]);
    },
  );
});

describe("antigravity fetchUsage and fetchModels", () => {
  it("posts the project to fetchAvailableModels and returns no reset credits", async () => {
    const calls: Captured[] = [];
    const adapter = createAntigravityAdapter(scripted([{ body: MODELS_FIXTURE }, { body: MODELS_FIXTURE }], calls));
    const usage = await adapter.fetchUsage("access-1", "pool-1@example.com", { projectId: "proj-1" });
    expect(usage.resetCredits).toBeNull();
    expect(usage.windows).toHaveLength(3);
    expect(calls[0]!.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ project: "proj-1" });
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer access-1");

    const models = await adapter.fetchModels("access-1", "pool-1@example.com", { projectId: "proj-1" });
    expect(models.map((m) => m.id)).toContain("claude-opus-5-5-high");
  });

  it("throws a provider error with the status when Google refuses", async () => {
    const adapter = createAntigravityAdapter(scripted([{ status: 401, body: { error: { message: "expired" } } }]));
    await expect(adapter.fetchModels("bad", "x")).rejects.toMatchObject({ status: 401, permanent: true });
  });
});
