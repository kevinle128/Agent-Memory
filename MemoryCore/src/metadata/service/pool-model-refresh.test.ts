import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceModelEntry } from "../types.js";
import { mergeSourceModels } from "../../subscription-pool/model-catalog.js";
import { SubscriptionPoolScheduler } from "../../subscription-pool/pool-scheduler.js";
import { SubscriptionProviderError } from "../../subscription-pool/providers/types.js";
import { createPoolFixture, fakeAdapter, tokens, type PoolFixture, POOL_TEAM_ID, POOL_USER_ID } from "../../subscription-pool/test-support.js";

type Listed = { id: string; display_name: string };

const model = (id: string): Listed => ({ id, display_name: id.toUpperCase() });

describe("pool model catalog refresh after an account check", () => {
  let fx: PoolFixture;
  let adapter: ReturnType<typeof fakeAdapter>;
  let listed: Listed[];

  async function catalog(): Promise<Array<[string, boolean, boolean]>> {
    const group = (await fx.store.getInstanceUpstreamGroup(fx.groupId))!;
    return group.source_models.map((m: SourceModelEntry) => [m.id, m.enabled, m.available]);
  }

  beforeEach(async () => {
    fx = await createPoolFixture();
    listed = [model("m1"), model("m2")];
    adapter = fakeAdapter({
      fetchModels: async () => listed,
      exchangeCode: async () => tokens({ providerAccountId: "acct-login", accountLabel: "login@example.com" }),
    });
    fx.svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });
  });

  afterEach(() => fx.store.close?.());

  it("reads the models right after an account is added through the login", async () => {
    const started = fx.svc.startSubscriptionOAuth(POOL_TEAM_ID, "codex", POOL_USER_ID);
    await fx.svc.completeSubscriptionOAuth({ team_id: POOL_TEAM_ID,
      provider: "codex",
      state: started.state,
      redirect_url: `http://localhost:1455/auth/callback?code=c&state=${started.state}`,
    }, POOL_USER_ID);
    expect(adapter.fetchModels).toHaveBeenCalledTimes(1);
    expect(await catalog()).toEqual([["m1", true, true], ["m2", true, true]]);
  });

  it("reads the models on a single check and on check-all, once per pool for check-all", async () => {
    const first = await fx.addAccount();
    await fx.addAccount();

    await fx.svc.checkSubscriptionAccountUsage(first.account_id);
    // One read of the pool tries each active account once.
    expect(adapter.fetchModels).toHaveBeenCalledTimes(2);
    expect(await catalog()).toEqual([["m1", true, true], ["m2", true, true]]);

    listed = [...listed, model("m3")];
    adapter.fetchModels.mockClear();
    await fx.svc.checkAllSubscriptionAccountUsage();
    expect(adapter.fetchModels).toHaveBeenCalledTimes(2);
    expect(adapter.fetchUsage).toHaveBeenCalledTimes(3);
    expect((await catalog()).map((row) => row[0])).toEqual(["m1", "m2", "m3"]);
  });

  it("keeps the admin's choices, adds new models as selected and removes models the provider dropped", async () => {
    const account = await fx.addAccount();
    await fx.svc.checkSubscriptionAccountUsage(account.account_id);
    await fx.svc.updateSourceModels({ group_id: fx.groupId, models: [{ id: "m2", enabled: false }] });

    listed = [model("m2"), model("m3")];
    await fx.svc.checkSubscriptionAccountUsage(account.account_id);
    expect(await catalog()).toEqual([["m2", false, true], ["m3", true, true]]);
  });

  it("keeps the old catalog and still completes the check when the model call fails", async () => {
    const account = await fx.addAccount();
    await fx.svc.checkSubscriptionAccountUsage(account.account_id);
    adapter.fetchModels.mockRejectedValue(new SubscriptionProviderError("down", false, 503));

    const checked = await fx.svc.checkSubscriptionAccountUsage(account.account_id) as { account_id: string };
    expect(checked.account_id).toBe(account.account_id);
    expect(await catalog()).toEqual([["m1", true, true], ["m2", true, true]]);
    expect((await fx.store.getInstanceUpstreamGroup(fx.groupId))!.source_models_error).toBeTruthy();
  });

  it("does not fail the login when the model call fails", async () => {
    adapter.fetchModels.mockRejectedValue(new Error("boom"));
    const started = fx.svc.startSubscriptionOAuth(POOL_TEAM_ID, "codex", POOL_USER_ID);
    const account = await fx.svc.completeSubscriptionOAuth({ team_id: POOL_TEAM_ID,
      provider: "codex",
      state: started.state,
      redirect_url: `http://localhost:1455/auth/callback?code=c&state=${started.state}`,
    }, POOL_USER_ID);
    expect(account).toMatchObject({ provider_account_id: "acct-login", created: true });
  });

  it("leaves a pool that is off alone", async () => {
    const account = await fx.addAccount();
    await fx.svc.disableSubscriptionPool(POOL_TEAM_ID, "codex", [{ agent_source: "codex", protocol: "openai-responses", display_name: "Codex" }]);
    await fx.svc.checkSubscriptionAccountUsage(account.account_id);
    expect(adapter.fetchModels).not.toHaveBeenCalled();
  });
});

describe("pool model catalog refresh on the scheduled check", () => {
  const HOUR = 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(1_800_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the models once per pool after a pass over several accounts", async () => {
    const fx = await createPoolFixture();
    const adapter = fakeAdapter({ fetchModels: async () => [model("m1")] });
    const scheduler = new SubscriptionPoolScheduler({
      getService: async () => fx.svc,
      checkIntervalMs: 24 * HOUR,
      logger: {},
      accountGapMs: 0,
      sourceModelsFirstDelayMs: 100 * HOUR,
    });
    fx.svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });
    await fx.addAccount();
    await fx.addAccount();
    await fx.addAccount();

    const done = scheduler.registerInstance("default");
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(adapter.fetchUsage).toHaveBeenCalledTimes(3);
    // One read of the pool tries each of the three active accounts once, not once per check.
    expect(adapter.fetchModels).toHaveBeenCalledTimes(3);
    const group = (await fx.store.getInstanceUpstreamGroup(fx.groupId))!;
    expect(group.source_models.map((m) => m.id)).toEqual(["m1"]);
    scheduler.stop?.();
    await fx.store.close?.();
  });
});

describe("mergeSourceModels", () => {
  const entry = (id: string, enabled: boolean): SourceModelEntry => ({
    id, display_name: id, enabled, available: true, first_seen_at: "t0", last_seen_at: "t0",
  });

  it("marks a missing model unavailable by default and drops it when asked", () => {
    const existing = [entry("a", false), entry("b", true)];
    const readings = [{ id: "b", display_name: "B" }, { id: "c", display_name: "C" }];
    expect(mergeSourceModels(existing, readings, true, "t1").map((m) => [m.id, m.enabled, m.available]))
      .toEqual([["b", true, true], ["c", true, true], ["a", false, false]]);
    expect(mergeSourceModels(existing, readings, true, "t1", true).map((m) => [m.id, m.enabled, m.available]))
      .toEqual([["b", true, true], ["c", true, true]]);
  });
});
