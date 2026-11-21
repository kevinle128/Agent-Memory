/**
 * `SessionStore.peekForTeam`: the read-only look at the team of a session. Every layer is a fake,
 * so a test also proves that the method writes nothing and rebuilds nothing.
 */
import { describe, expect, it, vi } from "vitest";
import type { BindingRepo, SessionBinding } from "../../db/binding-repo.js";
import type { SessionRepo } from "../../db/sessionRepo.js";
import { SessionStore } from "../store.js";
import type { SessionInitState } from "../types.js";

const KEY = "claude-code:s1";
const IDENTITY = { userId: "u1", agentSource: "claude-code", sessionId: "s1", spaceId: "sp" };
const TTL = 30 * 60_000;

function registered(team: string, userId = "u1"): SessionInitState {
  return {
    status: "initialized", keyId: KEY, startedAt: Date.now(), attemptCount: 1, userId,
    sessionInfo: { session_id: "s1", team_id: team, agent_id: "a", user_id: userId },
  };
}

function fakeRepo(row: SessionInitState | null | "throw") {
  return {
    upsert: vi.fn(async () => {}),
    getBySessionId: vi.fn(async () => {
      if (row === "throw") throw new Error("storage down");
      return row;
    }),
    deleteBySessionId: vi.fn(),
    loadAllInitialized: vi.fn(async () => []),
  } as unknown as SessionRepo & { upsert: ReturnType<typeof vi.fn>; getBySessionId: ReturnType<typeof vi.fn>; deleteBySessionId: ReturnType<typeof vi.fn> };
}

function fakeBindings(binding: SessionBinding | null | "throw") {
  return {
    getBinding: vi.fn(async () => {
      if (binding === "throw") throw new Error("storage down");
      return binding;
    }),
    putBinding: vi.fn(async () => {}),
    deleteBinding: vi.fn(async () => {}),
    touchLastSeen: vi.fn(async () => {}),
  } as unknown as BindingRepo & { getBinding: ReturnType<typeof vi.fn>; putBinding: ReturnType<typeof vi.fn>; deleteBinding: ReturnType<typeof vi.fn>; touchLastSeen: ReturnType<typeof vi.fn> };
}

describe("SessionStore.peekForTeam", () => {
  it("answers none when no layer has the session", async () => {
    const store = new SessionStore(TTL, fakeRepo(null), fakeBindings(null));
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "none" });
  });

  it("answers from an initialized L1 state without reading the repo", async () => {
    const repo = fakeRepo(null);
    const store = new SessionStore(TTL, repo, fakeBindings(null));
    await store.set(KEY, registered("team-b"));
    repo.getBySessionId.mockClear();
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "registered", teamId: "team-b" });
    expect(repo.getBySessionId).not.toHaveBeenCalled();
  });

  it("reads L2a when L1 has nothing, and does not promote the row to L1", async () => {
    const repo = fakeRepo(registered("team-b"));
    const store = new SessionStore(TTL, repo, fakeBindings(null));
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "registered", teamId: "team-b" });
    expect(repo.getBySessionId).toHaveBeenCalledWith("sp", "u1", "claude-code", "s1");
    expect(store.get(KEY)).toBeUndefined();
  });

  it("reads the chosen team of a pending L2a row", async () => {
    const pending: SessionInitState = { status: "pending_task_select", keyId: KEY, startedAt: Date.now(), attemptCount: 0, userId: "u1", selectedTeamId: "team-b" };
    const store = new SessionStore(TTL, fakeRepo(pending), fakeBindings(null));
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "pending", teamId: "team-b" });
  });

  it("reads the chosen team of a bypassed L2a row", async () => {
    const bypassed: SessionInitState = { status: "initialized", keyId: KEY, startedAt: Date.now(), attemptCount: 0, userId: "u1", bypassed: true, sessionInfo: null, selectedTeamId: "team-c" };
    const store = new SessionStore(TTL, fakeRepo(bypassed), fakeBindings(null));
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "registered", teamId: "team-c" });
  });

  it("ignores an L2a row of another user", async () => {
    const store = new SessionStore(TTL, fakeRepo(registered("team-b", "u2")), fakeBindings(null));
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "none" });
  });

  it("ignores an L1 state of another user and reads on", async () => {
    const repo = fakeRepo(null);
    const store = new SessionStore(TTL, repo, fakeBindings(null));
    await store.set(KEY, registered("team-b", "u2"));
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "none" });
    expect(repo.getBySessionId).toHaveBeenCalled();
  });

  it("ignores a pending L2a row that is older than the time to live, and deletes nothing", async () => {
    const stale: SessionInitState = { status: "pending_agent_select", keyId: KEY, startedAt: Date.now() - TTL - 1000, attemptCount: 0, userId: "u1", selectedTeamId: "team-b" };
    const repo = fakeRepo(stale);
    const store = new SessionStore(TTL, repo, fakeBindings(null));
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "none" });
    expect(repo.deleteBySessionId).not.toHaveBeenCalled();
  });

  it("keeps an old initialized row: a session that is resumed after a long sleep still has its team", async () => {
    const old = { ...registered("team-b"), startedAt: Date.now() - 10 * TTL };
    const store = new SessionStore(TTL, fakeRepo(old), fakeBindings(null));
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "registered", teamId: "team-b" });
  });

  it("treats a repo that throws as a miss and reads the binding", async () => {
    const bindings = fakeBindings({ outcome: "initialized", userId: "u1", teamId: "team-b", agentSource: "claude-code" });
    const store = new SessionStore(TTL, fakeRepo("throw"), bindings);
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "registered", teamId: "team-b" });
  });

  it("falls back to a pending L1 state when L2a has none", async () => {
    const repo = fakeRepo(null);
    const store = new SessionStore(TTL, repo, fakeBindings(null));
    await store.set(KEY, { status: "pending_agent_select", keyId: KEY, startedAt: Date.now(), attemptCount: 0, userId: "u1", selectedTeamId: "team-b" });
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "pending", teamId: "team-b" });
  });

  it("prefers the authoritative L2a row over a pending L1 state", async () => {
    const store = new SessionStore(TTL, fakeRepo(registered("team-c")), fakeBindings(null));
    await store.set(KEY, { status: "pending_agent_select", keyId: KEY, startedAt: Date.now(), attemptCount: 0, userId: "u1", selectedTeamId: "team-b" });
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "registered", teamId: "team-c" });
  });

  it("reads a bypassed binding without a team as a final state with no team", async () => {
    const bindings = fakeBindings({ outcome: "bypassed", userId: "u1", agentSource: "claude-code" });
    const store = new SessionStore(TTL, fakeRepo(null), bindings);
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "registered", teamId: null });
  });

  it("ignores a binding of another user", async () => {
    const bindings = fakeBindings({ outcome: "initialized", userId: "u2", teamId: "team-b", agentSource: "claude-code" });
    const store = new SessionStore(TTL, fakeRepo(null), bindings);
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "none" });
  });

  it("treats a binding read that throws as a miss", async () => {
    const store = new SessionStore(TTL, fakeRepo(null), fakeBindings("throw"));
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "none" });
  });

  it("writes nothing and rebuilds nothing, whichever layer answers", async () => {
    const repo = fakeRepo(null);
    const bindings = fakeBindings({ outcome: "initialized", userId: "u1", teamId: "team-b", agentSource: "claude-code" });
    const store = new SessionStore(TTL, repo, bindings);
    await store.peekForTeam(KEY, IDENTITY);
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(repo.deleteBySessionId).not.toHaveBeenCalled();
    expect(bindings.putBinding).not.toHaveBeenCalled();
    expect(bindings.deleteBinding).not.toHaveBeenCalled();
    expect(bindings.touchLastSeen).not.toHaveBeenCalled();
    expect(store.get(KEY)).toBeUndefined();
  });

  it("works without any repo", async () => {
    const store = new SessionStore(TTL);
    expect(await store.peekForTeam(KEY, IDENTITY)).toEqual({ state: "none" });
  });
});
