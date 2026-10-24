/**
 * Codex runner: the project that the client hook reported for the session
 * reaches the L0 write, and a session without a report writes no project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../../../storage/memory-storage.js";
import { SessionWorkspaceStore, setSessionWorkspaceStore } from "../../../project-scope/session-workspace.js";
import { CORE_URL, installFetch, makeApp, makeConfig, resetPoolState } from "../../../subscription-pool/__tests__/test-harness.js";

const SESSION = "01a16c99-623a-7cc3-b2c4-91528f4f0665";

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

const delta = JSON.stringify({ type: "response.output_text.delta", delta: "done" });
const completed = JSON.stringify({
  type: "response.completed",
  response: { id: "r", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
});
// A signed-in user: the project lookup key holds this id, not "anonymous".
vi.mock("../../../auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../auth.js")>()),
  verifyUserKey: async () => ({ userId: "usr-1", rejected: false }),
}));

// Records the context that the injection pipeline receives.
const injectionContexts: Array<{ custom?: Record<string, unknown> }> = [];
vi.mock("../../../injection/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../injection/index.js")>()),
  getInjectionPipeline: () => ({
    process: async (body: unknown, ctx: { custom?: Record<string, unknown> }) => {
      injectionContexts.push(ctx);
      return body;
    },
  }),
}));

const responsesReply = () => new Response(
  `event: response.output_text.delta\ndata: ${delta}\n\nevent: response.completed\ndata: ${completed}\n\n`,
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

async function send(sessionId: string, injection = false): Promise<ReturnType<typeof installFetch>> {
  const config = makeConfig();
  config.sessionInit = { ...(config.sessionInit ?? {}), enabled: true } as typeof config.sessionInit;
  config.injection = {
    ...(config.injection ?? {}), enabled: injection, injectors: injection ? ["skill"] : [],
  } as typeof config.injection;
  config.tdai = {
    ...config.tdai, enabled: true, endpoint: CORE_URL,
    memory: { ...config.tdai.memory, enabled: true, writeL0: true, recallL1: false, injectL2L3: false },
  };
  const calls = installFetch(() => responsesReply());
  const res = await makeApp(config).request("/codex/default/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer k", "session-id": sessionId },
    body: JSON.stringify({
      model: "gpt-5-codex", stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "fix the login bug" }] }],
    }),
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
  injectionContexts.length = 0;
  const store = new SessionWorkspaceStore(new MemoryStorage());
  await store.put(
    { spaceId: "default", userId: "usr-1", agentSource: "codex", sessionId: SESSION },
    {
      sessionId: SESSION, deviceId: "d1", client: "codex", cwd: "/w", gitToplevel: "/w",
      gitRemote: "git@h:x/demo.git", projectKey: "git:h/x/demo", projectHash: "0123456789abcdef",
      projectLabel: "h/x/demo", projectName: "x/demo", hookEvent: "UserPromptSubmit", hookVersion: "1",
      reportedAt: "2026-10-24T00:00:00.000Z",
    },
  );
  setSessionWorkspaceStore(store);
});

afterEach(() => {
  setSessionWorkspaceStore(null);
  vi.unstubAllGlobals();
});

describe("codex runner session project", () => {
  it("writes the L0 turn with the project the hook reported", async () => {
    const writes = l0Writes(await send(SESSION));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.body)).toMatchObject({
      project_key: "git:h/x/demo", project_hash: "0123456789abcdef",
    });
  });

  it("writes the L0 turn without a project when the hook did not report", async () => {
    const writes = l0Writes(await send("99999999-0000-0000-0000-000000000000"));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.body)).not.toHaveProperty("project_key");
  });

  it("passes the project hash and name to the injection pipeline", async () => {
    await send(SESSION, true);
    expect(injectionContexts).toHaveLength(1);
    expect(injectionContexts[0].custom).toMatchObject({ projectHash: "0123456789abcdef", projectName: "x/demo" });
  });

  it("passes no project to the injection pipeline when the hook did not report", async () => {
    await send("99999999-0000-0000-0000-000000000000", true);
    expect(injectionContexts).toHaveLength(1);
    expect(injectionContexts[0].custom?.projectHash).toBeUndefined();
    expect(injectionContexts[0].custom?.projectName).toBeUndefined();
  });
});
