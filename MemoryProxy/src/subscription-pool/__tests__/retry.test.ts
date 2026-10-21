import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPoolRequest, type PoolAuth } from "../pool-request.js";
import { __primeAccountCacheForTests, getPoolSnapshot } from "../account-cache.js";
import { POOL_RETRY_BUDGET_MS, resetPoolRetryForTests } from "../retry.js";
import { makeConfig, resetPoolState, jsonResponse } from "./test-harness.js";
import type { PoolAccount } from "../types.js";

const START = 1_800_000_000_000;
const ERROR_BODY = '{"type":"error","error":{"type":"rate_limit_error","message":"Error"},"request_id":"upstream-429"}';
const quotaWindow = (used: number, model: string | null = null) => ({ name: "five_hour", used_pct: used, model_scope: model, resets_at: START + 3_600_000, observed_at: Date.now(), source: "usage_api" });
const account = (id: string): PoolAccount => ({ account_id: id, group_id: "pool", provider: "claude", provider_account_id: id, enabled: true, status: "active", access_token: `secret-${id}`, token_expires_at: START + 3_600_000, usage: { windows: [quotaWindow(10)] }, exhausted_until: null });
const limited = (headers: Record<string, string> = {}) => new Response(ERROR_BODY, { status: 429, headers: { "content-type": "application/json", "request-id": "upstream-429", ...headers } });

describe("session-preserving 429 retries", () => {
  let accounts: PoolAccount[];
  let check: ReturnType<typeof vi.fn>;
  function request(signal?: AbortSignal) {
    return openPoolRequest({ config: makeConfig(), spaceId: "retry-test", row: { group_id: "pool", group_type: "custom", name: "pool", agents: ["claude-code"], mode: "subscription_pool", enabled: true, base_url: "", api_key: "", model_id: "" }, clientHeaders: new Headers({ "x-tdai-user-key": "test-user" }), userKey: "test-user", body: { model: "sonnet" }, bindSession: true, provider: "claude", signal });
  }
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(START);
    resetPoolState(); resetPoolRetryForTests();
    accounts = [account("a"), account("b")];
    __primeAccountCacheForTests("retry-test", { thresholdPct: 95, accounts });
    check = vi.fn(async () => ({ failed: false, account: accounts[0] }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/check-usage")) return jsonResponse({ code: 0, data: await check() });
      if (url.endsWith("/accounts/list")) return jsonResponse({ code: 0, data: { threshold_pct: 95, accounts } });
      return jsonResponse({ code: 0, data: {} });
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => { resetPoolRetryForTests(); resetPoolState(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("retries at 1,3,7,15,23 seconds, checks only after the fourth retry and stops at 30s", async () => {
    const times: number[] = []; const ids: string[] = [];
    const req = request();
    const pending = req.send(async (auth) => { ids.push(auth.kind === "account" ? auth.accountId : "client"); times.push(Date.now() - START); return limited(); });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    const response = await pending;
    expect(times).toEqual([0, 1000, 3000, 7000, 15000, 23000]);
    expect(new Set(ids)).toEqual(new Set(["a"]));
    expect(response.status).toBe(429); expect(await response.text()).toBe(ERROR_BODY);
    expect(response.headers.get("x-tdai-pool-status")).toBe("rate_limited");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    const state = await getPoolSnapshot(makeConfig().coreSkill, "retry-test");
    expect(state.accounts[0].status).toBe("active"); expect(state.accounts[0].exhausted_until).toBeNull();
  });

  it("returns early success on the same account without Check now", async () => {
    let n = 0;
    const send = vi.fn(async (_auth: PoolAuth) => ++n < 3 ? limited() : new Response("ok"));
    const pending = request().send(send);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await (await pending).text()).toBe("ok"); expect(check).not.toHaveBeenCalled();
    expect(send.mock.calls.every(([auth]) => auth.kind === "account" && auth.accountId === "a")).toBe(true);
  });

  it.each([null, "sonnet"])("switches only after Check now confirms full applicable quota (%s)", async (model) => {
    check.mockImplementation(async () => {
      accounts[0] = { ...accounts[0], usage: { windows: [quotaWindow(100, model)] } };
      return { failed: false, account: { ...accounts[0], usage_updated_at: Date.now() } };
    });
    const req = request();
    const ids: string[] = [];
    const pending = req.send(async (auth) => {
      const id = auth.kind === "account" ? auth.accountId : "client"; ids.push(id);
      return id === "a" ? limited() : new Response("account-b");
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await (await pending).text()).toBe("account-b");
    expect(ids).toEqual(["a", "a", "a", "a", "a", "b"]); expect(req.accountId).toBe("b");
    expect(check).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "network", "empty", "other-model"])("keeps the account without confirmed applicable quota: %s", async (kind) => {
    check.mockImplementation(async () => {
      if (kind === "network") throw new Error("usage unavailable");
      return { failed: kind === "failed", account: { ...accounts[0], usage: { windows: kind === "empty" ? [] : [quotaWindow(100, "opus")] } } };
    });
    const req = request(); const pending = req.send(async () => limited());
    await vi.advanceTimersByTimeAsync(POOL_RETRY_BUDGET_MS);
    expect((await pending).status).toBe(429); expect(req.accountId).toBe("a"); expect(check).toHaveBeenCalledTimes(1);
  });

  it.each(["header", "stale-usage"])("does not switch on retained old 100 percent data from Check now: %s", async (kind) => {
    check.mockImplementation(async () => ({ failed: false, account: {
      ...accounts[0], usage_updated_at: Date.now(),
      usage: { windows: [{ ...quotaWindow(100), source: kind === "header" ? "header" : "usage_api", observed_at: START - 1000 }] },
    } }));
    const req = request(); const pending = req.send(async () => limited());
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).status).toBe(429); expect(req.accountId).toBe("a");
  });

  it("shares Check now and staggers retries while requests retain independent deadlines", async () => {
    const firstTimes: number[] = []; const secondTimes: number[] = [];
    const first = request().send(async () => { firstTimes.push(Date.now()); return limited(); });
    await vi.advanceTimersByTimeAsync(1000);
    const second = request().send(async () => { secondTimes.push(Date.now()); return limited(); });
    await vi.advanceTimersByTimeAsync(29_000);
    expect((await first).status).toBe(429);
    let secondDone = false; void second.then(() => { secondDone = true; });
    await vi.advanceTimersByTimeAsync(0); expect(secondDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); expect((await second).status).toBe(429);
    expect(check).toHaveBeenCalledTimes(1);
    expect(firstTimes.slice(1).some((time) => secondTimes.slice(1).includes(time))).toBe(false);
  });

  it("honors a long Retry-After without switching or issuing an early retry", async () => {
    const send = vi.fn(async () => limited({ "retry-after": "60" }));
    const pending = request().send(send);
    await vi.advanceTimersByTimeAsync(30_000);
    const response = await pending;
    expect(send).toHaveBeenCalledTimes(1); expect(check).not.toHaveBeenCalled();
    expect(response.headers.get("retry-after")).toBe("30"); expect(await response.text()).toBe(ERROR_BODY);
  });

  it("does not make a new request wait behind another request's longer backoff", async () => {
    const first = request().send(async () => limited());
    await vi.advanceTimersByTimeAsync(8000);
    const times: number[] = [];
    const second = request().send(async () => { times.push(Date.now() - START); return limited(); });
    await vi.advanceTimersByTimeAsync(1000);
    expect(times).toEqual([8000, 9000]);
    await vi.advanceTimersByTimeAsync(29_000);
    expect((await first).status).toBe(429); expect((await second).status).toBe(429);
  });

  it("aborts a hung retry at the 30-second deadline and returns the original 429", async () => {
    let n = 0; let aborted = false;
    const pending = request().send(async (_auth, signal) => {
      if (++n === 1) return limited();
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true }));
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await (await pending).text()).toBe(ERROR_BODY); expect(aborted).toBe(true); expect(check).not.toHaveBeenCalled();
  });

  it("stops retrying when the client disconnects", async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => limited());
    const pending = request(controller.signal).send(send);
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(500); controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(30_000); expect(send).toHaveBeenCalledTimes(1);
  });

  it("counts time spent checking usage against the same 30-second budget", async () => {
    check.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 20_000)); return { failed: false, account: accounts[0] }; });
    const pending = request().send(async () => limited());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await (await pending).text()).toBe(ERROR_BODY);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("preserves success streams without retrying or starting Check now", async () => {
    const send = vi.fn(async () => new Response('data: {"text":"hello"}\n\n', { headers: { "content-type": "text/event-stream" } }));
    const result = await request().send(send);
    expect(await result.text()).toContain("hello");
    expect(send).toHaveBeenCalledTimes(1); expect(check).not.toHaveBeenCalled();
  });

  it("does not echo account credentials from a provider error back to the client", async () => {
    const pending = request().send(async () => new Response('{"error":{"message":"Rejected Bearer secret-a"}}', { status: 429, headers: { "retry-after": "60" } }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await (await pending).text()).not.toContain("secret-a");
  });
});
