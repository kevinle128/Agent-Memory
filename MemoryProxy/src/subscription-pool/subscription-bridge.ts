/**
 * Subscription bridge: a System Admin sees or changes the Subscription Account that serves the
 * current conversation. The model calls it with Bash curl and writes the answer from the JSON.
 *
 * Contract (all routes are POST with `content-type: application/json`):
 *
 *   Headers  `x-conversation-id` (or `x-parent-conversation-id`, which wins, so a subagent
 *            acts on its parent conversation) and `x-tdai-service-id`.
 *
 *   POST /subscription-bridge/v1/current   body `{}`
 *     200 `{ code: 0, message, data: { provider, state, account } }`
 *       state "bound"     account `{ account_id, email, display_name, account_label }`
 *       state "unbound"   account null; the pool picks an account on the next request
 *       state "own_login" account null; the last turn used the client's own login
 *
 *   POST /subscription-bridge/v1/switch    body `{ "email": string }`
 *     200 `{ code: 0, message: "ok", data: { provider, changed, previous: { email } | null,
 *           current: { email, display_name } } }`
 *
 *   Errors `{ code, message, reason, data? }`:
 *     400 40001 invalid_json, invalid_email
 *     401 40101 missing_conversation_id, session_not_initialized
 *     403 40301 not_system_admin
 *     404 40401 unknown_path, account_not_in_pool
 *     405 40501 method_not_allowed
 *     409 40901 not_pool_session, account_ambiguous, account_disabled, account_needs_login,
 *               account_exhausted, account_above_threshold
 *               (the last two have `data.resets_at` as ISO 8601 and `data.resets_at_ms` as epoch
 *               milliseconds, both null when unknown; above_threshold also has `data.usage_pct`
 *               and `data.threshold_pct`)
 *     415 41501 content_type_invalid
 *     503 50301 storage_unavailable, pool_unavailable
 *
 * The permission comes only from `canUseAccountSwitch`. The provider and the space come from the
 * session that the Proxy knows, never from a default or from config: a wrong space gives a valid
 * binding key that no pool request reads. A switch changes only the Session Binding of this
 * conversation; after it the pool treats the binding as usual and can still move it when the
 * account runs out of quota. Responses never carry tokens, and logs carry account ids only.
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import { getSessionStore } from "../session/store.js";
import { getProxyStorage } from "../storage/factory.js";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import { getPoolSnapshot } from "./account-cache.js";
import { canUseAccountSwitch, resolveSwitchPool } from "./account-switch-access.js";
import { getBinding, rebindSession, sessionBindingKey, type SessionBinding } from "./binding-store.js";
import {
  clearSessionClientLogin, isSessionOnClientLogin, poolSessionKey, reportPoolSessionCounts, type PoolProviderId,
} from "./pool-request.js";
import { accountSwitchRejection, type AccountSwitchRejection } from "./selector.js";
import type { PoolAccount } from "./types.js";

const TAG = "[subscription-bridge]";
const PATH_PREFIX = "/subscription-bridge/v1/";
const MAX_EMAIL_LENGTH = 254;
/** Agents that a Subscription Pool serves. The session key in the session store has this prefix. */
const POOL_AGENTS = ["claude-code", "codex"] as const;

type Action = "current" | "switch";

interface PoolSession {
  sessionId: string;
  spaceId: string;
  userId: string;
  agentSource: string;
}

/** Ends the request with an error envelope. */
class BridgeError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number,
    readonly reason: string,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function json(body: Record<string, unknown>, httpStatus = 200): Response {
  return new Response(JSON.stringify(body), { status: httpStatus, headers: { "content-type": "application/json" } });
}

function errorResponse(err: BridgeError): Response {
  return json({ code: err.code, message: err.message, reason: err.reason, ...(err.data ? { data: err.data } : {}) }, err.httpStatus);
}

const notPoolSession = (): BridgeError =>
  new BridgeError(409, 40901, "not_pool_session", "This conversation is not served by a Claude Code or Codex Subscription Pool.");

const storageUnavailable = (): BridgeError =>
  new BridgeError(503, 50301, "storage_unavailable", "The Proxy storage is not available. Try again later.");

/** First word of the label that holds an "@". Empty when the label has no e-mail. */
export function accountEmail(account: Pick<PoolAccount, "account_label">): string {
  return (account.account_label ?? "").split(/\s+/).find((word) => word.includes("@")) ?? "";
}

function describeAccount(account: PoolAccount): Record<string, string> {
  return {
    account_id: account.account_id,
    email: accountEmail(account),
    display_name: account.display_name ?? "",
    account_label: account.account_label ?? "",
  };
}

function headerValue(c: Context, name: string): string {
  return c.req.header(name)?.trim() ?? "";
}

/** A subagent sends its parent's id, so it acts on the same Session Binding as the parent. */
function deriveSessionId(c: Context): string {
  return headerValue(c, "x-parent-conversation-id") || headerValue(c, "x-conversation-id");
}

/**
 * The session in the in-memory session store, then in the long-lived identity binding. Only the
 * agents that a pool serves are tried in memory, so the key prefix gives the agent. A session
 * without a known space is skipped in memory: the identity binding is keyed by the space.
 */
async function findSession(sessionId: string, headerSpaceId: string): Promise<PoolSession> {
  const store = getSessionStore();
  for (const agentSource of POOL_AGENTS) {
    const state = store.get(`${agentSource}:${sessionId}`);
    const info = state?.status === "initialized" ? state.sessionInfo : null;
    if (!info?.user_id || !info.space_id) continue;
    if (headerSpaceId && headerSpaceId !== info.space_id) throw notPoolSession();
    return { sessionId, spaceId: info.space_id, userId: info.user_id, agentSource };
  }

  const bindingRepo = store.getBindingRepo();
  if (!bindingRepo || !headerSpaceId) {
    throw new BridgeError(401, 40101, "session_not_initialized", "The Proxy does not know this conversation yet.");
  }
  let binding;
  try {
    binding = await bindingRepo.getBinding(headerSpaceId, sessionId);
  } catch (err) {
    console.warn(`${TAG} identity binding read failed space=${headerSpaceId}: ${err instanceof Error ? err.message : "unknown"}`);
    throw storageUnavailable();
  }
  if (!binding || binding.outcome !== "initialized" || !binding.userId) {
    throw new BridgeError(401, 40101, "session_not_initialized", "The Proxy does not know this conversation yet.");
  }
  // An old binding without an agent gives no provider. Never guess one.
  if (binding.agentSource !== "claude-code" && binding.agentSource !== "codex") throw notPoolSession();
  return { sessionId, spaceId: headerSpaceId, userId: binding.userId, agentSource: binding.agentSource };
}

async function readEmail(c: Context): Promise<string> {
  let parsed: unknown;
  try {
    const raw = await c.req.text();
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new BridgeError(400, 40001, "invalid_json", "The body must be a JSON object.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BridgeError(400, 40001, "invalid_json", "The body must be a JSON object.");
  }
  const email = (parsed as { email?: unknown }).email;
  const value = typeof email === "string" ? email.trim() : "";
  if (!value || !value.includes("@") || value.length > MAX_EMAIL_LENGTH) {
    throw new BridgeError(400, 40001, "invalid_email", "Give the e-mail of the account in the body: {\"email\": \"name@example.com\"}.");
  }
  return value.toLowerCase();
}

function isoOrNull(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}

function rejectionError(rejection: AccountSwitchRejection): BridgeError {
  switch (rejection.reason) {
    case "account_disabled":
      return new BridgeError(409, 40901, rejection.reason, "The account is disabled in the pool.");
    case "account_needs_login":
      return new BridgeError(409, 40901, rejection.reason, "The account needs a new login in the pool admin panel.");
    case "account_exhausted": {
      const at = isoOrNull(rejection.resets_at);
      return new BridgeError(409, 40901, rejection.reason,
        at ? `The account is exhausted until ${at}.` : "The account is exhausted. Its reset time is unknown.",
        { resets_at: at, resets_at_ms: rejection.resets_at });
    }
    case "account_above_threshold": {
      const at = isoOrNull(rejection.resets_at);
      return new BridgeError(409, 40901, rejection.reason,
        `The account has used ${rejection.usage_pct}% of its quota, which is at or above the pool threshold of ${rejection.threshold_pct}%.`
          + (at ? ` Its usage resets at ${at}.` : ""),
        { resets_at: at, resets_at_ms: rejection.resets_at, usage_pct: rejection.usage_pct, threshold_pct: rejection.threshold_pct });
    }
  }
}

export interface SubscriptionBridgeDeps {
  now?: () => number;
}

export function createSubscriptionBridgeHandler(
  config: ProxyConfig,
  deps: SubscriptionBridgeDeps = {},
): (c: Context) => Promise<Response> {
  const clock = deps.now ?? Date.now;

  return async (c: Context): Promise<Response> => {
    try {
      const path = new URL(c.req.url).pathname.replace(/\/+$/, "");
      const action = path.startsWith(PATH_PREFIX) ? path.slice(PATH_PREFIX.length) : "";
      if (action !== "current" && action !== "switch") {
        throw new BridgeError(404, 40401, "unknown_path", `Unknown path ${path}. Use ${PATH_PREFIX}current or ${PATH_PREFIX}switch.`);
      }
      if (c.req.method !== "POST") {
        throw new BridgeError(405, 40501, "method_not_allowed", `Method ${c.req.method} is not allowed. Use POST.`);
      }
      if (!(c.req.header("content-type") ?? "").toLowerCase().includes("application/json")) {
        throw new BridgeError(415, 41501, "content_type_invalid", "The content-type must be application/json.");
      }

      const sessionId = deriveSessionId(c);
      if (!sessionId) {
        throw new BridgeError(401, 40101, "missing_conversation_id", "The x-conversation-id header is missing.");
      }
      const session = await findSession(sessionId, headerValue(c, "x-tdai-service-id"));
      return await handleAction(config, action, session, c, clock());
    } catch (err) {
      if (err instanceof BridgeError) return errorResponse(err);
      console.error(`${TAG} unexpected error: ${err instanceof Error ? err.message : "unknown"}`);
      return json({ code: 50001, message: "The subscription bridge failed. Try again later.", reason: "internal_error" }, 500);
    }
  };
}

async function handleAction(config: ProxyConfig, action: Action, session: PoolSession, c: Context, now: number): Promise<Response> {
  const { spaceId } = session;
  if (!(await canUseAccountSwitch(config, { spaceId, userId: session.userId }))) {
    throw new BridgeError(403, 40301, "not_system_admin", "Only a System Admin can see or change the subscription account.");
  }
  const pool = await resolveSwitchPool(config, spaceId, session.agentSource);
  if (!pool) throw notPoolSession();
  const { provider, row } = pool;

  let storage: ProxyStorage;
  try {
    storage = getProxyStorage(config.storage);
  } catch (err) {
    console.warn(`${TAG} storage unavailable: ${err instanceof Error ? err.message : "unknown"}`);
    throw storageUnavailable();
  }

  let key: string;
  try {
    key = sessionBindingKey(spaceId, provider, poolSessionKey(session.sessionId));
  } catch (err) {
    console.warn(`${TAG} no binding key for space=${spaceId}: ${err instanceof Error ? err.message : "unknown"}`);
    throw notPoolSession();
  }

  // Read the email before Core is called, so a bad body costs nothing.
  const email = action === "switch" ? await readEmail(c) : "";

  // A switch reads Core again, so it never judges an account by an old usage reading.
  const snapshot = await getPoolSnapshot(config.coreSkill, spaceId, config.instanceUpstream, now, action === "switch");
  if (snapshot.unavailable) {
    throw new BridgeError(503, 50301, "pool_unavailable", "The pool account list is not available. Try again later.");
  }
  // Core can send accounts of more than one pool group; only the group of this agent counts.
  const accounts = snapshot.accounts.filter((account) => account.group_id === row.group_id && account.provider === provider);

  let binding: SessionBinding | null;
  try {
    binding = await getBinding(storage, key, now);
  } catch (err) {
    console.warn(`${TAG} binding read failed space=${spaceId}: ${err instanceof Error ? err.message : "unknown"}`);
    throw storageUnavailable();
  }

  if (action === "current") return current(provider, accounts, binding, key, now);
  return switchAccount(config, {
    provider, spaceId, storage, key, accounts, binding, email, now, thresholdPct: snapshot.thresholdPct,
  });
}

function current(
  provider: PoolProviderId,
  accounts: readonly PoolAccount[],
  binding: SessionBinding | null,
  key: string,
  now: number,
): Response {
  if (isSessionOnClientLogin(key, now)) {
    return json({
      code: 0,
      message: "This conversation uses your own login, not the pool.",
      data: { provider, state: "own_login", account: null },
    });
  }
  const bound = binding ? accounts.find((account) => account.account_id === binding.account_id) : undefined;
  if (bound) {
    const described = describeAccount(bound);
    const name = described.email || described.display_name || described.account_id;
    return json({
      code: 0,
      message: `This conversation uses the ${provider} account ${name}.`,
      data: { provider, state: "bound", account: described },
    });
  }
  return json({
    code: 0,
    message: "No account is bound to this conversation yet. The pool picks one on the next request.",
    data: { provider, state: "unbound", account: null },
  });
}

interface SwitchInput {
  provider: PoolProviderId;
  spaceId: string;
  storage: ProxyStorage;
  key: string;
  accounts: readonly PoolAccount[];
  binding: SessionBinding | null;
  email: string;
  now: number;
  thresholdPct: number;
}

async function switchAccount(config: ProxyConfig, input: SwitchInput): Promise<Response> {
  const { provider, spaceId, storage, key, accounts, binding, email, now } = input;
  const matches = accounts.filter((account) => accountEmail(account).toLowerCase() === email);
  if (matches.length === 0) {
    throw new BridgeError(404, 40401, "account_not_in_pool", `No ${provider} account with this email is in the pool of this conversation.`);
  }
  if (matches.length > 1) {
    throw new BridgeError(409, 40901, "account_ambiguous", `More than one ${provider} account in the pool has this email. Ask an admin to fix the accounts.`);
  }
  const target = matches[0]!;
  const rejection = accountSwitchRejection(target, now, input.thresholdPct);
  if (rejection) {
    console.info(`${TAG} account switch refused space=${spaceId} provider=${provider} to=${target.account_id} reason=${rejection.reason}`);
    throw rejectionError(rejection);
  }

  const currentAccount = { email: accountEmail(target), display_name: target.display_name ?? "" };
  if (binding?.account_id === target.account_id && !isSessionOnClientLogin(key, now)) {
    return json({
      code: 0,
      message: "ok",
      data: { provider, changed: false, previous: { email: currentAccount.email }, current: currentAccount },
    });
  }

  try {
    await rebindSession(storage, key, target.account_id, now);
  } catch (err) {
    console.warn(`${TAG} binding write failed space=${spaceId}: ${err instanceof Error ? err.message : "unknown"}`);
    throw storageUnavailable();
  }
  clearSessionClientLogin(key);
  reportPoolSessionCounts(config.coreSkill, storage, spaceId, provider, [target.account_id, binding?.account_id], now);
  console.info(`${TAG} account switch space=${spaceId} provider=${provider} from=${binding?.account_id ?? "none"} to=${target.account_id}`);

  const previousAccount = binding ? accounts.find((account) => account.account_id === binding.account_id) : undefined;
  return json({
    code: 0,
    message: "ok",
    data: {
      provider,
      changed: true,
      previous: binding ? { email: previousAccount ? accountEmail(previousAccount) : "" } : null,
      current: currentAccount,
    },
  });
}
