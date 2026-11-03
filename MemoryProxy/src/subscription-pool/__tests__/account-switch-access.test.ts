import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __primeCacheForTests, clearCache, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import { canUseAccountSwitch, resetAccountSwitchAccessForTests, resolveSwitchPool } from "../account-switch-access.js";

const CONFIG = {
  coreSkill: { endpoint: "http://core.test", serviceToken: "svc", timeoutMs: 1000 },
  instanceUpstream: { cacheTtlSec: 30 },
};

function listResponse(items: unknown[]): Response {
  return new Response(JSON.stringify({ code: 0, data: { items, total: items.length, limit: 1, offset: 0 } }), { status: 200 });
}

describe("canUseAccountSwitch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetAccountSwitchAccessForTests();
    fetchMock = vi.fn(async () => listResponse([{ user_id: "u-admin", user_type: "system_admin" }]));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("allows a system admin and caches the answer", async () => {
    expect(await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-admin" })).toBe(true);
    expect(await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-admin" })).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://core.test/v3/internal/meta/user/list-by-instance");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-tdai-service-id"]).toBe("sp1");
    expect(headers["Authorization"]).toBe("Bearer svc");
    expect(JSON.parse(init.body as string)).toEqual({ user_ids: ["u-admin"], user_type: "system_admin", limit: 1 });
  });

  it("denies a normal user", async () => {
    // Core filters by role, so a normal user gives an empty list.
    fetchMock.mockImplementation(async () => listResponse([]));
    expect(await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-normal" })).toBe(false);
  });

  it("denies when Core ignores the role filter and returns a normal user", async () => {
    fetchMock.mockImplementation(async () => listResponse([{ user_id: "u-normal", user_type: "normal" }]));
    expect(await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-normal" })).toBe(false);
  });

  it("denies when Core returns the row of another user", async () => {
    fetchMock.mockImplementation(async () => listResponse([{ user_id: "u-other", user_type: "system_admin" }]));
    expect(await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-admin" })).toBe(false);
  });

  it("denies when the user is missing from the instance", async () => {
    fetchMock.mockImplementation(async () => listResponse([]));
    expect(await canUseAccountSwitch(CONFIG, { spaceId: "sp-other", userId: "u-admin" })).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("denies without a Core call when the space or user is missing or anonymous", async () => {
    expect(await canUseAccountSwitch(CONFIG, { spaceId: "", userId: "u-admin" })).toBe(false);
    expect(await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "" })).toBe(false);
    expect(await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "anonymous" })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("denies and does not cache when Core fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ code: 500, message: "INTERNAL: boom" }), { status: 500 }));
    expect(await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-admin" })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("svc");

    expect(await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-admin" })).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("denies and does not cache when Core is unreachable or returns no items", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementationOnce(async () => { throw new TypeError("fetch failed"); });
    expect(await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-admin" })).toBe(false);
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }));
    expect(await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-admin" })).toBe(false);
    expect(await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-admin" })).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keys the cache by instance", async () => {
    await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-admin" });
    await canUseAccountSwitch(CONFIG, { spaceId: "sp2", userId: "u-admin" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const spaces = fetchMock.mock.calls.map((call) => ((call[1] as RequestInit).headers as Record<string, string>)["x-tdai-service-id"]);
    expect(spaces).toEqual(["sp1", "sp2"]);
  });

  it("shares one Core call between concurrent checks", async () => {
    const results = await Promise.all([
      canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-admin" }),
      canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-admin" }),
      canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-admin" }),
    ]);
    expect(results).toEqual([true, true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps an allow for five minutes and a deny for one minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-admin" });
    fetchMock.mockImplementation(async () => listResponse([]));
    await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-normal" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(1_800_000_000_000 + 61_000);
    expect(await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-admin" })).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-normal" });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    vi.setSystemTime(1_800_000_000_000 + 5 * 60_000 + 1_000);
    expect(await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-admin" })).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("evicts the oldest entry when the cache is full", async () => {
    for (let i = 0; i < 1000; i++) {
      await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: `u-${i}` });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1000);
    await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-1000" });
    await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-999" });
    expect(fetchMock).toHaveBeenCalledTimes(1001);
    await canUseAccountSwitch(CONFIG, { spaceId: "sp1", userId: "u-0" });
    expect(fetchMock).toHaveBeenCalledTimes(1002);
  });
});

describe("resolveSwitchPool", () => {
  const SPACE = "sp-pool";
  const defaultRow: InstanceUpstreamRow = {
    group_id: "d", group_type: "default", name: "default", agents: ["claude-code", "codex", "codebuddy"], enabled: true,
    mode: "official", base_url: "", api_key: "", model_id: "",
  };
  function poolRow(partial: Partial<InstanceUpstreamRow>): InstanceUpstreamRow {
    return {
      group_id: "pool", group_type: "custom", name: "pool", agents: [], enabled: true,
      mode: "subscription_pool", base_url: "", api_key: "", model_id: "", ...partial,
    };
  }

  beforeEach(() => {
    clearCache();
    // Any Core call means the primed instance config was not used.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected Core call"); }));
  });
  afterEach(() => {
    clearCache();
    vi.unstubAllGlobals();
  });

  it("maps a pool for claude-code to the claude provider", async () => {
    const row = poolRow({ agents: ["claude-code"] });
    __primeCacheForTests(SPACE, [defaultRow, row]);
    expect(await resolveSwitchPool(CONFIG, SPACE, "claude-code")).toEqual({ provider: "claude", row });
  });

  it("maps a pool for codex to the codex provider", async () => {
    const row = poolRow({ agents: ["codex"] });
    __primeCacheForTests(SPACE, [defaultRow, row]);
    expect(await resolveSwitchPool(CONFIG, SPACE, "codex")).toEqual({ provider: "codex", row });
  });

  it("returns null for an agent without account switch support", async () => {
    __primeCacheForTests(SPACE, [defaultRow, poolRow({ agents: ["codebuddy"] })]);
    expect(await resolveSwitchPool(CONFIG, SPACE, "codebuddy")).toBeNull();
  });

  it("returns null when the agent group is custom_unified", async () => {
    __primeCacheForTests(SPACE, [defaultRow, poolRow({ agents: ["codex"], mode: "custom_unified", base_url: "http://x" })]);
    expect(await resolveSwitchPool(CONFIG, SPACE, "codex")).toBeNull();
  });

  it("returns null when the pool group is disabled", async () => {
    __primeCacheForTests(SPACE, [defaultRow, poolRow({ agents: ["codex"], enabled: false })]);
    expect(await resolveSwitchPool(CONFIG, SPACE, "codex")).toBeNull();
  });

  it("returns null when the agent uses the default group", async () => {
    __primeCacheForTests(SPACE, [defaultRow]);
    expect(await resolveSwitchPool(CONFIG, SPACE, "claude-code")).toBeNull();
  });
});
