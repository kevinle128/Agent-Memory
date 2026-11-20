import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceStore, WEB_INSTALL_ID, type DeviceFile } from '../../../src/extensions/vtc/device/device-store.js';
import { KeyIssuer, KeyLimitError } from '../../../src/extensions/vtc/device/key-issuer.js';
import { createJsonStorage } from '../../../src/panel/extensions/json-store.js';
import { createLocalSecrets } from '../../../src/panel/extensions/local-secret.js';
import { createMetaFacade } from '../../../src/panel/extensions/meta-facade.js';
import { createPanelFixture, type PanelFixture } from '../support/panel-fixture.js';
import { createFakeCore } from './fake-core.js';

const fixtures: PanelFixture[] = [];
// The fake Core reads the key cap from the environment; the tests assume Core's default.
beforeEach(() => {
  vi.stubEnv('TDAI_USER_KEY_MAX_ACTIVE', '20');
});

afterEach(() => {
  vi.unstubAllEnvs();
  while (fixtures.length) fixtures.pop()!.cleanup();
});

const DAY = 86_400_000;

async function setup() {
  const fixture = await createPanelFixture();
  fixtures.push(fixture);
  const clock = { now: new Date('2026-11-20T02:00:00.000Z') };
  const core = createFakeCore({ now: () => clock.now });
  core.seedAdmin();
  core.install(fixture.deps);
  const meta = createMetaFacade(fixture.deps);
  const dir = join(fixture.root, 'ext');
  const devices = new DeviceStore(createJsonStorage(dir).json<DeviceFile>('devices', { version: 1, devices: [] }));
  const audit = vi.fn();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const secrets = createLocalSecrets(dir);
  const issuer = (s = secrets) =>
    new KeyIssuer({ meta, devices, secrets: s, audit, logger, keyTtlDays: 7, now: () => clock.now });
  const user = core.seedUser({ username: 'one' });
  return { clock, core, meta, devices, audit, logger, dir, secrets, issuer, user };
}

const actions = (core: ReturnType<typeof createFakeCore>) => core.calls.map((c) => c.action);

describe('key issuer', () => {
  it('creates one web key on the first login', async () => {
    const { core, issuer, devices, dir, user } = await setup();
    const issued = await issuer().issueWebKey('default', user.user_id);

    const created = core.calls.filter((c) => c.action === 'user-key/create');
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toMatchObject({ user_id: user.user_id, name: 'panel-web', expires_at: '2026-11-27T02:00:00.000Z' });
    expect(issued.expiresAt).toBe('2026-11-27T02:00:00.000Z');
    expect(issued.userKey).toMatch(/^sk-mem-test-/);

    const row = devices.find('default', user.user_id, WEB_INSTALL_ID)!;
    expect(row).toMatchObject({ keyId: issued.keyId, expiresAt: issued.expiresAt });
    expect(row.encryptedKey).toBeTruthy();
    expect(readFileSync(join(dir, 'devices.json'), 'utf8')).not.toContain(issued.userKey);
  });

  it('renews the same web key on the next login', async () => {
    const { core, clock, issuer, user, audit } = await setup();
    const first = await issuer().issueWebKey('default', user.user_id);
    clock.now = new Date(clock.now.getTime() + 2 * DAY);
    const second = await issuer().issueWebKey('default', user.user_id);

    expect(second.keyId).toBe(first.keyId);
    expect(second.userKey).toBe(first.userKey);
    expect(second.expiresAt).toBe('2026-11-29T02:00:00.000Z');
    expect(actions(core).filter((a) => a === 'user-key/create')).toHaveLength(1);
    const update = core.calls.find((c) => c.action === 'user-key/update')!;
    expect(update.body).toEqual({ key_id: first.keyId, expires_at: '2026-11-29T02:00:00.000Z' });
    expect(audit.mock.calls.filter((c) => c[0] === 'vtc.key.issued')).toHaveLength(1);
  });

  it('creates then revokes when the stored key was revoked', async () => {
    const { core, issuer, user } = await setup();
    const first = await issuer().issueWebKey('default', user.user_id);
    core.keysOf(user.user_id).find((k) => k.key_id === first.keyId)!.status = 'revoked';
    core.calls.length = 0;

    const second = await issuer().issueWebKey('default', user.user_id);
    expect(second.keyId).not.toBe(first.keyId);
    const order = actions(core);
    expect(order.indexOf('user-key/create')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('user-key/create')).toBeLessThan(order.indexOf('user-key/revoke'));
  });

  it('creates then revokes when the local secret cannot decrypt the value', async () => {
    const { core, issuer, user, dir } = await setup();
    const first = await issuer().issueWebKey('default', user.user_id);
    // A new local secret models a lost or replaced secret file.
    rmSync(join(dir, '.secret'));
    core.calls.length = 0;

    const second = await issuer(createLocalSecrets(dir)).issueWebKey('default', user.user_id);
    expect(second.keyId).not.toBe(first.keyId);
    const order = actions(core);
    expect(order.indexOf('user-key/create')).toBeLessThan(order.indexOf('user-key/revoke'));
    const keys = core.keysOf(user.user_id);
    expect(keys.find((k) => k.key_id === first.keyId)!.status).toBe('revoked');
    expect(keys.find((k) => k.key_id === second.keyId)!.status).toBe('active');
  });

  it('prunes expired tracked keys before a create', async () => {
    const { core, meta, issuer, devices, user, clock } = await setup();
    const expired = await meta.keys.create('default', user.user_id, { name: 'laptop', expiresAt: new Date(clock.now.getTime() - DAY) });
    const live = await meta.keys.create('default', user.user_id, { name: 'phone', expiresAt: new Date(clock.now.getTime() + DAY) });
    const row = { instanceId: 'default', coreUserId: user.user_id, deviceName: 'x', lastLoginAt: clock.now.toISOString() };
    await devices.upsert({ ...row, installId: 'laptop', keyId: expired.key_id, expiresAt: new Date(clock.now.getTime() - DAY).toISOString() });
    await devices.upsert({ ...row, installId: 'phone', keyId: live.key_id, expiresAt: new Date(clock.now.getTime() + DAY).toISOString() });

    core.calls.length = 0;
    await issuer().issueWebKey('default', user.user_id);

    const keys = core.keysOf(user.user_id);
    expect(keys.find((k) => k.key_id === expired.key_id)!.status).toBe('revoked');
    expect(keys.find((k) => k.key_id === live.key_id)!.status).toBe('active');
    expect(devices.find('default', user.user_id, 'laptop')).toBeNull();
    expect(devices.find('default', user.user_id, 'phone')).not.toBeNull();
    const order = actions(core);
    // Pruning runs first, so the cap never counts a key that has already run out.
    expect(order.indexOf('user-key/revoke')).toBeLessThan(order.indexOf('user-key/create'));
  });

  it('reads the active key cap from the environment the way Core does', async () => {
    vi.stubEnv('TDAI_USER_KEY_MAX_ACTIVE', '3');
    const { core, meta, user } = await setup();
    core.addKeys(user.user_id, 1);
    const expiresAt = new Date(Date.now() + DAY);
    await meta.keys.create('default', user.user_id, { name: 'third', expiresAt });
    await expect(meta.keys.create('default', user.user_id, { name: 'fourth', expiresAt })).rejects.toMatchObject({
      code: 'key_limit_exceeded',
    });
  });

  it('refuses to revoke a key when one active key is left, even an already revoked one', async () => {
    const { core, meta, user } = await setup();
    const created = await meta.keys.create('default', user.user_id, { name: 'extra', expiresAt: new Date(Date.now() + DAY) });
    await meta.keys.revoke('default', created.key_id);
    await expect(meta.keys.revoke('default', created.key_id)).rejects.toMatchObject({ code: 'last_key_cannot_revoke' });
    expect(core.keysOf(user.user_id).filter((k) => k.status === 'active')).toHaveLength(1);
  });

  it('issues one key when two logins of the same user arrive together', async () => {
    const { core, issuer, user } = await setup();
    const both = issuer();
    const [a, b] = await Promise.all([both.issueWebKey('default', user.user_id), both.issueWebKey('default', user.user_id)]);
    expect(b.keyId).toBe(a.keyId);
    expect(b.userKey).toBe(a.userKey);
    expect(actions(core).filter((x) => x === 'user-key/create')).toHaveLength(1);
    expect(core.keysOf(user.user_id).filter((k) => !k.isDefault)).toHaveLength(1);
  });

  it('reports the key limit', async () => {
    const { core, meta, issuer, audit, user, clock } = await setup();
    // The default key plus 19 others fill Core's cap of 20.
    for (let i = 0; i < 19; i += 1) {
      await meta.keys.create('default', user.user_id, { name: `k${i}`, expiresAt: new Date(clock.now.getTime() + DAY) });
    }
    await expect(issuer().issueWebKey('default', user.user_id)).rejects.toBeInstanceOf(KeyLimitError);
    expect(audit).toHaveBeenCalledWith('vtc.key.limit_exceeded', { core_user_id: user.user_id });
    expect(core.keysOf(user.user_id).filter((k) => k.status === 'active')).toHaveLength(20);
  });

  it('never touches the default key', async () => {
    const { core, clock, issuer, user } = await setup();
    await issuer().issueWebKey('default', user.user_id);
    clock.now = new Date(clock.now.getTime() + DAY);
    await issuer().issueWebKey('default', user.user_id);
    const defaultKey = core.keysOf(user.user_id).find((k) => k.isDefault)!;
    expect(defaultKey.status).toBe('active');
    expect(core.calls.some((c) => c.body.key_id === defaultKey.key_id)).toBe(false);
    expect(JSON.stringify(core.calls.filter((c) => c.action.startsWith('user-key/')).map((c) => c.body))).not.toContain(defaultKey.key_value);
  });

  it('does not log key values', async () => {
    const { logger, audit, issuer, user } = await setup();
    const issued = await issuer().issueWebKey('default', user.user_id);
    expect(JSON.stringify([logger.warn.mock.calls, logger.info.mock.calls, audit.mock.calls])).not.toContain(issued.userKey);
  });

  it('removes the new key when it cannot be recorded', async () => {
    const { core, devices, issuer, user } = await setup();
    vi.spyOn(devices, 'upsert').mockRejectedValue(new Error('disk full'));
    await expect(issuer().issueWebKey('default', user.user_id)).rejects.toThrow('disk full');
    const tracked = core.keysOf(user.user_id).filter((k) => !k.isDefault);
    expect(tracked.every((k) => k.status === 'revoked')).toBe(true);
  });
});
