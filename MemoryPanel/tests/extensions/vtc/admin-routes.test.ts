import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAKE_API_KEY, createFakeCore, type FakeCore } from './fake-core.js';
import { buildVtcApp, cleanupVtcApps, continueRequest, makeUd, ssoNow, startWebLogin, writeExtensionFile } from './vtc-fixtures.js';

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupVtcApps();
});

const SESSION_COOKIE = 'tdai_idp_session';
const ADMIN_HEADERS = { 'X-Tdai-Service-Id': 'default', 'X-Tdai-User-Key': FAKE_API_KEY, 'content-type': 'application/json' };

interface Reply {
  status: number;
  // The shape differs per route; each test reads only the fields it checks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: { code: number; message: string; data: any };
}

type App = Awaited<ReturnType<typeof buildVtcApp>>;

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pnd_1',
    instanceId: 'default',
    vtcUserId: '10482',
    email: 'new.person@vtc.vn',
    kind: 'new',
    status: 'pending',
    source: 'web',
    firstLoginAt: '2026-11-19T01:00:00.000Z',
    lastLoginAt: '2026-11-19T01:00:00.000Z',
    loginCount: 1,
    ...overrides,
  };
}

function seed(options: { records?: unknown[]; links?: unknown[]; extra?: (core: FakeCore, team: { team_id: string }) => void } = {}) {
  const core = createFakeCore();
  const admin = core.seedAdmin();
  const team = core.seedTeam('Team A');
  options.extra?.(core, team);
  const prepare = (dir: string) => {
    writeExtensionFile(dir, 'pending', { version: 1, records: options.records ?? [] });
    if (options.links) writeExtensionFile(dir, 'links', { version: 1, links: options.links });
  };
  return { core, admin, team, prepare };
}

async function post(app: App['app'], path: string, body: unknown = {}, headers: Record<string, string> = ADMIN_HEADERS): Promise<Reply> {
  const res = await app.request(`/api/v1/ext/vtc${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Reply['body'] };
}

const approve = (app: App['app'], body: Record<string, unknown>) => post(app, '/pending/approve', body);
const callsOf = (core: FakeCore, action: string) => core.calls.filter((c) => c.action === action);
const fileOf = (dataDir: string, name: string) => JSON.parse(readFileSync(join(dataDir, 'vtc', `${name}.json`), 'utf8'));
/** A store file is written on its first change, so a store that never changed has no file. */
const linkRows = (dataDir: string): Array<{ vtcUserId: string }> =>
  existsSync(join(dataDir, 'vtc', 'links.json')) ? fileOf(dataDir, 'links').links : [];

describe('pending users admin routes', () => {
  describe('access', () => {
    it('refuses a normal user, refuses no key, and accepts the admin key and the admin session cookie', async () => {
      const { core, admin, prepare } = seed({ extra: (c) => void c.seedUser({ username: 'plain' }) });
      const { app, deps } = await buildVtcApp({ core, prepare });
      const plain = core.findUser((u) => u.username === 'plain')!;
      const plainKey = core.keysOf(plain.user_id)[0]!.key_value;

      const normal = await post(app, '/pending/list', {}, { ...ADMIN_HEADERS, 'X-Tdai-User-Key': plainKey });
      expect(normal.status).toBe(403);
      expect(normal.body.message).toBe('NOT_TEAM_ADMIN');
      const { 'X-Tdai-User-Key': _drop, ...noKey } = ADMIN_HEADERS;
      const anonymous = await post(app, '/pending/list', {}, noKey);
      expect(anonymous.status).toBe(401);
      expect((await post(app, '/pending/list')).status).toBe(200);

      const session = deps.auth.createSession({
        instanceId: 'default',
        coreUserId: admin.user_id,
        userKey: admin.key_value,
        providerId: 'user_key',
        externalSubject: 'admin',
      });
      const viaCookie = await post(app, '/pending/count', {}, {
        'X-Tdai-Service-Id': 'default',
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${session.token}`,
      });
      expect(viaCookie).toMatchObject({ status: 200, body: { code: 0, data: { pending_count: 0 } } });
    });

    it('refuses every pending route when the caller administers no team', async () => {
      const { core, team, prepare } = seed({ extra: (c) => void c.seedUser({ username: 'plain' }) });
      const plain = core.findUser((u) => u.username === 'plain')!;
      core.addMember(team.team_id, plain.user_id, 'member');
      const { app } = await buildVtcApp({ core, prepare });
      const headers = { ...ADMIN_HEADERS, 'X-Tdai-User-Key': core.keysOf(plain.user_id)[0]!.key_value };
      for (const path of ['list', 'count', 'candidates', 'approve', 'reject', 'reset', 'teams']) {
        const reply = await post(app, `/pending/${path}`, { pending_id: 'pnd_1' }, headers);
        expect(reply.status, path).toBe(403);
        expect(reply.body.message, path).toBe('NOT_TEAM_ADMIN');
      }
    });
  });

  describe('team admin', () => {
    function leadOf(ownName = 'Own') {
      const core = createFakeCore();
      const sys = core.seedAdmin();
      const lead = core.seedUser({ username: 'lead' });
      const own = core.seedTeam(ownName);
      const other = core.seedTeam('Other');
      core.addMember(own.team_id, lead.user_id, 'admin');
      core.addMember(other.team_id, lead.user_id, 'member');
      const headers = { ...ADMIN_HEADERS, 'X-Tdai-User-Key': lead.default_key_value };
      return { core, sys, lead, own, other, headers };
    }

    it('lists, counts, rejects and resets any pending record', async () => {
      const { core, headers } = leadOf();
      const { app } = await buildVtcApp({
        core,
        prepare: (dir) => writeExtensionFile(dir, 'pending', { version: 1, records: [record()] }),
      });
      expect((await post(app, '/pending/count', {}, headers)).body.data).toEqual({ pending_count: 1 });
      expect((await post(app, '/pending/list', {}, headers)).body.data.items).toEqual([
        expect.objectContaining({ pending_id: 'pnd_1', status: 'pending' }),
      ]);
      expect(await post(app, '/pending/reject', { pending_id: 'pnd_1', reason: 'later' }, headers)).toMatchObject({
        status: 200,
        body: { data: { status: 'rejected' } },
      });
      expect(await post(app, '/pending/reset', { pending_id: 'pnd_1' }, headers)).toMatchObject({
        status: 200,
        body: { data: { status: 'pending' } },
      });
    });

    it('approves into a team the caller administers and refuses another team', async () => {
      const { core, own, other, headers } = leadOf();
      const { app } = await buildVtcApp({
        core,
        prepare: (dir) =>
          writeExtensionFile(dir, 'pending', {
            version: 1,
            records: [record(), record({ id: 'pnd_2', vtcUserId: '10483', email: 'second.person@vtc.vn' })],
          }),
      });
      const intoOwn = await post(
        app,
        '/pending/approve',
        { pending_id: 'pnd_1', team_id: own.team_id, role: 'member', mode: 'create' },
        headers,
      );
      expect(intoOwn.status).toBe(200);
      expect(intoOwn.body.data).toMatchObject({ mode: 'created', team_id: own.team_id });
      const intoOther = await post(
        app,
        '/pending/approve',
        { pending_id: 'pnd_2', team_id: other.team_id, role: 'member', mode: 'create' },
        headers,
      );
      expect(intoOther).toMatchObject({ status: 403, body: { message: 'TEAM_NOT_ALLOWED' } });
      expect(core.findUser((u) => u.external_id === '10483')).toBeUndefined();
    });

    it('links a member of an administered team and refuses a user of another team', async () => {
      const { core, own, other, headers } = leadOf();
      const inside = core.seedUser({ username: 'inside', email: 'inside@vtc.vn' });
      const outside = core.seedUser({ username: 'outside', email: 'outside@vtc.vn' });
      core.addMember(own.team_id, inside.user_id, 'member');
      core.addMember(other.team_id, outside.user_id, 'member');
      const { app } = await buildVtcApp({
        core,
        prepare: (dir) =>
          writeExtensionFile(dir, 'pending', {
            version: 1,
            records: [record({ email: 'inside@vtc.vn' }), record({ id: 'pnd_2', vtcUserId: '10483', email: 'outside@vtc.vn' })],
          }),
      });
      const linked = await post(
        app,
        '/pending/approve',
        { pending_id: 'pnd_1', team_id: own.team_id, role: 'member', mode: 'link', link_user_id: inside.user_id },
        headers,
      );
      expect(linked.status).toBe(200);
      expect(linked.body.data).toMatchObject({ mode: 'linked', core_user_id: inside.user_id });
      const refused = await post(
        app,
        '/pending/approve',
        { pending_id: 'pnd_2', team_id: own.team_id, role: 'member', mode: 'link', link_user_id: outside.user_id },
        headers,
      );
      expect(refused).toMatchObject({ status: 409, body: { message: 'USER_NOT_LINKABLE' } });
    });

    it('leaves users of other teams out of the candidate list', async () => {
      const { core, own, other, headers } = leadOf();
      const inside = core.seedUser({ username: 'quang', email: 'quang.le@vtc.vn' });
      const outside = core.seedUser({ username: 'quang-le', email: 'else@vtc.vn' });
      core.addMember(own.team_id, inside.user_id, 'member');
      core.addMember(other.team_id, outside.user_id, 'member');
      const { app } = await buildVtcApp({
        core,
        prepare: (dir) => writeExtensionFile(dir, 'pending', { version: 1, records: [record({ email: 'quang.le@vtc.vn' })] }),
      });
      const reply = await post(app, '/pending/candidates', { pending_id: 'pnd_1' }, headers);
      expect(reply.body.data.candidates.map((c: { username: string }) => c.username)).toEqual(['quang']);
      const asSystem = await post(app, '/pending/candidates', { pending_id: 'pnd_1' });
      expect(asSystem.body.data.candidates.map((c: { username: string }) => c.username).sort()).toEqual(['quang', 'quang-le']);
    });

    it('returns only administered teams, and every membership for a system admin', async () => {
      const { core, sys, own, other, headers } = leadOf();
      const third = core.seedTeam('Third');
      core.addMember(own.team_id, sys.user_id, 'admin');
      core.addMember(other.team_id, sys.user_id, 'member');
      const { app } = await buildVtcApp({ core, prepare: () => undefined });
      const forLead = await post(app, '/pending/teams', {}, headers);
      expect(forLead.body.data.teams).toEqual([{ team_id: own.team_id, name: own.name }]);
      const forSystem = await post(app, '/pending/teams');
      expect(forSystem.body.data.teams.map((t: { team_id: string }) => t.team_id).sort()).toEqual(
        [own.team_id, other.team_id].sort(),
      );
      expect(forSystem.body.data.teams.map((t: { team_id: string }) => t.team_id)).not.toContain(third.team_id);
    });

    it('hides users of other teams in the create conflict, and creates when only they match', async () => {
      const { core, own, other, headers } = leadOf();
      const inside = core.seedUser({ username: 'quang', email: 'quang.le@vtc.vn' });
      const outside = core.seedUser({ username: 'quang-le', email: 'else@vtc.vn' });
      core.addMember(own.team_id, inside.user_id, 'member');
      core.addMember(other.team_id, outside.user_id, 'member');
      const onlyOutside = core.seedUser({ username: 'stranger', email: 'second.person@vtc.vn' });
      core.addMember(other.team_id, onlyOutside.user_id, 'member');
      const { app } = await buildVtcApp({
        core,
        prepare: (dir) =>
          writeExtensionFile(dir, 'pending', {
            version: 1,
            records: [
              record({ email: 'quang.le@vtc.vn' }),
              record({ id: 'pnd_2', vtcUserId: '10483', email: 'second.person@vtc.vn' }),
            ],
          }),
      });
      const conflict = await post(
        app,
        '/pending/approve',
        { pending_id: 'pnd_1', team_id: own.team_id, role: 'member', mode: 'create' },
        headers,
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.message).toBe('CANDIDATES_EXIST');
      expect(conflict.body.data.candidates.map((c: { username: string }) => c.username)).toEqual(['quang']);
      const created = await post(
        app,
        '/pending/approve',
        { pending_id: 'pnd_2', team_id: own.team_id, role: 'member', mode: 'create' },
        headers,
      );
      expect(created.status).toBe(200);
      expect(created.body.data.mode).toBe('created');
    });

    it('refuses to finish an earlier link to a user outside the administered teams', async () => {
      const { core, own, other, headers } = leadOf();
      const outside = core.seedUser({ username: 'outside', email: 'outside@vtc.vn' });
      core.addMember(other.team_id, outside.user_id, 'member');
      const { app } = await buildVtcApp({
        core,
        prepare: (dir) => {
          writeExtensionFile(dir, 'pending', { version: 1, records: [record()] });
          writeExtensionFile(dir, 'links', {
            version: 1,
            links: [{ instanceId: 'default', vtcUserId: '10482', coreUserId: outside.user_id, mode: 'linked', linkedAt: 'x' }],
          });
        },
      });
      const body = { pending_id: 'pnd_1', team_id: own.team_id, role: 'member', mode: 'link', link_user_id: outside.user_id };
      expect(await post(app, '/pending/approve', body, headers)).toMatchObject({
        status: 409,
        body: { message: 'USER_NOT_LINKABLE' },
      });
      expect(await post(app, '/pending/approve', body)).toMatchObject({
        status: 200,
        body: { data: { mode: 'existing', core_user_id: outside.user_id } },
      });
    });

    it('allows an administered team that sits past the first page of the team list', async () => {
      const core = createFakeCore();
      core.seedAdmin();
      const lead = core.seedUser({ username: 'lead' });
      for (let i = 0; i < 100; i += 1) {
        const filler = core.seedTeam(`Filler ${i}`);
        core.addMember(filler.team_id, lead.user_id, 'member');
      }
      const far = core.seedTeam('Far');
      core.addMember(far.team_id, lead.user_id, 'admin');
      const headers = { ...ADMIN_HEADERS, 'X-Tdai-User-Key': lead.default_key_value };
      const { app } = await buildVtcApp({
        core,
        prepare: (dir) => writeExtensionFile(dir, 'pending', { version: 1, records: [record()] }),
      });
      const reply = await post(
        app,
        '/pending/approve',
        { pending_id: 'pnd_1', team_id: far.team_id, role: 'member', mode: 'create' },
        headers,
      );
      expect(reply.status).toBe(200);
      expect(reply.body.data).toMatchObject({ mode: 'created', team_id: far.team_id });
    });

    it('refuses a reviewer and an inactive admin', async () => {
      const core = createFakeCore();
      core.seedAdmin();
      const reviewer = core.seedUser({ username: 'rev' });
      const dormant = core.seedUser({ username: 'old-admin' });
      const team = core.seedTeam('T');
      core.addMember(team.team_id, reviewer.user_id, 'reviewer');
      core.addMember(team.team_id, dormant.user_id, 'admin', 'removed');
      const { app } = await buildVtcApp({ core, prepare: () => undefined });
      for (const user of [reviewer, dormant]) {
        const headers = { ...ADMIN_HEADERS, 'X-Tdai-User-Key': user.default_key_value };
        const reply = await post(app, '/pending/list', {}, headers);
        expect(reply, user.user_id).toMatchObject({ status: 403, body: { message: 'NOT_TEAM_ADMIN' } });
      }
    });
  });

  describe('list and count', () => {
    it('lists pending and rejected people with the count', async () => {
      const { core } = seed({ extra: (c) => void c.seedUser({ username: 'linked-one' }) });
      const linkedId = core.findUser((u) => u.username === 'linked-one')!.user_id;
      const records = [
        record({ id: 'pnd_a', vtcUserId: '1', email: 'a@vtc.vn', lastLoginAt: '2026-11-19T03:00:00.000Z' }),
        record({ id: 'pnd_b', vtcUserId: '2', email: 'b@vtc.vn', source: 'device', status: 'rejected', rejectedAt: '2026-11-19T04:00:00.000Z', rejectedBy: 'usr-x', reason: 'no', lastLoginAt: '2026-11-19T02:00:00.000Z' }),
        record({ id: 'pnd_c', vtcUserId: '3', email: 'c@vtc.vn', kind: 'no_team', coreUserId: linkedId, lastLoginAt: '2026-11-19T05:00:00.000Z' }),
      ];
      const { app } = await buildVtcApp({
        core,
        prepare: (dir) => writeExtensionFile(dir, 'pending', { version: 1, records }),
      });

      const list = await post(app, '/pending/list');
      expect(list.body.code).toBe(0);
      expect(list.body.data.pending_count).toBe(2);
      expect(list.body.data.items.map((i: { pending_id: string }) => i.pending_id)).toEqual(['pnd_c', 'pnd_a', 'pnd_b']);
      const [noTeam, plain, rejected] = list.body.data.items;
      expect(noTeam).toMatchObject({ kind: 'no_team', core_user_id: linkedId, core_username: 'linked-one', source: 'web', status: 'pending' });
      expect(plain).toMatchObject({ email: 'a@vtc.vn', vtc_user_id: '1', login_count: 1, first_login_at: '2026-11-19T01:00:00.000Z' });
      expect(plain).not.toHaveProperty('core_username');
      expect(rejected).toMatchObject({ source: 'device', status: 'rejected', rejected_at: '2026-11-19T04:00:00.000Z', reason: 'no' });
      expect((await post(app, '/pending/count')).body.data).toEqual({ pending_count: 2 });
    });
  });

  describe('candidates', () => {
    it('finds a candidate by email and by username and hides unrelated, inactive and service users', async () => {
      const { core, prepare } = seed({
        records: [record({ email: 'quang.le@vtc.vn' })],
        extra: (c) => {
          c.seedUser({ username: 'quang', email: 'Quang.Le@vtc.vn' });
          c.seedUser({ username: 'quang-le' });
          c.seedUser({ username: 'quang.le' });
          c.seedUser({ username: 'knowledge-service', email: 'quang.le@vtc.vn' });
          c.seedUser({ username: 'someone-else', email: 'else@vtc.vn' });
        },
      });
      core.setStatus(core.seedUser({ username: 'inactive', email: 'quang.le@vtc.vn' }).user_id, 'disabled');
      const { app } = await buildVtcApp({ core, prepare });

      const reply = await post(app, '/pending/candidates', { pending_id: 'pnd_1' });
      expect(reply.body.data.kind).toBe('new');
      const byName = Object.fromEntries(reply.body.data.candidates.map((c: { username: string; match: string[] }) => [c.username, c.match]));
      expect(byName['quang']).toEqual(['email']);
      expect(byName['quang-le']).toEqual(['username']);
      expect(byName['quang.le']).toEqual(['username']);
      expect(byName['knowledge-service']).toBeUndefined();
      expect(byName['someone-else']).toBeUndefined();
      expect(byName['inactive']).toBeUndefined();
      expect(reply.body.data.candidates[0].username).toBe('quang');
      expect(JSON.stringify(reply.body)).not.toContain('password');
      expect(Object.keys(reply.body.data.candidates[0]).sort()).toEqual(
        ['auth_provider', 'display_name', 'email', 'match', 'user_id', 'user_type', 'username'],
      );
    });

    it('marks a candidate that is already linked to another VTC account', async () => {
      const { core, prepare } = seed({
        records: [record({ email: 'quang@vtc.vn' })],
        extra: (c) => void c.seedUser({ username: 'quang' }),
      });
      const target = core.findUser((u) => u.username === 'quang')!;
      const { app } = await buildVtcApp({
        core,
        prepare: (dir) => {
          prepare(dir);
          writeExtensionFile(dir, 'links', {
            version: 1,
            links: [{ instanceId: 'default', vtcUserId: '777', coreUserId: target.user_id, mode: 'linked', linkedAt: 'x' }],
          });
        },
      });
      const reply = await post(app, '/pending/candidates', { pending_id: 'pnd_1' });
      expect(reply.body.data.candidates).toEqual([expect.objectContaining({ username: 'quang', linked_vtc_user_id: '777' })]);
    });

    it('returns no candidates for a person who already has an account', async () => {
      const { core, prepare } = seed({
        records: [record({ kind: 'no_team', coreUserId: 'usr-1', email: 'quang@vtc.vn' })],
        extra: (c) => void c.seedUser({ username: 'quang', email: 'quang@vtc.vn' }),
      });
      const { app } = await buildVtcApp({ core, prepare });
      expect((await post(app, '/pending/candidates', { pending_id: 'pnd_1' })).body.data).toEqual({ kind: 'no_team', candidates: [] });
      expect((await post(app, '/pending/candidates', { pending_id: 'pnd_none' })).status).toBe(404);
    });
  });

  describe('approve', () => {
    it('refuses to create a user when candidates exist unless confirmed', async () => {
      const { core, team, prepare } = seed({
        records: [record({ email: 'quang.le@vtc.vn' })],
        extra: (c) => void c.seedUser({ username: 'quang', email: 'quang.le@vtc.vn' }),
      });
      const { app } = await buildVtcApp({ core, prepare });
      const body = { pending_id: 'pnd_1', team_id: team.team_id, role: 'member', mode: 'create' };

      const refused = await approve(app, body);
      expect(refused.status).toBe(409);
      expect(refused.body.message).toBe('CANDIDATES_EXIST');
      expect(refused.body.data.candidates).toEqual([expect.objectContaining({ username: 'quang', match: ['email'] })]);
      expect(callsOf(core, 'user/create')).toHaveLength(0);

      const confirmed = await approve(app, { ...body, confirm_create: true });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.data).toMatchObject({ mode: 'created', username: 'quang-le' });
      expect(callsOf(core, 'user/create')).toHaveLength(1);
    });

    it('creates a user, adds the membership and the default agent', async () => {
      const { core, team, prepare } = seed({ records: [record()] });
      const { app, dataDir } = await buildVtcApp({ core, prepare });
      const reply = await approve(app, { pending_id: 'pnd_1', team_id: team.team_id, role: 'reviewer', mode: 'create' });
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ code: 0, data: { mode: 'created', username: 'new-person', team_id: team.team_id, role: 'reviewer', role_kept: false, warnings: [] } });

      const user = core.findUser((u) => u.external_id === '10482')!;
      expect(user).toMatchObject({ auth_provider: 'vtc-sso', email: 'new.person@vtc.vn', username: 'new-person', display_name: 'new.person' });
      expect(reply.body.data.core_user_id).toBe(user.user_id);
      expect(core.memberOf(team.team_id, user.user_id)).toEqual({ role: 'reviewer', status: 'active' });
      expect(core.agentsOf(team.team_id, user.user_id)).toEqual(['default-agent-new-person']);
      expect(fileOf(dataDir, 'links').links).toEqual([
        expect.objectContaining({ vtcUserId: '10482', coreUserId: user.user_id, mode: 'created' }),
      ]);
      expect(fileOf(dataDir, 'pending').records).toEqual([]);
      expect(JSON.stringify(reply.body)).not.toContain('sk-mem');
    });

    it('links an existing user without bind-external', async () => {
      const { core, team, prepare } = seed({
        records: [record({ email: 'quang.le@vtc.vn' })],
        extra: (c) => void c.seedUser({ username: 'quang', email: 'quang.le@vtc.vn', auth_provider: 'woa', external_id: 'staff-9' }),
      });
      const existing = core.findUser((u) => u.username === 'quang')!;
      const { app, dataDir } = await buildVtcApp({ core, prepare });
      const reply = await approve(app, { pending_id: 'pnd_1', team_id: team.team_id, role: 'member', mode: 'link', link_user_id: existing.user_id });
      expect(reply.body.data).toMatchObject({ mode: 'linked', core_user_id: existing.user_id, username: 'quang', warnings: [] });
      expect(core.calls.some((c) => c.action === 'user/bind-external')).toBe(false);
      expect(callsOf(core, 'user/create')).toHaveLength(0);
      expect(core.userById(existing.user_id)).toMatchObject({ auth_provider: 'woa', external_id: 'staff-9' });
      expect(fileOf(dataDir, 'links').links).toEqual([expect.objectContaining({ mode: 'linked', coreUserId: existing.user_id })]);
      expect(core.agentsOf(team.team_id, existing.user_id)).toEqual(['default-agent-quang']);
    });

    it('keeps an existing membership role', async () => {
      const { core, team, prepare } = seed({ records: [record()], extra: (c) => void c.seedUser({ username: 'quang' }) });
      const existing = core.findUser((u) => u.username === 'quang')!;
      core.addMember(team.team_id, existing.user_id, 'admin');
      const { app } = await buildVtcApp({ core, prepare });
      const reply = await approve(app, { pending_id: 'pnd_1', team_id: team.team_id, role: 'member', mode: 'link', link_user_id: existing.user_id });
      expect(reply.body.data).toMatchObject({ role_kept: true, role: 'admin' });
      expect(callsOf(core, 'team-member/add')).toHaveLength(0);
      expect(core.memberOf(team.team_id, existing.user_id)?.role).toBe('admin');
    });

    it('approves a person with no team', async () => {
      const { core, team } = seed({ extra: (c) => void c.seedUser({ username: 'quang' }) });
      const existing = core.findUser((u) => u.username === 'quang')!;
      const { app } = await buildVtcApp({
        core,
        prepare: (dir) =>
          writeExtensionFile(dir, 'pending', { version: 1, records: [record({ kind: 'no_team', coreUserId: existing.user_id })] }),
      });
      const before = core.userCount();
      const reply = await approve(app, { pending_id: 'pnd_1', team_id: team.team_id, role: 'member' });
      expect(reply.body.data).toMatchObject({ core_user_id: existing.user_id, username: 'quang', mode: 'existing', role: 'member', warnings: [] });
      expect(core.memberOf(team.team_id, existing.user_id)).toEqual({ role: 'member', status: 'active' });
      expect(core.userCount()).toBe(before);
      expect(callsOf(core, 'user/create')).toHaveLength(0);
    });

    it('is idempotent on retry', async () => {
      const { core, team, prepare } = seed({ records: [record()] });
      const { app, dataDir } = await buildVtcApp({ core, prepare });
      core.failNext('team-member/add');
      const body = { pending_id: 'pnd_1', team_id: team.team_id, role: 'member', mode: 'create' };

      const failed = await approve(app, body);
      expect(failed).toMatchObject({ status: 502, body: { message: 'CORE_ERROR', data: { code: 'unexpected' } } });
      expect(fileOf(dataDir, 'pending').records).toEqual([expect.objectContaining({ id: 'pnd_1', status: 'pending' })]);
      expect(linkRows(dataDir)).toEqual([]);

      const retried = await approve(app, body);
      expect(retried.status).toBe(200);
      expect(retried.body.data.mode).toBe('recovered');
      expect(callsOf(core, 'user/create')).toHaveLength(1);
      expect(core.agentsOf(team.team_id, retried.body.data.core_user_id)).toEqual(['default-agent-new-person']);
      expect(fileOf(dataDir, 'pending').records).toEqual([]);
    });

    it('provisions the agent on a retry after the membership was already added', async () => {
      const { core, team } = seed({ extra: (c) => void c.seedUser({ username: 'quang' }) });
      const user = core.findUser((u) => u.username === 'quang')!;
      const { app } = await buildVtcApp({
        core,
        prepare: (dir) =>
          writeExtensionFile(dir, 'pending', {
            version: 1,
            records: [
              record({ id: 'pnd_1', vtcUserId: '1', kind: 'no_team', coreUserId: user.user_id }),
              record({ id: 'pnd_2', vtcUserId: '2', kind: 'no_team', coreUserId: user.user_id }),
            ],
          }),
      });
      core.failNext('agent/create');
      const first = await approve(app, { pending_id: 'pnd_1', team_id: team.team_id, role: 'member' });
      expect(first).toMatchObject({ status: 200, body: { data: { role_kept: false, warnings: ['default_agent_missing'] } } });
      expect(core.agentsOf(team.team_id, user.user_id)).toEqual([]);

      const second = await approve(app, { pending_id: 'pnd_2', team_id: team.team_id, role: 'member' });
      expect(second.body.data).toMatchObject({ role_kept: true, warnings: [] });
      expect(core.agentsOf(team.team_id, user.user_id)).toEqual(['default-agent-quang']);
    });

    it('retries a create whose link write failed', async () => {
      const { core, team, prepare } = seed({
        records: [record({ email: 'quang.le@vtc.vn' })],
        extra: (c) => void c.seedUser({ username: 'quang-le', email: 'quang.le@vtc.vn', auth_provider: 'vtc-sso', external_id: '10482' }),
      });
      const own = core.findUser((u) => u.external_id === '10482')!;
      const { app, dataDir } = await buildVtcApp({ core, prepare });
      const reply = await approve(app, { pending_id: 'pnd_1', team_id: team.team_id, role: 'member', mode: 'create' });
      expect(reply.status).toBe(200);
      expect(reply.body.data).toMatchObject({ mode: 'recovered', core_user_id: own.user_id, username: 'quang-le' });
      expect(callsOf(core, 'user/create')).toHaveLength(0);
      expect(fileOf(dataDir, 'links').links).toEqual([expect.objectContaining({ mode: 'recovered', coreUserId: own.user_id })]);
    });

    it('refuses a user linked to another VTC account, and a VTC person Core already binds to someone else', async () => {
      const { core, team, prepare } = seed({
        records: [record()],
        extra: (c) => {
          c.seedUser({ username: 'taken' });
          c.seedUser({ username: 'free' });
          c.seedUser({ username: 'bound', auth_provider: 'vtc-sso', external_id: '10482' });
        },
      });
      const taken = core.findUser((u) => u.username === 'taken')!;
      const free = core.findUser((u) => u.username === 'free')!;
      const { app } = await buildVtcApp({
        core,
        prepare: (dir) => {
          prepare(dir);
          writeExtensionFile(dir, 'links', {
            version: 1,
            links: [{ instanceId: 'default', vtcUserId: '777', coreUserId: taken.user_id, mode: 'linked', linkedAt: 'x' }],
          });
        },
      });
      const base = { pending_id: 'pnd_1', team_id: team.team_id, role: 'member', mode: 'link' };
      const linked = await approve(app, { ...base, link_user_id: taken.user_id });
      expect(linked).toMatchObject({ status: 409, body: { message: 'USER_ALREADY_LINKED' } });
      const other = await approve(app, { ...base, link_user_id: free.user_id });
      expect(other).toMatchObject({ status: 409, body: { message: 'VTC_ACCOUNT_EXISTS' } });
      expect(core.writes()).toEqual([]);
    });

    it('asks for the mode and the user to link, and for a user that exists', async () => {
      const { core, team, prepare } = seed({ records: [record()] });
      const { app } = await buildVtcApp({ core, prepare });
      const base = { pending_id: 'pnd_1', team_id: team.team_id, role: 'member' };
      expect(await approve(app, base)).toMatchObject({ status: 400, body: { message: 'MODE_REQUIRED' } });
      expect(await approve(app, { ...base, mode: 'link' })).toMatchObject({ status: 400, body: { message: 'LINK_USER_REQUIRED' } });
      expect(await approve(app, { ...base, mode: 'link', link_user_id: 'usr-none' })).toMatchObject({
        status: 404,
        body: { message: 'USER_NOT_FOUND' },
      });
      expect(core.writes()).toEqual([]);
    });

    it('picks a free username', async () => {
      const { core, team, prepare } = seed({
        records: [record({ email: 'quang.le@vtc.vn' })],
        extra: (c) => void c.seedUser({ username: 'quang-le' }),
      });
      const { app } = await buildVtcApp({ core, prepare });
      const reply = await approve(app, { pending_id: 'pnd_1', team_id: team.team_id, role: 'member', mode: 'create', confirm_create: true });
      expect(reply.body.data).toMatchObject({ mode: 'created', username: 'quang-le-2' });
    });

    it('warns when the default agent is missing but still approves', async () => {
      for (const action of ['agent/create', 'user/get']) {
        const { core, team, prepare } = seed({ records: [record()] });
        const { app, dataDir } = await buildVtcApp({ core, prepare });
        core.failNext(action);
        const reply = await approve(app, { pending_id: 'pnd_1', team_id: team.team_id, role: 'member', mode: 'create' });
        expect(reply.status, action).toBe(200);
        expect(reply.body.data.warnings, action).toEqual(['default_agent_missing']);
        expect(core.memberOf(team.team_id, reply.body.data.core_user_id)).toBeDefined();
        expect(fileOf(dataDir, 'pending').records).toEqual([]);
        cleanupVtcApps();
      }
    });

    it('refuses an unknown team and an invalid role', async () => {
      const { core, team, prepare } = seed({ records: [record()] });
      const { app } = await buildVtcApp({ core, prepare });
      expect(await approve(app, { pending_id: 'pnd_1', team_id: 'team-none', role: 'member', mode: 'create' })).toMatchObject({
        status: 404,
        body: { message: 'TEAM_NOT_FOUND' },
      });
      expect(await approve(app, { pending_id: 'pnd_1', team_id: team.team_id, role: 'owner', mode: 'create' })).toMatchObject({
        status: 400,
        body: { message: 'INVALID_PARAM' },
      });
      expect(core.writes()).toEqual([]);
    });

    it('refuses a record that is not pending and one that does not exist', async () => {
      const { core, team, prepare } = seed({ records: [record({ status: 'rejected' })] });
      const { app } = await buildVtcApp({ core, prepare });
      const body = { team_id: team.team_id, role: 'member', mode: 'create' };
      expect(await approve(app, { ...body, pending_id: 'pnd_1' })).toMatchObject({ status: 409, body: { message: 'PENDING_NOT_PENDING' } });
      expect(await approve(app, { ...body, pending_id: 'pnd_none' })).toMatchObject({ status: 404, body: { message: 'PENDING_NOT_FOUND' } });
    });

    it('makes one account when the same person is approved twice at once', async () => {
      const { core, team, prepare } = seed({ records: [record()] });
      const { app } = await buildVtcApp({ core, prepare });
      const body = { pending_id: 'pnd_1', team_id: team.team_id, role: 'member', mode: 'create' };
      const replies = await Promise.all([approve(app, body), approve(app, body)]);
      expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(callsOf(core, 'user/create')).toHaveLength(1);
    });
  });

  describe('reject and reset', () => {
    async function firstLogin(app: App['app'], offset = 0) {
      return continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow(offset), userId: '20001', email: 'new.person@vtc.vn' }));
    }

    it('rejects with a reason and the next login shows the refused page', async () => {
      const { core, prepare } = seed();
      const { app } = await buildVtcApp({ core, prepare });
      expect((await firstLogin(app)).status).toBe(200);
      const id = (await post(app, '/pending/list')).body.data.items[0].pending_id;

      const rejected = await post(app, '/pending/reject', { pending_id: id, reason: '  not staff  ' });
      expect(rejected).toMatchObject({ status: 200, body: { data: { pending_id: id, status: 'rejected' } } });
      const item = (await post(app, '/pending/list')).body.data.items[0];
      expect(item).toMatchObject({ status: 'rejected', reason: 'not staff' });
      expect((await post(app, '/pending/count')).body.data.pending_count).toBe(0);
      expect((await firstLogin(app, -3)).status).toBe(403);

      expect(await post(app, '/pending/reject', { pending_id: id })).toMatchObject({ status: 409, body: { message: 'PENDING_NOT_PENDING' } });
      expect((await post(app, '/pending/reject', { pending_id: id, reason: 'x'.repeat(501) })).status).toBe(400);
    });

    it('resets a rejected person back to pending and keeps the record', async () => {
      const { core, prepare } = seed();
      const { app } = await buildVtcApp({ core, prepare });
      await firstLogin(app);
      const id = (await post(app, '/pending/list')).body.data.items[0].pending_id;
      expect(await post(app, '/pending/reset', { pending_id: id })).toMatchObject({ status: 409, body: { message: 'PENDING_NOT_REJECTED' } });
      await post(app, '/pending/reject', { pending_id: id, reason: 'not now' });

      expect(await post(app, '/pending/reset', { pending_id: id })).toMatchObject({ status: 200, body: { data: { pending_id: id, status: 'pending' } } });
      const items = (await post(app, '/pending/list')).body.data.items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ pending_id: id, status: 'pending', login_count: 1 });
      expect(items[0]).not.toHaveProperty('rejected_at');
      expect(items[0]).not.toHaveProperty('reason');
      expect((await post(app, '/pending/count')).body.data.pending_count).toBe(1);
      expect((await firstLogin(app, -3)).status).toBe(200);
      const after = (await post(app, '/pending/list')).body.data.items;
      expect(after).toEqual([expect.objectContaining({ pending_id: id, status: 'pending', login_count: 2 })]);
    });
  });

  describe('failed approval', () => {
    const login = async (app: App['app'], offset: number) =>
      continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow(offset), userId: '20001', email: 'new.person@vtc.vn' }));
    const gotSession = (res: Response) => res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`));

    it('gives no session after a failed link approval, a rejection and a reset', async () => {
      const { core, team, prepare } = seed({ extra: (c) => void c.seedUser({ username: 'quang' }) });
      const quang = core.findUser((u) => u.username === 'quang')!;
      core.addMember(team.team_id, quang.user_id, 'member');
      const { app, dataDir } = await buildVtcApp({ core, prepare });
      expect(gotSession(await login(app, 0))).toBe(false);
      const id = (await post(app, '/pending/list')).body.data.items[0].pending_id;

      core.failNext('team-member/get');
      const failed = await approve(app, { pending_id: id, team_id: team.team_id, role: 'member', mode: 'link', link_user_id: quang.user_id });
      expect(failed).toMatchObject({ status: 502, body: { message: 'CORE_ERROR' } });
      expect(linkRows(dataDir)).toEqual([]);
      const stillPending = await login(app, -3);
      expect(stillPending.status).toBe(200);
      expect(gotSession(stillPending)).toBe(false);

      expect((await post(app, '/pending/reject', { pending_id: id })).status).toBe(200);
      expect((await post(app, '/pending/reset', { pending_id: id })).status).toBe(200);
      const afterReset = await login(app, -6);
      expect(gotSession(afterReset)).toBe(false);
      expect((await post(app, '/pending/list')).body.data.items).toEqual([expect.objectContaining({ kind: 'new', status: 'pending' })]);
    });

    it('keeps a person pending after a create approval failed, then a rejection and a reset', async () => {
      const { core, team, prepare } = seed();
      const { app } = await buildVtcApp({ core, prepare });
      expect(gotSession(await login(app, 0))).toBe(false);
      const id = (await post(app, '/pending/list')).body.data.items[0].pending_id;

      // The Core user and the membership exist when the agent lookup fails, so Core already binds this person.
      core.failNext('agent/list');
      const failed = await approve(app, { pending_id: id, team_id: team.team_id, role: 'member', mode: 'create' });
      expect(failed).toMatchObject({ status: 502, body: { message: 'CORE_ERROR' } });
      expect(core.findUser((u) => u.external_id === '20001')).toBeDefined();

      expect((await post(app, '/pending/reject', { pending_id: id })).status).toBe(200);
      expect((await post(app, '/pending/reset', { pending_id: id })).status).toBe(200);
      const next = await login(app, -3);
      expect(next.status).toBe(200);
      expect(gotSession(next)).toBe(false);
      expect((await post(app, '/pending/list')).body.data.items).toEqual([
        expect.objectContaining({ pending_id: id, kind: 'new', status: 'pending' }),
      ]);

      // A new approval then recovers the same Core user instead of making another one.
      const ok = await approve(app, { pending_id: id, team_id: team.team_id, role: 'member', mode: 'create' });
      expect(ok).toMatchObject({ status: 200, body: { data: { mode: 'recovered' } } });
      expect(gotSession(await login(app, -6))).toBe(true);
    });

    it('does not let a link left behind by a failed final step open the door while the request is open', async () => {
      const { core, team, prepare } = seed({ extra: (c) => void c.seedUser({ username: 'quang' }) });
      const quang = core.findUser((u) => u.username === 'quang')!;
      core.addMember(team.team_id, quang.user_id, 'member');
      const { app } = await buildVtcApp({
        core,
        prepare: (dir) => {
          writeExtensionFile(dir, 'pending', { version: 1, records: [record({ vtcUserId: '20001', email: 'new.person@vtc.vn' })] });
          writeExtensionFile(dir, 'links', {
            version: 1,
            links: [{ instanceId: 'default', vtcUserId: '20001', coreUserId: quang.user_id, mode: 'linked', linkedAt: 'x' }],
          });
        },
      });
      expect(gotSession(await login(app, 0))).toBe(false);
    });

    it('removes the link of a first request when it is rejected or reset, and keeps the link of a person with an account', async () => {
      const { core, team, prepare } = seed({ extra: (c) => void c.seedUser({ username: 'quang' }) });
      const quang = core.findUser((u) => u.username === 'quang')!;
      void team;
      const links = [
        { instanceId: 'default', vtcUserId: '1', coreUserId: quang.user_id, mode: 'linked', linkedAt: 'x' },
        { instanceId: 'default', vtcUserId: '2', coreUserId: quang.user_id, mode: 'linked', linkedAt: 'x' },
      ];
      const { app, dataDir } = await buildVtcApp({
        core,
        prepare: (dir) => {
          writeExtensionFile(dir, 'pending', {
            version: 1,
            records: [
              record({ id: 'pnd_new', vtcUserId: '1' }),
              record({ id: 'pnd_old', vtcUserId: '2', kind: 'no_team', coreUserId: quang.user_id }),
              record({ id: 'pnd_rej', vtcUserId: '3', status: 'rejected' }),
            ],
          });
          writeExtensionFile(dir, 'links', { version: 1, links: [...links, { ...links[0], vtcUserId: '3' }] });
        },
      });
      expect((await post(app, '/pending/reject', { pending_id: 'pnd_new' })).status).toBe(200);
      expect((await post(app, '/pending/reject', { pending_id: 'pnd_old' })).status).toBe(200);
      expect((await post(app, '/pending/reset', { pending_id: 'pnd_rej' })).status).toBe(200);
      expect(fileOf(dataDir, 'links').links.map((l: { vtcUserId: string }) => l.vtcUserId)).toEqual(['2']);
    });

    it('keeps the choice of an earlier link and refuses a different new choice', async () => {
      const { core, team, prepare } = seed({
        records: [record()],
        extra: (c) => {
          c.seedUser({ username: 'first' });
          c.seedUser({ username: 'second' });
        },
      });
      const first = core.findUser((u) => u.username === 'first')!;
      const second = core.findUser((u) => u.username === 'second')!;
      const { app } = await buildVtcApp({
        core,
        prepare: (dir) => {
          prepare(dir);
          writeExtensionFile(dir, 'links', {
            version: 1,
            links: [{ instanceId: 'default', vtcUserId: '10482', coreUserId: first.user_id, mode: 'linked', linkedAt: 'x' }],
          });
        },
      });
      const base = { pending_id: 'pnd_1', team_id: team.team_id, role: 'member' };
      expect(await approve(app, { ...base, mode: 'link', link_user_id: second.user_id })).toMatchObject({ status: 409, body: { message: 'LINK_CONFLICT' } });
      expect(await approve(app, { ...base, mode: 'create' })).toMatchObject({ status: 409, body: { message: 'LINK_CONFLICT' } });
      expect(core.writes()).toEqual([]);
      const same = await approve(app, { ...base, mode: 'link', link_user_id: first.user_id });
      expect(same).toMatchObject({ status: 200, body: { data: { mode: 'existing', core_user_id: first.user_id } } });
    });

    it('refuses to link a disabled, service, administrator or foreign VTC account', async () => {
      const { core, team, prepare } = seed({
        records: [record()],
        extra: (c) => {
          c.seedUser({ username: 'off' });
          c.seedUser({ username: 'knowledge-service' });
          c.seedUser({ username: 'other-vtc', auth_provider: 'vtc-sso', external_id: '999' });
        },
      });
      core.setStatus(core.findUser((u) => u.username === 'off')!.user_id, 'disabled');
      const { app } = await buildVtcApp({ core, prepare });
      const targets = ['off', 'knowledge-service', 'admin', 'other-vtc'].map((name) => core.findUser((u) => u.username === name)!.user_id);
      for (const link_user_id of targets) {
        const reply = await approve(app, { pending_id: 'pnd_1', team_id: team.team_id, role: 'member', mode: 'link', link_user_id });
        expect(reply, link_user_id).toMatchObject({ status: 409, body: { message: 'USER_NOT_LINKABLE' } });
      }
      expect(core.writes()).toEqual([]);
    });

    it('lists the user type of a candidate so the UI can warn about the administrator account', async () => {
      const { core, prepare } = seed({ records: [record({ email: 'admin@vtc.vn' })] });
      const { app } = await buildVtcApp({ core, prepare });
      const reply = await post(app, '/pending/candidates', { pending_id: 'pnd_1' });
      expect(reply.body.data.candidates).toEqual([expect.objectContaining({ username: 'admin', user_type: 'system_admin' })]);
    });

    it('stops when the record was decided while the team was being looked up', async () => {
      const { core, team, prepare } = seed({ records: [record()] });
      const { app, deps } = await buildVtcApp({ core, prepare });
      const real = deps.metaKernel.invoke.bind(deps.metaKernel);
      let rejected = false;
      deps.metaKernel.invoke = (async (action: string, body: unknown, ctx: unknown) => {
        if (action === 'team/get' && !rejected) {
          rejected = true;
          await post(app, '/pending/reject', { pending_id: 'pnd_1' });
        }
        return real(action as never, body as never, ctx as never);
      }) as typeof deps.metaKernel.invoke;
      const reply = await approve(app, { pending_id: 'pnd_1', team_id: team.team_id, role: 'member', mode: 'create' });
      expect(reply).toMatchObject({ status: 409, body: { message: 'PENDING_NOT_PENDING' } });
      expect(core.writes()).toEqual([]);
    });

    it('fails a recovered approval instead of answering with an empty username', async () => {
      const { core, team, prepare } = seed({
        records: [record()],
        extra: (c) => void c.seedUser({ username: 'quang-le', auth_provider: 'vtc-sso', external_id: '10482' }),
      });
      const { app, dataDir } = await buildVtcApp({ core, prepare });
      const body = { pending_id: 'pnd_1', team_id: team.team_id, role: 'member', mode: 'create' };
      core.failNext('user/get');
      expect((await approve(app, body)).status).toBe(502);
      expect(linkRows(dataDir)).toEqual([]);
      const retried = await approve(app, body);
      expect(retried.body.data).toMatchObject({ mode: 'recovered', username: 'quang-le' });
    });
  });

  describe('after approval', () => {
    it('logs the approved person in on the next web login', async () => {
      const { core, team, prepare } = seed();
      const { app } = await buildVtcApp({ core, prepare });
      const waiting = await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow(), userId: '20001', email: 'new.person@vtc.vn' }));
      expect(waiting.status).toBe(200);
      const id = (await post(app, '/pending/list')).body.data.items[0].pending_id;
      const approved = await approve(app, { pending_id: id, team_id: team.team_id, role: 'member', mode: 'create' });
      expect(approved.status).toBe(200);

      const next = await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow(-3), userId: '20001', email: 'new.person@vtc.vn' }));
      expect(next.status).toBe(302);
      const cookie = next.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0]!;
      const session = await app.request('/api/v1/auth/session', { headers: { cookie } });
      expect(await session.json()).toMatchObject({
        authenticated: true,
        user_id: approved.body.data.core_user_id,
        external_subject: '20001',
      });
    });
  });
});
