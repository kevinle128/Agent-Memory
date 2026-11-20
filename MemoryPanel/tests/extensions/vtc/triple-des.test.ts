import { describe, expect, it } from 'vitest';
import {
  TripleDesError,
  decodeSsoUserData,
  deriveTripleDesKey,
  encodeSsoUserData,
  tripleDesDecrypt,
  tripleDesEncrypt,
} from '../../../src/extensions/vtc/sso/triple-des.js';

const privateKey = 'test-private-key-not-real';
const publicKey = 'test-public-key-not-real';
const sample = {
  email: 'a.b@vtc.vn',
  userId: '10482',
  requestLoginDateTime: '2026-11-20 09:15:00',
  requestIp: '10.0.0.1',
};

function expectReason(fn: () => unknown, reason: 'decrypt_failed' | 'malformed'): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(TripleDesError);
    expect((err as TripleDesError).reason).toBe(reason);
    return;
  }
  throw new Error('expected TripleDesError');
}

describe('VTC SSO TripleDES cipher', () => {
  it('derives the key from the lowercase hex MD5', () => {
    // MD5('abc') = 900150983cd24fb0d6963f7d28e17f72
    expect(deriveTripleDesKey('abc')).toEqual(Buffer.from('900150983cd24fb0d6963f7d', 'ascii'));
  });

  it('round-trips ASCII text', () => {
    expect(tripleDesDecrypt(privateKey, tripleDesEncrypt(privateKey, 'a|b|c'))).toBe('a|b|c');
  });

  it('trims before encrypting', () => {
    expect(tripleDesDecrypt(privateKey, tripleDesEncrypt(privateKey, '  x  '))).toBe('x');
  });

  it('matches a fixed vector', () => {
    // Produced outside the code under test with:
    // node -e "const c=require('crypto');const k=Buffer.from(c.createHash('md5').update('test-private-key-not-real').digest('hex').slice(0,24),'ascii');const e=c.createCipheriv('des-ede3',k,null);console.log(Buffer.concat([e.update('hello|world','ascii'),e.final()]).toString('base64'))"
    const vector = 'SA7lFiPacJ7G7lNUcF9GFg==';
    expect(tripleDesEncrypt(privateKey, 'hello|world')).toBe(vector);
    expect(tripleDesDecrypt(privateKey, vector)).toBe('hello|world');
  });

  it('matches vectors produced by .NET Security.cs', () => {
    // Produced by a .NET 10 copy of noibo Security.cs with fake keys; the second vector has non-ASCII
    // characters in key and text, which .NET ASCII encoding turns into '?'.
    expect(tripleDesDecrypt(privateKey, 'SA7lFiPacJ7G7lNUcF9GFg==')).toBe('hello|world');
    expect(tripleDesEncrypt('tést-kéy', '  hé|llo  ')).toBe('bvUW888WfZo=');
    expect(tripleDesDecrypt('tést-kéy', 'bvUW888WfZo=')).toBe('h?|llo');
  });

  it('decodes a ud value produced by .NET, including a plus sign turned into a space', () => {
    const ud =
      'LKxYvx7vvqXiKcVPec2xLOGMQsJwvTS1zgkRIKSrY0OYAGCH3txbRP2rwZylXlCBvOOYzQXFtaaOVmLX3jYn1p7/unN347pVi0eY4VXqxkRtaXicDlFgzwa11beqhF+R';
    expect(ud).toContain('+');
    expect(decodeSsoUserData(privateKey, ud)).toEqual(sample);
    expect(decodeSsoUserData(privateKey, ud.replace(/\+/g, ' '))).toEqual(sample);
    expect(encodeSsoUserData(privateKey, publicKey, sample)).toBe(ud);
  });

  it('fails with the wrong key', () => {
    const body = tripleDesEncrypt(privateKey, 'hello|world');
    expectReason(() => tripleDesDecrypt('another-key-not-real', body), 'decrypt_failed');
  });

  it('fails on bad padding', () => {
    const raw = Buffer.from(tripleDesEncrypt(privateKey, 'hello|world'), 'base64');
    raw[raw.length - 1] ^= 0x01;
    expectReason(() => tripleDesDecrypt(privateKey, raw.toString('base64')), 'decrypt_failed');
  });

  it('fails on bad base64 and on lengths that are not a multiple of 8', () => {
    expectReason(() => tripleDesDecrypt(privateKey, 'not base64 !!'), 'decrypt_failed');
    expectReason(() => tripleDesDecrypt(privateKey, ''), 'decrypt_failed');
    expectReason(() => tripleDesDecrypt(privateKey, Buffer.alloc(12).toString('base64')), 'decrypt_failed');
    expectReason(() => tripleDesDecrypt(privateKey, 'AAAA='), 'decrypt_failed');
  });

  it('accepts only the canonical base64 spelling of the ciphertext', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let checked = 0;
    for (let length = 1; length <= 24 && checked < 2; length += 1) {
      const text = 'x'.repeat(length);
      const canonical = tripleDesEncrypt(privateKey, text);
      const pad = canonical.length - canonical.replace(/=+$/, '').length;
      if (pad === 0) continue;
      checked += 1;
      expect(tripleDesDecrypt(privateKey, canonical)).toBe(text);
      // The last data character carries 2 (one '=') or 4 (two '=') unused bits; every other value decodes to the same bytes.
      const unusedBits = pad === 1 ? 2 : 4;
      const lastIndex = canonical.length - pad - 1;
      const usedPart = alphabet.indexOf(canonical[lastIndex]!) >> unusedBits;
      let variants = 0;
      for (let i = 0; i < alphabet.length; i += 1) {
        if (i >> unusedBits !== usedPart || alphabet[i] === canonical[lastIndex]) continue;
        const variant = canonical.slice(0, lastIndex) + alphabet[i] + canonical.slice(lastIndex + 1);
        expect(Buffer.from(variant, 'base64').equals(Buffer.from(canonical, 'base64'))).toBe(true);
        expectReason(() => tripleDesDecrypt(privateKey, variant), 'decrypt_failed');
        variants += 1;
      }
      expect(variants).toBe(2 ** unusedBits - 1);
      // Missing padding is also not the canonical spelling.
      expectReason(() => tripleDesDecrypt(privateKey, canonical.replace(/=+$/, '')), 'decrypt_failed');
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('restores plus signs turned into spaces', () => {
    for (let counter = 0; counter < 5000; counter++) {
      const data = { ...sample, email: `user${counter}@vtc.vn` };
      const ud = encodeSsoUserData(privateKey, publicKey, data);
      if (!ud.includes('+')) continue;
      expect(decodeSsoUserData(privateKey, ud.replace(/\+/g, ' '))).toEqual(data);
      return;
    }
    throw new Error('no payload with a plus sign found');
  });

  it('decodes both layers', () => {
    const ud = encodeSsoUserData(privateKey, publicKey, sample);
    expect(decodeSsoUserData(privateKey, ud)).toEqual(sample);
  });

  it('rejects malformed payloads', () => {
    const inner = (parts: string[]) => tripleDesEncrypt(publicKey + privateKey, parts.join('|'));
    const outer = (innerCipher: string) => tripleDesEncrypt(privateKey, `${innerCipher}|${publicKey}`);

    expectReason(() => decodeSsoUserData(privateKey, tripleDesEncrypt(privateKey, 'no-separator')), 'malformed');
    expectReason(
      () => decodeSsoUserData(privateKey, outer(inner(['a@vtc.vn', '1', '2026-11-20 09:15:00']))),
      'malformed',
    );
    expectReason(
      () => decodeSsoUserData(privateKey, outer(inner(['a@vtc.vn', 'abc', '2026-11-20 09:15:00', '10.0.0.1']))),
      'malformed',
    );
    expectReason(
      () => decodeSsoUserData(privateKey, outer(inner(['', '1', '2026-11-20 09:15:00', '10.0.0.1']))),
      'malformed',
    );
  });

  it('drops empty inner parts as noibo does', () => {
    const outer = (text: string) =>
      tripleDesEncrypt(privateKey, `${tripleDesEncrypt(publicKey + privateKey, text)}|${publicKey}`);
    const line = 'a.b@vtc.vn|10482|2026-11-20 09:15:00|10.0.0.1';
    expect(decodeSsoUserData(privateKey, outer(`${line}|`))).toEqual(sample);
    expect(decodeSsoUserData(privateKey, outer(`${line}||extra`))).toEqual(sample);
    // The empty login time is dropped, so the IP moves to index 2 and index 3 is missing.
    expectReason(() => decodeSsoUserData(privateKey, outer('a.b@vtc.vn|10482||10.0.0.1')), 'malformed');
    expectReason(() => decodeSsoUserData(privateKey, outer('a.b@vtc.vn|10482|2026-11-20 09:15:00|')), 'malformed');
  });

  it('accepts only a user ID that is a valid Int64', () => {
    const outer = (userId: string) =>
      tripleDesEncrypt(
        privateKey,
        `${tripleDesEncrypt(publicKey + privateKey, `a@vtc.vn|${userId}|2026-11-20 09:15:00|10.0.0.1`)}|${publicKey}`,
      );
    expect(decodeSsoUserData(privateKey, outer('9223372036854775807')).userId).toBe('9223372036854775807');
    expectReason(() => decodeSsoUserData(privateKey, outer('9223372036854775808')), 'malformed');
    expectReason(() => decodeSsoUserData(privateKey, outer('-1')), 'malformed');
    expectReason(() => decodeSsoUserData(privateKey, outer('1.5')), 'malformed');
  });

  it('uses the inner key publicKey + privateKey', () => {
    const wrongInner = tripleDesEncrypt(privateKey + publicKey, 'a@vtc.vn|1|2026-11-20 09:15:00|10.0.0.1');
    const ud = tripleDesEncrypt(privateKey, `${wrongInner}|${publicKey}`);
    expectReason(() => decodeSsoUserData(privateKey, ud), 'decrypt_failed');
  });
});
