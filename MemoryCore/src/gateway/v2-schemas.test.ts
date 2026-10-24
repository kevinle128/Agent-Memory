import { describe, it, expect } from "vitest";
import { resolveIsolation } from "./v2-schemas.js";

const KEY = "git:github.com/kevinle128/agent-memory";
const HASH = "0123456789abcdef";
const BASE_BODY = { team_id: "t1", user_id: "u1", agent_id: "a1", session_id: "s1" };

function project(
  body: Record<string, unknown> | undefined,
  headers: Record<string, string | string[] | undefined> = {},
) {
  const { ctx } = resolveIsolation(body, headers);
  return { projectKey: ctx.projectKey, projectHash: ctx.projectHash };
}

describe("resolveIsolation project fields", () => {
  it("reads the pair from the body", () => {
    expect(project({ ...BASE_BODY, project_key: KEY, project_hash: HASH }))
      .toEqual({ projectKey: KEY, projectHash: HASH });
  });

  it("reads the pair from headers", () => {
    expect(project(BASE_BODY, { "x-tdai-project-key": KEY, "x-tdai-project-hash": HASH }))
      .toEqual({ projectKey: KEY, projectHash: HASH });
  });

  it("prefers the body over headers", () => {
    const other = "local:device:/tmp/app";
    const otherHash = "fedcba9876543210";
    expect(project(
      { ...BASE_BODY, project_key: KEY, project_hash: HASH },
      { "x-tdai-project-key": other, "x-tdai-project-hash": otherHash },
    )).toEqual({ projectKey: KEY, projectHash: HASH });
  });

  it("does not mix a body key with a header hash", () => {
    expect(project(
      { ...BASE_BODY, project_key: KEY },
      { "x-tdai-project-hash": HASH },
    )).toEqual({ projectKey: undefined, projectHash: undefined });
  });

  it("ignores both fields when the hash is invalid", () => {
    for (const bad of ["xyz", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", ""]) {
      expect(project({ ...BASE_BODY, project_key: KEY, project_hash: bad }))
        .toEqual({ projectKey: undefined, projectHash: undefined });
    }
  });

  it("ignores both fields when only one is present", () => {
    expect(project({ ...BASE_BODY, project_key: KEY })).toEqual({ projectKey: undefined, projectHash: undefined });
    expect(project({ ...BASE_BODY, project_hash: HASH })).toEqual({ projectKey: undefined, projectHash: undefined });
    expect(project(BASE_BODY, { "x-tdai-project-key": KEY })).toEqual({ projectKey: undefined, projectHash: undefined });
  });

  it("ignores a key that is empty, too long, or not a string", () => {
    expect(project({ ...BASE_BODY, project_key: "", project_hash: HASH }).projectKey).toBeUndefined();
    expect(project({ ...BASE_BODY, project_key: "k".repeat(513), project_hash: HASH }).projectKey).toBeUndefined();
    expect(project({ ...BASE_BODY, project_key: 42, project_hash: HASH }).projectKey).toBeUndefined();
    expect(project({ ...BASE_BODY, project_key: "k".repeat(512), project_hash: HASH }).projectKey)
      .toBe("k".repeat(512));
  });

  it("does not change the other isolation fields", () => {
    const { ctx } = resolveIsolation({ ...BASE_BODY, task_id: "task-1", project_key: KEY, project_hash: HASH }, {});
    expect(ctx).toMatchObject({
      teamId: "t1", userId: "u1", agentId: "a1", sessionId: "s1", taskId: "task-1",
      projectKey: KEY, projectHash: HASH,
    });
  });

  it("leaves the context without project keys when none is sent", () => {
    const { ctx } = resolveIsolation(BASE_BODY, {});
    expect("projectKey" in ctx).toBe(false);
    expect("projectHash" in ctx).toBe(false);
  });
});

describe("resolveIsolation project name", () => {
  const withName = (name: unknown, extra: Record<string, unknown> = { project_key: KEY, project_hash: HASH }) =>
    resolveIsolation({ ...BASE_BODY, ...extra, project_name: name }, {}).ctx.projectName;

  it("keeps a trimmed name that comes with a valid pair", () => {
    expect(withName("  vtc/3q-chess/3q-game-api ")).toBe("vtc/3q-chess/3q-game-api");
  });

  it("accepts 200 characters and drops 201", () => {
    expect(withName("n".repeat(200))).toBe("n".repeat(200));
    expect(withName("n".repeat(201))).toBeUndefined();
  });

  it.each(["", "   ", 42, null, "a\nb", "a\u0000b", "a\u007fb"])("drops the name %j without dropping the pair", (name) => {
    const { ctx } = resolveIsolation({ ...BASE_BODY, project_key: KEY, project_hash: HASH, project_name: name }, {});
    expect(ctx.projectName).toBeUndefined();
    expect(ctx).toMatchObject({ projectKey: KEY, projectHash: HASH });
  });

  it("ignores a name that has no valid pair", () => {
    expect(withName("x/y", { project_key: KEY, project_hash: "bad" })).toBeUndefined();
    expect(withName("x/y", {})).toBeUndefined();
  });

  it("leaves the context without a name when an older proxy sends none", () => {
    const { ctx } = resolveIsolation({ ...BASE_BODY, project_key: KEY, project_hash: HASH }, {});
    expect("projectName" in ctx).toBe(false);
  });
});
