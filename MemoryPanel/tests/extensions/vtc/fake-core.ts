import { vi } from 'vitest';
import type { PanelDeps } from '../../../src/panel/panel-deps.js';

/** The instance api_key the fixture registers; seedAdmin() makes it a system admin key, as the deployment requires. */
export const FAKE_API_KEY = 'test-gateway-key-not-real';
const DEFAULT_MAX_ACTIVE_KEYS = 20;

/** Read per call, the way Core reads TDAI_USER_KEY_MAX_ACTIVE (metadata-service.ts:981-984). */
function maxActiveKeys(): number {
  const fromEnv = Number(process.env.TDAI_USER_KEY_MAX_ACTIVE);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MAX_ACTIVE_KEYS;
}

interface FakeUser {
  user_id: string;
  username: string;
  user_type: string;
  email: string | null;
  display_name: string | null;
  auth_provider: string;
  external_id: string;
  status: string;
  password_hash: string;
  created_at: string;
}
export interface FakeKey {
  key_id: string;
  user_id: string;
  name: string;
  key_value: string;
  status: 'active' | 'revoked';
  expires_at: string | null;
  isDefault: boolean;
}
interface FakeTeam {
  team_id: string;
  name: string;
  owner_user_id: string;
}
interface FakeMember {
  team_id: string;
  user_id: string;
  role: string;
  status: string;
}
interface FakeAgent {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  status: string;
}
export interface FakeCall {
  action: string;
  body: Record<string, unknown>;
  userKey?: string;
}

class CoreError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}
const bad = (text: string) => new CoreError(400, text);
const missing = (text: string) => new CoreError(404, text);

/**
 * An in-memory copy of the Core actions the extension uses, so app-level tests run without Core.
 * The rules the extension relies on are copied from Core and cited next to each one.
 */
export function createFakeCore(options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  let counter = 0;
  const id = (prefix: string) => `${prefix}-${String(++counter).padStart(4, '0')}`;
  const users = new Map<string, FakeUser>();
  const keys = new Map<string, FakeKey>();
  const teams = new Map<string, FakeTeam>();
  const members: FakeMember[] = [];
  const agents: FakeAgent[] = [];
  const calls: FakeCall[] = [];
  const failures = new Map<string, number>();

  function newKey(userId: string, name: string, expiresAt: string | null, isDefault: boolean, value?: string): FakeKey {
    const key: FakeKey = {
      key_id: id('key'),
      user_id: userId,
      name,
      key_value: value ?? `sk-mem-test-${String(counter).padStart(8, '0')}${'0'.repeat(20)}`,
      status: 'active',
      expires_at: expiresAt,
      isDefault,
    };
    keys.set(key.key_id, key);
    return key;
  }

  function addUser(input: {
    username: string;
    email?: string | null;
    auth_provider?: string;
    external_id?: string;
    user_type?: string;
    display_name?: string | null;
  }): FakeUser {
    const user: FakeUser = {
      user_id: id('usr'),
      username: input.username,
      user_type: input.user_type ?? 'user',
      email: input.email ?? null,
      display_name: input.display_name ?? null,
      auth_provider: input.auth_provider ?? 'local',
      external_id: input.external_id ?? '',
      status: 'active',
      password_hash: 'fake-password-hash-not-real',
      created_at: now().toISOString(),
    };
    users.set(user.user_id, user);
    return user;
  }

  const activeKeys = (userId: string) => [...keys.values()].filter((k) => k.user_id === userId && k.status === 'active');
  const isLive = (key: FakeKey) => key.status === 'active' && (key.expires_at === null || Date.parse(key.expires_at) > now().getTime());
  const publicUser = (u: FakeUser) => ({
    user_id: u.user_id,
    username: u.username,
    user_type: u.user_type,
    email: u.email,
    display_name: u.display_name,
    auth_provider: u.auth_provider,
    external_id: u.external_id,
    status: u.status,
  });
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const requireUser = (userId: unknown): FakeUser => {
    const user = users.get(text(userId));
    if (!user) throw missing('user_not_found: no such user');
    return user;
  };
  const activeMembership = (teamId: string, userId: string) =>
    members.find((m) => m.team_id === teamId && m.user_id === userId && m.status === 'active');

  function handle(action: string, body: Record<string, unknown>): unknown {
    switch (action) {
      case 'user/create': {
        // Core makes a user together with an active default key (metadata-service.ts:621-639).
        const user = addUser({
          username: text(body.username),
          email: typeof body.email === 'string' ? body.email : null,
          display_name: typeof body.display_name === 'string' ? body.display_name : null,
          auth_provider: text(body.auth_provider),
          external_id: text(body.external_id),
        });
        const key = newKey(user.user_id, 'default', null, true);
        return { user_id: user.user_id, default_user_key: key.key_value };
      }
      case 'user/get':
        return publicUser(requireUser(body.user_id));
      case 'user/find-by-external': {
        const found = [...users.values()].find(
          (u) => u.external_id === text(body.external_id) && u.auth_provider === text(body.auth_provider),
        );
        if (!found) throw missing('user_not_found: no such user');
        return publicUser(found);
      }
      case 'user/list': {
        // Public listing: ids, type and username only; the username filter is exact (types.ts:302-314).
        const list = [...users.values()].filter((u) => !body.username || u.username === body.username);
        return {
          items: list.map((u) => ({ user_id: u.user_id, user_type: u.user_type, username: u.username, created_at: u.created_at })),
          total: list.length,
        };
      }
      case 'user-key/create': {
        const user = requireUser(body.user_id);
        // Expired-but-active keys count toward the cap (metadata-service.ts:893-911).
        if (activeKeys(user.user_id).length >= maxActiveKeys()) throw bad('key_limit_exceeded: too many keys');
        const key = newKey(user.user_id, text(body.name), typeof body.expires_at === 'string' ? body.expires_at : null, false);
        return { key_id: key.key_id, key_value: key.key_value, expires_at: key.expires_at };
      }
      case 'user-key/get': {
        const key = keys.get(text(body.key_id));
        if (!key) throw missing('user_key_not_found: no such key');
        return { key_id: key.key_id, user_id: key.user_id, status: key.status, expires_at: key.expires_at, name: key.name };
      }
      case 'user-key/update': {
        const key = keys.get(text(body.key_id));
        if (!key) throw missing('user_key_not_found: no such key');
        if (typeof body.expires_at === 'string') key.expires_at = body.expires_at;
        return { key_id: key.key_id };
      }
      case 'user-key/revoke': {
        const key = keys.get(text(body.key_id));
        if (!key) throw missing('user_key_not_found: no such key');
        // Core refuses when one active key is left, even if the key named is already revoked (metadata-service.ts:954-958).
        if (activeKeys(key.user_id).length <= 1) throw bad('last_key_cannot_revoke: last active key');
        key.status = 'revoked';
        return { key_id: key.key_id };
      }
      case 'auth/verify': {
        // An expired or revoked key is not valid (sqlite-adapter.ts:841-847).
        const key = [...keys.values()].find((k) => k.key_value === text(body.user_key));
        if (!key || !isLive(key)) return { valid: false };
        return { valid: true, user: publicUser(requireUser(key.user_id)) };
      }
      case 'team/get': {
        const team = teams.get(text(body.team_id));
        if (!team) throw missing('team_not_found: no such team');
        return team;
      }
      case 'team/list': {
        const ids = new Set(members.filter((m) => m.user_id === body.user_id && m.status === 'active').map((m) => m.team_id));
        const all = [...teams.values()].filter((t) => ids.has(t.team_id));
        const offset = typeof body.offset === 'number' && body.offset > 0 ? Math.floor(body.offset) : 0;
        const limit = typeof body.limit === 'number' && body.limit >= 0 ? Math.floor(body.limit) : all.length;
        return { items: all.slice(offset, offset + limit), total: all.length };
      }
      case 'team-member/get': {
        const member = members.find((m) => m.team_id === body.team_id && m.user_id === body.user_id);
        if (!member) throw missing('team_member_not_found: no such member');
        return { team_id: member.team_id, user_id: member.user_id, role: member.role, status: member.status };
      }
      case 'team-member/add': {
        requireUser(body.user_id);
        const existing = activeMembership(text(body.team_id), text(body.user_id));
        if (existing && existing.role === body.role) throw bad('member_already_exists: user is already a member');
        if (existing) existing.role = text(body.role);
        else members.push({ team_id: text(body.team_id), user_id: text(body.user_id), role: text(body.role), status: 'active' });
        return {};
      }
      case 'agent/list': {
        const items = agents.filter((a) => a.team_id === body.team_id && (!body.owner_user_id || a.owner_user_id === body.owner_user_id));
        return { items, total: items.length };
      }
      case 'agent/create': {
        const agent: FakeAgent = {
          agent_id: id('agt'),
          team_id: text(body.team_id),
          owner_user_id: text(body.owner_user_id),
          name: text(body.name),
          status: 'active',
        };
        agents.push(agent);
        return { agent_id: agent.agent_id };
      }
      default:
        throw bad(`unsupported_action: ${action}`);
    }
  }

  function envelope(action: string, body: Record<string, unknown>, userKey: string | undefined) {
    calls.push({ action, body, ...(userKey ? { userKey } : {}) });
    const remaining = failures.get(action) ?? 0;
    if (remaining > 0) {
      failures.set(action, remaining - 1);
      throw new Error('fetch failed');
    }
    try {
      return { code: 0, message: 'ok', request_id: 'req', data: handle(action, body) };
    } catch (err) {
      if (err instanceof CoreError) return { code: err.status, message: err.message, request_id: 'req', data: null };
      throw err;
    }
  }

  const core = {
    calls,
    /** Makes the next call of `action` fail like an unreachable Core. */
    failNext(action: string, times = 1): void {
      failures.set(action, times);
    },
    /** Replaces the Core ports of the deps; the facade reads them at call time. */
    install(deps: PanelDeps): void {
      deps.metaKernel = {
        invoke: vi.fn(async (action: string, body: Record<string, unknown>, ctx: { userKey?: string }) =>
          envelope(action, body, ctx.userKey),
        ),
      } as unknown as PanelDeps['metaKernel'];
      deps.kernelHttp = {
        postEnvelope: vi.fn(async (path: string, body: Record<string, unknown>, cred: { userKey?: string }) => {
          if (path === '/v3/internal/meta/user/list-by-instance') {
            // The internal listing returns full entities, password hash included.
            calls.push({ action: 'internal/user/list-by-instance', body });
            const limit = typeof body.limit === 'number' ? body.limit : 100;
            const offset = typeof body.offset === 'number' ? body.offset : 0;
            const all = [...users.values()];
            return { code: 0, message: 'ok', request_id: 'req', data: { items: all.slice(offset, offset + limit), total: all.length } };
          }
          return envelope(path.replace(/^\/v3\/meta\//, ''), body, cred.userKey);
        }),
      } as unknown as PanelDeps['kernelHttp'];
      deps.skillKernel = {
        invoke: vi.fn(async () => ({ code: 0, message: 'ok', request_id: 'req', data: {} })),
      } as unknown as PanelDeps['skillKernel'];
    },
    seedAdmin(): { user_id: string; key_value: string } {
      const admin = addUser({ username: 'admin', user_type: 'system_admin' });
      newKey(admin.user_id, 'instance', null, false, FAKE_API_KEY);
      return { user_id: admin.user_id, key_value: FAKE_API_KEY };
    },
    seedTeam(name: string): { team_id: string; name: string } {
      const owner = [...users.values()].find((u) => u.user_type === 'system_admin') ?? addUser({ username: 'team-owner' });
      const team: FakeTeam = { team_id: id('team'), name, owner_user_id: owner.user_id };
      teams.set(team.team_id, team);
      return team;
    },
    /** A user made the way Core makes one: with an active default key. */
    seedUser(input: { username: string; email?: string; auth_provider?: string; external_id?: string; user_type?: string }): {
      user_id: string;
      default_key_value: string;
    } {
      const user = addUser(input);
      const key = newKey(user.user_id, 'default', null, true);
      return { user_id: user.user_id, default_key_value: key.key_value };
    },
    addMember(teamId: string, userId: string, role = 'member', status = 'active'): void {
      members.push({ team_id: teamId, user_id: userId, role, status });
    },
    /** Adds active untracked keys, for example to reach Core's cap. */
    addKeys(userId: string, count: number): void {
      for (let i = 0; i < count; i += 1) newKey(userId, `extra-${i}`, null, false);
    },
    /** Read-only views of the Core state, for assertions. */
    userById(userId: string): Omit<FakeUser, 'password_hash'> | undefined {
      const user = users.get(userId);
      if (!user) return undefined;
      const { password_hash: _hash, ...rest } = user;
      return rest;
    },
    findUser(match: (user: Omit<FakeUser, 'password_hash'>) => boolean): Omit<FakeUser, 'password_hash'> | undefined {
      return [...users.values()].map(({ password_hash: _hash, ...rest }) => rest).find(match);
    },
    memberOf(teamId: string, userId: string): { role: string; status: string } | undefined {
      const member = members.find((m) => m.team_id === teamId && m.user_id === userId);
      return member ? { role: member.role, status: member.status } : undefined;
    },
    agentsOf(teamId: string, userId: string): string[] {
      return agents.filter((a) => a.team_id === teamId && a.owner_user_id === userId).map((a) => a.name);
    },
    setStatus(userId: string, status: string): void {
      requireUser(userId).status = status;
    },
    removeUser(userId: string): void {
      users.delete(userId);
    },
    keysOf(userId: string): FakeKey[] {
      return [...keys.values()].filter((k) => k.user_id === userId);
    },
    userCount: () => users.size,
    /** Calls that changed Core state. */
    writes(): FakeCall[] {
      return calls.filter((c) => /^(user\/create|user-key\/(create|update|revoke)|team-member\/add|agent\/create)$/.test(c.action));
    },
  };
  return core;
}

export type FakeCore = ReturnType<typeof createFakeCore>;
