/**
 * `GET /v3/admin/hook-recall-log` — read the recall log of the client hook.
 *
 * Admin only: the same Bearer key as the other `/v3/admin` routes
 * (`admin.apiKey`). The rows hold user prompts and memory text, so this route
 * fails closed: without a configured admin key it answers 403. (The other
 * admin routes are open when the key is empty.)
 *
 * Query: `limit` (1-200, default 50), `offset` (default 0), and the optional
 * filters `user_id`, `agent_id`, `session_id`, `outcome` and `since` (ms epoch
 * or ISO-8601 time).
 */

import type { Context } from "hono";

import { getHookRecallLog } from "../db/hook-recall-log.js";
import type { ProxyConfig } from "../types.js";
import { adminAuthError, checkAdminAuth } from "./admin-auth.js";

const MAX_LIMIT = 200;
const FILTER_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function intParam(raw: string | undefined, def: number, min: number, max: number): number | null {
  if (raw === undefined || raw === "") return def;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

function sinceParam(raw: string | undefined): number | undefined | null {
  if (raw === undefined || raw === "") return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

export function createHookRecallLogHandler(config: ProxyConfig) {
  return (c: Context): Response => {
    if (!config.admin?.apiKey) {
      return c.json({ code: 403, message: "admin.apiKey is not configured; the recall log is not readable" }, 403);
    }
    const auth = checkAdminAuth(c, config.admin.apiKey);
    if (auth !== "ok") return adminAuthError(c, auth);

    const limit = intParam(c.req.query("limit"), 50, 1, MAX_LIMIT);
    const offset = intParam(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const since = sinceParam(c.req.query("since"));
    if (limit === null) return c.json({ code: 400, message: `limit must be an integer from 1 to ${MAX_LIMIT}` }, 400);
    if (offset === null) return c.json({ code: 400, message: "offset must be a non-negative integer" }, 400);
    if (since === null) return c.json({ code: 400, message: "since must be ms epoch or an ISO-8601 time" }, 400);
    const filters: Record<string, string | undefined> = {};
    for (const key of ["user_id", "agent_id", "session_id", "outcome"]) {
      const v = c.req.query(key);
      if (v === undefined || v === "") continue;
      if (!FILTER_RE.test(v)) return c.json({ code: 400, message: `invalid ${key}` }, 400);
      filters[key] = v;
    }

    const log = getHookRecallLog(config);
    if (!log) return c.json({ code: 503, message: "recall log unavailable" }, 503);
    try {
      const data = log.list({
        limit,
        offset,
        userId: filters.user_id,
        agentId: filters.agent_id,
        sessionId: filters.session_id,
        outcome: filters.outcome,
        since,
      });
      return c.json({ code: 0, message: "ok", data: { ...data, limit, offset } });
    } catch (err) {
      return c.json({ code: 503, message: err instanceof Error ? err.message : String(err) }, 503);
    }
  };
}
