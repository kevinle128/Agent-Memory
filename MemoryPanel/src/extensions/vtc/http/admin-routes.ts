import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  MetaError,
  type ExtensionAuthPort,
  type ExtensionContext,
  type ExtensionLogger,
  type MetaFacade,
  type TeamRole,
} from '../../../panel/extensions/types.js';
import { VTC_AUTH_PROVIDER } from '../accounts/account-resolver.js';
import { emailLocalPart, findCandidates, isLinkTarget } from '../accounts/candidates.js';
import type { LinkStore } from '../accounts/link-store.js';
import type { PendingRecord, PendingStore } from '../accounts/pending-store.js';
import { safeUsername, uniqueUsername } from '../accounts/username.js';
import type { VtcConfig } from '../config.js';

export interface AdminRouteDeps {
  instanceId: string;
  auth: ExtensionAuthPort;
  meta: MetaFacade;
  pending: PendingStore;
  links: LinkStore;
  audit: ExtensionContext<VtcConfig>['audit'];
  logger: ExtensionLogger;
}

type ApprovedMode = 'linked' | 'created' | 'recovered' | 'existing';

/** A refusal the route reports as is; anything else thrown while approving is a Core failure. */
class ApiError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    readonly data: unknown = null,
  ) {
    super(code);
  }
}

const ROLES = ['admin', 'member', 'reviewer'] as const;

const emptyBody = z.object({});
const idBody = z.object({ pending_id: z.string().min(1).max(100) });
const approveBody = idBody.extend({
  team_id: z.string().min(1).max(200),
  role: z.enum(ROLES),
  mode: z.enum(['link', 'create']).optional(),
  link_user_id: z.string().min(1).max(200).optional(),
  confirm_create: z.boolean().optional(),
});
const rejectBody = idBody.extend({
  reason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value) => value || undefined),
});

function envelope(c: Context, status: number, message: string, data: unknown) {
  return c.json(
    { code: status === 200 ? 0 : status, message, request_id: c.get('reqId') ?? '', data },
    status as 200,
  );
}

type Caller = {
  userId: string;
  sameInstance: boolean;
  isSystemAdmin: boolean;
  /**
   * Teams where this caller is an active admin. Null for a system admin, who may use any team.
   * Core's team/list only returns teams the user belongs to, so a system admin's dialog list is that
   * membership set; approve still accepts any existing team id.
   */
  adminTeams: Array<{ team_id: string; name: string }> | null;
};

/** Routes over the pending list. A system admin, or an active admin of at least one team. Every route is POST. */
export function registerAdminRoutes(api: Hono, deps: AdminRouteDeps): void {
  const { auth, meta, pending, links, audit, logger } = deps;
  // One Panel process serves the instance, so this keeps two clicks on the same person from making two accounts.
  const approving = new Set<string>();
  // Approvals of different people run one after another: two at once could both pass the "already linked"
  // and "candidates exist" checks before either writes, and link two people to one account.
  let approveQueue: Promise<unknown> = Promise.resolve();
  function serializedApproval<T>(task: () => Promise<T>): Promise<T> {
    const run = approveQueue.then(task);
    approveQueue = run.catch(() => undefined);
    return run;
  }

  const TEAM_PAGE = 100;

  /** Every team team/list would return, including pages after the first. */
  async function everyTeam(instanceId: string, userId: string): Promise<Array<{ team_id: string; name: string }>> {
    const all: Array<{ team_id: string; name: string }> = [];
    let offset = 0;
    for (;;) {
      const page = await meta.teams.listForUser(instanceId, userId, { limit: TEAM_PAGE, offset });
      all.push(...page.items);
      offset += page.items.length;
      if (page.items.length === 0 || page.items.length < TEAM_PAGE || offset >= page.total) break;
    }
    return all;
  }

  /** Teams the caller may approve into. A system admin is not limited to the admin role. */
  async function teamsForCaller(instanceId: string, userId: string, isSystemAdmin: boolean): Promise<Caller['adminTeams']> {
    if (isSystemAdmin) return null;
    const adminTeams = [];
    for (const team of await everyTeam(instanceId, userId)) {
      const membership = await meta.members.get(instanceId, team.team_id, userId);
      if (membership?.status === 'active' && membership.role === 'admin') adminTeams.push(team);
    }
    return adminTeams;
  }

  /**
   * Candidates a team admin may be shown or offered as a link. A system admin sees the full list.
   * The same rule covers the candidate route and the "candidates exist" refusal on create.
   */
  async function candidatesForCaller<T extends { user_id: string }>(found: T[], admin: Caller): Promise<T[]> {
    if (!admin.adminTeams) return found;
    const kept: T[] = [];
    for (const candidate of found) {
      if (await activeMemberOf(candidate.user_id, admin.adminTeams)) kept.push(candidate);
    }
    return kept;
  }

  /** A team admin may link only an active member of a team they administer, and never a system admin. */
  async function linkableForCaller(user: { user_id: string; user_type?: string }, admin: Caller): Promise<boolean> {
    if (!admin.adminTeams) return true;
    if (user.user_type === 'system_admin') return false;
    return activeMemberOf(user.user_id, admin.adminTeams);
  }

  /** Active member of one of the teams this caller administers. */
  async function activeMemberOf(userId: string, teams: Array<{ team_id: string }>): Promise<boolean> {
    for (const team of teams) {
      const membership = await meta.members.get(deps.instanceId, team.team_id, userId);
      if (membership?.status === 'active') return true;
    }
    return false;
  }

  /** Parses the body, checks the caller may manage pending users, and runs the handler. */
  function route<S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    handler: (input: z.infer<S>, admin: Caller) => Promise<unknown>,
  ): void {
    api.post(path, async (c) => {
      const user = await auth.requireUser(c);
      if (user instanceof Response) return user;
      const raw = await c.req.json().catch(() => ({}));
      const parsed = schema.safeParse(raw ?? {});
      try {
        const sameInstance = user.instanceId === deps.instanceId;
        // Checked on the caller's own instance: a user ID means nothing on another one.
        const adminTeams = await teamsForCaller(user.instanceId, user.userId, user.isSystemAdmin);
        // Before the body check, so a member learns they are refused rather than how to shape the body.
        if (!user.isSystemAdmin && adminTeams?.length === 0) return envelope(c, 403, 'NOT_TEAM_ADMIN', null);
        if (!parsed.success) return envelope(c, 400, 'INVALID_PARAM', null);
        const data = await handler(parsed.data, {
          userId: user.userId,
          sameInstance,
          isSystemAdmin: user.isSystemAdmin,
          // Teams of another instance cannot be approved into here.
          adminTeams: user.isSystemAdmin ? null : sameInstance ? adminTeams : [],
        });
        return envelope(c, 200, 'ok', data);
      } catch (err) {
        if (err instanceof ApiError) return envelope(c, err.status, err.code, err.data);
        const code = err instanceof MetaError ? err.code : 'unexpected';
        // Codes only: Core errors can echo the names and addresses of the people involved.
        logger.error('vtc admin action failed', { path, code });
        return envelope(c, 502, 'CORE_ERROR', { code });
      }
    });
  }

  function load(id: string, sameInstance: boolean): PendingRecord {
    const record = sameInstance ? pending.get(id) : null;
    if (!record || record.instanceId !== deps.instanceId) throw new ApiError(404, 'PENDING_NOT_FOUND');
    return record;
  }

  /** A first request that is refused or cleared must not leave a link that would let the person in later. */
  async function dropLinkOfNewRequest(record: PendingRecord): Promise<void> {
    if (record.kind !== 'new' || !links.find(deps.instanceId, record.vtcUserId)) return;
    await links.remove(deps.instanceId, record.vtcUserId);
    audit('vtc.link.dropped', { vtc_user_id: record.vtcUserId, reason: 'request_closed' });
  }

  route('/pending/teams', emptyBody, async (_input, admin) => {
    if (!admin.sameInstance) return { teams: [] };
    if (admin.isSystemAdmin) {
      // Any role: a system admin approves into every team they belong to, not only ones they administer.
      return { teams: await everyTeam(deps.instanceId, admin.userId) };
    }
    return { teams: admin.adminTeams ?? [] };
  });

  route('/pending/count', emptyBody, async (_input, admin) => ({
    pending_count: admin.sameInstance ? pending.list(deps.instanceId).filter((r) => r.status === 'pending').length : 0,
  }));

  route('/pending/list', emptyBody, async (_input, admin) => {
    const records = admin.sameInstance ? pending.list(deps.instanceId) : [];
    const items = [];
    for (const r of records) {
      const item: Record<string, unknown> = {
        pending_id: r.id,
        email: r.email,
        vtc_user_id: r.vtcUserId,
        kind: r.kind,
        status: r.status,
        source: r.source,
        first_login_at: r.firstLoginAt,
        last_login_at: r.lastLoginAt,
        login_count: r.loginCount,
      };
      if (r.coreUserId) item.core_user_id = r.coreUserId;
      if (r.kind === 'no_team' && r.coreUserId) {
        // A lookup failure leaves the name out; it must not hide the whole list.
        item.core_username = await meta.users
          .get(deps.instanceId, r.coreUserId)
          .then((u) => u?.username ?? null)
          .catch(() => null);
      }
      if (r.rejectedAt) item.rejected_at = r.rejectedAt;
      if (r.reason) item.reason = r.reason;
      items.push(item);
    }
    return { items, pending_count: records.filter((r) => r.status === 'pending').length };
  });

  route('/pending/candidates', idBody, async (input, admin) => {
    const record = load(input.pending_id, admin.sameInstance);
    // A person with an account is already known; there is nobody to compare with.
    if (record.kind === 'no_team') return { kind: record.kind, candidates: [] };
    const found = await findCandidates(meta, links, deps.instanceId, record);
    return { kind: record.kind, candidates: await candidatesForCaller(found, admin) };
  });

  route('/pending/reject', rejectBody, async (input, admin) => {
    const record = load(input.pending_id, admin.sameInstance);
    if (record.status !== 'pending') throw new ApiError(409, 'PENDING_NOT_PENDING');
    if (approving.has(record.id)) throw new ApiError(409, 'APPROVAL_IN_PROGRESS');
    const rejected = await pending.reject(record.id, admin.userId, input.reason);
    if (!rejected) throw new ApiError(404, 'PENDING_NOT_FOUND');
    await dropLinkOfNewRequest(record);
    audit('vtc.pending.rejected', { pending_id: record.id, actor: admin.userId });
    return { pending_id: record.id, status: rejected.status };
  });

  route('/pending/reset', idBody, async (input, admin) => {
    const record = load(input.pending_id, admin.sameInstance);
    if (record.status !== 'rejected') throw new ApiError(409, 'PENDING_NOT_REJECTED');
    if (approving.has(record.id)) throw new ApiError(409, 'APPROVAL_IN_PROGRESS');
    await dropLinkOfNewRequest(record);
    if (!(await pending.reopen(record.id))) throw new ApiError(404, 'PENDING_NOT_FOUND');
    audit('vtc.pending.reset', { pending_id: record.id, actor: admin.userId });
    return { pending_id: record.id, status: 'pending' };
  });

  route('/pending/approve', approveBody, async (input, admin) => {
    const record = load(input.pending_id, admin.sameInstance);
    if (record.status !== 'pending') throw new ApiError(409, 'PENDING_NOT_PENDING');
    if (admin.adminTeams && !admin.adminTeams.some((team) => team.team_id === input.team_id)) {
      throw new ApiError(403, 'TEAM_NOT_ALLOWED');
    }
    if (!(await meta.teams.get(deps.instanceId, input.team_id))) throw new ApiError(404, 'TEAM_NOT_FOUND');
    if (approving.has(record.id)) throw new ApiError(409, 'APPROVAL_IN_PROGRESS');
    approving.add(record.id);
    try {
      return await serializedApproval(async () => {
        // Another request may have decided the record while the team lookup or an earlier approval was awaited.
        const current = pending.get(record.id);
        if (!current) throw new ApiError(404, 'PENDING_NOT_FOUND');
        if (current.status !== 'pending') throw new ApiError(409, 'PENDING_NOT_PENDING');
        return approve(current, input, admin);
      });
    } finally {
      approving.delete(record.id);
    }
  });

  async function approve(record: PendingRecord, input: z.infer<typeof approveBody>, admin: Caller) {
    const { instanceId } = deps;
    const adminUserId = admin.userId;
    const person = await resolveCoreUser(record, input, admin);
    const { coreUserId } = person;

    // Membership: an active member keeps the role they have; changing it silently is not this action's job.
    const membership = await meta.members.get(instanceId, input.team_id, coreUserId);
    const roleKept = membership?.status === 'active';
    const role: TeamRole = roleKept ? membership.role : input.role;
    if (!roleKept) await meta.members.add(instanceId, input.team_id, coreUserId, input.role);

    // Decided by the state now, not by whether add ran, so a retry after a failure still provisions. Without
    // an owned agent MemoryProxy bypasses the session and nothing is captured for the user.
    const owned = (await meta.agents.listOwned(instanceId, input.team_id, coreUserId)).length > 0;
    const hasAgent = owned || (await meta.members.provisionDefaults(instanceId, input.team_id, coreUserId));
    const warnings = hasAgent ? [] : ['default_agent_missing'];

    // The link is what lets the person in, so it is written only after every step above worked.
    await person.commitLink();
    await pending.remove(record.id);
    audit('vtc.pending.approved', {
      pending_id: record.id,
      core_user_id: coreUserId,
      team_id: input.team_id,
      role,
      mode: person.mode,
      role_kept: roleKept,
      actor: adminUserId,
    });
    return {
      core_user_id: coreUserId,
      username: person.username,
      mode: person.mode,
      team_id: input.team_id,
      role,
      role_kept: roleKept,
      warnings,
    };
  }

  /** Finds or makes the Core user of the request. The link is returned as a step to run last. Every step can be repeated after a failure. */
  async function resolveCoreUser(
    record: PendingRecord,
    input: z.infer<typeof approveBody>,
    admin: Caller,
  ): Promise<{ coreUserId: string; username: string; mode: ApprovedMode; commitLink: () => Promise<void> }> {
    const { instanceId } = deps;
    const noLink = async () => {};
    const linkLater = (coreUserId: string, mode: 'linked' | 'created' | 'recovered') => () =>
      links.upsert({
        instanceId,
        vtcUserId: record.vtcUserId,
        coreUserId,
        mode,
        linkedAt: new Date().toISOString(),
        linkedBy: admin.userId,
      });

    if (record.kind === 'no_team') {
      const user = record.coreUserId ? await meta.users.get(instanceId, record.coreUserId) : null;
      if (!user) throw new ApiError(404, 'USER_NOT_FOUND');
      return { coreUserId: user.user_id, username: user.username, mode: 'existing', commitLink: noLink };
    }

    // A link from an earlier attempt that failed after the link was written. A new choice of the
    // administrator must not be overridden by it. A link to a deleted user is dropped instead.
    const earlier = links.find(instanceId, record.vtcUserId);
    if (earlier) {
      const user = await meta.users.get(instanceId, earlier.coreUserId);
      if (user) {
        // A recovered link is still a link target: a team admin cannot finish one outside their teams.
        if (!(await linkableForCaller(user, admin))) throw new ApiError(409, 'USER_NOT_LINKABLE');
        const sameChoice =
          !input.mode ||
          (input.mode === 'link' ? input.link_user_id === earlier.coreUserId : earlier.mode !== 'linked');
        if (!sameChoice) throw new ApiError(409, 'LINK_CONFLICT');
        return { coreUserId: user.user_id, username: user.username, mode: 'existing', commitLink: noLink };
      }
      await links.remove(instanceId, record.vtcUserId);
    }

    if (!input.mode) throw new ApiError(400, 'MODE_REQUIRED');

    if (input.mode === 'link') {
      if (!input.link_user_id) throw new ApiError(400, 'LINK_USER_REQUIRED');
      // The same list the candidates come from, so the server applies the filters the UI shows.
      const detail = (await meta.users.listAllDetailed(instanceId)).find((u) => u.user_id === input.link_user_id);
      if (!detail) throw new ApiError(404, 'USER_NOT_FOUND');
      if (
        detail.user_type === 'system_admin' ||
        !isLinkTarget(detail, links, instanceId, record.vtcUserId) ||
        !(await linkableForCaller(detail, admin))
      ) {
        throw new ApiError(409, 'USER_NOT_LINKABLE');
      }
      const user = detail;
      const owner = links.findByCoreUser(instanceId, user.user_id);
      if (owner && owner.vtcUserId !== record.vtcUserId) throw new ApiError(409, 'USER_ALREADY_LINKED');
      // Core already binds this VTC person to an account; linking another one would split their data.
      const bound = await meta.users.findByExternal(instanceId, VTC_AUTH_PROVIDER, record.vtcUserId);
      if (bound && bound.user_id !== user.user_id) throw new ApiError(409, 'VTC_ACCOUNT_EXISTS');
      // The Core binding of the user (WOA or local) is left as it is.
      return { coreUserId: user.user_id, username: user.username, mode: 'linked', commitLink: linkLater(user.user_id, 'linked') };
    }

    // mode: create. An earlier attempt may have made the user and failed before the link was written.
    const bound = await meta.users.findByExternal(instanceId, VTC_AUTH_PROVIDER, record.vtcUserId);
    if (bound) {
      const user = await meta.users.get(instanceId, bound.user_id);
      if (!user) throw new ApiError(404, 'USER_NOT_FOUND');
      return { coreUserId: bound.user_id, username: user.username, mode: 'recovered', commitLink: linkLater(bound.user_id, 'recovered') };
    }
    const candidates = await candidatesForCaller(await findCandidates(meta, links, instanceId, record), admin);
    if (candidates.length > 0 && input.confirm_create !== true) {
      throw new ApiError(409, 'CANDIDATES_EXIST', { candidates });
    }
    const local = emailLocalPart(record.email);
    const username = await uniqueUsername(meta, instanceId, safeUsername(local));
    const created = await meta.users.create(instanceId, {
      username,
      external_id: record.vtcUserId,
      auth_provider: VTC_AUTH_PROVIDER,
      email: record.email,
      display_name: local,
    });
    return { coreUserId: created.user_id, username, mode: 'created', commitLink: linkLater(created.user_id, 'created') };
  }
}
