import { describe, expect, it, vi } from "vitest";

import { handleConversationAdd, type SkillRouterDeps } from "./skill-handlers.js";

const auth = { apiKey: "test", serviceId: "default" } as Parameters<typeof handleConversationAdd>[1];

const body = {
  session_id: "s1",
  user_id: "u1",
  team_id: "t1",
  agent_id: "a1",
  messages: [{ role: "user", content: "hello" }],
};

function deps(extractionEnabled: boolean | undefined): SkillRouterDeps & { handle: ReturnType<typeof vi.fn> } {
  const handle = vi.fn(async () => ({ status: "buffered" }));
  const d = {
    getSkillCore: () => undefined,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    resolveConversationAdd: vi.fn(async () => ({ handler: { handle } }) as never),
    ...(extractionEnabled === undefined ? {} : { isSkillExtractionEnabled: () => extractionEnabled }),
  } as unknown as SkillRouterDeps & { handle: ReturnType<typeof vi.fn> };
  d.handle = handle;
  return d;
}

describe("handleConversationAdd with skill extraction off", () => {
  it("answers skipped and buffers nothing", async () => {
    const d = deps(false);
    const res = await handleConversationAdd(body, auth, "req-1", d);
    expect(res).toMatchObject({ code: 0, data: { status: "skipped", reason: "extraction_disabled" } });
    expect(d.resolveConversationAdd).not.toHaveBeenCalled();
    expect(d.handle).not.toHaveBeenCalled();
  });

  it("still rejects an invalid body", async () => {
    const res = await handleConversationAdd({ ...body, messages: [] }, auth, "req-2", deps(false));
    expect(res.code).toBe(40001);
  });

  it("buffers the round when extraction is on", async () => {
    const d = deps(true);
    const res = await handleConversationAdd(body, auth, "req-3", d);
    expect(res.code).toBe(0);
    expect(d.handle).toHaveBeenCalledTimes(1);
  });

  it("keeps the earlier behavior when the dependency is absent", async () => {
    const d = deps(undefined);
    await handleConversationAdd(body, auth, "req-4", d);
    expect(d.handle).toHaveBeenCalledTimes(1);
  });
});

describe("handleConversationAdd strict import in code mode", () => {
  const strict = { ...body, strict_mode: true };
  const withMode = (mode: "code" | "chat") => Object.assign(deps(true), { getPromptMode: () => mode });

  it("refuses an import without a project, so it does not answer ok and create nothing", async () => {
    const d = withMode("code");
    const res = await handleConversationAdd(strict, auth, "req-5", d);
    expect(res.code).toBe(40001);
    expect(d.handle).not.toHaveBeenCalled();
  });

  it("accepts an import with a project", async () => {
    const d = withMode("code");
    const res = await handleConversationAdd(
      { ...strict, project_key: "git:h/a/b", project_hash: "aaaaaaaaaaaaaaaa" }, auth, "req-6", d);
    expect(res.code).toBe(0);
    expect(d.handle).toHaveBeenCalledTimes(1);
  });

  it("keeps normal rounds and chat mode unchanged", async () => {
    expect((await handleConversationAdd(body, auth, "req-7", withMode("code"))).code).toBe(0);
    expect((await handleConversationAdd(strict, auth, "req-8", withMode("chat"))).code).toBe(0);
  });
});
