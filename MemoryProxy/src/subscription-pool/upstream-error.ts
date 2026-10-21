import { randomUUID } from "node:crypto";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import { assertKeySegment } from "../storage/key-utils.js";

export const MAX_ERROR_BODY_CHARS = 8192;
const SENSITIVE_FIELD = /^(?:authorization|proxy.authorization|x.api.key|api.key|user.key|access.token|refresh.token|id.token|token|password|secret|client.secret|cookie|set.cookie|credentials)$/i;

/** Redact before truncating, including credentials echoed inside an upstream error message. */
export function sanitizeErrorText(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join("[REDACTED]");
  }
  safe = safe.replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/((?:access_token|refresh_token|id_token|api_key|user_key|password|client_secret)\s*[=:]\s*)[^\s,;"'<>]+/gi, "$1[REDACTED]");
  try {
    return JSON.stringify(JSON.parse(safe), (key, value: unknown) => SENSITIVE_FIELD.test(key) ? "[REDACTED]" : value);
  } catch {
    return safe;
  }
}

/** Best effort diagnostics: survives restarts in ProxyStorage and uses its existing TTL policy. */
export async function recordPoolUpstreamError(input: {
  storage: ProxyStorage | null;
  spaceId: string;
  accountId: string;
  provider: string;
  model: string;
  status: number;
  body: string;
  headers: Headers;
  requestId: string | null;
  secrets: readonly string[];
  now: number;
}): Promise<void> {
  const safe = (value: string) => sanitizeErrorText(value, input.secrets);
  const body = safe(input.body);
  const record = {
    event: "subscription_pool.upstream_error",
    timestamp: new Date(input.now).toISOString(),
    space_id: input.spaceId,
    account_id: input.accountId,
    provider: input.provider,
    model: safe(input.model).slice(0, 256),
    status: input.status,
    request_id: safe(input.requestId ?? "").slice(0, 256),
    upstream_request_id: safe(input.headers.get("request-id") ?? input.headers.get("x-request-id") ?? "").slice(0, 256),
    retry_after: safe(input.headers.get("retry-after") ?? "").slice(0, 128),
    body: body.slice(0, MAX_ERROR_BODY_CHARS),
    body_truncated: body.length > MAX_ERROR_BODY_CHARS,
    original_body_bytes: Buffer.byteLength(input.body, "utf8"),
  };
  console.warn(`[subscription-pool] ${JSON.stringify(record)}`);
  if (!input.storage) return;
  try {
    assertKeySegment("spaceId", input.spaceId);
    assertKeySegment("accountId", input.accountId);
    await input.storage.putJSON(`ttl/${input.spaceId}/subscription-pool/errors/${input.accountId}/${input.now}-${randomUUID()}.json`, record);
  } catch {
    // Do not let diagnostic storage failure affect account switching or expose credentials.
    console.warn(`[subscription-pool] error diagnostic storage failed account_id=${input.accountId}`);
  }
}
