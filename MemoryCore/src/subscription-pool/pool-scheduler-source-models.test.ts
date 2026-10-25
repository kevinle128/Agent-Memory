import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriptionPoolScheduler, type SubscriptionPoolSchedulerTarget } from "./pool-scheduler.js";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe("model list refresh timer", () => {
  let refreshAllSourceModels: ReturnType<typeof vi.fn>;
  let scheduler: SubscriptionPoolScheduler;
  const warnings: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(1_800_000_000_000);
    warnings.length = 0;
    refreshAllSourceModels = vi.fn(async () => ({ refreshed: 1, failed: 0 }));
    const target: SubscriptionPoolSchedulerTarget = {
      listSubscriptionAccountEntities: async () => [],
      subscriptionThreshold: async () => 95,
      runSubscriptionUsageCheck: async () => undefined,
      runSubscriptionTokenRefresh: async () => undefined,
      refreshAllSourceModels,
    };
    scheduler = new SubscriptionPoolScheduler({
      getService: async () => target,
      checkIntervalMs: 365 * 24 * HOUR,
      logger: { warn: (message: string) => warnings.push(message) },
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it("refreshes shortly after the instance is seen, then once a day", async () => {
    await scheduler.registerInstance("default");
    expect(refreshAllSourceModels).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * MIN - 1);
    expect(refreshAllSourceModels).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshAllSourceModels).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * HOUR - 1);
    expect(refreshAllSourceModels).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshAllSourceModels).toHaveBeenCalledTimes(2);
  });

  it("keeps the daily timer when a refresh fails and logs only the error code", async () => {
    refreshAllSourceModels.mockRejectedValueOnce(Object.assign(new Error("token sk-secret-value-1234"), { code: "boom" }));
    await scheduler.registerInstance("default");

    await vi.advanceTimersByTimeAsync(5 * MIN);
    await vi.advanceTimersByTimeAsync(24 * HOUR);

    expect(refreshAllSourceModels).toHaveBeenCalledTimes(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("error=boom");
    expect(warnings[0]).not.toContain("sk-secret");
  });

  it("stops with the other timers", async () => {
    await scheduler.registerInstance("default");
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(refreshAllSourceModels).not.toHaveBeenCalled();
    expect(scheduler.pendingTimers()).toEqual([]);
  });
});
