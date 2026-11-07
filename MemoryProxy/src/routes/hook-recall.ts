/**
 * `POST /:agent/:spaceId/v3/hook/recall` — L1 recall for the client hook.
 *
 * The Claude Code hook calls this route on UserPromptSubmit with the fields of
 * the hook report plus `prompt`. When the route finds memories it answers 200
 * with the exact JSON that the hook prints to stdout:
 *
 *   {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}
 *
 * Claude Code adds `additionalContext` next to the prompt and keeps it in the
 * session transcript, so later requests send the same bytes again and the
 * prompt cache stays valid. The proxy keeps no state for this.
 *
 * Every other result is 204 with no body, and the hook then prints nothing.
 * The rules, in order:
 *   1. `hookRecall.enabled` and a Claude Code client. Codex stays silent until
 *      its hook output contract is confirmed.
 *   2. The user key is valid (same check as the hook report).
 *   3. The session is registered and belongs to the same user and space. The
 *      agent comes from the session, never from the request.
 *   4. The user id or the agent id is in the allowlists.
 *   5. The hook reported a project (git remote or git toplevel). Without a
 *      project there is no search: memory is deny-by-default
 *      (docs/adr/0002-project-scoped-memory.md).
 *   6. A hit is injected only when its project is the session project, its
 *      score is at least `minScore`, and it fits in `topK` and `maxTokens`.
 *   7. The search must finish within `timeoutMs` of the request start.
 *
 * Requests that pass rules 1-4 are written to the recall log
 * (`db/hook-recall-log.ts`), with each candidate and its decision.
 */

import type { Context } from "hono";

import { extractUserQueryText } from "../common/user-query-extractor.js";
import {
  writeRecallLog,
  type RecallCandidate,
  type RecallLogRow,
  type RecallOutcome,
} from "../db/hook-recall-log.js";
import { loadSessionIdsL1, loadSessionIdsL2, resolveMemoryCtxs, type SessionIdFields } from "../memory/memory-bridge.js";
import { stageAuth } from "../pipeline/stages/auth.js";
import { buildProjectIdentity } from "../project-scope/project-key.js";
import { getSessionStore } from "../session/store.js";
import { buildTdaiClientForRequest } from "../tdai/client.js";
import { formatL1RecallBlock, formatL1RecallLine, searchL1InCtxs, type L1RecallHit } from "../tdai/l1-recall.js";
import type { HookRecallConfig, ProxyConfig } from "../types.js";
import { AGENT_RE, parseHookReport } from "./hook-report.js";

const TAG = "[hook-recall]";
const MAX_PROMPT = 20_000;
const MAX_QUERY = 2048;
const PREVIEW_CHARS = 200;
/** Candidates asked from each agent: more than topK, because the project filter drops many. */
const CANDIDATES_PER_TOPK = 4;
const MAX_CANDIDATES = 50;

/** Token estimate for the budget. Three characters per token is high for English and close for Vietnamese. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** The JSON body that the hook prints. */
export function hookOutput(additionalContext: string): { hookSpecificOutput: { hookEventName: string; additionalContext: string } } {
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
}

export interface RecallSelection {
  candidates: RecallCandidate[];
  lines: string[];
  tokens: number;
}

/**
 * Decide about each hit, best score first: project, score, count and token
 * budget. Returns the decision of every hit and the lines to inject.
 */
export function selectRecallHits(
  hits: L1RecallHit[],
  opts: { projectHash: string; selfAgentId: string; cfg: Pick<HookRecallConfig, "minScore" | "topK" | "maxTokens"> },
): RecallSelection {
  const candidates: RecallCandidate[] = [];
  const lines: string[] = [];
  let tokens = estimateTokens(formatL1RecallBlock([]));
  for (const h of hits) {
    const base = {
      id: h.id,
      agentId: h.fromAgentId,
      ...(h.type ? { type: h.type } : {}),
      ...(typeof h.score === "number" ? { score: h.score } : {}),
      ...(h.projectHash ? { projectHash: h.projectHash } : {}),
      preview: h.content.slice(0, PREVIEW_CHARS),
    };
    if (h.projectHash !== opts.projectHash) {
      candidates.push({ ...base, decision: "scope_blocked" });
      continue;
    }
    if (typeof h.score !== "number" || h.score < opts.cfg.minScore) {
      candidates.push({ ...base, decision: "below_min_score" });
      continue;
    }
    const line = formatL1RecallLine(h, lines.length, opts.selfAgentId);
    const lineTokens = estimateTokens(line) + 1;
    if (lines.length >= opts.cfg.topK || tokens + lineTokens > opts.cfg.maxTokens) {
      candidates.push({ ...base, decision: "over_budget" });
      continue;
    }
    lines.push(line);
    tokens += lineTokens;
    candidates.push({ ...base, decision: "injected" });
  }
  return { candidates, lines, tokens: lines.length > 0 ? tokens : 0 };
}

const TIMEOUT = Symbol("timeout");

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  // A late failure of the work must not become an unhandled rejection.
  work.catch(() => undefined);
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Session identity from the session store, then from the binding repo. */
async function loadSession(spaceId: string, agentSource: string, sessionId: string): Promise<SessionIdFields | null> {
  const ids = loadSessionIdsL1(`${agentSource}:${sessionId}`);
  if (ids) return ids;
  const repo = getSessionStore().getBindingRepo() ?? null;
  return repo && spaceId ? loadSessionIdsL2(repo, spaceId, sessionId) : null;
}

export function createHookRecallHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    const t0 = Date.now();
    const cfg = config.hookRecall;
    const agentSource = c.req.param("agent") ?? "";
    if (!AGENT_RE.test(agentSource)) return c.json({ error: "invalid agent" }, 400);

    const auth = await stageAuth(c);
    if (auth.rejected) return c.json({ error: "unauthorized", reason: auth.rejectReason }, 401);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const report = parseHookReport(raw);
    if (typeof report === "string") return c.json({ error: report }, 400);
    const prompt = (raw as Record<string, unknown>).prompt;
    if (typeof prompt !== "string" || prompt.length > MAX_PROMPT) return c.json({ error: "invalid prompt" }, 400);

    if (!cfg?.enabled || report.client !== "claude-code" || !auth.userId) return c.body(null, 204);
    if (cfg.allowAgentIds.length === 0 && cfg.allowUserIds.length === 0) return c.body(null, 204);
    const userId = auth.userId;
    const spaceId = auth.spaceId || c.req.param("spaceId") || "";
    const query = extractUserQueryText(prompt).trim().slice(0, MAX_QUERY);
    if (!query) return c.body(null, 204);

    const userAllowed = cfg.allowUserIds.includes(userId);
    const project = buildProjectIdentity({
      gitRemote: report.gitRemote,
      gitToplevel: report.gitToplevel,
      deviceId: report.deviceId,
    });
    const row: RecallLogRow = {
      createdAt: t0,
      spaceId,
      teamId: null,
      userId,
      agentId: null,
      agentSource,
      client: report.client,
      sessionId: report.sessionId,
      projectHash: project.projectHash,
      projectLabel: project.projectLabel,
      query,
      outcome: "error",
      candidates: [],
      injectedText: null,
      injectedCount: 0,
      tokens: 0,
      latencyMs: 0,
      error: null,
    };
    const finish = (outcome: RecallOutcome, body: Response, extra: Partial<RecallLogRow> = {}): Response => {
      const done: RecallLogRow = { ...row, ...extra, outcome, latencyMs: Date.now() - t0 };
      // Write after the answer is on its way: SQLite is synchronous.
      setImmediate(() => writeRecallLog(config, done));
      console.log(
        `${TAG} session=${report.sessionId} user=${userId} agent=${done.agentId ?? "none"} outcome=${outcome} ` +
        `candidates=${done.candidates.length} injected=${done.injectedCount} latency=${done.latencyMs}ms`,
      );
      return body;
    };
    const noContent = () => c.body(null, 204);

    let ids: SessionIdFields | null;
    try {
      ids = await loadSession(spaceId, agentSource, report.sessionId);
    } catch (err) {
      console.warn(`${TAG} session lookup failed session=${report.sessionId}:`, err instanceof Error ? err.message : String(err));
      ids = null;
    }
    if (!ids) return userAllowed ? finish("no_session", noContent()) : noContent();
    if (ids.user_id !== userId || (ids.space_id && spaceId && ids.space_id !== spaceId)) {
      console.warn(`${TAG} session=${report.sessionId} belongs to another user or space; no recall`);
      return noContent();
    }
    if (!userAllowed && !cfg.allowAgentIds.includes(ids.agent_id)) return noContent();
    row.teamId = ids.team_id;
    row.agentId = ids.agent_id;

    const projectHash = project.projectHash;
    if (!projectHash) return finish("no_project", noContent());

    const client = buildTdaiClientForRequest(config, ids.space_id || spaceId);
    if (!client) return finish("error", noContent(), { error: "memory is disabled in the proxy config" });

    const sessionIds = ids;
    const perAgentLimit = Math.min(cfg.topK * CANDIDATES_PER_TOPK, MAX_CANDIDATES);
    let hits: L1RecallHit[] | typeof TIMEOUT;
    try {
      hits = await withTimeout(
        (async () => {
          const ctxs = await resolveMemoryCtxs(config, sessionIds, `${agentSource}:${report.sessionId}`);
          return searchL1InCtxs(client, ctxs, query, sessionIds.session_id, sessionIds.task_id, perAgentLimit);
        })(),
        // The budget counts from the start of the request: auth and the session lookup use part of it.
        Math.max(0, cfg.timeoutMs - (Date.now() - t0)),
      );
    } catch (err) {
      return finish("error", noContent(), { error: err instanceof Error ? err.message : String(err) });
    }
    if (hits === TIMEOUT) return finish("timeout", noContent());

    const sel = selectRecallHits(hits, { projectHash, selfAgentId: ids.agent_id, cfg });
    if (sel.lines.length === 0) return finish("empty", noContent(), { candidates: sel.candidates });

    const text = formatL1RecallBlock(sel.lines);
    return finish("injected", c.json(hookOutput(text), 200), {
      candidates: sel.candidates,
      injectedText: text,
      injectedCount: sel.lines.length,
      tokens: sel.tokens,
    });
  };
}
