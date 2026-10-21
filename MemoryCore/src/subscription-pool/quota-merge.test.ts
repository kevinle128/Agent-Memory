import { describe, expect, it } from "vitest";
import type { SubscriptionQuotaWindow } from "../metadata/types.js";
import { applyQuotaReport } from "../metadata/subscription-pool/quota-report.js";
import { mergeUsageWindows } from "./quota-merge.js";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const T0 = 1_800_000_000_000;

function win(partial: Partial<SubscriptionQuotaWindow>): SubscriptionQuotaWindow {
  return { name: "primary_window", model_scope: null, used_pct: 10, resets_at: T0 + 60 * MIN, observed_at: T0, source: "usage_api", ...partial };
}

describe("mergeUsageWindows", () => {
  it("keeps the newest observation per window", () => {
    const merged = mergeUsageWindows(
      [win({ used_pct: 50, observed_at: T0 + 2 * MIN })],
      [win({ used_pct: 20, observed_at: T0 + MIN })],
    );
    expect(merged).toEqual([win({ used_pct: 50, observed_at: T0 + 2 * MIN })]);
  });

  it("keeps windows of other models apart", () => {
    const merged = mergeUsageWindows(
      [win({ name: "weekly", model_scope: null })],
      [win({ name: "weekly", model_scope: "gpt-5-codex", used_pct: 99 })],
    );
    expect(merged).toHaveLength(2);
  });

  it("accepts a newer usage reading before an old 429 window resets", () => {
    const limited = win({ used_pct: 100, source: "429", observed_at: T0, resets_at: T0 + 10 * MIN });
    const reading = win({ used_pct: 61, observed_at: T0 + 5 * MIN });
    expect(mergeUsageWindows([limited], [reading])).toEqual([reading]);
  });

  it("does not let an older 429 overwrite a newer provider reading", () => {
    const reading = win({ used_pct: 61, observed_at: T0 + MIN });
    const limited = win({ used_pct: 100, source: "429", observed_at: T0 });
    expect(mergeUsageWindows([reading], [limited])).toEqual([reading]);
  });

  it("does not freeze a 429 window that has no reset time", () => {
    const limited = win({ used_pct: 100, source: "429", resets_at: null });
    const reading = win({ used_pct: 40, observed_at: T0 + 20 * MIN });
    expect(mergeUsageWindows([limited], [reading])).toEqual([reading]);
  });

  it("lets a 429 win over a reading observed at the same time", () => {
    const reading = win({ used_pct: 60, observed_at: T0 });
    const limited = win({ used_pct: 100, source: "429", observed_at: T0 });
    expect(mergeUsageWindows([reading], [limited])).toEqual([limited]);
  });
});

describe("applyQuotaReport", () => {
  const base = { status: "active" as const, exhausted_until: null };

  it.each(["primary_window", "secondary_window", "five_hour", "seven_day"])("marks %s exhausted from a full header without a 429", (name) => {
    const reading = win({ name, used_pct: 100, source: "header" });
    expect(applyQuotaReport({ ...base, usage: { windows: [] } }, { windows: [reading] }, T0))
      .toMatchObject({ status: "exhausted", exhausted_until: reading.resets_at });
  });

  it("waits for all full shared windows despite a shorter retry-after", () => {
    const windows = [win({ used_pct: 100 }), win({ name: "seven_day", used_pct: 100, resets_at: T0 + DAY })];
    expect(applyQuotaReport({ ...base, usage: { windows } }, { status_code: 429, retry_after: 60 }, T0))
      .toMatchObject({ status: "exhausted", exhausted_until: T0 + DAY });
  });

  it("uses a bounded recheck for a full window with no reset time", () => {
    expect(applyQuotaReport({ ...base, usage: { windows: [] } }, { windows: [win({ used_pct: 100, resets_at: null })] }, T0))
      .toMatchObject({ status: "exhausted", exhausted_until: T0 + 15 * MIN });
  });

  it.each([
    win({ used_pct: 99 }),
    win({ used_pct: 100, resets_at: T0 }),
    win({ used_pct: 100, model_scope: "opus" }),
  ])("does not exhaust for a near-limit, reset, or per-model window: %j", (reading) => {
    expect(applyQuotaReport({ ...base, usage: { windows: [] } }, { windows: [reading] }, T0).status).toBeUndefined();
  });

  it.each(["auth_error", "disabled"] as const)("preserves %s for a full header reading", (status) => {
    const result = applyQuotaReport({ status, exhausted_until: null, usage: { windows: [] } }, { windows: [win({ used_pct: 100 })] }, T0);
    expect(result.status).toBeUndefined();
    expect(result.exhausted_until).toBeUndefined();
  });

  it("does not infer exhaustion from a bare 429", () => {
    const result = applyQuotaReport({ ...base, usage: { windows: [] } }, { status_code: 429 }, T0);
    expect(result.status).toBeUndefined();
    expect(result.exhausted_until).toBeUndefined();
  });

  it("does not infer exhaustion from unrelated reset times", () => {
    const usage = { windows: [win({ resets_at: T0 + 30 * MIN }), win({ name: "secondary_window", resets_at: T0 + 2 * DAY })] };
    const result = applyQuotaReport({ ...base, usage }, { status_code: 429 }, T0);
    expect(result.exhausted_until).toBeUndefined();
  });

  it("keeps measured usage separate from the retry-after cooldown", () => {
    const usage = { windows: [win({ name: "secondary_window", used_pct: 40, resets_at: T0 + 6 * DAY })] };
    const reported = applyQuotaReport({ ...base, usage }, { status_code: 429, retry_after: 300 }, T0);
    expect(reported.exhausted_until).toBeUndefined();
    expect(reported.status).toBeUndefined();
    expect(reported.usage).toBeUndefined();
    expect(reported.usage_updated_at).toBeUndefined();
  });

  it("stores the actual header percentage on a 429 without forcing every window to 100", () => {
    const reading = win({ used_pct: 61, source: "header", observed_at: T0 + MIN });
    const reported = applyQuotaReport({ ...base, usage: { windows: [] } }, { status_code: 429, windows: [reading] }, T0 + MIN);
    expect(reported.status).toBeUndefined();
    expect(reported.usage?.windows).toEqual([reading]);
  });

  it("does not let an older header reading undo a newer one", () => {
    const usage = { windows: [win({ used_pct: 80, observed_at: T0 + 2 * MIN })] };
    const result = applyQuotaReport({ ...base, usage }, { windows: [win({ used_pct: 20, observed_at: T0 + MIN })] }, T0 + 3 * MIN);
    expect(result.usage?.windows[0].used_pct).toBe(80);
  });

  it.each(["auth_error", "disabled"] as const)("does not change status %s on a 429", (status) => {
    const result = applyQuotaReport({ status, exhausted_until: null, usage: { windows: [] } }, { status_code: 429 }, T0);
    expect(result.status).toBeUndefined();
  });

  it("writes no status or exhaustion for a report without a 429", () => {
    const result = applyQuotaReport({ ...base, usage: { windows: [] } }, { active_sessions: 2 }, T0);
    expect(result.status).toBeUndefined();
    expect(result.exhausted_until).toBeUndefined();
    expect(result.active_sessions).toBe(2);
  });
});
