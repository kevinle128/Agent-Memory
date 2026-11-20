import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryStorage } from "../../../storage/memory-storage.js";
import {
  SessionWorkspaceStore,
  setSessionWorkspaceStore,
  type SessionWorkspace,
} from "../../../project-scope/session-workspace.js";
import { GATE_TEXT_MARKER, resetHookGateCache } from "../../hook-gate-core.js";
import {
  CODEX_GATE_CALL_PREFIX,
  CODEX_GATE_TEXT_PREFIX,
  runCodexHookGate,
  stripCodexGateTurns,
  type CodexGateParams,
  type CodexGateResult,
} from "../hook-gate.js";

const SID = "01a16d8e-4b6a-7e21-9f3c-0123456789ab";
const ORIGIN = "http://127.0.0.1:8096";
const COMMAND = `curl -fsSL ${ORIGIN}/setup/hooks.sh | bash -s -- --client codex --session ${SID}`;
const KEY = { spaceId: "default", userId: "usr-1", agentSource: "codex", sessionId: SID };

let store: SessionWorkspaceStore;

beforeEach(() => {
  resetHookGateCache();
  store = new SessionWorkspaceStore(new MemoryStorage());
  setSessionWorkspaceStore(store);
});

afterEach(() => setSessionWorkspaceStore(null));

/** The report is stored right after the first lookup, as when the installer finishes during the request. */
function arriveAfterFirstLookup(): void {
  const original = store.get.bind(store);
  let calls = 0;
  store.get = async (key) => {
    const found = await original(key);
    if (calls++ === 0) await store.put(KEY, report());
    return found;
  };
}

function report(): SessionWorkspace {
  return {
    sessionId: SID, deviceId: "d1", client: "codex", cwd: "/tmp/x", gitToplevel: null, gitRemote: null,
    projectKey: null, projectHash: null, projectLabel: null, hookEvent: "Install", hookVersion: "1",
    reportedAt: "2026-10-24T00:00:00.000Z",
  };
}

// ── Fixtures, shaped like the Codex 0.164.0 captures ─────────────────────────

const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });
const PROMPT = message("user", "fix the login bug");
const ABORTED = message("user", "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>");

const FUNCTION_TOOLS = [
  { type: "function", name: "exec_command", parameters: { type: "object" } },
  { type: "function", name: "write_stdin" },
  { type: "custom", name: "apply_patch" },
];
/** gpt-6 family: no tools[], the tools come in an additional_tools input item. */
const additionalTools = {
  type: "additional_tools", role: "developer",
  tools: [{ type: "namespace", name: "functions", tools: [
    { type: "custom", name: "exec" }, { type: "function", name: "wait" }, { type: "function", name: "request_user_input" },
  ] }],
};

const fnCall = (id: string) => ({ type: "function_call", id: `fc_${id}`, name: "exec_command", arguments: "{}", call_id: `${CODEX_GATE_CALL_PREFIX}${id}` });
const fnOut = (id: string, output: string) => ({ type: "function_call_output", id: `fco_${id}`, call_id: `${CODEX_GATE_CALL_PREFIX}${id}`, output });
const customCall = (id: string) => ({ type: "custom_tool_call", id: `ctc_${id}`, name: "exec", input: "js", call_id: `${CODEX_GATE_CALL_PREFIX}${id}` });
const customOut = (id: string, text: string) => ({
  type: "custom_tool_call_output", id: `ctco_${id}`, call_id: `${CODEX_GATE_CALL_PREFIX}${id}`,
  output: [{ type: "input_text", text: "Script completed\nOutput:\n" }, { type: "input_text", text }],
});
const gateText = (id: string) => ({
  type: "message", id: `${CODEX_GATE_TEXT_PREFIX}${id}`, role: "assistant",
  content: [{ type: "output_text", text: `${GATE_TEXT_MARKER} not installed` }],
});

const OK = "Process exited with code 0\nOutput:\nAgent-Memory hooks installed for codex";

/** The turn metadata header of a turn that the user typed, as Codex 0.164 sends it. */
const USER_TURN = JSON.stringify({ session_id: SID, thread_source: "user", agent_name: "/root" });

function params(overrides: Partial<CodexGateParams> = {}, body: Record<string, unknown> = {}): CodexGateParams {
  return {
    config: { hookGate: { enabled: true } },
    path: "/codex/default/v1/responses",
    headers: { originator: "codex-tui", "x-codex-turn-metadata": USER_TURN },
    body: { stream: true, tools: FUNCTION_TOOLS, input: [PROMPT], ...body },
    sessionId: SID,
    spaceId: "default",
    userId: "usr-1",
    modelId: "gpt-5.5",
    origin: ORIGIN,
    waitMs: 0,
    ...overrides,
  };
}

async function events(result: CodexGateResult): Promise<Array<{ type: string } & Record<string, any>>> {
  if (result.action !== "respond") throw new Error(`expected respond, got pass (${result.reason})`);
  const text = await result.response.text();
  return text.split("\n\n").filter(Boolean).map((block) => {
    const data = block.split("\n").find((l) => l.startsWith("data: "))!;
    return JSON.parse(data.slice(6));
  });
}

const doneItem = (evs: Array<{ type: string } & Record<string, any>>) => evs.find((e) => e.type === "response.output_item.done")!.item;

// ── Detection ────────────────────────────────────────────────────────────────

describe("runCodexHookGate: which requests are gated", () => {
  it("gates a terminal session that offers exec_command", async () => {
    expect(await runCodexHookGate(params())).toMatchObject({ action: "respond", reason: "install-requested" });
  });

  it("gates a terminal session of the gpt-6 family (exec in additional_tools, no tools[])", async () => {
    const result = await runCodexHookGate(params({}, { tools: undefined, input: [additionalTools, PROMPT] }));
    expect(result).toMatchObject({ action: "respond", reason: "install-requested" });
  });

  const passes: Array<[string, Partial<CodexGateParams>, Record<string, unknown>, string]> = [
    ["codex exec", { headers: { originator: "codex_exec" } }, {}, "not-tui"],
    ["an app-server host", { headers: { originator: "my_host" } }, {}, "not-tui"],
    ["a request without originator", { headers: {} }, {}, "not-tui"],
    ["a child agent (thread_source subagent, captured headers)", { headers: {
      originator: "codex-tui", "x-openai-subagent": "collab_spawn", "x-codex-parent-thread-id": SID,
      "x-codex-turn-metadata": JSON.stringify({ thread_source: "subagent", agent_name: "/root/probe" }),
    } }, {}, "not-user-turn"],
    ["a turn without metadata", { headers: { originator: "codex-tui" } }, {}, "not-user-turn"],
    ["a thread kind that is not known", { headers: { originator: "codex-tui", "x-codex-turn-metadata": JSON.stringify({ thread_source: "review" }) } }, {}, "not-user-turn"],
    ["a user turn that carries a subagent header", { headers: {
      originator: "codex-tui", "x-openai-subagent": "collab_spawn", "x-codex-turn-metadata": USER_TURN,
    } }, {}, "subagent"],
    ["a user turn that carries a parent thread header", { headers: {
      originator: "codex-tui", "x-codex-parent-thread-id": SID, "x-codex-turn-metadata": USER_TURN,
    } }, {}, "subagent"],
    ["a request without any tool", {}, { tools: [] }, "no-shell-tool"],
    ["the title request (apply_patch only)", {}, { tools: [{ type: "custom", name: "apply_patch" }] }, "no-shell-tool"],
    ["a request with a custom tool called exec_command", {}, { tools: [{ type: "custom", name: "exec_command" }] }, "no-shell-tool"],
    ["a compaction route", { path: "/codex/default/v1/responses/compact" }, {}, "other-route"],
    ["a cost-guard route", { path: "/codex/default/cost-guard/v1/responses" }, {}, "other-route"],
    ["a request without a session id", { sessionId: null }, {}, "no-session-id"],
    ["a session id that is not safe for a shell", { sessionId: "a; rm -rf ~" }, {}, "no-session-id"],
    ["a disabled gate", { config: { hookGate: { enabled: false } } }, {}, "disabled"],
  ];
  for (const [name, overrides, body, reason] of passes) {
    it(`passes ${name}`, async () => {
      expect(await runCodexHookGate(params(overrides, body))).toMatchObject({ action: "pass", reason });
    });
  }

  it("accepts the route with and without /v1", async () => {
    expect((await runCodexHookGate(params({ path: "/codex/default/responses" }))).action).toBe("respond");
  });

  it("passes when the session has a hook report", async () => {
    await store.put(KEY, report());
    expect(await runCodexHookGate(params())).toMatchObject({ action: "pass", reason: "installed" });
  });

  it("passes when the report lookup fails", async () => {
    store.get = async () => { throw new Error("storage down"); };
    expect(await runCodexHookGate(params())).toMatchObject({ action: "pass", reason: "lookup-failed" });
  });
});

// ── Call shapes ──────────────────────────────────────────────────────────────

describe("runCodexHookGate: install call", () => {
  it("answers with an escalated exec_command function call that runs the installer", async () => {
    const evs = await events(await runCodexHookGate(params()));
    const item = doneItem(evs);
    expect(item.type).toBe("function_call");
    expect(item.name).toBe("exec_command");
    expect(item.call_id.startsWith(CODEX_GATE_CALL_PREFIX)).toBe(true);
    expect(item.id.startsWith("fc_")).toBe(true);
    const args = JSON.parse(item.arguments);
    expect(args).toEqual({
      cmd: COMMAND,
      sandbox_permissions: "require_escalated",
      justification: expect.stringContaining("Agent-Memory"),
    });
    expect(evs.map((e) => e.type)).toEqual([
      "response.created", "response.in_progress", "response.output_item.added",
      "response.function_call_arguments.delta", "response.function_call_arguments.done",
      "response.output_item.done", "response.completed",
    ]);
    expect(evs.find((e) => e.type === "response.output_item.added")!.item.arguments).toBe("");
    expect(evs.at(-1)!.response.output[0].call_id).toBe(item.call_id);
  });

  it("answers with a custom exec call for the gpt-6 family; the script calls tools.exec_command with escalation", async () => {
    const result = await runCodexHookGate(params({}, { tools: undefined, input: [additionalTools, PROMPT] }));
    const evs = await events(result);
    const item = doneItem(evs);
    expect(item.type).toBe("custom_tool_call");
    expect(item.name).toBe("exec");
    expect(item.call_id.startsWith(CODEX_GATE_CALL_PREFIX)).toBe(true);
    expect(item.id.startsWith("ctc_")).toBe(true);
    expect(item.input).toMatch(/^const r = await tools\.exec_command\(\{.*\}\); text\(r\);$/);
    const literal = /tools\.exec_command\((\{.*\})\)/.exec(item.input)![1];
    expect(JSON.parse(literal)).toEqual({
      cmd: COMMAND, sandbox_permissions: "require_escalated", justification: expect.any(String),
    });
    expect(evs.find((e) => e.type === "response.output_item.added")!.item.input).toBe("");
    expect(evs.some((e) => e.type === "response.function_call_arguments.delta")).toBe(false);
  });

  it("prefers the function call when a request offers both", async () => {
    const result = await runCodexHookGate(params({}, { input: [additionalTools, PROMPT] }));
    expect(doneItem(await events(result)).type).toBe("function_call");
  });

  it("answers with one JSON body when the request does not stream", async () => {
    const result = await runCodexHookGate(params({}, { stream: false }));
    if (result.action !== "respond") throw new Error("expected respond");
    expect(result.response.headers.get("content-type")).toBe("application/json");
    const json = await result.response.json() as { object: string; output: Array<{ type: string; name: string }> };
    expect(json.object).toBe("response");
    expect(json.output[0]).toMatchObject({ type: "function_call", name: "exec_command" });
  });

  it("answers with text only when the origin is unknown", async () => {
    const result = await runCodexHookGate(params({ origin: null }));
    const item = doneItem(await events(result));
    expect(item.type).toBe("message");
    expect(item.content[0].text).toContain(GATE_TEXT_MARKER);
    expect(item.content[0].text).not.toContain("curl -fsSL");
  });
});

// ── Results ──────────────────────────────────────────────────────────────────

describe("runCodexHookGate: install result", () => {
  it("forwards the original prompt without gate items once the report exists", async () => {
    await store.put(KEY, report());
    const input = [PROMPT, fnCall("1"), fnOut("1", OK)];
    const result = await runCodexHookGate(params({}, { input }));
    expect(result).toMatchObject({ action: "pass", reason: "installed" });
    if (result.action === "pass") expect(result.body.input).toEqual([PROMPT]);
  });

  it("waits for a report that arrives shortly after the tool result", async () => {
    setTimeout(() => { void store.put(KEY, report()); }, 100);
    const result = await runCodexHookGate(params({ waitMs: 2000 }, { input: [PROMPT, fnCall("1"), fnOut("1", OK)] }));
    expect(result).toMatchObject({ action: "pass", reason: "installed-in-session" });
    if (result.action === "pass") expect(result.body.input).toEqual([PROMPT]);
  });

  it("answers with the manual command when no report arrives", async () => {
    const result = await runCodexHookGate(params({ waitMs: 50 }, { input: [PROMPT, fnCall("1"), fnOut("1", OK)] }));
    expect(result).toMatchObject({ action: "respond", reason: "install-failed" });
    const item = doneItem(await events(result));
    expect(item.id.startsWith(CODEX_GATE_TEXT_PREFIX)).toBe(true);
    expect(item.content[0].text).toContain(COMMAND);
  });

  it("answers at once, without waiting, when the command was rejected by the approval policy", async () => {
    const out = "approval policy is Never; reject command — you cannot ask for escalated permissions";
    const started = Date.now();
    const result = await runCodexHookGate(params({ waitMs: 5000 }, { input: [PROMPT, fnCall("1"), fnOut("1", out)] }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ action: "respond", reason: "install-rejected" });
    expect((await events(result)).find((e) => e.type === "response.output_text.delta")!.delta).toContain(COMMAND);
  });

  it("looks for the report before it trusts a refusal wording in the output", async () => {
    arriveAfterFirstLookup();
    const out = "git: warning: permission denied reading ~/.gitconfig\nAgent-Memory hooks installed";
    const result = await runCodexHookGate(params({}, { input: [PROMPT, fnCall("1"), fnOut("1", out)] }));
    expect(result).toMatchObject({ action: "pass", reason: "installed-in-session" });
  });

  it("reads the array output of a custom tool result", async () => {
    await store.put(KEY, report());
    const result = await runCodexHookGate(params({}, { tools: undefined, input: [additionalTools, PROMPT, customCall("1"), customOut("1", "x")] }));
    expect(result).toMatchObject({ action: "pass" });
    if (result.action === "pass") expect(result.body.input).toEqual([additionalTools, PROMPT]);
  });

  it("answers with text when the user refused the command in the approval screen", async () => {
    // Esc leaves: the aborted result, the interrupt marker, and then the next prompt of the user.
    const input = [PROMPT, fnCall("1"), fnOut("1", "Wall time: 6.0 seconds\naborted by user"), ABORTED, message("user", "hello?")];
    const result = await runCodexHookGate(params({}, { input }));
    expect(result).toMatchObject({ action: "respond", reason: "install-rejected" });
  });

  it("asks again on the prompt after the failure text, then stops after two failed attempts", async () => {
    const failed = fnOut("1", "Process exited with code 1");
    const second = await runCodexHookGate(params({}, { input: [PROMPT, fnCall("1"), failed, gateText("1"), message("user", "again")] }));
    expect(second).toMatchObject({ action: "respond", reason: "install-requested" });

    const input = [PROMPT, fnCall("1"), failed, gateText("1"), message("user", "again"), fnCall("2"), fnOut("2", "Process exited with code 1"), gateText("2"), message("user", "third")];
    const third = await runCodexHookGate(params({}, { input }));
    expect(third).toMatchObject({ action: "pass", reason: "retry-limit" });
    if (third.action === "pass") expect(third.body.input).toEqual([PROMPT, message("user", "again"), message("user", "third")]);
  });
});

// ── Stripping ────────────────────────────────────────────────────────────────

describe("stripCodexGateTurns", () => {
  it("returns the same body when there is nothing to remove", () => {
    const body = { input: [PROMPT, message("assistant", "hi")] };
    expect(stripCodexGateTurns(body)).toBe(body);
    expect(stripCodexGateTurns({})).toEqual({});
  });

  it("removes a function call, its output and the turn_aborted message that follows", () => {
    const next = message("user", "next");
    const body = { input: [PROMPT, fnCall("1"), fnOut("1", "aborted by user"), ABORTED, next] };
    expect(stripCodexGateTurns(body).input).toEqual([PROMPT, next]);
  });

  it("removes a custom tool call and its array output", () => {
    const body = { input: [PROMPT, customCall("1"), customOut("1", "x"), message("assistant", "real")] };
    expect(stripCodexGateTurns(body).input).toEqual([PROMPT, message("assistant", "real")]);
  });

  it("removes the text answers of the gate", () => {
    expect(stripCodexGateTurns({ input: [PROMPT, gateText("1"), message("user", "x")] }).input).toEqual([PROMPT, message("user", "x")]);
  });

  it("keeps a message that holds the interrupt marker and a typed prompt", () => {
    const mixed = { type: "message", role: "user", content: [
      { type: "input_text", text: "<turn_aborted>\nx\n</turn_aborted>" }, { type: "input_text", text: "real prompt" },
    ] };
    const body = { input: [PROMPT, fnCall("1"), fnOut("1", "aborted by user"), mixed] };
    expect(stripCodexGateTurns(body).input).toEqual([PROMPT, mixed]);
  });

  it("keeps a turn_aborted message that does not follow a gate result", () => {
    const body = { input: [PROMPT, ABORTED] };
    expect(stripCodexGateTurns(body)).toBe(body);
  });

  it("keeps calls of the model, also with the same name", () => {
    const own = { type: "function_call", id: "fc_x", name: "exec_command", arguments: "{}", call_id: "call_abc" };
    const ownOut = { type: "function_call_output", call_id: "call_abc", output: "ok" };
    const body = { input: [PROMPT, own, ownOut] };
    expect(stripCodexGateTurns(body)).toBe(body);
  });

  it("does not remove an assistant reply that only quotes the marker", () => {
    const quote = { type: "message", id: "msg_real", role: "assistant", content: [{ type: "output_text", text: `${GATE_TEXT_MARKER} quoted` }] };
    const body = { input: [PROMPT, quote] };
    expect(stripCodexGateTurns(body)).toBe(body);
  });
});

describe("runCodexHookGate: gate items are removed on every pass", () => {
  const withGateItems = [PROMPT, fnCall("1"), fnOut("1", "aborted by user"), ABORTED, message("user", "next")];
  const expected = [PROMPT, message("user", "next")];
  const cases: Array<[string, Partial<CodexGateParams>, Record<string, unknown>]> = [
    ["the gate is switched off", { config: { hookGate: { enabled: false } } }, {}],
    ["the client is codex exec", { headers: { originator: "codex_exec" } }, {}],
    ["the request offers no shell tool", {}, { tools: [] }],
    ["the route is not gated", { path: "/codex/default/v1/responses/compact" }, {}],
    ["the request has no session id", { sessionId: null }, {}],
  ];
  for (const [name, overrides, extra] of cases) {
    it(`strips when ${name}`, async () => {
      const result = await runCodexHookGate(params(overrides, { input: withGateItems, ...extra }));
      expect(result.action).toBe("pass");
      if (result.action === "pass") expect(result.body.input).toEqual(expected);
    });
  }
});
