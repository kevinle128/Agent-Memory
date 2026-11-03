import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __primeCacheForTests, clearCache, type InstanceUpstreamRow } from "../../../instance-upstream-cache.js";
import { resetAccountSwitchAccessForTests } from "../../../subscription-pool/account-switch-access.js";
import type { AgentContext, PrewarmInput } from "../../types.js";
import { SubscriptionToolsInjector, renderSubscriptionToolsBlock } from "../subscription-tools-injector.js";

const BASE = "http://proxy.test:8096/";
const SPACE = "sp-pool";
const SESSION = "sess-1";
const ADMIN = "u-admin";
const CONFIG = {
  coreSkill: { endpoint: "http://core.test", serviceToken: "svc", timeoutMs: 1000 },
  instanceUpstream: { cacheTtlSec: 30 },
};
const SANDBOX_LINE = "ask the user for approval to run the curl command outside the sandbox";

const defaultRow: InstanceUpstreamRow = {
  group_id: "d", group_type: "default", name: "default", agents: ["claude-code", "codex", "codebuddy"], enabled: true,
  mode: "official", base_url: "", api_key: "", model_id: "",
};
const poolRow: InstanceUpstreamRow = {
  group_id: "pool", group_type: "custom", name: "pool", agents: ["claude-code", "codex"], enabled: true,
  mode: "subscription_pool", base_url: "", api_key: "", model_id: "",
};

function listResponse(items: unknown[]): Response {
  return new Response(JSON.stringify({ code: 0, data: { items, total: items.length, limit: 1, offset: 0 } }), { status: 200 });
}

function ctxFor(agentSource: string, userId = ADMIN): AgentContext {
  return {
    metadata: {
      agentSource,
      userId,
      custom: {
        userKey: "sk-user-secret",
        session: { session_id: SESSION, team_id: "t1", user_id: userId, agent_id: "a1", space_id: SPACE },
      },
    },
  } as unknown as AgentContext;
}

function prewarmFor(agentSource: string, userId = ADMIN): PrewarmInput {
  return {
    keyId: "k1",
    userId,
    agentSource,
    spaceId: SPACE,
    sessionInfo: { session_id: SESSION, space_id: SPACE },
    agentDetail: null,
    taskDetail: null,
    callerUserKey: "sk-user-secret",
  } as unknown as PrewarmInput;
}

describe("renderSubscriptionToolsBlock", () => {
  it("renders curl recipes with the session and instance headers", () => {
    const text = renderSubscriptionToolsBlock(BASE, SESSION, SPACE, "claude-code");
    const headers = `-H 'content-type: application/json' -H 'x-tdai-service-id: ${SPACE}' -H 'x-conversation-id: ${SESSION}'`;
    expect(text.startsWith("<subscription_tools>")).toBe(true);
    expect(text.endsWith("</subscription_tools>")).toBe(true);
    expect(text).toContain(`curl -sSk -X POST http://proxy.test:8096/subscription-bridge/v1/current ${headers} -d '{}'`);
    expect(text).toContain(`curl -sSk -X POST http://proxy.test:8096/subscription-bridge/v1/switch ${headers} -d '{"email": "<email>"}'`);
    expect(text).toContain('<tool name="subscription_current">');
    expect(text).toContain('<tool name="subscription_switch">');
    expect(text).toContain("NEVER switch the account on your own.");
  });
});

describe("SubscriptionToolsInjector", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let injector: SubscriptionToolsInjector;

  beforeEach(() => {
    resetAccountSwitchAccessForTests();
    clearCache();
    __primeCacheForTests(SPACE, [defaultRow, poolRow]);
    // Only the role lookup reaches Core; the instance upstream config comes from the primed cache.
    fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/user/list-by-instance")) return listResponse([{ user_id: ADMIN, user_type: "system_admin" }]);
      throw new Error(`unexpected Core call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    injector = new SubscriptionToolsInjector({ proxyBaseUrl: BASE, config: CONFIG });
  });

  afterEach(() => {
    clearCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("offers the block to a system admin on a pool-served Claude Code session", async () => {
    const blocks = await injector.execute(ctxFor("claude-code"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe(renderSubscriptionToolsBlock(BASE, SESSION, SPACE, "claude-code"));
    expect(blocks[0]?.metadata?.source).toBe("subscription-tools-injector");
  });

  it("offers the block on a pool-served Codex session and adds the sandbox line", async () => {
    const blocks = await injector.execute(ctxFor("codex"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toContain(SANDBOX_LINE);
  });

  it("Claude Code block does not contain the sandbox line", async () => {
    const blocks = await injector.execute(ctxFor("claude-code"));
    expect(blocks[0]?.content).not.toContain("sandbox");
  });

  it("returns nothing for a normal user", async () => {
    // Core filters by role, so a normal user gives an empty list.
    fetchMock.mockImplementation(async () => listResponse([]));
    expect(await injector.execute(ctxFor("claude-code", "u-normal"))).toEqual([]);
    expect(await injector.prewarm(prewarmFor("claude-code", "u-normal"))).toEqual([]);
  });

  it("returns nothing when the client is not served by the pool", async () => {
    __primeCacheForTests(SPACE, [defaultRow]);
    expect(await injector.execute(ctxFor("claude-code"))).toEqual([]);
    expect(await injector.prewarm(prewarmFor("codex"))).toEqual([]);
  });

  it("returns nothing for other clients", async () => {
    __primeCacheForTests(SPACE, [defaultRow, { ...poolRow, agents: ["codebuddy"] }]);
    expect(await injector.execute(ctxFor("codebuddy"))).toEqual([]);
  });

  it("returns nothing when the role lookup fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ code: 500, message: "INTERNAL: boom" }), { status: 500 }));
    expect(await injector.execute(ctxFor("claude-code"))).toEqual([]);
  });

  it("returns nothing when the session identity is missing", async () => {
    const ctx = { metadata: { agentSource: "claude-code", userId: ADMIN, spaceId: SPACE, custom: {} } } as unknown as AgentContext;
    expect(await injector.execute(ctx)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prewarm and execute render the same text", async () => {
    for (const agentSource of ["claude-code", "codex"]) {
      const fromExecute = await injector.execute(ctxFor(agentSource));
      const fromPrewarm = await injector.prewarm(prewarmFor(agentSource));
      expect(fromPrewarm).toHaveLength(1);
      expect(fromPrewarm[0]?.content).toBe(fromExecute[0]?.content);
    }
  });

  it("rendered text contains no Bearer and no sk- key", async () => {
    for (const agentSource of ["claude-code", "codex"]) {
      const [block] = await injector.execute(ctxFor(agentSource));
      expect(block?.content).toBeDefined();
      expect(block?.content).not.toMatch(/Bearer|sk-/);
      expect(block?.content).not.toContain("svc");
    }
  });
});
