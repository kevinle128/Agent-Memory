import { ApiError, request, unwrapEnvelope } from '@/lib/api/base';
import type { MetaEnvelope } from '@/lib/api/types';
import { getPanelSession } from '@/lib/panelSession';
import { asVtcErrorCode, candidatesFromConflictBody, type Candidate, type PendingItem, type VtcErrorCode } from './logic';

const BASE = '/api/v1/ext/vtc/pending';

export const PENDING_CHANGED_EVENT = 'ext-vtc:pending-changed';

export interface ApproveResult {
  core_user_id: string;
  username: string;
  mode: string;
  team_id: string;
  role: string;
  role_kept: boolean;
  warnings: string[];
}

// Same headers as the meta calls: a cookie session carries no user key and relies on the cookie.
async function call<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const headers: Record<string, string> = { 'X-Tdai-Service-Id': session.instanceId };
  if (session.userKey) headers['X-Tdai-User-Key'] = session.userKey;
  const envelope = await request<MetaEnvelope<T>>('POST', `${BASE}/${action}`, body, headers);
  return unwrapEnvelope(envelope, 'empty response');
}

export const vtcApi = {
  list: () => call<{ items: PendingItem[]; pending_count: number }>('list'),
  count: async (): Promise<number> => (await call<{ pending_count: number }>('count')).pending_count,
  candidates: (pendingId: string) =>
    call<{ kind: 'new' | 'no_team'; candidates: Candidate[] }>('candidates', { pending_id: pendingId }),
  approve: (body: Record<string, unknown>) => call<ApproveResult>('approve', body),
  reject: async (pendingId: string, reason?: string): Promise<void> => {
    await call('reject', { pending_id: pendingId, ...(reason?.trim() ? { reason: reason.trim() } : {}) });
  },
  reset: async (pendingId: string): Promise<void> => {
    await call('reset', { pending_id: pendingId });
  },
  /** Teams this caller may approve into. The server applies the same rule as approve. */
  teams: () => call<{ teams: Array<{ team_id: string; name: string }> }>('teams'),
};

/** The candidate list of a 409 CANDIDATES_EXIST answer; null for any other failure. */
export function candidatesFromConflict(err: unknown): Candidate[] | null {
  return err instanceof ApiError ? candidatesFromConflictBody(err.status, err.body) : null;
}

/** The VTC error code of a failed call, when the server answered with one this page knows. */
export function vtcErrorCode(err: unknown): VtcErrorCode | null {
  return err instanceof ApiError ? asVtcErrorCode(err.rawMessage) : null;
}
