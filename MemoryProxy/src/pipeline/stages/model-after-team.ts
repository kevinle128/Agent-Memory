/**
 * stages/model-after-team.ts — model gate and model source when session init can still change
 * the team of the request.
 *
 * A subscription pool belongs to one team. The first team answer can be a deferred error, a
 * predicted team or a fallback team, and session init can register the session in another team
 * before the upstream is chosen. The model gate, the model alias and the `<source>/<model>`
 * match depend on the pool of the team, so a runner:
 *   1. skips the early model gate while `teamMayChangeInInit` is true;
 *   2. calls `reselectModelSource` after `settleRequestTeam` when the team changed;
 *   3. runs `gateModelAfterTeam` against the settled upstream, also when the team did not change.
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import {
  getInstanceUpstreamConfigs, resolveForAgent, shouldOverride, type Resolution,
} from "../../instance-upstream-cache.js";
import type { RequestTeam } from "../../subscription-pool/pool-team.js";
import { stageModelGate, type ModelGateOk } from "./model-gate.js";
import {
  applyModelSource, modelSourceErrorResponse, modelSourcePrefix, stageModelSource,
  type ModelSourceFormat, type ModelSourceResult,
} from "./model-source.js";

type MatchedSource = Extract<ModelSourceResult, { kind: "matched" }>;

/**
 * True when session init can still settle another team than the first answer. That is the case
 * for a deferrable error, and for a team that did not come from a registered session. The caller
 * must then run the model gate after `settleRequestTeam`.
 */
export function teamMayChangeInInit(team: RequestTeam | null, sessionInitMayRun: boolean): boolean {
  if (team === null || !sessionInitMayRun) return false;
  return team.kind === "error" ? team.deferrable : team.source !== "session";
}

export interface ReselectSourceInput {
  c: Context;
  config: ProxyConfig;
  /** Request body. `model` is rewritten only when the source match changes. */
  body: Record<string, unknown>;
  agent: string;
  spaceId: string;
  format: ModelSourceFormat;
  /** Team that session init settled. */
  teamId: string | null;
  /** `body.model` as the client sent it, before any source, pool-service or main-model rewrite. */
  originalModel: unknown;
}

export type ReselectSourceResult =
  | { kind: "error"; response: Response }
  | {
    kind: "ok";
    /** Source of the settled team, or null when the settled team has no such source. */
    matched: MatchedSource | null;
    /** True when a source matched before and the settled team lost it: `body.model` is the client model again. */
    lost: boolean;
  };

/**
 * Find the `<source>/<model>` of the client again, in the settled team. A pool source is the pool
 * of one team, so another team can match it, or lose it. `previous` is the match of the first
 * team. A request without a source prefix is left untouched.
 */
export async function reselectModelSource(
  input: ReselectSourceInput & { previous: MatchedSource | null; errorEnvelope: "anthropic" | "openai" },
): Promise<ReselectSourceResult> {
  const { c, config, body, agent, originalModel, previous } = input;
  if (modelSourcePrefix(config, agent, originalModel) === null) return { kind: "ok", matched: null, lost: false };
  const again = await stageModelSource({
    config, agent, spaceId: input.spaceId, format: input.format, model: originalModel, servesPool: true, teamId: input.teamId,
  });
  if (again.kind === "error") return { kind: "error", response: modelSourceErrorResponse(c, input.errorEnvelope, again) };
  if (again.kind === "matched") {
    applyModelSource(c, body, again, agent);
    return { kind: "ok", matched: again, lost: false };
  }
  if (previous === null) return { kind: "ok", matched: null, lost: false };
  // A known team without that pool runs as if no pool existed: the client's model name stays,
  // and the response keeps the model name of the upstream.
  body.model = originalModel;
  c.set("clientFacingModel", "");
  return { kind: "ok", matched: null, lost: true };
}

/** Kind of upstream that the settled team resolves to for this agent. */
export async function settledUpstreamKind(
  config: ProxyConfig,
  agent: string,
  spaceId: string,
  teamId: string | null,
  preset?: Extract<Resolution, { kind: "override" | "pool" }>,
): Promise<{ isPool: boolean; isOverride: boolean }> {
  try {
    const rows = await getInstanceUpstreamConfigs(config.coreSkill, spaceId, config.instanceUpstream);
    const resolution = preset ?? resolveForAgent(rows, agent, teamId);
    return { isPool: resolution.kind === "pool", isOverride: shouldOverride(resolution) };
  } catch {
    return { isPool: false, isOverride: false };
  }
}

/**
 * The model gate against the settled upstream. A custom upstream skips the pricing table. Answers
 * with the 400 of the runners when the model is not registered.
 */
export function gateModelAfterTeam(
  c: Context,
  config: ProxyConfig,
  requestedModel: string,
  isCustomUpstream: boolean,
): { ok: true; gate: ModelGateOk } | { ok: false; response: Response } {
  const gate = stageModelGate(requestedModel, config, isCustomUpstream);
  if (gate.ok) return { ok: true, gate };
  return {
    ok: false,
    response: c.json({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: `Model '${requestedModel}' is not a registered display name in the credit pricing table`,
      },
    }, 400),
  };
}
