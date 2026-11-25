/**
 * stages/auth.ts — early-auth stage (Phase 1)。
 *
 * 提取自 4 处近乎相同的代码:
 *   - handler.ts:461-471
 *   - anthropicHandler.ts:544-553  (用 extractApiKey 支持 x-api-key)
 *   - codexHandler.ts:309-323      (显式 fallback x-api-key + 组 keyId)
 *   - workbuddyHandler.ts:1108-1124 (同 codex)
 *
 * 差异只有两点, 都保留:
 *   1. apiKey 提取源:
 *      - handler 只认 Bearer
 *      - anthropic/codex/wb 支持 Bearer + x-api-key fallback
 *      - 统一策略: 都支持 x-api-key fallback, handler 走 Bearer 时 x-api-key
 *        永远 undefined, 行为等价
 *   2. rejected 时错误 envelope 格式:
 *      - openai (handler/codex/wb): `{error: "..."}`
 *      - anthropic:                 `{type:"error",error:{type,message}}`
 *      - 由调用方 (protocol.buildErrorResponse) 决定, 本 stage 只返 rejected 结果
 *
 * ⚠️ 顺序保持: verifyUserKey 必须在 body parse 之前, 拒绝流量不消耗 body reader。
 */

import type { Context } from "hono";
import { verifyUserKey } from "../../auth.js";
import { extractBearerToken, apiKeyToKeyId } from "../../opik.js";
import { extractSpaceIdFromPath } from "../../credit-reporter.js";

export interface AuthStageResult {
  /** Bearer/x-api-key 提取出来的原始 API key */
  apiKey: string;
  /** rejected=false 时保证非空; verifyUserKey 返回的 userId 或 fallback keyId */
  keyId: string;
  /** verifyUserKey 返回的 userId (可能为空字符串) */
  userId: string;
  /** URL 中提取的 spaceId (可能为空字符串) */
  spaceId: string;
  /** 只在 rejected=true 时有意义, 语义与 verifyUserKey 一致 */
  rejected: boolean;
  rejectReason?: string;
  /** Set only when MemoryCore could not answer and the key was not refused. */
  unavailable?: boolean;
}

/**
 * API key 提取模式 (老 4 个 handler 各不相同, 迁移时保留):
 *   - "bearer-only" (handler.ts): 只认 Bearer, 忽略 x-api-key
 *   - "bearer-first" (codex/wb/utility): Bearer 优先, x-api-key 兜底
 *   - "xapi-first" (anthropic): x-api-key 优先, Bearer 兜底
 * 这三种模式在同时带两种 header 时结果不同 (anthropic 走 x-api-key,
 * codex/wb 走 Bearer)。stage 必须显式支持 3 种。
 */
export type ApiKeyExtractionMode = "bearer-only" | "bearer-first" | "xapi-first";

/**
 * 从 Hono Context 提取 API key。
 *
 * When `x-tdai-user-key` is present it is the user key, and `Authorization` / `x-api-key` stay
 * the client's own credentials (for example the ChatGPT login of Codex). Without the header
 * the behavior is unchanged.
 */
export function extractApiKeyFromContext(
  c: Context,
  mode: ApiKeyExtractionMode = "bearer-first",
): string {
  // An empty or blank header counts as absent, the same as for the pool's client-login check.
  const userKeyHeader = c.req.header("x-tdai-user-key")?.trim();
  if (userKeyHeader) return userKeyHeader;
  const xApiKey = c.req.header("x-api-key");
  const bearer = extractBearerToken(
    c.req.header("authorization") ?? c.req.header("Authorization") ?? "",
  );
  if (mode === "xapi-first") {
    if (xApiKey) return xApiKey;
    return bearer ?? "";
  }
  if (mode === "bearer-only") {
    return bearer ?? "";
  }
  // bearer-first (default)
  if (bearer) return bearer;
  if (xApiKey) return xApiKey;
  return "";
}

const MEMORY_UNAVAILABLE_MESSAGE = "Memory service temporarily unavailable. Please retry.";
const RETRY_AFTER = { "retry-after": "5" };

export type AuthRejectionShape = "openai" | "anthropic" | "hook";

/**
 * A rejected key stays 401. A MemoryCore outage is 503 with retry-after, and the
 * body avoids words that a client rewrites into a sign-in prompt.
 * Returns null when the caller was accepted.
 */
export function authRejectionResponse(
  c: Context,
  auth: { rejected: boolean; unavailable?: boolean; rejectReason?: string },
  shape: AuthRejectionShape,
): Response | null {
  if (!auth.rejected) return null;
  if (auth.unavailable) {
    if (shape === "anthropic") {
      return c.json(
        { type: "error", error: { type: "api_error", message: MEMORY_UNAVAILABLE_MESSAGE } },
        503,
        RETRY_AFTER,
      );
    }
    if (shape === "hook") {
      return c.json({ error: "service_unavailable", reason: auth.rejectReason }, 503, RETRY_AFTER);
    }
    return c.json({ error: MEMORY_UNAVAILABLE_MESSAGE }, 503, RETRY_AFTER);
  }
  if (shape === "anthropic") {
    return c.json(
      { type: "error", error: { type: "authentication_error", message: `Authentication failed: ${auth.rejectReason ?? "unknown"}` } },
      401,
    );
  }
  if (shape === "hook") {
    return c.json({ error: "unauthorized", reason: auth.rejectReason }, 401);
  }
  return c.json({ error: `Authentication failed: ${auth.rejectReason ?? "unknown"}` }, 401);
}

/**
 * Early auth stage — 在 body 解析之前跑, 拒绝的请求短路。
 *
 * `rejected` with `unavailable` is a MemoryCore outage (503). Any other
 * rejection is a real key refusal (401).
 */
export async function stageAuth(
  c: Context,
  mode: ApiKeyExtractionMode = "bearer-first",
): Promise<AuthStageResult> {
  const apiKey = extractApiKeyFromContext(c, mode);
  const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const verify = await verifyUserKey(apiKey, spaceId);
  if (verify.rejected) {
    return {
      apiKey,
      keyId: "",
      userId: "",
      spaceId,
      rejected: true,
      rejectReason: verify.rejectReason,
      ...(verify.unavailable ? { unavailable: true } : {}),
    };
  }
  const userId = verify.userId;
  const keyId = userId || (apiKey ? apiKeyToKeyId(apiKey) : "unknown");
  return { apiKey, keyId, userId, spaceId, rejected: false };
}
