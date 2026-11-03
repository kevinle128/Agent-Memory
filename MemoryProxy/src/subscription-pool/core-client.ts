/**
 * Calls to the internal meta endpoints of Core (subscription pool, user roles). Same auth and
 * instance headers as the instance-upstream fetch. Access tokens are never logged here or by callers.
 */

import type { CoreSkillConfig } from "../types.js";

export type PoolCoreConfig = Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">;

const BASE_PATH = "/v3/internal/meta";

export class PoolCoreError extends Error {
  constructor(readonly path: string, readonly httpStatus: number, readonly errorCode?: string) {
    super(`pool core call ${path} failed: HTTP ${httpStatus}${errorCode ? ` (${errorCode})` : ""}`);
    this.name = "PoolCoreError";
  }
}

/** POST `body` to `/v3/internal/meta/<path>` and return the envelope `data`. */
export async function callInternalMeta<T>(
  config: PoolCoreConfig,
  spaceId: string,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const url = `${config.endpoint.replace(/\/$/, "")}${BASE_PATH}/${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.serviceToken}`,
      "x-tdai-service-id": spaceId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs || 3000)]) : AbortSignal.timeout(config.timeoutMs || 3000),
  });
  const env = await resp.json().catch(() => null) as
    | { code?: number; message?: string; data?: T }
    | null;
  if (!resp.ok || !env || env.code !== 0) {
    // Core error messages read "<error_code>: <detail>".
    const errorCode = typeof env?.message === "string" ? env.message.split(":")[0]?.trim() : undefined;
    throw new PoolCoreError(path, resp.status, errorCode);
  }
  return env.data as T;
}

/** POST `body` to `/v3/internal/meta/subscription-pool/<path>` and return the envelope `data`. */
export function callPoolCore<T>(
  config: PoolCoreConfig,
  spaceId: string,
  path: "accounts/list" | "report" | "refresh" | "check-usage",
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  return callInternalMeta<T>(config, spaceId, `subscription-pool/${path}`, body, signal);
}
