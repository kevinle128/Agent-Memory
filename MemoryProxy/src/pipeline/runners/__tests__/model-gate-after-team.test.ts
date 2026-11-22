/**
 * The model gate and the model source of the Codex, Anthropic and WorkBuddy runners while session
 * init can still change the team of the request. The runners are real; the session init state
 * machine is replaced by a function that writes the state it would write, and the upstreams are a
 * recording fetch.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../../instance-upstream-cache.js";
import { withClientFacingModel } from "../../../response-model-mask.js";
import { __resetSessionStoreForTests } from "../../../session/store.js";
import { __primeAccountCacheForTests } from "../../../subscription-pool/account-cache.js";
import {
  installFetch, jsonResponse, makeConfig, POOL_TEST_USER, registerPoolTestSession, resetPoolState,
  setPoolTestTeams, useRealSessionTeams, type RecordedCall,
} from "../../../subscription-pool/__tests__/test-harness.js";
import type { PoolAccount } from "../../../subscription-pool/types.js";
import type { ProxyConfig } from "../../../types.js";
import { runAnthropicPipeline } from "../anthropic.js";
import { runCodexPipeline } from "../codex.js";
import { runWorkbuddyPipeline } from "../workbuddy.js";

type Orchestrate = (args: unknown) => Promise<unknown>;
const orchestrate = vi.hoisted(() => vi.fn<Orchestrate>());
vi.mock("../../stages/session-init-orchestrate.js", () => ({
  stageSessionInitOrchestrate: (args: unknown) => orchestrate(args),
}));

const SPACE = "sp-gate";
const NOW = Date.now();
const HOUR = 3_600_000;

interface PricingEntry { name: string; modelName: string }
const priced = (...entries: PricingEntry[]): ProxyConfig["creditPricing"] =>
  ({ models: entries.map((e) => ({ ...e, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })) });

function configWith(pricing: ProxyConfig["creditPricing"]): ProxyConfig {
  const config = makeConfig();
  config.sessionInit = {
    ...(config.sessionInit ?? {}), enabled: true,
    headerAutoSelect: { enabled: true, teamHeader: "x-team-id", agentHeader: "x-agent-id", taskHeader: "x-task-id", onMismatch: "form" },
  } as typeof config.sessionInit;
  config.injection = { ...(config.injection ?? {}), enabled: false } as typeof config.injection;
  config.modelSources = { enabled: true };
  config.creditPricing = pricing;
  return config;
}

function appFor(config: ProxyConfig): Hono {
  const app = new Hono();
  const responses = withClientFacingModel(runCodexPipeline);
  const messages = withClientFacingModel(runAnthropicPipeline);
  const workbuddy = withClientFacingModel(runWorkbuddyPipeline);
  app.post("/codex/:spaceId/v1/responses", (c) => responses(c, config));
  app.post("/hermes/:spaceId/v1/responses", (c) => responses(c, config));
  app.post("/hermes/:spaceId/v1/messages", (c) => messages(c, config));
  app.post("/claude-code/:spaceId/v1/messages", (c) => messages(c, config));
  app.post("/workbuddy/:spaceId/v1/responses", (c) => workbuddy(c, config));
  return app;
}

const defaultRow = (agents: string[]): InstanceUpstreamRow => ({
  group_id: "d", group_type: "default", name: "default", agents, enabled: true, mode: "official",
  base_url: "", api_key: "", model_id: "",
});
const agentPool = (team: string, agent: string): InstanceUpstreamRow => ({
  group_id: `pool-${agent}-${team}`, group_type: "custom", name: `${agent} pool ${team}`, agents: [agent], enabled: true,
  mode: "subscription_pool", team_id: team, base_url: "", api_key: "", model_id: "",
});
const sourcePool = (team: string, agent: string, source: string, format: string, model: string): InstanceUpstreamRow => ({
  group_id: `src-${source}-${team}`, group_type: "custom", name: `${source} ${team}`, agents: [], enabled: true,
  mode: "subscription_pool", team_id: team, base_url: "", api_key: "", model_id: "",
  source_name: source, source_provider: format === "anthropic-messages" ? "claude" : "codex",
  source_formats: [format], source_agents: [agent],
  source_models: [{ id: model, enabled: true, available: true }],
});
const account = (row: InstanceUpstreamRow, partial: Partial<PoolAccount> = {}): PoolAccount => ({
  account_id: `acct-${row.group_id}`, group_id: row.group_id,
  provider: row.source_provider === "claude" || row.agents.includes("claude-code") ? "claude" : "codex",
  provider_account_id: `provider-${row.group_id}`, status: "active", enabled: true,
  access_token: `token-${row.group_id}`, token_expires_at: NOW + HOUR, usage: { windows: [] }, exhausted_until: null,
  ...partial,
});
const exhausted = (row: InstanceUpstreamRow): PoolAccount =>
  account(row, { status: "exhausted", exhausted_until: NOW + HOUR });

function prime(rows: InstanceUpstreamRow[], accounts: PoolAccount[]): void {
  __primeCacheForTests(SPACE, rows);
  __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts });
}

/** Session init that registers the session in `team`, as the real state machine does. */
const registersIn = (agentSource: string, sessionId: string, team: string) => async (): Promise<unknown> => {
  await registerPoolTestSession(agentSource, sessionId, team);
  return {
    proceed: true, response: null, wentThroughStateMachine: true,
    initResult: {
      intercepted: false, bypassed: false, justRegistered: true,
      sessionInfo: { team_id: team, user_id: POOL_TEST_USER, agent_id: "a1", session_id: sessionId },
    },
  };
};
/** Session init that gives the session no team. */
const givesNoTeam = async (): Promise<unknown> => ({
  proceed: true, response: null, wentThroughStateMachine: true,
  initResult: { intercepted: false, bypassed: true, justRegistered: false },
});
/** Session init that shows a form and needs no upstream. */
const showsForm = async (): Promise<unknown> => ({
  proceed: false, wentThroughStateMachine: true, initResult: null,
  response: jsonResponse({ type: "message", role: "assistant", content: [{ type: "text", text: "pick a team" }] }),
});

const modelCalls = (calls: RecordedCall[]): RecordedCall[] => calls.filter((call) =>
  call.url.startsWith("https://chatgpt.com") || call.url.startsWith("https://api.anthropic.com")
  || call.url.startsWith("http://global-upstream.test"));
const bodyOf = (call: RecordedCall): { model: string } => JSON.parse(call.body) as { model: string };

const responsesReply = (model: string) => ({
  id: "resp_1", object: "response", model, status: "completed", output: [],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});
const messageReply = (model: string) => ({
  id: "msg", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 1, output_tokens: 1 },
});
const responsesInput = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];

function responsesRequest(app: Hono, agent: string, model: string, headers: Record<string, string>): Response | Promise<Response> {
  return app.request(`/${agent}/${SPACE}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-user-key": "sk-mem-user", authorization: "Bearer own-token", ...headers },
    body: JSON.stringify({ model, stream: false, input: responsesInput }),
  });
}
function messagesRequest(app: Hono, agent: string, model: string, headers: Record<string, string>): Response | Promise<Response> {
  return app.request(`/${agent}/${SPACE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-user-key": "sk-mem-user", "x-api-key": "client-key", ...headers },
    body: JSON.stringify({ model, max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }),
  });
}

function quiet(): void {
  for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
}
function setup(teams: string[]): void {
  resetPoolState();
  useRealSessionTeams();
  setPoolTestTeams(teams);
  orchestrate.mockReset();
  quiet();
}
function teardown(): void {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetSessionStoreForTests();
}

describe("Codex runner: model gate and model source after the team settles", () => {
  const SESSION = "codex-session-1";
  const pool = (team: string) => agentPool(team, "codex");
  const send = (app: Hono, model: string, headers: Record<string, string> = {}) =>
    responsesRequest(app, "codex", model, { "session-id": SESSION, "chatgpt-account-id": "own-acct", ...headers });
  const pricing = priced({ name: "gpt-5-real", modelName: "gpt-5-codex" });

  afterEach(teardown);

  it("a predicted team without a pool does not reject a pool model before init registers a pool team", async () => {
    setup(["team-c", "team-a"]);
    prime([defaultRow(["codex"]), pool("team-a")], [account(pool("team-a"))]);
    orchestrate.mockImplementation(registersIn("codex", SESSION, "team-a"));
    const { upstreamCalls } = installFetch(() => jsonResponse(responsesReply("pool-model")));
    const res = await send(appFor(configWith(pricing)), "pool-model", { "x-team-id": "team-c" });
    await res.text();
    const calls = modelCalls(upstreamCalls);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/^https:\/\/chatgpt\.com/);
    expect(calls[0]!.headers["authorization"]).toBe("Bearer token-pool-codex-team-a");
    expect(bodyOf(calls[0]!).model).toBe("pool-model");
  });

  it("a deferred team error is answered after init and not as an unregistered model", async () => {
    setup(["team-b", "team-a"]);
    const rows = [defaultRow(["codex"]), pool("team-a"), pool("team-b")];
    prime(rows, [exhausted(pool("team-a")), exhausted(pool("team-b"))]);
    orchestrate.mockImplementation(givesNoTeam);
    const { upstreamCalls } = installFetch(() => jsonResponse(responsesReply("pool-model")));
    const res = await send(appFor(configWith(pricing)), "pool-model");
    expect(res.status).toBe(429);
    expect(modelCalls(upstreamCalls)).toHaveLength(0);
  });

  it("the form of init is shown while the first team answer is a deferred error", async () => {
    setup(["team-b", "team-a"]);
    prime([defaultRow(["codex"]), pool("team-a"), pool("team-b")], [exhausted(pool("team-a")), exhausted(pool("team-b"))]);
    orchestrate.mockImplementation(showsForm);
    const { upstreamCalls } = installFetch(() => jsonResponse(responsesReply("pool-model")));
    const res = await send(appFor(configWith(pricing)), "pool-model");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pick a team");
    expect(modelCalls(upstreamCalls)).toHaveLength(0);
  });

  it("a settled team without a pool gates a model that is not in the pricing table", async () => {
    setup(["team-a", "team-c"]);
    prime([defaultRow(["codex"]), pool("team-a")], [account(pool("team-a"))]);
    orchestrate.mockImplementation(registersIn("codex", SESSION, "team-c"));
    const { upstreamCalls } = installFetch(() => jsonResponse(responsesReply("pool-model")));
    const res = await send(appFor(configWith(pricing)), "pool-model", { "x-team-id": "team-a" });
    expect(res.status).toBe(400);
    expect(modelCalls(upstreamCalls)).toHaveLength(0);
  });

  it("a settled team without a pool sends the alias of the pricing table upstream", async () => {
    setup(["team-a", "team-c"]);
    prime([defaultRow(["codex"]), pool("team-a")], [account(pool("team-a"))]);
    orchestrate.mockImplementation(registersIn("codex", SESSION, "team-c"));
    const { upstreamCalls } = installFetch(() => jsonResponse(responsesReply("gpt-5-real")));
    const res = await send(appFor(configWith(pricing)), "gpt-5-codex", { "x-team-id": "team-a" });
    await res.text();
    const calls = modelCalls(upstreamCalls);
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toMatch(/^http:\/\/global-upstream\.test/);
    expect(bodyOf(calls[0]!).model).toBe("gpt-5-real");
  });

  describe("source of a multi-source agent (hermes)", () => {
    const HERMES_SESSION = "hermes-responses-1";
    const source = (team: string) => sourcePool(team, "hermes", "sub-openai", "openai-responses", "x-model");
    const sendHermes = (app: Hono, model: string, headers: Record<string, string> = {}) =>
      responsesRequest(app, "hermes", model, { "x-conversation-id": HERMES_SESSION, ...headers });

    it("a prefix that matched no pool before init matches the pool of the settled team", async () => {
      setup(["team-b", "team-a"]);
      prime([defaultRow(["hermes"]), source("team-a")], [account(source("team-a"))]);
      orchestrate.mockImplementation(registersIn("hermes", HERMES_SESSION, "team-a"));
      const { upstreamCalls } = installFetch(() => jsonResponse(responsesReply("x-model")));
      const res = await sendHermes(appFor(configWith(undefined as never)), "sub-openai/x-model", { "x-team-id": "team-b" });
      expect(await res.json()).toMatchObject({ model: "sub-openai/x-model" });
      const calls = modelCalls(upstreamCalls);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toMatch(/^https:\/\/chatgpt\.com/);
      expect(calls[0]!.headers["authorization"]).toBe("Bearer token-src-sub-openai-team-a");
      expect(bodyOf(calls[0]!).model).toBe("x-model");
    });

    it("the same request passes a non-empty pricing table that does not list the source model", async () => {
      setup(["team-b", "team-a"]);
      prime([defaultRow(["hermes"]), source("team-a")], [account(source("team-a"))]);
      orchestrate.mockImplementation(registersIn("hermes", HERMES_SESSION, "team-a"));
      const { upstreamCalls } = installFetch(() => jsonResponse(responsesReply("x-model")));
      const res = await sendHermes(appFor(configWith(pricing)), "sub-openai/x-model", { "x-team-id": "team-b" });
      await res.text();
      const calls = modelCalls(upstreamCalls);
      expect(res.status).toBe(200);
      expect(calls[0]!.url).toMatch(/^https:\/\/chatgpt\.com/);
      expect(bodyOf(calls[0]!).model).toBe("x-model");
    });

    it("a lost match restores the client model, applies the alias and shows the upstream model", async () => {
      setup(["team-a", "team-b"]);
      prime([defaultRow(["hermes"]), source("team-a")], [account(source("team-a"))]);
      orchestrate.mockImplementation(registersIn("hermes", HERMES_SESSION, "team-b"));
      const { upstreamCalls } = installFetch(() => jsonResponse(responsesReply("real-x")));
      const res = await sendHermes(
        appFor(configWith(priced({ name: "real-x", modelName: "sub-openai/x-model" }))), "sub-openai/x-model", { "x-team-id": "team-a" },
      );
      const reply = await res.json() as { model: string };
      const calls = modelCalls(upstreamCalls);
      expect(res.status).toBe(200);
      expect(calls[0]!.url).toMatch(/^http:\/\/global-upstream\.test/);
      expect(bodyOf(calls[0]!).model).toBe("real-x");
      expect(reply.model).toBe("real-x");
    });

    it("a lost match gates the restored client model", async () => {
      setup(["team-a", "team-b"]);
      prime([defaultRow(["hermes"]), source("team-a")], [account(source("team-a"))]);
      orchestrate.mockImplementation(registersIn("hermes", HERMES_SESSION, "team-b"));
      const { upstreamCalls } = installFetch(() => jsonResponse(responsesReply("x")));
      const res = await sendHermes(
        appFor(configWith(priced({ name: "other-real", modelName: "other" }))), "sub-openai/x-model", { "x-team-id": "team-a" },
      );
      expect(res.status).toBe(400);
      expect(modelCalls(upstreamCalls)).toHaveLength(0);
    });
  });
});

describe("Anthropic runner: model gate and model source after the team settles", () => {
  const SESSION = "hermes-messages-1";
  const source = (team: string) => sourcePool(team, "hermes", "sub-claude", "anthropic-messages", "claude-sonnet");
  const sendHermes = (app: Hono, model: string, headers: Record<string, string> = {}) =>
    messagesRequest(app, "hermes", model, { "x-conversation-id": SESSION, ...headers });
  const pricing = priced({ name: "other-real", modelName: "other" });

  afterEach(teardown);

  it("a prefix that matched no pool before init matches the pool of the settled team", async () => {
    setup(["team-b", "team-a"]);
    prime([defaultRow(["hermes"]), source("team-a")], [account(source("team-a"))]);
    orchestrate.mockImplementation(registersIn("hermes", SESSION, "team-a"));
    const { upstreamCalls } = installFetch(() => jsonResponse(messageReply("claude-sonnet")));
    const res = await sendHermes(appFor(configWith(undefined as never)), "sub-claude/claude-sonnet", { "x-team-id": "team-b" });
    expect(await res.json()).toMatchObject({ model: "sub-claude/claude-sonnet" });
    const calls = modelCalls(upstreamCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer token-src-sub-claude-team-a");
    expect(bodyOf(calls[0]!).model).toBe("claude-sonnet");
  });

  it("a predicted team without that pool does not reject the source model before init", async () => {
    setup(["team-b", "team-a"]);
    prime([defaultRow(["hermes"]), source("team-a")], [account(source("team-a"))]);
    orchestrate.mockImplementation(registersIn("hermes", SESSION, "team-a"));
    const { upstreamCalls } = installFetch(() => jsonResponse(messageReply("claude-sonnet")));
    const res = await sendHermes(appFor(configWith(pricing)), "sub-claude/claude-sonnet", { "x-team-id": "team-b" });
    await res.text();
    const calls = modelCalls(upstreamCalls);
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(bodyOf(calls[0]!).model).toBe("claude-sonnet");
  });

  it("a deferred team error is answered after init and not as an unregistered model", async () => {
    setup(["team-b", "team-a"]);
    prime([defaultRow(["hermes"]), source("team-a"), source("team-b")], [exhausted(source("team-a")), exhausted(source("team-b"))]);
    orchestrate.mockImplementation(givesNoTeam);
    const { upstreamCalls } = installFetch(() => jsonResponse(messageReply("claude-sonnet")));
    const res = await sendHermes(appFor(configWith(pricing)), "sub-claude/claude-sonnet");
    expect(res.status).toBe(429);
    expect(modelCalls(upstreamCalls)).toHaveLength(0);
  });

  it("the form of init is shown while the first team answer is a deferred error", async () => {
    setup(["team-b", "team-a"]);
    prime([defaultRow(["hermes"]), source("team-a"), source("team-b")], [exhausted(source("team-a")), exhausted(source("team-b"))]);
    orchestrate.mockImplementation(showsForm);
    const { upstreamCalls } = installFetch(() => jsonResponse(messageReply("claude-sonnet")));
    const res = await sendHermes(appFor(configWith(pricing)), "sub-claude/claude-sonnet");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pick a team");
    expect(modelCalls(upstreamCalls)).toHaveLength(0);
  });

  it("a lost match restores the client model, applies the alias and shows the upstream model", async () => {
    setup(["team-a", "team-b"]);
    prime([defaultRow(["hermes"]), source("team-a")], [account(source("team-a"))]);
    orchestrate.mockImplementation(registersIn("hermes", SESSION, "team-b"));
    const { upstreamCalls } = installFetch(() => jsonResponse(messageReply("claude-real")));
    const res = await sendHermes(
      appFor(configWith(priced({ name: "claude-real", modelName: "sub-claude/claude-sonnet" }))), "sub-claude/claude-sonnet", { "x-team-id": "team-a" },
    );
    const reply = await res.json() as { model: string };
    const calls = modelCalls(upstreamCalls);
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toMatch(/^http:\/\/global-upstream\.test/);
    expect(bodyOf(calls[0]!).model).toBe("claude-real");
    expect(reply.model).toBe("claude-real");
  });

  it("a lost match gates the restored client model", async () => {
    setup(["team-a", "team-b"]);
    prime([defaultRow(["hermes"]), source("team-a")], [account(source("team-a"))]);
    orchestrate.mockImplementation(registersIn("hermes", SESSION, "team-b"));
    const { upstreamCalls } = installFetch(() => jsonResponse(messageReply("x")));
    const res = await sendHermes(appFor(configWith(pricing)), "sub-claude/claude-sonnet", { "x-team-id": "team-a" });
    expect(res.status).toBe(400);
    expect(modelCalls(upstreamCalls)).toHaveLength(0);
  });

  describe("a plain pool of a team (claude-code)", () => {
    const CC_SESSION = "11111111-2222-3333-4444-555555555555";
    const pool = (team: string) => agentPool(team, "claude-code");
    const sendCode = (app: Hono, model: string, headers: Record<string, string> = {}) =>
      messagesRequest(app, "claude-code", model, { "x-claude-code-session-id": CC_SESSION, ...headers });

    it("a settled team without a pool gates a model that is not in the pricing table", async () => {
      setup(["team-a", "team-c"]);
      prime([defaultRow(["claude-code"]), pool("team-a")], [account(pool("team-a"))]);
      orchestrate.mockImplementation(registersIn("claude-code", CC_SESSION, "team-c"));
      const { upstreamCalls } = installFetch(() => jsonResponse(messageReply("claude-x")));
      const res = await sendCode(appFor(configWith(pricing)), "claude-x", { "x-team-id": "team-a" });
      expect(res.status).toBe(400);
      expect(modelCalls(upstreamCalls)).toHaveLength(0);
    });

    it("a settled team without a pool sends the alias of the pricing table upstream", async () => {
      setup(["team-a", "team-c"]);
      prime([defaultRow(["claude-code"]), pool("team-a")], [account(pool("team-a"))]);
      orchestrate.mockImplementation(registersIn("claude-code", CC_SESSION, "team-c"));
      const { upstreamCalls } = installFetch(() => jsonResponse(messageReply("claude-real")));
      const res = await sendCode(appFor(configWith(priced({ name: "claude-real", modelName: "claude-x" }))), "claude-x", { "x-team-id": "team-a" });
      await res.text();
      const calls = modelCalls(upstreamCalls);
      expect(res.status).toBe(200);
      expect(calls[0]!.url).toMatch(/^http:\/\/global-upstream\.test/);
      expect(bodyOf(calls[0]!).model).toBe("claude-real");
    });
  });
});

describe("WorkBuddy runner: model gate and model source after the team settles", () => {
  const SESSION = "workbuddy-session-1";
  const source = (team: string) => sourcePool(team, "workbuddy", "sub-openai", "openai-responses", "x-model");
  // Session state of this runner lives under the `codex:` key.
  const sendWorkbuddy = (app: Hono, model: string, headers: Record<string, string> = {}) =>
    responsesRequest(app, "workbuddy", model, { "session-id": SESSION, ...headers });
  const upstreamIdOnly = priced({ name: "x-model", modelName: "x-model" });

  afterEach(teardown);

  it("a prefix that matched no pool before init matches the pool of the settled team", async () => {
    setup(["team-b", "team-a"]);
    prime([defaultRow(["workbuddy"]), source("team-a")], [account(source("team-a"))]);
    orchestrate.mockImplementation(registersIn("codex", SESSION, "team-a"));
    const { upstreamCalls } = installFetch(() => jsonResponse(responsesReply("x-model")));
    const res = await sendWorkbuddy(appFor(configWith(upstreamIdOnly)), "sub-openai/x-model", { "x-team-id": "team-b" });
    await res.text();
    const calls = modelCalls(upstreamCalls);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/^https:\/\/chatgpt\.com/);
    expect(calls[0]!.headers["authorization"]).toBe("Bearer token-src-sub-openai-team-a");
    expect(bodyOf(calls[0]!).model).toBe("x-model");
  });

  it("a deferred team error is answered after init and not as an unregistered model", async () => {
    setup(["team-b", "team-a"]);
    prime([defaultRow(["workbuddy"]), source("team-a"), source("team-b")], [exhausted(source("team-a")), exhausted(source("team-b"))]);
    orchestrate.mockImplementation(givesNoTeam);
    const { upstreamCalls } = installFetch(() => jsonResponse(responsesReply("x-model")));
    const res = await sendWorkbuddy(appFor(configWith(upstreamIdOnly)), "sub-openai/x-model");
    expect(res.status).toBe(429);
    expect(modelCalls(upstreamCalls)).toHaveLength(0);
  });

  it("the form of init is shown while the first team answer is a deferred error", async () => {
    setup(["team-b", "team-a"]);
    prime([defaultRow(["workbuddy"]), source("team-a"), source("team-b")], [exhausted(source("team-a")), exhausted(source("team-b"))]);
    orchestrate.mockImplementation(showsForm);
    const { upstreamCalls } = installFetch(() => jsonResponse(responsesReply("x-model")));
    const res = await sendWorkbuddy(appFor(configWith(upstreamIdOnly)), "sub-openai/x-model");
    expect(res.status).toBe(200);
    expect(modelCalls(upstreamCalls)).toHaveLength(0);
  });

  it("a lost match restores the client model, applies the alias and shows the upstream model", async () => {
    setup(["team-a", "team-b"]);
    prime([defaultRow(["workbuddy"]), source("team-a")], [account(source("team-a"))]);
    orchestrate.mockImplementation(registersIn("codex", SESSION, "team-b"));
    const { upstreamCalls } = installFetch(() => jsonResponse(responsesReply("x-real")));
    const res = await sendWorkbuddy(
      appFor(configWith(priced({ name: "x-model", modelName: "x-model" }, { name: "x-real", modelName: "sub-openai/x-model" }))),
      "sub-openai/x-model", { "x-team-id": "team-a" },
    );
    const reply = await res.json() as { model: string };
    const calls = modelCalls(upstreamCalls);
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toMatch(/^http:\/\/global-upstream\.test/);
    expect(bodyOf(calls[0]!).model).toBe("x-real");
    expect(reply.model).toBe("x-real");
  });

  it("a lost match gates the restored client model", async () => {
    setup(["team-a", "team-b"]);
    prime([defaultRow(["workbuddy"]), source("team-a")], [account(source("team-a"))]);
    orchestrate.mockImplementation(registersIn("codex", SESSION, "team-b"));
    const { upstreamCalls } = installFetch(() => jsonResponse(responsesReply("x")));
    const res = await sendWorkbuddy(appFor(configWith(upstreamIdOnly)), "sub-openai/x-model", { "x-team-id": "team-a" });
    expect(res.status).toBe(400);
    expect(modelCalls(upstreamCalls)).toHaveLength(0);
  });

  it("a pool source of a registered session team is gated by the pricing table", async () => {
    setup(["team-a"]);
    prime([defaultRow(["workbuddy"]), source("team-a")], [account(source("team-a"))]);
    await registerPoolTestSession("codex", SESSION, "team-a");
    orchestrate.mockImplementation(async () => ({
      proceed: true, response: null, wentThroughStateMachine: false,
      initResult: { intercepted: false, bypassed: false, justRegistered: false,
        sessionInfo: { team_id: "team-a", user_id: POOL_TEST_USER, agent_id: "a1", session_id: SESSION } },
    }));
    const { upstreamCalls } = installFetch(() => jsonResponse(responsesReply("x-model")));
    const res = await sendWorkbuddy(appFor(configWith(priced({ name: "other-real", modelName: "other" }))), "sub-openai/x-model");
    expect(res.status).toBe(400);
    expect(modelCalls(upstreamCalls)).toHaveLength(0);
  });
});
