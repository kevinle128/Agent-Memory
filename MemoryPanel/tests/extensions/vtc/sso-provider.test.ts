import { describe, expect, it } from 'vitest';
import type { VtcConfig } from '../../../src/extensions/vtc/config.js';
import { ReplayGuard } from '../../../src/extensions/vtc/sso/replay-guard.js';
import { decodeSsoUserData } from '../../../src/extensions/vtc/sso/triple-des.js';
import { VtcSsoProvider } from '../../../src/extensions/vtc/sso/vtc-sso-provider.js';
import { PRIVATE_KEY, makeUd } from './vtc-fixtures.js';

const NOW = Date.parse('2026-11-20T02:15:00Z');
const config: VtcConfig = {
  ssoBaseUrl: 'https://sso.test.invalid/sso',
  serviceId: '123456',
  privateKey: PRIVATE_KEY,
  publicBaseUrl: 'https://panel.test.invalid',
  successState: '1',
  keyTtlDays: 7,
  loginMaxAgeSeconds: 300,
  deviceCodeTtlSeconds: 600,
};

function setup(overrides: Partial<VtcConfig> = {}) {
  const clock = { now: NOW };
  const replay = new ReplayGuard({ now: () => clock.now });
  const provider = new VtcSsoProvider({ ...config, ...overrides }, replay, () => clock.now);
  return { clock, provider };
}

/** The SSO time of a ticket issued `ageSeconds` before the fixed clock, written as the SSO writes it (UTC+7). */
function sso(ageSeconds: number): string {
  const at = new Date(NOW - ageSeconds * 1000 + 7 * 3600_000);
  return at.toISOString().slice(0, 19).replace('T', ' ');
}

describe('VTC SSO provider', () => {
  it('accepts a fresh valid ticket', () => {
    const { provider } = setup();
    const result = provider.verify({ r: '1', ud: makeUd({ time: sso(10) }) });
    expect(result).toMatchObject({
      ok: true,
      identity: { providerId: 'vtc', subject: '10482', loginName: 'a.b', email: 'a.b@vtc.vn', displayName: 'a.b' },
      requestIp: '10.0.0.1',
    });
  });

  it('lowercases the email', () => {
    const { provider } = setup();
    const result = provider.verify({ r: '1', ud: makeUd({ email: 'A.B@VTC.VN', time: sso(1) }) });
    expect(result).toMatchObject({ ok: true, identity: { email: 'a.b@vtc.vn', loginName: 'a.b' } });
  });

  it('rejects a ticket whose email is clearly malformed', () => {
    const { provider } = setup();
    const bad = ['no-at-sign', '@vtc.vn', 'a@', 'a b@vtc.vn', 'a@@vtc.vn', 'a@vtc', 'a@.vn', `${'x'.repeat(250)}@vtc.vn`];
    bad.forEach((email, i) => {
      const ud = makeUd({ email, userId: String(40000 + i), time: sso(5) });
      expect(provider.verify({ r: '1', ud }), email).toMatchObject({ ok: false, reason: 'malformed' });
    });
    expect(provider.verify({ r: '1', ud: makeUd({ email: 'a.b@vtc.vn', time: sso(5) }) })).toMatchObject({ ok: true });
  });

  it('rejects a ticket older than the allowed age', () => {
    const { provider } = setup();
    expect(provider.verify({ r: '1', ud: makeUd({ time: sso(400) }) })).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('accepts a ticket inside the skew allowance and rejects one beyond it', () => {
    const { provider } = setup();
    expect(provider.verify({ r: '1', ud: makeUd({ time: sso(-30) }) })).toMatchObject({ ok: true });
    expect(provider.verify({ r: '1', ud: makeUd({ time: sso(-120) }) })).toMatchObject({
      ok: false,
      reason: 'clock_skew',
    });
  });

  it('rejects a replayed ticket but still accepts a different one', () => {
    const { provider } = setup();
    const ud = makeUd({ time: sso(5) });
    expect(provider.verify({ r: '1', ud })).toMatchObject({ ok: true });
    expect(provider.verify({ r: '1', ud })).toMatchObject({ ok: false, reason: 'replayed' });
    expect(provider.verify({ r: '1', ud: makeUd({ time: sso(6), userId: '10483' }) })).toMatchObject({ ok: true });
  });

  it('rejects a ticket rebuilt from copied or dropped cipher blocks as a replay', () => {
    const { provider } = setup();
    // The cipher is ECB without a MAC, so whole blocks can be copied or dropped. A long email gives such
    // edits room to leave the user ID and the login time intact.
    const email = 'nguyen.van.anh.long.email.address.for.splicing@vtc.vn';
    const ud = makeUd({ email, time: sso(5) });
    const original = decodeSsoUserData(PRIVATE_KEY, ud);
    const body = Buffer.from(ud, 'base64');
    const blocks = body.length / 8;
    const variants: string[] = [];
    for (let start = 0; start < blocks - 1; start++) {
      for (let len = 1; len <= 4 && start + len <= blocks - 1; len++) {
        const head = body.subarray(0, start * 8);
        const run = body.subarray(start * 8, (start + len) * 8);
        const tail = body.subarray((start + len) * 8);
        for (const forged of [Buffer.concat([head, run, run, tail]), Buffer.concat([head, tail])]) {
          const text = forged.toString('base64');
          try {
            const data = decodeSsoUserData(PRIVATE_KEY, text);
            if (data.userId === original.userId && data.requestLoginDateTime === original.requestLoginDateTime) {
              variants.push(text);
            }
          } catch {
            // Most edits break the structure; only the ones that still decode matter here.
          }
        }
      }
    }
    expect(variants.length).toBeGreaterThan(0);
    expect(provider.verify({ r: '1', ud })).toMatchObject({ ok: true });
    for (const variant of variants) {
      expect(provider.verify({ r: '1', ud: variant })).toMatchObject({ ok: false, reason: 'replayed' });
    }
  });

  it('rejects a failed SSO state and honours a configured state', () => {
    const { provider } = setup();
    expect(provider.verify({ r: '0', ud: makeUd({ time: sso(5) }) })).toMatchObject({ ok: false, reason: 'sso_failed' });
    expect(provider.verify({ ud: makeUd({ time: sso(5) }) })).toMatchObject({ ok: false, reason: 'sso_failed' });

    const custom = setup({ successState: 'ok' }).provider;
    expect(custom.verify({ r: '1', ud: makeUd({ time: sso(5) }) })).toMatchObject({ ok: false, reason: 'sso_failed' });
    expect(custom.verify({ r: 'ok', ud: makeUd({ time: sso(5) }) })).toMatchObject({ ok: true });
  });

  it('rejects a ticket for another private key', () => {
    const { provider } = setup();
    const ud = makeUd({ time: sso(5), privateKey: 'another-private-key-not-real' });
    expect(provider.verify({ r: '1', ud })).toMatchObject({ ok: false, reason: 'decrypt_failed' });
  });

  it('rejects a missing ticket', () => {
    const { provider } = setup();
    expect(provider.verify({ r: '1' })).toMatchObject({ ok: false, reason: 'missing_ticket' });
    expect(provider.verify({ r: '1', ud: '' })).toMatchObject({ ok: false, reason: 'missing_ticket' });
  });

  it('reports the time shape, not the value', () => {
    const { provider } = setup();
    const result = provider.verify({
      r: '1',
      ud: makeUd({ time: 'yesterday at noon', email: 'secret.person@vtc.vn' }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'time_unparsed', timeShape: 'aaaaaaaaa aa aaaa' });
    const text = JSON.stringify(result);
    expect(text).not.toContain('yesterday');
    expect(text).not.toContain('secret.person');
  });

  it('accepts plus signs decoded as spaces', () => {
    const { provider } = setup();
    // Find a ticket whose base64 holds a plus sign, then send it the way a lax query parser delivers it.
    let ud = '';
    for (let i = 0; i < 400 && !ud.includes('+'); i += 1) ud = makeUd({ time: sso(5), userId: String(20000 + i) });
    expect(ud).toContain('+');
    expect(provider.verify({ r: '1', ud: ud.replace(/\+/g, ' ') })).toMatchObject({ ok: true });
  });

  it('does not record invalid tickets in the replay set', () => {
    const { clock, provider } = setup();
    const ud = makeUd({ time: sso(400) });
    expect(provider.verify({ r: '1', ud })).toMatchObject({ ok: false, reason: 'stale' });
    clock.now = NOW - 390_000;
    expect(provider.verify({ r: '1', ud })).toMatchObject({ ok: true });
  });

  /** A ticket whose outer base64 ends in padding, with the number of '=' it needs. */
  function paddedTicket(pad: 1 | 2): string {
    for (let i = 0; i < 256; i += 1) {
      // The email length sets the ciphertext length, and so whether the base64 text is padded.
      const ud = makeUd({ time: sso(5), userId: String(30000 + i), email: `${'a'.repeat((i % 64) + 1)}@vtc.vn` });
      if (ud.endsWith('='.repeat(pad)) && !ud.endsWith('='.repeat(pad + 1))) return ud;
    }
    throw new Error('no padded ticket found');
  }

  /** Every other spelling that decodes to the same bytes. */
  function spellings(ud: string): string[] {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const pad = ud.length - ud.replace(/=+$/, '').length;
    const unusedBits = pad === 1 ? 2 : 4;
    const lastIndex = ud.length - pad - 1;
    const usedPart = alphabet.indexOf(ud[lastIndex]!) >> unusedBits;
    return [...alphabet]
      .filter((ch, i) => i >> unusedBits === usedPart && ch !== ud[lastIndex])
      .map((ch) => ud.slice(0, lastIndex) + ch + ud.slice(lastIndex + 1));
  }

  for (const pad of [1, 2] as const) {
    it(`accepts a padded ticket (${pad} padding) once and refuses its non-canonical spellings`, () => {
      const { provider } = setup();
      const ud = paddedTicket(pad);
      const variants = spellings(ud);
      expect(variants).toHaveLength(pad === 1 ? 3 : 15);
      expect(provider.verify({ r: '1', ud })).toMatchObject({ ok: true });
      expect(provider.verify({ r: '1', ud })).toMatchObject({ ok: false, reason: 'replayed' });
      for (const variant of variants) {
        expect(provider.verify({ r: '1', ud: variant })).toMatchObject({ ok: false });
      }
    });

    it(`refuses non-canonical spellings of a padded ticket (${pad} padding) that was never used`, () => {
      const { provider } = setup();
      const ud = paddedTicket(pad);
      for (const variant of spellings(ud)) {
        expect(provider.verify({ r: '1', ud: variant })).toMatchObject({ ok: false, reason: 'decrypt_failed' });
      }
      expect(provider.verify({ r: '1', ud: ud.replace(/=+$/, '') })).toMatchObject({ ok: false, reason: 'decrypt_failed' });
      // None of the refused spellings used up the real ticket.
      expect(provider.verify({ r: '1', ud })).toMatchObject({ ok: true });
    });
  }

  it('remembers a ticket until its latest reading would stop being fresh', () => {
    const { clock, provider } = setup();
    // 10/11/2026 reads as 11 October or 10 November (UTC+7); the clock sits on the first.
    const first = Date.parse('2026-10-11T02:15:00Z');
    const second = Date.parse('2026-11-10T02:15:00Z');
    const ud = makeUd({ time: '10/11/2026 09:15:00' });
    clock.now = first;
    expect(provider.verify({ r: '1', ud })).toMatchObject({ ok: true });
    // Far beyond the fixed window, when only the other reading is fresh, the ticket is still a replay.
    clock.now = second;
    expect(provider.verify({ r: '1', ud })).toMatchObject({ ok: false, reason: 'replayed' });
    // The record lasts through the second reading's allowed age (300 s) plus the skew (60 s).
    clock.now = second + 360_000;
    expect(provider.verify({ r: '1', ud })).toMatchObject({ ok: false, reason: 'replayed' });
    clock.now = second + 360_001;
    expect(provider.verify({ r: '1', ud })).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('builds the SSO login and logout URLs', () => {
    const { provider } = setup();
    const returnUrl = 'https://panel.test.invalid/ext/vtc/sso/return?n=abc';
    expect(provider.buildLoginUrl(returnUrl)).toBe(
      `https://sso.test.invalid/sso/Login/?id=123456&url=${encodeURIComponent(returnUrl)}` +
        '&continue=https%3A%2F%2Fpanel.test.invalid%2Fext%2Fvtc%2Fsso%2Fcontinue&m=1',
    );
    expect(provider.buildLogoutUrl('https://panel.test.invalid/')).toBe(
      'https://sso.test.invalid/sso/Logout/?url=https%3A%2F%2Fpanel.test.invalid%2F',
    );
  });

  it('returns an identity or null from the callback', async () => {
    const { provider } = setup();
    const ud = makeUd({ time: sso(5) });
    expect(await provider.authenticateFromCallback({ r: '1', ud })).toMatchObject({ subject: '10482' });
    expect(await provider.authenticateFromCallback({ r: '1', ud })).toBeNull();
  });
});
