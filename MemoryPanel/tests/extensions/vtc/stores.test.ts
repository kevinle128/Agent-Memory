import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LinkStore, type LinkFile } from '../../../src/extensions/vtc/accounts/link-store.js';
import { PendingStore, type PendingFile } from '../../../src/extensions/vtc/accounts/pending-store.js';
import { DeviceStore, type DeviceFile } from '../../../src/extensions/vtc/device/device-store.js';
import { createJsonStorage } from '../../../src/panel/extensions/json-store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vtc-stores-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function pendingStore(clock: { now: Date } = { now: new Date('2026-11-20T02:00:00Z') }) {
  // A fresh storage per call: it models a restart.
  const doc = createJsonStorage(dir).json<PendingFile>('pending', { version: 1, records: [] });
  return new PendingStore(doc, () => clock.now);
}

const login = {
  instanceId: 'default',
  vtcUserId: '10482',
  email: 'a.b@vtc.vn',
  kind: 'new' as const,
  source: 'web' as const,
  touch: true,
};

describe('pending store', () => {
  it('records a first login and counts later ones', async () => {
    const clock = { now: new Date('2026-11-20T02:00:00Z') };
    const store = pendingStore(clock);
    const first = await store.recordLogin(login);
    expect(first).toMatchObject({ status: 'pending', loginCount: 1, source: 'web', kind: 'new' });
    expect(first.id).toMatch(/^pnd_[0-9A-Z]{26}$/);

    clock.now = new Date('2026-11-20T03:00:00Z');
    const second = await store.recordLogin({ ...login, source: 'device' });
    expect(second.id).toBe(first.id);
    expect(second.loginCount).toBe(2);
    expect(second.firstLoginAt).toBe('2026-11-20T02:00:00.000Z');
    expect(second.lastLoginAt).toBe('2026-11-20T03:00:00.000Z');
    // The source stays where the person first logged in.
    expect(second.source).toBe('web');
    expect(store.list('default')).toHaveLength(1);
  });

  it('updates kind and Core user while the record is pending but keeps the first email', async () => {
    const store = pendingStore();
    await store.recordLogin(login);
    const moved = await store.recordLogin({ ...login, email: 'new@vtc.vn', kind: 'no_team', coreUserId: 'usr-1' });
    expect(moved).toMatchObject({ email: 'a.b@vtc.vn', kind: 'no_team', coreUserId: 'usr-1' });
  });

  it('keeps a rejected record rejected on login', async () => {
    const store = pendingStore();
    const created = await store.recordLogin(login);
    const rejected = await store.reject(created.id, 'usr-admin', 'not an employee');
    expect(rejected).toMatchObject({ status: 'rejected', rejectedBy: 'usr-admin', reason: 'not an employee' });
    const again = await store.recordLogin({ ...login, email: 'other@vtc.vn' });
    expect(again).toMatchObject({ status: 'rejected', email: 'a.b@vtc.vn', loginCount: 2 });
    expect(await store.reject('missing', 'usr-admin')).toBeNull();
  });

  it('does not count a login when touch is false', async () => {
    const clock = { now: new Date('2026-11-20T02:00:00Z') };
    const store = pendingStore(clock);
    await store.recordLogin(login);
    clock.now = new Date('2026-11-20T04:00:00Z');
    const polled = await store.recordLogin({ ...login, touch: false });
    expect(polled).toMatchObject({ loginCount: 1, lastLoginAt: '2026-11-20T02:00:00.000Z' });
  });

  it('persists records across a reopen', async () => {
    const created = await pendingStore().recordLogin(login);
    const reopened = pendingStore();
    expect(reopened.findByVtcUser('default', '10482')).toEqual(created);
    expect(reopened.get(created.id)).toEqual(created);
    await reopened.remove(created.id);
    expect(pendingStore().list('default')).toEqual([]);
  });

  it('lists the newest login first', async () => {
    const clock = { now: new Date('2026-11-20T02:00:00Z') };
    const store = pendingStore(clock);
    await store.recordLogin(login);
    clock.now = new Date('2026-11-20T05:00:00Z');
    await store.recordLogin({ ...login, vtcUserId: '2' });
    clock.now = new Date('2026-11-20T06:00:00Z');
    await store.recordLogin(login);
    expect(store.list('default').map((r) => r.vtcUserId)).toEqual(['10482', '2']);
  });

  it('keys pending records by instance', async () => {
    const store = pendingStore();
    await store.recordLogin(login);
    await store.recordLogin({ ...login, instanceId: 'other' });
    expect(store.list('default')).toHaveLength(1);
    expect(store.list('other')).toHaveLength(1);
    expect(store.findByVtcUser('other', '10482')?.instanceId).toBe('other');
  });
});

describe('link store', () => {
  const link = { instanceId: 'default', vtcUserId: '10482', coreUserId: 'usr-1', mode: 'linked' as const, linkedAt: 'x' };
  const open = () => new LinkStore(createJsonStorage(dir).json<LinkFile>('links', { version: 1, links: [] }));

  it('keys links by instance and replaces on upsert', async () => {
    const store = open();
    await store.upsert(link);
    await store.upsert({ ...link, instanceId: 'other', coreUserId: 'usr-9' });
    await store.upsert({ ...link, coreUserId: 'usr-2', mode: 'recovered' });
    expect(store.find('default', '10482')).toMatchObject({ coreUserId: 'usr-2', mode: 'recovered' });
    expect(store.find('other', '10482')?.coreUserId).toBe('usr-9');
    expect(store.findByCoreUser('default', 'usr-2')?.vtcUserId).toBe('10482');
    expect(open().find('default', '10482')?.coreUserId).toBe('usr-2');
    await store.remove('default', '10482');
    expect(open().find('default', '10482')).toBeNull();
    expect(open().find('other', '10482')).not.toBeNull();
  });
});

describe('device store', () => {
  const row = {
    instanceId: 'default',
    coreUserId: 'usr-1',
    installId: 'panel-web',
    keyId: 'key-1',
    deviceName: 'Panel web',
    expiresAt: '2026-11-27T00:00:00.000Z',
    lastLoginAt: '2026-11-20T00:00:00.000Z',
  };
  const open = () => new DeviceStore(createJsonStorage(dir).json<DeviceFile>('devices', { version: 1, devices: [] }));

  it('keys devices by instance, user and install', async () => {
    const store = open();
    await store.upsert(row);
    await store.upsert({ ...row, instanceId: 'other', keyId: 'key-2' });
    await store.upsert({ ...row, installId: 'laptop', keyId: 'key-3' });
    await store.upsert({ ...row, keyId: 'key-4' });
    expect(store.find('default', 'usr-1', 'panel-web')?.keyId).toBe('key-4');
    expect(store.find('other', 'usr-1', 'panel-web')?.keyId).toBe('key-2');
    expect(store.listForUser('default', 'usr-1')).toHaveLength(2);
    expect(open().listForUser('default', 'usr-1')).toHaveLength(2);
    await store.remove('default', 'usr-1', 'laptop');
    expect(open().listForUser('default', 'usr-1')).toHaveLength(1);
  });
});
