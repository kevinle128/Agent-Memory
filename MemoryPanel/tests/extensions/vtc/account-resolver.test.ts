import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountResolver } from '../../../src/extensions/vtc/accounts/account-resolver.js';
import { LinkStore, type LinkFile } from '../../../src/extensions/vtc/accounts/link-store.js';
import { PendingStore, type PendingFile } from '../../../src/extensions/vtc/accounts/pending-store.js';
import { createJsonStorage } from '../../../src/panel/extensions/json-store.js';
import { MetaError, type MetaFacade } from '../../../src/panel/extensions/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vtc-resolver-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const person = { vtcUserId: '10482', email: 'a.b@vtc.vn' };
const opts = { source: 'web' as const, touch: true };

function setup() {
  const storage = createJsonStorage(dir);
  const pending = new PendingStore(storage.json<PendingFile>('pending', { version: 1, records: [] }));
  const links = new LinkStore(storage.json<LinkFile>('links', { version: 1, links: [] }));
  const meta = {
    users: {
      get: vi.fn(async (): Promise<{ user_id: string; username: string } | null> => null),
      findByExternal: vi.fn(async (): Promise<{ user_id: string } | null> => null),
      create: vi.fn(),
    },
    keys: { create: vi.fn(), update: vi.fn(), revoke: vi.fn(), get: vi.fn() },
    teams: { listForUser: vi.fn(async () => ({ total: 0, items: [] as Array<{ team_id: string; name: string }> })) },
    members: { add: vi.fn(), provisionDefaults: vi.fn() },
  };
  const audit = vi.fn();
  const resolver = new AccountResolver({ meta: meta as unknown as MetaFacade, pending, links, audit });
  return { meta, pending, links, audit, resolver };
}

function expectNoCoreWrite(meta: ReturnType<typeof setup>['meta']) {
  expect(meta.users.create).not.toHaveBeenCalled();
  for (const fn of Object.values(meta.keys)) expect(fn).not.toHaveBeenCalled();
  expect(meta.members.add).not.toHaveBeenCalled();
  expect(meta.members.provisionDefaults).not.toHaveBeenCalled();
}

describe('account resolver', () => {
  it('puts an unknown person in the pending list without writing to Core', async () => {
    const { resolver, meta, pending } = setup();
    const decision = await resolver.resolve('default', person, opts);
    expect(decision).toMatchObject({ kind: 'pending', record: { kind: 'new', email: 'a.b@vtc.vn', source: 'web' } });
    expectNoCoreWrite(meta);
    expect(pending.list('default')).toHaveLength(1);
    expect(meta.users.findByExternal).toHaveBeenCalledWith('default', 'vtc-sso', '10482');
  });

  it('keeps the first stored email and audits a different one without logging addresses', async () => {
    const { resolver, pending, audit } = setup();
    await resolver.resolve('default', person, opts);
    const decision = await resolver.resolve('default', { ...person, email: 'other@vtc.vn' }, opts);
    expect(decision).toMatchObject({ kind: 'pending', record: { email: 'a.b@vtc.vn', loginCount: 2 } });
    expect(pending.list('default')[0]!.email).toBe('a.b@vtc.vn');
    expect(audit).toHaveBeenCalledWith('vtc.identity.email_mismatch', { vtc_user_id: '10482', email_changed: true });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('@');

    audit.mockClear();
    await resolver.resolve('default', person, opts);
    expect(audit).not.toHaveBeenCalledWith('vtc.identity.email_mismatch', expect.anything());
  });

  it('refuses a rejected person', async () => {
    const { resolver, meta, pending } = setup();
    const record = await pending.recordLogin({ instanceId: 'default', vtcUserId: '10482', email: 'a.b@vtc.vn', kind: 'new', source: 'web', touch: true });
    await pending.reject(record.id, 'usr-admin');
    const decision = await resolver.resolve('default', person, opts);
    expect(decision).toMatchObject({ kind: 'rejected', record: { status: 'rejected', loginCount: 2 } });
    expectNoCoreWrite(meta);
  });

  it('approves a linked person who is in a team and removes a stale pending record', async () => {
    const { resolver, meta, pending, links } = setup();
    await links.upsert({ instanceId: 'default', vtcUserId: '10482', coreUserId: 'usr-1', mode: 'linked', linkedAt: 'x' });
    meta.users.get.mockResolvedValue({ user_id: 'usr-1', username: 'one' });
    meta.teams.listForUser.mockResolvedValue({ total: 1, items: [{ team_id: 't1', name: 'Team' }] });
    await pending.recordLogin({ instanceId: 'default', vtcUserId: '10482', email: 'a.b@vtc.vn', kind: 'no_team', coreUserId: 'usr-1', source: 'web', touch: true });

    expect(await resolver.resolve('default', person, opts)).toEqual({ kind: 'approved', coreUserId: 'usr-1' });
    expect(pending.list('default')).toEqual([]);
    expectNoCoreWrite(meta);
  });

  it('keeps a linked person with no team pending as no_team', async () => {
    const { resolver, meta, links } = setup();
    await links.upsert({ instanceId: 'default', vtcUserId: '10482', coreUserId: 'usr-1', mode: 'linked', linkedAt: 'x' });
    meta.users.get.mockResolvedValue({ user_id: 'usr-1', username: 'one' });
    const decision = await resolver.resolve('default', person, opts);
    expect(decision).toMatchObject({ kind: 'pending', record: { kind: 'no_team', coreUserId: 'usr-1' } });
    expectNoCoreWrite(meta);
  });

  it('recovers a lost link from Core', async () => {
    const { resolver, meta, links, audit } = setup();
    meta.users.findByExternal.mockResolvedValue({ user_id: 'usr-7' });
    meta.teams.listForUser.mockResolvedValue({ total: 1, items: [{ team_id: 't1', name: 'Team' }] });
    expect(await resolver.resolve('default', person, opts)).toEqual({ kind: 'approved', coreUserId: 'usr-7' });
    expect(links.find('default', '10482')).toMatchObject({ coreUserId: 'usr-7', mode: 'recovered' });
    expect(audit).toHaveBeenCalledWith('vtc.link.recovered', { vtc_user_id: '10482', core_user_id: 'usr-7' });
  });

  it('does not honour a link or a Core binding while a first request is open or refused', async () => {
    const { resolver, meta, pending, links } = setup();
    await links.upsert({ instanceId: 'default', vtcUserId: '10482', coreUserId: 'usr-1', mode: 'linked', linkedAt: 'x' });
    meta.users.get.mockResolvedValue({ user_id: 'usr-1', username: 'one' });
    meta.users.findByExternal.mockResolvedValue({ user_id: 'usr-1' });
    meta.teams.listForUser.mockResolvedValue({ total: 1, items: [{ team_id: 't1', name: 'Team' }] });
    const record = await pending.recordLogin({ instanceId: 'default', vtcUserId: '10482', email: 'a.b@vtc.vn', kind: 'new', source: 'web', touch: true });

    expect(await resolver.resolve('default', person, opts)).toMatchObject({ kind: 'pending', record: { kind: 'new' } });
    await pending.reject(record.id, 'usr-admin');
    expect(await resolver.resolve('default', person, opts)).toMatchObject({ kind: 'rejected' });
    expect(meta.teams.listForUser).not.toHaveBeenCalled();
    expect(meta.users.findByExternal).not.toHaveBeenCalled();
  });

  it('refuses a rejected no_team person without reading Core or touching the links', async () => {
    const { resolver, meta, pending, links } = setup();
    await links.upsert({ instanceId: 'default', vtcUserId: '10482', coreUserId: 'usr-1', mode: 'linked', linkedAt: 'x' });
    const record = await pending.recordLogin({ instanceId: 'default', vtcUserId: '10482', email: 'a.b@vtc.vn', kind: 'no_team', coreUserId: 'usr-1', source: 'web', touch: true });
    await pending.reject(record.id, 'usr-admin');

    expect(await resolver.resolve('default', person, opts)).toMatchObject({ kind: 'rejected', record: { kind: 'no_team', coreUserId: 'usr-1' } });
    expect(meta.users.get).not.toHaveBeenCalled();
    expect(meta.users.findByExternal).not.toHaveBeenCalled();
    expect(links.find('default', '10482')).toMatchObject({ coreUserId: 'usr-1', mode: 'linked' });
  });

  it('keeps a refusal made while Core was being read', async () => {
    const { resolver, meta, pending, links } = setup();
    await links.upsert({ instanceId: 'default', vtcUserId: '10482', coreUserId: 'usr-1', mode: 'linked', linkedAt: 'x' });
    meta.users.get.mockResolvedValue({ user_id: 'usr-1', username: 'one' });
    const record = await pending.recordLogin({ instanceId: 'default', vtcUserId: '10482', email: 'a.b@vtc.vn', kind: 'no_team', coreUserId: 'usr-1', source: 'web', touch: true });
    meta.teams.listForUser.mockImplementation(async () => {
      await pending.reject(record.id, 'usr-admin');
      return { total: 1, items: [{ team_id: 't1', name: 'Team' }] };
    });

    expect(await resolver.resolve('default', person, opts)).toMatchObject({ kind: 'rejected' });
    expect(pending.get(record.id)).toMatchObject({ status: 'rejected' });
  });

  it('drops a link to a deleted user', async () => {
    const { resolver, meta, links, audit } = setup();
    await links.upsert({ instanceId: 'default', vtcUserId: '10482', coreUserId: 'usr-gone', mode: 'linked', linkedAt: 'x' });
    meta.users.get.mockResolvedValue(null);
    const decision = await resolver.resolve('default', person, opts);
    expect(decision).toMatchObject({ kind: 'pending', record: { kind: 'new' } });
    expect(links.find('default', '10482')).toBeNull();
    expect(audit).toHaveBeenCalledWith('vtc.link.dropped', { vtc_user_id: '10482', core_user_id: 'usr-gone' });
    expectNoCoreWrite(meta);
  });

  it('fails closed when Core errors', async () => {
    const { resolver, meta, pending } = setup();
    meta.users.findByExternal.mockRejectedValue(new MetaError('kernel_error', 'boom'));
    await expect(resolver.resolve('default', person, opts)).rejects.toMatchObject({ code: 'kernel_error' });
    expect(pending.list('default')).toEqual([]);

    meta.users.findByExternal.mockResolvedValue({ user_id: 'usr-7' });
    meta.teams.listForUser.mockRejectedValue(new Error('fetch failed'));
    await expect(resolver.resolve('default', person, opts)).rejects.toThrow('fetch failed');
    expect(pending.list('default')).toEqual([]);
  });

  it('keeps a linked person pending when the team lookup fails instead of approving', async () => {
    const { resolver, meta, links } = setup();
    await links.upsert({ instanceId: 'default', vtcUserId: '10482', coreUserId: 'usr-1', mode: 'linked', linkedAt: 'x' });
    meta.users.get.mockResolvedValue({ user_id: 'usr-1', username: 'one' });
    meta.teams.listForUser.mockRejectedValue(new MetaError('kernel_error', 'boom'));
    await expect(resolver.resolve('default', person, opts)).rejects.toBeInstanceOf(MetaError);
  });
});
