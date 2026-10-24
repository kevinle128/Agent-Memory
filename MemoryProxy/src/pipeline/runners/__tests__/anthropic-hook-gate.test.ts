/**
 * Anthropic runner: an interactive Claude Code session without a hook report is
 * answered by the hook gate. A gated turn reaches no upstream, writes no L0 and
 * starts no skill work. Once the hook reported, the turn goes through with the
 * synthetic gate turns removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../../../storage/memory-storage.js";
import { SessionWorkspaceStore, setSessionWorkspaceStore } from "../../../project-scope/session-workspace.js";
import { GATE_FORM_PREFIX, GATE_INSTALL_PREFIX, INSTALL_LABEL, resetHookGateCache } from "../../../session/claude-code/hook-gate.js";
import { createHookReportHandler } from "../../../routes/hook-report.js";
import { CORE_URL, installFetch, makeApp, makeConfig, resetPoolState } from "../../../subscription-pool/__tests__/test-harness.js";

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

const anthropicReply = () => new Response(
  [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-test", content: [], usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

const tools = (...names: string[]) => names.map((name) => ({ name, input_schema: { type: "object" } }));
const prompt = { role: "user", content: [{ type: "text", text: "fix the login bug" }] };
const syntheticTurns = [
  { role: "assistant", content: [{ type: "tool_use", id: `${GATE_FORM_PREFIX}1`, name: "AskUserQuestion", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: `${GATE_FORM_PREFIX}1`, content: `User has answered your questions: "q"="${INSTALL_LABEL}".` }] },
  { role: "assistant", content: [{ type: "tool_use", id: `${GATE_INSTALL_PREFIX}2`, name: "Bash", input: { command: "x" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: `${GATE_INSTALL_PREFIX}2`, content: "ok" }] },
];

async function send(messages: unknown[], toolNames: string[], hookGate = true, stream = true, beforeSend?: (app: ReturnType<typeof makeApp>, config: ReturnType<typeof makeConfig>) => Promise<void>) {
  const config = makeConfig();
  config.hookGate = { enabled: hookGate };
  config.sessionInit = { ...(config.sessionInit ?? {}), enabled: true } as typeof config.sessionInit;
  config.tdai = {
    ...config.tdai, enabled: true, endpoint: CORE_URL,
    memory: { ...config.tdai.memory, enabled: true, writeL0: true, recallL1: false, injectL2L3: false },
  };
  const calls = installFetch(() => anthropicReply());
  const app = makeApp(config);
  app.post("/:agent/:spaceId/v3/hook/report", (c) => createHookReportHandler(config)(c));
  await beforeSend?.(app, config);
  const res = await app.request("/claude-code/default/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json", authorization: "Bearer k",
      "x-claude-code-session-id": SESSION, host: "127.0.0.1:8096",
    },
    body: JSON.stringify({ model: "claude-test", max_tokens: 100, stream, tools: tools(...toolNames), messages }),
  });
  const text = await res.text();
  await new Promise((r) => setTimeout(r, 100));
  return { res, text, calls };
}

/** Model calls only; the billing report goes to a second host. */
const modelCalls = (calls: ReturnType<typeof installFetch>) =>
  calls.upstreamCalls.filter((c) => c.url.endsWith("/v1/messages"));

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

describe("anthropic runner hook gate", () => {
  it("answers the install form without any upstream call, L0 write or session-init", async () => {
    const { res, text, calls } = await send([prompt], ["Bash", "AskUserQuestion"]);
    expect(res.status).toBe(200);
    expect(text).toContain(GATE_FORM_PREFIX);
    expect(calls.upstreamCalls).toHaveLength(0); // no model call and no billing report
    // The only Core call is the read of the upstream config, made before the gate.
    expect(calls.coreCalls.map((c) => new URL(c.url).pathname)).toEqual(["/v3/internal/meta/instance-upstream/list"])
    expect(l0Writes(calls)).toHaveLength(0);
    expect(sessionInitCalls).toHaveLength(0);
  });

  it("forwards a headless run unchanged", async () => {
    const { text, calls } = await send([prompt], ["Bash"]);
    expect(text).not.toContain(GATE_FORM_PREFIX);
    expect(modelCalls(calls)).toHaveLength(1);
    expect(JSON.parse(modelCalls(calls)[0]!.body).messages).toEqual([prompt]);
  });

  it("forwards the original prompt without gate turns once the hook reported, then runs session-init", async () => {
    await store.put(
      { spaceId: "default", userId: "usr-1", agentSource: "claude-code", sessionId: SESSION },
      {
        sessionId: SESSION, deviceId: "d1", client: "claude-code", cwd: "/w", gitToplevel: null, gitRemote: null,
        projectKey: null, projectHash: null, projectLabel: null, hookEvent: "Install", hookVersion: "1",
        reportedAt: "2026-10-24T00:00:00.000Z",
      },
    );
    const { text, calls } = await send([prompt, ...syntheticTurns], ["Bash", "AskUserQuestion"]);
    expect(text).not.toContain(GATE_FORM_PREFIX);
    expect(modelCalls(calls)).toHaveLength(1);
    expect(JSON.parse(modelCalls(calls)[0]!.body).messages).toEqual([prompt]);
    expect(sessionInitCalls).toHaveLength(1);
  });

  it("does not gate when the config switch is off", async () => {
    const { text, calls } = await send([prompt], ["Bash", "AskUserQuestion"], false);
    expect(text).not.toContain(GATE_FORM_PREFIX);
    expect(modelCalls(calls)).toHaveLength(1);
  });

  it("passes a model request after the hook posted its report to the real report route", async () => {
    // Proves the gate looks up the same key that the report route writes.
    const { text, calls } = await send([prompt], ["Bash", "AskUserQuestion"], true, true, async (app) => {
      const res = await app.request("/claude-code/default/v3/hook/report", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer k" },
        body: JSON.stringify({
          device_id: "d1", session_id: SESSION, cwd: "/tmp/plain", client: "claude-code",
          hook_version: "1", hook_event: "UserPromptSubmit",
        }),
      });
      expect(res.status).toBe(204);
    });
    expect(text).not.toContain(GATE_FORM_PREFIX);
    expect(modelCalls(calls)).toHaveLength(1);
  });

  it("removes gate turns from a request that does not stream", async () => {
    const { calls } = await send([prompt, ...syntheticTurns], ["Bash", "AskUserQuestion"], true, false);
    expect(JSON.parse(modelCalls(calls)[0]!.body).messages).toEqual([prompt]);
  });

  it("removes gate turns from a resumed headless run and when the gate is off", async () => {
    const headless = await send([prompt, ...syntheticTurns], ["Bash"]);
    expect(JSON.parse(modelCalls(headless.calls)[0]!.body).messages).toEqual([prompt]);
    const off = await send([prompt, ...syntheticTurns], ["Bash", "AskUserQuestion"], false);
    expect(JSON.parse(modelCalls(off.calls)[0]!.body).messages).toEqual([prompt]);
  });
});
