import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export class TripleDesError extends Error {
  constructor(readonly reason: 'decrypt_failed' | 'malformed') {
    // The message carries the reason only, never key or payload material.
    super(reason);
    this.name = 'TripleDesError';
  }
}

export interface SsoUserData {
  email: string;
  userId: string;
  requestLoginDateTime: string;
  requestIp: string;
}

const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;
const BLOCK_SIZE = 8;

// .NET ASCII encoding turns every UTF-16 unit above 0x7f into '?'; Node would keep a byte.
function toAsciiBytes(value: string): Buffer {
  return Buffer.from(value.replace(/[^\x00-\x7f]/g, '?'), 'ascii');
}

/** Key of the VTC SSO cipher: the first 24 characters of the lowercase hex MD5 of the key string, as ASCII bytes. */
export function deriveTripleDesKey(keyString: string): Buffer {
  const md5 = createHash('md5').update(toAsciiBytes(keyString)).digest('hex');
  return Buffer.from(md5.slice(0, 24), 'ascii');
}

/** Encrypt as Security.TripleDESEncrypt does: trim, ASCII, 3DES-ECB, PKCS7, base64. Used by tests and the local fake SSO only. */
export function tripleDesEncrypt(keyString: string, plaintext: string): string {
  const cipher = createCipheriv('des-ede3', deriveTripleDesKey(keyString), null);
  const body = Buffer.concat([cipher.update(toAsciiBytes(plaintext.trim())), cipher.final()]);
  return body.toString('base64');
}

const INT64_MAX = 9223372036854775807n;

function isInt64(value: string): boolean {
  return /^[0-9]{1,19}$/.test(value) && BigInt(value) <= INT64_MAX;
}

/** Undo form decoding that turned '+' into ' ' before base64 decoding. */
export function restorePlus(value: string): string {
  return value.replace(/ /g, '+');
}

/** Decrypt as Security.TripleDESDecrypt does. Throws TripleDesError('decrypt_failed') on bad or non-canonical base64, bad length or bad padding. */
export function tripleDesDecrypt(keyString: string, base64: string): string {
  const text = restorePlus(base64);
  // Buffer.from(..., 'base64') never throws, so check the shape before decoding.
  if (text.length % 4 !== 0 || !BASE64_SHAPE.test(text)) throw new TripleDesError('decrypt_failed');
  const body = Buffer.from(text, 'base64');
  if (body.length === 0 || body.length % BLOCK_SIZE !== 0) throw new TripleDesError('decrypt_failed');
  // Node ignores the unused trailing bits of the last character, so several texts decode to the same bytes.
  // Only the canonical text is accepted; otherwise a variant of a used ticket would pass as a new one.
  if (body.toString('base64') !== text) throw new TripleDesError('decrypt_failed');
  try {
    const decipher = createDecipheriv('des-ede3', deriveTripleDesKey(keyString), null);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    throw new TripleDesError('decrypt_failed');
  }
}

/**
 * Two-layer decode of `ud` (AccountMail.cs:30-41). Throws TripleDesError with reason
 * 'decrypt_failed' (either layer) or 'malformed' (not exactly 2 outer parts, fewer than 4 inner parts after dropping empty ones,
 * an empty email, user ID or IP, or a user ID that is not a valid Int64 as noibo's Int64.Parse reads it).
 */
export function decodeSsoUserData(privateKey: string, ud: string): SsoUserData {
  const outer = tripleDesDecrypt(privateKey, restorePlus(ud))
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const [encryptedInner, publicKey] = outer;
  if (outer.length !== 2 || encryptedInner === undefined || publicKey === undefined) {
    throw new TripleDesError('malformed');
  }

  // The inner text never went through query decoding. tripleDesDecrypt restores spaces anyway,
  // which changes nothing because valid base64 holds no space.
  // Like noibo (RemoveEmptyEntries), empty parts are dropped, so a trailing '|' is accepted.
  const inner = tripleDesDecrypt(publicKey + privateKey, encryptedInner)
    .split('|')
    .filter((part) => part !== '')
    .map((part) => part.trim());
  // noibo reads the fields at indexes 0, 1 and 3 (email, user ID, IP); index 2 is the login time.
  const [email, userId, requestLoginDateTime, requestIp] = inner;
  if (
    inner.length < 4 ||
    !email ||
    !userId ||
    !requestIp ||
    requestLoginDateTime === undefined ||
    !isInt64(userId)
  ) {
    throw new TripleDesError('malformed');
  }
  return { email, userId, requestLoginDateTime, requestIp };
}

/** Build `ud` the way the SSO does. Used by tests and the local fake SSO only. */
export function encodeSsoUserData(privateKey: string, publicKey: string, data: SsoUserData): string {
  const inner = tripleDesEncrypt(
    publicKey + privateKey,
    [data.email, data.userId, data.requestLoginDateTime, data.requestIp].join('|'),
  );
  return tripleDesEncrypt(privateKey, `${inner}|${publicKey}`);
}
