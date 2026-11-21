/**
 * The team of a session end to end: the real session init writes the state, and the next turn must
 * find that state under the key the request team helper builds. A key or identity that differs
 * between the two would send every registered session to the fallback, so these tests use no
 * replaced init function and no stubbed session store.
 *
 * Session init registers the session through the forced identity of the developer config, so no
 * team form and no Core team list is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import { __resetSessionStoreForTests } from "../../session/store.js";
import type { ProxyConfig } from "../../types.js";
import { __primeAccountCacheForTests } from "../account-cache.js";
import type { PoolAccount } from "../types.js";
import {
  installFetch, jsonResponse, makeApp, makeConfig, resetPoolState, setPoolTestTeams, useRealSessionTeams, type RecordedCall,
} from "./test-harness.js";

const SPACE = "sp-key";
const SESSION = "11111111-2222-3333-4444-555555555555";
const NOW = Date.now();
const HOUR = 3_600_000;

const defaultRow: InstanceUpstreamRow = {
  group_id: "d", group_type: "default", name: "default", agents: ["claude-code", "codex"], enabled: true,
  mode: "official", base_url: "", api_key: "", model_id: "",
};
const poolOf = (team: string, agent: string, kind: string): InstanceUpstreamRow => ({
  group_id: `${kind}-${team}`, group_type: "custom", name: `${kind} pool ${team}`, agents: [agent], enabled: true,
  mode: "subscription_pool", team_id: team, base_url: "", api_key: "", model_id: "",
});
const accountOf = (team: string, provider: "claude" | "codex", kind: string): PoolAccount => ({
  account_id: `${kind}-acc-${team}`, group_id: `${kind}-${team}`, provider, provider_account_id: `${kind}-p-${team}`,
  status: "active", enabled: true, access_token: `${kind}-token-${team}`, token_expires_at: NOW + HOUR,
  usage: { windows: [] }, exhausted_until: null,
});

function configWithForcedTeam(team: string): ProxyConfig {
  const config = makeConfig();
  config.sessionInit = {
    ...(config.sessionInit ?? {}), enabled: true, debugForceIdentity: { team_id: team, agent_id: "ag1", task_id: "t1" },
  } as ProxyConfig["sessionInit"];
  config.injection = { ...(config.injection ?? {}), enabled: false } as ProxyConfig["injection"];
  return config;
}

const modelCalls = (calls: RecordedCall[]): RecordedCall[] =>
  calls.filter((call) => /^(https:\/\/api\.anthropic\.com|https:\/\/chatgpt\.com|http:\/\/global-upstream\.test)/.test(call.url));

describe("the session team found by the key of the runner", () => {
  beforeEach(() => {
    resetPoolState();
    useRealSessionTeams();
    // Core order: team A first. Without the session team, the fallback would pick team A.
    setPoolTestTeams(["team-a", "team-b"]);
    for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetSessionStoreForTests();
  });

  it("Claude Code: turn 1 registers in team B and turn 2 carries the token of team B", async () => {
    __primeCacheForTests(SPACE, [defaultRow, poolOf("team-a", "claude-code", "claude"), poolOf("team-b", "claude-code", "claude")]);
    __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts: [accountOf("team-a", "claude", "claude"), accountOf("team-b", "claude", "claude")] });
    const { upstreamCalls } = installFetch(() => jsonResponse({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
    const app = makeApp(configWithForcedTeam("team-b"));
    const send = () => app.request(`/claude-code/${SPACE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-user-key": "sk-mem-user", "x-claude-code-session-id": SESSION },
      body: JSON.stringify({ model: "claude-x", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    await (await send()).text();
    await (await send()).text();
    const tokens = modelCalls(upstreamCalls).map((call) => call.headers["authorization"]);
    expect(tokens).toEqual(["Bearer claude-token-team-b", "Bearer claude-token-team-b"]);
    expect(tokens.join("|")).not.toContain("team-a");
  });

  it("Claude Code: a sidequery with a main session in the store uses the pool of that team", async () => {
    __primeCacheForTests(SPACE, [defaultRow, poolOf("team-a", "claude-code", "claude"), poolOf("team-b", "claude-code", "claude")]);
    __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts: [accountOf("team-a", "claude", "claude"), accountOf("team-b", "claude", "claude")] });
    const { upstreamCalls } = installFetch(() => jsonResponse({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
    const config = configWithForcedTeam("team-b");
    config.ccRequestRouting = { enabled: true } as ProxyConfig["ccRequestRouting"];
    const app = makeApp(config);
    const post = (body: Record<string, unknown>) => app.request(`/claude-code/${SPACE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-user-key": "sk-mem-user", "x-claude-code-session-id": SESSION },
      body: JSON.stringify({ model: "claude-x", max_tokens: 8, stream: false, ...body }),
    });
    // The main turn: a tool list and a cache marker on the user turn make it a main request.
    const main = {
      tools: [{ name: "Bash", description: "x", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "fix it", cache_control: { type: "ephemeral" } }] }],
    };
    await (await post(main)).text();
    // The sidequery: no tools and no cache marker. It runs no session init of its own.
    await (await post({ messages: [{ role: "user", content: "title this" }] })).text();
    const tokens = modelCalls(upstreamCalls).map((call) => call.headers["authorization"]);
    expect(tokens).toHaveLength(2);
    expect(tokens.every((token) => token === "Bearer claude-token-team-b")).toBe(true);
  });

  it("Codex: turn 1 registers in team B and turn 2 carries the token of team B", async () => {
    __primeCacheForTests(SPACE, [defaultRow, poolOf("team-a", "codex", "codex"), poolOf("team-b", "codex", "codex")]);
    __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts: [accountOf("team-a", "codex", "codex"), accountOf("team-b", "codex", "codex")] });
    const { upstreamCalls } = installFetch(() => new Response(
      "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const app = makeApp(configWithForcedTeam("team-b"));
    const send = () => app.request(`/codex/${SPACE}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-tdai-user-key": "sk-mem-user", authorization: "Bearer chatgpt-own-token",
        "chatgpt-account-id": "own-acct", "session-id": SESSION,
      },
      body: JSON.stringify({ model: "gpt-5-codex", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], stream: true }),
    });
    await (await send()).text();
    await (await send()).text();
    const tokens = modelCalls(upstreamCalls).map((call) => call.headers["authorization"]);
    expect(tokens).toEqual(["Bearer codex-token-team-b", "Bearer codex-token-team-b"]);
    expect(tokens.join("|")).not.toContain("team-a");
  });
});
