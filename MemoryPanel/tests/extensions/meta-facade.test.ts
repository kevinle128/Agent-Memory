import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMetaFacade } from '../../src/panel/extensions/meta-facade.js';
import { FetchKernelHttpAdapter } from '../../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';
import { FetchMetaKernelAdapter } from '../../src/panel/kernel/adapters/fetch-meta-kernel-adapter.js';
import { MetaError } from '../../src/panel/extensions/types.js';
import { createPanelFixture, stubMetaKernel, type PanelFixture } from './support/panel-fixture.js';

const fixtures: PanelFixture[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  while (fixtures.length) fixtures.pop()!.cleanup();
});

async function setup() {
  const fixture = await createPanelFixture();
  fixtures.push(fixture);
  return fixture;
}

const ok = (data: unknown) => ({ code: 0, message: 'ok', request_id: '', data });
const fail = (message: string, code = 400) => ({ code, message, request_id: '', data: null });

describe('meta facade', () => {
  it('uses the instance api key as the user key', async () => {
    const { deps } = await setup();
    const invoke = stubMetaKernel(deps, () => ({ data: { user_id: 'usr-1', username: 'one' } }));
    await createMetaFacade(deps).users.get('default', 'usr-1');
    expect(invoke).toHaveBeenCalledWith(
      'user/get',
      { user_id: 'usr-1' },
      expect.objectContaining({
        instanceId: 'default',
        gatewayEndpoint: 'http://127.0.0.1:1',
        gatewayApiKey: 'test-gateway-key-not-real',
        userKey: 'test-gateway-key-not-real',
      }),
    );
  });

  it('uses the separate system user key as the user key and keeps the api key as the gateway key', async () => {
    const { deps } = await setup();
    deps.config.extensions = { ...deps.config.extensions, systemUserKey: 'test-system-user-key-not-real' };
    const invoke = stubMetaKernel(deps, () => ({ data: { user_id: 'usr-1', username: 'one' } }));
    await createMetaFacade(deps).users.get('default', 'usr-1');
    expect(invoke).toHaveBeenCalledWith(
      'user/get',
      { user_id: 'usr-1' },
      expect.objectContaining({
        gatewayApiKey: 'test-gateway-key-not-real',
        userKey: 'test-system-user-key-not-real',
      }),
    );
  });

  it('falls back to the api key when the separate system user key is blank', async () => {
    const { deps } = await setup();
    deps.config.extensions = { ...deps.config.extensions, systemUserKey: '  ' };
    const invoke = stubMetaKernel(deps, () => ({ data: { user_id: 'usr-1', username: 'one' } }));
    await createMetaFacade(deps).users.get('default', 'usr-1');
    expect(invoke).toHaveBeenCalledWith(
      'user/get',
      { user_id: 'usr-1' },
      expect.objectContaining({ userKey: 'test-gateway-key-not-real' }),
    );
  });

  it('rejects an unknown instance', async () => {
    const { deps } = await setup();
    stubMetaKernel(deps, () => ({ data: {} }));
    await expect(createMetaFacade(deps).users.get('nowhere', 'usr-1')).rejects.toMatchObject({
      code: 'invalid_instance',
    });
  });

  it('maps a Core error message to a MetaError code', async () => {
    const { deps } = await setup();
    stubMetaKernel(deps, () => fail('key_limit_exceeded: active user key limit 20 reached'));
    const facade = createMetaFacade(deps);
    const error = await facade.keys
      .create('default', 'usr-1', { name: 'n', expiresAt: new Date() })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MetaError);
    expect(error).toMatchObject({ code: 'key_limit_exceeded' });

    stubMetaKernel(deps, () => fail('something without a code', 500));
    await expect(facade.keys.revoke('default', 'key-1')).rejects.toMatchObject({ code: 'kernel_error' });
  });

  it('drops the default user key from user/create', async () => {
    const { deps } = await setup();
    stubMetaKernel(deps, () => ({
      data: { user_id: 'usr-9', default_user_key: { key_value: 'sk-mem-test-0000000000000000000000000000' } },
    }));
    const created = await createMetaFacade(deps).users.create('default', {
      username: 'nine',
      external_id: '10482',
      auth_provider: 'vtc',
    });
    expect(created).toEqual({ user_id: 'usr-9' });
    expect(JSON.stringify(created)).not.toContain('sk-mem-test');
  });

  it('maps only allowed user fields from list-by-instance and pages until a short page', async () => {
    const { deps } = await setup();
    const row = (index: number) => ({
      user_id: `usr-${index}`,
      username: `user${index}`,
      user_type: 'user',
      email: `u${index}@vtc.vn`,
      display_name: null,
      auth_provider: 'vtc',
      external_id: String(index),
      status: 'active',
      password: '$scrypt$x',
      raw_profile_json: '{"private":true}',
    });
    const postEnvelope = vi
      .fn()
      .mockResolvedValueOnce(ok({ items: Array.from({ length: 100 }, (_, i) => row(i)) }))
      .mockResolvedValueOnce(ok({ items: [row(100)] }));
    deps.kernelHttp = { postEnvelope } as unknown as typeof deps.kernelHttp;

    const users = await createMetaFacade(deps).users.listAllDetailed('default');
    expect(users).toHaveLength(101);
    expect(users[0]).toEqual({
      user_id: 'usr-0',
      username: 'user0',
      user_type: 'user',
      email: 'u0@vtc.vn',
      display_name: null,
      auth_provider: 'vtc',
      external_id: '0',
      status: 'active',
    });
    expect(JSON.stringify(users)).not.toMatch(/scrypt|raw_profile/);
    expect(postEnvelope).toHaveBeenCalledTimes(2);
    const [path, body, credentials] = postEnvelope.mock.calls[0];
    expect(path).toBe('/v3/internal/meta/user/list-by-instance');
    expect(body).toEqual({ instance_id: 'default', limit: 100, offset: 0 });
    expect(credentials).toMatchObject({ apiKey: 'test-gateway-key-not-real', userKey: undefined });
    expect(postEnvelope.mock.calls[1][1]).toEqual({ instance_id: 'default', limit: 100, offset: 100 });
  });

  it('stops paging at the row limit', async () => {
    const { deps } = await setup();
    const page = ok({ items: Array.from({ length: 100 }, (_, i) => ({ user_id: `usr-${i}`, username: 'x' })) });
    const postEnvelope = vi.fn().mockResolvedValue(page);
    deps.kernelHttp = { postEnvelope } as unknown as typeof deps.kernelHttp;
    const users = await createMetaFacade(deps).users.listAllDetailed('default');
    expect(users).toHaveLength(5000);
    expect(postEnvelope).toHaveBeenCalledTimes(50);
  });

  it('sends expires_at as ISO 8601 UTC', async () => {
    const { deps } = await setup();
    const invoke = stubMetaKernel(deps, (action) =>
      action === 'user-key/create' ? { data: { key_id: 'key-1', key_value: 'sk-mem-test-1', expires_at: null } } : {},
    );
    const facade = createMetaFacade(deps);
    const expiresAt = new Date('2026-11-27T01:02:03.456Z');
    await facade.keys.create('default', 'usr-1', { name: 'x'.repeat(200), expiresAt });
    await facade.keys.update('default', 'key-1', { expiresAt });
    expect(invoke.mock.calls[0][1]).toEqual({
      user_id: 'usr-1',
      name: 'x'.repeat(128),
      expires_at: '2026-11-27T01:02:03.456Z',
    });
    expect(invoke.mock.calls[1][1]).toEqual({ key_id: 'key-1', expires_at: '2026-11-27T01:02:03.456Z' });
  });

  it('treats member_already_exists as success', async () => {
    const { deps } = await setup();
    const invoke = stubMetaKernel(deps, () => fail('member_already_exists: user is already a member'));
    await expect(createMetaFacade(deps).members.add('default', 'team-1', 'usr-1', 'member')).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('team-member/add');

    stubMetaKernel(deps, () => fail('team_not_found: no such team', 404));
    await expect(createMetaFacade(deps).members.add('default', 'team-x', 'usr-1', 'member')).rejects.toMatchObject({
      code: 'team_not_found',
    });
  });

  it('awaits default agent provisioning and reports the result', async () => {
    const { deps } = await setup();
    let created = false;
    const calls: string[] = [];
    // Default skills import runs after the agent exists; keep it off the network.
    deps.skillKernel = {
      invoke: vi.fn(async () => ({ code: 0, message: 'ok', request_id: '', data: {} })),
    } as unknown as typeof deps.skillKernel;
    stubMetaKernel(deps, async (action) => {
      calls.push(action);
      if (action === 'user/get') return { data: { user_id: 'usr-1', username: 'one' } };
      if (action === 'agent/list') {
        return { data: { items: created ? [{ agent_id: 'ag-1', name: 'default-agent-one' }] : [] } };
      }
      if (action === 'agent/create') {
        await new Promise((resolve) => setTimeout(resolve, 30));
        created = true;
        return { data: { agent_id: 'ag-1' } };
      }
      return { data: { items: [] } };
    });
    const result = await createMetaFacade(deps).members.provisionDefaults('default', 'team-1', 'usr-1');
    expect(created).toBe(true);
    expect(result).toBe(true);
    expect(calls.indexOf('agent/create')).toBeLessThan(calls.lastIndexOf('agent/list'));
  });

  it('never throws from provisioning', async () => {
    const { deps, logs } = await setup();
    stubMetaKernel(deps, () => {
      throw new Error('network down');
    });
    await expect(createMetaFacade(deps).members.provisionDefaults('default', 'team-1', 'usr-1')).resolves.toBe(false);
    expect(logs.some((line) => line.level === 'warn' && line.msg === 'default agent provisioning failed')).toBe(true);
  });

  it('returns null for not found', async () => {
    const { deps } = await setup();
    stubMetaKernel(deps, (action) => {
      if (action === 'user/find-by-external') return fail('user_not_found: no user', 404);
      return fail(`${action.split('/')[0].replace('-', '_')}_not_found: missing`, 404);
    });
    const facade = createMetaFacade(deps);
    expect(await facade.users.get('default', 'usr-x')).toBeNull();
    expect(await facade.members.get('default', 'team-1', 'usr-x')).toBeNull();
    expect(await facade.keys.get('default', 'key-x')).toBeNull();
    expect(await facade.teams.get('default', 'team-x')).toBeNull();
    expect(await facade.users.findByExternal('default', 'vtc', '1')).toBeNull();
  });

  it('maps lists and lookups', async () => {
    const { deps } = await setup();
    const invoke = stubMetaKernel(deps, (action) => {
      switch (action) {
        case 'user/list':
          return { data: { items: [{ user_id: 'usr-1', username: 'one', user_type: 'user', extra: 'x' }] } };
        case 'team/list':
          return { data: { total: 3, items: [{ team_id: 't1', name: 'Team', owner_user_id: 'usr-9' }] } };
        case 'team-member/get':
          return { data: { role: 'admin', status: 'active', user_id: 'usr-1' } };
        case 'agent/list':
          return { data: { items: [{ agent_id: 'ag-1', name: 'a', prompt: 'private' }] } };
        case 'auth/verify':
          return { data: { valid: true, user: { user_id: 'usr-1', user_type: 'user', password: 'x' } } };
        default:
          return { data: {} };
      }
    });
    const facade = createMetaFacade(deps);
    expect(await facade.users.listByUsername('default', 'one')).toEqual([
      { user_id: 'usr-1', username: 'one', user_type: 'user' },
    ]);
    expect(await facade.teams.listForUser('default', 'usr-1')).toEqual({
      total: 3,
      items: [{ team_id: 't1', name: 'Team' }],
    });
    expect(await facade.members.get('default', 't1', 'usr-1')).toEqual({ role: 'admin', status: 'active' });
    expect(await facade.agents.listOwned('default', 't1', 'usr-1')).toEqual([{ agent_id: 'ag-1', name: 'a' }]);
    expect(await facade.auth.verify('default', 'sk-mem-test-user')).toEqual({ user_id: 'usr-1', user_type: 'user' });
    expect(invoke.mock.calls.find((call) => call[0] === 'user/list')![1]).toEqual({
      username: 'one',
      limit: 100,
      offset: 0,
    });
    expect(invoke.mock.calls.find((call) => call[0] === 'agent/list')![1]).toMatchObject({
      team_id: 't1',
      owner_user_id: 'usr-1',
      status: 'active',
    });
  });

  it('verifies that the instance key is a system admin key', async () => {
    const { deps } = await setup();
    stubMetaKernel(deps, () => ({ data: { valid: true, user: { user_id: 'usr-a', user_type: 'system_admin' } } }));
    expect(await createMetaFacade(deps).system.verify('default')).toBe(true);
    stubMetaKernel(deps, () => ({ data: { valid: true, user: { user_id: 'usr-a', user_type: 'user' } } }));
    expect(await createMetaFacade(deps).system.verify('default')).toBe(false);
    stubMetaKernel(deps, () => {
      throw new Error('network down');
    });
    expect(await createMetaFacade(deps).system.verify('default')).toBe(false);
  });

  it('verifies the separate system user key, not the api key, when it is set', async () => {
    const { deps } = await setup();
    deps.config.extensions = { ...deps.config.extensions, systemUserKey: 'test-system-user-key-not-real' };
    const seen: unknown[] = [];
    stubMetaKernel(deps, (_action, body) => {
      seen.push(body);
      return { data: { valid: true, user: { user_id: 'usr-a', user_type: 'system_admin' } } };
    });
    expect(await createMetaFacade(deps).system.verify('default')).toBe(true);
    expect(JSON.stringify(seen)).toContain('test-system-user-key-not-real');
    expect(JSON.stringify(seen)).not.toContain('test-gateway-key-not-real');
  });

  it('fails when a success reply lacks the user id or the key', async () => {
    const { deps } = await setup();
    const facade = createMetaFacade(deps);
    stubMetaKernel(deps, () => ({ data: {} }));
    await expect(
      facade.users.create('default', { username: 'one', external_id: '1', auth_provider: 'vtc' }),
    ).rejects.toMatchObject({ code: 'kernel_error' });
    await expect(facade.keys.create('default', 'usr-1', { name: 'n', expiresAt: new Date() })).rejects.toMatchObject({
      code: 'kernel_error',
    });
    stubMetaKernel(deps, () => ({ data: { key_id: 'key-1' } }));
    await expect(facade.keys.create('default', 'usr-1', { name: 'n', expiresAt: new Date() })).rejects.toMatchObject({
      code: 'kernel_error',
    });
    stubMetaKernel(deps, () => ({ data: { user_id: 'usr-1' } }));
    await expect(
      facade.users.create('default', { username: 'one', external_id: '1', auth_provider: 'vtc' }),
    ).resolves.toEqual({ user_id: 'usr-1' });
  });

  describe('logging', () => {
    const EMAIL = 'someone.private@vtc.vn';

    async function withRealTransport() {
      const fixture = await setup();
      const lines: string[] = [];
      const logger = {
        debug: (msg: string, fields?: unknown) => lines.push(`${msg} ${JSON.stringify(fields)}`),
        info: (msg: string, fields?: unknown) => lines.push(`${msg} ${JSON.stringify(fields)}`),
        warn: (msg: string, fields?: unknown) => lines.push(`${msg} ${JSON.stringify(fields)}`),
        error: (msg: string, fields?: unknown) => lines.push(`${msg} ${JSON.stringify(fields)}`),
        child: () => logger,
      };
      const kernelHttp = new FetchKernelHttpAdapter(logger);
      fixture.deps.kernelHttp = kernelHttp;
      fixture.deps.metaKernel = new FetchMetaKernelAdapter(kernelHttp, 1000);
      const profile = {
        user_id: 'usr-1',
        username: 'one',
        email: EMAIL,
        display_name: 'Someone Private',
        external_id: '1',
        auth_provider: 'vtc',
        status: 'active',
        valid: true,
        user: { user_id: 'usr-1', email: EMAIL, user_type: 'user' },
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const data = url.includes('list-by-instance') || url.includes('user/') || url.includes('auth/') ? profile : {};
          const payload = url.includes('list-by-instance') ? { items: [profile] } : { ...data, items: [] };
          return new Response(JSON.stringify({ code: 0, message: 'ok', request_id: 'r', data: payload }), {
            headers: { 'content-type': 'application/json' },
          });
        }),
      );
      return { facade: createMetaFacade(fixture.deps), lines };
    }

    it('keeps profile fields out of the logs for calls that return them', async () => {
      const { facade, lines } = await withRealTransport();
      await facade.users.listAllDetailed('default');
      await facade.users.get('default', 'usr-1');
      await facade.users.findByExternal('default', 'vtc', '1');
      await facade.users.create('default', {
        username: 'one',
        external_id: '1',
        auth_provider: 'vtc',
        email: EMAIL,
        display_name: 'Someone Private',
      });
      await facade.auth.verify('default', 'sk-mem-test-0000000000000000000000000000');
      await facade.system.verify('default');
      await facade.users.listByUsername('default', 'quiet-user-name');
      expect(lines.join('\n')).not.toMatch(/someone\.private|Someone Private|sk-mem-test|quiet-user-name/);
    });

    it('still logs the bodies of other calls', async () => {
      const { facade, lines } = await withRealTransport();
      await facade.keys.get('default', 'key-1');
      const text = lines.join('\n');
      expect(text).toContain('api.remote.request');
      expect(text).toContain('api.remote.response');
      expect(text).toContain('requestBody');
    });
  });
});
