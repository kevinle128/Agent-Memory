import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../../storage/memory-storage.js";
import { TdaiClient } from "../../tdai/client.js";
import type { TdaiIdentity } from "../../tdai/types.js";
import {
  SessionWorkspaceStore,
  setSessionWorkspaceStore,
  withSessionProject,
  type SessionWorkspace,
} from "../session-workspace.js";

const key = { spaceId: "default", userId: "usr-1", agentSource: "claude-code", sessionId: "s1" };
const identity: TdaiIdentity = { teamId: "t1", userId: "usr-1", agentId: "a1", sessionId: "s1" };

function workspace(overrides: Partial<SessionWorkspace> = {}): SessionWorkspace {
  return {
    sessionId: "s1",
    deviceId: "d1",
    client: "claude-code",
    cwd: "/Users/dale/src/demo",
    gitToplevel: "/Users/dale/src/demo",
    gitRemote: "git@h:x/demo.git",
    projectKey: "git:h/x/demo",
    projectHash: "0123456789abcdef",
    projectLabel: "h/x/demo",
    hookEvent: "UserPromptSubmit",
    hookVersion: "1",
    reportedAt: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

let store: SessionWorkspaceStore;

beforeEach(() => {
  store = new SessionWorkspaceStore(new MemoryStorage());
  setSessionWorkspaceStore(store);
});

afterEach(() => {
  setSessionWorkspaceStore(null);
  vi.unstubAllGlobals();
});

describe("withSessionProject", () => {
  it("adds the reported project to the identity", async () => {
    await store.put(key, workspace());
    expect(await withSessionProject(identity, {}, key)).toEqual({
      ...identity,
      projectKey: "git:h/x/demo",
      projectHash: "0123456789abcdef",
    });
  });

  it("adds the project name when the report has one", async () => {
    await store.put(key, workspace({ projectName: "x/demo" }));
    expect(await withSessionProject(identity, {}, key)).toMatchObject({ projectHash: "0123456789abcdef", projectName: "x/demo" });
  });

  it("omits the project name for a report stored before the field existed", async () => {
    await store.put(key, workspace());
    expect(await withSessionProject(identity, {}, key)).not.toHaveProperty("projectName");
  });

  it("keeps the identity unchanged when the hook has not reported", async () => {
    expect(await withSessionProject(identity, {}, key)).toBe(identity);
  });

  it("keeps the identity unchanged when the report has no project", async () => {
    await store.put(key, workspace({ projectKey: null, projectHash: null, gitRemote: null, gitToplevel: null }));
    expect(await withSessionProject(identity, {}, key)).toBe(identity);
  });

  it("does not use a report of another session", async () => {
    await store.put({ ...key, sessionId: "other" }, workspace({ sessionId: "other" }));
    expect(await withSessionProject(identity, {}, key)).toBe(identity);
  });

  it("returns null for a null identity", async () => {
    expect(await withSessionProject(null, {}, key)).toBeNull();
  });

  it("keeps the identity unchanged when the lookup fails", async () => {
    vi.spyOn(store, "get").mockRejectedValueOnce(new Error("storage down"));
    expect(await withSessionProject(identity, {}, key)).toBe(identity);
  });
});

describe("TdaiClient.addConversation project fields", () => {
  const client = () =>
    new TdaiClient({
      enabled: true,
      endpoint: "http://core.test",
      apiKey: "k",
      serviceId: "default",
      writeL0: true,
      recallL1: false,
      injectL2L3: false,
      l1Limit: 5,
      l2Limit: 3,
      timeoutMs: 1000,
    });

  function captureBody(): { bodies: Array<Record<string, unknown>> } {
    const out = { bodies: [] as Array<Record<string, unknown>> };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      out.bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ code: 0, data: {} }));
    }));
    return out;
  }

  it("sends project_key and project_hash when the identity has a project", async () => {
    const cap = captureBody();
    await client().addConversation(
      { ...identity, projectKey: "git:h/x/demo", projectHash: "0123456789abcdef" },
      [{ role: "user", content: "hi" }],
    );
    expect(cap.bodies[0]).toMatchObject({ project_key: "git:h/x/demo", project_hash: "0123456789abcdef" });
  });

  it("sends project_name with the project fields only when the identity has one", async () => {
    const cap = captureBody();
    const withProject = { ...identity, projectKey: "git:h/x/demo", projectHash: "0123456789abcdef" };
    await client().addConversation({ ...withProject, projectName: "x/demo" }, [{ role: "user", content: "hi" }]);
    await client().addConversation(withProject, [{ role: "user", content: "hi" }]);
    expect(cap.bodies[0]).toMatchObject({ project_name: "x/demo" });
    expect(cap.bodies[1]).not.toHaveProperty("project_name");
  });

  it("sends no project fields when the identity has no project", async () => {
    const cap = captureBody();
    await client().addConversation(identity, [{ role: "user", content: "hi" }]);
    expect(cap.bodies[0]).not.toHaveProperty("project_key");
    expect(cap.bodies[0]).not.toHaveProperty("project_hash");
    expect(cap.bodies[0]).not.toHaveProperty("project_name");
  });
});
