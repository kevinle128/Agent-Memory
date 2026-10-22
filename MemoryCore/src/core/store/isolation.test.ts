import { describe, expect, it } from "vitest";

import { buildDedupScopeFilter, buildIsolationWhere, rowMatchesIsolation } from "./isolation.js";

const row = (team_id: string, user_id = "default", agent_id = "default") => ({ team_id, user_id, agent_id });

describe("buildDedupScopeFilter", () => {
  it("keeps a real team id", () => {
    expect(buildDedupScopeFilter("team-a", "u1", "a1")).toEqual({ teamId: "team-a", userId: "u1", agentId: "a1" });
  });

  it("always constrains the team, even when the caller has no team", () => {
    expect(buildDedupScopeFilter(undefined)).toEqual({ teamId: "", userId: "default", agentId: "default" });
    expect(buildDedupScopeFilter("")).toEqual({ teamId: "", userId: "default", agentId: "default" });
    expect(buildIsolationWhere(buildDedupScopeFilter("")).clause).toContain("team_id = ?");
  });

  it("does not match another team's rows when the team is empty (TCVDB/MongoDB store team-less rows as \"\")", () => {
    const filter = buildDedupScopeFilter("");
    expect(rowMatchesIsolation(row(""), filter)).toBe(true);
    expect(rowMatchesIsolation(row("team-b"), filter)).toBe(false);
  });

  it("does not match another team's rows when the team is \"default\" (SQLite stores team-less rows as \"default\")", () => {
    const filter = buildDedupScopeFilter("default");
    expect(rowMatchesIsolation(row("default"), filter)).toBe(true);
    expect(rowMatchesIsolation(row("team-b"), filter)).toBe(false);
  });
});
