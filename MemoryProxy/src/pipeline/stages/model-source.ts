/**
 * stages/model-source.ts — route `<source>/<model>` model names of multi-source agents.
 *
 * A model source is an upstream group with a `source_name`: a `custom_unified` group (base URL +
 * key) or a `subscription_pool` group. A multi-source agent (omp, hermes, openclaw) sends
 * `model: "<source>/<model>"`. This stage finds the group, checks the agent, the group switch, the
 * wire format and the enabled model list, and hands back the resolution the runners already know:
 *   - subscription_pool → { kind: "pool" }, handled by the pool branch of the runner;
 *   - custom_unified    → { kind: "override" } with a copy of the row whose `model_id` is the
 *                         real model id, handled by stageInstanceUpstreamOverride.
 *
 * A pool source is found only in the pool row of the request team (`teamId`).
 *
 * The stage returns `none` before it reads the cache or the body when the switch is off, the agent
 * is not multi-source, the agent is outside `modelSources.agents`, or the model has no known
 * prefix. Claude Code and Codex are not multi-source, so they never reach the cache.
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import {
  getInstanceUpstreamConfigs,
  isPoolRow,
  type InstanceUpstreamRow,
  type Resolution,
} from "../../instance-upstream-cache.js";
import { isMultiSourceAgent } from "../../supported-agents.js";

export type ModelSourceFormat = "anthropic-messages" | "openai-chat" | "openai-responses" | "gemini";

export type ModelSourceErrorCode =
  | "model_source_not_allowed"
  | "model_source_disabled"
  | "model_format_mismatch"
  | "model_not_enabled";

export type ModelSourceResolution = Extract<Resolution, { kind: "override" | "pool" }>;

export type ModelSourceResult =
  | { kind: "none" }
  | { kind: "error"; code: ModelSourceErrorCode; message: string; detail: Record<string, unknown> }
  | {
      kind: "matched";
      sourceName: string;
      sourceType: "subscription" | "api";
      groupId: string;
      format: ModelSourceFormat;
      /** The model name as the client sent it, with the prefix. Shown back to the client. */
      clientModel: string;
      /** The real model id sent upstream. */
      upstreamModel: string;
      resolution: ModelSourceResolution;
    };

export interface ModelSourceInput {
  config: Pick<ProxyConfig, "coreSkill" | "instanceUpstream" | "modelSources">;
  /** First path segment of the request. */
  agent: string | undefined;
  spaceId: string;
  /** Wire format of the endpoint the client called. */
  format: ModelSourceFormat;
  /** `body.model` as parsed. */
  model: unknown;
  /** False when the calling runner has no subscription pool branch for this format. */
  servesPool: boolean;
  /**
   * Team of the request, from the request team helper. Only a pool source of this team is found.
   * Null when no pool serves the client: a pool prefix is then not found, like an unknown one.
   * Ignored when `servesPool` is false.
   */
  teamId: string | null;
}

export function isSourceRow(row: InstanceUpstreamRow): boolean {
  return row.group_type === "custom"
    && (row.mode === "custom_unified" || row.mode === "subscription_pool")
    && typeof row.source_name === "string"
    && row.source_name !== "";
}

function fail(
  code: ModelSourceErrorCode,
  message: string,
  detail: Record<string, unknown>,
): ModelSourceResult {
  return { kind: "error", code, message, detail };
}

/**
 * Lower-case source prefix of `<source>/<model>` when the request is one a model source can
 * serve: the switch is on, the agent is multi-source and allowed, and the model has a prefix.
 * Null otherwise. The stage and the request team helper share it, so both agree on what a
 * source request is.
 */
export function modelSourcePrefix(
  config: Pick<ProxyConfig, "modelSources">,
  agent: string | undefined,
  model: unknown,
): string | null {
  if (config.modelSources?.enabled !== true) return null;
  if (!agent || !isMultiSourceAgent(agent)) return null;
  const allowed = config.modelSources.agents;
  if (allowed && !allowed.includes(agent)) return null;
  if (typeof model !== "string") return null;
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  return model.slice(0, slash).toLowerCase();
}

export async function stageModelSource(input: ModelSourceInput): Promise<ModelSourceResult> {
  const { config, agent, spaceId, format, model } = input;

  const prefix = modelSourcePrefix(config, agent, model);
  if (prefix === null || !agent || typeof model !== "string") return { kind: "none" };
  const upstreamModel = model.slice(model.indexOf("/") + 1);

  const items = await getInstanceUpstreamConfigs(config.coreSkill, spaceId, config.instanceUpstream);
  // The source name of a pool repeats in every team, so a pool source is found only in the pool
  // of the request team. A known team without that pool gets `none`, as if no pool existed.
  // A runner that cannot use a pool at all answers the format error whichever team asks, so it
  // needs no team and no pool of any team is ever opened for it.
  const row = items.find((r) => isSourceRow(r) && r.source_name === prefix
    && (!isPoolRow(r) || !input.servesPool
      || (input.teamId !== null && input.teamId !== "" && r.team_id === input.teamId)));
  if (!row) return { kind: "none" };

  const detail = { agent, source: prefix, format };
  const isPool = row.mode === "subscription_pool";

  if (!(row.source_agents ?? []).includes(agent)) {
    return fail("model_source_not_allowed", `Agent '${agent}' is not allowed to use source '${prefix}'.`, detail);
  }
  if (isPool ? !row.enabled : row.source_enabled !== true) {
    return fail(
      "model_source_disabled",
      isPool
        ? `Source '${prefix}' is disabled because its subscription pool is off.`
        : `Source '${prefix}' is disabled.`,
      detail,
    );
  }
  const formats = row.source_formats ?? [];
  if (!formats.includes(format) || (isPool && !input.servesPool)) {
    return fail(
      "model_format_mismatch",
      `Source '${prefix}' does not serve the '${format}' format. It serves: ${formats.join(", ") || "none"}.`,
      { ...detail, served_formats: formats },
    );
  }
  const entry = (row.source_models ?? []).find((m) => m.id === upstreamModel);
  if (!entry || entry.enabled !== true || entry.available === false) {
    return fail("model_not_enabled", `Model '${upstreamModel}' is not enabled in source '${prefix}'.`, detail);
  }

  const resolution: ModelSourceResolution = isPool
    ? { kind: "pool", row }
    : { kind: "override", row: { ...row, model_id: upstreamModel } };
  return {
    kind: "matched",
    sourceName: prefix,
    sourceType: isPool ? "subscription" : "api",
    groupId: row.group_id,
    format,
    clientModel: model,
    upstreamModel,
    resolution,
  };
}

/**
 * Apply a `matched` result to the request: real model id into the body, the prefixed name for
 * the response mask. Returns the Langfuse metadata for the request.
 */
export function applyModelSource(
  c: Context,
  body: Record<string, unknown>,
  matched: Extract<ModelSourceResult, { kind: "matched" }>,
  agent: string,
): Record<string, unknown> {
  body.model = matched.upstreamModel;
  c.set("clientFacingModel", matched.clientModel);
  console.log(
    `[model-source] agent=${agent} source=${matched.sourceName} group=${matched.groupId} format=${matched.format} kind=${matched.resolution.kind} model=${matched.upstreamModel}`,
  );
  return {
    model_source: matched.sourceName,
    model_source_group_id: matched.groupId,
    source_type: matched.sourceType,
    upstream_model: matched.upstreamModel,
    client_model: matched.clientModel,
  };
}

/** Error response in the envelope of the calling runner. */
export function modelSourceErrorResponse(
  c: Context,
  envelope: "openai" | "anthropic",
  err: Extract<ModelSourceResult, { kind: "error" }>,
): Response {
  if (envelope === "anthropic") {
    return c.json({
      type: "error",
      error: { type: err.code, message: err.message },
      detail: err.detail,
    }, 400);
  }
  return c.json({
    code: 400,
    error_code: err.code.toUpperCase(),
    message: err.message,
    detail: err.detail,
  }, 400);
}
