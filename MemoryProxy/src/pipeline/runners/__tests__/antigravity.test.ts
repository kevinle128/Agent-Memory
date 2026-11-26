/**
 * AntiGravity runner through the real route table: the Cloud Code envelope, the SSE unwrap, the
 * model list, the path key (auth and masking), pool errors (401, 429, 503), the hook gate, the
 * session id from `labels.cascade_id` and the L0 write. The upstream and Core are recording stubs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../../server.js";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../../instance-upstream-cache.js";
import { __primeAccountCacheForTests, unavailableAccountIds } from "../../../subscription-pool/account-cache.js";
import type { PoolAccount } from "../../../subscription-pool/types.js";
import { MemoryStorage } from "../../../storage/memory-storage.js";
import { SessionWorkspaceStore, setSessionWorkspaceStore } from "../../../project-scope/session-workspace.js";
import { resetHookGateCache } from "../../../session/hook-gate-core.js";
import { resetPoolRetryForTests } from "../../../subscription-pool/retry.js";
import {
  CORE_URL, installFetch, jsonResponse, makeConfig, registerPoolTestSession, resetPoolState, setPoolTestTeams,
  useRealSessionTeams, type RecordedCall,
} from "../../../subscription-pool/__tests__/test-harness.js";
import {
  ANTIGRAVITY_USER_AGENT, createSseUnwrapStream, extractUserMessage, geminiModelList, maskKeyedPath,
  modelsFromUpstream, openaiModelList, parseAntigravityPath, unwrapSseLine, upstreamModelFor, wrapEnvelope,
} from "../antigravity.js";
import { isAntigravityCapacityError, parseAntigravityLimitBody } from "../../../subscription-pool/quota-signals.js";
import { antigravityHookOutput, hookOutput } from "../../../routes/hook-recall.js";
import { countGateAnswers, geminiTextSse } from "../../../session/antigravity/hook-gate.js";
import { GATE_TEXT_MARKER } from "../../../session/hook-gate-core.js";

const SPACE = "sp-agy";
const KEY = "sk-mem-secretkey123";
const SESSION = "5f1d6b7e-9c1a-4e55-8f0b-2f6d3d9a1c11";
const NOW = Date.now();
const UPSTREAM = "https://daily-cloudcode-pa.googleapis.com";

const verifyUserKey = vi.fn(async (_key: string, _space: string): Promise<{
  userId: string;
  rejected: boolean;
  rejectReason?: string;
  unavailable?: boolean;
}> => ({ userId: "usr-1", rejected: false }));
vi.mock("../../../auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../auth.js")>()),
  verifyUserKey: (key: string, space: string) => verifyUserKey(key, space),
}));

const sessionInit = vi.fn();
vi.mock("../../stages/session-init-orchestrate.js", () => ({
  stageSessionInitOrchestrate: (args: unknown) => sessionInit(args),
}));

const logged: string[] = [];
vi.mock("../../../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../logger.js")>()),
  writeLog: (_config: unknown, entry: unknown) => { logged.push(JSON.stringify(entry)); },
}));

const defaultRow: InstanceUpstreamRow = {
  group_id: "d", group_type: "default", name: "default", agents: ["claude-code"], enabled: true,
  mode: "official", base_url: "", api_key: "", model_id: "",
};
const poolRow: InstanceUpstreamRow = {
  group_id: "pool-agy", group_type: "custom", name: "AGY pool", agents: ["antigravity"], enabled: true,
  mode: "subscription_pool", team_id: "team-a", base_url: "", api_key: "", model_id: "",
};

function acct(id: string, partial: Partial<PoolAccount> = {}): PoolAccount {
  return {
    account_id: id, group_id: "pool-agy", provider: "antigravity", provider_account_id: `g-${id}`,
    project_id: `proj-${id}`, status: "active", enabled: true, access_token: `secret-token-${id}`,
    token_expires_at: NOW + 3_600_000, usage: { windows: [] }, exhausted_until: null, ...partial,
  };
}

function prime(accounts: PoolAccount[], rows: InstanceUpstreamRow[] = [defaultRow, poolRow]): void {
  __primeCacheForTests(SPACE, rows);
  __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts });
}

const chunk = (text: string, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text }] } }], ...extra }, traceId: "t" })}\n\n`;
const sse = () => new Response(chunk("po") + chunk("ng"), { status: 200, headers: { "content-type": "text/event-stream", "content-length": "999" } });

const agyBody = (extra: Record<string, unknown> = {}) => ({
  contents: [{ role: "user", parts: [{ text: "say pong" }] }],
  systemInstruction: { parts: [{ text: "sys" }] },
  generationConfig: { thinkingConfig: { thinkingLevel: "MEDIUM" } },
  labels: { cascade_id: SESSION, client: "antigravity-cli" },
  ...extra,
});

const streamPath = (key = KEY, model = "gemini-3.8-flash") => `/antigravity/${SPACE}/${key}/v1beta/models/${model}:streamGenerateContent?alt=sse`;

let app: ReturnType<typeof createApp>;
let logs: string[];
let store: SessionWorkspaceStore;

function configured() {
  const config = makeConfig();
  config.hookGate = { enabled: false };
  return config;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

beforeEach(() => {
  resetPoolState();
  resetPoolRetryForTests();
  resetHookGateCache();
  logs = [];
  logged.length = 0;
  verifyUserKey.mockClear();
  verifyUserKey.mockImplementation(async () => ({ userId: "usr-1", rejected: false, rejectReason: undefined, unavailable: undefined }));
  sessionInit.mockReset();
  sessionInit.mockResolvedValue({
    proceed: true, response: null, wentThroughStateMachine: false,
    initResult: { intercepted: false, bypassed: true, justRegistered: false, sessionInfo: null },
  });
  store = new SessionWorkspaceStore(new MemoryStorage());
  setSessionWorkspaceStore(store);
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
  }
  app = createApp(configured());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setSessionWorkspaceStore(null); });

describe("antigravity wire helpers", () => {
  it("wraps the body in the Cloud Code envelope without changing it", () => {
    const body = { contents: [], labels: { cascade_id: "c" } };
    const env = wrapEnvelope("m", "proj", body, "agent-x");
    expect(env).toEqual({ model: "m", project: "proj", request: body, requestType: "agent", userAgent: "antigravity", requestId: "agent-x" });
    expect(env.request).toBe(body);
    expect(String(wrapEnvelope("m", "p", {}).requestId)).toMatch(/^agent-[0-9a-f-]{36}$/);
  });

  it("puts the thinking level back as a model suffix only when it is missing", () => {
    const body = (level?: string) => ({ generationConfig: level ? { thinkingConfig: { thinkingLevel: level } } : {} });
    expect(upstreamModelFor("claude-opus-5-5", body("HIGH"))).toBe("claude-opus-5-5-high");
    expect(upstreamModelFor("claude-opus-5-5-high", body("HIGH"))).toBe("claude-opus-5-5-high");
    expect(upstreamModelFor("claude-opus-5-5", body("MEDIUM"))).toBe("claude-opus-5-5-medium");
    expect(upstreamModelFor("claude-opus-5-5", body("LOW"))).toBe("claude-opus-5-5-low");
    expect(upstreamModelFor("gemini-4-neon", body("MEDIUM"))).toBe("gemini-4-neon-medium");
    expect(upstreamModelFor("gemini-3.8-flash", body())).toBe("gemini-3.8-flash");
    expect(upstreamModelFor("gemini-3.8-flash", {})).toBe("gemini-3.8-flash");
    expect(upstreamModelFor("gemini-3.1-flash-lite", body("MINIMAL"))).toBe("gemini-3.1-flash-lite");
    expect(upstreamModelFor("gemini-2.5-flash-lite", body("MINIMAL"))).toBe("gemini-2.5-flash-lite");
    expect(upstreamModelFor("gemini-3.8-flash", body("MINIMAL"))).toBe("gemini-3.8-flash");
    expect(upstreamModelFor("claude-opus-5-5", body("THINKING_LEVEL_UNSPECIFIED"))).toBe("claude-opus-5-5");
    expect(upstreamModelFor("claude-opus-5-5", body("NONE"))).toBe("claude-opus-5-5");
  });

  it("uses the agy user agent string", () => {
    expect(ANTIGRAVITY_USER_AGENT).toMatch(/^antigravity\/cli\/1\.5\.13 \(aidev_client; os_type=(darwin|linux|windows); arch=(arm64|amd64); cl=1025641825; auth_method=consumer\)$/);
  });

  it("parses the path shapes of the Panel guide and masks the key", () => {
    expect(parseAntigravityPath(`/antigravity/${SPACE}/${KEY}/v1/models`)).toEqual({ kind: "models-openai", spaceId: SPACE, accessKey: KEY, memoryOff: false });
    expect(parseAntigravityPath(`/antigravity/${SPACE}/analyse/${KEY}/v1beta/models`)).toEqual({ kind: "models-gemini", spaceId: SPACE, accessKey: KEY, memoryOff: false });
    expect(parseAntigravityPath(`/antigravity/${SPACE}/${KEY}/v1beta/models/gemini-3:streamGenerateContent`)).toEqual({ kind: "stream", spaceId: SPACE, accessKey: KEY, memoryOff: false, model: "gemini-3" });
    expect(parseAntigravityPath(`/antigravity/${SPACE}/${KEY}/v1beta/models/gemini-3%3AgenerateContent`)).toEqual({ kind: "generate", spaceId: SPACE, accessKey: KEY, memoryOff: false, model: "gemini-3" });
    expect(parseAntigravityPath(`/antigravity/${SPACE}/${KEY}/v1beta/models/gemini-3:countTokens`)).toBeNull();
    expect(parseAntigravityPath(`/codex/${SPACE}/${KEY}/v1/models`)).toBeNull();
    expect(maskKeyedPath(`/antigravity/${SPACE}/${KEY}/v1beta/models`)).toBe(`/antigravity/${SPACE}/***/v1beta/models`);
  });

  it("reads the memory-off segment after the key, as a whole segment only", () => {
    const tail = "v1beta/models/gemini-3:streamGenerateContent";
    expect(parseAntigravityPath(`/antigravity/${SPACE}/${KEY}/memory-off/${tail}`))
      .toEqual({ kind: "stream", spaceId: SPACE, accessKey: KEY, memoryOff: true, model: "gemini-3" });
    expect(parseAntigravityPath(`/antigravity/${SPACE}/analyse/${KEY}/memory-off/v1/models`))
      .toEqual({ kind: "models-openai", spaceId: SPACE, accessKey: KEY, memoryOff: true });
    // A key that contains the text, or is the text, is a key and not the switch.
    expect(parseAntigravityPath(`/antigravity/${SPACE}/sk-memory-off/${tail}`)?.memoryOff).toBe(false);
    expect(parseAntigravityPath(`/antigravity/${SPACE}/memory-off/${tail}`))
      .toMatchObject({ accessKey: "memory-off", memoryOff: false });
    expect(parseAntigravityPath(`/antigravity/${SPACE}/${KEY}/memory-off-x/${tail}`)).toBeNull();
    expect(parseAntigravityPath(`/antigravity/${SPACE}/${KEY}/memory-off/memory-off/${tail}`)).toBeNull();
    expect(maskKeyedPath(`/antigravity/${SPACE}/${KEY}/memory-off/v1beta/models`)).toBe(`/antigravity/${SPACE}/***/memory-off/v1beta/models`);
    expect(maskKeyedPath(`/antigravity/${SPACE}/analyse/${KEY}/v1/models`)).toBe(`/antigravity/${SPACE}/analyse/***/v1/models`);
    expect(maskKeyedPath(`/antigravity/${SPACE}/${KEY}/v1/models`)).not.toContain(KEY);
  });

  it("unwraps each SSE line and leaves other lines alone", () => {
    expect(unwrapSseLine('data: {"response": {"a": 1}, "traceId": "t"}\r\n')).toEqual({ line: 'data: {"a":1}', text: "" });
    expect(unwrapSseLine("").line).toBe("");
    expect(unwrapSseLine(": ping").line).toBe(": ping");
    expect(unwrapSseLine("data: [DONE]").line).toBe("data: [DONE]");
    expect(unwrapSseLine('data: {"other": 1}').line).toBe('data: {"other": 1}');
    const visible = unwrapSseLine(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "think", thought: true }, { text: "answer" }] } }] } })}`);
    expect(visible.text).toBe("answer");
  });

  it("unwraps a stream when chunks split a line and a multi-byte character", async () => {
    const full = new TextEncoder().encode(chunk("xin chào đời") + chunk("!"));
    // Cut inside the 2-byte character "à" and inside the second data line.
    const cutA = full.indexOf(0xc3) + 1;
    const cutB = full.length - 7;
    const parts = [full.slice(0, cutA), full.slice(cutA, cutB), full.slice(cutB)];
    let done = "";
    const out = new Response(new ReadableStream({
      start(controller) { for (const p of parts) controller.enqueue(p); controller.close(); },
    }).pipeThrough(createSseUnwrapStream((text) => { done = text; })));
    const text = await out.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
    expect(dataLines).toHaveLength(2);
    expect(dataLines.every((l) => !l.includes('"response"'))).toBe(true);
    expect(JSON.parse(dataLines[0]!.slice(5)).candidates[0].content.parts[0].text).toBe("xin chào đời");
    expect(done).toBe("xin chào đời!");
  });

  it("filters noisy model ids and renders both list formats", () => {
    const models = modelsFromUpstream({
      models: {
        "claude-opus-5-5-high": { displayName: "Opus" }, "gemini-3.8-flash-medium": {},
        chat_23310: {}, tab_flash: {}, "x-disabled": {}, "y-tiered": {}, "z-sonar": {}, "gemini-3-pro-image": {},
      },
    });
    expect(models).toEqual([{ id: "claude-opus-5-5-high", displayName: "Opus" }, { id: "gemini-3.8-flash-medium", displayName: "gemini-3.8-flash-medium" }]);
    expect(geminiModelList(models)).toEqual({
      models: [
        { name: "models/claude-opus-5-5-high", displayName: "Opus", supportedGenerationMethods: ["generateContent", "streamGenerateContent"] },
        { name: "models/gemini-3.8-flash-medium", displayName: "gemini-3.8-flash-medium", supportedGenerationMethods: ["generateContent", "streamGenerateContent"] },
      ],
    });
    expect(openaiModelList(models)).toEqual({ object: "list", data: [{ id: "claude-opus-5-5-high", object: "model" }, { id: "gemini-3.8-flash-medium", object: "model" }] });
    expect(modelsFromUpstream({ models: [{ model: "a" }, { name: "chat_1" }] })).toEqual([{ id: "a", displayName: "a" }]);
    expect(modelsFromUpstream({ models: { "gemini-x": { isInternal: true }, "gemini-y": {} } })).toEqual([{ id: "gemini-y", displayName: "gemini-y" }]);
    expect(modelsFromUpstream({ models: [{ name: "models/gemini-z" }] })).toEqual([{ id: "gemini-z", displayName: "gemini-z" }]);
  });

  it("reads the user message of a request and skips tool-loop steps", () => {
    expect(extractUserMessage(agyBody())).toEqual({ role: "user", content: "say pong" });
    expect(extractUserMessage({ contents: [{ role: "user", parts: [{ text: "q" }] }, { role: "model", parts: [{ text: "a" }] }, { role: "user", parts: [{ functionResponse: { name: "x" } }] }] })).toBeNull();
    expect(extractUserMessage({ contents: [] })).toBeNull();
  });

  it("reads reset hints of a 429 and detects the capacity 503", () => {
    const retry = JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" }] } });
    expect(parseAntigravityLimitBody(retry, new Headers(), 1000)).toEqual({ resetsAt: 31_000, retryAfterSec: 30 });
    const meta = JSON.stringify({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", metadata: { quotaResetDelay: "1h2m3s" } }] } });
    expect(parseAntigravityLimitBody(meta, new Headers(), 0).retryAfterSec).toBe(3723);
    expect(parseAntigravityLimitBody("{}", new Headers({ "retry-after": "12" }), 0).retryAfterSec).toBe(12);
    expect(parseAntigravityLimitBody("not json", new Headers(), 0)).toEqual({ resetsAt: null, retryAfterSec: null });
    expect(isAntigravityCapacityError(503, '{"error":{"status":"UNAVAILABLE","message":"No capacity available for model x on the server"}}')).toBe(true);
    expect(isAntigravityCapacityError(500, "UNAVAILABLE")).toBe(false);
    expect(isAntigravityCapacityError(503, "gateway timeout")).toBe(false);
  });

  it("builds the recall output of the antigravity hook next to the Claude one", () => {
    expect(antigravityHookOutput("memo")).toEqual({ injectSteps: [{ ephemeralMessage: "memo" }] });
    expect(hookOutput("memo")).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "memo" } });
  });

  it("counts gate answers in the history by their marker", () => {
    const gate = { role: "model", parts: [{ text: `${GATE_TEXT_MARKER} install` }] };
    expect(countGateAnswers({ contents: [{ role: "user", parts: [{ text: "a" }] }, gate, { role: "user", parts: [] }, gate] })).toBe(2);
    expect(countGateAnswers({ contents: [{ role: "model", parts: [{ text: "hello" }] }] })).toBe(0);
    expect(countGateAnswers({})).toBe(0);
  });

  it("answers a gate message as a valid Gemini SSE stream", async () => {
    const res = geminiTextSse("hello");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(JSON.parse((await res.text()).replace(/^data: /, "")))
      .toEqual({ candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }] });
  });
});

describe("antigravity stream route", () => {
  it("wraps the request, calls Cloud Code with the account token and unwraps the stream", async () => {
    prime([acct("a")]);
    const { upstreamCalls } = installFetch(() => sse());
    const res = await post(streamPath(), agyBody());
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("content-length")).toBeNull();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
    expect(dataLines.map((d) => d.candidates[0].content.parts[0].text)).toEqual(["po", "ng"]);
    expect(dataLines[0].response).toBeUndefined();

    expect(upstreamCalls).toHaveLength(1);
    const call = upstreamCalls[0]!;
    expect(call.url).toBe(`${UPSTREAM}/v1internal:streamGenerateContent?alt=sse`);
    expect(call.headers["authorization"]).toBe("Bearer secret-token-a");
    expect(call.headers["user-agent"]).toBe(ANTIGRAVITY_USER_AGENT);
    const sent = JSON.parse(call.body);
    expect(sent.model).toBe("gemini-3.8-flash-medium");
    expect(sent.project).toBe("proj-a");
    expect(sent.requestType).toBe("agent");
    expect(sent.userAgent).toBe("antigravity");
    expect(sent.requestId).toMatch(/^agent-/);
    expect(sent.request).toEqual(agyBody());
  });

  it("unwraps a non-stream answer and uses the generateContent URL", async () => {
    prime([acct("a")]);
    const { upstreamCalls } = installFetch(() => jsonResponse({ response: { candidates: [{ content: { parts: [{ text: "pong" }] } }] }, traceId: "t" }));
    const res = await post(`/antigravity/${SPACE}/${KEY}/v1beta/models/gemini-3.8-flash:generateContent`, agyBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [{ content: { parts: [{ text: "pong" }] } }] });
    expect(upstreamCalls[0]!.url).toBe(`${UPSTREAM}/v1internal:generateContent`);
  });

  it("accepts the analyse path of the Panel guide", async () => {
    prime([acct("a")]);
    installFetch(() => sse());
    const res = await post(`/antigravity/${SPACE}/analyse/${KEY}/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse`, agyBody());
    await res.text();
    expect(res.status).toBe(200);
  });

  it("uses the row base_url, then the configured agent url, for the host", async () => {
    prime([acct("a")], [defaultRow, { ...poolRow, base_url: "https://cc.example.test/" }]);
    const { upstreamCalls } = installFetch(() => sse());
    await (await post(streamPath(), agyBody())).text();
    expect(upstreamCalls[0]!.url).toBe("https://cc.example.test/v1internal:streamGenerateContent?alt=sse");

    prime([acct("a")]);
    const config = configured();
    config.upstream.agents = { antigravity: { url: "https://cfg.example.test" } };
    app = createApp(config);
    upstreamCalls.length = 0;
    await (await post(streamPath(), agyBody())).text();
    expect(upstreamCalls[0]!.url).toBe("https://cfg.example.test/v1internal:streamGenerateContent?alt=sse");
  });

  it("rejects a wrong path key before any upstream call", async () => {
    prime([acct("a")]);
    verifyUserKey.mockImplementation(async () => ({ userId: "", rejected: true, rejectReason: "invalid user_key", unavailable: undefined }));
    const { upstreamCalls } = installFetch(() => sse());
    const res = await post(streamPath("sk-wrong"), agyBody());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { status: "UNAUTHENTICATED" } });
    expect(upstreamCalls).toHaveLength(0);
    expect(verifyUserKey).toHaveBeenCalledWith("sk-wrong", SPACE);
  });

  it("answers 503 UNAVAILABLE when MemoryCore cannot verify, without an agy sign-in phrase", async () => {
    prime([acct("a")]);
    verifyUserKey.mockImplementation(async () => ({
      userId: "",
      rejected: true,
      rejectReason: "auth service timeout (5000ms)",
      unavailable: true,
    }));
    const { upstreamCalls } = installFetch(() => sse());
    const res = await post(streamPath(), agyBody());
    const body = await res.json() as { error?: { message?: string; status?: string } };
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(body.error?.status).toBe("UNAVAILABLE");
    expect(body.error?.message).toBe("Memory service temporarily unavailable. Please retry.");
    expect(body.error?.message ?? "").not.toMatch(/auth|sign.in|log.in/i);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("answers an unknown keyed path with 404 and does not reach the chat runner", async () => {
    prime([acct("a")]);
    const { upstreamCalls } = installFetch(() => sse());
    const res = await post(`/antigravity/${SPACE}/${KEY}/v1beta/models/gemini-3:countTokens`, agyBody());
    expect(res.status).toBe(404);
    expect(upstreamCalls).toHaveLength(0);
    expect(verifyUserKey).not.toHaveBeenCalled();
  });

  it("never lets the path key reach logs, log entries, upstream calls or Core calls", async () => {
    prime([acct("a")]);
    const calls = installFetch(() => sse());
    await (await post(streamPath(), agyBody())).text();
    await (await app.request(`/antigravity/${SPACE}/${KEY}/v1/models`)).text();
    await (await post(`/antigravity/${SPACE}/${KEY}/v1beta/models/x:countTokens`, {})).text();
    await new Promise((r) => setTimeout(r, 50));
    // The key never goes to Google or into a log. Core gets it only as the user-key header,
    // as for every agent, never in a URL or a body.
    expect(JSON.stringify([logs, logged, calls.upstreamCalls])).not.toContain(KEY);
    expect(JSON.stringify(calls.coreCalls.map((c) => [c.url, c.body]))).not.toContain(KEY);
    // The account token goes only into the upstream Authorization header.
    expect(JSON.stringify([logs, logged])).not.toContain("secret-token-");
    expect(JSON.stringify(calls.upstreamCalls.map((c) => [c.url, c.body]))).not.toContain("secret-token-");
  });

  it("returns a client error when the pool is not configured for the agent", async () => {
    prime([acct("a")], [defaultRow]);
    const { upstreamCalls } = installFetch(() => sse());
    const res = await post(streamPath(), agyBody());
    expect(res.status).toBe(400);
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe("antigravity pool errors", () => {
  it("refreshes the token once on 401 and retries the same account", async () => {
    prime([acct("a")]);
    const { upstreamCalls, coreCalls } = installFetch(
      (call) => (call.headers["authorization"] === "Bearer secret-token-a" ? new Response("{}", { status: 401 }) : sse()),
      (call) => (call.url.endsWith("/refresh")
        ? jsonResponse({ code: 0, data: { account_id: "a", access_token: "fresh-token-a", provider_account_id: "g-a", token_expires_at: NOW + 9 * 3_600_000 } })
        : jsonResponse({ code: 0, data: {} })),
    );
    const res = await post(streamPath(), agyBody());
    await res.text();
    expect(res.status).toBe(200);
    expect(upstreamCalls.map((c) => c.headers["authorization"])).toEqual(["Bearer secret-token-a", "Bearer fresh-token-a"]);
    expect(coreCalls.some((c) => c.url.endsWith("/refresh"))).toBe(true);
    expect(JSON.parse(upstreamCalls[1]!.body).project).toBe("proj-a");
  });

  it("checks usage on a 429 and moves to the next account when the quota is full", async () => {
    prime([acct("a"), acct("b")]);
    const t = Date.now();
    const full = { name: "all", model_scope: null, used_pct: 100, resets_at: t + 3_600_000, observed_at: t, source: "usage_api" };
    const limited = () => jsonResponse({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7200s" }] } }, 429);
    const { upstreamCalls, coreCalls } = installFetch(
      (call) => (call.headers["authorization"] === "Bearer secret-token-a" ? limited() : sse()),
      (call) => {
        if (call.url.endsWith("/check-usage")) {
          return jsonResponse({ code: 0, data: { failed: false, account: { ...acct("a"), usage: { windows: [full] }, usage_updated_at: t } } });
        }
        if (call.url.endsWith("/accounts/list")) {
          return jsonResponse({ code: 0, data: { threshold_pct: 95, accounts: [acct("a", { status: "exhausted", exhausted_until: t + 3_600_000, usage: { windows: [full] } }), acct("b")] } });
        }
        return jsonResponse({ code: 0, data: {} });
      },
    );
    const res = await post(streamPath(), agyBody());
    await res.text();
    expect(res.status).toBe(200);
    expect(upstreamCalls.map((c) => c.headers["authorization"])).toEqual(["Bearer secret-token-a", "Bearer secret-token-b"]);
    expect(JSON.parse(upstreamCalls[1]!.body).project).toBe("proj-b");
    expect(coreCalls.filter((c) => c.url.endsWith("/check-usage"))).toHaveLength(1);
  });

  it("retries a 429 without any hint on the same account at 1, 2, 4 and 8 seconds before Check now", async () => {
    vi.useFakeTimers();
    prime([acct("a"), acct("b")]);
    const times: number[] = [];
    const start = Date.now();
    installFetch((call) => {
      times.push(Date.now() - start);
      return call.headers["authorization"] === "Bearer secret-token-a" ? jsonResponse({ error: { status: "RESOURCE_EXHAUSTED" } }, 429) : sse();
    });
    const pending = post(streamPath(), agyBody());
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await pending;
    expect(res.status).toBe(429);
    expect(times.slice(0, 5)).toEqual([0, 1000, 3000, 7000, 15_000]);
  });

  it("tries the next account after a capacity 503 and does not mark the first one exhausted", async () => {
    prime([acct("a"), acct("b")]);
    const capacity = () => jsonResponse({ error: { code: 503, status: "UNAVAILABLE", message: "No capacity available for model x on the server" } }, 503);
    const { upstreamCalls } = installFetch((call) => (call.headers["authorization"] === "Bearer secret-token-a" ? capacity() : sse()));
    const res = await post(streamPath(), agyBody());
    await res.text();
    expect(res.status).toBe(200);
    expect(upstreamCalls.map((c) => c.headers["authorization"])).toEqual(["Bearer secret-token-a", "Bearer secret-token-b"]);
    // No cooldown and no exhausted mark: account a stays selectable.
    expect(unavailableAccountIds(SPACE, Date.now()).size).toBe(0);

    upstreamCalls.length = 0;
    const second = await post(streamPath(), agyBody({ labels: { cascade_id: "another-session-1" } }));
    await second.text();
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer secret-token-a");
  });

  it("returns the 503 when every account has no capacity", async () => {
    prime([acct("a"), acct("b")]);
    const { upstreamCalls } = installFetch(() => jsonResponse({ error: { code: 503, status: "UNAVAILABLE", message: "No capacity available" } }, 503));
    const res = await post(streamPath(), agyBody());
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("No capacity");
    expect(upstreamCalls).toHaveLength(2);
  });

  it("does not treat another 503 as a capacity shortage", async () => {
    prime([acct("a"), acct("b")]);
    const { upstreamCalls } = installFetch(() => new Response("bad gateway", { status: 503 }));
    const res = await post(streamPath(), agyBody());
    expect(res.status).toBe(503);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("answers 409 when the selected account has no project", async () => {
    prime([acct("a", { project_id: undefined })]);
    const { upstreamCalls } = installFetch(() => sse());
    const res = await post(streamPath(), agyBody());
    expect(res.status).toBe(409);
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe("antigravity model list", () => {
  it("lists the Core catalog of the pool in both formats and filters noisy ids", async () => {
    const row: InstanceUpstreamRow = {
      ...poolRow,
      source_models: [
        { id: "claude-opus-5-5-high", display_name: "Opus 5.5", enabled: true, available: true },
        { id: "gemini-3.8-flash-medium", enabled: true },
        { id: "chat_1", enabled: true }, { id: "off-model", enabled: false }, { id: "gone", enabled: true, available: false },
      ],
    };
    prime([acct("a")], [defaultRow, row]);
    const { upstreamCalls } = installFetch(() => sse());
    const gemini = await app.request(`/antigravity/${SPACE}/${KEY}/v1beta/models?pageSize=1000`);
    expect(gemini.status).toBe(200);
    expect((await gemini.json() as { models: Array<{ name: string }> }).models.map((m) => m.name))
      .toEqual(["models/claude-opus-5-5-high", "models/gemini-3.8-flash-medium"]);
    const openai = await app.request(`/antigravity/${SPACE}/${KEY}/v1/models`);
    expect((await openai.json() as { data: Array<{ id: string }> }).data.map((m) => m.id))
      .toEqual(["claude-opus-5-5-high", "gemini-3.8-flash-medium"]);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("falls back to fetchAvailableModels with the account token and project", async () => {
    prime([acct("a")]);
    const { upstreamCalls } = installFetch(() => jsonResponse({ models: { "gemini-3.8-flash-medium": { displayName: "Flash" }, chat_9: {}, "m-tiered": {} } }));
    const res = await app.request(`/antigravity/${SPACE}/${KEY}/v1beta/models`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(geminiModelList([{ id: "gemini-3.8-flash-medium", displayName: "Flash" }]));
    expect(upstreamCalls[0]!.url).toBe(`${UPSTREAM}/v1internal:fetchAvailableModels`);
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer secret-token-a");
    expect(JSON.parse(upstreamCalls[0]!.body)).toEqual({ project: "proj-a" });
  });

  it("checks the path key on the model list too", async () => {
    prime([acct("a")]);
    verifyUserKey.mockImplementation(async () => ({ userId: "", rejected: true, rejectReason: "invalid user_key" }));
    const { upstreamCalls } = installFetch(() => sse());
    expect((await app.request(`/antigravity/${SPACE}/bad/v1/models`)).status).toBe(401);
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe("antigravity hook gate and session", () => {
  const gateConfig = () => {
    const config = configured();
    config.hookGate = { enabled: true };
    return config;
  };

  it("answers with the install command as a Gemini SSE stream while no hook report exists", async () => {
    prime([acct("a")]);
    app = createApp(gateConfig());
    const { upstreamCalls } = installFetch(() => sse());
    const res = await post(streamPath(), agyBody(), { host: "proxy.example.test", "x-forwarded-proto": "https" });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const event = JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    expect(event.candidates[0].finishReason).toBe("STOP");
    const shown: string = event.candidates[0].content.parts[0].text;
    expect(shown.startsWith(GATE_TEXT_MARKER)).toBe(true);
    expect(shown).toContain(
      `curl -fsSL https://proxy.example.test/setup/hooks.sh | bash -s -- --client antigravity --base-url https://proxy.example.test/antigravity/${SPACE}`,
    );
    // The conversation history keeps the answer: no key and no session id in the command.
    expect(shown).not.toContain("--session");
    expect(shown).not.toContain(SESSION);
    expect(shown).not.toContain(KEY);
    expect(upstreamCalls).toHaveLength(0);
    expect(sessionInit).not.toHaveBeenCalled();
  });

  it("fails open after two gate answers in the conversation", async () => {
    prime([acct("a")]);
    app = createApp(gateConfig());
    const { upstreamCalls } = installFetch(() => sse());
    const gate = { role: "model", parts: [{ text: `${GATE_TEXT_MARKER} install` }] };
    const body = agyBody({ contents: [{ role: "user", parts: [{ text: "a" }] }, gate, { role: "user", parts: [{ text: "b" }] }, gate, { role: "user", parts: [{ text: "c" }] }] });
    const res = await post(streamPath(), body);
    await res.text();
    expect(upstreamCalls).toHaveLength(1);
    // The body goes upstream as agy sent it, gate turns included.
    expect(JSON.parse(upstreamCalls[0]!.body).request).toEqual(body);
  });

  it("passes when the hook reported the session", async () => {
    prime([acct("a")]);
    app = createApp(gateConfig());
    await store.put(
      { spaceId: SPACE, userId: "usr-1", agentSource: "antigravity", sessionId: SESSION },
      {
        sessionId: SESSION, deviceId: "d1", client: "antigravity", cwd: "/w", gitToplevel: null, gitRemote: null,
        projectKey: null, projectHash: null, projectLabel: null, hookEvent: "SessionStart", hookVersion: "1",
        reportedAt: "2026-11-19T00:00:00.000Z",
      },
    );
    const { upstreamCalls } = installFetch(() => sse());
    await (await post(streamPath(), agyBody())).text();
    expect(upstreamCalls).toHaveLength(1);
  });

  it("does not gate requests without a stream or without a cascade id", async () => {
    prime([acct("a")]);
    app = createApp(gateConfig());
    const { upstreamCalls } = installFetch(() => jsonResponse({ response: { candidates: [] } }));
    await post(`/antigravity/${SPACE}/${KEY}/v1beta/models/gemini-3.8-flash:generateContent`, agyBody());
    await (await post(streamPath(), agyBody({ labels: {} }))).text();
    expect(upstreamCalls).toHaveLength(2);
  });

  it("registers the session under labels.cascade_id and writes the L0 row", async () => {
    prime([acct("a")]);
    const config = configured();
    config.sessionInit = { ...(config.sessionInit ?? {}), enabled: true } as typeof config.sessionInit;
    config.tdai = {
      ...config.tdai, enabled: true, endpoint: CORE_URL,
      memory: { ...config.tdai.memory, enabled: true, writeL0: true, recallL1: false, injectL2L3: false },
    };
    app = createApp(config);
    sessionInit.mockResolvedValue({
      proceed: true, response: null, wentThroughStateMachine: false,
      initResult: {
        intercepted: false, bypassed: false, justRegistered: true,
        sessionInfo: { session_id: SESSION, team_id: "tm-1", agent_id: "agt-1", user_id: "usr-1", task_id: "tsk-1", space_id: SPACE },
      },
    });
    const calls = installFetch(() => sse(), (call) => (call.url.includes("/capabilities") || call.url.includes("capab")
      ? jsonResponse({ chat_memory: true })
      : jsonResponse({ code: 0, data: {} })));
    await (await post(streamPath(), agyBody())).text();
    await new Promise((r) => setTimeout(r, 150));
    expect(sessionInit).toHaveBeenCalledTimes(1);
    const args = sessionInit.mock.calls[0]![0] as { agentSourceForState: string; sessionKey: string; userId: string };
    expect(args.agentSourceForState).toBe("antigravity");
    expect(args.sessionKey).toBe(SESSION);
    const writes = calls.coreCalls.filter((c) => c.url.endsWith("/v3/conversation/add"));
    expect(writes).toHaveLength(1);
    const payload = JSON.parse(writes[0]!.body) as { messages: Array<{ role: string; content: string }> };
    expect(payload.messages).toEqual([{ role: "user", content: "say pong" }, { role: "assistant", content: "pong" }]);
    expect(JSON.stringify(calls.coreCalls.map((c) => [c.url, c.body]))).not.toContain(KEY);
  });

  describe("memory-off URL", () => {
    const offPath = `/antigravity/${SPACE}/${KEY}/memory-off/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse`;

    it("skips the hook gate and still returns the model answer", async () => {
      prime([acct("a")]);
      app = createApp(gateConfig());
      const { upstreamCalls } = installFetch(() => sse());
      const res = await post(offPath, agyBody(), { host: "proxy.example.test" });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).toContain('"po"');
      expect(text).not.toContain(GATE_TEXT_MARKER);
      expect(upstreamCalls).toHaveLength(1);
      expect(verifyUserKey).toHaveBeenCalledWith(KEY, SPACE);
    });

    it("rejects a wrong key on the memory-off URL like any other", async () => {
      prime([acct("a")]);
      verifyUserKey.mockImplementation(async () => ({ userId: "", rejected: true, rejectReason: "bad" }));
      const { upstreamCalls } = installFetch(() => sse());
      const res = await post(offPath, agyBody());
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(upstreamCalls).toHaveLength(0);
    });

    it("runs no session init and writes no L0 row, while the normal URL does both", async () => {
      prime([acct("a")]);
      const config = configured();
      config.sessionInit = { ...(config.sessionInit ?? {}), enabled: true } as typeof config.sessionInit;
      config.tdai = {
        ...config.tdai, enabled: true, endpoint: CORE_URL,
        memory: { ...config.tdai.memory, enabled: true, writeL0: true, recallL1: false, injectL2L3: false },
      };
      app = createApp(config);
      sessionInit.mockResolvedValue({
        proceed: true, response: null, wentThroughStateMachine: false,
        initResult: {
          intercepted: false, bypassed: false, justRegistered: true,
          sessionInfo: { session_id: SESSION, team_id: "tm-1", agent_id: "agt-1", user_id: "usr-1", task_id: "tsk-1", space_id: SPACE },
        },
      });
      const calls = installFetch(() => sse(), (call) => (call.url.includes("capab")
        ? jsonResponse({ chat_memory: true })
        : jsonResponse({ code: 0, data: {} })));
      const l0Writes = () => calls.coreCalls.filter((c) => c.url.endsWith("/v3/conversation/add"));

      const off = await post(offPath, agyBody());
      expect(await off.text()).toContain('"po"');
      await new Promise((r) => setTimeout(r, 150));
      expect(sessionInit).not.toHaveBeenCalled();
      expect(l0Writes()).toHaveLength(0);
      expect(calls.upstreamCalls).toHaveLength(1);

      await (await post(streamPath(), agyBody())).text();
      await new Promise((r) => setTimeout(r, 150));
      expect(sessionInit).toHaveBeenCalledTimes(1);
      expect(l0Writes()).toHaveLength(1);
    });
  });

  it("sends the session id of the pool binding from the cascade id", async () => {
    prime([acct("a"), acct("b")]);
    const { upstreamCalls } = installFetch(() => sse());
    for (let i = 0; i < 3; i++) await (await post(streamPath(), agyBody())).text();
    expect(new Set(upstreamCalls.map((c) => JSON.parse(c.body).project)).size).toBe(1);
  });
});

describe("supported agent entry", () => {
  it("is registered with the gemini protocol", async () => {
    const { DEFAULT_SUPPORTED_AGENTS, isSupportedAgent, isMultiSourceAgent } = await import("../../../supported-agents.js");
    expect(DEFAULT_SUPPORTED_AGENTS).toContainEqual({ agent_source: "antigravity", protocol: "gemini", display_name: "AntiGravity" });
    expect(isSupportedAgent("antigravity")).toBe(true);
    expect(isMultiSourceAgent("antigravity")).toBe(false);
  });
});

export type { RecordedCall };

describe("antigravity teams", () => {
  const teamPool = (team: string): InstanceUpstreamRow => ({ ...poolRow, group_id: `pool-agy-${team}`, name: `AGY pool ${team}`, team_id: team });
  const teamAcct = (team: string, partial: Partial<PoolAccount> = {}): PoolAccount =>
    acct(team, { group_id: `pool-agy-${team}`, ...partial });
  const primeTeams = (accounts: PoolAccount[], teams: string[] = ["team-a", "team-b"]): void => {
    __primeCacheForTests(SPACE, [defaultRow, ...teams.map(teamPool)]);
    __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts });
  };

  beforeEach(() => {
    useRealSessionTeams();
    setPoolTestTeams(["team-b", "team-a"]);
  });

  it("sends a team B session to its own account and never to team A", async () => {
    primeTeams([teamAcct("team-a"), teamAcct("team-b")]);
    await registerPoolTestSession("antigravity", SESSION, "team-b", "usr-1");
    const { upstreamCalls } = installFetch(() => sse());
    await (await post(streamPath(), agyBody())).text();
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer secret-token-team-b");
    expect(JSON.stringify(upstreamCalls[0]!.headers)).not.toContain("team-a");
  });

  it("answers the 400 of an unconfigured pool for a known team without an AntiGravity pool", async () => {
    setPoolTestTeams(["team-a", "team-c"]);
    primeTeams([teamAcct("team-a")], ["team-a"]);
    await registerPoolTestSession("antigravity", SESSION, "team-c", "usr-1");
    const { upstreamCalls } = installFetch(() => sse());
    const res = await post(streamPath(), agyBody());
    expect(res.status).toBe(400);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("takes the first team in Core order that has a usable account when the session has no team", async () => {
    primeTeams([teamAcct("team-b", { status: "exhausted", exhausted_until: NOW + 3_600_000 }), teamAcct("team-a")]);
    const { upstreamCalls } = installFetch(() => sse());
    sessionInit.mockResolvedValue({
      proceed: true, response: null, wentThroughStateMachine: false,
      initResult: { intercepted: false, bypassed: true, justRegistered: false, sessionInfo: null },
    });
    await (await post(streamPath(), agyBody())).text();
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer secret-token-team-a");
  });

  it("answers 429 when no team has a usable account, and calls no upstream", async () => {
    const out = { status: "exhausted" as const, exhausted_until: NOW + 3_600_000 };
    primeTeams([teamAcct("team-b", out), teamAcct("team-a", out)]);
    const { upstreamCalls } = installFetch(() => sse());
    const res = await post(streamPath(), agyBody(), {});
    expect(res.status).toBe(429);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("answers 403 for a user with no team, and calls no upstream", async () => {
    setPoolTestTeams([]);
    primeTeams([teamAcct("team-a")]);
    const { upstreamCalls } = installFetch(() => sse());
    const res = await post(streamPath(), agyBody());
    expect(res.status).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("lists the model catalog through the first team with a usable account, in Core order", async () => {
    primeTeams([teamAcct("team-b", { status: "exhausted", exhausted_until: NOW + 3_600_000 }), teamAcct("team-a")]);
    const { upstreamCalls } = installFetch(() => jsonResponse({ models: { "gemini-3.8-flash-medium": { displayName: "Flash" } } }));
    const res = await app.request(`/antigravity/${SPACE}/${KEY}/v1beta/models`);
    expect(res.status).toBe(200);
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer secret-token-team-a");
  });

  it("answers the 400 of an unconfigured pool on the model list when no team of the user has a pool", async () => {
    setPoolTestTeams(["team-x"]);
    primeTeams([teamAcct("team-a")]);
    const { upstreamCalls } = installFetch(() => jsonResponse({ models: {} }));
    const res = await app.request(`/antigravity/${SPACE}/${KEY}/v1beta/models`);
    expect(res.status).toBe(400);
    expect(upstreamCalls).toHaveLength(0);
  });
});
