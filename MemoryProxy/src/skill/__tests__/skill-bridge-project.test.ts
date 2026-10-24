import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessions = vi.hoisted(() => ({ states: new Map<string, unknown>() }));

vi.mock("../../session/store.js", () => ({
  getSessionStore: () => ({
    get: (key: string) => sessions.states.get(key),
    getBindingRepo: () => undefined,
  }),
}));
vi.mock("../../memory/bridge-telemetry.js", () => ({
  emitBridgeToolCallTelemetry: vi.fn(),
  emitBridgeRejectTelemetry: vi.fn(),
  emitSkillUsageTelemetry: vi.fn(),
  agentSourceFromSessionKey: (k: string) => k.split(":")[0],
}));

import { MemoryStorage } from "../../storage/memory-storage.js";
import { SessionWorkspaceStore, setSessionWorkspaceStore, type SessionWorkspace } from "../../project-scope/session-workspace.js";
import type { ProxyConfig } from "../../types.js";
import { createSkillBridgeHandler } from "../skill-bridge.js";

const HASH = "aaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbb";
const SESSION_ID = "sess-1";

function makeConfig(profileScopeMode?: string): ProxyConfig {
  return {
    coreSkill: { endpoint: "http://core.test", serviceToken: "t", serviceId: "default", timeoutMs: 1000 },
    tdai: { serviceId: "default", apiKey: "k", ...(profileScopeMode ? { memory: { profileScopeMode } } : {}) },
    skillRuntime: { allowLlmWrite: true },
  } as unknown as ProxyConfig;
}

interface UpstreamCall { url: string; body: Record<string, unknown> }

/**
 * Fake Core. `honor` models a Core that applies the view and echoes it; an old
 * Core ignores the fields and answers with every skill.
 */
function fakeCore(honor: boolean, data: Record<string, unknown> = {}) {
  const calls: UpstreamCall[] = [];
  const fetcher = vi.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body });
    const echo = honor
      ? { ...(body.project_hash ? { project_hash: body.project_hash } : {}), ...(body.scope_filter ? { scope_filter: body.scope_filter } : {}) }
      : {};
    return Response.json({ code: 0, data: { items: [{ skill_id: "skl-1" }], total: 1, listing: "<available_skills>\n- one\n</available_skills>", ...data, ...echo } });
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

function appWith(fetcher: typeof fetch, profileScopeMode?: string): Hono {
  const app = new Hono();
  app.all("/skill-bridge/v3/skill/*", createSkillBridgeHandler(makeConfig(profileScopeMode), { fetcher }));
  return app;
}

async function call(app: Hono, sub: string, body: Record<string, unknown>) {
  const res = await app.request(`/skill-bridge/v3/skill/${sub}`, {
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
    projectKey: "git:example.test/team/repo", projectHash: hash, projectLabel: "example.test/team/repo", projectName: "team/repo",
    hookEvent: "UserPromptSubmit", hookVersion: "1", reportedAt: new Date().toISOString(),
  };
  await store.put({ spaceId: "space1", userId: "u1", agentSource: "claude-code", sessionId: SESSION_ID }, ws);
}

const FORGED = {
  change_source: "manual", scope: "project", project_hash: OTHER, project_key: "git:evil/repo",
  project_name: "evil", origin: "manual", scope_filter: "global_only",
};

beforeEach(() => {
  sessions.states.clear();
  sessions.states.set(`claude-code:${SESSION_ID}`, {
    status: "initialized",
    sessionInfo: { user_id: "u1", team_id: "t1", agent_id: "a1", session_id: SESSION_ID, space_id: "space1" },
  });
});

describe("skill bridge project view", () => {
  it("replaces model-sent project fields with the project of the session on a read", async () => {
    await reportProject(HASH);
    const core = fakeCore(true);
    const res = await call(appWith(core.fetcher), "list", { ...FORGED });
    expect(res.json.code).toBe(0);
    const sent = core.calls[0]!.body;
    expect(sent).toMatchObject({ project_hash: HASH, team_id: "t1", agent_id: "a1" });
    for (const field of ["change_source", "scope", "project_key", "project_name", "origin", "scope_filter"]) {
      expect(sent, field).not.toHaveProperty(field);
    }
  });

  it("asks for global skills only when the session has no project", async () => {
    await reportProject(null);
    const core = fakeCore(true);
    await call(appWith(core.fetcher), "listing", { project_hash: OTHER });
    const sent = core.calls[0]!.body;
    expect(sent).toMatchObject({ scope_filter: "global_only" });
    expect(sent).not.toHaveProperty("project_hash");
  });

  it("forces the extracted change source on a write and drops the model's own", async () => {
    await reportProject(HASH);
    const core = fakeCore(true);
    await call(appWith(core.fetcher), "update", { skill_id: "skl-1", expected_version: 1, content: "x", ...FORGED });
    expect(core.calls[0]!.body).toMatchObject({ change_source: "extracted" });
    expect(core.calls[0]!.body).not.toHaveProperty("project_key");
    expect(core.calls[0]!.body).not.toHaveProperty("origin");
  });

  it("places a created skill in the project of the session", async () => {
    await reportProject(HASH);
    const core = fakeCore(true);
    await call(appWith(core.fetcher), "create", { name: "n", content: "c", ...FORGED });
    expect(core.calls[0]!.body).toMatchObject({
      change_source: "extracted", scope: "project", project_hash: HASH,
      project_key: "git:example.test/team/repo", project_name: "team/repo",
    });
  });

  it("does not reach the rollback and proposal routes", async () => {
    await reportProject(HASH);
    const core = fakeCore(true);
    const app = appWith(core.fetcher);
    for (const sub of ["rollback", "proposals/list", "proposals/approve", "proposals/reject", "versions/diff"]) {
      const res = await call(app, sub, { skill_id: "skl-1" });
      expect(res.status, sub).toBeGreaterThanOrEqual(400);
    }
    expect(core.calls).toHaveLength(0);
  });

  it("hides the list answer of an old Core that did not apply the view", async () => {
    await reportProject(HASH);
    const core = fakeCore(false);
    const app = appWith(core.fetcher);
    const list = await call(app, "list", {});
    expect(list.json.data).toEqual({ items: [], total: 0 });
    const listing = await call(app, "listing", {});
    expect(listing.json.data.listing).toContain("(none)");
  });

  it("answers not found for a skill of another project from an old Core", async () => {
    await reportProject(HASH);
    const core = fakeCore(false, { scope: "project", project_hash: OTHER });
    const res = await call(appWith(core.fetcher), "get", { skill_id: "skl-1" });
    expect(res.json.code).toBe(40401);
  });

  it("keeps the earlier request in legacy mode", async () => {
    await reportProject(HASH);
    const core = fakeCore(false);
    const res = await call(appWith(core.fetcher, "legacy"), "update", { skill_id: "skl-1", expected_version: 1, change_source: "manual" });
    expect(core.calls[0]!.body).toMatchObject({ change_source: "manual" });
    expect(core.calls[0]!.body).not.toHaveProperty("project_hash");
    expect(res.json.code).toBe(0);
  });

  it("hides versions and file reads answered by an old Core without the echo", async () => {
    await reportProject(HASH);
    const core = fakeCore(false);
    const app = appWith(core.fetcher);
    expect((await call(app, "versions", { skill_id: "skl-1" })).json.code).toBe(40401);
    expect((await call(app, "files/read", { skill_id: "skl-1", path: "a.md" })).json.code).toBe(40401);
  });

  it("refuses a file download answered by an old Core without the echo", async () => {
    await reportProject(HASH);
    const core = fakeCore(false, { content: "secret", encoding: "utf-8" });
    const res = await appWith(core.fetcher).request("/skill-bridge/v3/skill/files/download", {
      method: "POST",
      headers: { "content-type": "application/json", "x-conversation-id": SESSION_ID, "x-tdai-service-id": "space1" },
      body: JSON.stringify({ skill_id: "skl-1", path: "a.md" }),
    });
    expect(await res.text()).not.toContain("secret");
    const ok = fakeCore(true, { content: "visible", encoding: "utf-8" });
    const good = await appWith(ok.fetcher).request("/skill-bridge/v3/skill/files/download", {
      method: "POST",
      headers: { "content-type": "application/json", "x-conversation-id": SESSION_ID, "x-tdai-service-id": "space1" },
      body: JSON.stringify({ skill_id: "skl-1", path: "a.md" }),
    });
    expect(await good.text()).toBe("visible");
    expect(ok.calls[0]!.body).toMatchObject({ project_hash: HASH });
  });

  it("sets the source session on a write and drops the model's value", async () => {
    await reportProject(HASH);
    const core = fakeCore(true);
    await call(appWith(core.fetcher), "patch", { skill_id: "skl-1", expected_version: 1, source_session_id: "forged" });
    expect(core.calls[0]!.body).toMatchObject({ source_session_id: SESSION_ID });
    const read = fakeCore(true);
    await call(appWith(read.fetcher), "list", { source_session_id: "forged" });
    expect(read.calls[0]!.body).not.toHaveProperty("source_session_id");
  });
});
