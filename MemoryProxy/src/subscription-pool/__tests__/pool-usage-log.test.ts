import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeLogMock = vi.hoisted(() => vi.fn());
vi.mock("../../logger.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../logger.js")>();
  return { ...original, writeLog: writeLogMock };
});

import { buildClickHouseRow } from "../../clickhouse.js";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import { __primeAccountCacheForTests } from "../account-cache.js";
import { installFetch, makeApp, makeConfig, resetPoolState, setPoolTestTeams } from "./test-harness.js";
import type { PoolAccount } from "../types.js";

const SPACE = "sp-log";
const rows: InstanceUpstreamRow[] = [
  { group_id: "d", group_type: "default", name: "d", agents: ["claude-code"], enabled: true, mode: "official", base_url: "", api_key: "", model_id: "" },
  { group_id: "p", group_type: "custom", name: "p", agents: ["codex"], enabled: true, mode: "subscription_pool", team_id: "team-a", base_url: "", api_key: "", model_id: "" },
];
const account: PoolAccount = {
  account_id: "acc-log", group_id: "p", provider: "codex", provider_account_id: "chatgpt-log", status: "active", enabled: true,
  access_token: "tok", token_expires_at: Date.now() + 3_600_000, usage: { windows: [] }, exhausted_until: null,
};

const completed = JSON.stringify({ type: "response.completed", response: { id: "r", usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } } });
const sseBody = `event: response.completed\ndata: ${completed}\n\n`;

describe("usage rows of pool requests", () => {
  beforeEach(() => { resetPoolState(); writeLogMock.mockClear(); });
  afterEach(() => vi.unstubAllGlobals());

  it("record the serving account for a streamed turn", async () => {
    __primeCacheForTests(SPACE, rows);
    __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts: [account] });
    installFetch(() => new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await makeApp(makeConfig()).request(`/codex/${SPACE}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-user-key": "sk", authorization: "Bearer own", "session-id": "s1" },
      body: JSON.stringify({ model: "gpt-5", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }),
    });
    await res.text();
    await vi.waitFor(() => {
      const usage = writeLogMock.mock.calls.map((c) => c[1]).filter((e) => e.event === "usage");
      expect(usage.length).toBeGreaterThan(0);
      expect(usage[0].subscriptionAccountId).toBe("acc-log");
    });
  });

  it("do not carry the field outside a pool", async () => {
    __primeCacheForTests(SPACE, [rows[0]!, { ...rows[1]!, mode: "custom_passthrough", base_url: "http://custom.test/api" }]);
    installFetch(() => new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await makeApp(makeConfig()).request(`/codex/${SPACE}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer own", "session-id": "s1" },
      body: JSON.stringify({ model: "gpt-5", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }),
    });
    await res.text();
    await vi.waitFor(() => {
      expect(writeLogMock.mock.calls.some((c) => c[1].event === "usage")).toBe(true);
    });
    for (const call of writeLogMock.mock.calls) expect("subscriptionAccountId" in call[1]).toBe(false);
  });
});

describe("usage rows and log line of Claude Code pool requests", () => {
  const claudeRows: InstanceUpstreamRow[] = [
    rows[0]!,
    { group_id: "pc", group_type: "custom", name: "pc", agents: ["claude-code"], enabled: true, mode: "subscription_pool", team_id: "team-a", base_url: "", api_key: "", model_id: "" },
  ];
  const claudeAccount: PoolAccount = {
    account_id: "acc-claude", group_id: "pc", provider: "claude", provider_account_id: "claude-log", status: "active", enabled: true,
    access_token: "claude-secret-token", token_expires_at: Date.now() + 3_600_000, usage: { windows: [] }, exhausted_until: null,
  };
  const message = { id: "msg", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };
  const streamed = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");

  async function claudeTurn(stream: boolean): Promise<void> {
    __primeCacheForTests(SPACE, claudeRows);
    __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts: [claudeAccount] });
    setPoolTestTeams(["team-a"]);
    installFetch(() => stream
      ? new Response(streamed, { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await makeApp(makeConfig()).request(`/claude-code/${SPACE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-user-key": "sk-mem-user", "x-memory-mode": "off" },
      body: JSON.stringify({ model: "claude-x", max_tokens: 8, stream, messages: [{ role: "user", content: "hi" }] }),
    });
    await res.text();
  }

  const usageEntries = () => writeLogMock.mock.calls.map((c) => c[1]).filter((e) => e.event === "usage" && !e.usage?.error);

  beforeEach(() => {
    resetPoolState();
    writeLogMock.mockClear();
    for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([[false], [true]])("record the serving account and team for a Claude Code turn (stream=%s)", async (stream) => {
    await claudeTurn(stream);
    await vi.waitFor(() => {
      expect(usageEntries().length).toBeGreaterThan(0);
    });
    expect(usageEntries()[0]).toMatchObject({ subscriptionAccountId: "acc-claude", subscriptionTeamId: "team-a" });
  });

  it("writes one console line with the account id and team id, and never a token", async () => {
    await claudeTurn(false);
    const lines = (console.info as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    const served = lines.filter((l) => l.includes("[subscription-pool] served"));
    expect(served).toEqual(["[subscription-pool] served account_id=acc-claude team=team-a"]);
    const everything = JSON.stringify([
      ...["log", "warn", "error", "info", "debug"].flatMap((m) => (console[m as "log"] as unknown as ReturnType<typeof vi.fn>).mock.calls),
      ...writeLogMock.mock.calls,
    ]);
    expect(everything).not.toContain("claude-secret-token");
  });

  it("do not carry the fields for a Claude Code turn outside a pool", async () => {
    __primeCacheForTests(SPACE, [rows[0]!]);
    installFetch(() => new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await makeApp(makeConfig()).request(`/claude-code/${SPACE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "client-key" },
      body: JSON.stringify({ model: "claude-x", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    await res.text();
    await vi.waitFor(() => {
      expect(usageEntries().length).toBeGreaterThan(0);
    });
    for (const entry of usageEntries()) {
      expect("subscriptionAccountId" in entry).toBe(false);
      expect("subscriptionTeamId" in entry).toBe(false);
    }
  });
});

describe("buildClickHouseRow", () => {
  const base = {
    timestamp: "2026-10-19T00:00:00.000Z", event: "usage", modelId: "m", keyId: "k", upstreamUrl: "u", stream: true,
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };
  it("fills subscription_account_id for pool requests and leaves it empty otherwise", () => {
    expect(buildClickHouseRow({ ...base, subscriptionAccountId: "acc-1" })?.subscription_account_id).toBe("acc-1");
    expect(buildClickHouseRow(base)?.subscription_account_id).toBe("");
  });
});
