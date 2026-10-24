import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../report/log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { initAuth, resetAuthCacheForTest, verifyUserKey } from "../auth.js";

const VALID = { code: 0, data: { valid: true, user: { user_id: "usr-1" } } };
const INVALID = { code: 0, data: { valid: false } };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("verifyUserKey while the auth service is unavailable", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    resetAuthCacheForTest();
    initAuth({ enabled: true, url: "http://core", timeoutMs: 0, apiKey: "", staleOnErrorMs: 60_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    initAuth({ enabled: false, url: "", timeoutMs: 0, apiKey: "" });
  });

  it("accepts a recently verified key when the service cannot be reached", async () => {
    fetchMock.mockResolvedValueOnce(json(200, VALID));
    expect(await verifyUserKey("sk-a", "default")).toEqual({ userId: "usr-1", rejected: false });

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await verifyUserKey("sk-a", "default")).toEqual({ userId: "usr-1", rejected: false });

    fetchMock.mockResolvedValueOnce(json(503, {}));
    expect(await verifyUserKey("sk-a", "default")).toEqual({ userId: "usr-1", rejected: false });
  });

  it("rejects a key that was never verified", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await verifyUserKey("sk-new", "default")).rejected).toBe(true);
  });

  it("keeps the fallback per service id", async () => {
    fetchMock.mockResolvedValueOnce(json(200, VALID));
    await verifyUserKey("sk-a", "space-1");
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await verifyUserKey("sk-a", "space-2")).rejected).toBe(true);
  });

  it("stops accepting after the window", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(json(200, VALID));
    await verifyUserKey("sk-a", "default");
    vi.advanceTimersByTime(60_001);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await verifyUserKey("sk-a", "default")).rejected).toBe(true);
  });

  it("never serves a key that the service rejected after it was verified", async () => {
    fetchMock.mockResolvedValueOnce(json(200, VALID));
    await verifyUserKey("sk-a", "default");
    fetchMock.mockResolvedValueOnce(json(200, INVALID));
    expect((await verifyUserKey("sk-a", "default")).rejected).toBe(true);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await verifyUserKey("sk-a", "default")).rejected).toBe(true);
  });

  it("treats a 4xx as a refusal, not as an outage", async () => {
    fetchMock.mockResolvedValueOnce(json(200, VALID));
    await verifyUserKey("sk-a", "default");
    fetchMock.mockResolvedValueOnce(json(401, {}));
    expect((await verifyUserKey("sk-a", "default")).rejected).toBe(true);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await verifyUserKey("sk-a", "default")).rejected).toBe(true);
  });

  it("is off when staleOnErrorMs is 0", async () => {
    initAuth({ enabled: true, url: "http://core", timeoutMs: 0, apiKey: "", staleOnErrorMs: 0 });
    fetchMock.mockResolvedValueOnce(json(200, VALID));
    await verifyUserKey("sk-a", "default");
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await verifyUserKey("sk-a", "default")).rejected).toBe(true);
  });

  it("refuses a 200 that is not JSON and gives no fallback after it", async () => {
    fetchMock.mockResolvedValueOnce(json(200, VALID));
    await verifyUserKey("sk-a", "default");
    fetchMock.mockResolvedValueOnce(new Response("<html>error</html>", { status: 200 }));
    expect((await verifyUserKey("sk-a", "default")).rejected).toBe(true);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await verifyUserKey("sk-a", "default")).rejected).toBe(true);
  });

  it("does not bring back a key when a slow success started before a refusal", async () => {
    fetchMock.mockResolvedValueOnce(json(200, VALID));
    await verifyUserKey("sk-a", "default");
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));
    const slow = verifyUserKey("sk-a", "default");
    await new Promise((r) => setTimeout(r, 5));
    fetchMock.mockResolvedValueOnce(json(200, INVALID));
    await verifyUserKey("sk-a", "default");
    release(json(200, VALID));
    await slow;
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await verifyUserKey("sk-a", "default")).rejected).toBe(true);
  });
});
