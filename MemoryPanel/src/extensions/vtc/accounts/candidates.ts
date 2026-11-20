import type { MetaFacade, MetaUserDetail } from '../../../panel/extensions/types.js';
import { VTC_AUTH_PROVIDER } from './account-resolver.js';
import type { LinkStore } from './link-store.js';
import type { PendingRecord } from './pending-store.js';
import { safeUsername } from './username.js';

export interface Candidate {
  user_id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  auth_provider: string;
  /** 'system_admin' lets the UI warn before a person is linked to the administrator account. */
  user_type: string;
  match: Array<'email' | 'username'>;
  /** Already linked to another VTC account, so the UI disables it. */
  linked_vtc_user_id?: string;
}

// The hidden service user of the Panel; repeated here because an extension may not import the startup code.
const HIDDEN_SERVICE_USER = 'knowledge-service';

/**
 * Whether an account may be shown or linked for this VTC person. An account that the VTC login created for
 * somebody else is not a duplicate of this person, and linking to it would hand over that person's data.
 */
export function isLinkTarget(user: MetaUserDetail, links: LinkStore, instanceId: string, vtcUserId: string): boolean {
  if (user.status !== 'active' || user.username === HIDDEN_SERVICE_USER) return false;
  if (user.auth_provider === VTC_AUTH_PROVIDER && user.external_id !== vtcUserId) {
    const owner = links.findByCoreUser(instanceId, user.user_id);
    if (!owner || owner.vtcUserId !== vtcUserId) return false;
  }
  return true;
}

export function emailLocalPart(email: string): string {
  return email.split('@')[0] ?? email;
}

/**
 * Existing Core users that may be the same person. Memory and skills belong to the Core user, so an
 * administrator must look at these before a second account is made. Only the fields of `Candidate` leave
 * this function, and nothing is logged.
 */
export async function findCandidates(
  meta: MetaFacade,
  links: LinkStore,
  instanceId: string,
  record: PendingRecord,
): Promise<Candidate[]> {
  const email = record.email.trim().toLowerCase();
  const local = emailLocalPart(email);
  const safeLocal = safeUsername(local);
  const found: Candidate[] = [];

  for (const user of await meta.users.listAllDetailed(instanceId)) {
    if (!isLinkTarget(user, links, instanceId, record.vtcUserId)) continue;
    // The account this very person already has is not a duplicate of itself.
    if (user.auth_provider === VTC_AUTH_PROVIDER && user.external_id === record.vtcUserId) continue;

    const match: Candidate['match'] = [];
    if (email && user.email?.trim().toLowerCase() === email) match.push('email');
    const username = user.username.toLowerCase();
    if (username === local || username === safeLocal) match.push('username');
    if (match.length === 0) continue;

    const candidate: Candidate = {
      user_id: user.user_id,
      username: user.username,
      display_name: user.display_name,
      email: user.email,
      auth_provider: user.auth_provider,
      user_type: user.user_type ?? 'normal',
      match,
    };
    const link = links.findByCoreUser(instanceId, user.user_id);
    if (link && link.vtcUserId !== record.vtcUserId) candidate.linked_vtc_user_id = link.vtcUserId;
    found.push(candidate);
  }

  // Email matches first: they are the strongest sign of the same person.
  return found.sort((a, b) => Number(b.match.includes('email')) - Number(a.match.includes('email')));
}
