/**
 * L0 write site of the Anthropic runner for Claude Code: a subagent request
 * writes nothing and stays out of the skill buffer, a lead request writes the
 * human turn with the project of the session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../../../storage/memory-storage.js";
import { SessionWorkspaceStore, setSessionWorkspaceStore } from "../../../project-scope/session-workspace.js";
import { CORE_URL, installFetch, jsonResponse, makeApp, makeConfig, resetPoolState } from "../../../subscription-pool/__tests__/test-harness.js";

const SESSION = "11111111-2222-3333-4444-555555555555";

vi.mock("../../stages/session-init-orchestrate.js", () => ({
  stageSessionInitOrchestrate: async () => ({
    proceed: true,
    response: null,
    wentThroughStateMachine: false,
    initResult: {
      intercepted: false,
      bypassed: false,
      justRegistered: false,
      sessionInfo: { team_id: "t1", user_id: "u1", agent_id: "a1", session_id: SESSION },
    },
  }),
}));

const skillTrigger = vi.fn(async () => undefined);
vi.mock("../../../skill/handler-glue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../skill/handler-glue.js")>()),
  triggerSkillExtractIfReady: (...args: unknown[]) => skillTrigger(...(args as [])),
}));

const upstreamReply = () => jsonResponse({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-4-8",
  content: [{ type: "text", text: "on it" }],
  stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
});

const marked = { type: "text", text: "fix the login bug", cache_control: { type: "ephemeral" } };
const body = {
  model: "claude-opus-4-8", max_tokens: 1000, stream: false,
  tools: [{ name: "Bash", description: "x", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: [marked] }],
};

async function send(headers: Record<string, string>): Promise<ReturnType<typeof installFetch>> {
  const config = makeConfig();
  config.sessionInit = { ...(config.sessionInit ?? {}), enabled: true } as typeof config.sessionInit;
  config.injection = { ...(config.injection ?? {}), enabled: false } as typeof config.injection;
  config.tdai = {
    ...config.tdai, enabled: true, endpoint: CORE_URL,
    memory: { ...config.tdai.memory, enabled: true, writeL0: true, recallL1: false, injectL2L3: false },
  };
  const calls = installFetch(() => upstreamReply());
  const res = await makeApp(config).request("/claude-code/default/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "k", "x-claude-code-session-id": SESSION, ...headers },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  await res.text();
  await vi.waitFor(() => expect(calls.upstreamCalls.length).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 50));
  return calls;
}

const l0Writes = (calls: ReturnType<typeof installFetch>) =>
  calls.coreCalls.filter((c) => c.url.endsWith("/v3/conversation/add"));

beforeEach(async () => {
  resetPoolState();
  skillTrigger.mockClear();
  const store = new SessionWorkspaceStore(new MemoryStorage());
  await store.put(
    { spaceId: "default", userId: "anonymous", agentSource: "claude-code", sessionId: SESSION },
    {
      sessionId: SESSION, deviceId: "d1", client: "claude-code", cwd: "/w", gitToplevel: "/w",
      gitRemote: "git@h:x/demo.git", projectKey: "git:h/x/demo", projectHash: "0123456789abcdef",
      projectLabel: "h/x/demo", hookEvent: "UserPromptSubmit", hookVersion: "1", reportedAt: "2026-10-23T00:00:00.000Z",
    },
  );
  setSessionWorkspaceStore(store);
});

afterEach(() => {
  setSessionWorkspaceStore(null);
  vi.unstubAllGlobals();
});

describe("anthropic runner L0 write", () => {
  it("writes the human turn with project fields for a lead request", async () => {
    const calls = await send({});
    const writes = l0Writes(calls);
    expect(writes).toHaveLength(1);
    const sent = JSON.parse(writes[0]!.body);
    expect(sent).toMatchObject({ project_key: "git:h/x/demo", project_hash: "0123456789abcdef" });
    expect(sent.messages).toEqual([
      { role: "user", content: "fix the login bug" },
      { role: "assistant", content: "on it" },
    ]);
    expect(skillTrigger).toHaveBeenCalledTimes(1);
  });

  it("writes no L0 and no skill buffer for a subagent request", async () => {
    const calls = await send({ "x-claude-code-agent-id": "agent-1" });
    expect(l0Writes(calls)).toHaveLength(0);
    expect(skillTrigger).not.toHaveBeenCalled();
  });
});
