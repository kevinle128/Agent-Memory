/**
 * Byte-level snapshots of every synthetic Claude Code gate answer, so a change
 * of the code under the gate cannot change what the client receives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../../../storage/memory-storage.js";
import { THINKING_SIGNATURE_PLACEHOLDER } from "../form.js";
import { SessionWorkspaceStore, setSessionWorkspaceStore } from "../../../project-scope/session-workspace.js";
import {
  buildInstallCommand,
  EXIT_LABEL,
  GATE_FORM_PREFIX,
  GATE_INSTALL_PREFIX,
  GATE_TEXT_MARKER,
  INSTALL_LABEL,
  resetHookGateCache,
  runHookGate,
  stripGateTurns,
  type HookGateParams,
  type HookGateResult,
} from "../hook-gate.js";

const SID = "11111111-2222-3333-4444-555555555555";
const ORIGIN = "http://127.0.0.1:8096";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T00:00:00.000Z"));
  resetHookGateCache();
  setSessionWorkspaceStore(new SessionWorkspaceStore(new MemoryStorage()));
});

afterEach(() => {
  vi.useRealTimers();
  setSessionWorkspaceStore(null);
});

const tool = (name: string) => ({ name, input_schema: { type: "object" } });
const prompt = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const formCall = { role: "assistant", content: [
  { type: "thinking", thinking: "", signature: THINKING_SIGNATURE_PLACEHOLDER },
  { type: "tool_use", id: `${GATE_FORM_PREFIX}1`, name: "AskUserQuestion", input: {} },
] };
const answer = (label: string) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: `${GATE_FORM_PREFIX}1`, content: `Your questions have been answered: "Install the hook?"="${label}".` }],
});
const installCall = { role: "assistant", content: [
  { type: "tool_use", id: `${GATE_INSTALL_PREFIX}2`, name: "Bash", input: { command: "x" } },
] };
const installResult = { role: "user", content: [{ type: "tool_result", tool_use_id: `${GATE_INSTALL_PREFIX}2`, content: "installed" }] };

function params(overrides: Partial<HookGateParams> = {}, body: Record<string, unknown> = {}): HookGateParams {
  return {
    config: { hookGate: { enabled: true } } as unknown as HookGateParams["config"],
    agentSource: "claude-code",
    memoryTurn: true,
    path: "/claude-code/default/v1/messages",
    headers: { "x-claude-code-session-id": SID },
    body: { stream: true, tools: [tool("Bash"), tool("AskUserQuestion")], messages: [prompt("hello")], ...body },
    spaceId: "default",
    userId: "usr-1",
    modelId: "test-model",
    origin: ORIGIN,
    waitMs: 0,
    ...overrides,
  };
}

async function wire(result: HookGateResult): Promise<string> {
  if (result.action !== "respond") return `pass:${result.reason}`;
  return `respond:${result.reason}\n${result.response.status} ${result.response.headers.get("content-type")}\n${await result.response.text()}`;
}

describe("Claude Code gate wire output", () => {
  it("install command", () => {
    expect(buildInstallCommand(ORIGIN, SID)).toMatchSnapshot();
  });

  it("form", async () => {
    expect(await wire(await runHookGate(params()))).toMatchSnapshot();
  });

  it("form retry", async () => {
    const other = { role: "user", content: [{ type: "tool_result", tool_use_id: `${GATE_FORM_PREFIX}1`, content: "maybe" }] };
    expect(await wire(await runHookGate(params({}, { messages: [prompt("hello"), formCall, other] })))).toMatchSnapshot();
  });

  it("install call", async () => {
    expect(await wire(await runHookGate(params({}, { messages: [prompt("hello"), formCall, answer(INSTALL_LABEL)] })))).toMatchSnapshot();
  });

  it("exit chosen", async () => {
    expect(await wire(await runHookGate(params({}, { messages: [prompt("hello"), formCall, answer(EXIT_LABEL)] })))).toMatchSnapshot();
  });

  it("install failed", async () => {
    const messages = [prompt("hello"), formCall, answer(INSTALL_LABEL), installCall, installResult];
    expect(await wire(await runHookGate(params({}, { messages })))).toMatchSnapshot();
  });

  it("no Bash tool", async () => {
    expect(await wire(await runHookGate(params({}, { tools: [tool("AskUserQuestion")] })))).toMatchSnapshot();
  });

  it("unknown origin", async () => {
    expect(await wire(await runHookGate(params({ origin: null })))).toMatchSnapshot();
  });

  it("retry limit", async () => {
    const bad = (n: number) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: `${GATE_FORM_PREFIX}${n}`, content: "x" }] });
    const result = await runHookGate(params({}, { messages: [prompt("hello"), formCall, bad(1), formCall, bad(2)] }));
    expect(await wire(result)).toMatchSnapshot();
  });

  it("stripped body", () => {
    const body = { messages: [prompt("hello"), { role: "assistant", content: [
      { type: "thinking", thinking: "", signature: THINKING_SIGNATURE_PLACEHOLDER },
      { type: "text", text: `${GATE_TEXT_MARKER} blocked` },
    ] }, formCall, answer(INSTALL_LABEL), installCall, installResult, prompt("next")] };
    expect(JSON.stringify(stripGateTurns(body))).toMatchSnapshot();
  });
});
