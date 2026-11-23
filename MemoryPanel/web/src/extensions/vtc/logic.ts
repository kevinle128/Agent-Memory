/**
 * Pure rules of the Pending users page. No alias imports, so the Panel Vitest suite can run them.
 */
export interface PendingItem {
  pending_id: string;
  email: string;
  vtc_user_id: string;
  kind: 'new' | 'no_team';
  core_user_id?: string;
  core_username?: string;
  status: 'pending' | 'rejected';
  source: 'web' | 'device';
  first_login_at: string;
  last_login_at: string;
  login_count: number;
  rejected_at?: string;
  reason?: string;
}

export interface Candidate {
  user_id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  auth_provider: string;
  /** 'system_admin' is shown with a warning: the server refuses to link a person to that account. */
  user_type: string;
  match: Array<'email' | 'username'>;
  linked_vtc_user_id?: string;
}

export type AccountChoice =
  | { mode: 'existing' }
  | { mode: 'link'; userId: string }
  | { mode: 'create'; confirmed: boolean };

export type TeamRoleChoice = 'member' | 'admin';

export type UnselectableReason = 'linked' | 'system_admin';

/** Why an administrator cannot link the person to this account; null when linking is allowed. */
export function unselectableReason(c: Candidate): UnselectableReason | null {
  if (c.linked_vtc_user_id) return 'linked';
  if (c.user_type === 'system_admin') return 'system_admin';
  return null;
}

export function isSelectable(c: Candidate): boolean {
  return unselectableReason(c) === null;
}

/** Link the first selectable candidate when one exists; create otherwise; 'existing' for a user without a team. */
export function defaultAccountChoice(item: PendingItem, candidates: Candidate[]): AccountChoice {
  if (item.kind === 'no_team') return { mode: 'existing' };
  const first = candidates.find(isSelectable);
  return first ? { mode: 'link', userId: first.user_id } : { mode: 'create', confirmed: false };
}

/** Create needs a confirmation when any candidate exists. A team is always required. */
export function canSubmit(
  item: PendingItem,
  candidates: Candidate[],
  choice: AccountChoice,
  teamId: string | null,
): boolean {
  if (!teamId) return false;
  switch (choice.mode) {
    case 'existing':
      return item.kind === 'no_team';
    case 'link':
      return item.kind === 'new' && candidates.some((c) => c.user_id === choice.userId && isSelectable(c));
    case 'create':
      return item.kind === 'new' && (candidates.length === 0 || choice.confirmed);
  }
}

export function approveBody(
  item: PendingItem,
  candidates: Candidate[],
  choice: AccountChoice,
  teamId: string,
  role: TeamRoleChoice,
): Record<string, unknown> {
  const body: Record<string, unknown> = { pending_id: item.pending_id, team_id: teamId, role };
  if (choice.mode === 'link') {
    body.mode = 'link';
    body.link_user_id = choice.userId;
  } else if (choice.mode === 'create') {
    body.mode = 'create';
    if (candidates.length > 0 && choice.confirmed) body.confirm_create = true;
  }
  return body;
}

const SAIGON_OFFSET_MS = 7 * 60 * 60 * 1000;

/** 'YYYY-MM-DD HH:mm' in Asia/Saigon (UTC+7, no daylight saving). An unreadable value is returned as it came. */
export function formatSaigon(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms + SAIGON_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/** Candidates in a 409 CANDIDATES_EXIST answer of approve; null for any other failure. */
export function candidatesFromConflictBody(status: number, body: string): Candidate[] | null {
  if (status !== 409) return null;
  try {
    const parsed = JSON.parse(body) as { message?: unknown; data?: { candidates?: unknown } };
    if (parsed.message !== 'CANDIDATES_EXIST' || !Array.isArray(parsed.data?.candidates)) return null;
    return parsed.data.candidates as Candidate[];
  } catch {
    return null;
  }
}

/** Codes the VTC admin routes answer with; each has an `error.<code>` text in the bundles. */
export const VTC_ERROR_CODES = [
  'PENDING_NOT_FOUND',
  'PENDING_NOT_PENDING',
  'PENDING_NOT_REJECTED',
  'APPROVAL_IN_PROGRESS',
  'TEAM_NOT_FOUND',
  'NOT_TEAM_ADMIN',
  'TEAM_NOT_ALLOWED',
  'USER_NOT_FOUND',
  'USER_NOT_LINKABLE',
  'USER_ALREADY_LINKED',
  'VTC_ACCOUNT_EXISTS',
  'LINK_CONFLICT',
  'MODE_REQUIRED',
  'LINK_USER_REQUIRED',
  'CORE_ERROR',
] as const;

export type VtcErrorCode = (typeof VTC_ERROR_CODES)[number];

export function asVtcErrorCode(value: unknown): VtcErrorCode | null {
  return typeof value === 'string' && (VTC_ERROR_CODES as readonly string[]).includes(value)
    ? (value as VtcErrorCode)
    : null;
}
