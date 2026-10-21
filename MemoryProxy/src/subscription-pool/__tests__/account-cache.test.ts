import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAccountCache, getPoolSnapshot, markAccountExhausted, observeAccountWindows, replaceAccountToken,
} from "../account-cache.js";
import type { PoolAccount } from "../types.js";

const CORE = { endpoint: "http://core.test", serviceToken: "svc", timeoutMs: 1000 };

function acct(id: string, partial: Partial<PoolAccount> = {}): PoolAccount {
  return {
    account_id: id, group_id: "g", provider: "codex", provider_account_id: `pa-${id}`, status: "active",
    enabled: true, access_token: "tok-1", token_expires_at: 1000, usage: { windows: [] }, exhausted_until: null,
    ...partial,
  };
}

function coreReturns(accounts: PoolAccount[], threshold = 95) {
  return vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { threshold_pct: threshold, accounts } }), { status: 200 }));
}

describe("pool account cache", () => {
  beforeEach(() => clearAccountCache());
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("fetches from Core with the service token and instance id, then serves from cache until the TTL ends", async () => {
    const fetchMock = coreReturns([acct("a")]);
    vi.stubGlobal("fetch", fetchMock);
    const first = await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 0);
    expect(first.thresholdPct).toBe(95);
    expect(first.accounts.map((a) => a.account_id)).toEqual(["a"]);
    await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 29_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 31_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://core.test/v3/internal/meta/subscription-pool/accounts/list");
    expect((init.headers as Record<string, string>)["x-tdai-service-id"]).toBe("sp1");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer svc");
  });

  it("returns the last good value when Core fails after a success", async () => {
    vi.stubGlobal("fetch", coreReturns([acct("a")]));
    await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 0);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    const stale = await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 60_000);
    expect(stale.accounts.map((a) => a.account_id)).toEqual(["a"]);
  });

  it("returns an empty pool when Core fails on the first call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    const snap = await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 0);
    expect(snap.accounts).toEqual([]);
    expect(snap.unavailable).toBe(true);
  });

  it("keeps a local exhaustion across a refetch that does not know it yet", async () => {
    vi.stubGlobal("fetch", coreReturns([acct("a")]));
    await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 0);
    markAccountExhausted("sp1", "a", 500_000);
    const snap = await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 40_000);
    expect(snap.accounts[0]!.exhausted_until).toBe(500_000);
  });

  it("clears an older cooldown and quota overlay after Check now confirms quota, even within the TTL", async () => {
    vi.stubGlobal("fetch", coreReturns([acct("a")]));
    await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 1000);
    markAccountExhausted("sp1", "a", 500_000, 2000);
    observeAccountWindows("sp1", "a", [{ name: "primary_window", model_scope: null, used_pct: 100, resets_at: 500_000, observed_at: 2000, source: "header" }]);

    const reading = { name: "primary_window", model_scope: null, used_pct: 2, resets_at: 500_000, observed_at: 3000, source: "usage_api" };
    const freshFetch = coreReturns([acct("a", { usage: { windows: [reading] } })]);
    vi.stubGlobal("fetch", freshFetch);
    const fresh = await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 4000, true);

    expect(freshFetch).toHaveBeenCalledTimes(1);
    expect(fresh.accounts[0]!.exhausted_until).toBeNull();
    expect(fresh.accounts[0]!.usage.windows).toEqual([reading]);
    // Clearing persists into later cached reads; it is not just a one-request override.
    expect((await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 5000)).accounts[0]!.exhausted_until).toBeNull();
  });

  it.each(["usage_api", "header"])("does not clear a newer 429 from an older %s reading", async (source) => {
    markAccountExhausted("sp1", "a", 500_000, 3000);
    const reading = { name: "primary_window", model_scope: null, used_pct: 2, resets_at: 500_000, observed_at: 2000, source };
    vi.stubGlobal("fetch", coreReturns([acct("a", { usage: { windows: [reading] } })]));
    expect((await getPoolSnapshot(CORE, "sp1", undefined, 4000, true)).accounts[0]!.exhausted_until).toBe(500_000);
  });

  it("does not treat a newer proxy header report as a successful Check now", async () => {
    markAccountExhausted("sp1", "a", 500_000, 2000);
    const reading = { name: "primary_window", model_scope: null, used_pct: 2, resets_at: 500_000, observed_at: 3000, source: "header" };
    vi.stubGlobal("fetch", coreReturns([acct("a", { usage: { windows: [reading] } })]));
    expect((await getPoolSnapshot(CORE, "sp1", undefined, 4000, true)).accounts[0]!.exhausted_until).toBe(500_000);
  });

  it("keeps a full account exhausted after a successful check", async () => {
    markAccountExhausted("sp1", "a", 500_000, 2000);
    const reading = { name: "primary_window", model_scope: null, used_pct: 100, resets_at: 600_000, observed_at: 3000, source: "usage_api" };
    vi.stubGlobal("fetch", coreReturns([acct("a", { status: "exhausted", exhausted_until: 600_000, usage: { windows: [reading] } })]));
    expect((await getPoolSnapshot(CORE, "sp1", undefined, 4000, true)).accounts[0]!.exhausted_until).toBe(600_000);
  });

  it("keeps the cooldown when a forced refetch fails", async () => {
    vi.stubGlobal("fetch", coreReturns([acct("a")]));
    await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 1000);
    markAccountExhausted("sp1", "a", 500_000, 2000);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect((await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 4000, true)).accounts[0]!.exhausted_until).toBe(500_000);
  });

  it("preserves the known reset when Core returns a malformed list during revalidation", async () => {
    vi.stubGlobal("fetch", coreReturns([acct("a", { status: "exhausted", exhausted_until: 500_000 })]));
    await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 1000);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: 0, data: {} }))));
    const snapshot = await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 4000, true);
    expect(snapshot.accounts[0]!.exhausted_until).toBe(500_000);
  });

  it("does not let a stale local exhaustion shorten a longer one from Core", async () => {
    vi.stubGlobal("fetch", coreReturns([acct("a", { status: "exhausted", exhausted_until: 900_000 })]));
    markAccountExhausted("sp1", "a", 500_000);
    const snap = await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 0);
    expect(snap.accounts[0]!.exhausted_until).toBe(900_000);
  });

  it("merges observed windows: the newest observation wins per window", async () => {
    const coreWindow = { name: "primary_window", model_scope: null, used_pct: 10, resets_at: 9, observed_at: 100, source: "usage_api" };
    vi.stubGlobal("fetch", coreReturns([acct("a", { usage: { windows: [coreWindow] } })]));
    observeAccountWindows("sp1", "a", [
      { name: "primary_window", model_scope: null, used_pct: 50, resets_at: 9, observed_at: 200, source: "header" },
      { name: "secondary_window", model_scope: null, used_pct: 5, resets_at: 9, observed_at: 200, source: "header" },
    ]);
    const snap = await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 0);
    const byName = Object.fromEntries(snap.accounts[0]!.usage.windows.map((w) => [w.name, w.used_pct]));
    expect(byName).toEqual({ primary_window: 50, secondary_window: 5 });

    // Core later reports a newer reading; it replaces the local one.
    const newer = { ...coreWindow, used_pct: 20, observed_at: 300 };
    vi.stubGlobal("fetch", coreReturns([acct("a", { usage: { windows: [newer] } })]));
    const after = await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 60_000);
    expect(after.accounts[0]!.usage.windows.find((w) => w.name === "primary_window")!.used_pct).toBe(20);
  });

  it("uses a refreshed token until Core serves a newer one", async () => {
    vi.stubGlobal("fetch", coreReturns([acct("a", { access_token: "old", token_expires_at: 1000 })]));
    replaceAccountToken("sp1", "a", "fresh", 5000);
    const snap = await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 0);
    expect(snap.accounts[0]!.access_token).toBe("fresh");
    expect(snap.accounts[0]!.token_expires_at).toBe(5000);

    vi.stubGlobal("fetch", coreReturns([acct("a", { access_token: "newest", token_expires_at: 9000 })]));
    const after = await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 60_000);
    expect(after.accounts[0]!.access_token).toBe("newest");
  });

  it("uses a refreshed token even when the provider omits its expiry", async () => {
    vi.stubGlobal("fetch", coreReturns([acct("a", { access_token: "old", token_expires_at: 1000 })]));
    replaceAccountToken("sp1", "a", "fresh", null);
    const snap = await getPoolSnapshot(CORE, "sp1", { cacheTtlSec: 30 }, 0);
    expect(snap.accounts[0]).toMatchObject({ access_token: "fresh", token_expires_at: null });
  });
});
