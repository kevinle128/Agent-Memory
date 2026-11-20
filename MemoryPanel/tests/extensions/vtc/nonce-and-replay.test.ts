import { describe, expect, it } from 'vitest';
import { extractReturnNonce, NonceStore } from '../../../src/extensions/vtc/sso/nonce-store.js';
import { ReplayGuard } from '../../../src/extensions/vtc/sso/replay-guard.js';

const input = { kind: 'web' as const, instanceId: 'default', returnTo: '/' };

describe('nonce store', () => {
  it('works once', () => {
    const store = new NonceStore();
    const nonce = store.create(input)!;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(store.take(nonce)).toMatchObject(input);
    expect(store.take(nonce)).toBeNull();
    expect(store.take('unknown')).toBeNull();
  });

  it('expires after the lifetime', () => {
    let now = 0;
    const store = new NonceStore({ ttlMs: 1000, now: () => now });
    const nonce = store.create(input)!;
    now = 1000;
    expect(store.take(nonce)).toBeNull();
  });

  it('refuses new nonces when full of live ones and recovers after expiry', () => {
    let now = 0;
    const store = new NonceStore({ ttlMs: 1000, max: 2, now: () => now });
    expect(store.create(input)).not.toBeNull();
    expect(store.create(input)).not.toBeNull();
    expect(store.create(input)).toBeNull();
    now = 2000;
    expect(store.create(input)).not.toBeNull();
  });

  it('reads the nonce only from the return URL of this Panel', () => {
    const nonce = 'A'.repeat(32);
    const base = 'https://panel.test.invalid';
    expect(extractReturnNonce(`${base}/ext/vtc/sso/return?n=${nonce}`, base)).toBe(nonce);
    expect(extractReturnNonce(`https://evil.example/ext/vtc/sso/return?n=${nonce}`, base)).toBeNull();
    expect(extractReturnNonce(`${base}/other?n=${nonce}`, base)).toBeNull();
    expect(extractReturnNonce(`${base}/ext/vtc/sso/return?n=short`, base)).toBeNull();
    expect(extractReturnNonce(`${base}/ext/vtc/sso/return`, base)).toBeNull();
    expect(extractReturnNonce('not a url', base)).toBeNull();
    expect(extractReturnNonce(undefined, base)).toBeNull();
  });
});

describe('replay guard', () => {
  const login = (userId: string, loginTime = '2026-11-20 09:00:00') => ({ userId, loginTime });

  it('refuses a repeat until the record runs out and forgets it afterwards', () => {
    let now = 0;
    const guard = new ReplayGuard({ now: () => now });
    expect(guard.firstUse(login('1'), 1000)).toBe(true);
    expect(guard.firstUse(login('1'), 1000)).toBe(false);
    now = 1000;
    expect(guard.firstUse(login('1'), 2000)).toBe(false);
    now = 2001;
    expect(guard.firstUse(login('1'), 3000)).toBe(true);
  });

  it('keeps a record for as long as the caller asks, not for a fixed window', () => {
    let now = 0;
    const guard = new ReplayGuard({ now: () => now });
    expect(guard.firstUse(login('1'), 3_600_000)).toBe(true);
    now = 3_599_999;
    expect(guard.firstUse(login('1'), 7_000_000)).toBe(false);
    now = 3_600_001;
    expect(guard.firstUse(login('1'), 7_000_000)).toBe(true);
  });

  it('keys on the user ID and the trimmed raw login time', () => {
    const guard = new ReplayGuard();
    const until = Date.now() + 60_000;
    expect(guard.firstUse(login('1'), until)).toBe(true);
    expect(guard.firstUse(login('1', ' 2026-11-20 09:00:00 '), until)).toBe(false);
    expect(guard.firstUse(login('2'), until)).toBe(true);
    expect(guard.firstUse(login('1', '2026-11-20 09:00:01'), until)).toBe(true);
  });

  it('fails closed when full of live logins', () => {
    let now = 0;
    const guard = new ReplayGuard({ max: 1, now: () => now });
    expect(guard.firstUse(login('1'), 1000)).toBe(true);
    expect(guard.firstUse(login('2'), 1000)).toBe(false);
    now = 1001;
    expect(guard.firstUse(login('2'), 2000)).toBe(true);
  });
});
