import { isIP } from "node:net";
import { redactSecrets } from "../core/report/llm-error-classifier.js";
import type { SourceModelEntry, SubscriptionAccountEntity } from "../metadata/types.js";
import {
  SubscriptionProviderError,
  shortMessage,
  type FetchModelsOptions,
  type SourceModelReading,
  type SubscriptionFetch,
  type SubscriptionProviderAdapter,
} from "./providers/types.js";

/** Longest model list body read from an API source. */
const MAX_BODY_CHARS = 8 * 1024 * 1024;
const API_TIMEOUT_MS = 10_000;

/** Raised when a model list cannot be read. The text is safe to store: it holds no token or key. */
export class ModelCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelCatalogError";
  }
}

/** Hosts of this server that a source must never point at. */
const INTERNAL_HOSTS = new Set(["localhost", "memory-core", "0.0.0.0", "::", "::1", "metadata.google.internal"]);

function isInternalIPv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p))) return false;
  const [a, b] = parts;
  return a === 127 || a === 0 || (a === 169 && b === 254);
}

/** `::ffff:7f00:1` (the form URL parsing gives `::ffff:127.0.0.1`) as dotted IPv4, or undefined. */
function ipv4OfMappedIPv6(host: string): string | undefined {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!match) return /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
  const high = parseInt(match[1], 16);
  const low = parseInt(match[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** Parses the base URL of an API source and refuses addresses that lead into this server. */
export function parseFetchableBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new ModelCatalogError("base_url is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ModelCatalogError("base_url must use http or https");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const mappedV4 = ipv4OfMappedIPv6(host);
  if (
    INTERNAL_HOSTS.has(host)
    || host.endsWith(".localhost")
    || (isIP(host) === 4 && isInternalIPv4(host))
    || (mappedV4 !== undefined && isInternalIPv4(mappedV4))
  ) {
    throw new ModelCatalogError("base_url points at an internal address");
  }
  return url;
}

/**
 * `<base>/models`. An Anthropic base without a version segment gets `/v1`, like the request path
 * the proxy builds; an OpenAI-compatible base is used as written.
 */
export function apiModelsUrl(baseUrl: string, sourceProvider: string): string {
  const url = parseFetchableBaseUrl(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  const versioned = /\/v\d+$/.test(path);
  url.pathname = `${path}${sourceProvider === "anthropic" && !versioned ? "/v1" : ""}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export interface ApiSourceInput {
  base_url: string;
  api_key: string;
  source_provider: string;
}

/** Lists the models of an API-key source with `GET <base_url>/models`. */
export async function fetchApiSourceModels(
  group: ApiSourceInput,
  fetchImpl: SubscriptionFetch = fetch,
): Promise<SourceModelReading[]> {
  const url = apiModelsUrl(group.base_url, group.source_provider);
  const headers: Record<string, string> = group.source_provider === "anthropic"
    ? { "x-api-key": group.api_key, "anthropic-version": "2023-06-01", accept: "application/json" }
    : { authorization: `Bearer ${group.api_key}`, accept: "application/json" };
  const response = await fetchImpl(url, { headers, redirect: "error", signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!response.ok) throw new ModelCatalogError(`provider returned ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_BODY_CHARS) throw new ModelCatalogError("model list is too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ModelCatalogError("provider returned a body that is not JSON");
  }
  return parseOpenAiModels(body);
}

/** Reads `data[].id` (OpenAI-compatible) or a bare array of the same items. */
export function parseOpenAiModels(body: unknown): SourceModelReading[] {
  const list = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  const models = new Map<string, SourceModelReading>();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) continue;
    const name = typeof record.display_name === "string" ? record.display_name.trim()
      : typeof record.name === "string" ? record.name.trim() : "";
    models.set(id, { id, display_name: name || id });
  }
  return [...models.values()];
}

/**
 * Merges a fresh model list into the stored one. Models seen before keep their `enabled` choice;
 * new models start as `newModelsEnabled`; models the provider no longer lists stay with
 * `available: false`.
 */
export function mergeSourceModels(
  existing: readonly SourceModelEntry[],
  readings: readonly SourceModelReading[],
  newModelsEnabled: boolean,
  now: string,
): SourceModelEntry[] {
  const known = new Map(existing.map((model) => [model.id, model]));
  const seen = new Set<string>();
  const merged: SourceModelEntry[] = [];
  for (const reading of readings) {
    if (seen.has(reading.id)) continue;
    seen.add(reading.id);
    const previous = known.get(reading.id);
    merged.push(previous
      ? { ...previous, display_name: reading.display_name, available: true, last_seen_at: now }
      : {
        id: reading.id,
        display_name: reading.display_name,
        enabled: newModelsEnabled,
        available: true,
        first_seen_at: now,
        last_seen_at: now,
      });
  }
  for (const model of existing) {
    if (!seen.has(model.id)) merged.push({ ...model, available: false });
  }
  return merged;
}

/** Error text for `source_models_error`: redacted, bounded, and free of the given secrets. */
export function describeFetchError(error: unknown, secrets: readonly string[] = []): string {
  let text: string;
  if (error instanceof ModelCatalogError || error instanceof SubscriptionProviderError) {
    text = error.message;
  } else if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    text = "request timed out";
  } else if (error instanceof Error && error.name === "TypeError") {
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    text = typeof code === "string" ? `network error (${code})` : "network error";
  } else {
    text = error instanceof Error ? `fetch failed (${error.name})` : "fetch failed";
  }
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.split(secret).join("[redacted]");
  }
  return shortMessage(redactSecrets(text)) ?? "fetch failed";
}

export interface PoolFetchDeps {
  adapterFor: (provider: SubscriptionAccountEntity["provider"]) => SubscriptionProviderAdapter | null;
  /**
   * Refreshes the token of an account after a 401. `heldExpiresAt` is the expiry of the token that
   * was refused. Returns the account to retry with, or null when it cannot be refreshed.
   */
  refreshAfterUnauthorized: (account: SubscriptionAccountEntity) => Promise<SubscriptionAccountEntity | null>;
  options?: FetchModelsOptions;
  onAccountError?: (accountId: string, error: unknown) => void;
}

export interface PoolFetchResult {
  models: SourceModelReading[];
  /** Accounts that answered with a model list. */
  succeeded: number;
  /** Last error when no account succeeded. */
  lastError: unknown;
}

/**
 * Reads the model list of every given account and merges the lists (plans can differ). An account
 * that answers 401 gets one token refresh and one retry; any other failure moves to the next one.
 */
export async function fetchPoolSourceModels(
  accounts: readonly SubscriptionAccountEntity[],
  deps: PoolFetchDeps,
): Promise<PoolFetchResult> {
  const models = new Map<string, SourceModelReading>();
  let succeeded = 0;
  let lastError: unknown = new ModelCatalogError("no active account in the pool");
  for (const account of accounts) {
    const adapter = deps.adapterFor(account.provider);
    if (!adapter) continue;
    let current = account;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const readings = await adapter.fetchModels(current.access_token, current.provider_account_id, deps.options);
        for (const reading of readings) if (!models.has(reading.id)) models.set(reading.id, reading);
        succeeded += 1;
        break;
      } catch (error) {
        lastError = error;
        deps.onAccountError?.(account.account_id, error);
        if (attempt === 0 && error instanceof SubscriptionProviderError && error.status === 401) {
          const refreshed = await deps.refreshAfterUnauthorized(current).catch(() => null);
          if (refreshed) {
            current = refreshed;
            continue;
          }
        }
        break;
      }
    }
  }
  return { models: [...models.values()], succeeded, lastError };
}
