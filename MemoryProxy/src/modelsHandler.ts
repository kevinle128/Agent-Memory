/** OpenAI-compatible model discovery backed by the local pricing table. */

import type { Context, Next } from "hono";
import { verifyUserKey } from "./auth.js";
import { extractSpaceIdFromPath } from "./credit-reporter.js";
import { poolServiceFor } from "./guard-adapter.js";
import { getInstanceUpstreamConfigs, isPoolRow, type InstanceUpstreamRow } from "./instance-upstream-cache.js";
import { extractBearerToken } from "./opik.js";
import { authRejectionResponse } from "./pipeline/stages/auth.js";
import { isSourceRow } from "./pipeline/stages/model-source.js";
import { normalizePublicModelName } from "./pricing.js";
import { listMemberTeamIds } from "./subscription-pool/pool-team.js";
import { isMultiSourceAgent } from "./supported-agents.js";
import type { CreditPricingConfig, ProxyConfig } from "./types.js";

export interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

/** A model of a named source, listed as `<source>/<model>` for a multi-source agent. */
export interface SourceModelListing extends OpenAIModel {
  source: string;
  source_type: "subscription" | "api";
  provider: string;
  format: string;
  formats: string[];
  upstream_model: string;
  display_name: string;
}

export interface OpenAIModelsResponse {
  object: "list";
  data: OpenAIModel[];
}

/**
 * Builds the public model catalog from pricing entries accepted by
 * `isModelInPricing`: only non-empty `modelName` values are client-facing.
 * `extraIds` (the live model-pool service) are listed first.
 */
export function buildModelsResponse(pricing: CreditPricingConfig, extraIds: string[] = []): OpenAIModelsResponse {
  const ids = new Set<string>();
  const data: OpenAIModel[] = [];

  for (const rawId of [...extraIds, ...(pricing.models ?? []).map((entry) => entry.modelName)]) {
    const id = rawId?.trim() ?? "";
    const normalizedId = normalizePublicModelName(id);
    if (!normalizedId || ids.has(normalizedId)) continue;

    ids.add(normalizedId);
    data.push({ id, object: "model", created: 0, owned_by: "context-proxy" });
  }

  return { object: "list", data };
}

/**
 * Source models an agent may use: enabled models of enabled sources whose `source_agents` include
 * the agent. A subscription source follows the switch of its pool; an API source follows
 * `source_enabled`. Ordered by source name, then model id. A model id that two rows give (the
 * pools of two teams use the same source name) is listed once.
 */
export function listSourceModels(rows: InstanceUpstreamRow[], agent: string): SourceModelListing[] {
  const out: SourceModelListing[] = [];
  const listed = new Set<string>();
  const sources = rows
    .filter((row) => isSourceRow(row) && (row.source_agents ?? []).includes(agent))
    .sort((a, b) => (a.source_name! < b.source_name! ? -1 : a.source_name! > b.source_name! ? 1 : 0));

  for (const row of sources) {
    const isPool = row.mode === "subscription_pool";
    if (isPool ? !row.enabled : row.source_enabled !== true) continue;
    const formats = row.source_formats ?? [];
    if (formats.length === 0) continue;
    const source = row.source_name!;
    const models = (row.source_models ?? [])
      .filter((m) => m.enabled === true && m.available !== false && m.id)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const m of models) {
      if (listed.has(`${source}/${m.id}`)) continue;
      listed.add(`${source}/${m.id}`);
      out.push({
        id: `${source}/${m.id}`,
        object: "model",
        created: 0,
        owned_by: source,
        source,
        source_type: isPool ? "subscription" : "api",
        provider: row.source_provider ?? "",
        format: formats[0]!,
        formats: [...formats],
        upstream_model: m.id,
        display_name: m.display_name || m.id,
      });
    }
  }
  return out;
}

function agentFromPath(path: string): string {
  return path.split("?", 1)[0]!.split("/").filter(Boolean)[0] ?? "";
}

/** True when `<source>/<model>` listing applies to this request's agent. */
function usesSourceListing(config: ProxyConfig, agent: string): boolean {
  if (config.modelSources?.enabled !== true) return false;
  if (!isMultiSourceAgent(agent)) return false;
  const allowed = config.modelSources.agents;
  return !allowed || allowed.includes(agent);
}

interface ModelsAuth {
  spaceId: string;
  userId: string;
  apiKey: string;
}

/** Verifies the user key for the request space. Returns the caller or an error response. */
async function authenticate(c: Context): Promise<ModelsAuth | { response: Response }> {
  const spaceId = extractSpaceIdFromPath(c.req.path);
  if (!spaceId) {
    return { response: c.json({ error: "spaceId is required in the request path" }, 400) };
  }

  const apiKey = c.req.header("x-api-key")
    ?? extractBearerToken(c.req.header("authorization") ?? c.req.header("Authorization") ?? "")
    ?? "";
  const verified = await verifyUserKey(apiKey, spaceId);
  const denied = authRejectionResponse(c, verified, "openai");
  if (denied) return { response: denied };
  const { userId } = verified;
  return { spaceId, userId, apiKey };
}

/**
 * Rows the caller may list: every row that is not a pool, and the pool rows of the teams of the
 * caller. The source name of a pool repeats in every team, so a pool of another team must stay
 * out of the list. When the team list is not available the list holds the instance sources only;
 * it is read-only, so it does not fail.
 */
async function rowsOfCaller(config: ProxyConfig, auth: ModelsAuth): Promise<InstanceUpstreamRow[]> {
  const rows = await getInstanceUpstreamConfigs(config.coreSkill, auth.spaceId, config.instanceUpstream);
  if (!rows.some(isPoolRow)) return rows;
  const teamIds = await listMemberTeamIds(config, auth.spaceId, auth.userId, auth.apiKey);
  const mine = new Set(teamIds ?? []);
  return rows.filter((row) => !isPoolRow(row) || (typeof row.team_id === "string" && row.team_id !== "" && mine.has(row.team_id)));
}

/** Handles the tenant-scoped OpenAI-compatible `GET /v1/models` endpoint locally. */
export async function handleModels(c: Context, config: ProxyConfig): Promise<Response> {
  const auth = await authenticate(c);
  if ("response" in auth) return auth.response;

  c.header("cache-control", "no-store");
  const pool = poolServiceFor(config);
  const legacy = buildModelsResponse(config.creditPricing, pool.active ? [pool.serviceName] : []);

  const agent = agentFromPath(c.req.path);
  if (!usesSourceListing(config, agent)) return c.json(legacy);

  const rows = await rowsOfCaller(config, auth);
  const sourceModels = listSourceModels(rows, agent);
  const seen = new Set(sourceModels.map((m) => m.id));
  return c.json({
    object: "list",
    data: [...sourceModels, ...legacy.data.filter((m) => !seen.has(m.id))],
  });
}

/**
 * `GET /<agent>/:spaceId/v1/models/:model`. Multi-source agents get one source entry or an
 * OpenAI-style 404; every other agent (or a disabled switch) falls through to the old routing.
 */
export async function handleSourceModel(c: Context, config: ProxyConfig, next: Next): Promise<Response | void> {
  const agent = agentFromPath(c.req.path);
  if (!usesSourceListing(config, agent)) return next();

  const auth = await authenticate(c);
  if ("response" in auth) return auth.response;

  c.header("cache-control", "no-store");
  const id = c.req.param("model") ?? "";
  const rows = await rowsOfCaller(config, auth);
  const found = listSourceModels(rows, agent).find((m) => m.id === id);
  if (found) return c.json(found);
  return c.json({
    error: { message: `The model '${id}' does not exist`, type: "invalid_request_error", param: "model", code: "model_not_found" },
  }, 404);
}

/**
 * Hermes probes `POST /hermes/:spaceId/api/show` for the context length. Answer 404 locally so the
 * probe never reaches an upstream. With the switch off the old routing applies.
 */
export function handleHermesShow(c: Context, config: ProxyConfig, next: Next): Response | Promise<void> {
  if (!usesSourceListing(config, "hermes")) return next();
  return c.json({
    error: { message: "model details are not available", type: "invalid_request_error", code: "model_not_found" },
  }, 404);
}
