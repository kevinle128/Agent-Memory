import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessions = vi.hoisted(() => ({ states: new Map<string, unknown>() }));

vi.mock("../../session/store.js", () => ({
  getSessionStore: () => ({
    get: (key: string) => sessions.states.get(key),
    getBindingRepo: () => undefined,
  }),
}));
vi.mock("../bridge-telemetry.js", () => ({
  emitBridgeToolCallTelemetry: vi.fn(),
  emitBridgeRejectTelemetry: vi.fn(),
  agentSourceFromSessionKey: (k: string) => k.split(":")[0],
}));

import { MemoryStorage } from "../../storage/memory-storage.js";
import { SessionWorkspaceStore, setSessionWorkspaceStore, type SessionWorkspace } from "../../project-scope/session-workspace.js";
import type { ProxyConfig } from "../../types.js";
import { createMemoryBridgeHandler } from "../memory-bridge.js";

const HASH = "aaaaaaaaaaaaaaaa";
const SESSION_ID = "sess-1";
function makeConfig(profileScopeMode?: string): ProxyConfig {
  return {
    coreSkill: { endpoint: "http://core.test", serviceToken: "t", serviceId: "default", timeoutMs: 1000 },
    tdai: { serviceId: "default", apiKey: "k", ...(profileScopeMode ? { memory: { profileScopeMode } } : {}) },
  } as unknown as ProxyConfig;
}

interface UpstreamCall { url: string; body: Record<string, unknown> }

interface FakeCoreOptions {
  /** A Core that does not know `project_hash`: it serves user-global data and does not echo the hash. */
  ignoreProjectHash?: boolean;
  /** Make the call that carries `project_hash` (or the one without it) fail. */
  failProjectCall?: "throw" | "http500";
  failGlobalCall?: "throw";
}

/** Fake Core: project scenes live under a hash, user-global ones without it. */
function fakeCore(scenes: { project: Record<string, string>; global: Record<string, string> }, opts: FakeCoreOptions = {}) {
  const calls: UpstreamCall[] = [];
  const fetcher = vi.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body });
    const isProject = Boolean(body.project_hash) && !opts.ignoreProjectHash;
    if (body.project_hash && opts.failProjectCall === "throw") throw new Error("project call timed out");
    if (body.project_hash && opts.failProjectCall === "http500") return new Response("boom", { status: 500 });
    if (!body.project_hash && opts.failGlobalCall === "throw") throw new Error("global call timed out");
    const set = isProject ? scenes.project : scenes.global;
    const echo = isProject ? { project_hash: body.project_hash } : {};
    if (url.endsWith("/v3/scenario/read")) {
      const content = set[String(body.path)];
      return Response.json({ code: 0, data: { ...(content === undefined ? { content: null } : { path: body.path, content }), ...echo } });
    }
    if (url.endsWith("/v3/scenario/ls")) {
      const entries = Object.keys(set).map((path) => ({ path, summary: `summary of ${path}` }));
      return Response.json({ code: 0, data: { entries, total: entries.length, ...echo } });
    }
    return Response.json({ code: 0, data: {} });
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

function appWith(fetcher: typeof fetch, profileScopeMode?: string): Hono {
  const app = new Hono();
  app.all("/memory-bridge/v3/*", createMemoryBridgeHandler(makeConfig(profileScopeMode), { fetcher }));
  return app;
}

async function call(app: Hono, sub: string, body: Record<string, unknown>) {
  const res = await app.request(`/memory-bridge/v3/${sub}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-conversation-id": SESSION_ID, "x-tdai-service-id": "space1" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { code: number; data?: any } };
}

async function reportProject(hash: string | null): Promise<void> {
  const store = new SessionWorkspaceStore(new MemoryStorage());
  setSessionWorkspaceStore(store);
  if (!hash) return;
  const ws: SessionWorkspace = {
    sessionId: SESSION_ID, deviceId: "d1", client: "claude-code", cwd: "/w", gitToplevel: "/w", gitRemote: null,
    projectKey: "git:example.test/team/repo", projectHash: hash, projectLabel: "example.test/team/repo",
    hookEvent: "UserPromptSubmit", hookVersion: "1", reportedAt: new Date().toISOString(),
  };
  await store.put({ spaceId: "space1", userId: "u1", agentSource: "claude-code", sessionId: SESSION_ID }, ws);
}

beforeEach(() => {
  sessions.states.clear();
  sessions.states.set(`claude-code:${SESSION_ID}`, {
    status: "initialized",
    sessionInfo: { user_id: "u1", team_id: "t1", agent_id: "a1", session_id: SESSION_ID, space_id: "space1" },
  });
});

describe("memory bridge scene tools", () => {
  it("reads the project scene first, with the session's project hash", async () => {
    await reportProject(HASH);
    const core = fakeCore({ project: { "work.md": "PROJECT BODY" }, global: { "work.md": "GLOBAL BODY" } });

    const res = await call(appWith(core.fetcher), "scenario/read", { path: "work.md" });

    expect(res.json.data).toMatchObject({ content: "PROJECT BODY", scope: "project" });
    expect(res.json.data).not.toHaveProperty("project_hash");
    expect(core.calls).toHaveLength(1);
    expect(core.calls[0].body.project_hash).toBe(HASH);
  });

  it("falls back to the user-global scene when the project has no such file", async () => {
    await reportProject(HASH);
    const core = fakeCore({ project: {}, global: { "root-habits.md": "GLOBAL BODY" } });

    const res = await call(appWith(core.fetcher), "scenario/read", { path: "root-habits.md" });

    expect(res.json.data).toMatchObject({ content: "GLOBAL BODY", scope: "global" });
    expect(core.calls.map((c) => c.body.project_hash)).toEqual([HASH, undefined]);
  });

  it("reads only the requested scope", async () => {
    await reportProject(HASH);
    const core = fakeCore({ project: { "work.md": "PROJECT BODY" }, global: { "work.md": "GLOBAL BODY" } });
    const app = appWith(core.fetcher);

    expect((await call(app, "scenario/read", { path: "work.md", scope: "global" })).json.data.content).toBe("GLOBAL BODY");
    expect((await call(app, "scenario/read", { path: "only-global.md", scope: "project" })).json.data.content).toBeNull();
    expect(core.calls.map((c) => c.body.project_hash)).toEqual([undefined, HASH]);
    expect(core.calls.every((c) => !("scope" in c.body))).toBe(true);
  });

  it("behaves as before without a project: no project hash, one upstream call", async () => {
    await reportProject(null);
    const core = fakeCore({ project: { "work.md": "PROJECT BODY" }, global: { "root-habits.md": "GLOBAL BODY" } });

    const res = await call(appWith(core.fetcher), "scenario/read", { path: "work.md" });

    expect(res.json.data.content).toBeNull();
    expect(core.calls).toHaveLength(1);
    expect(core.calls[0].body).not.toHaveProperty("project_hash");
  });

  it("never lets the model choose the project", async () => {
    await reportProject(null);
    const core = fakeCore({ project: { "work.md": "OTHER PROJECT" }, global: {} });

    const res = await call(appWith(core.fetcher), "scenario/read", { path: "work.md", project_hash: "bbbbbbbbbbbbbbbb" });

    expect(res.json.data.content).toBeNull();
    expect(core.calls.every((c) => c.body.project_hash === undefined)).toBe(true);

    await reportProject(HASH);
    await call(appWith(core.fetcher), "scenario/read", { path: "work.md", project_hash: "bbbbbbbbbbbbbbbb" });
    expect(core.calls.at(-1)!.body.project_hash).toBe(HASH);
  });

  it("lists project and user-global scenes, each tagged with its scope", async () => {
    await reportProject(HASH);
    const core = fakeCore({ project: { "work.md": "p" }, global: { "root-habits.md": "g" } });

    const res = await call(appWith(core.fetcher), "scenario/ls", { path_prefix: "" });

    expect(res.json.code).toBe(0);
    expect(res.json.data.entries).toEqual([
      { path: "work.md", summary: "summary of work.md", scope: "project" },
      { path: "root-habits.md", summary: "summary of root-habits.md", scope: "global" },
    ]);
    expect(res.json.data.total).toBe(2);
    expect(res.json.data).not.toHaveProperty("partial");
  });

  it("lists one scope when asked", async () => {
    await reportProject(HASH);
    const core = fakeCore({ project: { "work.md": "p" }, global: { "root-habits.md": "g" } });

    const res = await call(appWith(core.fetcher), "scenario/ls", { scope: "project" });

    expect(res.json.data.entries.map((e: { path: string }) => e.path)).toEqual(["work.md"]);
    expect(core.calls).toHaveLength(1);
  });

  it("lists user-global scenes unchanged without a project", async () => {
    await reportProject(null);
    const core = fakeCore({ project: { "work.md": "p" }, global: { "root-habits.md": "g" } });

    const res = await call(appWith(core.fetcher), "scenario/ls", {});

    expect(res.json.data.entries).toEqual([{ path: "root-habits.md", summary: "summary of root-habits.md" }]);
    expect(core.calls).toHaveLength(1);
  });

  describe("a Core that ignores project_hash", () => {
    it("never tags a global read as project and answers from the global path", async () => {
      await reportProject(HASH);
      const core = fakeCore({ project: { "work.md": "PROJECT BODY" }, global: { "work.md": "GLOBAL BODY" } }, { ignoreProjectHash: true });

      const res = await call(appWith(core.fetcher), "scenario/read", { path: "work.md" });

      expect(res.json.data).toMatchObject({ content: "GLOBAL BODY", scope: "global" });
    });

    it("answers a project-only read with no content", async () => {
      await reportProject(HASH);
      const core = fakeCore({ project: {}, global: { "root-habits.md": "GLOBAL BODY" } }, { ignoreProjectHash: true });

      const res = await call(appWith(core.fetcher), "scenario/read", { path: "root-habits.md", scope: "project" });

      expect(res.json.data).toMatchObject({ content: null, scope: "project" });
    });

    it("lists no entry as project and reports the project side as failed", async () => {
      await reportProject(HASH);
      const core = fakeCore({ project: { "work.md": "p" }, global: { "root-habits.md": "g" } }, { ignoreProjectHash: true });

      const res = await call(appWith(core.fetcher), "scenario/ls", {});

      expect(res.json.data.entries).toEqual([{ path: "root-habits.md", summary: "summary of root-habits.md", scope: "global" }]);
      expect(res.json.data).toMatchObject({ partial: true, failed_scopes: ["project"] });
    });
  });

  describe("profile scope mode", () => {
    it.each(["deny", "legacy"])("keeps the global-only read in %s mode, whatever the hook reported", async (mode) => {
      await reportProject(HASH);
      const core = fakeCore({ project: { "work.md": "PROJECT BODY" }, global: { "work.md": "GLOBAL BODY" } });
      const app = appWith(core.fetcher, mode);

      const read = await call(app, "scenario/read", { path: "work.md" });
      const list = await call(app, "scenario/ls", {});

      expect(read.json.data.content).toBe("GLOBAL BODY");
      expect(read.json.data).not.toHaveProperty("scope");
      expect(list.json.data.entries).toEqual([{ path: "work.md", summary: "summary of work.md" }]);
      expect(core.calls.every((c) => c.body.project_hash === undefined)).toBe(true);
    });

    it("runs the project branch in scoped mode", async () => {
      await reportProject(HASH);
      const core = fakeCore({ project: { "work.md": "PROJECT BODY" }, global: {} });

      const res = await call(appWith(core.fetcher, "scoped"), "scenario/read", { path: "work.md" });

      expect(res.json.data.content).toBe("PROJECT BODY");
    });
  });

  describe("a failing project call", () => {
    it.each(["throw", "http500"] as const)("falls through to the global read when the project call fails (%s)", async (failProjectCall) => {
      await reportProject(HASH);
      const core = fakeCore({ project: {}, global: { "root-habits.md": "GLOBAL BODY" } }, { failProjectCall });

      const res = await call(appWith(core.fetcher), "scenario/read", { path: "root-habits.md" });

      expect(res.status).toBe(200);
      expect(res.json.data).toMatchObject({ content: "GLOBAL BODY", scope: "global" });
    });

    it("does not fall through when only the project scope was requested", async () => {
      await reportProject(HASH);
      const core = fakeCore({ project: {}, global: { "root-habits.md": "GLOBAL BODY" } }, { failProjectCall: "throw" });

      const res = await call(appWith(core.fetcher), "scenario/read", { path: "root-habits.md", scope: "project" });

      expect(res.status).toBe(502);
      expect(core.calls.every((c) => c.body.project_hash !== undefined)).toBe(true);
    });

    it.each(["throw", "http500"] as const)("lists the global entries and marks the answer partial when the project call fails (%s)", async (failProjectCall) => {
      await reportProject(HASH);
      const core = fakeCore({ project: { "work.md": "p" }, global: { "root-habits.md": "g" } }, { failProjectCall });

      const res = await call(appWith(core.fetcher), "scenario/ls", {});

      expect(res.status).toBe(200);
      expect(res.json.data.entries).toEqual([{ path: "root-habits.md", summary: "summary of root-habits.md", scope: "global" }]);
      expect(res.json.data).toMatchObject({ partial: true, failed_scopes: ["project"] });
    });

    it("lists the project entries and marks the answer partial when the global call fails", async () => {
      await reportProject(HASH);
      const core = fakeCore({ project: { "work.md": "p" }, global: { "root-habits.md": "g" } }, { failGlobalCall: "throw" });

      const res = await call(appWith(core.fetcher), "scenario/ls", {});

      expect(res.json.data.entries).toEqual([{ path: "work.md", summary: "summary of work.md", scope: "project" }]);
      expect(res.json.data).toMatchObject({ partial: true, failed_scopes: ["global"] });
    });

    it("returns an error when both sides fail", async () => {
      await reportProject(HASH);
      const core = fakeCore({ project: {}, global: {} }, { failProjectCall: "throw", failGlobalCall: "throw" });

      const res = await call(appWith(core.fetcher), "scenario/ls", {});

      expect(res.status).toBe(502);
    });
  });
});
