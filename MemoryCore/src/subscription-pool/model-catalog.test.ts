import { describe, expect, it, vi } from "vitest";
import type { SourceModelEntry, SubscriptionAccountEntity } from "../metadata/types.js";
import {
  ModelCatalogError,
  apiModelsUrl,
  describeFetchError,
  fetchApiSourceModels,
  fetchPoolSourceModels,
  mergeSourceModels,
  parseFetchableBaseUrl,
  parseOpenAiModels,
} from "./model-catalog.js";
import { SubscriptionProviderError } from "./providers/types.js";
import { fakeAdapter } from "./test-support.js";

const T1 = "2026-10-26T01:00:00.000Z";
const T2 = "2026-10-27T01:00:00.000Z";

function entry(id: string, enabled: boolean, available = true): SourceModelEntry {
  return { id, display_name: id, enabled, available, first_seen_at: T1, last_seen_at: T1 };
}

describe("mergeSourceModels", () => {
  it("starts new models on for a subscription and off for an API source", () => {
    const readings = [{ id: "a", display_name: "A" }];
    expect(mergeSourceModels([], readings, true, T1)).toEqual([
      { id: "a", display_name: "A", enabled: true, available: true, first_seen_at: T1, last_seen_at: T1 },
    ]);
    expect(mergeSourceModels([], readings, false, T1)[0].enabled).toBe(false);
  });

  it("keeps the choice of a known model and starts a later model by the source kind", () => {
    const existing = [entry("kept-on", true), entry("kept-off", false)];
    const readings = ["kept-on", "kept-off", "later"].map((id) => ({ id, display_name: id }));
    const apiMerged = mergeSourceModels(existing, readings, false, T2);
    expect(apiMerged.map((m) => [m.id, m.enabled])).toEqual([["kept-on", true], ["kept-off", false], ["later", false]]);
    const poolMerged = mergeSourceModels(existing, readings, true, T2);
    expect(poolMerged.map((m) => [m.id, m.enabled])).toEqual([["kept-on", true], ["kept-off", false], ["later", true]]);
    expect(apiMerged[0]).toMatchObject({ first_seen_at: T1, last_seen_at: T2 });
    expect(apiMerged[2]).toMatchObject({ first_seen_at: T2, last_seen_at: T2 });
  });

  it("marks a model that vanished as unavailable and keeps its choice", () => {
    const merged = mergeSourceModels([entry("gone", true), entry("stays", false)], [{ id: "stays", display_name: "Stays" }], true, T2);
    expect(merged.find((m) => m.id === "gone")).toMatchObject({ enabled: true, available: false, last_seen_at: T1 });
    expect(merged.find((m) => m.id === "stays")).toMatchObject({ available: true, display_name: "Stays" });
  });

  it("makes a model that returns available again with its old choice", () => {
    const merged = mergeSourceModels([entry("back", true, false)], [{ id: "back", display_name: "back" }], false, T2);
    expect(merged[0]).toMatchObject({ enabled: true, available: true });
  });

  it("drops repeated ids in one reading", () => {
    const merged = mergeSourceModels([], [{ id: "a", display_name: "1" }, { id: "a", display_name: "2" }], true, T1);
    expect(merged).toHaveLength(1);
  });
});

describe("API source model list", () => {
  it("reads data[].id from an OpenAI-compatible response", () => {
    expect(parseOpenAiModels({ data: [{ id: "deepseek-v4" }, { id: "vendor/x", name: "Vendor X" }, { id: "" }, {}, null] })).toEqual([
      { id: "deepseek-v4", display_name: "deepseek-v4" },
      { id: "vendor/x", display_name: "Vendor X" },
    ]);
    expect(parseOpenAiModels({ object: "list" })).toEqual([]);
  });

  it("builds the models URL from the base URL", () => {
    expect(apiModelsUrl("https://api.example.test/v1", "openai")).toBe("https://api.example.test/v1/models");
    expect(apiModelsUrl("https://api.example.test/v1/", "openai")).toBe("https://api.example.test/v1/models");
    expect(apiModelsUrl("https://api.example.test", "openai")).toBe("https://api.example.test/models");
    expect(apiModelsUrl("https://api.anthropic.com", "anthropic")).toBe("https://api.anthropic.com/v1/models");
    expect(apiModelsUrl("https://api.example.test/api/v2", "anthropic")).toBe("https://api.example.test/api/v2/models");
    expect(apiModelsUrl("https://gw.example.test/v1?key=abc", "openai")).toBe("https://gw.example.test/v1/models");
  });

  it("sends a bearer key, with a timeout and no redirect", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const models = await fetchApiSourceModels(
      { base_url: "https://api.example.test/v1", api_key: "sk-key-1", source_provider: "openrouter" },
      async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "vendor/m2" }] }), { status: 200 });
      },
    );
    expect(models.map((m) => m.id)).toEqual(["m1", "vendor/m2"]);
    expect(calls[0].url).toBe("https://api.example.test/v1/models");
    expect(calls[0].init?.headers).toMatchObject({ authorization: "Bearer sk-key-1" });
    expect(calls[0].init?.redirect).toBe("error");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses x-api-key and the version header for an Anthropic source", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    await fetchApiSourceModels(
      { base_url: "https://api.anthropic.com", api_key: "sk-ant-1", source_provider: "anthropic" },
      async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ data: [{ id: "claude-x" }] }), { status: 200 });
      },
    );
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/models");
    expect(calls[0].init?.headers).toMatchObject({ "x-api-key": "sk-ant-1", "anthropic-version": "2023-06-01" });
    expect(calls[0].init?.headers).not.toHaveProperty("authorization");
  });

  it("raises a plain error for a refusal, a non-JSON body and an oversized body", async () => {
    const group = { base_url: "https://api.example.test", api_key: "sk-key-1", source_provider: "openai" };
    await expect(fetchApiSourceModels(group, async () => new Response("denied sk-key-1", { status: 401 })))
      .rejects.toThrow("provider returned 401");
    await expect(fetchApiSourceModels(group, async () => new Response("<html>", { status: 200 })))
      .rejects.toThrow("not JSON");
    await expect(fetchApiSourceModels(group, async () => new Response("x".repeat(8 * 1024 * 1024 + 1), { status: 200 })))
      .rejects.toThrow("too large");
  });

  it.each([
    "http://localhost:8080",
    "http://LOCALHOST./v1",
    "http://127.0.0.1",
    "http://127.9.9.9/v1",
    "http://0.0.0.0",
    "http://memory-core:3000",
    "http://[::1]:3000",
    "http://[::ffff:127.0.0.1]",
    "http://169.254.169.254/latest",
    "http://app.localhost",
    "ftp://api.example.test",
    "not a url",
  ])("refuses the base URL %s", (baseUrl) => {
    expect(() => parseFetchableBaseUrl(baseUrl)).toThrow(ModelCatalogError);
  });

  it("does not call out for an internal address", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchApiSourceModels({ base_url: "http://127.0.0.1:3000", api_key: "k", source_provider: "openai" }, fetchImpl))
      .rejects.toThrow("internal address");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("describeFetchError", () => {
  it("redacts keys and tokens from provider text", () => {
    const text = describeFetchError(new SubscriptionProviderError("bad Bearer abc.def-ghi and key sk-live-ABCDEFGH12345", false, 500));
    expect(text).not.toContain("abc.def-ghi");
    expect(text).not.toContain("sk-live-ABCDEFGH12345");
  });

  it("removes a secret that no pattern would catch", () => {
    expect(describeFetchError(new ModelCatalogError("echo hunter22 again"), ["hunter22"])).toBe("echo [redacted] again");
  });

  it("names a timeout and a network error without request data", () => {
    expect(describeFetchError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("request timed out");
    expect(describeFetchError(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }))).toBe("network error (ECONNREFUSED)");
    expect(describeFetchError("weird")).toBe("fetch failed");
  });

  it("bounds the text", () => {
    expect(describeFetchError(new ModelCatalogError("a ".repeat(1000))).length).toBeLessThanOrEqual(300);
  });
});

describe("fetchPoolSourceModels", () => {
  function account(id: string, extra: Partial<SubscriptionAccountEntity> = {}): SubscriptionAccountEntity {
    return {
      account_id: id,
      provider: "codex",
      provider_account_id: `p-${id}`,
      access_token: `token-${id}`,
      token_expires_at: 1,
      ...extra,
    } as SubscriptionAccountEntity;
  }

  it("merges the lists of every account that answers and skips one that fails", async () => {
    const adapter = fakeAdapter({
      fetchModels: async (token) => {
        if (token === "token-b") throw new SubscriptionProviderError("down", false, 503);
        return token === "token-a"
          ? [{ id: "m1", display_name: "M1" }, { id: "m2", display_name: "M2" }]
          : [{ id: "m2", display_name: "again" }, { id: "m3", display_name: "M3" }];
      },
    });
    const result = await fetchPoolSourceModels([account("a"), account("b"), account("c")], {
      adapterFor: () => adapter,
      refreshAfterUnauthorized: async () => null,
    });
    expect(result.models.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(result.models.find((m) => m.id === "m2")?.display_name).toBe("M2");
    expect(result.succeeded).toBe(2);
    expect(adapter.fetchModels).toHaveBeenCalledWith("token-a", "p-a", undefined);
  });

  it("refreshes the token once after a 401 and retries that account", async () => {
    const adapter = fakeAdapter({
      fetchModels: async (token) => {
        if (token === "token-old") throw new SubscriptionProviderError("expired", true, 401);
        return [{ id: "m1", display_name: "M1" }];
      },
    });
    const refreshAfterUnauthorized = vi.fn(async (a: SubscriptionAccountEntity) => ({ ...a, access_token: "token-new" }));
    const result = await fetchPoolSourceModels([account("a", { access_token: "token-old" })], { adapterFor: () => adapter, refreshAfterUnauthorized });
    expect(result.succeeded).toBe(1);
    expect(refreshAfterUnauthorized).toHaveBeenCalledTimes(1);
    expect(adapter.fetchModels.mock.calls.map((c) => c[0])).toEqual(["token-old", "token-new"]);
  });

  it("goes to the next account when the refresh fails or the retry is refused again", async () => {
    const adapter = fakeAdapter({
      fetchModels: async (token) => {
        if (token !== "token-ok") throw new SubscriptionProviderError("expired", true, 401);
        return [{ id: "m1", display_name: "M1" }];
      },
    });
    const refreshAfterUnauthorized = vi.fn(async (a: SubscriptionAccountEntity) => (a.account_id === "a" ? null : { ...a, access_token: "token-still-bad" }));
    const result = await fetchPoolSourceModels(
      [account("a", { access_token: "token-x" }), account("b", { access_token: "token-y" }), account("c", { access_token: "token-ok" })],
      { adapterFor: () => adapter, refreshAfterUnauthorized },
    );
    expect(result.succeeded).toBe(1);
    expect(refreshAfterUnauthorized).toHaveBeenCalledTimes(2);
    // account b is tried with its old token and the refreshed one only, never a third time
    expect(adapter.fetchModels.mock.calls.map((c) => c[0])).toEqual(["token-x", "token-y", "token-still-bad", "token-ok"]);
  });

  it("does not refresh on an error that is not a 401", async () => {
    const adapter = fakeAdapter({ fetchModels: async () => { throw new SubscriptionProviderError("busy", false, 429); } });
    const refreshAfterUnauthorized = vi.fn();
    const result = await fetchPoolSourceModels([account("a")], { adapterFor: () => adapter, refreshAfterUnauthorized });
    expect(result.succeeded).toBe(0);
    expect(refreshAfterUnauthorized).not.toHaveBeenCalled();
    expect(result.lastError).toBeInstanceOf(SubscriptionProviderError);
  });

  it("reports an empty pool as a failure", async () => {
    const result = await fetchPoolSourceModels([], { adapterFor: () => fakeAdapter(), refreshAfterUnauthorized: async () => null });
    expect(result.succeeded).toBe(0);
    expect((result.lastError as Error).message).toContain("no active account");
  });
});
