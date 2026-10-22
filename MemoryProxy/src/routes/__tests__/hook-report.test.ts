import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initAuth } from "../../auth.js";
import { MetadataClient, setMetadataClient } from "../../meta/client.js";
import { MemoryStorage } from "../../storage/memory-storage.js";
import type { ProxyConfig } from "../../types.js";
import { projectHash } from "../../project-scope/project-key.js";
import { SessionWorkspaceStore, setSessionWorkspaceStore } from "../../project-scope/session-workspace.js";
import { createHookReportHandler, parseHookReport, resetDeviceRefreshThrottle } from "../hook-report.js";
import { createSetupScriptHandler } from "../setup-scripts.js";

const config = {
  coreSkill: { endpoint: "http://core.test", serviceToken: "svc", serviceId: "default", timeoutMs: 1000 },
} as unknown as ProxyConfig;

let store: SessionWorkspaceStore;
const upsert = vi.fn(async () => ({}) as never);

function app(): Hono {
  const a = new Hono();
  a.post("/:agent/:spaceId/v3/hook/report", (c) => createHookReportHandler(config)(c));
  return a;
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device_id: "6f1c2b9e-1111-4222-8333-944455556666",
    session_id: "ac642bae-802e-46af-9104-81b23db0969d",
    cwd: "/Users/dale/src/demo/sub",
    git_toplevel: "/Users/dale/src/demo",
    git_remote: "git@gitlab.example.com:Team/Demo-Repo.git",
    hook_event: "UserPromptSubmit",
    hook_version: "1",
    client: "claude-code",
    os: "darwin",
    arch: "arm64",
    hostname: "dale-mbp",
    ...overrides,
  };
}

function post(body: unknown, path = "/claude-code/default/v3/hook/report", token = "sk-mem-test") {
  return app().request(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const key = (sessionId = "ac642bae-802e-46af-9104-81b23db0969d", userId = "anonymous") => ({
  spaceId: "default",
  userId,
  agentSource: "claude-code",
  sessionId,
});

beforeEach(() => {
  store = new SessionWorkspaceStore(new MemoryStorage());
  setSessionWorkspaceStore(store);
  resetDeviceRefreshThrottle();
  upsert.mockClear();
  const client = new MetadataClient(config.coreSkill, "default", "sk-mem-test");
  client.upsertDeviceSetup = upsert as never;
  setMetadataClient(client);
  initAuth({ enabled: false, url: "", timeoutMs: 1000, apiKey: "" });
});

afterEach(() => {
  setSessionWorkspaceStore(null);
  setMetadataClient(null);
  initAuth({ enabled: false, url: "", timeoutMs: 1000, apiKey: "" });
  vi.unstubAllGlobals();
});

describe("parseHookReport", () => {
  it("accepts a full report and maps empty git fields to null", () => {
    const r = parseHookReport(report({ git_toplevel: "", git_remote: null }));
    expect(r).toMatchObject({ gitToplevel: null, gitRemote: null, client: "claude-code" });
  });

  it.each([
    ["device_id", { device_id: "../etc" }],
    ["session_id", { session_id: "" }],
    ["cwd", { cwd: 42 }],
    ["client", { client: "Claude Code" }],
    ["hook_version", { hook_version: undefined }],
  ])("rejects a bad %s", (_k, o) => {
    expect(typeof parseHookReport(report(o))).toBe("string");
  });

  it("rejects a non-object body", () => {
    expect(parseHookReport([1, 2])).toBe("body must be a JSON object");
  });
});

describe("POST /:agent/:spaceId/v3/hook/report", () => {
  it("stores the session workspace with the project of the repository", async () => {
    const res = await post(report());
    expect(res.status).toBe(204);
    const ws = await store.get(key());
    expect(ws).toMatchObject({
      cwd: "/Users/dale/src/demo/sub",
      projectKey: "git:gitlab.example.com/team/demo-repo",
      projectHash: projectHash("git:gitlab.example.com/team/demo-repo"),
      projectLabel: "gitlab.example.com/team/demo-repo",
      hookEvent: "UserPromptSubmit",
    });
  });

  it("stores no project for a folder outside git", async () => {
    await post(report({ cwd: "/Users/dale/Movies", git_toplevel: null, git_remote: null }));
    expect(await store.get(key())).toMatchObject({ cwd: "/Users/dale/Movies", projectKey: null, projectHash: null });
  });

  it("replaces the workspace when a later report changes the folder", async () => {
    await post(report());
    await post(report({ cwd: "/Users/dale/Movies", git_toplevel: null, git_remote: null }));
    expect((await store.get(key()))?.projectKey).toBeNull();
  });

  it("returns 400 for a bad body and stores nothing", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post(report({ session_id: "" }))).status).toBe(400);
    expect(await store.get(key())).toBeNull();
  });

  it("returns 400 for an invalid agent segment", async () => {
    expect((await post(report(), "/Claude_Code/default/v3/hook/report")).status).toBe(400);
  });

  it("returns 401 when the auth service rejects the user key", async () => {
    initAuth({ enabled: true, url: "http://core.test", timeoutMs: 1000, apiKey: "" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { valid: false } }))));
    const res = await post(report(), undefined, "sk-mem-bad");
    expect(res.status).toBe(401);
    expect(await store.get(key())).toBeNull();
  });

  it("keys the record by the verified user and refreshes the device record", async () => {
    initAuth({ enabled: true, url: "http://core.test", timeoutMs: 1000, apiKey: "" });
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, data: { valid: true, user: { user_id: "usr-1" } } })),
    ));
    expect((await post(report())).status).toBe(204);
    expect(await store.get(key(undefined, "usr-1"))).not.toBeNull();
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "usr-1",
      device_id: "6f1c2b9e-1111-4222-8333-944455556666",
      client: "claude-code",
      hook_version: "1",
    }));
  });

  it("refreshes the device record at most once per interval, except for an install", async () => {
    initAuth({ enabled: true, url: "http://core.test", timeoutMs: 1000, apiKey: "" });
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, data: { valid: true, user: { user_id: "usr-1" } } })),
    ));
    await post(report());
    await post(report());
    expect(upsert).toHaveBeenCalledTimes(1);
    await post(report({ hook_event: "Install" }));
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("does not refresh a device record for an anonymous caller", async () => {
    await post(report());
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("setup script routes", () => {
  it("returns 404 for an unknown script name", async () => {
    const a = new Hono();
    a.get("/setup/:name", (c) => createSetupScriptHandler(c.req.param("name"))(c));
    expect((await a.request("/setup/other.sh")).status).toBe(404);
  });
});
