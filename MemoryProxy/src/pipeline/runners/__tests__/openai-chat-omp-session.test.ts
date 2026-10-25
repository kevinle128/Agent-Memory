/**
 * OpenAI-chat runner: the omp agent takes its session key from the session id
 * header that omp sends, so the key joins the workspace the omp extension
 * reported. Other agents do not read that header.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../../../storage/memory-storage.js";
import { SessionWorkspaceStore, setSessionWorkspaceStore } from "../../../project-scope/session-workspace.js";
import { runOpenaiChatPipeline } from "../openai-chat.js";
import { CORE_URL, installFetch, jsonResponse, makeConfig, resetPoolState } from "../../../subscription-pool/__tests__/test-harness.js";

const SESSION = "01a16c9a-989c-730e-b265-ca0e2582933c";

vi.mock("../../../auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../auth.js")>()),
  verifyUserKey: async () => ({ userId: "usr-1", rejected: false }),
}));

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

const chatReply = () => jsonResponse({
  id: "c1", object: "chat.completion", model: "m",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

async function send(agent: string, headers: Record<string, string>): Promise<ReturnType<typeof installFetch>> {
  const config = makeConfig();
  config.sessionInit = { ...(config.sessionInit ?? {}), enabled: true } as typeof config.sessionInit;
  config.injection = { ...(config.injection ?? {}), enabled: false } as typeof config.injection;
  config.tdai = {
    ...config.tdai, enabled: true, endpoint: CORE_URL,
    memory: { ...config.tdai.memory, enabled: true, writeL0: true, recallL1: false, injectL2L3: false },
  };
  const calls = installFetch(() => chatReply());
  const app = new Hono();
  app.post("/:agent/:spaceId/v1/chat/completions", (c) => runOpenaiChatPipeline(c, config));
  const res = await app.request(`/${agent}/default/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer k", ...headers },
    body: JSON.stringify({ model: "m", stream: false, messages: [{ role: "user", content: "fix the login bug" }] }),
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
  const store = new SessionWorkspaceStore(new MemoryStorage());
  for (const agentSource of ["omp", "opencode"]) {
    await store.put(
      { spaceId: "default", userId: "usr-1", agentSource, sessionId: SESSION },
      {
        sessionId: SESSION, deviceId: "d1", client: agentSource, cwd: "/w", gitToplevel: "/w",
        gitRemote: "git@h:x/demo.git", projectKey: "git:h/x/demo", projectHash: "0123456789abcdef",
        projectLabel: "h/x/demo", projectName: "x/demo", hookEvent: "session_start", hookVersion: "1",
        reportedAt: "2026-10-24T00:00:00.000Z",
      },
    );
  }
  setSessionWorkspaceStore(store);
});

afterEach(() => {
  vi.restoreAllMocks();
  setSessionWorkspaceStore(null);
  vi.unstubAllGlobals();
});

// The session key that the runner used, from its request log line.
function usedSessionKey(log: ReturnType<typeof vi.spyOn>): string | undefined {
  for (const call of log.mock.calls) {
    const m = /^\[injection-debug\] .*? sessionKey=(\S+) /.exec(String(call[0]));
    if (m) return m[1];
  }
  return undefined;
}

describe("openai-chat runner session key for omp", () => {
  it("uses the session_id header for omp, so the L0 write carries the reported project", async () => {
    const log = vi.spyOn(console, "log");
    const writes = l0Writes(await send("omp", { session_id: SESSION }));
    expect(usedSessionKey(log)).toBe(SESSION);
    expect(writes.length).toBeGreaterThan(0);
    expect(JSON.parse(writes[0]!.body)).toMatchObject({ project_key: "git:h/x/demo", project_hash: "0123456789abcdef" });
  });

  it("uses the x-session-affinity header for omp", async () => {
    const log = vi.spyOn(console, "log");
    await send("omp", { "x-session-affinity": SESSION });
    expect(usedSessionKey(log)).toBe(SESSION);
  });

  it("falls back to the key id for omp without a session header", async () => {
    const log = vi.spyOn(console, "log");
    const writes = l0Writes(await send("omp", {}));
    expect(usedSessionKey(log)).not.toBe(SESSION);
    for (const w of writes) expect(JSON.parse(w.body)).not.toHaveProperty("project_key");
  });

  it("ignores the session_id and x-session-affinity headers for another agent", async () => {
    const log = vi.spyOn(console, "log");
    const writes = l0Writes(await send("opencode", { session_id: SESSION, "x-session-affinity": SESSION }));
    expect(usedSessionKey(log)).not.toBe(SESSION);
    for (const w of writes) expect(JSON.parse(w.body)).not.toHaveProperty("project_key");
  });
});
