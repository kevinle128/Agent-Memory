import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthProvider, RedirectCallbackProvider } from '../../src/panel/auth/types.js';
import { createExtensionHost } from '../../src/panel/extensions/host.js';
import type { ExtensionContext, ExtensionHooks, PanelExtension } from '../../src/panel/extensions/types.js';
import { createPanelFixture, stubMetaKernel, type PanelFixture } from './support/panel-fixture.js';

const fixtures: PanelFixture[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (fixtures.length) fixtures.pop()!.cleanup();
});

const DEMO_ENV = { PANEL_EXT_DEMO_NAME: 'demo-name' };
const configSchema = z.object({ NAME: z.string() });

function demoProvider(overrides: Partial<RedirectCallbackProvider> = {}): RedirectCallbackProvider {
  return {
    id: 'demo',
    type: 'ticket',
    kind: 'redirect-callback',
    displayName: 'Demo sign-in',
    authProviderDomain: 'demo',
    buildLoginUrl: () => '',
    buildLogoutUrl: () => '',
    loginPath: '/ext/demo/login',
    logoutPath: '/ext/demo/logout',
    authenticateFromCallback: async () => null,
    ...overrides,
  };
}

function demoExtension(
  register: (ctx: ExtensionContext<{ NAME: string }>) => void | ExtensionHooks = () => undefined,
  overrides: Partial<PanelExtension<{ NAME: string }>> = {},
): PanelExtension<{ NAME: string }> {
  return {
    id: 'demo',
    version: '1.2.3',
    apiVersion: 1,
    displayName: 'Demo',
    configSchema,
    register,
    ...overrides,
  };
}

interface Options {
  selected?: string[];
  strict?: boolean;
  settings?: Record<string, string>;
  env?: Record<string, string>;
}

async function setup(catalog: PanelExtension<any>[], options: Options = {}) {
  const fixture = await createPanelFixture(options.settings);
  fixtures.push(fixture);
  const { deps } = fixture;
  deps.config.extensions = {
    enabled: options.selected ?? ['demo'],
    dataDir: fixture.dataDir,
    strict: options.strict ?? false,
  };
  const host = createExtensionHost({ deps, catalog, env: options.env ?? DEMO_ENV });
  if (host) deps.extensions = host;
  const { buildPanelApp } = await import('../../src/panel/http/app.js');
  return { ...fixture, host, app: buildPanelApp(deps) };
}

function systemAdminKernel(deps: PanelFixture['deps']) {
  return stubMetaKernel(deps, (action, body) => {
    if (action !== 'auth/verify') return { code: 404, message: 'not_found: unknown action' };
    if (body.user_key === 'sk-mem-test-admin') {
      return { data: { valid: true, user: { user_id: 'usr-admin', user_type: 'system_admin' } } };
    }
    if (body.user_key === 'sk-mem-test-member') {
      return { data: { valid: true, user: { user_id: 'usr-member', user_type: 'user' } } };
    }
    return { data: { valid: false } };
  });
}

const adminHeaders = { 'x-tdai-service-id': 'default', 'x-tdai-user-key': 'sk-mem-test-admin' };

describe('extension host', () => {
  it('returns no host when no extension is selected', async () => {
    const fixture = await createPanelFixture();
    fixtures.push(fixture);
    fixture.deps.config.extensions.enabled = [];
    expect(createExtensionHost({ deps: fixture.deps, catalog: [demoExtension()] })).toBeUndefined();

    const { buildPanelApp } = await import('../../src/panel/http/app.js');
    const app = buildPanelApp(fixture.deps);
    const paths = app.routes.map((route) => route.path);
    expect(paths.some((path) => path.includes('/ext/') || path.endsWith('/extensions'))).toBe(false);
    expect((await app.request('/api/v1/extensions')).status).toBe(404);
    expect(existsSync(fixture.dataDir)).toBe(false);
  });

  it('skips an unknown id and reports it to a system admin only', async () => {
    const { app, deps, host } = await setup([], { selected: ['nope'] });
    systemAdminKernel(deps);
    expect(host!.records()).toMatchObject([{ id: 'nope', status: 'failed', reason: 'unknown extension' }]);

    const anonymous = await app.request('/api/v1/extensions');
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toEqual({ extensions: [] });

    const member = await app.request('/api/v1/extensions', {
      headers: { ...adminHeaders, 'x-tdai-user-key': 'sk-mem-test-member' },
    });
    expect(await member.json()).toEqual({ extensions: [] });

    const admin = await app.request('/api/v1/extensions', { headers: adminHeaders });
    expect(await admin.json()).toMatchObject({
      extensions: [{ id: 'nope', status: 'failed', reason: 'unknown extension' }],
    });
  });

  it('marks bad config as failed and mounts nothing', async () => {
    const register = vi.fn();
    const userKeyOnly = {
      methods: [{ id: 'user_key', type: 'user_key', display_name: 'user_key', enabled: true }],
    };

    // A value that exists but breaks the schema: the reason names the field, never the value.
    const tooShort = demoExtension(register, { configSchema: z.object({ NAME: z.string().min(50) }) });
    const invalid = await setup([tooShort], { env: { PANEL_EXT_DEMO_NAME: 'leaky-value-not-real' } });
    const record = invalid.host!.records()[0];
    expect(record.status).toBe('failed');
    expect(record.reason).toContain('NAME');
    expect(JSON.stringify([record, invalid.logs])).not.toContain('leaky-value-not-real');
    expect((await invalid.app.request('/api/v1/ext/demo/ping')).status).toBe(404);

    // A missing value, and an empty one that counts as missing.
    for (const env of [{}, { PANEL_EXT_DEMO_NAME: '' }]) {
      const missing = await setup([demoExtension(register)], { env });
      expect(missing.host!.records()[0]).toMatchObject({ status: 'failed' });
      expect(missing.host!.records()[0].reason).toContain('NAME');
      expect((await missing.app.request('/api/v1/ext/demo/ping')).status).toBe(404);
      expect(await (await missing.app.request('/api/v1/auth/methods')).json()).toEqual(userKeyOnly);
    }
    expect(register).not.toHaveBeenCalled();
  });

  it('commits nothing when register throws', async () => {
    const { app } = await setup([
      demoExtension((ctx) => {
        ctx.auth.registerProvider(demoProvider());
        ctx.http.api.get('/ping', (c) => c.text('pong'));
        throw new Error('register went wrong');
      }),
    ]);
    const methods = (await (await app.request('/api/v1/auth/methods')).json()) as { methods: Array<{ id: string }> };
    expect(methods.methods.map((method) => method.id)).not.toContain('demo');
    expect((await app.request('/api/v1/ext/demo/ping')).status).toBe(404);
  });

  it('isolates a handler error', async () => {
    const { app, logs } = await setup([
      demoExtension((ctx) => {
        ctx.http.api.get('/boom', () => {
          throw new Error('handler exploded');
        });
      }),
    ]);
    const res = await app.request('/api/v1/ext/demo/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ message: 'EXTENSION_ERROR' });
    expect(logs.some((line) => line.msg === 'extension handler failed')).toBe(true);
    expect((await app.request('/api/v1/meta/instances')).status).toBe(200);
  });

  it('stops startup in strict mode', async () => {
    await expect(setup([demoExtension()], { strict: true, env: {} })).rejects.toThrow(/extension failed: demo: NAME/);
  });

  it('marks a failing start hook as degraded', async () => {
    const { app, host } = await setup([
      demoExtension((ctx) => {
        ctx.http.api.get('/ping', (c) => c.text('pong'));
        return {
          start: async () => {
            throw new Error('core not reachable');
          },
        };
      }),
    ]);
    await host!.start();
    expect(host!.records()[0]).toMatchObject({ status: 'degraded', reason: 'core not reachable' });
    const res = await app.request('/api/v1/ext/demo/ping');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pong');
  });

  it('runs stop hooks and ignores their errors', async () => {
    const stop = vi.fn().mockRejectedValue(new Error('stop failed'));
    const { host } = await setup([demoExtension(() => ({ stop }))]);
    await expect(host!.stop()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('lists a redirect-callback provider as a redirect method', async () => {
    const { app } = await setup([
      demoExtension((ctx) => {
        ctx.auth.registerProvider(demoProvider());
        ctx.web.advertise({ pages: [{ id: 'pending', visible_to: 'system_admin' }], loginMethodIds: ['demo'] });
      }),
    ]);
    const methods = (await (await app.request('/api/v1/auth/methods')).json()) as { methods: unknown[] };
    expect(methods.methods).toEqual([
      { id: 'user_key', type: 'user_key', display_name: 'user_key', enabled: true },
      {
        id: 'demo',
        type: 'redirect',
        display_name: 'Demo sign-in',
        enabled: true,
        login_url: '/ext/demo/login',
        logout_url: '/ext/demo/logout',
      },
    ]);
    const list = await app.request('/api/v1/extensions');
    expect(await list.json()).toEqual({
      extensions: [
        {
          id: 'demo',
          version: '1.2.3',
          status: 'active',
          web: { pages: [{ id: 'pending', visible_to: 'system_admin' }] },
          login_method_ids: ['demo'],
        },
      ],
    });
  });

  it('applies advertise calls made after registration', async () => {
    let context!: ExtensionContext<{ NAME: string }>;
    const { app } = await setup([
      demoExtension((ctx) => {
        context = ctx;
        ctx.web.advertise({ pages: [], loginMethodIds: [] });
      }),
    ]);
    context.web.advertise({ pages: [{ id: 'late', visible_to: 'all' }], loginMethodIds: ['demo'] });
    const list = (await (await app.request('/api/v1/extensions')).json()) as {
      extensions: Array<{ web: { pages: unknown[] }; login_method_ids: string[] }>;
    };
    expect(list.extensions[0].web.pages).toEqual([{ id: 'late', visible_to: 'all' }]);
    expect(list.extensions[0].login_method_ids).toEqual(['demo']);
  });

  it('fails an extension that tries to take a reserved provider id', async () => {
    const { host } = await setup([
      demoExtension((ctx) => {
        ctx.auth.registerProvider(demoProvider({ id: 'woa' }) as AuthProvider);
      }),
    ]);
    expect(host!.records()[0]).toMatchObject({ status: 'failed', reason: 'reserved auth provider id: woa' });
  });

  it('loads a required extension first and fails a dependent whose requirement failed', async () => {
    const order: string[] = [];
    const base = (id: string, requires: string[], schema: z.ZodTypeAny = z.object({})) =>
      ({
        id,
        version: '1',
        apiVersion: 1,
        displayName: id,
        requires,
        configSchema: schema,
        register: () => {
          order.push(id);
        },
      }) as PanelExtension<unknown>;

    const ok = await setup([base('b', ['a']), base('a', [])], { selected: ['b', 'a'], env: {} });
    expect(order).toEqual(['a', 'b']);
    expect(ok.host!.records().map((record) => [record.id, record.status])).toEqual([
      ['b', 'active'],
      ['a', 'active'],
    ]);

    const broken = await setup([base('b', ['a']), base('a', [], z.object({ X: z.string() }))], {
      selected: ['b', 'a'],
      env: {},
    });
    expect(broken.host!.records()[0]).toMatchObject({ id: 'b', status: 'failed', reason: 'missing required extension a' });

    const cycle = await setup([base('a', ['b']), base('b', ['a'])], { selected: ['a', 'b'], env: {} });
    expect(cycle.host!.records().every((record) => record.status === 'failed')).toBe(true);
  });

  it('refuses an unsupported api version', async () => {
    const { host } = await setup([demoExtension(undefined, { apiVersion: 2 as unknown as 1 })]);
    expect(host!.records()[0].status).toBe('failed');
  });

  it('mounts pages before the SPA fallback', async () => {
    const fixture = await createPanelFixture();
    fixtures.push(fixture);
    writeFileSync(join(fixture.root, 'dist', 'index.html'), '<!doctype html><title>spa</title>');
    fixture.deps.config.extensions = { enabled: ['demo'], dataDir: fixture.dataDir, strict: false };
    fixture.deps.extensions = createExtensionHost({
      deps: fixture.deps,
      catalog: [
        demoExtension((ctx) => {
          ctx.http.pages.get('/hello', (c) => c.html('<p>extension page</p>'));
        }),
      ],
      env: DEMO_ENV,
    });
    const { buildPanelApp } = await import('../../src/panel/http/app.js');
    const app = buildPanelApp(fixture.deps);
    const page = await app.request('/ext/demo/hello');
    expect(await page.text()).toBe('<p>extension page</p>');
    const other = await app.request('/ext/demo/elsewhere');
    expect(await other.text()).toContain('<title>spa</title>');
  });

  it('drops secret-looking audit fields', async () => {
    let context!: ExtensionContext<{ NAME: string }>;
    const { logs } = await setup([demoExtension((ctx) => void (context = ctx))]);
    context.audit('demo.x', {
      user_key: 'a',
      claim_token: 'b',
      key_id: 'k',
      ok: 1,
      ud: 'c',
      session_token: 'd',
      db_password: 'e',
    });
    const line = logs.find((entry) => entry.msg === 'audit')!;
    expect(line.fields).toEqual({ audit: true, ext: 'demo', event: 'demo.x', key_id: 'k', ok: 1 });
  });

  it('creates no data file until the first write', async () => {
    let context!: ExtensionContext<{ NAME: string }>;
    const { dataDir } = await setup([demoExtension((ctx) => void (context = ctx))]);
    const doc = context.storage.json('things', { version: 1 as const, items: [] as string[] });
    expect(existsSync(dataDir)).toBe(false);
    expect(doc.read().items).toEqual([]);

    await doc.update((current) => ({ ...current, items: ['one'] }));
    const file = join(dataDir, 'demo', 'things.json');
    expect(JSON.parse(readFileSync(file, 'utf8')).items).toEqual(['one']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, 'demo')).mode & 0o777).toBe(0o700);
    expect(doc.read().items).toEqual(['one']);
  });

  it('serializes concurrent updates and keeps the old state when a write fails', async () => {
    let context!: ExtensionContext<{ NAME: string }>;
    const { dataDir } = await setup([demoExtension((ctx) => void (context = ctx))]);
    const doc = context.storage.json('counter', { version: 1 as const, n: 0 });
    await Promise.all([1, 2, 3].map(() => doc.update((current) => ({ ...current, n: current.n + 1 }))));
    expect(doc.read().n).toBe(3);

    // A directory in place of the file makes the rename fail.
    const blocker = context.storage.json('blocked', { version: 1 as const, n: 0 });
    mkdirSync(join(dataDir, 'demo', 'blocked.json'));
    await expect(blocker.update((current) => ({ ...current, n: 9 }))).rejects.toThrow();
    expect(blocker.read().n).toBe(0);
    expect(() => context.storage.json('Bad Name', { version: 1 as const })).toThrow(/invalid extension data file name/);
  });

  it('shares one state between two opens of the same document', async () => {
    let context!: ExtensionContext<{ NAME: string }>;
    const { dataDir } = await setup([demoExtension((ctx) => void (context = ctx))]);
    const first = context.storage.json('shared', { version: 1 as const, items: [] as string[] });
    const second = context.storage.json('shared', { version: 1 as const, items: [] as string[] });
    await Promise.all([
      first.update((current) => ({ ...current, items: [...current.items, 'a'] })),
      second.update((current) => ({ ...current, items: [...current.items, 'b'] })),
      first.update((current) => ({ ...current, items: [...current.items, 'c'] })),
    ]);
    expect(first.read().items).toEqual(['a', 'b', 'c']);
    expect(second.read().items).toEqual(['a', 'b', 'c']);
    expect(JSON.parse(readFileSync(join(dataDir, 'demo', 'shared.json'), 'utf8')).items).toEqual(['a', 'b', 'c']);
  });

  it('refuses an unreadable data file', async () => {
    const fixture = await createPanelFixture();
    fixtures.push(fixture);
    const file = join(fixture.dataDir, 'demo', 'things.json');
    mkdirSync(join(fixture.dataDir, 'demo'), { recursive: true });
    writeFileSync(file, '{bad');
    fixture.deps.config.extensions = { enabled: ['demo'], dataDir: fixture.dataDir, strict: false };
    const host = createExtensionHost({
      deps: fixture.deps,
      catalog: [
        demoExtension((ctx) => {
          ctx.storage.json('things', { version: 1 as const });
        }),
      ],
      env: DEMO_ENV,
    })!;
    expect(host.records()[0]).toMatchObject({
      status: 'failed',
      reason: 'unreadable extension data file: things.json',
    });
    expect(readFileSync(file, 'utf8')).toBe('{bad');
  });

  it('refuses a data file with another version', async () => {
    const fixture = await createPanelFixture();
    fixtures.push(fixture);
    mkdirSync(join(fixture.dataDir, 'demo'), { recursive: true });
    writeFileSync(join(fixture.dataDir, 'demo', 'things.json'), JSON.stringify({ version: 2 }));
    fixture.deps.config.extensions = { enabled: ['demo'], dataDir: fixture.dataDir, strict: false };
    const host = createExtensionHost({
      deps: fixture.deps,
      catalog: [demoExtension((ctx) => void ctx.storage.json('things', { version: 1 as const }))],
      env: DEMO_ENV,
    })!;
    expect(host.records()[0].status).toBe('failed');
  });

  it('encrypts with the local secret', async () => {
    let context!: ExtensionContext<{ NAME: string }>;
    const { dataDir } = await setup([demoExtension((ctx) => void (context = ctx))]);
    expect(existsSync(join(dataDir, 'demo', '.secret'))).toBe(false);
    const cipher = context.secrets.encrypt('x');
    expect(cipher).not.toContain('x.');
    expect(context.secrets.decrypt(cipher)).toBe('x');
    expect(statSync(join(dataDir, 'demo', '.secret')).mode & 0o777).toBe(0o600);
  });

  it('rate limits per client', async () => {
    const { app } = await setup([
      demoExtension((ctx) => {
        const limiter = ctx.rateLimit('probe', { perMinute: 2 });
        ctx.http.api.get('/limited', (c) => (limiter.allow(c) ? c.text('ok') : c.text('slow down', 429)));
      }),
    ]);
    const call = (ip: string) => app.request('/api/v1/ext/demo/limited', { headers: { 'x-forwarded-for': ip } });
    expect((await call('10.0.0.1')).status).toBe(200);
    expect((await call('10.0.0.1')).status).toBe(200);
    expect((await call('10.0.0.1')).status).toBe(429);
    expect((await call('10.0.0.2')).status).toBe(200);
  });

  it('keys the limit on the address the trusted proxy appended', async () => {
    const { app } = await setup([
      demoExtension((ctx) => {
        const limiter = ctx.rateLimit('probe', { perMinute: 1 });
        ctx.http.api.get('/limited', (c) => (limiter.allow(c) ? c.text('ok') : c.text('slow down', 429)));
      }),
    ]);
    const call = (forwarded: string) =>
      app.request('/api/v1/ext/demo/limited', { headers: { 'x-forwarded-for': forwarded } });
    expect((await call('1.1.1.1, 10.0.0.9')).status).toBe(200);
    // A client that forges the left side still lands in the same bucket as its real address.
    expect((await call('2.2.2.2, 10.0.0.9')).status).toBe(429);
    expect((await call('1.1.1.1, 10.0.0.8')).status).toBe(200);
  });

  it('requires a system admin', async () => {
    const { app, deps } = await setup([
      demoExtension((ctx) => {
        ctx.http.api.get('/admin', async (c) => {
          const result = await ctx.auth.requireSystemAdmin(c);
          return result instanceof Response ? result : c.json(result);
        });
      }),
    ]);
    systemAdminKernel(deps);
    const call = (headers: Record<string, string>) => app.request('/api/v1/ext/demo/admin', { headers });

    expect((await call({})).status).toBe(400);
    expect((await call({ 'x-tdai-service-id': 'unknown' })).status).toBe(400);
    expect((await call({ 'x-tdai-service-id': 'default' })).status).toBe(401);
    expect((await call({ ...adminHeaders, 'x-tdai-user-key': 'sk-mem-test-wrong' })).status).toBe(401);
    expect((await call({ ...adminHeaders, 'x-tdai-user-key': 'sk-mem-test-member' })).status).toBe(403);
    const ok = await call(adminHeaders);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ userId: 'usr-admin', instanceId: 'default' });
  });

  it('creates a Panel session that the Panel then accepts, and destroys it', async () => {
    let context!: ExtensionContext<{ NAME: string }>;
    const { deps } = await setup([demoExtension((ctx) => void (context = ctx))], {
      settings: { PANEL_AUTH_SESSION_SECURE: 'true' },
    });
    expect(context.auth.cookieSecure).toBe(true);
    const { token, setCookie } = context.auth.createSession({
      instanceId: 'default',
      coreUserId: 'usr-1',
      userKey: 'sk-mem-test-0000000000000000000000000000',
      providerId: 'demo',
      externalSubject: 'subject-1',
    });
    expect(setCookie).toContain(`${deps.config.auth.sessionCookieName}=${token}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(deps.auth.resolveSession('default', token)?.coreUserId).toBe('usr-1');

    const probe = new Hono();
    probe.get('/out', (c) => {
      const { clearCookie, hadSessionCookie } = context.auth.destroySession(c);
      return c.text(`${hadSessionCookie}|${clearCookie}`);
    });
    const res = await probe.request('/out', { headers: { cookie: `${deps.config.auth.sessionCookieName}=${token}` } });
    const text = await res.text();
    expect(text.startsWith('true|')).toBe(true);
    expect(text).toContain('Max-Age=0');
    expect(deps.auth.resolveSession('default', token)).toBeNull();
    expect((await (await probe.request('/out')).text()).startsWith('false|')).toBe(true);
  });

  it('exposes instances', async () => {
    let context!: ExtensionContext<{ NAME: string }>;
    await setup([demoExtension((ctx) => void (context = ctx))]);
    expect(context.instances.list()).toEqual([{ instance_id: 'default', name: 'Test' }]);
    expect(context.instances.resolveDefault()).toBe('default');
    expect(context.instances.has('default')).toBe(true);
    expect(context.instances.has('other')).toBe(false);
  });
});
