/**
 * Rules for team-scoped subscription pool groups that the SQLite store, the MongoDB store and the
 * operator scripts must apply in the same way. The functions here are pure, so each caller reads
 * the data itself and this module only decides.
 */
import type { UpstreamMode } from "../types.js";

/** Threshold of an account when no valid stored value is known. */
export const DEFAULT_ACCOUNT_THRESHOLD_PCT = 95;

const MIN_ACCOUNT_THRESHOLD_PCT = 50;
const MAX_ACCOUNT_THRESHOLD_PCT = 100;

/** Team names that mark the default team when no name is configured, in search order. */
export const DEFAULT_TEAM_NAMES: readonly string[] = ["default", "default-team"];

/**
 * Names to search for the default team, in order. A configured name is used alone, so an operator
 * can point the backfill at one team without a match on the built-in names.
 */
export function defaultTeamSearchNames(configuredName?: string | null): string[] {
  const name = configuredName?.trim();
  return name ? [name] : [...DEFAULT_TEAM_NAMES];
}

/** Active teams that have one name. */
export interface DefaultTeamCandidates {
  name: string;
  team_ids: readonly string[];
}

export type DefaultTeamPick =
  | { status: "found"; name: string; team_id: string }
  /** Two or more active teams have the same name. The search stops at that name. */
  | { status: "ambiguous"; name: string; candidate_ids: string[] }
  /** `reason` is set when a configured team id is not an active team. */
  | { status: "not_found"; reason?: "configured_team_not_active" };

/**
 * Pick the default team from the candidates of each name, in the order given. The first name with
 * exactly one active team wins. A name with two or more teams stops the search, because a later
 * name must not win over a name that the operator cannot tell apart. No match gives `not_found`.
 */
export function pickDefaultTeam(candidatesByName: readonly DefaultTeamCandidates[]): DefaultTeamPick {
  for (const step of candidatesByName) {
    const ids = [...new Set(step.team_ids)];
    if (ids.length === 0) continue;
    if (ids.length === 1) return { status: "found", name: step.name, team_id: ids[0]! };
    return { status: "ambiguous", name: step.name, candidate_ids: ids.sort() };
  }
  return { status: "not_found" };
}

/**
 * Pick the default team from a configured team id. Only an active team with that id counts, so a
 * missing, archived or renamed-away id gives no team and never falls back to a name rule.
 */
export function pickDefaultTeamById(configuredId: string, activeTeamIds: readonly string[]): DefaultTeamPick {
  return activeTeamIds.includes(configuredId)
    ? { status: "found", name: configuredId, team_id: configuredId }
    : { status: "not_found", reason: "configured_team_not_active" };
}

/** What one start-up run of the pool team backfill did. */
export interface PoolTeamBackfillOutcome {
  /** Agents that went back to the default group. */
  restored: string[];
  /** Pool groups without a team before the run. */
  unassigned: number;
  /** Result of the default team search. Null when no pool group needed a team. */
  pick: DefaultTeamPick | null;
  /** Pool groups that got the default team. */
  assigned: number;
  /** True when a source name of an unassigned group is already used in the default team. */
  sourceClash: boolean;
}

/**
 * Write the backfill log lines. A run that changed rows writes one info line. Pool groups that
 * stay without a team give one error line with the candidate team ids (no team names), on each
 * start until the operator fixes the cause. A run that changed nothing writes no line.
 */
export function logSubscriptionPoolTeamBackfill(outcome: PoolTeamBackfillOutcome): void {
  const { restored, unassigned, pick, assigned, sourceClash } = outcome;
  if (restored.length > 0 || assigned > 0) {
    const team = assigned > 0 && pick?.status === "found" ? pick.team_id : "none";
    console.log(
      `[subscription-pool] team backfill team=${team} groups=${assigned} agents_restored=${restored.join(",") || "none"}`,
    );
  }
  if (unassigned > assigned) {
    const reason = sourceClash
      ? "source_name_clash"
      : pick?.status === "not_found" && pick.reason ? pick.reason : (pick?.status ?? "not_found");
    const candidates = pick?.status === "ambiguous"
      ? pick.candidate_ids
      : pick?.status === "found" ? [pick.team_id] : [];
    console.error(
      `[subscription-pool] team backfill left ${unassigned - assigned} pool group(s) without a team: ` +
      `reason=${reason} candidates=${candidates.join(",") || "none"}. No team uses these groups. ` +
      "Set TDAI_METADATA_DEFAULT_TEAM_ID (or TDAI_METADATA_DEFAULT_TEAM_NAME), or fix the team, then start again.",
    );
  }
}

/**
 * Scope of an upstream group for the agent and name rules. The instance scope holds the default,
 * custom and extraction groups that are not pools. Each team has its own pool scope. A pool group
 * without a team is in a pool scope that no team uses, so it never blocks an instance write.
 */
export interface UpstreamGroupScope {
  pool: boolean;
  team_id: string;
}

export const INSTANCE_UPSTREAM_SCOPE: UpstreamGroupScope = { pool: false, team_id: "" };

export function upstreamGroupScope(group: { mode: UpstreamMode | string; team_id?: string | null }): UpstreamGroupScope {
  return group.mode === "subscription_pool"
    ? { pool: true, team_id: String(group.team_id ?? "") }
    : INSTANCE_UPSTREAM_SCOPE;
}

export function sameUpstreamScope(a: UpstreamGroupScope, b: UpstreamGroupScope): boolean {
  return a.pool === b.pool && a.team_id === b.team_id;
}

/**
 * Read a stored threshold percentage. A value that is not an integer from 50 to 100 gives the
 * default, so a damaged setting cannot write a value that the account table rejects.
 */
export function parseStoredThresholdPct(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_ACCOUNT_THRESHOLD_PCT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= MIN_ACCOUNT_THRESHOLD_PCT && value <= MAX_ACCOUNT_THRESHOLD_PCT
    ? value
    : DEFAULT_ACCOUNT_THRESHOLD_PCT;
}
