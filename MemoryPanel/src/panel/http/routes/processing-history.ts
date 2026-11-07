/**
 * /api/v1/processing-history/* — data of the Processing History page.
 *
 * The page lets a team admin audit what the memory system did: which
 * memories the client hook injected (proxy recall log), which extraction runs
 * ran (Core memory generation log), and the 👍/👎 ratings on both. The skill
 * suggestion tab uses the existing /skill/proposals/* routes, where Core
 * checks who may see and decide each proposal.
 *
 * Access: every route needs a team admin of the requested team: a system
 * admin, the team owner, or an active member with the role `admin`. The rows
 * hold user prompts and memory text, so a check that cannot complete refuses.
 *
 * Routes (POST, headers like /meta/*):
 *   /processing-history/config         what is configured (Langfuse link, injection source)
 *   /processing-history/injections     recall log rows of the team
 *   /processing-history/extractions    generation logs of the team, with the full log
 *   /processing-history/feedback/list  ratings of the given targets
 *   /processing-history/feedback/set   set or remove the caller's rating of one target
 */
import type { Context, Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import type { MetaCallContext } from '../../kernel/types.js';
import { toKernelCredentials } from '../../kernel/types.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import { buildCtx, okEnvelope, readJson, str } from './knowledge/common.js';
import {
  FEEDBACK_TARGET_TYPES,
  MAX_FEEDBACK_NOTE_CHARS,
  type FeedbackTargetType,
} from '../../state/processing-feedback-store.js';

const PROXY_TIMEOUT_MS = 10_000;
const CORE_TIMEOUT_MS = 30_000;
/** Ids in the recall log filters: same rule as the proxy. */
const FILTER_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const RECALL_OUTCOMES = ['injected', 'empty', 'no_session', 'no_project', 'timeout', 'error'];
const MAX_FEEDBACK_TARGETS = 200;

type AdminCheck = { userId: string } | { error: Response };

/**
 * Team admin gate. One auth/verify call gives the user and the user type;
 * then the membership role, then the team owner.
 */
async function requireTeamAdmin(
  deps: PanelDeps,
  c: Context,
  ctx: MetaCallContext,
  teamId: string,
): Promise<AdminCheck> {
  if (!ctx.userKey) return { error: respondControlError(c, 401, 'INVALID_USER_KEY') };
  const verify = await deps.metaKernel.invoke('auth/verify', { user_key: ctx.userKey }, ctx);
  const data = verify.data as { valid?: boolean; user?: { user_id?: string; user_type?: string } } | null;
  const userId = verify.code === 0 && data?.valid ? data.user?.user_id : undefined;
  if (!userId) return { error: respondControlError(c, 401, 'INVALID_USER_KEY') };
  if (data?.user?.user_type === 'system_admin') return { userId };

  const member = await deps.metaKernel.invoke('team-member/get', { team_id: teamId, user_id: userId }, ctx);
  const m = member.data as { role?: string; status?: string } | null;
  if (member.code === 0 && m?.status === 'active' && m.role === 'admin') return { userId };

  const team = await deps.metaKernel.invoke('team/get', { team_id: teamId }, ctx);
  const t = team.data as { owner_user_id?: string } | null;
  if (team.code === 0 && t?.owner_user_id === userId) return { userId };

  return { error: respondControlError(c, 403, 'NOT_TEAM_ADMIN') };
}

function intIn(v: unknown, def: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : def;
}

function isoTime(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export function registerProcessingHistoryRoutes(api: Hono, deps: PanelDeps): void {
  const cfg = deps.config.processingHistory;

  api.post('/processing-history/config', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamAdmin(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    return respondEnvelope(
      c,
      okEnvelope(c, {
        injections_configured: !!cfg.proxyAdminUrl,
        langfuse_project_url: cfg.langfuseProjectUrl || null,
      }),
    );
  });

  // body: { team_id, limit?, offset?, agent_id?, session_id?, outcome?, since? }
  api.post('/processing-history/injections', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!FILTER_ID_RE.test(teamId)) return respondControlError(c, 400, 'INVALID_TEAM_ID');
    const gate = await requireTeamAdmin(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    if (!cfg.proxyAdminUrl) return respondControlError(c, 503, 'INJECTION_LOG_NOT_CONFIGURED');

    const limit = intIn(body.limit, 50, 1, 200);
    const offset = intIn(body.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const params = new URLSearchParams({ team_id: teamId, limit: String(limit), offset: String(offset) });
    for (const key of ['agent_id', 'session_id'] as const) {
      const v = str(body, key);
      if (!v) continue;
      if (!FILTER_ID_RE.test(v)) return respondControlError(c, 400, `INVALID_${key.toUpperCase()}`);
      params.set(key, v);
    }
    const outcome = str(body, 'outcome');
    if (outcome) {
      if (!RECALL_OUTCOMES.includes(outcome)) return respondControlError(c, 400, 'INVALID_OUTCOME');
      params.set('outcome', outcome);
    }
    const since = isoTime(body.since);
    if (since) params.set('since', since);

    let res: Response;
    try {
      res = await fetch(`${cfg.proxyAdminUrl}/v3/admin/hook-recall-log?${params.toString()}`, {
        headers: cfg.proxyAdminApiKey ? { authorization: `Bearer ${cfg.proxyAdminApiKey}` } : {},
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
    } catch (err) {
      deps.logger.warn('processing-history: proxy unreachable', { err: err instanceof Error ? err.message : String(err) });
      return respondControlError(c, 502, 'INJECTION_LOG_UNREACHABLE');
    }
    // 403: the proxy has no admin key; 401: the keys of the Hub and the proxy differ.
    if (res.status === 403) return respondControlError(c, 503, 'PROXY_ADMIN_KEY_NOT_SET');
    if (res.status === 401) return respondControlError(c, 503, 'PROXY_ADMIN_KEY_REJECTED');
    let payload: { code?: number; message?: string; data?: unknown };
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      return respondControlError(c, 502, `INJECTION_LOG_BAD_RESPONSE: HTTP ${res.status}`);
    }
    if (!res.ok || payload.code !== 0) {
      return respondControlError(c, 502, `INJECTION_LOG_ERROR: ${payload.message ?? `HTTP ${res.status}`}`);
    }
    return respondEnvelope(c, okEnvelope(c, payload.data));
  });

  // body: { team_id, layer?, status?: succeeded|failed|empty, agent_id?, session_id?,
  //         start_time?, end_time?, limit?, cursor? }
  api.post('/processing-history/extractions', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamAdmin(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;

    // Core list is scoped to the instance only, so the team filter is always set here.
    const query: Record<string, unknown> = { team_id: teamId, include_log: true, limit: intIn(body.limit, 30, 1, 100) };
    const layer = str(body, 'layer');
    if (layer) {
      if (!['l1', 'l2', 'l3'].includes(layer)) return respondControlError(c, 400, 'INVALID_LAYER');
      query.layer = layer;
    }
    const status = str(body, 'status');
    if (status === 'empty') {
      query.status = 'succeeded';
      query.output = 'empty';
    } else if (status === 'succeeded' || status === 'failed') {
      query.status = status;
    } else if (status) {
      return respondControlError(c, 400, 'INVALID_STATUS');
    }
    for (const key of ['agent_id', 'session_id', 'cursor'] as const) {
      const v = str(body, key);
      if (v) query[key] = v;
    }
    const start = isoTime(body.start_time);
    const end = isoTime(body.end_time);
    if (start && end) {
      query.start_time = start;
      query.end_time = end;
    }
    try {
      const env = await deps.kernelHttp.postEnvelope<unknown>(
        '/v3/memory-generation-log/list',
        query,
        toKernelCredentials(ctx, { timeoutMs: CORE_TIMEOUT_MS }),
      );
      return respondEnvelope(c, env);
    } catch (err) {
      return respondControlError(c, 500, `EXTRACTIONS_FETCH_ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // body: { team_id, targets: [{ target_type, target_id }] }
  api.post('/processing-history/feedback/list', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const raw = Array.isArray(body.targets) ? body.targets : null;
    if (!raw || raw.length > MAX_FEEDBACK_TARGETS) return respondControlError(c, 400, 'INVALID_TARGETS');
    const targets: Array<{ target_type: FeedbackTargetType; target_id: string }> = [];
    for (const t of raw) {
      const r = t as Record<string, unknown>;
      if (
        typeof r?.target_type !== 'string' ||
        !(FEEDBACK_TARGET_TYPES as readonly string[]).includes(r.target_type) ||
        typeof r.target_id !== 'string' ||
        !r.target_id.trim()
      ) {
        return respondControlError(c, 400, 'INVALID_TARGETS');
      }
      targets.push({ target_type: r.target_type as FeedbackTargetType, target_id: r.target_id.trim() });
    }
    const gate = await requireTeamAdmin(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    try {
      const items = deps.feedbackStore.list({ instanceId: ctx.instanceId, teamId }, targets);
      return respondEnvelope(c, okEnvelope(c, { items, user_id: gate.userId }));
    } catch (err) {
      return respondControlError(c, 500, `FEEDBACK_STORE_ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // body: { team_id, target_type, target_id, rating: 'up'|'down'|null, note? }
  api.post('/processing-history/feedback/set', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const targetType = str(body, 'target_type');
    const targetId = str(body, 'target_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!targetType || !(FEEDBACK_TARGET_TYPES as readonly string[]).includes(targetType)) {
      return respondControlError(c, 400, 'INVALID_TARGET_TYPE');
    }
    if (!targetId || targetId.length > 256) return respondControlError(c, 400, 'INVALID_TARGET_ID');
    const rating = body.rating;
    if (rating !== 'up' && rating !== 'down' && rating !== null) return respondControlError(c, 400, 'INVALID_RATING');
    const note = body.note === undefined ? '' : body.note;
    if (typeof note !== 'string' || note.length > MAX_FEEDBACK_NOTE_CHARS) return respondControlError(c, 400, 'INVALID_NOTE');
    const gate = await requireTeamAdmin(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    try {
      const entry = deps.feedbackStore.set(
        {
          instance_id: ctx.instanceId,
          team_id: teamId,
          target_type: targetType as FeedbackTargetType,
          target_id: targetId,
          user_id: gate.userId,
        },
        rating,
        note,
      );
      return respondEnvelope(c, okEnvelope(c, { entry }));
    } catch (err) {
      return respondControlError(c, 500, `FEEDBACK_STORE_ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
