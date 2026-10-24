import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryStorage } from "../../../storage/memory-storage.js";
import {
  SessionWorkspaceStore,
  setSessionWorkspaceStore,
  type SessionWorkspace,
} from "../../../project-scope/session-workspace.js";
import { GATE_TEXT_MARKER, resetHookGateCache } from "../../hook-gate-core.js";
import {
  isOmpRequest,
  OMP_GATE_CALL_PREFIX,
  runOmpHookGate,
  stripOmpGateTurns,
  type OmpGateParams,
  type OmpGateResult,
} from "../hook-gate.js";

const SID = "01a16eab-0b03-708d-8d4f-4bba152cad8e";
const ORIGIN = "http://127.0.0.1:8096";
const COMMAND = `curl -fsSL ${ORIGIN}/setup/hooks.sh | bash -s -- --client omp --session ${SID}`;
/** The hook report route stores omp reports under the route segment `pi`. */
const KEY = { spaceId: "default", userId: "usr-1", agentSource: "pi", sessionId: SID };

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
    sessionId: SID, deviceId: "d1", client: "omp", cwd: "/tmp/x", gitToplevel: null, gitRemote: null,
    projectKey: null, projectHash: null, projectLabel: null, hookEvent: "Install", hookVersion: "1",
    reportedAt: "2026-10-24T00:00:00.000Z",
  };
}

// ── Fixtures, shaped like the omp 18.6.3 captures ────────────────────────────

const fnTool = (name: string) => ({ type: "function", function: { name, parameters: { type: "object" } } });
const INTERACTIVE_TOOLS = ["read", "bash", "edit", "eval", "ask", "write"].map(fnTool);
const PRINT_TOOLS = ["read", "bash", "edit", "eval", "write"].map(fnTool);

const SYSTEM = { role: "system", content: "You are omp's trusted coding assistant." };
const PROMPT = {
  role: "user",
  content: [
    { type: "text", text: "<system-reminder>\nToday: 2026-10-24; current working directory: '/w'.\n</system-reminder>" },
    { type: "text", text: "fix the login bug" },
  ],
};
const gateCall = (id: string) => ({
  role: "assistant", content: "",
  tool_calls: [{ id: `${OMP_GATE_CALL_PREFIX}${id}`, type: "function", function: { name: "bash", arguments: "{}" } }],
});
const gateResult = (id: string, content: string) => ({ role: "tool", content, tool_call_id: `${OMP_GATE_CALL_PREFIX}${id}` });
const gateText = (text = "not installed") => ({ role: "assistant", content: `${GATE_TEXT_MARKER} ${text}` });
const OK = "Agent-Memory hooks installed.\n\nWall time: 3.2 seconds";

function params(overrides: Partial<OmpGateParams> = {}, body: Record<string, unknown> = {}): OmpGateParams {
  return {
    config: { hookGate: { enabled: true } },
    path: "/pi/default/v1/chat/completions",
    headers: { "user-agent": "omp/18.6.3" },
    body: { stream: true, tools: INTERACTIVE_TOOLS, messages: [SYSTEM, PROMPT], ...body },
    sessionId: SID,
    spaceId: "default",
    userId: "usr-1",
    modelId: "test-model",
    origin: ORIGIN,
    waitMs: 0,
    ...overrides,
  };
}

/** The JSON chunks of an SSE answer. */
async function chunks(result: OmpGateResult): Promise<Array<Record<string, any>>> {
  if (result.action !== "respond") throw new Error(`expected respond, got pass (${result.reason})`);
  const text = await result.response.text();
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  return text.split("\n\n").filter((b) => b.startsWith("data: {")).map((b) => JSON.parse(b.slice(6)));
}

// ── Detection ────────────────────────────────────────────────────────────────

describe("runOmpHookGate: which requests are gated", () => {
  it("gates a terminal omp session (ask and bash offered)", async () => {
    expect(await runOmpHookGate(params())).toMatchObject({ action: "respond", reason: "install-requested" });
  });

  it("reads tool names from the flat shape too", async () => {
    const flat = [{ name: "bash" }, { name: "ask" }];
    expect(await runOmpHookGate(params({}, { tools: flat }))).toMatchObject({ action: "respond" });
  });

  const passes: Array<[string, Partial<OmpGateParams>, Record<string, unknown>, string]> = [
    ["omp -p (no ask tool)", {}, { tools: PRINT_TOOLS }, "non-interactive"],
    ["a request without bash", {}, { tools: ["ask", "read"].map(fnTool) }, "non-interactive"],
    ["a request without tools", {}, { tools: undefined }, "non-interactive"],
    ["a request that does not stream", {}, { stream: false }, "non-interactive"],
    ["plain pi", { headers: { "user-agent": "OpenAI/JS 6.26.0" } }, {}, "not-omp"],
    ["a request without User-Agent", { headers: {} }, {}, "not-omp"],
    ["another route", { path: "/pi/default/cost-guard/v1/chat/completions" }, {}, "other-route"],
    ["a request without a session id", { sessionId: null }, {}, "no-session-id"],
    ["a session id that is not safe for a shell", { sessionId: "a; rm -rf ~" }, {}, "no-session-id"],
    ["a disabled gate", { config: { hookGate: { enabled: false } } }, {}, "disabled"],
  ];
  for (const [name, overrides, body, reason] of passes) {
    it(`passes ${name}`, async () => {
      expect(await runOmpHookGate(params(overrides, body))).toMatchObject({ action: "pass", reason });
    });
  }

  it("recognises omp by User-Agent", () => {
    expect(isOmpRequest({ "user-agent": "omp/18.12.6" })).toBe(true);
    expect(isOmpRequest({ "user-agent": "OpenAI/JS 6.26.0" })).toBe(false);
    expect(isOmpRequest({})).toBe(false);
  });

  it("passes when the session has a report under the pi route key", async () => {
    await store.put(KEY, report());
    expect(await runOmpHookGate(params())).toMatchObject({ action: "pass", reason: "installed" });
  });

  it("does not take a report that is stored under another agent source", async () => {
    await store.put({ ...KEY, agentSource: "omp" }, report());
    expect((await runOmpHookGate(params())).action).toBe("respond");
  });

  it("passes when the report lookup fails", async () => {
    store.get = async () => { throw new Error("storage down"); };
    expect(await runOmpHookGate(params())).toMatchObject({ action: "pass", reason: "lookup-failed" });
  });
});

// ── Install call ─────────────────────────────────────────────────────────────

describe("runOmpHookGate: install call", () => {
  it("answers with a bash tool call that runs the installer, as chat completion chunks", async () => {
    const cs = await chunks(await runOmpHookGate(params()));
    const first = cs[0].choices[0].delta.tool_calls[0];
    expect(first).toMatchObject({ index: 0, type: "function", function: { name: "bash", arguments: "" } });
    expect(first.id.startsWith(OMP_GATE_CALL_PREFIX)).toBe(true);
    const args = JSON.parse(cs[1].choices[0].delta.tool_calls[0].function.arguments);
    expect(args).toEqual({ command: COMMAND, i: expect.any(String) });
    expect(cs.at(-1)!.choices[0].finish_reason).toBe("tool_calls");
    expect(cs.every((c) => c.object === "chat.completion.chunk" && c.model === "test-model")).toBe(true);
  });

  it("answers with text only when the origin is unknown", async () => {
    const cs = await chunks(await runOmpHookGate(params({ origin: null })));
    expect(cs[0].choices[0].delta.content).toContain(GATE_TEXT_MARKER);
    expect(cs[0].choices[0].delta.content).not.toContain("curl -fsSL");
    expect(cs.at(-1)!.choices[0].finish_reason).toBe("stop");
  });
});

// ── Results ──────────────────────────────────────────────────────────────────

describe("runOmpHookGate: install result", () => {
  const afterInstall = [SYSTEM, PROMPT, gateCall("1"), gateResult("1", OK)];

  it("forwards the original prompt without the synthetic turns once the report exists", async () => {
    await store.put(KEY, report());
    const result = await runOmpHookGate(params({}, { messages: afterInstall }));
    expect(result.action).toBe("pass");
    if (result.action === "pass") expect(result.body.messages).toEqual([SYSTEM, PROMPT]);
  });

  it("waits for a report that arrives shortly after the tool result", async () => {
    setTimeout(() => { void store.put(KEY, report()); }, 100);
    const result = await runOmpHookGate(params({ waitMs: 2000 }, { messages: afterInstall }));
    expect(result).toMatchObject({ action: "pass", reason: "installed-in-session" });
    if (result.action === "pass") expect(result.body.messages).toEqual([SYSTEM, PROMPT]);
  });

  it("answers with the manual command when no report arrives", async () => {
    const result = await runOmpHookGate(params({ waitMs: 50 }, { messages: afterInstall }));
    expect(result).toMatchObject({ action: "respond", reason: "install-failed" });
    expect((await chunks(result))[0].choices[0].delta.content).toContain(COMMAND);
  });

  it("answers at once when the command was refused", async () => {
    const refused = [SYSTEM, PROMPT, gateCall("1"), gateResult("1", "Tool call denied by the user")];
    const started = Date.now();
    const result = await runOmpHookGate(params({ waitMs: 5000 }, { messages: refused }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ action: "respond", reason: "install-rejected" });
  });

  it("looks for the report before it trusts a refusal wording in the output", async () => {
    arriveAfterFirstLookup();
    const out = "curl: permission denied (ignored)\nAgent-Memory hooks installed";
    const result = await runOmpHookGate(params({}, { messages: [SYSTEM, PROMPT, gateCall("1"), gateResult("1", out)] }));
    expect(result).toMatchObject({ action: "pass", reason: "installed-in-session" });
  });

  it("asks again on the prompt after the failure text, then passes after two failed attempts (fail open)", async () => {
    const failed = (n: string) => [gateCall(n), gateResult(n, "curl: (7) Failed to connect"), gateText()];
    const second = await runOmpHookGate(params({}, { messages: [SYSTEM, PROMPT, ...failed("1"), PROMPT] }));
    expect(second).toMatchObject({ action: "respond", reason: "install-requested" });

    const messages = [SYSTEM, PROMPT, ...failed("1"), PROMPT, ...failed("2"), PROMPT];
    const third = await runOmpHookGate(params({}, { messages }));
    expect(third).toMatchObject({ action: "pass", reason: "retry-limit" });
    if (third.action === "pass") expect(third.body.messages).toEqual([SYSTEM, PROMPT, PROMPT, PROMPT]);
  });
});

// ── Stripping ────────────────────────────────────────────────────────────────

describe("stripOmpGateTurns", () => {
  it("returns the same body when there is nothing to remove", () => {
    const body = { messages: [SYSTEM, PROMPT] };
    expect(stripOmpGateTurns(body)).toBe(body);
    expect(stripOmpGateTurns({})).toEqual({});
  });

  it("removes the assistant call, the tool message and the text answers", () => {
    const reply = { role: "assistant", content: "real answer" };
    const body = { messages: [SYSTEM, PROMPT, gateCall("1"), gateResult("1", OK), gateText(), reply] };
    expect(stripOmpGateTurns(body).messages).toEqual([SYSTEM, PROMPT, reply]);
  });

  it("keeps the other tool calls of an assistant message that also holds a gate call", () => {
    const own = { id: "call_own", type: "function", function: { name: "read", arguments: "{}" } };
    const mixed = { role: "assistant", content: "", tool_calls: [gateCall("1").tool_calls[0], own] };
    expect(stripOmpGateTurns({ messages: [mixed] }).messages).toEqual([{ role: "assistant", content: "", tool_calls: [own] }]);
  });

  it("keeps calls and results of the model", () => {
    const own = { role: "assistant", content: "", tool_calls: [{ id: "call_x", type: "function", function: { name: "bash", arguments: "{}" } }] };
    const body = { messages: [SYSTEM, PROMPT, own, { role: "tool", content: "ok", tool_call_id: "call_x" }] };
    expect(stripOmpGateTurns(body)).toBe(body);
  });

  it("does not remove an assistant reply with tool calls that starts with the marker", () => {
    const quote = { role: "assistant", content: `${GATE_TEXT_MARKER} quoted`, tool_calls: [{ id: "call_y", type: "function", function: { name: "read", arguments: "{}" } }] };
    const body = { messages: [PROMPT, quote] };
    expect(stripOmpGateTurns(body)).toBe(body);
  });
});

describe("runOmpHookGate: gate turns are removed on every pass", () => {
  const withGateTurns = [SYSTEM, PROMPT, gateCall("1"), gateResult("1", OK)];
  const cases: Array<[string, Partial<OmpGateParams>, Record<string, unknown>]> = [
    ["the gate is switched off", { config: { hookGate: { enabled: false } } }, {}],
    ["the run is omp -p", {}, { tools: PRINT_TOOLS }],
    ["the client is plain pi", { headers: { "user-agent": "OpenAI/JS 6.26.0" } }, {}],
    ["the request has no session id", { sessionId: null }, {}],
    ["the request does not stream", {}, { stream: false }],
  ];
  for (const [name, overrides, extra] of cases) {
    it(`strips when ${name}`, async () => {
      const result = await runOmpHookGate(params(overrides, { messages: withGateTurns, ...extra }));
      expect(result.action).toBe("pass");
      if (result.action === "pass") expect(result.body.messages).toEqual([SYSTEM, PROMPT]);
    });
  }
});
