import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceRequest } from '../../../src/extensions/vtc/device/device-flow.js';
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
const MAC: DeviceRequest = { installId: 'install-mac-01', deviceName: 'Paseo on Mac', hasKey: false };

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
  const issuer = new KeyIssuer({
    meta,
    devices,
    secrets: createLocalSecrets(dir),
    audit,
    logger,
    keyTtlDays: 7,
    now: () => clock.now,
  });
  const user = core.seedUser({ username: 'one' });
  return { clock, core, meta, devices, audit, dir, issuer, user };
}

const actions = (core: ReturnType<typeof createFakeCore>) => core.calls.map((c) => c.action);

describe('device keys', () => {
  it('creates a key for an unknown device', async () => {
    const { core, issuer, devices, dir, user } = await setup();
    const issued = await issuer.issueDeviceKey('default', user.user_id, MAC);
    if (issued.renewed) throw new Error('expected a new key');

    const created = core.calls.filter((c) => c.action === 'user-key/create');
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toMatchObject({ user_id: user.user_id, name: 'paseo:Paseo on Mac', expires_at: '2026-11-27T02:00:00.000Z' });
    expect(issued.expires_at).toBe('2026-11-27T02:00:00.000Z');
    expect(issued.key_value).toMatch(/^sk-mem-test-/);

    const row = devices.find('default', user.user_id, MAC.installId)!;
    expect(row).toMatchObject({ keyId: issued.key_id, deviceName: 'Paseo on Mac', expiresAt: issued.expires_at });
    expect(row.encryptedKey).toBeUndefined();
    expect(readFileSync(join(dir, 'devices.json'), 'utf8')).not.toContain(issued.key_value);
  });

  it('renews the same key on the same device without returning a value', async () => {
    const { core, clock, issuer, devices, user } = await setup();
    const first = await issuer.issueDeviceKey('default', user.user_id, MAC);
    clock.now = new Date(clock.now.getTime() + 3 * DAY);
    const second = await issuer.issueDeviceKey('default', user.user_id, { ...MAC, hasKey: true, deviceName: 'Mac renamed' });

    expect(second).toEqual({ renewed: true, key_id: first.key_id, expires_at: '2026-11-30T02:00:00.000Z' });
    expect(second).not.toHaveProperty('key_value');
    expect(actions(core).filter((a) => a === 'user-key/create')).toHaveLength(1);
    expect(core.keysOf(user.user_id).filter((k) => k.name.startsWith('paseo:'))).toHaveLength(1);
    expect(core.calls.find((c) => c.action === 'user-key/update')!.body).toEqual({
      key_id: first.key_id,
      expires_at: '2026-11-30T02:00:00.000Z',
    });
    expect(devices.find('default', user.user_id, MAC.installId)).toMatchObject({ deviceName: 'Mac renamed', expiresAt: second.expires_at });
  });

  it('replaces the key after a reinstall: create first, revoke second', async () => {
    const { core, issuer, devices, user } = await setup();
    const first = await issuer.issueDeviceKey('default', user.user_id, MAC);
    core.calls.length = 0;
    const second = await issuer.issueDeviceKey('default', user.user_id, MAC);
    if (second.renewed) throw new Error('expected a new key');

    expect(second.key_id).not.toBe(first.key_id);
    const order = actions(core).filter((a) => a === 'user-key/create' || a === 'user-key/revoke');
    expect(order).toEqual(['user-key/create', 'user-key/revoke']);
    expect(core.calls.find((c) => c.action === 'user-key/revoke')!.body).toEqual({ key_id: first.key_id });
    expect(core.keysOf(user.user_id).find((k) => k.key_id === first.key_id)!.status).toBe('revoked');
    expect(devices.find('default', user.user_id, MAC.installId)!.keyId).toBe(second.key_id);
  });

  it('replaces a key that was revoked in Core even if the device says it has one', async () => {
    const { core, meta, issuer, user } = await setup();
    const first = await issuer.issueDeviceKey('default', user.user_id, MAC);
    await meta.keys.revoke('default', first.key_id);
    const again = await issuer.issueDeviceKey('default', user.user_id, { ...MAC, hasKey: true });

    expect(again.renewed).toBe(false);
    expect(again.key_id).not.toBe(first.key_id);
    expect(actions(core).filter((a) => a === 'user-key/create')).toHaveLength(2);
  });

  it('renews nothing for a device that has no row even if it says it has a key', async () => {
    const { issuer, user } = await setup();
    const issued = await issuer.issueDeviceKey('default', user.user_id, { ...MAC, hasKey: true });
    expect(issued.renewed).toBe(false);
  });

  it('prunes expired keys of other devices before a create and leaves the current device alone', async () => {
    const { core, clock, issuer, devices, user } = await setup();
    const old = await issuer.issueDeviceKey('default', user.user_id, { ...MAC, installId: 'install-old-01' });
    clock.now = new Date(clock.now.getTime() + 8 * DAY);
    const web = await issuer.issueWebKey('default', user.user_id);
    const current = await issuer.issueDeviceKey('default', user.user_id, MAC);

    expect(core.keysOf(user.user_id).find((k) => k.key_id === old.key_id)!.status).toBe('revoked');
    expect(devices.find('default', user.user_id, 'install-old-01')).toBeNull();
    expect(devices.find('default', user.user_id, WEB_INSTALL_ID)!.keyId).toBe(web.keyId);
    expect(devices.find('default', user.user_id, MAC.installId)!.keyId).toBe(current.key_id);
  });

  it('prunes the dead key of the same device before a create at the key cap', async () => {
    const { core, issuer, devices, user } = await setup();
    const first = await issuer.issueDeviceKey('default', user.user_id, MAC);
    if (first.renewed) throw new Error('expected a new key');
    // The seeded default key and the device key are active too: 1 + 1 + 18 reaches the cap of 20.
    core.addKeys(user.user_id, 18);
    expect(await issuer.expireDeviceKey('default', first.key_value, MAC.installId)).toBe('ok');

    // Logged out, the device logs in again: its dead key still counts in Core until it is revoked.
    const again = await issuer.issueDeviceKey('default', user.user_id, MAC);
    expect(again.renewed).toBe(false);
    expect(core.keysOf(user.user_id).find((k) => k.key_id === first.key_id)!.status).toBe('revoked');
    expect(devices.find('default', user.user_id, MAC.installId)!.keyId).toBe(again.key_id);
  });

  it('reports the key limit', async () => {
    const { core, issuer, audit, user } = await setup();
    core.addKeys(user.user_id, 19);
    await expect(issuer.issueDeviceKey('default', user.user_id, MAC)).rejects.toBeInstanceOf(KeyLimitError);
    expect(audit).toHaveBeenCalledWith('vtc.key.limit_exceeded', { core_user_id: user.user_id });
  });

  it('never makes two keys for two logins of one device at once', async () => {
    const { core, issuer, user } = await setup();
    const results = await Promise.all([
      issuer.issueDeviceKey('default', user.user_id, MAC),
      issuer.issueDeviceKey('default', user.user_id, MAC),
    ]);
    const active = core.keysOf(user.user_id).filter((k) => k.name.startsWith('paseo:') && k.status === 'active');
    expect(active).toHaveLength(1);
    expect(results.map((r) => r.key_id)).toContain(active[0]!.key_id);
  });

  it('refuses the reserved web install id', async () => {
    const { issuer, user } = await setup();
    await expect(issuer.issueDeviceKey('default', user.user_id, { ...MAC, installId: WEB_INSTALL_ID })).rejects.toThrow();
  });

  it('expires the device key at logout without revoking it', async () => {
    const { core, clock, meta, issuer, devices, audit, user } = await setup();
    const issued = await issuer.issueDeviceKey('default', user.user_id, MAC);
    if (issued.renewed) throw new Error('expected a new key');
    expect(await issuer.expireDeviceKey('default', issued.key_value, MAC.installId)).toBe('ok');

    const key = core.keysOf(user.user_id).find((k) => k.key_id === issued.key_id)!;
    expect(key.status).toBe('active');
    expect(Date.parse(key.expires_at!)).toBeLessThanOrEqual(clock.now.getTime());
    expect(await meta.auth.verify('default', issued.key_value)).toBeNull();
    // The row stays, due now, so the next prune revokes the key and frees the slot Core still counts.
    expect(devices.find('default', user.user_id, MAC.installId)!.expiresAt).toBe(clock.now.toISOString());
    expect(audit).toHaveBeenCalledWith('vtc.key.expired', { key_id: issued.key_id });

    const other = await issuer.issueDeviceKey('default', user.user_id, { ...MAC, installId: 'install-two-01' });
    expect(other.renewed).toBe(false);
    expect(core.keysOf(user.user_id).find((k) => k.key_id === issued.key_id)!.status).toBe('revoked');
    expect(devices.find('default', user.user_id, MAC.installId)).toBeNull();
  });

  it('refuses logout with an invalid key, for an unknown device and for the web install', async () => {
    const { issuer, user } = await setup();
    const issued = await issuer.issueDeviceKey('default', user.user_id, MAC);
    if (issued.renewed) throw new Error('expected a new key');
    const web = await issuer.issueWebKey('default', user.user_id);

    expect(await issuer.expireDeviceKey('default', 'sk-mem-test-nothing', MAC.installId)).toBe('invalid_key');
    expect(await issuer.expireDeviceKey('default', issued.key_value, 'install-other-01')).toBe('unknown_device');
    // Any valid key of the user must not be able to end the Panel web session key.
    expect(await issuer.expireDeviceKey('default', issued.key_value, WEB_INSTALL_ID)).toBe('unknown_device');
    expect(await issuer.expireDeviceKey('default', web.userKey, WEB_INSTALL_ID)).toBe('unknown_device');
  });
});
