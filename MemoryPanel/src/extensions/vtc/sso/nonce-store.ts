import { randomBytes } from 'node:crypto';

export interface LoginNonce {
  kind: 'web' | 'device';
  instanceId: string;
  returnTo: string;
  userCode?: string;
  expiresAt: number;
}

const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const RETURN_PATH = '/ext/vtc/sso/return';

/**
 * Single-use login nonces in memory: one Panel process holds them, so a restart drops logins in
 * progress and the user starts again.
 */
export class NonceStore {
  private readonly entries = new Map<string, LoginNonce>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 600_000;
    this.max = opts.max ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  /** Null when the store is full of live nonces. */
  create(input: Omit<LoginNonce, 'expiresAt'>): string | null {
    if (this.entries.size >= this.max) this.sweep();
    if (this.entries.size >= this.max) return null;
    const nonce = randomBytes(24).toString('base64url');
    this.entries.set(nonce, { ...input, expiresAt: this.now() + this.ttlMs });
    return nonce;
  }

  /** Removes the nonce whatever the outcome, so it works once. */
  take(nonce: string): LoginNonce | null {
    const entry = this.entries.get(nonce);
    if (!entry) return null;
    this.entries.delete(nonce);
    return entry.expiresAt > this.now() ? entry : null;
  }

  sweep(): void {
    const time = this.now();
    for (const [nonce, entry] of this.entries) if (entry.expiresAt <= time) this.entries.delete(nonce);
  }
}

/** The nonce in the `url` round-trip, only when `url` points at `<publicBaseUrl>/ext/vtc/sso/return`. */
export function extractReturnNonce(url: string | undefined, publicBaseUrl: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== new URL(publicBaseUrl).origin || parsed.pathname !== RETURN_PATH) return null;
    const nonce = parsed.searchParams.get('n');
    return nonce && NONCE_PATTERN.test(nonce) ? nonce : null;
  } catch {
    return null;
  }
}
