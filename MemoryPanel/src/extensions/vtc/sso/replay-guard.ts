import { createHash } from 'node:crypto';

/** Remembers tickets until the moment they can no longer pass the freshness check, so a captured URL cannot log in twice. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: { max?: number; now?: () => number } = {}) {
    this.max = opts.max ?? 50_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Records the login until `until` (epoch ms, inclusive). False if the same login was seen and is still
   * remembered, or if the guard is full (fail closed). The ticket is 3DES-ECB without a MAC, so a person can
   * copy or drop ciphertext blocks and get a new ticket that decodes to the same fields. The key is therefore
   * the identity the ticket proves (VTC user ID and the raw login time), never the ciphertext.
   */
  firstUse(identity: { userId: string; loginTime: string }, until: number): boolean {
    const key = createHash('sha256').update(`${identity.userId}\0${identity.loginTime.trim()}`).digest('hex');
    const time = this.now();
    const expires = this.seen.get(key);
    if (expires !== undefined && expires >= time) return false;
    if (this.seen.size >= this.max) this.sweep();
    if (this.seen.size >= this.max) return false;
    this.seen.set(key, until);
    return true;
  }

  sweep(): void {
    const time = this.now();
    for (const [key, expires] of this.seen) if (expires < time) this.seen.delete(key);
  }
}
