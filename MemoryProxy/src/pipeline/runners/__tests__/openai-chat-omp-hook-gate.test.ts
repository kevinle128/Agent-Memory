/**
 * OpenAI-chat runner, pi route: an interactive omp session without a hook
 * report is answered by the hook gate. A gated turn reaches no upstream, writes
 * no L0 and starts no session-init. omp sends its session id in the body field
 * `prompt_cache_key`. Plain pi and `omp -p` are not gated.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../../../storage/memory-storage.js";
import { SessionWorkspaceStore, setSessionWorkspaceStore } from "../../../project-scope/session-workspace.js";
import { OMP_GATE_CALL_PREFIX } from "../../../session/pi/hook-gate.js";
import { resetHookGateCache } from "../../../session/hook-gate-core.js";
import { createHookReportHandler } from "../../../routes/hook-report.js";
import { runOpenaiChatPipeline } from "../openai-chat.js";
import { CORE_URL, installFetch, jsonResponse, makeConfig, resetPoolState } from "../../../subscription-pool/__tests__/test-harness.js";

const SESSION = "01a16eab-0b03-708d-8d4f-4bba152cad8e";

vi.mock("../../../auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../auth.js")>()),
  verifyUserKey: async () => ({ userId: "usr-1", rejected: false }),
}));

const sessionInitCalls: unknown[] = [];
vi.mock("../../stages/session-init-orchestrate.js", () => ({
  stageSessionInitOrchestrate: async (args: unknown) => {
    sessionInitCalls.push(args);
    return {
      proceed: true, response: null, wentThroughStateMachine: false,
      initResult: { intercepted: false, bypassed: true, justRegistered: false, sessionInfo: null },
    };
  },
}));

const chatReply = () => jsonResponse({
  id: "c1", object: "chat.completion", model: "m",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

const fnTool = (name: string) => ({ type: "function", function: { name, parameters: { type: "object" } } });
const INTERACTIVE = ["read", "bash", "ask"].map(fnTool);
const PRINT = ["read", "bash"].map(fnTool);
const PROMPT = {
  role: "user",
  content: [
    { type: "text", text: "<system-reminder>\nToday: 2026-10-24.\n</system-reminder>" },
    { type: "text", text: "fix the login bug" },
  ],
};
const GATE_TURNS = [
  { role: "assistant", content: "", tool_calls: [{ id: `${OMP_GATE_CALL_PREFIX}1`, type: "function", function: { name: "bash", arguments: "{}" } }] },
  { role: "tool", content: "ok", tool_call_id: `${OMP_GATE_CALL_PREFIX}1` },
];

interface SendOptions {
  hookGate?: boolean;
  userAgent?: string;
  tools?: unknown[];
  messages?: unknown[];
  extraBody?: Record<string, unknown>;
  beforeSend?: (app: Hono) => Promise<void>;
}

async function send(options: SendOptions = {}) {
  const config = makeConfig();
  config.hookGate = { enabled: options.hookGate ?? true };
  config.sessionInit = { ...(config.sessionInit ?? {}), enabled: true } as typeof config.sessionInit;
  config.injection = { ...(config.injection ?? {}), enabled: false } as typeof config.injection;
  config.tdai = {
    ...config.tdai, enabled: true, endpoint: CORE_URL,
    memory: { ...config.tdai.memory, enabled: true, writeL0: true, recallL1: false, injectL2L3: false },
  };
  const calls = installFetch(() => chatReply());
  const app = new Hono();
  app.post("/:agent/:spaceId/v1/chat/completions", (c) => runOpenaiChatPipeline(c, config));
  app.post("/:agent/:spaceId/v3/hook/report", (c) => createHookReportHandler(config)(c));
  await options.beforeSend?.(app);
  const res = await app.request("/pi/default/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json", authorization: "Bearer k",
      "user-agent": options.userAgent ?? "omp/18.6.3", host: "127.0.0.1:8096",
    },
    body: JSON.stringify({
      model: "m", stream: true, tools: options.tools ?? INTERACTIVE, prompt_cache_key: SESSION,
      messages: options.messages ?? [PROMPT], ...options.extraBody,
    }),
  });
  const text = await res.text();
  await new Promise((r) => setTimeout(r, 100));
  return { res, text, calls };
}

const modelCalls = (calls: ReturnType<typeof installFetch>) =>
  calls.upstreamCalls.filter((c) => c.url.endsWith("/chat/completions"));
const l0Writes = (calls: ReturnType<typeof installFetch>) =>
  calls.coreCalls.filter((c) => c.url.endsWith("/v3/conversation/add"));

let store: SessionWorkspaceStore;

beforeEach(() => {
  resetPoolState();
  resetHookGateCache();
  sessionInitCalls.length = 0;
  store = new SessionWorkspaceStore(new MemoryStorage());
  setSessionWorkspaceStore(store);
});

afterEach(() => {
  setSessionWorkspaceStore(null);
  vi.unstubAllGlobals();
});

async function putReport() {
  await store.put(
    { spaceId: "default", userId: "usr-1", agentSource: "pi", sessionId: SESSION },
    {
      sessionId: SESSION, deviceId: "d1", client: "omp", cwd: "/w", gitToplevel: null, gitRemote: null,
      projectKey: null, projectHash: null, projectLabel: null, hookEvent: "Install", hookVersion: "1",
      reportedAt: "2026-10-24T00:00:00.000Z",
    },
  );
}

describe("openai-chat runner hook gate for omp", () => {
  it("answers with the install tool call without any upstream call, L0 write or session-init", async () => {
    const { res, text, calls } = await send();
    expect(res.status).toBe(200);
    expect(text).toContain(OMP_GATE_CALL_PREFIX);
    expect(text).toContain("--client omp --session " + SESSION);
    expect(calls.upstreamCalls).toHaveLength(0);
    expect(l0Writes(calls)).toHaveLength(0);
    expect(sessionInitCalls).toHaveLength(0);
  });

  it("forwards the original prompt without gate turns once the hook reported", async () => {
    await putReport();
    const { calls } = await send({ messages: [PROMPT, ...GATE_TURNS] });
    expect(modelCalls(calls)).toHaveLength(1);
    expect(JSON.parse(modelCalls(calls)[0]!.body).messages).toEqual([PROMPT]);
    expect(sessionInitCalls).toHaveLength(1);
  });

  it("passes once the extension posted its report to the real report route", async () => {
    const { calls } = await send({
      beforeSend: async (app) => {
        const res = await app.request("/pi/default/v3/hook/report", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer k" },
          body: JSON.stringify({
            device_id: "d1", session_id: SESSION, cwd: "/tmp/plain", client: "omp",
            hook_version: "1", hook_event: "Install",
          }),
        });
        expect(res.status).toBe(204);
      },
    });
    expect(modelCalls(calls)).toHaveLength(1);
  });

  it("does not gate omp -p (no ask tool), and removes the gate turns", async () => {
    const { calls } = await send({ tools: PRINT, messages: [PROMPT, ...GATE_TURNS] });
    expect(modelCalls(calls)).toHaveLength(1);
    expect(JSON.parse(modelCalls(calls)[0]!.body).messages).toEqual([PROMPT]);
  });

  it("does not gate plain pi, even with an ask tool and the same key field", async () => {
    const { text, calls } = await send({ userAgent: "OpenAI/JS 6.26.0" });
    expect(text).not.toContain(OMP_GATE_CALL_PREFIX);
    expect(modelCalls(calls)).toHaveLength(1);
  });

  it("does not gate when the config switch is off, and removes the gate turns", async () => {
    const { calls } = await send({ hookGate: false, messages: [PROMPT, ...GATE_TURNS] });
    expect(modelCalls(calls)).toHaveLength(1);
    expect(JSON.parse(modelCalls(calls)[0]!.body).messages).toEqual([PROMPT]);
  });

  it("does not gate an omp request without prompt_cache_key", async () => {
    const { text, calls } = await send({ extraBody: { prompt_cache_key: undefined } });
    expect(text).not.toContain(OMP_GATE_CALL_PREFIX);
    expect(modelCalls(calls)).toHaveLength(1);
  });
});
