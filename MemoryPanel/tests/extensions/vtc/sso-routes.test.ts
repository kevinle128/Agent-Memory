import { afterEach, describe, expect, it, vi } from 'vitest';
import { STATE_COOKIE, safeReturnTo } from '../../../src/extensions/vtc/http/sso-routes.js';
import { PRIVATE_KEY, buildVtcApp, cleanupVtcApps } from './vtc-fixtures.js';

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupVtcApps();
});

const USER_KEY_METHOD = { id: 'user_key', type: 'user_key', display_name: 'user_key', enabled: true };

async function methods(app: Awaited<ReturnType<typeof buildVtcApp>>['app']) {
  return ((await (await app.request('/api/v1/auth/methods')).json()) as { methods: Array<{ id: string }> }).methods;
}

describe('VTC SSO routes', () => {
  it('lists VTC Mail as a redirect method when enabled', async () => {
    const { app } = await buildVtcApp();
    expect(await methods(app)).toEqual([
      USER_KEY_METHOD,
      {
        id: 'vtc',
        type: 'redirect',
        display_name: 'VTC Mail',
        enabled: true,
        login_url: '/ext/vtc/sso/login?flow=web',
        logout_url: '/ext/vtc/sso/logout',
      },
    ]);
  });

  it('redirects to the SSO with a nonce and a state cookie', async () => {
    const { app } = await buildVtcApp();
    const res = await app.request('/ext/vtc/sso/login?flow=web');
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location.startsWith('https://sso.test.invalid/sso/Login/?id=123456&url=')).toBe(true);
    const url = new URL(location).searchParams.get('url')!;
    const nonce = /\/ext\/vtc\/sso\/return\?n=([A-Za-z0-9_-]{32})$/.exec(url)?.[1];
    expect(nonce).toBeDefined();
    expect(new URL(location).searchParams.get('continue')).toBe('https://panel.test.invalid/ext/vtc/sso/continue');
    expect(new URL(location).searchParams.get('m')).toBe('1');

    const cookie = res.headers.getSetCookie().find((line) => line.startsWith(`${STATE_COOKIE}=`))!;
    expect(cookie).toContain(`${STATE_COOKIE}=${nonce}`);
    for (const attribute of ['HttpOnly', 'SameSite=Lax', 'Max-Age=600', 'Secure']) expect(cookie).toContain(attribute);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('gives each login start its own nonce', async () => {
    const { app } = await buildVtcApp();
    const cookies = await Promise.all(
      [1, 2].map(async () => (await app.request('/ext/vtc/sso/login?flow=web')).headers.getSetCookie()[0]),
    );
    expect(cookies[0]).not.toBe(cookies[1]);
  });

  it('refuses another instance and a flow it does not serve', async () => {
    const { app } = await buildVtcApp();
    const other = await app.request('/ext/vtc/sso/login?flow=web&instance_id=other');
    expect(other.status).toBe(400);
    expect(await other.text()).toContain('VTC Mail login is not available for this memory instance.');
    expect(other.headers.getSetCookie()).toEqual([]);

    expect((await app.request('/ext/vtc/sso/login?flow=web&instance_id=default')).status).toBe(302);
    expect((await app.request('/ext/vtc/sso/login')).status).toBe(400);
    expect((await app.request('/ext/vtc/sso/login?flow=device')).status).toBe(400);
  });

  it('keeps only safe return paths', () => {
    const base = 'https://panel.test.invalid';
    expect(safeReturnTo('/teams?x=1', base)).toBe('/teams?x=1');
    expect(safeReturnTo('/a/b#c', base)).toBe('/a/b#c');
    // The resolved form is what the browser would follow.
    expect(safeReturnTo('/a/../b?x=1', base)).toBe('/b?x=1');
    for (const bad of [
      '//evil.example',
      'https://evil.example',
      '/\\evil.example',
      '/a\\b',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r/evil.example',
      '/\u0000/evil.example',
      '/\u007f/evil.example',
      '/%09/evil.example',
      '/%0a/evil.example',
      '/%0D/evil.example',
      '/%00/evil.example',
      '/%5cevil.example',
      '/%2f/evil.example',
      '/%2F%2Fevil.example',
      '/.//evil.example',
      '/..//evil.example',
      '/%2e//evil.example',
      '/./\\evil.example',
      '/%E0%A4%A',
      'teams',
      '',
    ]) {
      expect(safeReturnTo(bad, base), JSON.stringify(bad)).toBe('/');
    }
    expect(safeReturnTo(undefined, base)).toBe('/');
  });

  it('sends GET /sso/return back to the start page', async () => {
    const { app } = await buildVtcApp();
    const res = await app.request('/ext/vtc/sso/return?n=x');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('rate limits login starts', async () => {
    const { app } = await buildVtcApp();
    for (let i = 0; i < 30; i += 1) expect((await app.request('/ext/vtc/sso/login?flow=web')).status).toBe(302);
    const limited = await app.request('/ext/vtc/sso/login?flow=web');
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain('Too many logins');
  });

  it('logs out of the Panel and the SSO', async () => {
    const { app, deps } = await buildVtcApp();
    const { sessionCookieName } = deps.config.auth;
    const session = deps.auth.createSession({
      instanceId: 'default',
      coreUserId: 'usr-1',
      userKey: 'sk-mem-test-0000000000000000000000000000',
      providerId: 'vtc',
      externalSubject: '10482',
    });
    expect(deps.auth.getSession(session.token)).not.toBeNull();

    const res = await app.request('/ext/vtc/sso/logout', {
      headers: { cookie: `${sessionCookieName}=${session.token}; ${STATE_COOKIE}=abc` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://sso.test.invalid/sso/Logout/?url=https%3A%2F%2Fpanel.test.invalid%2F');
    const cookies = res.headers.getSetCookie();
    expect(cookies.find((line) => line.startsWith(`${sessionCookieName}=;`))).toContain('Max-Age=0');
    expect(cookies.find((line) => line.startsWith(`${STATE_COOKIE}=;`))).toContain('Max-Age=0');
    expect(deps.auth.getSession(session.token)).toBeNull();
  });

  it('does nothing when the request has no Panel session cookie', async () => {
    const { app } = await buildVtcApp();
    const res = await app.request('/ext/vtc/sso/logout', { headers: { cookie: `${STATE_COOKIE}=abc` } });
    expect(res.status).toBe(302);
    // Not the SSO logout, and no cookie is touched: a cross-site link cannot end the SSO session.
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('fails when https is used without Secure cookies', async () => {
    const { app, host } = await buildVtcApp({ settings: { PANEL_AUTH_SESSION_SECURE: '' } });
    expect(host.records()[0]).toMatchObject({ id: 'vtc', status: 'failed' });
    expect(host.records()[0].reason).toContain('PANEL_AUTH_SESSION_SECURE must be true');
    expect(await methods(app)).toEqual([USER_KEY_METHOD]);
    expect((await app.request('/ext/vtc/sso/login?flow=web')).status).toBe(404);
  });

  it('allows http on localhost for local runs', async () => {
    const { host } = await buildVtcApp({
      settings: { PANEL_AUTH_SESSION_SECURE: '' },
      env: {
        PANEL_EXT_VTC_PUBLIC_BASE_URL: 'http://127.0.0.1:18125',
        PANEL_EXT_VTC_SSO_BASE_URL: 'http://127.0.0.1:18126/sso',
      },
    });
    expect(host.records()[0]).toMatchObject({ id: 'vtc', status: 'active' });
  });

  it('refuses plain http for a real host', async () => {
    const { host } = await buildVtcApp({ env: { PANEL_EXT_VTC_PUBLIC_BASE_URL: 'http://panel.test.invalid' } });
    expect(host.records()[0]).toMatchObject({ status: 'failed' });
    expect(host.records()[0].reason).toContain('PUBLIC_BASE_URL');
    const sso = await buildVtcApp({ env: { PANEL_EXT_VTC_SSO_BASE_URL: 'http://sso.test.invalid' } });
    expect(sso.host.records()[0].reason).toContain('SSO_BASE_URL');
  });

  it('refuses a public base URL with a path, query or hash', async () => {
    for (const value of ['https://panel.test.invalid/app', 'https://panel.test.invalid/?a=1', 'https://panel.test.invalid/#x']) {
      const { host } = await buildVtcApp({ env: { PANEL_EXT_VTC_PUBLIC_BASE_URL: value } });
      expect(host.records()[0]).toMatchObject({ status: 'failed' });
    }
  });

  it('fails for an unknown instance', async () => {
    const { host } = await buildVtcApp({ env: { PANEL_EXT_VTC_INSTANCE_ID: 'nope' } });
    expect(host.records()[0]).toMatchObject({ status: 'failed' });
    expect(host.records()[0].reason).toContain('PANEL_EXT_VTC_INSTANCE_ID');
  });

  it('marks the extension degraded when the instance key is not a system admin', async () => {
    const healthy = await buildVtcApp();
    await healthy.host.start();
    expect(healthy.host.records()[0].status).toBe('active');
    await healthy.host.stop();

    const { host } = await buildVtcApp({ apiKeyUserType: 'normal' });
    await host.start();
    expect(host.records()[0]).toMatchObject({ status: 'degraded' });
    expect(host.records()[0].reason).toContain('system admin');
    await host.stop();
  });

  it('config errors never echo values', async () => {
    const { host, logs } = await buildVtcApp({ env: { PANEL_EXT_VTC_SSO_BASE_URL: 'not-a-url' } });
    const record = host.records()[0];
    expect(record.status).toBe('failed');
    expect(record.reason).toContain('SSO_BASE_URL');
    const text = JSON.stringify([record, logs]);
    expect(text).not.toContain('not-a-url');
    expect(text).not.toContain(PRIVATE_KEY);
  });

  it('does not log the private key while it serves logins', async () => {
    const { app, logs } = await buildVtcApp();
    await app.request('/ext/vtc/sso/login?flow=web');
    await app.request('/ext/vtc/sso/logout');
    expect(JSON.stringify(logs)).not.toContain(PRIVATE_KEY);
  });
});
