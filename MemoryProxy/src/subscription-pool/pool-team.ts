/**
 * Team of a request, and the team-aware answers around it.
 *
 * Every subscription pool belongs to one team. A request may use only the pool of its own team,
 * so each path that can reach a pool asks this module first. Every request has a user and every
 * user belongs to at least one team, so the helper finds a team or returns a clear error.
 *
 * Order of the rules (see `resolveRequestTeam`):
 *   A. A known team: the registered session, a bypassed session that chose a team, a pending form
 *      choice, then the team that init registers in this request: the default of the user, else
 *      the header preset (the order of session init). A known team decides alone. A known
 *      team without a pool uses the shared normal upstream; it never moves to another team.
 *   B. Else the ordered fallback: the user's active teams in the order Core returns them, and the
 *      first team that has an enabled pool for the client with at least one usable account.
 *
 * The helper runs only when an enabled pool row that belongs to a team serves the client in the
 * instance. In every other case it returns null, and the request runs exactly as before.
 */

import type { Context } from "hono";
import { getInstanceUpstreamConfigs, isTeamPoolRow, poolServesClient, type InstanceUpstreamRow } from "../instance-upstream-cache.js";
import { getMetadataClient } from "../meta/client.js";
import { isMemoryModeOff, MEMORY_MODE_HEADER } from "../common/memory-mode.js";
import { modelSourcePrefix } from "../pipeline/stages/model-source.js";
import { getSessionStore, type SessionTeamPeek } from "../session/store.js";
import { parsePresetIdentity } from "../session/preset.js";
import { hasSystemUsers, matchSystemUserByUserId } from "../systemUser.js";
import type { ProxyConfig } from "../types.js";
import { getPoolSnapshot, unavailableAccountIds } from "./account-cache.js";
import type { PoolCoreConfig } from "./core-client.js";
import { buildPoolExhaustedResponse, buildPoolUnavailableResponse } from "./exhausted-response.js";
import { earliestReset, hasAccountBelowQuota, selectAccount } from "./selector.js";
import type { PoolAccount } from "./types.js";

const TAG = "[subscription-pool]";

/** A fresh team list is used as it is for this long. */
const MEMBERSHIP_FRESH_MS = 60_000;
/** After a Core error the last good team list is kept for this long. */
const MEMBERSHIP_STALE_MS = 10 * 60_000;
const MEMBERSHIP_MAX_ENTRIES = 2000;
/** The user default is cached this long per user. */
const USER_DEFAULT_FRESH_MS = 60_000;
const USER_DEFAULT_MAX_ENTRIES = 2000;
/** Seconds that a client waits when the team list is not available. */
const TEAM_LIST_RETRY_AFTER_SEC = 5;

export type RequestTeamSource = "session" | "pending" | "preset" | "default" | "fallback";

export type RequestTeamErrorCode =
  | "no_active_team"
  | "no_team_pool"
  | "pool_exhausted"
  | "pool_unavailable"
  | "team_list_unavailable";

export interface RequestTeamError {
  kind: "error";
  code: RequestTeamErrorCode;
  status: 403 | 429 | 503;
  message: string;
  /** Earliest reset in epoch milliseconds, for `pool_exhausted`. Null when no account reports one. */
  resetAtMs?: number | null;
  /**
   * True when session init (or a session reset / local mem command) may still run for this
   * request. The caller then goes on with no team, lets those stages run (they may answer without
   * an upstream), and applies the error after init when the session still has no team.
   */
  deferrable: boolean;
}

export type RequestTeam =
  | { kind: "team"; teamId: string; source: RequestTeamSource }
  | RequestTeamError;

/** What the team list needs from the config: where Core is. */
export interface TeamListConfig {
  coreSkill: PoolCoreConfig;
}

export interface RequestTeamInput {
  config: TeamListConfig & Pick<ProxyConfig, "instanceUpstream" | "sessionInit" | "modelSources">;
  spaceId: string;
  /** Verified user id. Empty or "anonymous" gives no team logic (auth is off or the user is unknown). */
  userId: string;
  /** User key of the request. Core reads the team list with it. */
  userKey: string;
  agentSource: string;
  /**
   * The session of the request as the runner registers it: the L1 key, the agent source and the
   * session id of the identity. Null when the request carries no session id.
   */
  session: { keyId: string; agentSource: string; sessionId: string } | null;
  /** Lowercased request headers. The header preset is read from them. */
  lcHeaders: Record<string, string>;
  /** `body.model` as the client sent it. */
  model: unknown;
  /**
   * True when the caller runs session init for this request, so a team may be registered during
   * the request. Then the preset and the user default predict that team, and an error can wait.
   */
  sessionInitMayRun: boolean;
  /** The request asks for no memory by a way other than the header (the AntiGravity URL form). */
  memoryOff?: boolean;
  now?: number;
}

/**
 * Agent source under which the session store keeps the state of a client. WorkBuddy reuses the
 * Codex state machine, so its sessions sit under `codex`.
 */
export function sessionStateAgent(agentSource: string): string {
  return agentSource === "workbuddy" ? "codex" : agentSource;
}

// ── Membership ───────────────────────────────────────────────────────────────

interface MembershipEntry {
  teamIds: string[];
  freshUntil: number;
  staleUntil: number;
}

const membership = new Map<string, MembershipEntry>();
const membershipInFlight = new Map<string, Promise<string[] | null>>();

/** Hook for tests: replace the Core call that lists the teams of a user. */
type TeamListFetcher = (
  config: TeamListConfig, spaceId: string, userId: string, userKey: string,
) => Promise<Array<{ team_id: string; status?: string }>>;

const coreTeamList: TeamListFetcher = (config, spaceId, userId, userKey) =>
  getMetadataClient(config.coreSkill, spaceId, userKey).listTeams(userId);
let teamListFetcher: TeamListFetcher = coreTeamList;

function membershipKey(spaceId: string, userId: string): string {
  return `${spaceId}\0${userId}`;
}

function rememberMembership(key: string, teamIds: string[], now: number): void {
  // Delete first so that a rewritten key moves to the newest position of the Map.
  membership.delete(key);
  if (membership.size >= MEMBERSHIP_MAX_ENTRIES) {
    const oldest = membership.keys().next().value as string | undefined;
    if (oldest !== undefined) membership.delete(oldest);
  }
  membership.set(key, { teamIds, freshUntil: now + MEMBERSHIP_FRESH_MS, staleUntil: now + MEMBERSHIP_STALE_MS });
}

/**
 * Ids of the active teams of a user, in the order Core returns them (newest team first). The value
 * is cached for 60 seconds. After a Core error the last good value is used for up to 10 minutes.
 * Null when Core cannot answer and no usable value exists. Concurrent calls share one request.
 */
export async function listMemberTeamIds(
  config: TeamListConfig,
  spaceId: string,
  userId: string,
  userKey: string,
  now: number = Date.now(),
): Promise<string[] | null> {
  if (!spaceId || !userId || !userKey) return null;
  const key = membershipKey(spaceId, userId);
  const cached = membership.get(key);
  if (cached && cached.freshUntil > now) return cached.teamIds;

  const inFlight = membershipInFlight.get(key);
  if (inFlight) return inFlight;

  const load = teamListFetcher(config, spaceId, userId, userKey)
    .then((teams) => {
      const ids = teams
        .filter((team) => team.status === undefined || team.status === "active")
        .map((team) => team.team_id)
        .filter((id): id is string => typeof id === "string" && id !== "");
      rememberMembership(key, ids, now);
      return ids;
    })
    .catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : "unknown";
      if (cached && cached.staleUntil > now) {
        console.warn(`${TAG} team list failed for space=${spaceId}, using the last good list (${reason})`);
        return cached.teamIds;
      }
      console.warn(`${TAG} team list failed for space=${spaceId}, no usable list (${reason})`);
      return null;
    })
    .finally(() => {
      membershipInFlight.delete(key);
    });
  membershipInFlight.set(key, load);
  return load;
}

// ── User default ─────────────────────────────────────────────────────────────

interface UserDefaultEntry {
  teamId: string | null;
  freshUntil: number;
}

const userDefaults = new Map<string, UserDefaultEntry>();

async function userDefaultTeamId(
  config: TeamListConfig, spaceId: string, userId: string, userKey: string, now: number,
): Promise<string | null> {
  const key = membershipKey(spaceId, userId);
  const cached = userDefaults.get(key);
  if (cached && cached.freshUntil > now) return cached.teamId;
  let teamId: string | null = null;
  try {
    const def = await getMetadataClient(config.coreSkill, spaceId, userKey).getUserSessionDefault(userId);
    teamId = def?.team_id || null;
  } catch (err) {
    // An unreadable default is no default. The next request tries again.
    console.warn(`${TAG} user default read failed for space=${spaceId}: ${err instanceof Error ? err.message : "unknown"}`);
    return null;
  }
  userDefaults.delete(key);
  if (userDefaults.size >= USER_DEFAULT_MAX_ENTRIES) {
    const oldest = userDefaults.keys().next().value as string | undefined;
    if (oldest !== undefined) userDefaults.delete(oldest);
  }
  userDefaults.set(key, { teamId, freshUntil: now + USER_DEFAULT_FRESH_MS });
  return teamId;
}

// ── The helper ───────────────────────────────────────────────────────────────

function modelOf(model: unknown): string {
  if (typeof model !== "string") return "";
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

function errorMessage(code: RequestTeamErrorCode, agentSource: string): string {
  switch (code) {
    case "no_active_team":
      return `The user is not an active member of any team, so no subscription pool can serve ${agentSource}.`;
    case "no_team_pool":
      return `No team of this user has a subscription pool for ${agentSource}. Open the session in a team that has one, or ask a team admin.`;
    case "pool_exhausted":
      return "All subscription accounts of the pools of this user have reached their usage limit.";
    case "pool_unavailable":
      return "The subscription pool is unavailable. Try again shortly.";
    case "team_list_unavailable":
      return "The team list of this user is not available. Try again shortly.";
  }
}

function failure(
  code: RequestTeamErrorCode,
  status: 403 | 429 | 503,
  agentSource: string,
  deferrable: boolean,
  resetAtMs?: number | null,
): RequestTeamError {
  console.warn(`${TAG} no usable team pool code=${code}`);
  return {
    kind: "error", code, status, message: errorMessage(code, agentSource), deferrable,
    ...(resetAtMs !== undefined ? { resetAtMs } : {}),
  };
}

/**
 * Team of one request, or null when no team pool serves this client in the instance (the gate),
 * for a system user, and when no user is known. Null means: run exactly as before.
 */
export async function resolveRequestTeam(input: RequestTeamInput): Promise<RequestTeam | null> {
  const { config, spaceId, userId, userKey, agentSource } = input;
  const now = input.now ?? Date.now();
  if (!spaceId || !userId || userId === "anonymous") return null;
  if (hasSystemUsers() && matchSystemUserByUserId(userId) !== null) return null;

  const rows = await getInstanceUpstreamConfigs(config.coreSkill, spaceId, config.instanceUpstream);
  const prefix = modelSourcePrefix(config, agentSource, input.model);
  if (!poolServesClient(rows, agentSource, prefix)) return null;

  const memoryOff = input.memoryOff === true || isMemoryModeOff(input.lcHeaders[MEMORY_MODE_HEADER]);
  const mayRegister = input.sessionInitMayRun && input.session !== null && !memoryOff;

  const teamIds = await listMemberTeamIds(config, spaceId, userId, userKey, now);

  // A known team decides alone.
  let peek: SessionTeamPeek = { state: "none" };
  if (input.session) {
    peek = await getSessionStore().peekForTeam(input.session.keyId, {
      userId, agentSource: input.session.agentSource, sessionId: input.session.sessionId, spaceId,
    });
  }
  // Init may still add a team while the session has no final state, so only then a predicted
  // team is tried. An error still waits for the stages that run before the upstream is chosen,
  // even on a final state: mem:session-reset and local mem commands need no upstream, and
  // settleRequestTeam answers the error before any upstream call.
  const predicts = mayRegister && peek.state !== "registered";
  const deferrable = mayRegister;

  const candidates: Array<{ teamId: string; source: RequestTeamSource }> = [];
  const peekedTeamId = peek.state === "none" ? null : peek.teamId;
  if (peekedTeamId) {
    candidates.push({ teamId: peekedTeamId, source: peek.state === "pending" ? "pending" : "session" });
  } else if (predicts) {
    // The user default and the header preset decide the team that init registers in this very
    // request. Init tries the user default first and the preset second, so this does the same.
    const defaultTeamId = await userDefaultTeamId(config, spaceId, userId, userKey, now);
    if (defaultTeamId) candidates.push({ teamId: defaultTeamId, source: "default" });
    const preset = config.sessionInit ? parsePresetIdentity(config.sessionInit, input.lcHeaders) : undefined;
    if (preset?.teamId) candidates.push({ teamId: preset.teamId, source: "preset" });
  }

  if (teamIds === null) return failure("team_list_unavailable", 503, agentSource, deferrable);

  const known = candidates.find((candidate) => teamIds.includes(candidate.teamId));
  if (known) return { kind: "team", teamId: known.teamId, source: known.source };

  // No known team: the ordered fallback.
  if (teamIds.length === 0) return failure("no_active_team", 403, agentSource, deferrable);

  const snapshot = await getPoolSnapshot(config.coreSkill, spaceId, config.instanceUpstream, now);
  const skipped = unavailableAccountIds(spaceId, now);
  const model = modelOf(input.model);
  let hasPool = false;
  // A source request to a pool that is switched off, or that does not allow this client or model,
  // still gets the answer of its own team (source disabled, not allowed, model not enabled). So the
  // first team with such a row is kept in case no team pool serves the request.
  let switchedOffSourceTeam: string | null = null;
  const poolAccounts: PoolAccount[] = [];
  for (const teamId of teamIds) {
    if (switchedOffSourceTeam === null && prefix !== null
      && rows.some((r) => isTeamPoolRow(r, teamId) && r.source_name === prefix
        && (!r.enabled || !poolRowServes(r, agentSource, prefix, model)))) {
      switchedOffSourceTeam = teamId;
    }
    const row = rows.find((r) => r.group_type === "custom" && isTeamPoolRow(r, teamId) && r.enabled
      && poolRowServes(r, agentSource, prefix, model));
    if (!row) continue;
    hasPool = true;
    const accounts = snapshot.accounts.filter((account) => account.group_id === row.group_id);
    if (selectAccount(accounts, null, now, snapshot.thresholdPct, model, 0, skipped) !== null) {
      return { kind: "team", teamId, source: "fallback" };
    }
    poolAccounts.push(...accounts);
  }
  if (!hasPool && switchedOffSourceTeam !== null) return { kind: "team", teamId: switchedOffSourceTeam, source: "fallback" };
  if (!hasPool) return failure("no_team_pool", 403, agentSource, deferrable);
  // An account below its limit that was still held back (a failed token refresh) is no quota cause.
  if (snapshot.unavailable || hasAccountBelowQuota(poolAccounts, now, model)) {
    return failure("pool_unavailable", 503, agentSource, deferrable);
  }
  return failure("pool_exhausted", 429, agentSource, deferrable, earliestReset(poolAccounts, now, snapshot.thresholdPct, model));
}

/**
 * True when the pool row serves the request: it holds the agent, or it is the source of a
 * `<source>/<model>` request that allows this agent and has the model enabled (as stageModelSource checks).
 */
function poolRowServes(row: InstanceUpstreamRow, agentSource: string, prefix: string | null, upstreamModel: string): boolean {
  if (row.agents.includes(agentSource)) return true;
  if (prefix === null || row.source_name !== prefix) return false;
  if (!(row.source_agents ?? []).includes(agentSource)) return false;
  const entry = (row.source_models ?? []).find((m) => m.id === upstreamModel);
  return entry !== undefined && entry.enabled === true && entry.available !== false;
}

// ── After session init ───────────────────────────────────────────────────────

export interface SettledTeam {
  /** Team to route with. Null when no team pool serves the client. */
  teamId: string | null;
  /** An error to answer with. Set only when init gave no team and the deferred error stands. */
  error: RequestTeamError | null;
  /** True when the team differs from the one of the first answer. */
  changed: boolean;
}

/**
 * The error of a first answer that must be returned now. A deferrable error waits for session
 * init; every other error stands at once.
 */
export function immediateTeamError(team: RequestTeam | null): RequestTeamError | null {
  return team?.kind === "error" && !team.deferrable ? team : null;
}

/** Team id of a first answer, or null when it is no team (gate closed, or an error). */
export function teamIdOf(team: RequestTeam | null): string | null {
  return team?.kind === "team" ? team.teamId : null;
}

/**
 * Settle the team after session init ran. `sessionTeamId` is the team that init registered, or the
 * team of a bypassed session that chose one; null when init gave none. A session team wins over a
 * fallback or predicted team, but only while the user is still a member of it. A deferred error
 * stands when no team is known.
 */
export async function settleTeamAfterInit(input: {
  config: TeamListConfig;
  spaceId: string;
  userId: string;
  userKey: string;
  first: RequestTeam | null;
  sessionTeamId: string | null;
  now?: number;
}): Promise<SettledTeam> {
  const { first, sessionTeamId } = input;
  if (first === null) return { teamId: null, error: null, changed: false };
  const firstTeamId = first.kind === "team" ? first.teamId : null;

  if (sessionTeamId) {
    const teamIds = await listMemberTeamIds(input.config, input.spaceId, input.userId, input.userKey, input.now);
    if (teamIds?.includes(sessionTeamId)) {
      return { teamId: sessionTeamId, error: null, changed: sessionTeamId !== firstTeamId };
    }
  }
  if (first.kind === "error") return { teamId: null, error: first, changed: false };
  return { teamId: first.teamId, error: null, changed: false };
}

/**
 * Settle the team of a request after session init, in one call: it reads the session once more
 * (read-only), because init may have registered the session or recorded a choice. Call it right
 * before the upstream is chosen, so a mem command or a form that needs no upstream is never
 * blocked by a team error.
 */
export async function settleRequestTeam(input: {
  config: TeamListConfig;
  spaceId: string;
  userId: string;
  userKey: string;
  first: RequestTeam | null;
  session: RequestTeamInput["session"];
  now?: number;
}): Promise<SettledTeam> {
  if (input.first === null) return { teamId: null, error: null, changed: false };
  let sessionTeamId: string | null = null;
  if (input.session) {
    const peek = await getSessionStore().peekForTeam(input.session.keyId, {
      userId: input.userId, agentSource: input.session.agentSource,
      sessionId: input.session.sessionId, spaceId: input.spaceId,
    });
    if (peek.state === "registered") sessionTeamId = peek.teamId;
  }
  const settled = await settleTeamAfterInit({ ...input, sessionTeamId });
  if (settled.changed) {
    console.log(`${TAG} team changed during session init team=${settled.teamId ?? "-"}`);
  }
  return settled;
}

// ── Error responses ──────────────────────────────────────────────────────────

/**
 * Answer for a team error in the envelope of the calling runner. `pool_exhausted` and
 * `pool_unavailable` use the pool's own answers, so a client handles them as it always did.
 */
export function teamErrorResponse(
  c: Context,
  envelope: "anthropic" | "openai",
  err: RequestTeamError,
  now: number = Date.now(),
): Response {
  if (err.code === "pool_exhausted") return buildPoolExhaustedResponse(err.resetAtMs ?? null, now);
  if (err.code === "pool_unavailable") return buildPoolUnavailableResponse();
  const headers: Record<string, string> = err.code === "team_list_unavailable" ? { "retry-after": String(TEAM_LIST_RETRY_AFTER_SEC) } : {};
  if (envelope === "anthropic") {
    return c.json({ type: "error", error: { type: err.code, message: err.message } }, err.status, headers);
  }
  return c.json({ code: err.status, error_code: err.code.toUpperCase(), message: err.message }, err.status, headers);
}

// ── Tests ────────────────────────────────────────────────────────────────────

/** Clear every cache of this module (for testing). */
export function clearTeamCaches(): void {
  membership.clear();
  membershipInFlight.clear();
  userDefaults.clear();
  teamListFetcher = coreTeamList;
}

/** Put a team list in the membership cache without a Core call (for testing). */
export function __primeMembershipForTests(spaceId: string, userId: string, teamIds: string[], ttlMs = 60_000): void {
  const now = Date.now();
  membership.set(membershipKey(spaceId, userId), { teamIds, freshUntil: now + ttlMs, staleUntil: now + MEMBERSHIP_STALE_MS });
}

/** Replace the Core call that lists the teams of a user (for testing). */
export function __setTeamListFetcherForTests(fetcher: TeamListFetcher | null): void {
  teamListFetcher = fetcher ?? coreTeamList;
}
