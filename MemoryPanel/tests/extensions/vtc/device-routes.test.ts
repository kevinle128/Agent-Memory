import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '../../../src/extensions/vtc/http/pages.js';
import { FAKE_API_KEY, createFakeCore } from './fake-core.js';
import { buildVtcApp, cleanupVtcApps, continueRequest, makeUd, ssoNow } from './vtc-fixtures.js';

// Only Date is faked and it is installed before the app is built: the stores and limiters read Date.now
// when they are made, and the data files are written with real timers.
beforeEach(() => {
  vi.stubEnv('TDAI_USER_KEY_MAX_ACTIVE', '20');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T03:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  cleanupVtcApps();
});

const MEMBER = { userId: '10482', email: 'a.b@vtc.vn' };
const NEWCOMER = { userId: '20001', email: 'new.person@vtc.vn' };
const ADMIN_HEADERS = { 'X-Tdai-Service-Id': 'default', 'X-Tdai-User-Key': FAKE_API_KEY, 'content-type': 'application/json' };

type App = Awaited<ReturnType<typeof buildVtcApp>>;

function seedCore() {
  const core = createFakeCore();
  core.seedAdmin();
  const team = core.seedTeam('Team A');
  const user = core.seedUser({ username: 'one', email: MEMBER.email, auth_provider: 'vtc-sso', external_id: MEMBER.userId });
  core.addMember(team.team_id, user.user_id, 'member');
  return { core, team, user };
}

const advance = (seconds: number) => vi.setSystemTime(new Date(Date.now() + seconds * 1000));

interface Reply {
  status: number;
  // The shape differs per route; each test reads only the fields it checks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Headers;
}

async function post(app: App['app'], path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await app.request(`/api/v1/ext/vtc/device/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const START = { install_id: 'install-mac-0001', device_name: 'Paseo on Mac', has_key: false };

async function start(app: App['app'], body: Record<string, unknown> = START) {
  const reply = await post(app, 'start', body);
  expect(reply.status).toBe(200);
  return reply.body as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; interval: number; expires_in: number };
}

/** What a person does: open the device page, then press its button with the cookie the page set. */
async function startBrowserLogin(app: App['app'], userCode: string): Promise<Response> {
  const device = await app.request(`/ext/vtc/device?code=${encodeURIComponent(userCode)}`);
  expect(device.status).toBe(200);
  const confirm = device.headers.getSetCookie().find((line) => line.startsWith('tdai_ext_vtc_device_confirm='))!.split(';')[0]!;
  const href = /href="(\/ext\/vtc\/sso\/login[^"]*)"/.exec(await device.text())![1]!.replace(/&amp;/g, '&');
  return app.request(href, { headers: { cookie: confirm } });
}

/** The browser side: the device page, the SSO round trip with a crafted ticket, the continue page. */
async function browserLogin(app: App['app'], userCode: string, person = MEMBER) {
  const login = await startBrowserLogin(app, userCode);
  expect(login.status).toBe(302);
  const returnUrl = new URL(login.headers.get('location')!).searchParams.get('url')!;
  const cookie = login.headers.getSetCookie().find((line) => line.startsWith('tdai_ext_vtc_state='))!.split(';')[0]!;
  const res = await continueRequest(app, { returnUrl, cookie }, makeUd({ time: ssoNow(), ...person }));
  return { status: res.status, html: await res.text(), setCookies: res.headers.getSetCookie() };
}

const page = (kind: Parameters<typeof renderPage>[0]['kind']) => renderPage({ lang: 'en', kind });
// The SSO session stays open after a waiting or refused device login, so these pages carry the SSO logout link.
const SSO_LOGOUT = 'https://sso.test.invalid/sso/Logout/?url=https%3A%2F%2Fpanel.test.invalid%2F';
const pageWithLogout = (kind: 'device_waiting' | 'device_refused') => renderPage({ lang: 'en', kind, logoutHref: SSO_LOGOUT });

/** A full successful login of a team member; returns the token answer. */
async function connect(app: App['app'], body: Record<string, unknown> = START) {
  const started = await start(app, body);
  const browser = await browserLogin(app, started.user_code);
  expect(browser.html).toBe(page('device_done'));
  advance(6);
  return post(app, 'token', { device_code: started.device_code });
}

describe('device routes', () => {
  it('logs a known team member in and returns the key once', async () => {
    const { core, team, user } = seedCore();
    const { app } = await buildVtcApp({ core });
    const started = await start(app);
    expect(started).toMatchObject({
      verification_uri: 'https://panel.test.invalid/ext/vtc/device',
      verification_uri_complete: `https://panel.test.invalid/ext/vtc/device?code=${started.user_code}`,
      interval: 5,
      expires_in: 600,
    });

    const device = await app.request(`/ext/vtc/device?code=${started.user_code.toLowerCase()}`);
    expect(device.status).toBe(200);
    const deviceHtml = await device.text();
    expect(deviceHtml).toContain('Paseo on Mac');
    expect(deviceHtml).toContain(started.user_code);
    expect(deviceHtml).toContain('Log in with VTC Mail');
    expect(deviceHtml).toContain(`/ext/vtc/sso/login?flow=device&amp;code=${started.user_code}`);
    expect(deviceHtml).not.toContain('class="code"');
    expect(device.headers.get('x-frame-options')).toBe('DENY');
    expect(device.headers.get('content-security-policy')).not.toContain('script-src');
    expect(deviceHtml).not.toContain('<script');

    const browser = await browserLogin(app, started.user_code);
    expect(browser.status).toBe(200);
    expect(browser.html).toBe(page('device_done'));
    expect(browser.setCookies.some((c) => c.startsWith('tdai_ext_vtc_state=') && /Max-Age=0|expires=/i.test(c))).toBe(true);
    expect(browser.setCookies.some((c) => c.startsWith('tdai_idp_session='))).toBe(false);

    // The first poll is only due after the interval.
    expect((await post(app, 'token', { device_code: started.device_code })).body).toEqual({ error: 'slow_down' });
    advance(6);
    const token = await post(app, 'token', { device_code: started.device_code });
    expect(token.status).toBe(200);
    expect(token.headers.get('cache-control')).toBe('no-store');
    expect(token.body).toMatchObject({
      status: 'approved',
      renewed: false,
      expires_at: '2026-11-27T03:00:06.000Z',
      user: { user_id: user.user_id, email: MEMBER.email, display_name: 'one' },
      teams: [{ team_id: team.team_id, name: 'Team A', role: 'member' }],
    });
    expect(token.body.user_key).toMatch(/^sk-mem-test-/);
    expect(token.body.user_key).not.toBe(user.default_key_value);
    expect(JSON.stringify(token.body)).not.toContain(user.default_key_value);
    expect(core.keysOf(user.user_id).find((k) => k.key_id === token.body.key_id)).toMatchObject({ name: 'paseo:Paseo on Mac', status: 'active' });

    advance(6);
    const again = await post(app, 'token', { device_code: started.device_code });
    expect(again).toMatchObject({ status: 400, body: { error: 'expired_token' } });
  });

  it('answers pending and unknown device codes in the RFC shape', async () => {
    const { core } = seedCore();
    const { app } = await buildVtcApp({ core });
    const started = await start(app);
    advance(6);
    expect(await post(app, 'token', { device_code: started.device_code })).toMatchObject({ status: 400, body: { error: 'authorization_pending' } });
    expect(await post(app, 'token', { device_code: 'unknown' })).toMatchObject({ status: 400, body: { error: 'expired_token' } });
    expect(await post(app, 'token', {})).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(await post(app, 'token', 'not json')).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
  });

  it('renews instead of creating on the same device', async () => {
    const { core, user } = seedCore();
    const { app } = await buildVtcApp({ core });
    const first = await connect(app);
    advance(3600);
    const second = await connect(app, { ...START, has_key: true });

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: 'approved', renewed: true, key_id: first.body.key_id });
    expect(second.body).not.toHaveProperty('user_key');
    expect(second.body.expires_at > first.body.expires_at).toBe(true);
    expect(second.body.teams).toHaveLength(1);
    const deviceKeys = core.keysOf(user.user_id).filter((k) => k.name === 'paseo:Paseo on Mac');
    expect(deviceKeys).toHaveLength(1);
    expect(core.calls.filter((c) => c.action === 'user-key/create')).toHaveLength(1);
  });

  it('replaces the key after a reinstall', async () => {
    const { core, user } = seedCore();
    const { app } = await buildVtcApp({ core });
    const first = await connect(app);
    const second = await connect(app, { ...START, has_key: false });
    expect(second.body.renewed).toBe(false);
    expect(second.body.key_id).not.toBe(first.body.key_id);
    expect(core.keysOf(user.user_id).find((k) => k.key_id === first.body.key_id)!.status).toBe('revoked');
  });

  it('returns a claim token to a person who waits and the key after approval', async () => {
    const { core, team } = seedCore();
    const { app, dataDir } = await buildVtcApp({ core });
    const started = await start(app);
    const browser = await browserLogin(app, started.user_code, NEWCOMER);
    expect(browser.status).toBe(200);
    expect(browser.html).toBe(pageWithLogout('device_waiting'));

    advance(6);
    const token = await post(app, 'token', { device_code: started.device_code });
    expect(token).toMatchObject({ status: 200, body: { status: 'account_pending', retry_after: 60 } });
    const claimToken = token.body.claim_token as string;
    expect(claimToken.length).toBeGreaterThanOrEqual(43);

    const waiting = await post(app, 'claim', { install_id: START.install_id, claim_token: claimToken });
    expect(waiting).toMatchObject({ status: 200, body: { status: 'account_pending', retry_after: 60 } });

    const list = await app.request('/api/v1/ext/vtc/pending/list', { method: 'POST', headers: ADMIN_HEADERS, body: '{}' });
    const pendingId = ((await list.json()) as { data: { items: Array<{ pending_id: string }> } }).data.items[0]!.pending_id;
    const approve = await app.request('/api/v1/ext/vtc/pending/approve', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ pending_id: pendingId, team_id: team.team_id, role: 'reviewer', mode: 'create' }),
    });
    expect(approve.status).toBe(200);

    const claimed = await post(app, 'claim', { install_id: START.install_id, claim_token: claimToken });
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({
      status: 'approved',
      renewed: false,
      user: { email: NEWCOMER.email, display_name: 'new-person' },
      teams: [{ team_id: team.team_id, name: 'Team A', role: 'reviewer' }],
    });
    expect(claimed.body.user_key).toMatch(/^sk-mem-test-/);
    expect(await post(app, 'claim', { install_id: START.install_id, claim_token: claimToken })).toMatchObject({
      status: 400,
      body: { error: 'invalid_grant' },
    });
    expect(JSON.parse(readFileSync(join(dataDir, 'vtc', 'claims.json'), 'utf8')).claims).toEqual([]);
  });

  it('binds the claim token to the install', async () => {
    const { core } = seedCore();
    const { app } = await buildVtcApp({ core });
    const started = await start(app);
    await browserLogin(app, started.user_code, NEWCOMER);
    advance(6);
    const { body } = await post(app, 'token', { device_code: started.device_code });
    expect(await post(app, 'claim', { install_id: 'install-other-01', claim_token: body.claim_token })).toMatchObject({
      status: 400,
      body: { error: 'invalid_grant' },
    });
    expect(await post(app, 'claim', { install_id: START.install_id, claim_token: 'unknown-token' })).toMatchObject({
      status: 400,
      body: { error: 'invalid_grant' },
    });
  });

  it('expires a claim after seven days', async () => {
    const { core } = seedCore();
    const { app, dataDir } = await buildVtcApp({ core });
    const started = await start(app);
    await browserLogin(app, started.user_code, NEWCOMER);
    advance(6);
    const { body } = await post(app, 'token', { device_code: started.device_code });
    advance(7 * 86_400 + 1);
    expect(await post(app, 'claim', { install_id: START.install_id, claim_token: body.claim_token })).toMatchObject({
      status: 400,
      body: { error: 'expired_token' },
    });
    expect(JSON.parse(readFileSync(join(dataDir, 'vtc', 'claims.json'), 'utf8')).claims).toEqual([]);
  });

  it('refuses a rejected person', async () => {
    const { core } = seedCore();
    const { app } = await buildVtcApp({ core });
    const started = await start(app);
    await browserLogin(app, started.user_code, NEWCOMER);
    advance(6);
    const { body } = await post(app, 'token', { device_code: started.device_code });

    const list = await app.request('/api/v1/ext/vtc/pending/list', { method: 'POST', headers: ADMIN_HEADERS, body: '{}' });
    const pendingId = ((await list.json()) as { data: { items: Array<{ pending_id: string }> } }).data.items[0]!.pending_id;
    await app.request('/api/v1/ext/vtc/pending/reject', { method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ pending_id: pendingId }) });
    expect(await post(app, 'claim', { install_id: START.install_id, claim_token: body.claim_token })).toMatchObject({
      status: 400,
      body: { error: 'access_denied' },
    });

    // The person logs in again on a new device code: the browser says refused and the plugin gets access_denied.
    const second = await start(app, { ...START, install_id: 'install-mac-0002' });
    const browser = await browserLogin(app, second.user_code, NEWCOMER);
    expect(browser.status).toBe(403);
    expect(browser.html).toBe(pageWithLogout('device_refused'));
    advance(6);
    expect(await post(app, 'token', { device_code: second.device_code })).toMatchObject({ status: 400, body: { error: 'access_denied' } });
  });

  it('refuses an expired user code on the device page and at login', async () => {
    const { core } = seedCore();
    const { app } = await buildVtcApp({ core });
    const started = await start(app);
    advance(601);
    const device = await app.request(`/ext/vtc/device?code=${started.user_code}`);
    expect(device.status).toBe(404);
    expect(await device.text()).toBe(page('device_expired'));
    const login = await app.request(`/ext/vtc/sso/login?flow=device&code=${started.user_code}`);
    expect(login.status).toBe(400);
    expect(await login.text()).toBe(page('device_expired'));
    expect((await app.request('/ext/vtc/sso/login?flow=device&code=nonsense')).status).toBe(400);
    expect((await app.request('/ext/vtc/sso/login?flow=device')).status).toBe(400);
    expect((await app.request('/ext/vtc/device')).status).toBe(404);
  });

  it('shows the expired page when the code ends during the SSO round trip', async () => {
    const { core } = seedCore();
    // A short code lifetime, so the code ends while the login state (ten minutes) is still valid.
    const { app } = await buildVtcApp({ core, env: { PANEL_EXT_VTC_DEVICE_CODE_TTL_SECONDS: '60' } });
    const started = await start(app);
    const login = await startBrowserLogin(app, started.user_code);
    const returnUrl = new URL(login.headers.get('location')!).searchParams.get('url')!;
    const cookie = login.headers.getSetCookie().find((line) => line.startsWith('tdai_ext_vtc_state='))!.split(';')[0]!;
    advance(61);
    const res = await continueRequest(app, { returnUrl, cookie }, makeUd({ time: ssoNow(), ...MEMBER }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(page('device_expired'));
  });

  it('validates start input', async () => {
    const { core } = seedCore();
    const { app } = await buildVtcApp({ core });
    const bad = [
      { ...START, install_id: 'short' },
      { ...START, install_id: 'has space 123' },
      { ...START, install_id: 'panel-web' },
      { ...START, device_name: 'x'.repeat(65) },
      { ...START, device_name: ' \u0007 ' },
      { ...START, has_key: 'yes' },
      { install_id: START.install_id },
    ];
    for (const body of bad) expect((await post(app, 'start', body)).status, JSON.stringify(body)).toBe(400);

    const cleaned = await post(app, 'start', { ...START, device_name: '  Mac\u0007 mini  ' });
    expect(cleaned.status).toBe(200);
    const row = await app.request(`/ext/vtc/device?code=${cleaned.body.user_code}`);
    expect(await row.text()).toContain('Mac mini');
    expect((await post(app, 'start', { install_id: START.install_id, device_name: 'Mac' })).status).toBe(200);
  });

  it('rate limits start, token and claim', async () => {
    const { core } = seedCore();
    const { app } = await buildVtcApp({ core });
    for (let i = 0; i < 10; i += 1) expect((await post(app, 'start', START)).status).toBe(200);
    expect(await post(app, 'start', START)).toMatchObject({ status: 429, body: { error: 'slow_down' } });
    for (let i = 0; i < 10; i += 1) await post(app, 'claim', { install_id: START.install_id, claim_token: 'x' });
    expect((await post(app, 'claim', { install_id: START.install_id, claim_token: 'x' })).status).toBe(429);
    for (let i = 0; i < 60; i += 1) await post(app, 'token', { device_code: 'x' });
    expect((await post(app, 'token', { device_code: 'x' })).status).toBe(429);
  });

  it('logs out a device', async () => {
    const { core, user } = seedCore();
    const { app } = await buildVtcApp({ core });
    const issued = await connect(app);
    const key = issued.body.user_key as string;
    const logout = { install_id: START.install_id };

    expect(await post(app, 'logout', logout)).toMatchObject({ status: 401, body: { error: 'invalid_token' } });
    expect(await post(app, 'logout', { install_id: 'install-other-01' }, { 'X-Tdai-User-Key': key })).toMatchObject({
      status: 404,
      body: { error: 'unknown_device' },
    });
    expect(await post(app, 'logout', { install_id: 'panel-web' }, { 'X-Tdai-User-Key': key })).toMatchObject({ status: 400 });
    expect(await post(app, 'logout', logout, { 'X-Tdai-User-Key': key })).toMatchObject({ status: 200, body: { ok: true } });

    // Expired, not revoked: Core refuses the key, the key row is still active.
    const row = core.keysOf(user.user_id).find((k) => k.key_value === key)!;
    expect(row.status).toBe('active');
    expect(Date.parse(row.expires_at!)).toBeLessThanOrEqual(Date.now());
    expect(await post(app, 'logout', logout, { 'X-Tdai-User-Key': key })).toMatchObject({ status: 401 });
  });

  it('never stores device key values, claim tokens or device codes', async () => {
    const { core } = seedCore();
    const { app, dataDir } = await buildVtcApp({ core });
    const member = await connect(app);
    const started = await start(app, { ...START, install_id: 'install-new-0001' });
    await browserLogin(app, started.user_code, NEWCOMER);
    advance(6);
    const pending = await post(app, 'token', { device_code: started.device_code });
    const second = await start(app, { ...START, install_id: 'install-new-0002' });

    const files = ['devices', 'claims', 'pending', 'links']
      .map((name) => {
        try {
          return readFileSync(join(dataDir, 'vtc', `${name}.json`), 'utf8');
        } catch {
          return '';
        }
      })
      .join('\n');
    for (const secret of [member.body.user_key, pending.body.claim_token, started.device_code, second.device_code]) {
      expect(files).not.toContain(secret);
    }
    expect(files).toContain('tokenHash');
  });

  it('never logs keys, codes or tokens', async () => {
    const { core } = seedCore();
    const { app, logs } = await buildVtcApp({ core });
    const member = await connect(app);
    const started = await start(app, { ...START, install_id: 'install-new-0001' });
    await browserLogin(app, started.user_code, NEWCOMER);
    advance(6);
    const pending = await post(app, 'token', { device_code: started.device_code });
    await post(app, 'logout', { install_id: START.install_id }, { 'X-Tdai-User-Key': member.body.user_key });
    core.failNext('team-member/get');
    await post(app, 'claim', { install_id: 'install-new-0001', claim_token: pending.body.claim_token });

    const text = JSON.stringify(logs);
    for (const secret of [member.body.user_key, pending.body.claim_token, started.device_code, started.user_code, NEWCOMER.email, MEMBER.email]) {
      expect(text).not.toContain(secret);
    }
  });

  it('answers 503 and keeps the claim when Core fails, without minting a key', async () => {
    const { core, team } = seedCore();
    const { app } = await buildVtcApp({ core });
    const started = await start(app);
    await browserLogin(app, started.user_code, NEWCOMER);
    advance(6);
    const { body } = await post(app, 'token', { device_code: started.device_code });

    const list = await app.request('/api/v1/ext/vtc/pending/list', { method: 'POST', headers: ADMIN_HEADERS, body: '{}' });
    const pendingId = ((await list.json()) as { data: { items: Array<{ pending_id: string }> } }).data.items[0]!.pending_id;
    await app.request('/api/v1/ext/vtc/pending/approve', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ pending_id: pendingId, team_id: team.team_id, role: 'member', mode: 'create' }),
    });

    // The profile read fails after the resolver ran: no key may exist yet and the token stays usable.
    core.failNext('team-member/get');
    const failed = await post(app, 'claim', { install_id: START.install_id, claim_token: body.claim_token });
    expect(failed).toMatchObject({ status: 503, body: { error: 'temporarily_unavailable' } });
    expect(core.calls.filter((c) => c.action === 'user-key/create')).toHaveLength(0);
    const retried = await post(app, 'claim', { install_id: START.install_id, claim_token: body.claim_token });
    expect(retried.status).toBe(200);
  });

  it('reports the key limit with a clear error', async () => {
    const { core, user } = seedCore();
    core.addKeys(user.user_id, 19);
    const { app } = await buildVtcApp({ core });
    const reply = await connect(app);
    expect(reply).toMatchObject({ status: 409, body: { error: 'key_limit_exceeded' } });
  });

  it('keeps the outcome for a retry when the answer fails before a key goes out', async () => {
    const { core, user } = seedCore();
    const { app } = await buildVtcApp({ core });
    const started = await start(app);
    await browserLogin(app, started.user_code);
    advance(6);
    // The profile read fails after the outcome was taken: nothing was minted, so the next poll must still get it.
    core.failNext('team-member/get');
    const failed = await post(app, 'token', { device_code: started.device_code });
    expect(failed).toMatchObject({ status: 503, body: { error: 'temporarily_unavailable' } });
    expect(core.calls.filter((c) => c.action === 'user-key/create')).toHaveLength(0);

    advance(6);
    const retried = await post(app, 'token', { device_code: started.device_code });
    expect(retried.status).toBe(200);
    expect(retried.body.user_key).toMatch(/^sk-mem-test-/);
    expect(core.keysOf(user.user_id).filter((k) => k.name === 'paseo:Paseo on Mac')).toHaveLength(1);

    advance(6);
    expect(await post(app, 'token', { device_code: started.device_code })).toMatchObject({ status: 400, body: { error: 'expired_token' } });
  });

  it('gives the key to one of two polls that overlap', async () => {
    const { core } = seedCore();
    const { app } = await buildVtcApp({ core });
    const started = await start(app);
    await browserLogin(app, started.user_code);
    advance(6);
    const [one, two] = await Promise.all([
      post(app, 'token', { device_code: started.device_code }),
      post(app, 'token', { device_code: started.device_code }),
    ]);
    const statuses = [one.status, two.status].sort();
    expect(statuses).toEqual([200, 400]);
    expect(core.calls.filter((c) => c.action === 'user-key/create')).toHaveLength(1);
  });

  it('does not revive a key that a logout expired', async () => {
    const { core, user } = seedCore();
    const { app } = await buildVtcApp({ core });
    const first = await connect(app);
    const key = first.body.user_key as string;
    await post(app, 'logout', { install_id: START.install_id }, { 'X-Tdai-User-Key': key });

    const again = await connect(app, { ...START, has_key: true });
    expect(again.status).toBe(200);
    expect(again.body.renewed).toBe(false);
    expect(again.body.key_id).not.toBe(first.body.key_id);
    expect(again.body.user_key).not.toBe(key);
    const old = core.keysOf(user.user_id).find((k) => k.key_id === first.body.key_id)!;
    expect(old.status).toBe('revoked');
    // The logged-out key is still refused.
    expect(await post(app, 'logout', { install_id: START.install_id }, { 'X-Tdai-User-Key': key })).toMatchObject({ status: 401 });
  });

  it('lets only the device own key log that device out', async () => {
    const { core, user } = seedCore();
    const { app } = await buildVtcApp({ core });
    const issued = await connect(app);
    const logout = { install_id: START.install_id };

    // The default key of the same user is valid in Core but is not this device's key.
    expect(await post(app, 'logout', logout, { 'X-Tdai-User-Key': user.default_key_value })).toMatchObject({
      status: 401,
      body: { error: 'invalid_token' },
    });
    const row = core.keysOf(user.user_id).find((k) => k.key_id === issued.body.key_id)!;
    expect(row.expires_at).not.toBeNull();
    expect(Date.parse(row.expires_at!)).toBeGreaterThan(Date.now());
    expect(await post(app, 'logout', logout, { 'X-Tdai-User-Key': issued.body.user_key })).toMatchObject({ status: 200 });
  });

  it('lets only one of two claims with the same token mint a key', async () => {
    const { core, team } = seedCore();
    const { app } = await buildVtcApp({ core });
    const started = await start(app);
    await browserLogin(app, started.user_code, NEWCOMER);
    advance(6);
    const { body } = await post(app, 'token', { device_code: started.device_code });
    const list = await app.request('/api/v1/ext/vtc/pending/list', { method: 'POST', headers: ADMIN_HEADERS, body: '{}' });
    const pendingId = ((await list.json()) as { data: { items: Array<{ pending_id: string }> } }).data.items[0]!.pending_id;
    await app.request('/api/v1/ext/vtc/pending/approve', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ pending_id: pendingId, team_id: team.team_id, role: 'member', mode: 'create' }),
    });

    const claim = { install_id: START.install_id, claim_token: body.claim_token };
    const [one, two] = await Promise.all([post(app, 'claim', claim), post(app, 'claim', claim)]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect([one, two].find((r) => r.status === 409)!.body).toEqual({ error: 'claim_in_progress' });
    expect(core.calls.filter((c) => c.action === 'user-key/create')).toHaveLength(1);
  });

  it('sends a login that skipped the device page back to it', async () => {
    const { core } = seedCore();
    const { app } = await buildVtcApp({ core });
    const started = await start(app);
    const target = `/ext/vtc/sso/login?flow=device&code=${started.user_code}`;
    const devicePath = `/ext/vtc/device?code=${started.user_code}`;
    const sentBack = (res: Response) => {
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(devicePath);
      expect(res.headers.getSetCookie().some((c) => c.startsWith('tdai_ext_vtc_state='))).toBe(false);
    };

    sentBack(await app.request(target));

    const page = await app.request(devicePath);
    const setCookie = page.headers.getSetCookie().find((line) => line.startsWith('tdai_ext_vtc_device_confirm='))!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    const pair = setCookie.split(';')[0]!;
    const token = pair.split('=')[1]!;
    const html = await page.text();
    expect(html).toContain(`confirm=${token}`);

    // The cookie alone: a page of another site that opened the device page in a window and then navigated
    // that window to the login would send it, but it cannot read the token out of the page.
    sentBack(await app.request(target, { headers: { cookie: pair } }));
    // The link token alone: a link an attacker built from a device page of their own.
    sentBack(await app.request(`${target}&confirm=${token}`));
    // Made-up or mismatched values.
    sentBack(await app.request(`${target}&confirm=made-up`, { headers: { cookie: 'tdai_ext_vtc_device_confirm=made-up' } }));
    sentBack(await app.request(`${target}&confirm=other`, { headers: { cookie: pair } }));
    // A token that belongs to another code.
    const other = await start(app, { ...START, install_id: 'install-mac-0002' });
    const otherPage = await app.request(`/ext/vtc/device?code=${other.user_code}`);
    const otherToken = otherPage.headers.getSetCookie().find((line) => line.startsWith('tdai_ext_vtc_device_confirm='))!.split(';')[0]!.split('=')[1]!;
    sentBack(await app.request(`${target}&confirm=${otherToken}`, { headers: { cookie: `tdai_ext_vtc_device_confirm=${otherToken}` } }));

    // Wrong attempts did not use the token up; both copies together pass once.
    const good = await app.request(`${target}&confirm=${token}`, { headers: { cookie: pair } });
    expect(good.status).toBe(302);
    expect(good.headers.get('location')).toMatch(/^https:\/\/sso\.test\.invalid\//);
    sentBack(await app.request(`${target}&confirm=${token}`, { headers: { cookie: pair } }));
  });
});
