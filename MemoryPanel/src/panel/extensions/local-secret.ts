import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../auth/identity-store.js';
import type { ExtensionSecretsPort } from './types.js';

/** A per-extension secret kept in a 0600 file, created on first use. It never comes from an env variable. */
export function createLocalSecrets(dir: string): ExtensionSecretsPort {
  const path = join(dir, '.secret');
  let secret = '';
  if (existsSync(path)) secret = readFileSync(path, 'utf8').trim();
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  return {
    encrypt: (plain) => encryptSecret(plain, secret),
    decrypt: (cipher) => decryptSecret(cipher, secret),
  };
}
