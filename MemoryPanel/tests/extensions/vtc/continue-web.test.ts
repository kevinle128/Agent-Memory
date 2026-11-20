import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage, type ErrorCode } from '../../../src/extensions/vtc/http/pages.js';
import { STATE_COOKIE } from '../../../src/extensions/vtc/http/sso-routes.js';
import { createFakeCore } from './fake-core.js';
import {
  PRIVATE_KEY,
  buildVtcApp,
  cleanupVtcApps,
  continueRequest,
  makeUd,
  ssoNow,
  startWebLogin,
  writeExtensionFile,
} from './vtc-fixtures.js';

// The fake Core reads the key cap from the environment; the tests assume Core's default.
beforeEach(() => {
  vi.stubEnv('TDAI_USER_KEY_MAX_ACTIVE', '20');
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupVtcApps();
});

const EMAIL = 'a.b@vtc.vn';
const SESSION_COOKIE = 'tdai_idp_session';

function errorPage(error: ErrorCode): string {
  return renderPage({ lang: 'en', kind: 'error', error });
}

/** A Core with an admin, one team and, when asked, the VTC person already approved in it. */
function seedCore(approved = true) {
  const core = createFakeCore();
  core.seedAdmin();
  const team = core.seedTeam('Team A');
  const user = core.seedUser({ username: 'one', email: EMAIL, auth_provider: 'vtc-sso', external_id: '10482' });
  if (approved) core.addMember(team.team_id, user.user_id);
  return { core, team, user };
}

function sessionCookieOf(res: Response): string {
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  expect(line).toBeDefined();
  return line!.split(';')[0]!;
}

function pendingFile(dataDir: string): { records: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dataDir, 'vtc', 'pending.json'), 'utf8'));
}

describe('VTC continue route, web flow', () => {
  it('logs an approved person into the Panel', async () => {
    const { core, user } = seedCore();
    const { app } = await buildVtcApp({ core });
    const login = await startWebLogin(app, '/teams?tab=1');
    const res = await continueRequest(app, login, makeUd({ time: ssoNow() }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/teams?tab=1');

    const cookie = sessionCookieOf(res);
    const session = await app.request('/api/v1/auth/session', { headers: { cookie } });
    expect(await session.json()).toMatchObject({
      authenticated: true,
      method: 'idp',
      provider_id: 'vtc',
      user_id: user.user_id,
      external_subject: '10482',
    });
  });

  it('sends the browser back only to a path on this Panel', async () => {
    for (const returnTo of ['//evil.example', '/%09/evil.example', '/\t/evil.example', '/\\evil.example', '/.//evil.example', 'https://evil.example']) {
      const { core } = seedCore();
      const { app } = await buildVtcApp({ core });
      const res = await continueRequest(app, await startWebLogin(app, returnTo), makeUd({ time: ssoNow() }));
      expect(res.status, returnTo).toBe(302);
      expect(res.headers.get('location'), returnTo).toBe('/');
      cleanupVtcApps();
    }
  });

  it('uses the web key for meta requests', async () => {
    const { core, user } = seedCore();
    const { app } = await buildVtcApp({ core });
    const res = await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow() }));
    const cookie = sessionCookieOf(res);

    core.calls.length = 0;
    const meta = await app.request('/api/v1/meta/team/list', {
      method: 'POST',
      headers: { cookie, 'x-tdai-service-id': 'default', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(meta.status).toBe(200);
    const webKey = core.keysOf(user.user_id).find((k) => k.name === 'panel-web')!;
    const call = core.calls.find((c) => c.action === 'team/list')!;
    expect(call.userKey).toBe(webKey.key_value);
    expect(call.userKey).not.toBe(core.keysOf(user.user_id).find((k) => k.isDefault)!.key_value);
  });

  it('refuses a missing or different state cookie', async () => {
    const { core } = seedCore();
    const { app } = await buildVtcApp({ core });
    const ud = makeUd({ time: ssoNow() });

    const login = await startWebLogin(app);
    const missing = await continueRequest(app, { returnUrl: login.returnUrl }, ud);
    expect(missing.status).toBe(400);
    expect(await missing.text()).toBe(errorPage('state_mismatch'));

    const other = await startWebLogin(app);
    const different = await continueRequest(app, { returnUrl: login.returnUrl, cookie: other.cookie }, ud);
    expect(different.status).toBe(400);
    expect(await different.text()).toBe(errorPage('state_mismatch'));
    expect(different.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);

    // The refusals came before the replay guard, so the same ticket still works with a fresh nonce.
    const fresh = await continueRequest(app, await startWebLogin(app), ud);
    expect(fresh.status).toBe(302);
  });

  it('refuses a reused nonce', async () => {
    const { core } = seedCore();
    const { app } = await buildVtcApp({ core });
    const login = await startWebLogin(app);
    expect((await continueRequest(app, login, makeUd({ time: ssoNow() }))).status).toBe(302);
    const again = await continueRequest(app, login, makeUd({ time: ssoNow(), userId: '10483' }));
    expect(again.status).toBe(400);
    expect(await again.text()).toBe(errorPage('expired'));
  });

  it('shows the waiting page to a new person and writes nothing to Core', async () => {
    const core = createFakeCore();
    core.seedAdmin();
    const { app, dataDir } = await buildVtcApp({ core });
    const email = '"><img/src=x/onerror=alert(1)>@vtc.vn';
    const res = await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow(), userId: '20001', email }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Pending');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img/src=x/onerror=alert(1)&gt;@vtc.vn');
    // The person holds no Panel session yet, so the link goes straight to the SSO logout.
    expect(html).toContain('href="https://sso.test.invalid/sso/Logout/?url=https%3A%2F%2Fpanel.test.invalid%2F"');
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);

    const { records } = pendingFile(dataDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ vtcUserId: '20001', source: 'web', kind: 'new', status: 'pending', loginCount: 1 });
    expect(core.writes()).toEqual([]);
    expect(core.userCount()).toBe(1);
  });

  it('keeps a person who has an account but no team waiting', async () => {
    const { core } = seedCore(false);
    const { app, dataDir } = await buildVtcApp({ core });
    const res = await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow() }));
    expect(res.status).toBe(200);
    expect(pendingFile(dataDir).records[0]).toMatchObject({ kind: 'no_team', vtcUserId: '10482' });
    expect(core.writes()).toEqual([]);
  });

  it('shows the refused page to a rejected person', async () => {
    const { core } = seedCore();
    const { app } = await buildVtcApp({
      core,
      prepare: (dir) =>
        writeExtensionFile(dir, 'pending', {
          version: 1,
          records: [
            {
              id: 'pnd_TEST',
              instanceId: 'default',
              vtcUserId: '10482',
              email: EMAIL,
              kind: 'new',
              status: 'rejected',
              source: 'web',
              firstLoginAt: '2026-11-19T00:00:00.000Z',
              lastLoginAt: '2026-11-19T00:00:00.000Z',
              loginCount: 1,
            },
          ],
        }),
    });
    const res = await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow() }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('href="https://sso.test.invalid/sso/Logout/?url=https%3A%2F%2Fpanel.test.invalid%2F"');
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    expect(core.writes()).toEqual([]);
  });

  it('refuses to open a session when the key belongs to another user', async () => {
    const { core } = seedCore();
    const { app, deps } = await buildVtcApp({ core });
    const real = deps.kernelHttp.postEnvelope.bind(deps.kernelHttp);
    deps.kernelHttp.postEnvelope = (async (path: string, ...rest: unknown[]) => {
      if (path === '/v3/meta/auth/verify') {
        return { code: 0, message: 'ok', request_id: 'req', data: { valid: true, user: { user_id: 'usr-other' } } };
      }
      return (real as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof deps.kernelHttp.postEnvelope;
    const res = await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow() }));
    expect(res.status).toBe(503);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
  });

  it('shows a clear page when Core is down', async () => {
    const { core } = seedCore();
    const { app } = await buildVtcApp({ core });
    core.failNext('user/find-by-external');
    const res = await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow() }));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(errorPage('unavailable'));
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
  });

  it('shows a clear page when the web key cannot be issued', async () => {
    const { core, user } = seedCore();
    const { app } = await buildVtcApp({ core });
    core.failNext('user-key/create');
    const down = await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow() }));
    expect(down.status).toBe(503);
    expect(await down.text()).toBe(errorPage('unavailable'));
    expect(down.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);

    // Core's cap is 20 active keys: the default key plus 19. The second login has its own login time, because the
    // same user and time count as one login.
    core.addKeys(user.user_id, 19);
    const full = await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow(-5), requestIp: '10.0.0.2' }));
    expect(full.status).toBe(409);
    expect(await full.text()).toBe(errorPage('key_limit'));
    expect(full.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
  });

  it('refuses stale, replayed and foreign tickets', async () => {
    const { core } = seedCore();
    const { app } = await buildVtcApp({ core });

    const stale = await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow(-3600) }));
    expect(stale.status).toBe(400);
    expect(await stale.text()).toBe(errorPage('expired'));

    const ud = makeUd({ time: ssoNow() });
    expect((await continueRequest(app, await startWebLogin(app), ud)).status).toBe(302);
    const replayed = await continueRequest(app, await startWebLogin(app), ud);
    expect(replayed.status).toBe(400);
    expect(await replayed.text()).toBe(errorPage('replayed'));

    const foreign = await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow(), privateKey: 'someone-elses-key' }));
    expect(foreign.status).toBe(400);
    expect(await foreign.text()).toBe(errorPage('unreadable'));

    const failed = await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow() }), { r: '0' });
    expect(failed.status).toBe(400);
    expect(await failed.text()).toBe(errorPage('sso_failed'));

    const noTicket = await continueRequest(app, await startWebLogin(app), undefined);
    expect(noTicket.status).toBe(400);
    expect(await noTicket.text()).toBe(errorPage('unreadable'));
  });

  it('does not log emails, tickets or keys', async () => {
    const { core, user } = seedCore();
    const { app, logs } = await buildVtcApp({ core });
    const udApproved = makeUd({ time: ssoNow() });
    const udPending = makeUd({ time: ssoNow(), userId: '20002', email: 'new.person@vtc.vn' });
    const udStale = makeUd({ time: ssoNow(-3600), userId: '20003' });
    for (const ud of [udApproved, udPending, udStale]) await continueRequest(app, await startWebLogin(app), ud);

    const text = JSON.stringify(logs);
    expect(logs.some((l) => l.msg === 'vtc sso ticket accepted')).toBe(true);
    for (const secret of [EMAIL, 'new.person@vtc.vn', udApproved, udPending, udStale, PRIVATE_KEY]) {
      expect(text).not.toContain(secret);
    }
    for (const key of core.keysOf(user.user_id)) expect(text).not.toContain(key.key_value);
    // The shape of the time is logged, never its value.
    expect(text).toMatch(/dddd-dd-dd dd:dd:dd/);
  });

  it('expires the state cookie on every answer and sets Referrer-Policy', async () => {
    const { core } = seedCore();
    const { app } = await buildVtcApp({ core });
    const responses = [
      // success
      await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow() })),
      // pending
      await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow(), userId: '20004' })),
      // refused ticket
      await continueRequest(app, await startWebLogin(app), makeUd({ time: ssoNow(-3600) })),
      // state mismatch
      await continueRequest(app, { returnUrl: (await startWebLogin(app)).returnUrl }, makeUd({ time: ssoNow() })),
    ];
    expect(responses.map((r) => r.status)).toEqual([302, 200, 400, 400]);
    for (const res of responses) {
      const cleared = res.headers.getSetCookie().find((c) => c.startsWith(`${STATE_COOKIE}=;`));
      expect(cleared).toContain('Max-Age=0');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });
});
