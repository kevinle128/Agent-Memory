/**
 * Role of one user in one team, read from Core at call time.
 *
 * `team-member/get` refuses a caller that is not an active member of the
 * team, so a user who is not in the team gets `null`. The function has no
 * system-admin path: a system admin has a role only where they are a member.
 */
import type { PanelDeps } from '../panel-deps.js';
import type { MetaCallContext } from '../kernel/types.js';

export type TeamRole = 'admin' | 'member' | 'reviewer';

const ROLES: ReadonlySet<string> = new Set(['admin', 'member', 'reviewer']);

/** Core answered with a server-side failure, so the role is unknown (not "no role"). */
export class TeamRoleUnavailableError extends Error {
  constructor(readonly action: string, readonly code: number) {
    super(`core action ${action} failed with code ${code}`);
    this.name = 'TeamRoleUnavailableError';
  }
}

export interface ResolveTeamRoleOptions {
  /**
   * Also accept the team owner as `admin` when the member row is not an active admin.
   * The owner check reads `team/get`, which does not check the caller, so use it only
   * where the caller is already trusted to know the team id.
   */
  ownerFallback?: boolean;
}

/**
 * - `ownerFallback: false` (default): the role of the active member row, else `null`.
 *   A 5xx answer from Core throws `TeamRoleUnavailableError`, so an outage is not read as "no access".
 * - `ownerFallback: true`: the legacy rule of the Processing History gate. Any Core error
 *   counts as "no role" and the owner of the team counts as `admin`.
 */
export async function resolveTeamRole(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  teamId: string,
  options: ResolveTeamRoleOptions = {},
): Promise<TeamRole | null> {
  const ownerFallback = options.ownerFallback === true;

  const member = await deps.metaKernel.invoke('team-member/get', { team_id: teamId, user_id: userId }, ctx);
  if (!ownerFallback && member.code >= 500) throw new TeamRoleUnavailableError('team-member/get', member.code);
  const row = member.data as { role?: string; status?: string } | null;
  const role =
    member.code === 0 && row?.status === 'active' && typeof row.role === 'string' && ROLES.has(row.role)
      ? (row.role as TeamRole)
      : null;

  if (!ownerFallback || role === 'admin') return role;

  const team = await deps.metaKernel.invoke('team/get', { team_id: teamId }, ctx);
  const owner = team.data as { owner_user_id?: string } | null;
  if (team.code === 0 && owner?.owner_user_id === userId) return 'admin';
  return role;
}
