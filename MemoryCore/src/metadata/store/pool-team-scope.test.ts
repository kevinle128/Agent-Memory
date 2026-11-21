import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_ACCOUNT_THRESHOLD_PCT,
  INSTANCE_UPSTREAM_SCOPE,
  defaultTeamSearchNames,
  parseStoredThresholdPct,
  pickDefaultTeam,
  pickDefaultTeamById,
  logSubscriptionPoolTeamBackfill,
  sameUpstreamScope,
  upstreamGroupScope,
} from "./pool-team-scope.js";

describe("default team search", () => {
  it("searches default first and then default-team when no name is configured", () => {
    expect(defaultTeamSearchNames()).toEqual(["default", "default-team"]);
    expect(defaultTeamSearchNames("   ")).toEqual(["default", "default-team"]);
  });

  it("uses only the configured name when it is set", () => {
    expect(defaultTeamSearchNames(" Main ")).toEqual(["Main"]);
  });

  it("picks the only team of the first name that has one", () => {
    expect(pickDefaultTeam([
      { name: "default", team_ids: ["team-a"] },
      { name: "default-team", team_ids: ["team-b"] },
    ])).toEqual({ status: "found", name: "default", team_id: "team-a" });
  });

  it("falls through to the next name when a name has no team", () => {
    expect(pickDefaultTeam([
      { name: "default", team_ids: [] },
      { name: "default-team", team_ids: ["team-b"] },
    ])).toEqual({ status: "found", name: "default-team", team_id: "team-b" });
  });

  it("stops at a name with two teams and does not try the next name", () => {
    expect(pickDefaultTeam([
      { name: "default", team_ids: ["team-z", "team-a"] },
      { name: "default-team", team_ids: ["team-b"] },
    ])).toEqual({ status: "ambiguous", name: "default", candidate_ids: ["team-a", "team-z"] });
  });

  it("finds no team when no name matches", () => {
    expect(pickDefaultTeam([{ name: "default", team_ids: [] }])).toEqual({ status: "not_found" });
    expect(pickDefaultTeam([])).toEqual({ status: "not_found" });
  });

  it("counts a team id that is listed twice as one team", () => {
    expect(pickDefaultTeam([{ name: "default", team_ids: ["team-a", "team-a"] }]))
      .toEqual({ status: "found", name: "default", team_id: "team-a" });
  });
});

describe("default team by id", () => {
  it("finds the configured team when it is active", () => {
    expect(pickDefaultTeamById("team-a", ["team-a"]))
      .toEqual({ status: "found", name: "team-a", team_id: "team-a" });
  });

  it("finds no team when the configured id is not in the active list", () => {
    expect(pickDefaultTeamById("team-a", [])).toEqual({ status: "not_found", reason: "configured_team_not_active" });
    expect(pickDefaultTeamById("team-a", ["team-b"])).toEqual({ status: "not_found", reason: "configured_team_not_active" });
  });

  it("names the id variable in the error line when the configured team is not active", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      logSubscriptionPoolTeamBackfill({
        restored: [], unassigned: 2, assigned: 0, sourceClash: false,
        pick: pickDefaultTeamById("team-a", []),
      });
      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]![0]);
      expect(line).toContain("reason=configured_team_not_active");
      expect(line).toContain("TDAI_METADATA_DEFAULT_TEAM_ID");
    } finally {
      error.mockRestore();
    }
  });
});

describe("upstream group scope", () => {
  it("puts every group that is not a pool in the instance scope, whatever its team field", () => {
    expect(upstreamGroupScope({ mode: "official", team_id: "" })).toEqual(INSTANCE_UPSTREAM_SCOPE);
    expect(upstreamGroupScope({ mode: "custom_unified", team_id: "team-a" })).toEqual(INSTANCE_UPSTREAM_SCOPE);
  });

  it("gives each team its own pool scope and keeps pools without a team out of the instance scope", () => {
    const a = upstreamGroupScope({ mode: "subscription_pool", team_id: "team-a" });
    const b = upstreamGroupScope({ mode: "subscription_pool", team_id: "team-b" });
    const none = upstreamGroupScope({ mode: "subscription_pool", team_id: "" });
    expect(sameUpstreamScope(a, upstreamGroupScope({ mode: "subscription_pool", team_id: "team-a" }))).toBe(true);
    expect(sameUpstreamScope(a, b)).toBe(false);
    expect(sameUpstreamScope(none, INSTANCE_UPSTREAM_SCOPE)).toBe(false);
  });
});

describe("stored threshold", () => {
  it("reads an integer from 50 to 100", () => {
    expect(parseStoredThresholdPct("80")).toBe(80);
    expect(parseStoredThresholdPct(50)).toBe(50);
    expect(parseStoredThresholdPct("100")).toBe(100);
  });

  it("uses 95 for a missing or invalid value", () => {
    for (const raw of [undefined, null, "", "abc", "49", "101", "80.5", "-1"]) {
      expect(parseStoredThresholdPct(raw)).toBe(DEFAULT_ACCOUNT_THRESHOLD_PCT);
    }
    expect(DEFAULT_ACCOUNT_THRESHOLD_PCT).toBe(95);
  });
});
