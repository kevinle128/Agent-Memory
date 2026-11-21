import { describe, expect, it } from "vitest";
import { isTeamPoolRow, poolServesClient, resolveForAgent, shouldOverride, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";

function row(partial: Partial<InstanceUpstreamRow>): InstanceUpstreamRow {
  return {
    group_id: "g", group_type: "custom", name: "n", agents: ["codex"], enabled: true,
    mode: "subscription_pool", team_id: "team-a", base_url: "", api_key: "", model_id: "", ...partial,
  };
}
const dflt = row({ group_id: "d", group_type: "default", mode: "official", agents: ["claude-code", "codex"], team_id: "" });

describe("resolveForAgent with subscription_pool groups", () => {
  it("uses the pool of the request team", () => {
    const pool = row({});
    expect(resolveForAgent([dflt, pool], "codex", "team-a")).toEqual({ kind: "pool", row: pool });
  });

  it("ignores the pool of another team and falls back to the default group", () => {
    expect(resolveForAgent([dflt, row({})], "codex", "team-b")).toEqual({ kind: "official", row: dflt });
  });

  it("picks the pool of the request team when two teams have a pool for the agent", () => {
    const poolA = row({ group_id: "pool-a", team_id: "team-a" });
    const poolB = row({ group_id: "pool-b", team_id: "team-b" });
    expect(resolveForAgent([dflt, poolA, poolB], "codex", "team-b")).toEqual({ kind: "pool", row: poolB });
    expect(resolveForAgent([dflt, poolA, poolB], "codex", "team-a")).toEqual({ kind: "pool", row: poolA });
  });

  it("ignores a switched-off team pool and uses the default group", () => {
    expect(resolveForAgent([dflt, row({ enabled: false })], "codex", "team-a")).toEqual({ kind: "official", row: dflt });
  });

  it("a team pool no longer blocks the agent when it is switched off", () => {
    const result = resolveForAgent([dflt, row({ enabled: false })], "codex", "team-a");
    expect(result.kind).not.toBe("blocked");
  });

  it("ignores a pool row without a team", () => {
    const noTeam = row({ team_id: undefined });
    const emptyTeam = row({ team_id: "" });
    expect(resolveForAgent([dflt, noTeam], "codex", "team-a")).toEqual({ kind: "official", row: dflt });
    expect(resolveForAgent([dflt, emptyTeam], "codex", "")).toEqual({ kind: "official", row: dflt });
    expect(resolveForAgent([dflt, emptyTeam], "codex", "team-a")).toEqual({ kind: "official", row: dflt });
  });

  it("uses the instance layer when the gate is closed (no team given)", () => {
    expect(resolveForAgent([dflt, row({})], "codex", null)).toEqual({ kind: "official", row: dflt });
  });

  it("never returns a pool for a null team, even when only pool rows exist", () => {
    expect(resolveForAgent([row({})], "codex", null)).toEqual({ kind: "official", row: null });
  });

  it("an agent outside the pool group still resolves to the default group", () => {
    expect(resolveForAgent([dflt, row({})], "claude-code", "team-a")).toEqual({ kind: "official", row: dflt });
  });

  it("an agent that only a pool of another team holds is unmanaged when the default group lacks it", () => {
    const narrowDefault = row({ group_id: "d", group_type: "default", mode: "official", agents: ["claude-code"], team_id: "" });
    expect(resolveForAgent([narrowDefault, row({})], "codex", "team-b")).toEqual({ kind: "unmanaged", agent: "codex" });
  });

  it("other custom modes keep resolving to override", () => {
    const custom = row({ mode: "custom_unified", base_url: "http://x", team_id: "" });
    expect(resolveForAgent([dflt, custom], "codex", "team-a")).toEqual({ kind: "override", row: custom });
    expect(resolveForAgent([dflt, custom], "codex", null)).toEqual({ kind: "override", row: custom });
  });

  it("a disabled custom group that is not a pool still blocks the agent", () => {
    const custom = row({ mode: "custom_unified", base_url: "http://x", enabled: false, team_id: "" });
    expect(resolveForAgent([dflt, custom], "codex", "team-a")).toEqual({
      kind: "blocked", reason: "custom_disabled", group_id: "g",
    });
  });

  it("shouldOverride stays false for a pool resolution", () => {
    expect(shouldOverride(resolveForAgent([dflt, row({})], "codex", "team-a"))).toBe(false);
  });
});

describe("pool row helpers", () => {
  it("isTeamPoolRow matches only the pool row of the same non-empty team", () => {
    expect(isTeamPoolRow(row({}), "team-a")).toBe(true);
    expect(isTeamPoolRow(row({}), "team-b")).toBe(false);
    expect(isTeamPoolRow(row({}), null)).toBe(false);
    expect(isTeamPoolRow(row({ team_id: "" }), "")).toBe(false);
    expect(isTeamPoolRow(row({ mode: "custom_unified" }), "team-a")).toBe(false);
  });

  it("poolServesClient counts enabled pool rows with a team that hold the agent or the source name", () => {
    const pool = row({ source_name: "sub-openai", source_agents: ["omp"] });
    expect(poolServesClient([pool], "codex", null)).toBe(true);
    expect(poolServesClient([pool], "claude-code", null)).toBe(false);
    expect(poolServesClient([pool], "omp", "sub-openai")).toBe(true);
    expect(poolServesClient([pool], "omp", "sub-claude")).toBe(false);
  });

  it("poolServesClient counts a disabled row only for its source name", () => {
    const disabled = row({ enabled: false, source_name: "sub-openai" });
    expect(poolServesClient([disabled], "codex", null)).toBe(false);
    expect(poolServesClient([disabled], "omp", "sub-openai")).toBe(true);
  });

  it("poolServesClient ignores rows without a team", () => {
    expect(poolServesClient([row({ team_id: undefined })], "codex", null)).toBe(false);
    expect(poolServesClient([row({ team_id: "" })], "codex", null)).toBe(false);
    expect(poolServesClient([row({ mode: "custom_unified", team_id: "" })], "codex", null)).toBe(false);
  });
});
