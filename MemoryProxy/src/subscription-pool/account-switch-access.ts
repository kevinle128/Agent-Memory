/**
 * Access check for the Account Switch: who may see or change the Subscription Account that serves
 * a session, and which Subscription Pool serves an agent.
 *
 * `canUseAccountSwitch` is the only place that decides the permission. Every caller (the status
 * block that the Proxy injects and the command bridge) must ask here, so the two can never give
 * different answers for the same user.
 *
 * A failed role lookup in Core (network, HTTP or envelope error) denies the request and is not
 * cached: a Core outage must not grant access, and the next check must ask Core again so that a
 * real System Admin gets access back as soon as Core recovers.
 */

import { getInstanceUpstreamConfigs, resolveForAgent, type InstanceUpstreamRow } from "../instance-upstream-cache.js";
import type { InstanceUpstreamConfig } from "../types.js";
import { callInternalMeta, type PoolCoreConfig } from "./core-client.js";
import { listMemberTeamIds } from "./pool-team.js";

const TAG = "[account-switch-access]";
const ALLOW_TTL_MS = 5 * 60_000;
const DENY_TTL_MS = 60_000;
const MAX_ENTRIES = 1000;

interface CacheEntry {
  allowed: boolean;
  expiresAt: number;
}

/** The parts of `ProxyConfig` that the checks read; a full `ProxyConfig` fits. */
interface AccessConfig {
  coreSkill: PoolCoreConfig;
  instanceUpstream?: Partial<InstanceUpstreamConfig>;
}

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<boolean>>();

/**
 * True when `userId` is a System Admin of the Memory instance `spaceId`. Results are cached per
 * instance and user; concurrent checks for the same key share one Core call.
 */
export async function canUseAccountSwitch(
  config: AccessConfig,
  input: { spaceId: string; userId: string },
): Promise<boolean> {
  const { spaceId, userId } = input;
  if (!spaceId || !userId || userId === "anonymous") return false;

  const key = `${spaceId}\0${userId}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.allowed;

  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const check = lookupSystemAdmin(config, spaceId, userId)
    .then((allowed) => {
      remember(key, allowed);
      return allowed;
    })
    .catch((err: unknown) => {
      console.warn(`${TAG} role lookup failed for spaceId=${spaceId}, access denied: ${err instanceof Error ? err.message : "unknown"}`);
      return false;
    })
    .finally(() => {
      pending.delete(key);
    });
  pending.set(key, check);
  return check;
}

/**
 * Core filters by user id and role. The row is checked again here: a Core that does not know the
 * role filter ignores it and would return a normal user, and that must never grant access.
 */
async function lookupSystemAdmin(config: AccessConfig, spaceId: string, userId: string): Promise<boolean> {
  const data = await callInternalMeta<{ items?: unknown }>(config.coreSkill, spaceId, "user/list-by-instance", {
    user_ids: [userId],
    user_type: "system_admin",
    limit: 1,
  });
  if (!data || !Array.isArray(data.items)) {
    throw new Error("user/list-by-instance returned no items array");
  }
  const rows = data.items as Array<{ user_id?: unknown; user_type?: unknown } | null>;
  return rows.length === 1 && rows[0]?.user_id === userId && rows[0]?.user_type === "system_admin";
}

function remember(key: string, allowed: boolean): void {
  // Delete first so that a rewritten key moves to the newest position of the Map.
  cache.delete(key);
  if (cache.size >= MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { allowed, expiresAt: Date.now() + (allowed ? ALLOW_TTL_MS : DENY_TTL_MS) });
}

/** The registered session whose pool the Account Switch looks up. */
export interface SwitchSession {
  userId: string;
  /** Key of the user that registered the session. Core reads the team list with it. */
  userKey: string;
  /** Team of the registered session. */
  teamId: string;
}

/**
 * The Subscription Pool that serves `agentSource` for a registered session, or null when the agent
 * has no Account Switch support, the session has no team, the user left the team, or the team has
 * no enabled pool for the agent. Only the pool of the team of the session is ever returned, so a
 * switch never lists the accounts of another team. A team list that cannot be read gives null.
 */
export async function resolveSwitchPool(
  config: AccessConfig,
  spaceId: string,
  agentSource: string,
  session: SwitchSession,
): Promise<{ provider: "claude" | "codex" | "antigravity"; row: InstanceUpstreamRow } | null> {
  const provider = agentSource === "claude-code" ? "claude"
    : agentSource === "codex" ? "codex"
      : agentSource === "antigravity" ? "antigravity" : null;
  if (!provider || !session.teamId || !session.userKey) return null;
  const teamIds = await listMemberTeamIds(config, spaceId, session.userId, session.userKey);
  if (!teamIds?.includes(session.teamId)) return null;
  const resolution = resolveForAgent(
    await getInstanceUpstreamConfigs(config.coreSkill, spaceId, config.instanceUpstream),
    agentSource,
    session.teamId,
  );
  if (resolution.kind !== "pool") return null;
  return { provider, row: resolution.row };
}

export function resetAccountSwitchAccessForTests(): void {
  cache.clear();
  pending.clear();
}
