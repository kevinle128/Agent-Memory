import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TdaiClient } from "../client.js";
import type { TdaiAgentCtx } from "../types.js";

const HASH = "0123456789abcdef";
const ctx: TdaiAgentCtx = { teamId: "team-1", userId: "user-1", agentId: "agent-1" };

function makeClient(): TdaiClient {
  return new TdaiClient({
    enabled: true,
    endpoint: "http://tdai.test",
    apiKey: "key",
    serviceId: "svc",
    writeL0: true,
    recallL1: true,
    injectL2L3: true,
    l1Limit: 5,
    l2Limit: 50,
    timeoutMs: 1000,
  });
}

/** Stub fetch with one envelope and return the mock, so a test can read the request body. */
function stubFetch(data: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, message: "ok", data }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("TdaiClient project_hash on L2/L3 reads", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("readL3ForCtx keeps the body unchanged without a project hash", async () => {
    const fetchMock = stubFetch({ content: "persona", updated_at: "2026-10-01T00:00:00.000Z" });

    const result = await makeClient().readL3ForCtx(ctx);

    expect(String(fetchMock.mock.calls[0][0])).toBe("http://tdai.test/v3/core/read");
    expect(JSON.stringify(sentBody(fetchMock))).toBe(JSON.stringify({ team_id: "team-1", agent_id: "agent-1" }));
    expect(result).toEqual({ content: "persona", updatedAt: "2026-10-01T00:00:00.000Z" });
  });

  it("readL3ForCtx sends project_hash when given", async () => {
    const fetchMock = stubFetch({ content: "project memory" });

    const result = await makeClient().readL3ForCtx(ctx, HASH);

    expect(sentBody(fetchMock)).toEqual({ team_id: "team-1", agent_id: "agent-1", project_hash: HASH });
    expect(result?.content).toBe("project memory");
  });

  it("readL3ForCtx returns null when the project has no document", async () => {
    stubFetch({ content: null });

    await expect(makeClient().readL3ForCtx(ctx, HASH)).resolves.toBeNull();
  });

  it("listL2ForCtx keeps the body unchanged without a project hash", async () => {
    const fetchMock = stubFetch({ entries: [{ path: "a.md", summary: "A", updated_at: "t" }] });

    const entries = await makeClient().listL2ForCtx(ctx);

    expect(String(fetchMock.mock.calls[0][0])).toBe("http://tdai.test/v3/scenario/ls");
    expect(JSON.stringify(sentBody(fetchMock))).toBe(
      JSON.stringify({ team_id: "team-1", agent_id: "agent-1", path_prefix: "" }),
    );
    expect(entries).toEqual([{ path: "a.md", summary: "A", updatedAt: "t" }]);
  });

  it("listL2ForCtx sends project_hash when given", async () => {
    const fetchMock = stubFetch({ entries: [{ path: "work.md" }] });

    const entries = await makeClient().listL2ForCtx(ctx, HASH);

    expect(sentBody(fetchMock)).toEqual({ team_id: "team-1", agent_id: "agent-1", path_prefix: "", project_hash: HASH });
    expect(entries.map((e) => e.path)).toEqual(["work.md"]);
  });

  it("readL2ForCtx keeps the body unchanged without a project hash", async () => {
    const fetchMock = stubFetch({ content: "scene", updated_at: "t" });

    const file = await makeClient().readL2ForCtx(ctx, "work.md");

    expect(String(fetchMock.mock.calls[0][0])).toBe("http://tdai.test/v3/scenario/read");
    expect(JSON.stringify(sentBody(fetchMock))).toBe(
      JSON.stringify({ team_id: "team-1", agent_id: "agent-1", path: "work.md" }),
    );
    expect(file).toEqual({ path: "work.md", content: "scene", updatedAt: "t" });
  });

  it("readL2ForCtx sends project_hash when given", async () => {
    const fetchMock = stubFetch({ content: "scene" });

    await makeClient().readL2ForCtx(ctx, "work.md", HASH);

    expect(sentBody(fetchMock)).toEqual({ team_id: "team-1", agent_id: "agent-1", path: "work.md", project_hash: HASH });
  });

  it("treats an empty project hash as absent", async () => {
    const fetchMock = stubFetch({ content: "persona" });

    await makeClient().readL3ForCtx(ctx, "");

    expect(sentBody(fetchMock)).toEqual({ team_id: "team-1", agent_id: "agent-1" });
  });

  it("still returns an empty result when the gateway rejects the hash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));

    await expect(makeClient().readL3ForCtx(ctx, HASH)).resolves.toBeNull();
    await expect(makeClient().listL2ForCtx(ctx, HASH)).resolves.toEqual([]);
  });
});
