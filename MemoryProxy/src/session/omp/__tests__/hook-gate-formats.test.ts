import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryStorage } from "../../../storage/memory-storage.js";
import {
  SessionWorkspaceStore,
  setSessionWorkspaceStore,
} from "../../../project-scope/session-workspace.js";
import { GATE_TEXT_MARKER, resetHookGateCache } from "../../hook-gate-core.js";
import { OMP_GATE_CALL_PREFIX, runOmpHookGate, stripOmpGateTurns, type OmpGateParams } from "../hook-gate.js";

const SID = "01a16eab-0b03-708d-8d4f-4bba152cad8e";
const ORIGIN = "http://127.0.0.1:8096";
const COMMAND = `curl -fsSL ${ORIGIN}/setup/hooks.sh | bash -s -- --client omp --session ${SID} --base-url ${ORIGIN}`;
const GATE_ID = `${OMP_GATE_CALL_PREFIX}1`;
const OK = "Agent-Memory hooks installed.\n\nWall time: 3.2 seconds";

let store: SessionWorkspaceStore;

beforeEach(() => {
  resetHookGateCache();
  store = new SessionWorkspaceStore(new MemoryStorage());
  setSessionWorkspaceStore(store);
});
afterEach(() => setSessionWorkspaceStore(null));

function gateParams(path: string, body: Record<string, unknown>, overrides: Partial<OmpGateParams> = {}): OmpGateParams {
  return {
    config: { hookGate: { enabled: true } },
    path,
    body: { stream: true, ...body },
    sessionId: SID,
    spaceId: "default",
    userId: "usr-1",
    modelId: "test-model",
    origin: ORIGIN,
    waitMs: 0,
    ...overrides,
  };
}

/** Events of a Server-Sent Events body: `{event, data}` per block. */
async function events(res: Response): Promise<Array<{ event: string | null; data: Record<string, any> | "[DONE]" }>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.trim().length > 0)
    .map((b) => {
      const event = /^event: (.*)$/m.exec(b)?.[1] ?? null;
      const raw = /^data: (.*)$/m.exec(b)?.[1] ?? "";
      return { event, data: raw === "[DONE]" ? "[DONE]" : JSON.parse(raw) };
    });
}

// ── anthropic-messages ───────────────────────────────────────────────────────

describe("omp hook gate: anthropic-messages", () => {
  const PATH = "/omp/default/v1/messages";
  const tool = (name: string) => ({ name, input_schema: { type: "object" } });
  const TUI_TOOLS = ["_read", "_bash", "_edit", "_ask", "_write"].map(tool);
  const PRINT_TOOLS = ["_read", "_bash", "_edit", "_write"].map(tool);
  const PROMPT = { role: "user", content: "<system-reminder>\nToday\n</system-reminder>\nfix the login bug" };
  const call = { role: "assistant", content: [{ type: "tool_use", id: GATE_ID, name: "_bash", input: { command: "x", i: "y" } }] };
  const result = (text: string) => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: GATE_ID, content: text, is_error: false }],
  });

  it("answers a terminal session with a _bash tool_use that carries the install command", async () => {
    const out = await runOmpHookGate(gateParams(PATH, { tools: TUI_TOOLS, messages: [PROMPT] }));
    expect(out).toMatchObject({ action: "respond", reason: "install-requested" });
    if (out.action !== "respond") return;
    const evs = await events(out.response);
    const start = evs.find((e) => e.event === "content_block_start" && (e.data as any).content_block.type === "tool_use")!.data as any;
    expect(start.content_block).toMatchObject({ type: "tool_use", name: "_bash" });
    expect(start.content_block.id.startsWith(OMP_GATE_CALL_PREFIX)).toBe(true);
    const json = evs.filter((e) => e.event === "content_block_delta" && (e.data as any).delta.type === "input_json_delta").map((e) => (e.data as any).delta.partial_json).join("");
    expect(JSON.parse(json)).toEqual({ command: COMMAND, i: expect.any(String) });
    expect(evs.find((e) => e.event === "message_delta")!.data).toMatchObject({ delta: { stop_reason: "tool_use" } });
  });

  it("passes omp -p, a title request without tools, and a non-streaming request", async () => {
    for (const body of [{ tools: PRINT_TOOLS, messages: [PROMPT] }, { messages: [PROMPT] }, { tools: TUI_TOOLS, stream: false, messages: [PROMPT] }]) {
      expect(await runOmpHookGate(gateParams(PATH, body))).toMatchObject({ action: "pass", reason: "non-interactive" });
    }
  });

  it("does not read the OpenAI tool names (ask, bash) in this format", async () => {
    const tools = ["ask", "bash"].map(tool);
    expect(await runOmpHookGate(gateParams(PATH, { tools, messages: [PROMPT] }))).toMatchObject({ action: "pass" });
  });

  it("passes without a session id", async () => {
    const out = await runOmpHookGate(gateParams(PATH, { tools: TUI_TOOLS, messages: [PROMPT] }, { sessionId: null }));
    expect(out).toMatchObject({ action: "pass", reason: "no-session-id" });
  });

  it("answers the failed result with text, then lets a second failure through", async () => {
    const withResult = { tools: TUI_TOOLS, messages: [PROMPT, call, result("curl: (7) failed")] };
    const out = await runOmpHookGate(gateParams(PATH, withResult));
    expect(out).toMatchObject({ action: "respond", reason: "install-failed" });
    if (out.action !== "respond") return;
    const evs = await events(out.response);
    const answer = evs
      .filter((e) => e.event === "content_block_delta" && (e.data as any).delta.type === "text_delta")
      .map((e) => (e.data as any).delta.text)
      .join("");
    expect(answer.startsWith(GATE_TEXT_MARKER)).toBe(true);
    expect(answer).toContain(COMMAND);

    const text = { role: "assistant", content: [{ type: "text", text: `${GATE_TEXT_MARKER} not installed` }] };
    const second = { role: "assistant", content: [{ type: "tool_use", id: `${OMP_GATE_CALL_PREFIX}2`, name: "_bash", input: {} }] };
    const secondResult = { role: "user", content: [{ type: "tool_result", tool_use_id: `${OMP_GATE_CALL_PREFIX}2`, content: "failed" }] };
    const messages = [PROMPT, call, result("failed"), text, PROMPT, second, secondResult, { role: "assistant", content: [{ type: "text", text: `${GATE_TEXT_MARKER} again` }] }, PROMPT];
    expect(await runOmpHookGate(gateParams(PATH, { tools: TUI_TOOLS, messages }))).toMatchObject({ action: "pass", reason: "retry-limit" });
  });

  it("lets the prompt through without the synthetic turns once the report exists", async () => {
    await store.put({ spaceId: "default", userId: "usr-1", agentSource: "omp", sessionId: SID }, {
      sessionId: SID, deviceId: "d1", client: "omp", cwd: "/tmp/x", gitToplevel: null, gitRemote: null,
      projectKey: null, projectHash: null, projectLabel: null, hookEvent: "Install", hookVersion: "1",
      reportedAt: "2026-10-24T00:00:00.000Z",
    });
    const out = await runOmpHookGate(gateParams(PATH, { tools: TUI_TOOLS, messages: [PROMPT, call, result(OK)] }));
    expect(out.action === "pass" && out.reason).toBe("installed");
    expect(out.action === "pass" && out.body.messages).toEqual([PROMPT]);
  });

  it("strips the gate call, the result and the text answers, and keeps the rest", () => {
    const text = { role: "assistant", content: [{ type: "text", text: `${GATE_MARKER_TEXT()}` }] };
    const later = { role: "user", content: "next" };
    const body = { messages: [PROMPT, call, result(OK), text, later] };
    expect(stripOmpGateTurns(body, "anthropic-messages").messages).toEqual([PROMPT, later]);
  });

  it("keeps the other blocks of a mixed message and returns the same object when nothing matches", () => {
    const mixed = { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: GATE_ID, name: "_bash", input: {} }] };
    expect(stripOmpGateTurns({ messages: [mixed] }, "anthropic-messages").messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
    const clean = { messages: [PROMPT, { role: "assistant", content: [{ type: "text", text: "hello" }] }] };
    expect(stripOmpGateTurns(clean, "anthropic-messages")).toBe(clean);
  });
});

const GATE_MARKER_TEXT = () => `${GATE_TEXT_MARKER} not installed`;

// ── openai-responses ─────────────────────────────────────────────────────────

describe("omp hook gate: openai-responses", () => {
  const PATH = "/omp/default/v1/responses";
  const tool = (name: string) => ({ type: "function", name, parameters: { type: "object" } });
  const TUI_TOOLS = ["read", "bash", "edit", "ask", "write"].map(tool);
  const PRINT_TOOLS = ["read", "bash", "edit", "write"].map(tool);
  const PROMPT = {
    role: "user",
    content: [
      { type: "input_text", text: "<system-reminder>\nToday\n</system-reminder>" },
      { type: "input_text", text: "fix the login bug" },
    ],
  };
  const call = { type: "function_call", call_id: GATE_ID, name: "bash", arguments: "{}" };
  const output = (text: string) => ({ type: "function_call_output", call_id: GATE_ID, output: text });
  const gateText = { type: "message", role: "assistant", content: [{ type: "output_text", text: `${GATE_TEXT_MARKER} not installed` }] };

  it("answers a terminal session with a bash function_call stream", async () => {
    const out = await runOmpHookGate(gateParams(PATH, { tools: TUI_TOOLS, input: [PROMPT] }));
    expect(out).toMatchObject({ action: "respond", reason: "install-requested" });
    if (out.action !== "respond") return;
    const evs = await events(out.response);
    expect(evs.map((e) => e.event)).toEqual([
      "response.created", "response.in_progress", "response.output_item.added",
      "response.function_call_arguments.delta", "response.function_call_arguments.done",
      "response.output_item.done", "response.completed",
    ]);
    const item = (evs.find((e) => e.event === "response.output_item.done")!.data as any).item;
    expect(item).toMatchObject({ type: "function_call", name: "bash", status: "completed" });
    expect(item.call_id.startsWith(OMP_GATE_CALL_PREFIX)).toBe(true);
    expect(JSON.parse(item.arguments)).toEqual({ command: COMMAND, i: expect.any(String) });
    expect((evs[2].data as any).item.arguments).toBe("");
  });

  it("passes omp -p, a request without tools, and a non-streaming request", async () => {
    for (const body of [{ tools: PRINT_TOOLS, input: [PROMPT] }, { input: [PROMPT] }, { tools: TUI_TOOLS, stream: false, input: [PROMPT] }]) {
      expect(await runOmpHookGate(gateParams(PATH, body))).toMatchObject({ action: "pass", reason: "non-interactive" });
    }
  });

  it("does not gate the compaction route", async () => {
    expect(await runOmpHookGate(gateParams("/omp/default/v1/responses/compact", { tools: TUI_TOOLS, input: [PROMPT] }))).toMatchObject({
      action: "pass", reason: "other-route",
    });
  });

  it("passes without a session id", async () => {
    expect(await runOmpHookGate(gateParams(PATH, { tools: TUI_TOOLS, input: [PROMPT] }, { sessionId: null }))).toMatchObject({
      action: "pass", reason: "no-session-id",
    });
  });

  it("answers the result of a refused install with a text message", async () => {
    const out = await runOmpHookGate(gateParams(PATH, { tools: TUI_TOOLS, input: [PROMPT, call, output("Aborted by user")] }));
    expect(out).toMatchObject({ action: "respond", reason: "install-rejected" });
    if (out.action !== "respond") return;
    const evs = await events(out.response);
    const item = (evs.find((e) => e.event === "response.output_item.done")!.data as any).item;
    expect(item).toMatchObject({ type: "message", role: "assistant" });
    expect(item.content[0].text.startsWith(GATE_TEXT_MARKER)).toBe(true);
  });

  it("strips the call, the output and the text answers on a pass", async () => {
    const later = { role: "user", content: [{ type: "input_text", text: "next" }] };
    const body = { input: [PROMPT, call, output(OK), gateText, later] };
    expect(stripOmpGateTurns(body, "openai-responses").input).toEqual([PROMPT, later]);
    const out = await runOmpHookGate(gateParams(PATH, { tools: PRINT_TOOLS, input: [PROMPT, call, output(OK), gateText, later] }));
    expect(out.action === "pass" && (out.body.input as unknown[])).toEqual([PROMPT, later]);
  });

  it("keeps calls of other tools and returns the same object when nothing matches", () => {
    const other = { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" };
    const clean = { input: [PROMPT, other, { type: "function_call_output", call_id: "call_1", output: "x" }] };
    expect(stripOmpGateTurns(clean, "openai-responses")).toBe(clean);
  });
});

// ── Other agents keep their own gates ────────────────────────────────────────

describe("omp hook gate: routes of other agents", () => {
  it.each(["/claude-code/default/v1/messages", "/codex/default/v1/responses", "/pi/default/v1/chat/completions"])(
    "does not gate %s",
    async (path) => {
      const tools = ["_ask", "_bash", "ask", "bash"].map((name) => ({ name }));
      expect(await runOmpHookGate(gateParams(path, { tools, messages: [], input: [] }))).toMatchObject({
        action: "pass", reason: "other-route",
      });
    },
  );
});
