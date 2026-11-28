import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubscriptionQuotaWindow } from "../metadata/types.js";
import { SubscriptionProviderError } from "./providers/types.js";
import { RELOGIN_NEEDED } from "./token-refresher.js";
import { checkAccountUsage, USAGE_CHECK_FAILED } from "./usage-check.js";
import { createPoolFixture, fakeAdapter, tokens, usageReading, type PoolFixture } from "./test-support.js";

const MIN = 60 * 1000;
const NOW = 1_800_000_000_000;

function win(used_pct: number, resets_at: number | null, partial: Partial<SubscriptionQuotaWindow> = {}): SubscriptionQuotaWindow {
  return { name: "primary_window", model_scope: null, used_pct, resets_at, observed_at: NOW, source: "usage_api", ...partial };
}

describe("checkAccountUsage", () => {
  let fx: PoolFixture;

  beforeEach(async () => {
    fx = await createPoolFixture();
  });

  afterEach(async () => {
    await fx.store.close();
  });

  it("stores the usage reading and clears the failure count", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { usage_fail_count: 2, last_error: USAGE_CHECK_FAILED });
    const adapter = fakeAdapter({ fetchUsage: async () => usageReading([win(30, NOW + 60 * MIN)]) });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.failed).toBe(false);
    expect(result.account).toMatchObject({ usage_fail_count: 0, last_error: null, usage_updated_at: NOW });
    expect(result.account.usage.windows).toEqual([win(30, NOW + 60 * MIN)]);
  });

  it("replaces the old per-model windows with the quota group windows of the new reading", async () => {
    const account = await fx.addAccount();
    const perModel = win(30, NOW + 60 * MIN, { name: "quota", model_scope: "gemini-4-argon-high" });
    await fx.store.updateSubscriptionAccount(account.account_id, { usage: { windows: [perModel] } });
    const group = win(7, NOW + 60 * MIN, { name: "weekly", model_scope: "gemini", group_label: "Gemini Models", shared_models: ["gemini-4-argon-high"] });

    const result = await checkAccountUsage(fx.store, account.account_id, fakeAdapter({ fetchUsage: async () => usageReading([group]) }), 95, NOW);

    expect(result.account.usage.windows).toEqual([group]);
  });

  it("stores the reset credits of the reading and clears them when the provider gives none", async () => {
    const account = await fx.addAccount();
    const resetCredits = {
      available: 1, usable_now: 1, note: null, observed_at: NOW,
      credits: [{ id: "credit-1", label: null, remaining: 1, total: null, expires_at: NOW + MIN, usable_now: true, unavailable_reason: null }],
    };

    const stored = await checkAccountUsage(fx.store, account.account_id, fakeAdapter({ fetchUsage: async () => usageReading([], resetCredits) }), 95, NOW);
    expect(stored.account.reset_credits).toEqual(resetCredits);

    const cleared = await checkAccountUsage(fx.store, account.account_id, fakeAdapter({ fetchUsage: async () => usageReading([]) }), 95, NOW);
    expect(cleared.account.reset_credits).toBeNull();
  });

  it("keeps the stored reset credits when the usage check fails", async () => {
    const account = await fx.addAccount();
    const resetCredits = { available: 0, usable_now: 0, note: "no_grant", observed_at: NOW, credits: [] };
    await fx.store.updateSubscriptionAccount(account.account_id, { reset_credits: resetCredits });

    const result = await checkAccountUsage(fx.store, account.account_id, fakeAdapter({ fetchUsage: async () => { throw new Error("down"); } }), 95, NOW);

    expect(result.failed).toBe(true);
    expect(result.account.reset_credits).toEqual(resetCredits);
  });

  it("releases an exhausted account when every shared window is below the threshold", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { status: "exhausted", exhausted_until: NOW - 30_000 });
    const adapter = fakeAdapter({ fetchUsage: async () => usageReading([win(10, NOW + 5 * 60 * MIN), win(99, NOW + 60 * MIN, { name: "opus", model_scope: "gpt-5-codex" })]) });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.account).toMatchObject({ status: "active", exhausted_until: null });
  });

  it("Check now replaces an old 429 hold with the latest 61 percent reading before reset", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, {
      status: "exhausted",
      exhausted_until: NOW + 7 * 24 * 60 * MIN,
      usage: { windows: [win(100, NOW + 7 * 24 * 60 * MIN, { name: "seven_day", source: "429", observed_at: NOW - MIN })] },
    });
    const reading = win(61, NOW + 7 * 24 * 60 * MIN, { name: "seven_day" });
    const result = await checkAccountUsage(fx.store, account.account_id, fakeAdapter({ fetchUsage: async () => usageReading([reading]) }), 95, NOW);

    expect(result.failed).toBe(false);
    expect(result.account).toMatchObject({ status: "active", exhausted_until: null, usage_updated_at: NOW });
    expect(result.account.usage.windows).toEqual([reading]);
  });

  it("drops an old synthetic 429 window absent from a successful usage response", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, {
      status: "exhausted",
      exhausted_until: NOW + 60 * MIN,
      usage: { windows: [win(100, NOW + 60 * MIN, { name: "five_hour", source: "429", observed_at: NOW - MIN })] },
    });
    const reading = win(61, NOW + 7 * 24 * 60 * MIN, { name: "seven_day" });
    const result = await checkAccountUsage(fx.store, account.account_id, fakeAdapter({ fetchUsage: async () => usageReading([reading]) }), 95, NOW);

    expect(result.account).toMatchObject({ status: "active", exhausted_until: null });
    expect(result.account.usage.windows).toEqual([reading]);
  });

  it("keeps an account exhausted until the reset the provider returns", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { status: "exhausted", exhausted_until: NOW - 30_000 });
    const adapter = fakeAdapter({ fetchUsage: async () => usageReading([win(100, NOW + 40 * MIN)]) });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.account).toMatchObject({ status: "exhausted", exhausted_until: NOW + 40 * MIN });
  });

  it("checks again in 15 minutes when a window at the threshold has no future reset time", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { status: "exhausted", exhausted_until: NOW - 30_000 });
    const adapter = fakeAdapter({ fetchUsage: async () => usageReading([win(97, NOW - MIN)]) });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.account).toMatchObject({ status: "active", exhausted_until: null });
    expect(result.account.usage.windows[0].resets_at).toBe(NOW + 15 * MIN);
  });

  it.each(["primary_window", "secondary_window", "five_hour", "seven_day"])("marks an active account exhausted when %s reaches 100 percent", async (name) => {
    const account = await fx.addAccount();
    const result = await checkAccountUsage(fx.store, account.account_id, fakeAdapter({ fetchUsage: async () => usageReading([win(100, NOW + MIN, { name })]) }), 95, NOW);
    expect(result.account).toMatchObject({ status: "exhausted", exhausted_until: NOW + MIN });
  });

  it("keeps an active account available below 100 percent, even above the threshold", async () => {
    const account = await fx.addAccount();
    const result = await checkAccountUsage(fx.store, account.account_id, fakeAdapter({ fetchUsage: async () => usageReading([win(99, NOW + MIN)]) }), 95, NOW);
    expect(result.account).toMatchObject({ status: "active", exhausted_until: null });
  });

  it("waits for both full shared windows to reset", async () => {
    const account = await fx.addAccount();
    const adapter = fakeAdapter({ fetchUsage: async () => usageReading([win(100, NOW + MIN), win(100, NOW + 60 * MIN, { name: "secondary_window" })]) });
    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);
    expect(result.account).toMatchObject({ status: "exhausted", exhausted_until: NOW + 60 * MIN });
  });

  it("rechecks a newly exhausted account when the reset is unknown", async () => {
    const account = await fx.addAccount();
    const result = await checkAccountUsage(fx.store, account.account_id, fakeAdapter({ fetchUsage: async () => usageReading([win(100, null)]) }), 95, NOW);
    expect(result.account).toMatchObject({ status: "exhausted", exhausted_until: NOW + 15 * MIN });
  });

  it("does not exhaust the whole account for a full per-model window", async () => {
    const account = await fx.addAccount();
    const result = await checkAccountUsage(fx.store, account.account_id, fakeAdapter({ fetchUsage: async () => usageReading([win(100, NOW + MIN, { model_scope: "opus" })]) }), 95, NOW);
    expect(result.account).toMatchObject({ status: "active", exhausted_until: null });
  });

  it.each(["auth_error", "disabled"] as const)("preserves %s when a usage reading is full", async (status) => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { status });
    const result = await checkAccountUsage(fx.store, account.account_id, fakeAdapter({ fetchUsage: async () => usageReading([win(100, NOW + MIN)]) }), 95, NOW);
    expect(result.account).toMatchObject({ status, exhausted_until: null });
  });

  it("marks an account plan_error when its plan is downgraded and restores active once renewed", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { status: "exhausted", exhausted_until: NOW + 30 * MIN, account_label: "acct-1@example.com (Ultra)" });

    const downgraded = await checkAccountUsage(
      fx.store,
      account.account_id,
      fakeAdapter({ fetchUsage: async () => ({ windows: [win(20, NOW + MIN)], resetCredits: null, accountLabel: "acct-1@example.com (Free)", planError: "Ultra subscription required (Free)" }) }),
      95,
      NOW,
    );
    expect(downgraded.failed).toBe(false);
    expect(downgraded.account).toMatchObject({
      status: "plan_error",
      exhausted_until: null,
      account_label: "acct-1@example.com (Free)",
      last_error: "Ultra subscription required (Free)",
    });

    const renewed = await checkAccountUsage(
      fx.store,
      account.account_id,
      fakeAdapter({ fetchUsage: async () => ({ windows: [win(20, NOW + MIN)], resetCredits: null, accountLabel: "acct-1@example.com (Ultra)", planError: null }) }),
      95,
      NOW + MIN,
    );
    expect(renewed.account).toMatchObject({
      status: "active",
      exhausted_until: null,
      account_label: "acct-1@example.com (Ultra)",
      last_error: null,
    });
  });

  it("counts a failure and keeps the stored usage", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { usage: { windows: [win(50, NOW + MIN)] } });
    const adapter = fakeAdapter({ fetchUsage: async () => { throw new Error("down"); } });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.failed).toBe(true);
    expect(result.account).toMatchObject({ usage_fail_count: 1, last_error: USAGE_CHECK_FAILED });
    expect(result.account.usage.windows).toEqual([win(50, NOW + MIN)]);
  });

  it("releases by time when the usage API fails after the reset", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { status: "exhausted", exhausted_until: NOW - 30_000 });
    const adapter = fakeAdapter({ fetchUsage: async () => { throw new Error("down"); } });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.account).toMatchObject({ status: "active", exhausted_until: null });
  });

  it("does not release early when the usage API fails before the reset", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { status: "exhausted", exhausted_until: NOW + 10 * MIN });
    const adapter = fakeAdapter({ fetchUsage: async () => { throw new Error("down"); } });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.account).toMatchObject({ status: "exhausted", exhausted_until: NOW + 10 * MIN });
  });

  it("calls the provider with the stored token and account id", async () => {
    const account = await fx.addAccount();
    const adapter = fakeAdapter();
    await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);
    expect(adapter.fetchUsage).toHaveBeenCalledWith("access-1", "acct-1", { projectId: null });
  });

  it("drops a stale window the provider no longer returns, so the account is released", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, {
      status: "exhausted",
      exhausted_until: NOW - 30_000,
      usage: { windows: [win(100, NOW - 30_000, { name: "primary", source: "429" }), win(100, NOW - 30_000, { name: "secondary_window", source: "429" })] },
    });
    const adapter = fakeAdapter({ fetchUsage: async () => usageReading([win(10, NOW + 5 * 60 * MIN)]) });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.account).toMatchObject({ status: "active", exhausted_until: null });
    expect(result.account.usage.windows.map((w) => w.name)).toEqual(["primary_window"]);
  });

  it("drops an older usage API window that the new reading sends under another name", async () => {
    const account = await fx.addAccount();
    const weeklyReset = NOW + 4 * 24 * 60 * MIN;
    await fx.store.updateSubscriptionAccount(account.account_id, {
      usage: { windows: [
        win(14, weeklyReset, { observed_at: NOW - MIN }),
        win(50, NOW + 60 * MIN, { name: "header_only", source: "header", observed_at: NOW - MIN }),
      ] },
    });
    const adapter = fakeAdapter({ fetchUsage: async () => usageReading([win(15, weeklyReset, { name: "secondary_window" })]) });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.account.usage.windows.map((w) => w.name).sort()).toEqual(["header_only", "secondary_window"]);
  });

  it("never sets an exhaustion time in the past", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, {
      status: "exhausted",
      exhausted_until: NOW - 30_000,
      usage: { windows: [win(100, NOW - MIN, { name: "weekly", source: "429" })] },
    });
    const adapter = fakeAdapter({ fetchUsage: async () => usageReading([win(100, NOW + 30 * MIN)]) });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.account.exhausted_until).toBe(NOW + 30 * MIN);
  });

  it("marks a window that is stuck at the limit at the threshold of the account", async () => {
    const low = await fx.addAccount({ threshold_pct: 70 });
    const high = await fx.addAccount({ threshold_pct: 95 });
    fx.svc.setSubscriptionPoolHooks({ adapterFor: () => fakeAdapter({ fetchUsage: async () => usageReading([win(80, null)]) }) });

    const lowResult = await fx.svc.runSubscriptionUsageCheck(low.account_id, { refreshModels: false });
    const highResult = await fx.svc.runSubscriptionUsageCheck(high.account_id, { refreshModels: false });

    // A window at or above the threshold with no known reset gets a next check; a window below it is stored as read.
    expect(lowResult.account.usage.windows[0]!.resets_at).not.toBeNull();
    expect(highResult.account.usage.windows[0]!.resets_at).toBeNull();
  });

  it("preserves the stored plan_error reason when a usage check fails", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, {
      status: "plan_error",
      last_error: "Ultra subscription required (Free)",
    });
    const adapter = fakeAdapter({ fetchUsage: async () => { throw new Error("401"); } });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.failed).toBe(true);
    expect(result.account).toMatchObject({
      status: "plan_error",
      usage_fail_count: 1,
      last_error: "Ultra subscription required (Free)",
    });
  });

  it("refreshes an expired token before checking usage so a plan_error account can recover", async () => {
    const account = await fx.addAccount({ token_expires_at: Date.now() - MIN });
    await fx.store.updateSubscriptionAccount(account.account_id, {
      status: "plan_error",
      last_error: "Ultra subscription required (Free)",
    });
    const adapter = fakeAdapter({
      refresh: async () => tokens({ accessToken: "fresh-access", refreshToken: "fresh-refresh" }),
      fetchUsage: async (accessToken) => {
        if (accessToken !== "fresh-access") throw new SubscriptionProviderError("unauthorized", false, 401);
        return { windows: [win(10, NOW + MIN)], resetCredits: null, planError: null };
      },
    });
    fx.svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });

    const result = await fx.svc.runSubscriptionUsageCheck(account.account_id, { refreshModels: false });

    expect(adapter.refresh).toHaveBeenCalledWith("refresh-1");
    expect(adapter.fetchUsage).toHaveBeenCalledWith("fresh-access", "acct-1", { projectId: null });
    expect(result.failed).toBe(false);
    expect(result.account).toMatchObject({ status: "active", last_error: null });
  });

  it("stops before fetchUsage when pre-check refresh permanently fails into auth_error", async () => {
    const account = await fx.addAccount({ token_expires_at: Date.now() - MIN });
    await fx.store.updateSubscriptionAccount(account.account_id, {
      status: "plan_error",
      last_error: "Ultra subscription required (Free)",
    });
    const adapter = fakeAdapter({
      refresh: async () => { throw new SubscriptionProviderError("invalid_grant", true, 400); },
    });
    fx.svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });

    const result = await fx.svc.runSubscriptionUsageCheck(account.account_id, { refreshModels: false });

    expect(adapter.fetchUsage).not.toHaveBeenCalled();
    expect(result.failed).toBe(true);
    expect(result.account).toMatchObject({ status: "auth_error", last_error: RELOGIN_NEEDED });
  });

  it("preserves plan_error and skips fetchUsage when pre-check refresh transiently fails on an expired token", async () => {
    const account = await fx.addAccount({ token_expires_at: Date.now() - MIN });
    await fx.store.updateSubscriptionAccount(account.account_id, {
      status: "plan_error",
      last_error: "Ultra subscription required (Free)",
    });
    const adapter = fakeAdapter({
      refresh: async () => { throw new SubscriptionProviderError("service unavailable", false, 503); },
    });
    fx.svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });

    const result = await fx.svc.runSubscriptionUsageCheck(account.account_id, { refreshModels: false });

    expect(adapter.refresh).toHaveBeenCalledTimes(1);
    expect(adapter.fetchUsage).not.toHaveBeenCalled();
    expect(result.failed).toBe(true);
    expect(result.account).toMatchObject({
      status: "plan_error",
      usage_fail_count: 0,
      last_error: "Ultra subscription required (Free)",
    });
  });

  it("skips pre-check refresh and fetchUsage when the account is already in auth_error", async () => {
    const account = await fx.addAccount({ token_expires_at: Date.now() - MIN });
    await fx.store.updateSubscriptionAccount(account.account_id, {
      status: "auth_error",
      last_error: RELOGIN_NEEDED,
    });
    const adapter = fakeAdapter();
    fx.svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });

    const result = await fx.svc.runSubscriptionUsageCheck(account.account_id, { refreshModels: false });

    expect(adapter.refresh).not.toHaveBeenCalled();
    expect(adapter.fetchUsage).not.toHaveBeenCalled();
    expect(result.failed).toBe(true);
    expect(result.account).toMatchObject({ status: "auth_error", last_error: RELOGIN_NEEDED });
  });
});
