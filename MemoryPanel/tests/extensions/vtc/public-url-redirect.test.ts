import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicHttpsRedirectLocation } from '../../../src/extensions/vtc/http/public-url-redirect.js';
import { createPanelFixture } from '../support/panel-fixture.js';
import { buildVtcApp, cleanupVtcApps } from './vtc-fixtures.js';

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupVtcApps();
});

const PUBLIC = 'https://panel.test.invalid';

describe('public HTTPS redirect', () => {
  it('sends an HTTP browser navigation to the public origin and keeps the path and query', async () => {
    const { app } = await buildVtcApp();
    const page = await app.request('http://panel.test.invalid:8125/teams?tab=1&return_to=%2Ftasks');
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe(`${PUBLIC}/teams?tab=1&return_to=%2Ftasks`);
    expect(page.headers.get('set-cookie')).toBeNull();

    const sso = await app.request('http://panel.test.invalid:8125/ext/vtc/sso/login?flow=web&return_to=%2Fteams');
    expect(sso.status).toBe(302);
    expect(sso.headers.get('location')).toBe(`${PUBLIC}/ext/vtc/sso/login?flow=web&return_to=%2Fteams`);
    expect(sso.headers.get('set-cookie')).toBeNull();

    const head = await app.request('http://panel.test.invalid:8125/ext/vtc/device?code=AB', { method: 'HEAD' });
    expect(head.status).toBe(302);
    expect(head.headers.get('location')).toBe(`${PUBLIC}/ext/vtc/device?code=AB`);
  });

  it('treats an explicit public port as already arrived, including when X-Forwarded-Proto is missing', async () => {
    const { app } = await buildVtcApp({
      env: { PANEL_EXT_VTC_PUBLIC_BASE_URL: 'https://panel.test.invalid:8126' },
    });
    const direct = await app.request('http://panel.test.invalid:8125/ext/vtc/sso/login?flow=web&return_to=%2Fteams');
    expect(direct.status).toBe(302);
    expect(direct.headers.get('location')).toBe(
      'https://panel.test.invalid:8126/ext/vtc/sso/login?flow=web&return_to=%2Fteams',
    );

    const proxied = await app.request('http://panel.test.invalid:8126/ext/vtc/sso/login?flow=web', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(proxied.headers.get('location')).toMatch(/^https:\/\/sso\.test\.invalid\//);

    const headerMissing = await app.request('http://panel.test.invalid:8126/teams?tab=1');
    expect(headerMissing.headers.get('location')).toBeNull();
  });

  it('does not redirect a request whose host is already the public host', async () => {
    const { app } = await buildVtcApp();
    for (const headers of [
      { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'panel.test.invalid' },
      { 'x-forwarded-proto': 'http' },
      {},
    ]) {
      const res = await app.request('http://panel.test.invalid/ext/vtc/sso/login?flow=web', { headers });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toMatch(/^https:\/\/sso\.test\.invalid\//);
    }
  });

  it('keeps redirecting when the host differs even if proxy headers name the public origin', async () => {
    const { app } = await buildVtcApp();
    const res = await app.request('http://panel.test.invalid:8125/teams?tab=1', {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/teams?tab=1`);
  });

  it('does not redirect health, API, or a non-navigation method', async () => {
    const { app } = await buildVtcApp();
    const health = await app.request('http://panel.test.invalid:8125/health');
    expect(health.status).toBe(200);
    expect(health.headers.get('location')).toBeNull();
    expect(await health.json()).toEqual({ status: 'ok' });

    const head = await app.request('http://panel.test.invalid:8125/health', { method: 'HEAD' });
    expect(head.headers.get('location')).toBeNull();

    const api = await app.request('http://panel.test.invalid:8125/api/v1/auth/methods');
    expect(api.status).toBe(200);
    expect(api.headers.get('location')).toBeNull();

    const post = await app.request('http://panel.test.invalid:8125/api/v1/ext/vtc/device/start', { method: 'POST' });
    expect(post.status).not.toBe(302);
    expect(post.headers.get('location')).toBeNull();
  });

  it('stays unchanged when the extension is off or the public origin is http', async () => {
    const off = await createPanelFixture();
    try {
      const { buildPanelApp } = await import('../../../src/panel/http/app.js');
      const app = buildPanelApp(off.deps);
      const res = await app.request('http://panel.test.invalid:8125/teams?tab=1');
      expect(res.headers.get('location')).toBeNull();
    } finally {
      off.cleanup();
    }

    const { app } = await buildVtcApp({
      settings: { PANEL_AUTH_SESSION_SECURE: '' },
      env: {
        PANEL_EXT_VTC_PUBLIC_BASE_URL: 'http://127.0.0.1:18125',
        PANEL_EXT_VTC_SSO_BASE_URL: 'http://127.0.0.1:18126/sso',
      },
    });
    const local = await app.request('http://127.0.0.1:8125/teams?tab=1');
    expect(local.headers.get('location')).toBeNull();
  });

  it('builds the target only from the public origin', () => {
    expect(
      publicHttpsRedirectLocation({
        method: 'GET',
        requestUrl: 'http://evil.example:8125/teams?next=https://evil.example/phish',
        publicBaseUrl: PUBLIC,
      }),
    ).toBe(`${PUBLIC}/teams?next=https://evil.example/phish`);
    expect(
      publicHttpsRedirectLocation({
        method: 'GET',
        requestUrl: 'http://panel.test.invalid/teams',
        publicBaseUrl: PUBLIC,
      }),
    ).toBeNull();
    expect(
      publicHttpsRedirectLocation({
        method: 'GET',
        requestUrl: 'http://panel.test.invalid:8125/health',
        publicBaseUrl: 'http://127.0.0.1:18125',
      }),
    ).toBeNull();
  });
});
