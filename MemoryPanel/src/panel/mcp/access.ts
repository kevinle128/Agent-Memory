/**
 * Who is calling and which teams the caller may read.
 *
 * Rules that every MCP tool inherits:
 * - The caller comes from Core `auth/verify` with the user key of the request.
 *   The `user_id` sent to Core is always the caller's. No tool argument supplies it.
 * - Access is per team and is read from Core at call time: the active membership of
 *   the caller in that team. A role in one team gives nothing in another team.
 * - A system admin has no override. Their scope is their own memberships.
 * - A team that does not exist and a team the caller cannot read give the same error.
 * - Nothing is kept between HTTP requests. `createRequestAccess` memoizes for one request only.
 */
import type { PanelDeps } from '../panel-deps.js';
import type { MetaCallContext } from '../kernel/types.js';
import type { MetaEnvelope } from '../kernel/envelope.js';
import {
  checkKnowledgeRead,
  fetchAllMetaListItems,
  type KnowledgeReadCheck,
} from '../http/routes/knowledge/common.js';
import type { KnowledgeClientPort } from '../kernel/ports/knowledge-client-port.js';
import { resolveTeamRole, type TeamRole } from '../authz/team-role.js';
import { DeadlineExceededError, createRequestLifecycle, type RequestLifecycle } from './guards.js';

/** Same id rule as the proxy and the Processing History filters. */
const TEAM_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ECHO_ID_MAX = 64;
const ROLE_LOOKUP_CONCURRENCY = 8;

export interface Caller {
  userId: string;
  username: string;
  /** Shown by `whoami` only. No access rule reads it. */
  userType: string;
}

export interface ScopeEntry {
  team_id: string;
  team_name: string;
  role: TeamRole;
  /** `team`: the caller may read what the team shares and what the caller manages. `own`: shared and own assets. */
  scope: 'team' | 'own';
}

export type NotReadableKind = 'team' | 'asset';

/** The one error for "you may not read this", whatever the reason. */
export class NotReadableError extends Error {
  constructor(readonly kind: NotReadableKind, id: unknown) {
    super(
      kind === 'team'
        ? `No readable team with id ${echoId(id)}.`
        : `No readable wiki or code graph with id ${echoId(id)}.`,
    );
    this.name = 'NotReadableError';
  }
}

/** Core could not answer. The caller is not told why. */
export class UpstreamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamUnavailableError';
  }
}

function echoId(id: unknown): string {
  return String(id).slice(0, ECHO_ID_MAX);
}

function scopeOf(role: TeamRole): ScopeEntry['scope'] {
  return role === 'admin' ? 'team' : 'own';
}

/** One `auth/verify` call. `null` means the key is invalid, expired or revoked. */
export async function resolveCaller(deps: PanelDeps, ctx: MetaCallContext): Promise<Caller | null> {
  if (!ctx.userKey) return null;
  const env = await deps.metaKernel.invoke('auth/verify', { user_key: ctx.userKey }, ctx);
  if (env.code >= 500) throw new UpstreamUnavailableError(`auth/verify failed with code ${env.code}`);
  const data = env.data as {
    valid?: boolean;
    user?: { user_id?: string; username?: string; user_type?: string } | null;
  } | null;
  const user = env.code === 0 && data?.valid ? data.user : null;
  if (!user || typeof user.user_id !== 'string' || !user.user_id) return null;
  return {
    userId: user.user_id,
    username: typeof user.username === 'string' ? user.username : '',
    userType: typeof user.user_type === 'string' ? user.user_type : '',
  };
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

interface TeamRow {
  team_id?: string;
  name?: string;
}

/**
 * Teams in scope for the caller.
 *
 * Without `teamIdArg`: every team of the caller's active memberships, each with the role
 * read from its own member row.
 * With `teamIdArg`: that team only. A missing, malformed, unknown or foreign team id
 * throws the same `NotReadableError`. `team/get` runs only after the membership check passed.
 */
export async function resolveScope(
  deps: PanelDeps,
  ctx: MetaCallContext,
  caller: Caller,
  teamIdArg?: unknown,
): Promise<ScopeEntry[]> {
  if (teamIdArg !== undefined && teamIdArg !== null) {
    if (typeof teamIdArg !== 'string' || !TEAM_ID_RE.test(teamIdArg)) {
      throw new NotReadableError('team', teamIdArg);
    }
    return [await resolveOneTeam(deps, ctx, caller, teamIdArg)];
  }

  const teams = await fetchAllMetaListItems<TeamRow>(
    deps,
    ctx,
    'team/list',
    { user_id: caller.userId },
    (env: MetaEnvelope<unknown>) => {
      throw new UpstreamUnavailableError(`team/list failed with code ${env.code}`);
    },
  );
  const seen = new Set<string>();
  const unique = teams.filter((t): t is Required<TeamRow> => {
    if (typeof t.team_id !== 'string' || !t.team_id || seen.has(t.team_id)) return false;
    seen.add(t.team_id);
    return true;
  });
  const roles = await mapLimited(unique, ROLE_LOOKUP_CONCURRENCY, (t) =>
    lookupRole(deps, ctx, caller, t.team_id),
  );
  const scope: ScopeEntry[] = [];
  unique.forEach((t, i) => {
    const role = roles[i];
    if (role) {
      scope.push({
        team_id: t.team_id,
        team_name: typeof t.name === 'string' ? t.name : '',
        role,
        scope: scopeOf(role),
      });
    }
  });
  return scope;
}

async function lookupRole(
  deps: PanelDeps,
  ctx: MetaCallContext,
  caller: Caller,
  teamId: string,
): Promise<TeamRole | null> {
  try {
    return await resolveTeamRole(deps, ctx, caller.userId, teamId);
  } catch (err) {
    throw new UpstreamUnavailableError(err instanceof Error ? err.message : String(err));
  }
}

async function resolveOneTeam(
  deps: PanelDeps,
  ctx: MetaCallContext,
  caller: Caller,
  teamId: string,
): Promise<ScopeEntry> {
  const role = await lookupRole(deps, ctx, caller, teamId);
  if (!role) throw new NotReadableError('team', teamId);
  const env = await deps.metaKernel.invoke('team/get', { team_id: teamId }, ctx);
  if (env.code >= 500) throw new UpstreamUnavailableError(`team/get failed with code ${env.code}`);
  const team = env.data as TeamRow | null;
  if (env.code !== 0 || !team) throw new NotReadableError('team', teamId);
  return {
    team_id: teamId,
    team_name: typeof team.name === 'string' ? team.name : '',
    role,
    scope: scopeOf(role),
  };
}

/** The read calls of the knowledge service that the tools need. No write call is reachable. */
export type KnowledgeReader = Pick<
  KnowledgeClientPort,
  'codeGraphGet' | 'codeGraphQuery' | 'wikiGet' | 'wikiSearch' | 'wikiPageRead' | 'wikiPageLs' | 'wikiGraph'
>;

/**
 * What a tool gets. It has no raw `deps`, `ctx` or request lifecycle: Core is reached through
 * `core`, which always sends the key of the caller, is tracked by the route, and stops once the
 * request is over.
 */
export interface RequestAccess {
  caller: Caller;
  /** Teams in scope. With `teamId`, only that team, or `NotReadableError`. */
  scope(teamId?: unknown): Promise<ScopeEntry[]>;
  /** One Core call as the caller. Throws `DeadlineExceededError` when the request is over. */
  core(action: string, body: Record<string, unknown>): Promise<MetaEnvelope>;
  /**
   * Every row of a paged Core list, as the caller. A failed page throws `UpstreamUnavailableError`,
   * so an outage is never read as an empty list.
   */
  coreList<T>(action: string, body: Record<string, unknown>): Promise<T[]>;
  /**
   * The knowledge service, read calls only. Like `core`, every call is tracked by the route and
   * refused once the request is over. It does not check who may read an asset: use `checkKnowledgeRead`.
   */
  knowledge(): KnowledgeReader;
  /**
   * The read gate of the Panel UI for one wiki or code graph, for the caller of this request.
   * Returns the denial reason; the tool turns every reason into the one not-readable error.
   */
  checkKnowledgeRead(
    knowledgeId: string,
    opts?: { allowInFlightCodeOwner?: boolean },
  ): Promise<KnowledgeReadCheck>;
  /** Team ids that this request resolved, for the log line. */
  resolvedTeamIds(): string[];
}

export function createRequestAccess(
  deps: PanelDeps,
  ctx: MetaCallContext,
  caller: Caller,
  lifecycle: RequestLifecycle = createRequestLifecycle(),
): RequestAccess {
  const memo = new Map<string, Promise<ScopeEntry[]>>();
  const resolved = new Set<string>();
  const core = (action: string, body: Record<string, unknown>): Promise<MetaEnvelope> => {
    // A call after the deadline would only add load: the caller already has its answer.
    if (lifecycle.stopped()) return Promise.reject(new DeadlineExceededError());
    // Every Core call is tracked, so the route keeps its slot until each one settles,
    // also when a tool does not await the result.
    return lifecycle.track(deps.metaKernel.invoke(action, body, ctx));
  };
  // Same rule for the knowledge service: no call after the deadline, and every call is tracked.
  const guardKnowledge = <T>(call: () => Promise<T>): Promise<T> => {
    if (lifecycle.stopped()) return Promise.reject(new DeadlineExceededError());
    return lifecycle.track(call());
  };
  const reader = (): KnowledgeClientPort => deps.knowledgeClientFactory(ctx.instanceId);
  const knowledgeReader: KnowledgeReader = {
    codeGraphGet: (id) => guardKnowledge(() => reader().codeGraphGet(id)),
    codeGraphQuery: (id, tool, params, opts) =>
      guardKnowledge(() => reader().codeGraphQuery(id, tool, params, opts)),
    wikiGet: (id) => guardKnowledge(() => reader().wikiGet(id)),
    wikiSearch: (id, query, limit, graph) => guardKnowledge(() => reader().wikiSearch(id, query, limit, graph)),
    wikiPageRead: (id, refs) => guardKnowledge(() => reader().wikiPageRead(id, refs)),
    wikiPageLs: (id) => guardKnowledge(() => reader().wikiPageLs(id)),
    wikiGraph: (id) => guardKnowledge(() => reader().wikiGraph(id)),
  };
  const guarded: PanelDeps = { ...deps, metaKernel: { invoke: (action, body) => core(action, body) } };
  return {
    caller,
    core,
    coreList: <T>(action: string, body: Record<string, unknown>) =>
      fetchAllMetaListItems<T>(guarded, ctx, action, body, (env: MetaEnvelope<unknown>) => {
        throw new UpstreamUnavailableError(`${action} failed with code ${env.code}`);
      }),
    knowledge: () => knowledgeReader,
    async checkKnowledgeRead(knowledgeId, opts) {
      // The gate reads a Core failure as "no access". Track it here, so an outage is not shown as a refusal.
      let coreFailed = false;
      const check = await checkKnowledgeRead(
        {
          metaKernel: {
            invoke: async (action, body) => {
              const env = await core(action, body);
              if (env.code >= 500) coreFailed = true;
              return env;
            },
          },
          knowledgeClientFactory: () => knowledgeReader,
        },
        ctx,
        knowledgeId,
        { allowInFlightCodeOwner: opts?.allowInFlightCodeOwner === true, action: 'read', userId: caller.userId },
      );
      if (!check.ok && coreFailed) throw new UpstreamUnavailableError('knowledge read check failed');
      return check;
    },
    scope(teamId?: unknown) {
      const key = teamId === undefined || teamId === null ? '*' : `t:${String(teamId)}`;
      let pending = memo.get(key);
      if (!pending) {
        pending = resolveScope(guarded, ctx, caller, teamId).then((entries) => {
          for (const e of entries) resolved.add(e.team_id);
          return entries;
        });
        memo.set(key, pending);
      }
      return pending;
    },
    resolvedTeamIds: () => [...resolved],
  };
}
