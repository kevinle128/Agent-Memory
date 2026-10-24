/**
 * Codex runner: an interactive Codex session without a hook report is answered
 * by the hook gate. A gated turn reaches no upstream, writes no L0 and starts no
 * session-init. Once the hook reported, the turn goes through with the synthetic
 * gate items removed. The title request of the terminal is a side request.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../../../storage/memory-storage.js";
import { SessionWorkspaceStore, setSessionWorkspaceStore } from "../../../project-scope/session-workspace.js";
import { CODEX_GATE_CALL_PREFIX } from "../../../session/codex/hook-gate.js";
import { resetHookGateCache } from "../../../session/hook-gate-core.js";
import { createHookReportHandler } from "../../../routes/hook-report.js";
import { runCodexPipeline } from "../codex.js";
import { CORE_URL, installFetch, makeConfig, resetPoolState } from "../../../subscription-pool/__tests__/test-harness.js";

const SESSION = "01a16c99-623a-7cc3-b2c4-91528f4f0665";

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

const delta = JSON.stringify({ type: "response.output_text.delta", delta: "done" });
const completed = JSON.stringify({
  type: "response.completed",
  response: { id: "r", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
});
const responsesReply = () => new Response(
  `event: response.output_text.delta\ndata: ${delta}\n\nevent: response.completed\ndata: ${completed}\n\n`,
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });
const PROMPT = message("user", "fix the login bug");
const TOOLS = [{ type: "function", name: "exec_command" }, { type: "custom", name: "apply_patch" }];
const ABORTED = message("user", "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>");
const GATE_ITEMS = [
  { type: "function_call", id: "fc_x", name: "exec_command", arguments: "{}", call_id: `${CODEX_GATE_CALL_PREFIX}1` },
  { type: "function_call_output", id: "fco_x", call_id: `${CODEX_GATE_CALL_PREFIX}1`, output: "ok" },
  ABORTED,
];

interface SendOptions {
  hookGate?: boolean;
  path?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  beforeSend?: (app: Hono) => Promise<void>;
}

async function send(options: SendOptions = {}) {
  const config = makeConfig();
  config.hookGate = { enabled: options.hookGate ?? true };
  config.sessionInit = { ...(config.sessionInit ?? {}), enabled: true } as typeof config.sessionInit;
  config.tdai = {
    ...config.tdai, enabled: true, endpoint: CORE_URL,
    memory: { ...config.tdai.memory, enabled: true, writeL0: true, recallL1: false, injectL2L3: false },
  };
  const calls = installFetch(() => responsesReply());
  const app = new Hono();
  app.post("/codex/:spaceId/v1/responses/compact", (c) => runCodexPipeline(c, config));
  app.post("/codex/:spaceId/v1/responses", (c) => runCodexPipeline(c, config));
  app.post("/:agent/:spaceId/v3/hook/report", (c) => createHookReportHandler(config)(c));
  await options.beforeSend?.(app);
  const res = await app.request(options.path ?? "/codex/default/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json", authorization: "Bearer k", "session-id": SESSION,
      originator: "codex-tui", host: "127.0.0.1:8096",
      "x-codex-turn-metadata": JSON.stringify({ thread_source: "user" }), ...options.headers,
    },
    body: JSON.stringify({ model: "gpt-5.5", stream: true, tools: TOOLS, input: [PROMPT], ...options.body }),
  });
  const text = await res.text();
  await new Promise((r) => setTimeout(r, 100));
  return { res, text, calls };
}

const modelCalls = (calls: ReturnType<typeof installFetch>) =>
  calls.upstreamCalls.filter((c) => /\/responses(\/compact)?$/.test(c.url));
const l0Writes = (calls: ReturnType<typeof installFetch>) =>
  calls.coreCalls.filter((c) => c.url.endsWith("/v3/conversation/add"));
const forwardedInput = (calls: ReturnType<typeof installFetch>) => JSON.parse(modelCalls(calls)[0]!.body).input;

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
    { spaceId: "default", userId: "usr-1", agentSource: "codex", sessionId: SESSION },
    {
      sessionId: SESSION, deviceId: "d1", client: "codex", cwd: "/w", gitToplevel: null, gitRemote: null,
      projectKey: null, projectHash: null, projectLabel: null, hookEvent: "Install", hookVersion: "1",
      reportedAt: "2026-10-24T00:00:00.000Z",
    },
  );
}

describe("codex runner hook gate", () => {
  it("answers with the install tool call without any upstream call, L0 write or session-init", async () => {
    const { res, text, calls } = await send();
    expect(res.status).toBe(200);
    expect(text).toContain("response.function_call_arguments.delta");
    expect(text).toContain(CODEX_GATE_CALL_PREFIX);
    expect(text).toContain("require_escalated");
    expect(calls.upstreamCalls).toHaveLength(0);
    expect(l0Writes(calls)).toHaveLength(0);
    expect(sessionInitCalls).toHaveLength(0);
  });

  it("forwards the original prompt without gate items once the hook reported", async () => {
    await putReport();
    const { calls } = await send({ body: { input: [PROMPT, ...GATE_ITEMS] } });
    expect(modelCalls(calls)).toHaveLength(1);
    expect(forwardedInput(calls)).toEqual([PROMPT]);
    expect(sessionInitCalls).toHaveLength(1);
  });

  it("passes once the hook posted its report to the real report route", async () => {
    // Proves the gate looks up the same key that the report route writes.
    const { calls } = await send({
      beforeSend: async (app) => {
        const res = await app.request("/codex/default/v3/hook/report", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer k" },
          body: JSON.stringify({
            device_id: "d1", session_id: SESSION, cwd: "/tmp/plain", client: "codex",
            hook_version: "1", hook_event: "Install",
          }),
        });
        expect(res.status).toBe(204);
      },
    });
    expect(modelCalls(calls)).toHaveLength(1);
  });

  it("does not gate codex exec, and removes the gate items from its history", async () => {
    const { calls } = await send({ headers: { originator: "codex_exec" }, body: { input: [PROMPT, ...GATE_ITEMS] } });
    expect(modelCalls(calls)).toHaveLength(1);
    expect(forwardedInput(calls)).toEqual([PROMPT]);
  });

  it("does not gate when the config switch is off, and removes the gate items", async () => {
    const { calls } = await send({ hookGate: false, body: { input: [PROMPT, ...GATE_ITEMS] } });
    expect(modelCalls(calls)).toHaveLength(1);
    expect(forwardedInput(calls)).toEqual([PROMPT]);
  });

  it("treats the title request as a side request: no gate, no session-init, no L0", async () => {
    const meta = JSON.stringify({ session_id: SESSION, thread_source: "thread_title" });
    const { text, calls } = await send({
      headers: { "x-codex-turn-metadata": meta },
      body: { tools: [{ type: "custom", name: "apply_patch" }] },
    });
    expect(text).not.toContain(CODEX_GATE_CALL_PREFIX);
    expect(modelCalls(calls)).toHaveLength(1);
    expect(sessionInitCalls).toHaveLength(0);
    expect(l0Writes(calls)).toHaveLength(0);
  });

  it("removes the gate items from a compaction request", async () => {
    const { calls } = await send({ path: "/codex/default/v1/responses/compact", body: { input: [PROMPT, ...GATE_ITEMS] } });
    expect(modelCalls(calls)).toHaveLength(1);
    expect(forwardedInput(calls)).toEqual([PROMPT]);
  });
});
