import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryStorage } from "../../../storage/memory-storage.js";
import { THINKING_SIGNATURE_PLACEHOLDER } from "../form.js";
import {
  SessionWorkspaceStore,
  setSessionWorkspaceStore,
  type SessionWorkspace,
} from "../../../project-scope/session-workspace.js";
import {
  buildInstallCommand,
  EXIT_LABEL,
  GATE_FORM_PREFIX,
  GATE_INSTALL_PREFIX,
  GATE_TEXT_MARKER,
  INSTALL_LABEL,
  resetHookGateCache,
  resolveProxyOrigin,
  runHookGate,
  stripGateTurns,
  type HookGateParams,
  type HookGateResult,
} from "../hook-gate.js";

const SID = "11111111-2222-3333-4444-555555555555";
const ORIGIN = "http://127.0.0.1:8096";
const COMMAND = `curl -fsSL ${ORIGIN}/setup/hooks.sh | bash -s -- --client claude-code --session ${SID}`;
const KEY = { spaceId: "default", userId: "usr-1", agentSource: "claude-code", sessionId: SID };

let store: SessionWorkspaceStore;

beforeEach(() => {
  resetHookGateCache();
  store = new SessionWorkspaceStore(new MemoryStorage());
  setSessionWorkspaceStore(store);
});

afterEach(() => {
  setSessionWorkspaceStore(null);
});

function report(overrides: Partial<SessionWorkspace> = {}): SessionWorkspace {
  return {
    sessionId: SID, deviceId: "d1", client: "claude-code", cwd: "/tmp/x", gitToplevel: null, gitRemote: null,
    projectKey: null, projectHash: null, projectLabel: null, hookEvent: "Install", hookVersion: "1",
    reportedAt: "2026-10-24T00:00:00.000Z", ...overrides,
  };
}

const tool = (name: string) => ({ name, input_schema: { type: "object" } });
const INTERACTIVE_TOOLS = [tool("Bash"), tool("Read"), tool("AskUserQuestion")];

/** An assistant text turn as the gate emits it: placeholder thinking block, then the marked text. */
const gateText = (text: string) => ({ role: "assistant", content: [
  { type: "thinking", thinking: "", signature: THINKING_SIGNATURE_PLACEHOLDER },
  { type: "text", text: `${GATE_TEXT_MARKER} ${text}` },
] });
const prompt = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const formCall = { role: "assistant", content: [
  { type: "thinking", thinking: "", signature: THINKING_SIGNATURE_PLACEHOLDER },
  { type: "tool_use", id: `${GATE_FORM_PREFIX}1`, name: "AskUserQuestion", input: {} },
] };
const answer = (label: string, id = `${GATE_FORM_PREFIX}1`) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: `Your questions have been answered: "Install the hook?"="${label}". You can now continue with these answers in mind.` }],
});
const installCall = { role: "assistant", content: [
  { type: "thinking", thinking: "", signature: THINKING_SIGNATURE_PLACEHOLDER },
  { type: "tool_use", id: `${GATE_INSTALL_PREFIX}2`, name: "Bash", input: { command: COMMAND } },
] };
/** Claude Code appends a system message after the tool results. */
const trailingSystem = { role: "system", content: "<total_tokens>15000000 tokens left</total_tokens>" };
const installResult = { role: "user", content: [{ type: "tool_result", tool_use_id: `${GATE_INSTALL_PREFIX}2`, content: "installed" }] };

/** The gate reads only these two config sections; storage stays unset so the shared in-memory store is used. */
function gateConfig(enabled: boolean): HookGateParams["config"] {
  return { hookGate: { enabled } } as unknown as HookGateParams["config"];
}

function params(overrides: Partial<HookGateParams> = {}, body: Record<string, unknown> = {}): HookGateParams {
  return {
    config: gateConfig(true),
    agentSource: "claude-code",
    memoryTurn: true,
    path: "/claude-code/default/v1/messages",
    headers: { "x-claude-code-session-id": SID },
    body: { stream: true, tools: INTERACTIVE_TOOLS, messages: [prompt("hello")], ...body },
    spaceId: "default",
    userId: "usr-1",
    modelId: "test-model",
    origin: ORIGIN,
    waitMs: 0,
    ...overrides,
  };
}

async function sse(result: HookGateResult): Promise<string> {
  if (result.action !== "respond") throw new Error(`expected respond, got pass (${result.reason})`);
  return result.response.text();
}

/** The tool_use block of a synthetic answer, parsed from its SSE stream. */
function toolUseOf(stream: string): { name: string; id: string; input: Record<string, unknown> } {
  const start = /"content_block":\{"type":"tool_use","id":"([^"]+)","name":"([^"]+)"/.exec(stream);
  const delta = /"partial_json":"((?:[^"\\]|\\.)*)"/.exec(stream);
  if (!start || !delta) throw new Error("no tool_use in stream");
  return { id: start[1], name: start[2], input: JSON.parse(JSON.parse(`"${delta[1]}"`)) };
}

describe("runHookGate: requests that pass", () => {
  it("passes when the session has a hook report", async () => {
    await store.put(KEY, report());
    const result = await runHookGate(params());
    expect(result).toMatchObject({ action: "pass", reason: "installed" });
  });

  it("counts a report without a project as installed", async () => {
    await store.put(KEY, report({ projectKey: null, projectHash: null, gitToplevel: null }));
    expect((await runHookGate(params())).action).toBe("pass");
  });

  it("passes a headless run: no form tool in the request", async () => {
    const result = await runHookGate(params({}, { tools: [tool("Bash"), tool("Read")] }));
    expect(result).toMatchObject({ action: "pass", reason: "non-interactive" });
  });

  it("passes a request that does not stream", async () => {
    const result = await runHookGate(params({}, { stream: false }));
    expect(result).toMatchObject({ action: "pass", reason: "non-interactive" });
  });

  it("passes a request without tools (title and model probe)", async () => {
    const result = await runHookGate(params({}, { tools: [], max_tokens: 1 }));
    expect(result.action).toBe("pass");
  });

  it("passes a subagent request", async () => {
    const result = await runHookGate(params({ headers: { "x-claude-code-session-id": SID, "x-claude-code-agent-id": "agent-1" } }));
    expect(result).toMatchObject({ action: "pass", reason: "subagent" });
  });

  it("passes a request that is not on the main line", async () => {
    expect(await runHookGate(params({ memoryTurn: false }))).toMatchObject({ action: "pass", reason: "not-main-line" });
  });

  it("passes other clients", async () => {
    expect(await runHookGate(params({ agentSource: "codex" }))).toMatchObject({ action: "pass", reason: "not-claude-code" });
  });

  it("passes a request without a session id", async () => {
    expect(await runHookGate(params({ headers: {} }))).toMatchObject({ action: "pass", reason: "no-session-id" });
  });

  it("passes when the gate is disabled, even without a report", async () => {
    const result = await runHookGate(params({ config: gateConfig(false) }));
    expect(result).toMatchObject({ action: "pass", reason: "disabled" });
  });

  it("passes when the report lookup fails", async () => {
    store.get = async () => { throw new Error("storage down"); };
    expect(await runHookGate(params())).toMatchObject({ action: "pass", reason: "lookup-failed" });
  });
});

describe("runHookGate: install form", () => {
  it("asks once with Install now and Exit", async () => {
    const result = await runHookGate(params());
    const stream = await sse(result);
    const call = toolUseOf(stream);
    expect(call.name).toBe("AskUserQuestion");
    expect(call.id.startsWith(GATE_FORM_PREFIX)).toBe(true);
    const questions = call.input.questions as Array<{ options: Array<{ label: string }>; multiSelect: boolean }>;
    expect(questions).toHaveLength(1);
    expect(questions[0].options.map((o) => o.label)).toEqual([INSTALL_LABEL, EXIT_LABEL]);
    expect(questions[0].multiSelect).toBe(false);
    expect(stream).toContain('"stop_reason":"tool_use"');
  });

  it("reads the answer when a system message follows the tool result", async () => {
    const result = await runHookGate(params({}, { messages: [prompt("hello"), formCall, answer(INSTALL_LABEL), trailingSystem] }));
    expect(toolUseOf(await sse(result)).name).toBe("Bash");
  });

  it("answers Install now with a Bash call that installs and reports the session", async () => {
    const result = await runHookGate(params({}, { messages: [prompt("hello"), formCall, answer(INSTALL_LABEL)] }));
    const call = toolUseOf(await sse(result));
    expect(call.name).toBe("Bash");
    expect(call.id.startsWith(GATE_INSTALL_PREFIX)).toBe(true);
    expect(call.input.command).toBe(COMMAND);
  });

  it("re-asks when the answer is free text (Other)", async () => {
    const other = { role: "user", content: [{ type: "tool_result", tool_use_id: `${GATE_FORM_PREFIX}1`, content: 'User has answered your questions: "Install the hook?"="maybe later". You can now continue.' }] };
    const stream = await sse(await runHookGate(params({}, { messages: [prompt("hello"), formCall, other] })));
    const call = toolUseOf(stream);
    expect(call.name).toBe("AskUserQuestion");
    expect((call.input.questions as Array<{ question: string }>)[0].question).toMatch(/^Could not read the answer/);
  });

  it("re-asks when the form was dismissed", async () => {
    const dismissed = { role: "user", content: [{ type: "tool_result", is_error: true, tool_use_id: `${GATE_FORM_PREFIX}1`, content: "The user doesn't want to proceed with this tool use." }] };
    const call = toolUseOf(await sse(await runHookGate(params({}, { messages: [prompt("hello"), formCall, dismissed] }))));
    expect(call.name).toBe("AskUserQuestion");
  });

  it("reads a JSON answer", async () => {
    const json = { role: "user", content: [{ type: "tool_result", tool_use_id: `${GATE_FORM_PREFIX}1`, content: JSON.stringify({ answers: { q: INSTALL_LABEL } }) }] };
    const call = toolUseOf(await sse(await runHookGate(params({}, { messages: [prompt("hello"), formCall, json] }))));
    expect(call.name).toBe("Bash");
  });
});

describe("runHookGate: install result", () => {
  const afterInstall = [prompt("hello"), formCall, answer(INSTALL_LABEL), installCall, installResult, trailingSystem];

  it("forwards the original prompt without the synthetic turns when the report exists", async () => {
    await store.put(KEY, report());
    const result = await runHookGate(params({}, { messages: afterInstall }));
    expect(result.action).toBe("pass");
    if (result.action !== "pass") return;
    expect(result.body.messages).toEqual([prompt("hello"), trailingSystem]);
    expect(result.body.tools).toEqual(INTERACTIVE_TOOLS);
  });

  it("waits for a report that arrives shortly after the tool result", async () => {
    setTimeout(() => { void store.put(KEY, report()); }, 100);
    const result = await runHookGate(params({ waitMs: 2000 }, { messages: afterInstall }));
    expect(result).toMatchObject({ action: "pass" });
  });

  it("answers with the error and the manual command when no report arrives", async () => {
    const result = await runHookGate(params({ waitMs: 50 }, { messages: afterInstall }));
    const stream = await sse(result);
    expect(stream).toContain(GATE_TEXT_MARKER);
    expect(stream).toContain("did not finish");
    expect(stream).toContain("hooks.sh");
    expect(stream).toContain('"stop_reason":"end_turn"');
  });
});

describe("runHookGate: exit", () => {
  it("blocks right after Exit is chosen", async () => {
    const stream = await sse(await runHookGate(params({}, { messages: [prompt("hello"), formCall, answer(EXIT_LABEL)] })));
    expect(stream).toContain(GATE_TEXT_MARKER);
    expect(stream).toContain("does not send requests to the model");
  });

  it("blocks every later request of the session", async () => {
    const blocked = gateText("blocked");
    const result = await runHookGate(params({}, {
      messages: [prompt("hello"), formCall, answer(EXIT_LABEL), blocked, prompt("one more try")],
    }));
    expect(result).toMatchObject({ action: "respond", reason: "exited" });
  });
});

describe("runHookGate: no Bash tool", () => {
  it("answers with the install command instead of a form", async () => {
    const result = await runHookGate(params({}, { tools: [tool("Read"), tool("AskUserQuestion")] }));
    const stream = await sse(result);
    expect(stream).not.toContain("tool_use\"");
    expect(stream).toContain(GATE_TEXT_MARKER);
    expect(stream).toContain("hooks.sh");
  });

  it("answers with text only when the proxy origin is unknown", async () => {
    const result = await runHookGate(params({ origin: null }));
    const stream = await sse(result);
    expect(stream).toContain(GATE_TEXT_MARKER);
    expect(stream).not.toContain("curl -fsSL");
  });
});

describe("stripGateTurns", () => {
  it("returns the same body when there is nothing to remove", () => {
    const body = { messages: [prompt("hello")] };
    expect(stripGateTurns(body)).toBe(body);
  });

  it("removes gate turns in the middle of a longer conversation", () => {
    const reply = { role: "assistant", content: [{ type: "text", text: "real answer" }] };
    const blocked = gateText("error");
    const body = { messages: [prompt("hello"), blocked, formCall, answer(INSTALL_LABEL), installCall, installResult, reply, prompt("next")] };
    expect((stripGateTurns(body).messages as unknown[])).toEqual([prompt("hello"), reply, prompt("next")]);
  });

  it("keeps the other blocks of a user message that also holds a gate result", () => {
    const mixed = { role: "user", content: [
      { type: "tool_result", tool_use_id: `${GATE_FORM_PREFIX}1`, content: "x" },
      { type: "text", text: "extra" },
    ] };
    expect((stripGateTurns({ messages: [mixed] }).messages as unknown[])).toEqual([{ role: "user", content: [{ type: "text", text: "extra" }] }]);
  });
});

describe("install command", () => {
  it("builds the command from forwarded headers", () => {
    expect(resolveProxyOrigin({ "x-forwarded-proto": "https", "x-forwarded-host": "proxy.example.com, edge" }, "http://internal/x"))
      .toBe("https://proxy.example.com");
    expect(resolveProxyOrigin({ host: "127.0.0.1:8096" }, "http://127.0.0.1:8096/claude-code/default/v1/messages"))
      .toBe("http://127.0.0.1:8096");
  });

  it("refuses an origin that could carry shell syntax", () => {
    expect(resolveProxyOrigin({ host: "evil.com;rm -rf ~" }, "http://x/")).toBeNull();
    expect(resolveProxyOrigin({ "x-forwarded-proto": "ftp", host: "a.com" }, "http://x/")).toBeNull();
    expect(buildInstallCommand("http://a.com", "id; rm")).toBeNull();
    expect(buildInstallCommand(null, SID)).toBeNull();
  });
});

const withGateTurns = { messages: [prompt("hello"), formCall, answer(INSTALL_LABEL), installCall, installResult, trailingSystem] };

describe("runHookGate: gate turns are removed on every pass", () => {
  const cases: Array<[string, Partial<HookGateParams>, Record<string, unknown>]> = [
    ["the gate is disabled", { config: gateConfig(false) }, {}],
    ["the request is not on the main line (fork)", { memoryTurn: false }, {}],
    ["the resumed headless run has no form tool", {}, { tools: [tool("Bash")] }],
    ["the request does not stream", {}, { stream: false }],
    ["the request is from a subagent", { headers: { "x-claude-code-session-id": SID, "x-claude-code-agent-id": "a1" } }, {}],
    ["the route is not gated", { path: "/v1/messages" }, {}],
  ];
  for (const [name, overrides, extra] of cases) {
    it(`strips when ${name}`, async () => {
      const result = await runHookGate(params(overrides, { ...withGateTurns, ...extra }));
      expect(result.action).toBe("pass");
      if (result.action === "pass") expect(result.body.messages).toEqual([prompt("hello"), trailingSystem]);
    });
  }

  it("leaves the body of another client untouched", async () => {
    const body = { ...withGateTurns };
    const result = await runHookGate(params({ agentSource: "codex" }, body));
    expect(result.action === "pass" && result.body.messages).toEqual(body.messages);
  });

  it("does not strip a model reply that quotes the marker", async () => {
    const quote = { role: "assistant", content: [{ type: "text", text: `${GATE_TEXT_MARKER} you asked about this` }] };
    const real = { role: "assistant", content: [
      { type: "thinking", thinking: "x", signature: "real-signature" },
      { type: "text", text: `${GATE_TEXT_MARKER} also quoted` },
    ] };
    const body = { messages: [prompt("hello"), quote, real] };
    expect(stripGateTurns(body)).toBe(body);
  });
});

describe("runHookGate: routes", () => {
  for (const path of [
    "/v1/messages",
    "/claude-code/v1/messages",
    "/proxy/default/v1/messages",
    "/claude-code/default/cost-guard/v1/messages",
    "/claude-code/default/cost-guard/pre/v1/messages",
    "/claude-code/default/cost-guard/cheap/v1/messages",
    "/claude-code/default/analyse/v1/messages",
    "/codex/default/v1/messages",
  ]) {
    it(`passes ${path}`, async () => {
      expect(await runHookGate(params({ path }))).toMatchObject({ action: "pass" });
    });
  }

  it("gates the exact route", async () => {
    expect((await runHookGate(params({ path: "/claude-code/default/v1/messages" }))).action).toBe("respond");
  });
});

describe("runHookGate: SDK hosts and loops", () => {
  const sdk = { "x-claude-code-session-id": SID, "user-agent": "claude-cli/2.1.117 (external, sdk-ts)" };

  it("passes an SDK entrypoint even when it offers the form tool", async () => {
    expect(await runHookGate(params({ headers: sdk }))).toMatchObject({ action: "pass", reason: "sdk" });
    expect(await runHookGate(params({ headers: { ...sdk, "user-agent": "claude-cli/2.1 (external, sdk-py)" } }))).toMatchObject({ reason: "sdk" });
  });

  it("does not use the entrypoint as a reason to gate", async () => {
    const cli = { "x-claude-code-session-id": SID, "user-agent": "claude-cli/2.1.289 (external, cli)" };
    expect((await runHookGate(params({ headers: cli }))).action).toBe("respond");
    // An unknown entrypoint with no form tool still passes.
    expect((await runHookGate(params({ headers: { ...cli, "user-agent": "claude-cli/2.1 (external, claude-vscode)" } }, { tools: [tool("Bash")] }))).action).toBe("pass");
  });

  const denied = (n: number) => {
    const out: unknown[] = [prompt("hello")];
    for (let i = 1; i <= n; i++) {
      out.push({ role: "assistant", content: [{ type: "tool_use", id: `${GATE_FORM_PREFIX}${i}`, name: "AskUserQuestion", input: {} }] });
      out.push({ role: "user", content: [{ type: "tool_result", is_error: true, tool_use_id: `${GATE_FORM_PREFIX}${i}`, content: "Permission denied" }] });
    }
    return out;
  };

  it("asks again after one unreadable result", async () => {
    expect(await runHookGate(params({}, { messages: denied(1) }))).toMatchObject({ action: "respond", reason: "form-retry" });
  });

  it("stops asking after two unreadable results and forwards the stripped history", async () => {
    const result = await runHookGate(params({}, { messages: [...denied(2), prompt("next")] }));
    expect(result).toMatchObject({ action: "pass", reason: "retry-limit" });
    if (result.action === "pass") expect(result.body.messages).toEqual([prompt("hello"), prompt("next")]);
  });
});

describe("runHookGate: install result with an error", () => {
  it("answers with the manual command when the install call was denied", async () => {
    const denied = { role: "user", content: [{ type: "tool_result", is_error: true, tool_use_id: `${GATE_INSTALL_PREFIX}2`, content: "Permission to use Bash has been denied." }] };
    const result = await runHookGate(params({ waitMs: 20 }, { messages: [prompt("hello"), formCall, answer(INSTALL_LABEL), installCall, denied] }));
    expect(result).toMatchObject({ action: "respond", reason: "install-failed" });
    expect(await sse(result)).toContain("typing ! before it");
  });
});

describe("runHookGate: public origin and cache", () => {
  const body = { messages: [prompt("hello"), formCall, answer(INSTALL_LABEL)] };

  it("uses the configured public origin before the request origin", async () => {
    const config = { hookGate: { enabled: true, publicOrigin: "https://proxy.example.com/" } } as unknown as HookGateParams["config"];
    const call = toolUseOf(await sse(await runHookGate(params({ config }, body))));
    expect(call.input.command).toContain("https://proxy.example.com/setup/hooks.sh");
  });

  it("ignores a public origin that is not an origin", async () => {
    const config = { hookGate: { enabled: true, publicOrigin: "x; rm -rf ~" } } as unknown as HookGateParams["config"];
    const call = toolUseOf(await sse(await runHookGate(params({ config }, body))));
    expect(call.input.command).toContain(ORIGIN);
  });

  it("explains in the Exit text that the same session continues after the install", async () => {
    const stream = await sse(await runHookGate(params({}, { messages: [prompt("hello"), formCall, answer(EXIT_LABEL)] })));
    expect(stream).toContain("this session continues");
    expect(stream).not.toContain("start a new session");
  });

  it("caches a present report but never an absent one", async () => {
    expect((await runHookGate(params())).action).toBe("respond"); // absent
    await store.put(KEY, report());
    expect((await runHookGate(params())).action).toBe("pass"); // present now, absent was not cached
    store.get = async () => { throw new Error("must not be read"); };
    expect(await runHookGate(params())).toMatchObject({ action: "pass", reason: "installed" }); // served from the cache
  });
});
