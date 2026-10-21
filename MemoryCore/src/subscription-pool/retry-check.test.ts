import { afterEach, describe, expect, it, vi } from "vitest";
import type * as http from "node:http";
import { createPoolFixture, fakeAdapter, POOL_AGENTS } from "./test-support.js";
import { handleInternalMetaRoute } from "../metadata/router/internal-meta-router.js";

afterEach(() => { vi.useRealTimers(); });

describe("internal retry Check now", () => {
  it("deduplicates concurrent checks per account, returns token-free results and expires the cache", async () => {
    const fx = await createPoolFixture();
    try {
      const account = await fx.addAccount();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const adapter = fakeAdapter({ fetchUsage: async () => { await gate; return [{ name: "weekly", model_scope: null, used_pct: 100, resets_at: Date.now() + 60_000, observed_at: Date.now(), source: "usage_api" }]; } });
      fx.svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });
      const first = fx.svc.checkSubscriptionAccountUsageInternal(account.account_id);
      const second = fx.svc.checkSubscriptionAccountUsageInternal(account.account_id);
      await vi.waitFor(() => expect(adapter.fetchUsage).toHaveBeenCalledTimes(1));
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toEqual(b);
      expect(a).toMatchObject({ failed: false, account: { status: "exhausted", usage: { windows: [expect.objectContaining({ used_pct: 100 })] } } });
      expect(JSON.stringify(a)).not.toMatch(/access_token|refresh_token|access-1|refresh-1/);
      await fx.svc.checkSubscriptionAccountUsageInternal(account.account_id);
      expect(adapter.fetchUsage).toHaveBeenCalledTimes(1);
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 11_000);
      await fx.svc.checkSubscriptionAccountUsageInternal(account.account_id);
      expect(adapter.fetchUsage).toHaveBeenCalledTimes(2);
    } finally { await fx.store.close(); }
  });

  it("exposes a service-authenticated internal check without adding a public member action", async () => {
    const fx = await createPoolFixture();
    try {
      const account = await fx.addAccount();
      const adapter = fakeAdapter({ fetchUsage: async () => [] });
      fx.svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });
      let status = 0; let result: unknown;
      const handled = await handleInternalMetaRoute(
        { headers: { "x-tdai-service-id": "default" } } as http.IncomingMessage,
        {} as http.ServerResponse, "/v3/internal/meta/subscription-pool/check-usage", "POST",
        async () => ({ account_id: account.account_id }),
        (_res, code, body) => { status = code; result = body; },
        { getMetadataService: () => fx.svc, getSupportedAgents: () => POOL_AGENTS, logger: {} },
      );
      expect(handled).toBe(true); expect(status).toBe(200);
      expect(result).toMatchObject({ code: 0, data: { failed: false, account: { account_id: account.account_id } } });
      expect(JSON.stringify(result)).not.toMatch(/access_token|refresh_token/);
    } finally { await fx.store.close(); }
  });

  it("reports a failed usage fetch as unknown rather than inventing exhaustion", async () => {
    const fx = await createPoolFixture();
    try {
      const account = await fx.addAccount();
      fx.svc.setSubscriptionPoolHooks({ adapterFor: () => fakeAdapter({ fetchUsage: async () => { throw new Error("429"); } }) });
      expect(await fx.svc.checkSubscriptionAccountUsageInternal(account.account_id))
        .toMatchObject({ failed: true, account: { status: "active", exhausted_until: null } });
    } finally { await fx.store.close(); }
  });
});
