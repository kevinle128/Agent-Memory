/**
 * Auth service client — verifies user_key and resolves user_id via auth/verify API.
 *
 * Features:
 * - Every call goes directly to the auth service. Only when the service cannot
 *   be reached (connection error, timeout, HTTP 5xx), a key that it verified in
 *   the last `staleOnErrorMs` stays accepted, so a MemoryCore restart does not
 *   reject every request. Unknown or rejected keys are never accepted this way.
 * - Returns structured result to allow caller to reject invalid keys
 * - x-tdai-service-id is derived from the request path's spaceId (not config)
 * - Configurable via YAML `auth` section
 */

import { createHash } from "node:crypto";
import { log } from "./report/log.js";
import type { AuthConfig } from "./types.js";

export type { AuthConfig };

/** Result of verifyUserKey call. */
export interface VerifyUserResult {
  /** User ID if verified successfully; empty string otherwise. */
  userId: string;
  /** True when auth is enabled and verification did NOT return valid=true. */
  rejected: boolean;
  /** Error detail for logging/response when rejected. */
  rejectReason?: string;
}

// ── Module state ──────────────────────────────────────────────────────────────

let config: AuthConfig | null = null;

/**
 * Last verification result per (service id, key hash). Keys are never stored.
 * `userId` is set after a success; `forgottenAtMs` after a refusal, so a slow
 * success that started before the refusal cannot bring the key back.
 */
const lastGood = new Map<string, { userId?: string; atMs: number; forgottenAtMs?: number }>();
const LAST_GOOD_MAX = 10_000;

function lastGoodKey(serviceId: string, userKey: string): string {
  return `${serviceId}\u0000${createHash("sha256").update(userKey).digest("hex")}`;
}

function store(k: string, entry: { userId?: string; atMs: number; forgottenAtMs?: number }): void {
  lastGood.delete(k);
  lastGood.set(k, entry);
  if (lastGood.size > LAST_GOOD_MAX) lastGood.delete(lastGood.keys().next().value as string);
}

function rememberGood(serviceId: string, userKey: string, userId: string, startedAtMs: number): void {
  const k = lastGoodKey(serviceId, userKey);
  const prev = lastGood.get(k);
  if (prev?.forgottenAtMs !== undefined && prev.forgottenAtMs >= startedAtMs) return;
  store(k, { userId, atMs: Date.now() });
}

/** Forget a key that the service rejected, so a revoked key is never served stale. */
function forgetGood(serviceId: string, userKey: string): void {
  const k = lastGoodKey(serviceId, userKey);
  if (!lastGood.has(k)) return;
  const now = Date.now();
  store(k, { atMs: now, forgottenAtMs: now });
}

/**
 * When the auth service is unavailable, accept a key it verified recently.
 * Returns null when there is no fresh enough earlier verification.
 */
function staleResult(serviceId: string, userKey: string, reason: string): VerifyUserResult | null {
  const windowMs = config?.staleOnErrorMs ?? 0;
  if (windowMs <= 0) return null;
  const hit = lastGood.get(lastGoodKey(serviceId, userKey));
  if (!hit?.userId || Date.now() - hit.atMs > windowMs) return null;
  log.warn("auth.verify.staleAccepted", { serviceId, ageMs: Date.now() - hit.atMs, reason });
  return { userId: hit.userId, rejected: false };
}

/** Clear remembered verifications. For tests. */
export function resetAuthCacheForTest(): void {
  lastGood.clear();
}

/**
 * Initialize the auth client.
 * Must be called once at startup. Idempotent.
 */
export function initAuth(cfg: AuthConfig): void {
  if (!cfg.enabled) {
    config = null;
    return;
  }
  if (!cfg.url) {
    log.warn("auth.init.skipped", { reason: "empty url" });
    config = null;
    return;
  }
  config = cfg;
  log.info("auth.init", { url: cfg.url, bearer: Boolean(cfg.apiKey) });
}

/** Check if auth verification is enabled. */
export function isAuthEnabled(): boolean {
  return config != null;
}

/**
 * Verify a user_key (API key from the client request) and resolve to a user_id.
 *
 * When auth is enabled, the principle is:
 * **Any result that is NOT valid=true with a user_id → reject the request.**
 *
 * @param userKey - The client's API key (user_key)
 * @param serviceId - The service/instance ID from request path spaceId (used as x-tdai-service-id)
 *
 * Returns a structured result:
 * - `{ userId: "usr-xxx", rejected: false }` — verified successfully
 * - `{ userId: "", rejected: true, rejectReason }` — auth enabled but verification failed
 * - `{ userId: "", rejected: false }` — auth not enabled (passthrough)
 *
 * This function never throws.
 * Each call queries the auth service; see the module comment for the one
 * fallback used while the service is unavailable.
 */
export async function verifyUserKey(userKey: string, serviceId: string): Promise<VerifyUserResult> {
  if (!config) return { userId: "", rejected: false };
  if (!serviceId) return { userId: "", rejected: true, rejectReason: "missing service_id (spaceId not in request path)" };
  if (!userKey) return { userId: "", rejected: true, rejectReason: "missing user_key" };

  const startedAtMs = Date.now();
  try {
    // A gateway-protected kernel (server.apiKey / TDAI_GATEWAY_API_KEY) answers 401 to
    // an unauthenticated verify call, so send the configured bearer like the sibling
    // tdai / skill clients do. Without one the request is unchanged.
    const fetchOpts: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-service-id": serviceId,
        ...(config.apiKey ? { "authorization": `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ user_key: userKey }),
    };
    if (config.timeoutMs > 0) {
      fetchOpts.signal = AbortSignal.timeout(config.timeoutMs);
    }

    const url = config.url.replace(/\/+$/, "") + "/v3/meta/auth/verify";
    const resp = await fetch(url, fetchOpts);

    if (!resp.ok) {
      const reason = `auth service returned HTTP ${resp.status}`;
      log.warn("auth.verify.httpError", { status: resp.status, serviceId });
      // A 5xx means the service is unavailable; a 4xx is a real refusal.
      if (resp.status >= 500) {
        const stale = staleResult(serviceId, userKey, reason);
        if (stale) return stale;
      } else {
        forgetGood(serviceId, userKey);
      }
      return { userId: "", rejected: true, rejectReason: reason };
    }

    let body: { code?: number; data?: { valid?: boolean; user?: { user_id?: string } } };
    try {
      body = await resp.json() as typeof body;
    } catch {
      // A 200 that is not JSON (for example an error page from something in
      // between) is not an answer from the auth service: refuse, no fallback.
      forgetGood(serviceId, userKey);
      return { userId: "", rejected: true, rejectReason: "auth service returned a non-JSON response" };
    }

    // Only accept: code=0 AND valid=true AND user_id present
    if (body.code === 0 && body.data?.valid === true && body.data.user?.user_id) {
      rememberGood(serviceId, userKey, body.data.user.user_id, startedAtMs);
      return { userId: body.data.user.user_id, rejected: false };
    }

    forgetGood(serviceId, userKey);
    // Everything else is a rejection
    const reason = body.data?.valid === false
      ? "invalid user_key"
      : `unexpected verify response (code=${body.code})`;
    return { userId: "", rejected: true, rejectReason: reason };
  } catch (err: unknown) {
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    const reason = isTimeout
      ? `auth service timeout (${config.timeoutMs}ms)`
      : `auth service error: ${err instanceof Error ? err.message : String(err)}`;
    log.warn("auth.verify.error", { error: reason, serviceId });
    const stale = staleResult(serviceId, userKey, reason);
    if (stale) return stale;
    return { userId: "", rejected: true, rejectReason: reason };
  }
}
