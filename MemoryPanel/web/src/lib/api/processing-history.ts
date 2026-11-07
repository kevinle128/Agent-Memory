/**
 * api/processing-history.ts — Processing History page (/api/v1/processing-history/*).
 *
 * Team admins only; the Panel server checks the role on every call.
 */
import { getPanelSession } from '../panelSession';
import { request, ApiError } from './base';
import type { MetaEnvelope } from './types';

const PREFIX = '/api/v1/processing-history';

async function call<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const envelope = await request<MetaEnvelope<T>>('POST', `${PREFIX}/${endpoint}`, body, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  });
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data as T;
}

// ── Config ──

export interface ProcessingHistoryConfig {
  injections_configured: boolean;
  /** Langfuse project URL, or null when the trace links are off. */
  langfuse_project_url: string | null;
}

// ── Injections (proxy hook recall log) ──

export type RecallOutcome = 'injected' | 'empty' | 'no_session' | 'no_project' | 'timeout' | 'error';
export type CandidateDecision = 'injected' | 'below_min_score' | 'over_budget' | 'scope_blocked';

export interface RecallCandidate {
  id: string;
  agentId: string;
  type?: string;
  score?: number;
  projectHash?: string;
  decision: CandidateDecision;
  /** First characters of the memory. */
  preview: string;
}

export interface InjectionEntry {
  id: number;
  createdAt: number;
  spaceId: string;
  teamId: string | null;
  userId: string;
  agentId: string | null;
  agentSource: string;
  client: string | null;
  sessionId: string;
  projectHash: string | null;
  projectLabel: string | null;
  query: string;
  outcome: RecallOutcome;
  candidates: RecallCandidate[];
  injectedText: string | null;
  injectedCount: number;
  tokens: number;
  latencyMs: number;
  error: string | null;
}

export interface InjectionPage {
  items: InjectionEntry[];
  total: number;
  limit: number;
  offset: number;
}

// ── Extractions (Core memory generation log) ──

export type GenerationLayer = 'l1' | 'l2' | 'l3';
export type ExtractionStatusFilter = 'succeeded' | 'failed' | 'empty';

export interface GenerationRef {
  layer: 'l0' | GenerationLayer;
  record_id: string;
}

export interface GenerationLog {
  log_id: string;
  generation_id: string;
  layer: GenerationLayer;
  status: 'succeeded' | 'failed';
  team_id?: string;
  agent_id?: string;
  user_id?: string;
  session_id?: string;
  task_id?: string;
  prompt: { memory_prompt_id: string; version: number; source: string; prompt_sha256: string };
  anchor_memory_id?: string;
  input_refs: GenerationRef[];
  output_refs: GenerationRef[];
  model?: string;
  prompt_mode?: string;
  variant?: 'project';
  started_at_ms: number;
  finished_at_ms: number;
  latency_ms: number;
  error_code?: string;
  error_message?: string;
  scope_check?: {
    result: 'passed' | 'rejected' | 'judge_failed';
    error_kind?: string;
    reason?: string;
    leaks?: string[];
    judge_attempts: number;
  };
}

export interface ExtractionItem {
  log_id: string;
  layer: GenerationLayer;
  status: 'succeeded' | 'failed';
  finished_at_ms: number;
  log: GenerationLog;
}

export interface ExtractionPage {
  items: ExtractionItem[];
  next_cursor?: string;
  /** Logs read for this page; can be more than the items when a filter drops logs. */
  scanned?: number;
}

// ── Feedback ──

export type FeedbackTargetType = 'injection' | 'extraction' | 'skill';
export type FeedbackRating = 'up' | 'down';

export interface FeedbackEntry {
  target_type: FeedbackTargetType;
  target_id: string;
  rating: FeedbackRating;
  note: string;
  user_id: string;
  updated_at: string;
}

export const processingHistoryApi = {
  config: (teamId: string) => call<ProcessingHistoryConfig>('config', { team_id: teamId }),

  injections: (params: {
    teamId: string;
    limit: number;
    offset: number;
    agentId?: string;
    sessionId?: string;
    outcome?: RecallOutcome;
    since?: string;
  }) =>
    call<InjectionPage>('injections', {
      team_id: params.teamId,
      limit: params.limit,
      offset: params.offset,
      agent_id: params.agentId,
      session_id: params.sessionId,
      outcome: params.outcome,
      since: params.since,
    }),

  extractions: (params: {
    teamId: string;
    limit: number;
    cursor?: string;
    layer?: GenerationLayer;
    status?: ExtractionStatusFilter;
    agentId?: string;
    sessionId?: string;
    startTime?: string;
    endTime?: string;
  }) =>
    call<ExtractionPage>('extractions', {
      team_id: params.teamId,
      limit: params.limit,
      cursor: params.cursor,
      layer: params.layer,
      status: params.status,
      agent_id: params.agentId,
      session_id: params.sessionId,
      start_time: params.startTime,
      end_time: params.endTime,
    }),

  feedbackList: (teamId: string, targets: Array<{ target_type: FeedbackTargetType; target_id: string }>) =>
    call<{ items: FeedbackEntry[]; user_id: string }>('feedback/list', { team_id: teamId, targets }),

  feedbackSet: (params: {
    teamId: string;
    targetType: FeedbackTargetType;
    targetId: string;
    rating: FeedbackRating | null;
    note?: string;
  }) =>
    call<{ entry: FeedbackEntry | null }>('feedback/set', {
      team_id: params.teamId,
      target_type: params.targetType,
      target_id: params.targetId,
      rating: params.rating,
      note: params.note ?? '',
    }),
};
