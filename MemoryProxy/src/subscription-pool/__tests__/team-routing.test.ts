/**
 * Requests of users that belong to more than one team, through the real Claude Code and Codex
 * runners and the real session store. Each test records which pool token reached the upstream:
 * a request must never carry the token of an account of another team.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import { __resetSessionStoreForTests } from "../../session/store.js";
import { __primeAccountCacheForTests } from "../account-cache.js";
import type { PoolAccount } from "../types.js";
import {
  installFetch, jsonResponse, makeApp, makeConfig, registerPoolTestSession, resetPoolState, setPoolTestTeams,
  useRealSessionTeams, type RecordedCall,
} from "./test-harness.js";
import { __setTeamListFetcherForTests } from "../pool-team.js";

const SPACE = "sp-teams";
const NOW = Date.now();
const HOUR = 3_600_000;
const CHATGPT = "https://chatgpt.com/backend-api/codex";

const defaultRow: InstanceUpstreamRow = {
  group_id: "d", group_type: "default", name: "default", agents: ["claude-code", "codex"], enabled: true,
  mode: "official", base_url: "", api_key: "", model_id: "",
};

function claudePool(team: string): InstanceUpstreamRow {
  return {
    group_id: `claude-${team}`, group_type: "custom", name: `claude pool ${team}`, agents: ["claude-code"], enabled: true,
    mode: "subscription_pool", team_id: team, base_url: "", api_key: "", model_id: "",
  };
}

function codexPool(team: string): InstanceUpstreamRow {
  return { ...claudePool(team), group_id: `codex-${team}`, name: `codex pool ${team}`, agents: ["codex"] };
}

function claudeAccount(team: string, partial: Partial<PoolAccount> = {}): PoolAccount {
  return {
    account_id: `ca-${team}`, group_id: `claude-${team}`, provider: "claude", provider_account_id: `acct-${team}`,
    status: "active", enabled: true, access_token: `claude-token-${team}`, token_expires_at: NOW + HOUR,
    usage: { windows: [] }, exhausted_until: null, ...partial,
  };
}

function codexAccount(team: string, partial: Partial<PoolAccount> = {}): PoolAccount {
  return {
    account_id: `xa-${team}`, group_id: `codex-${team}`, provider: "codex", provider_account_id: `chatgpt-${team}`,
    status: "active", enabled: true, access_token: `codex-token-${team}`, token_expires_at: NOW + HOUR,
    usage: { windows: [] }, exhausted_until: null, ...partial,
  };
}

const exhausted = <T extends PoolAccount>(account: T): T => ({ ...account, status: "exhausted", exhausted_until: NOW + HOUR });

function prime(rows: InstanceUpstreamRow[], accounts: PoolAccount[]): void {
  __primeCacheForTests(SPACE, [defaultRow, ...rows]);
  __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts });
}

const message = { id: "msg", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };
const sse = (): Response => new Response("data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n", {
  status: 200, headers: { "content-type": "text/event-stream" },
});

function claude(headers: Record<string, string> = {}) {
  return makeApp(makeConfig()).request(`/claude-code/${SPACE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-user-key": "sk-mem-user", ...headers },
    body: JSON.stringify({ model: "claude-x", max_tokens: 8, stream: false, messages: [{ role: "user", content: "hi" }] }),
  });
}

function codex(headers: Record<string, string> = {}) {
  return makeApp(makeConfig()).request(`/codex/${SPACE}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-tdai-user-key": "sk-mem-user",
      authorization: "Bearer chatgpt-own-token", "chatgpt-account-id": "own-acct", ...headers,
    },
    body: JSON.stringify({ model: "gpt-5-codex", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], stream: true }),
  });
}

/** Every credential that reached the upstream, so a test can assert on all of them. */
const credentialsOf = (calls: RecordedCall[]): string => calls.map((call) => `${call.headers["authorization"] ?? ""}|${call.headers["chatgpt-account-id"] ?? ""}`).join("\n");

describe("team routing in the runners", () => {
  beforeEach(() => {
    resetPoolState();
    useRealSessionTeams();
    setPoolTestTeams(["team-b", "team-a"]);
    for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetSessionStoreForTests();
  });

  describe("Claude Code", () => {
    it("sends a team B request to its own account and never to team A", async () => {
      prime([claudePool("team-a"), claudePool("team-b")], [claudeAccount("team-a"), claudeAccount("team-b")]);
      await registerPoolTestSession("claude-code", "sess-b", "team-b");
      const { upstreamCalls } = installFetch(() => jsonResponse(message));
      const res = await claude({ "x-claude-code-session-id": "sess-b" });
      await res.text();
      expect(res.status).toBe(200);
      expect(upstreamCalls).toHaveLength(1);
      expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer claude-token-team-b");
      expect(credentialsOf(upstreamCalls)).not.toContain("team-a");
    });

    it("sends a team A request to its own account when the user is in both teams", async () => {
      prime([claudePool("team-a"), claudePool("team-b")], [claudeAccount("team-a"), claudeAccount("team-b")]);
      await registerPoolTestSession("claude-code", "sess-a", "team-a");
      const { upstreamCalls } = installFetch(() => jsonResponse(message));
      await (await claude({ "x-claude-code-session-id": "sess-a" })).text();
      expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer claude-token-team-a");
      expect(credentialsOf(upstreamCalls)).not.toContain("team-b");
    });

    it("sends a request of a team without a pool to the shared normal upstream, with no pool token", async () => {
      setPoolTestTeams(["team-a", "team-c"]);
      prime([claudePool("team-a")], [claudeAccount("team-a")]);
      await registerPoolTestSession("claude-code", "sess-c", "team-c");
      const { upstreamCalls } = installFetch(() => jsonResponse(message));
      const res = await claude({ "x-claude-code-session-id": "sess-c", "x-api-key": "client-key" });
      await res.text();
      expect(res.status).toBe(200);
      // The second recorded call is the usage report of a normal upstream request; a pool request has none.
      expect(upstreamCalls.filter((call) => call.url.startsWith("http://global-upstream.test"))).toHaveLength(1);
      expect(upstreamCalls[0]!.url).toMatch(/^http:\/\/global-upstream\.test/);
      expect(credentialsOf(upstreamCalls)).not.toContain("claude-token");
    });

    it("x-memory-mode: off with two teams uses the first team in Core order that has a usable account", async () => {
      setPoolTestTeams(["team-b", "team-a"]);
      prime([claudePool("team-a"), claudePool("team-b")], [exhausted(claudeAccount("team-b")), claudeAccount("team-a")]);
      const { upstreamCalls } = installFetch(() => jsonResponse(message));
      const res = await claude({ "x-memory-mode": "off", "x-claude-code-session-id": "sess-off" });
      await res.text();
      expect(res.status).toBe(200);
      expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer claude-token-team-a");
      expect(credentialsOf(upstreamCalls)).not.toContain("team-b");
    });

    it("x-memory-mode: off takes the newest team first when both have a usable account", async () => {
      prime([claudePool("team-a"), claudePool("team-b")], [claudeAccount("team-a"), claudeAccount("team-b")]);
      const { upstreamCalls } = installFetch(() => jsonResponse(message));
      await (await claude({ "x-memory-mode": "off" })).text();
      expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer claude-token-team-b");
    });

    it("a request without a session id takes the first team that has a usable account", async () => {
      prime([claudePool("team-a"), claudePool("team-b")], [exhausted(claudeAccount("team-b")), claudeAccount("team-a")]);
      const { upstreamCalls } = installFetch(() => jsonResponse(message));
      await (await claude()).text();
      expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer claude-token-team-a");
    });

    it("answers 429 with the earliest reset when no team has a usable account, and calls no upstream", async () => {
      prime([claudePool("team-a"), claudePool("team-b")], [exhausted(claudeAccount("team-b")), exhausted(claudeAccount("team-a"))]);
      const { upstreamCalls } = installFetch(() => jsonResponse(message));
      const res = await claude({ "x-memory-mode": "off" });
      expect(res.status).toBe(429);
      expect(res.headers.get("x-tdai-pool-status")).toBe("exhausted");
      expect(res.headers.get("x-tdai-pool-earliest-reset")).not.toBeNull();
      expect(upstreamCalls).toHaveLength(0);
    });

    it("answers 403 no_team_pool when no team of the user has a pool, and calls no upstream", async () => {
      setPoolTestTeams(["team-a", "team-b"]);
      prime([claudePool("team-z")], [claudeAccount("team-z")]);
      const { upstreamCalls } = installFetch(() => jsonResponse(message));
      const res = await claude({ "x-memory-mode": "off" });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ type: "error", error: { type: "no_team_pool" } });
      expect(upstreamCalls).toHaveLength(0);
    });

    it("answers 403 no_active_team for a user with zero teams, and calls no upstream", async () => {
      setPoolTestTeams([]);
      prime([claudePool("team-a")], [claudeAccount("team-a")]);
      const { upstreamCalls } = installFetch(() => jsonResponse(message));
      const res = await claude({ "x-claude-code-session-id": "sess-none" });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { type: "no_active_team" } });
      expect(upstreamCalls).toHaveLength(0);
    });

    it("answers 503 with Retry-After when the team list is not available, and calls no upstream", async () => {
      __setTeamListFetcherForTests(async () => { throw new Error("core down"); });
      prime([claudePool("team-a")], [claudeAccount("team-a")]);
      const { upstreamCalls } = installFetch(() => jsonResponse(message));
      const res = await claude({ "x-memory-mode": "off" });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(upstreamCalls).toHaveLength(0);
    });

    it("keeps old behavior for a client that no team pool serves", async () => {
      prime([codexPool("team-a")], [codexAccount("team-a")]);
      const { upstreamCalls } = installFetch(() => jsonResponse(message));
      setPoolTestTeams([]);
      const res = await claude({ "x-memory-mode": "off", "x-api-key": "client-key" });
      await res.text();
      expect(res.status).toBe(200);
      expect(upstreamCalls[0]!.url).toMatch(/^http:\/\/global-upstream\.test/);
    });

    it("a session never moves to the pool of another team after the first account is bound", async () => {
      prime([claudePool("team-a"), claudePool("team-b")], [claudeAccount("team-a"), claudeAccount("team-b")]);
      const { upstreamCalls } = installFetch(() => jsonResponse(message));
      await registerPoolTestSession("claude-code", "sess-move", "team-a");
      await (await claude({ "x-claude-code-session-id": "sess-move" })).text();
      await registerPoolTestSession("claude-code", "sess-move", "team-b");
      await (await claude({ "x-claude-code-session-id": "sess-move" })).text();
      expect(upstreamCalls.map((call) => call.headers["authorization"])).toEqual([
        "Bearer claude-token-team-a", "Bearer claude-token-team-b",
      ]);
    });
  });

  describe("Codex", () => {
    it("sends a team B request to its own account and never to team A", async () => {
      prime([codexPool("team-a"), codexPool("team-b")], [codexAccount("team-a"), codexAccount("team-b")]);
      await registerPoolTestSession("codex", "cx-b", "team-b");
      const { upstreamCalls } = installFetch(() => sse());
      await (await codex({ "session-id": "cx-b" })).text();
      expect(upstreamCalls).toHaveLength(1);
      expect(upstreamCalls[0]!.url).toBe(`${CHATGPT}/responses`);
      expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer codex-token-team-b");
      expect(upstreamCalls[0]!.headers["chatgpt-account-id"]).toBe("chatgpt-team-b");
      expect(credentialsOf(upstreamCalls)).not.toContain("team-a");
    });

    it("sends a request of a team without a pool to the shared normal upstream", async () => {
      setPoolTestTeams(["team-a", "team-c"]);
      prime([codexPool("team-a")], [codexAccount("team-a")]);
      await registerPoolTestSession("codex", "cx-c", "team-c");
      const { upstreamCalls } = installFetch(() => sse());
      await (await codex({ "session-id": "cx-c" })).text();
      expect(upstreamCalls[0]!.url).toMatch(/^http:\/\/global-upstream\.test/);
      expect(credentialsOf(upstreamCalls)).not.toContain("codex-token");
    });

    it("a request without a session takes the first team that has a usable account", async () => {
      prime([codexPool("team-a"), codexPool("team-b")], [exhausted(codexAccount("team-b")), codexAccount("team-a")]);
      const { upstreamCalls } = installFetch(() => sse());
      await (await codex()).text();
      expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer codex-token-team-a");
      expect(credentialsOf(upstreamCalls)).not.toContain("team-b");
    });

    it("answers 429 when no team has a usable account, and calls no upstream", async () => {
      prime([codexPool("team-a"), codexPool("team-b")], [exhausted(codexAccount("team-b")), exhausted(codexAccount("team-a"))]);
      const { upstreamCalls } = installFetch(() => sse());
      const res = await codex();
      expect(res.status).toBe(429);
      expect(upstreamCalls).toHaveLength(0);
    });

    it("answers 403 no_active_team for a user with zero teams", async () => {
      setPoolTestTeams([]);
      prime([codexPool("team-a")], [codexAccount("team-a")]);
      const { upstreamCalls } = installFetch(() => sse());
      const res = await codex({ "session-id": "cx-none" });
      expect(res.status).toBe(403);
      expect(upstreamCalls).toHaveLength(0);
    });

    it("a subagent request follows the team of its parent session", async () => {
      prime([codexPool("team-a"), codexPool("team-b")], [codexAccount("team-a"), codexAccount("team-b")]);
      await registerPoolTestSession("codex", "cx-parent", "team-b");
      const { upstreamCalls } = installFetch(() => sse());
      await (await codex({ "session-id": "cx-child", "x-parent-conversation-id": "cx-parent" })).text();
      expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer codex-token-team-b");
    });
  });
});
