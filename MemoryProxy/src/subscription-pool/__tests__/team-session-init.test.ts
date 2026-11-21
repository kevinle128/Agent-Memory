/**
 * The team of a request while session init runs in the same request. Init can register the
 * session in another team than the first answer, show a form, or leave the session without a team.
 * The Claude Code runner is real; the session init state machine is replaced by a function that
 * writes the state it would write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import { __resetSessionStoreForTests, getSessionStore } from "../../session/store.js";
import type { SessionInitState } from "../../session/types.js";
import { __primeAccountCacheForTests } from "../account-cache.js";
import type { PoolAccount } from "../types.js";
import {
  CORE_URL, installFetch, jsonResponse, makeApp, makeConfig, POOL_TEST_USER, registerPoolTestSession, resetPoolState,
  setPoolTestTeams, useRealSessionTeams, type RecordedCall,
} from "./test-harness.js";

const SPACE = "sp-init";
const SESSION = "11111111-2222-3333-4444-555555555555";
const NOW = Date.now();
const HOUR = 3_600_000;

type Orchestrate = (args: unknown) => Promise<unknown>;
const orchestrate = vi.hoisted(() => vi.fn<Orchestrate>());
vi.mock("../../pipeline/stages/session-init-orchestrate.js", () => ({
  stageSessionInitOrchestrate: (args: unknown) => orchestrate(args),
}));

const defaultRow: InstanceUpstreamRow = {
  group_id: "d", group_type: "default", name: "default", agents: ["claude-code"], enabled: true,
  mode: "official", base_url: "", api_key: "", model_id: "",
};
const poolOf = (team: string): InstanceUpstreamRow => ({
  group_id: `claude-${team}`, group_type: "custom", name: `claude pool ${team}`, agents: ["claude-code"], enabled: true,
  mode: "subscription_pool", team_id: team, base_url: "", api_key: "", model_id: "",
});
const accountOf = (team: string, partial: Partial<PoolAccount> = {}): PoolAccount => ({
  account_id: `ca-${team}`, group_id: `claude-${team}`, provider: "claude", provider_account_id: `acct-${team}`,
  status: "active", enabled: true, access_token: `claude-token-${team}`, token_expires_at: NOW + HOUR,
  usage: { windows: [] }, exhausted_until: null, ...partial,
});
const exhausted = (team: string): PoolAccount => accountOf(team, { status: "exhausted", exhausted_until: NOW + HOUR });

const message = { id: "msg", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };

function prime(accounts: PoolAccount[]): void {
  __primeCacheForTests(SPACE, [defaultRow, poolOf("team-a"), poolOf("team-b")]);
  __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts });
}

async function send(extra: Record<string, string> = {}): Promise<Response> {
  const config = makeConfig();
  config.sessionInit = { ...(config.sessionInit ?? {}), enabled: true } as typeof config.sessionInit;
  config.injection = { ...(config.injection ?? {}), enabled: false } as typeof config.injection;
  const res = await makeApp(config).request(`/claude-code/${SPACE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-user-key": "sk-mem-user", "x-claude-code-session-id": SESSION, ...extra },
    body: JSON.stringify({ model: "claude-x", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }),
  });
  return res;
}

/**
 * Calls to a model upstream. With session init on, other parts of the proxy also call helper
 * endpoints, and those are not the request that is under test.
 */
const modelCalls = (calls: RecordedCall[]): RecordedCall[] =>
  calls.filter((call) => call.url.startsWith("https://api.anthropic.com") || call.url.startsWith("http://global-upstream.test"));

/** The result of an init that registered the session in `team`, after it wrote the state. */
async function registersIn(team: string): Promise<unknown> {
  await registerPoolTestSession("claude-code", SESSION, team);
  return {
    proceed: true, response: null, wentThroughStateMachine: true,
    initResult: {
      intercepted: false, bypassed: false, justRegistered: true,
      sessionInfo: { team_id: team, user_id: POOL_TEST_USER, agent_id: "a1", session_id: SESSION },
    },
  };
}

describe("team of a request while session init runs", () => {
  beforeEach(() => {
    resetPoolState();
    useRealSessionTeams();
    setPoolTestTeams(["team-b", "team-a"]);
    orchestrate.mockReset();
    for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetSessionStoreForTests();
  });

  it("a session whose team changed during init uses the new team in the same turn", async () => {
    prime([accountOf("team-a"), accountOf("team-b")]);
    // The first answer is the fallback team B (newest first); init registers the session in team A.
    orchestrate.mockImplementation(() => registersIn("team-a"));
    const { upstreamCalls: allCalls } = installFetch(() => jsonResponse(message));
    const res = await send();
    const upstreamCalls = modelCalls(allCalls);
    await res.text();
    expect(res.status).toBe(200);
    expect(orchestrate).toHaveBeenCalledTimes(1);
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer claude-token-team-a");
    expect(upstreamCalls.map((call) => call.headers["authorization"] ?? "").join("|")).not.toContain("team-b");
  });

  it("a session registered in a team without a pool runs on the normal upstream in the same turn", async () => {
    setPoolTestTeams(["team-a", "team-c"]);
    prime([accountOf("team-a")]);
    orchestrate.mockImplementation(() => registersIn("team-c"));
    const { upstreamCalls: allCalls } = installFetch(() => jsonResponse(message));
    const res = await send({ "x-api-key": "client-key" });
    await res.text();
    const upstreamCalls = modelCalls(allCalls);
    expect(res.status).toBe(200);
    expect(upstreamCalls[0]!.url).toMatch(/^http:\/\/global-upstream\.test/);
    expect(upstreamCalls.map((call) => call.headers["authorization"] ?? "").join("|")).not.toContain("claude-token");
  });

  it("a bypassed session with a chosen team uses that team, not the first team with a usable pool", async () => {
    prime([accountOf("team-a"), accountOf("team-b")]);
    orchestrate.mockImplementation(async () => {
      const keyId = `claude-code:${SESSION}`;
      await getSessionStore().set(keyId, {
        status: "initialized", keyId, startedAt: Date.now(), attemptCount: 0, userId: POOL_TEST_USER,
        bypassed: true, sessionInfo: null, selectedTeamId: "team-a",
      } as SessionInitState);
      return { proceed: true, response: null, wentThroughStateMachine: true, initResult: { intercepted: false, bypassed: true } };
    });
    const { upstreamCalls: allCalls } = installFetch(() => jsonResponse(message));
    await (await send()).text();
    const upstreamCalls = modelCalls(allCalls);
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer claude-token-team-a");
  });

  it("a team error does not block a form that init shows, and no upstream is called", async () => {
    prime([exhausted("team-a"), exhausted("team-b")]);
    orchestrate.mockResolvedValue({
      proceed: false, wentThroughStateMachine: true, initResult: null,
      response: jsonResponse({ type: "message", role: "assistant", content: [{ type: "text", text: "pick a team" }] }),
    });
    const { upstreamCalls: allCalls } = installFetch(() => jsonResponse(message));
    const res = await send();
    const upstreamCalls = modelCalls(allCalls);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pick a team");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("answers the deferred team error after init when init gives no team, before any upstream call", async () => {
    prime([exhausted("team-a"), exhausted("team-b")]);
    orchestrate.mockResolvedValue({
      proceed: true, response: null, wentThroughStateMachine: true,
      initResult: { intercepted: false, bypassed: true, justRegistered: false },
    });
    const { upstreamCalls: allCalls } = installFetch(() => jsonResponse(message));
    const res = await send();
    const upstreamCalls = modelCalls(allCalls);
    expect(res.status).toBe(429);
    expect(res.headers.get("x-tdai-pool-status")).toBe("exhausted");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("uses the registered team of init instead of a deferred error", async () => {
    prime([exhausted("team-b"), accountOf("team-a")]);
    // Team B first and exhausted, team A usable: the first answer is team A; init also says team A.
    orchestrate.mockImplementation(() => registersIn("team-a"));
    const { upstreamCalls: allCalls } = installFetch(() => jsonResponse(message));
    await (await send()).text();
    const upstreamCalls = modelCalls(allCalls);
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer claude-token-team-a");
  });

  it("answers no_active_team after init for a user with no team, when init gave none", async () => {
    setPoolTestTeams([]);
    prime([accountOf("team-a")]);
    orchestrate.mockResolvedValue({
      proceed: true, response: null, wentThroughStateMachine: true,
      initResult: { intercepted: false, bypassed: true, justRegistered: false },
    });
    const { upstreamCalls: allCalls } = installFetch(() => jsonResponse(message), (call) =>
      call.url.startsWith(CORE_URL) ? jsonResponse({ code: 0, data: {} }) : jsonResponse({}));
    const res = await send();
    const upstreamCalls = modelCalls(allCalls);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { type: "no_active_team" } });
    expect(upstreamCalls).toHaveLength(0);
  });

  it("does not run the fallback again for a session that init already registered", async () => {
    prime([accountOf("team-a"), accountOf("team-b")]);
    await registerPoolTestSession("claude-code", SESSION, "team-a");
    orchestrate.mockResolvedValue({
      proceed: true, response: null, wentThroughStateMachine: false,
      initResult: {
        intercepted: false, bypassed: false, justRegistered: false,
        sessionInfo: { team_id: "team-a", user_id: POOL_TEST_USER, agent_id: "a1", session_id: SESSION },
      },
    });
    const { upstreamCalls: allCalls } = installFetch(() => jsonResponse(message));
    await (await send()).text();
    const upstreamCalls = modelCalls(allCalls);
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer claude-token-team-a");
  });

  describe("Codex", () => {
    const codexPoolOf = (team: string): InstanceUpstreamRow => ({ ...poolOf(team), group_id: `codex-${team}`, agents: ["codex"] });
    const codexAccountOf = (team: string, partial: Partial<PoolAccount> = {}): PoolAccount => ({
      ...accountOf(team), account_id: `xa-${team}`, group_id: `codex-${team}`, provider: "codex",
      provider_account_id: `chatgpt-${team}`, access_token: `codex-token-${team}`, ...partial,
    });
    const sse = (): Response => new Response("data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n", {
      status: 200, headers: { "content-type": "text/event-stream" },
    });

    async function sendCodex(): Promise<Response> {
      const config = makeConfig();
      config.sessionInit = { ...(config.sessionInit ?? {}), enabled: true } as typeof config.sessionInit;
      config.injection = { ...(config.injection ?? {}), enabled: false } as typeof config.injection;
      return makeApp(config).request(`/codex/${SPACE}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json", "x-tdai-user-key": "sk-mem-user", authorization: "Bearer chatgpt-own-token",
          "chatgpt-account-id": "own-acct", "session-id": SESSION,
        },
        body: JSON.stringify({ model: "gpt-5-codex", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], stream: true }),
      });
    }

    function primeCodex(accounts: PoolAccount[]): void {
      __primeCacheForTests(SPACE, [{ ...defaultRow, agents: ["codex"] }, codexPoolOf("team-a"), codexPoolOf("team-b")]);
      __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts });
    }

    const codexModelCalls = (calls: RecordedCall[]): RecordedCall[] =>
      calls.filter((call) => call.url.startsWith("https://chatgpt.com") || call.url.startsWith("http://global-upstream.test"));

    it("a session whose team changed during init uses the new team in the same turn", async () => {
      primeCodex([codexAccountOf("team-a"), codexAccountOf("team-b")]);
      orchestrate.mockImplementation(async () => {
        await registerPoolTestSession("codex", SESSION, "team-a");
        return {
          proceed: true, response: null, wentThroughStateMachine: true,
          initResult: {
            intercepted: false, bypassed: false, justRegistered: true,
            sessionInfo: { team_id: "team-a", user_id: POOL_TEST_USER, agent_id: "a1", session_id: SESSION },
          },
        };
      });
      const { upstreamCalls } = installFetch(() => sse());
      await (await sendCodex()).text();
      const calls = codexModelCalls(upstreamCalls);
      expect(calls[0]!.headers["authorization"]).toBe("Bearer codex-token-team-a");
      expect(calls.map((call) => call.headers["authorization"] ?? "").join("|")).not.toContain("team-b");
    });

    it("answers the deferred team error after init, before any upstream call", async () => {
      primeCodex([codexAccountOf("team-a", { status: "exhausted", exhausted_until: NOW + HOUR }), codexAccountOf("team-b", { status: "exhausted", exhausted_until: NOW + HOUR })]);
      orchestrate.mockResolvedValue({
        proceed: true, response: null, wentThroughStateMachine: true,
        initResult: { intercepted: false, bypassed: true, justRegistered: false },
      });
      const { upstreamCalls } = installFetch(() => sse());
      const res = await sendCodex();
      expect(res.status).toBe(429);
      expect(codexModelCalls(upstreamCalls)).toHaveLength(0);
    });
  });
});
