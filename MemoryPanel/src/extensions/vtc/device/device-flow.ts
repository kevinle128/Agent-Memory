import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export interface DeviceRequest {
  installId: string;
  deviceName: string;
  hasKey: boolean;
}

export type DeviceOutcome =
  | { kind: 'approved'; coreUserId: string; subject: string; email: string }
  | { kind: 'pending'; subject: string; email: string }
  | { kind: 'rejected' };

export type PollResult =
  | { status: 'authorization_pending' }
  | { status: 'slow_down' }
  | { status: 'expired_token' }
  /** `ticket` is handed back to `complete` or `release` once the answer is built. */
  | { status: 'done'; ticket: string; request: DeviceRequest; outcome: DeviceOutcome };

/** No I, O, 0 or 1: a person reads the code from a screen and types it. */
export const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USER_CODE_LENGTH = 8;
const USER_CODE_ATTEMPTS = 20;
// Long enough to read the device page and press the button, short enough that a stale page is useless.
const CONFIRM_TTL_MS = 5 * 60_000;

/** Upper-cases, drops spaces and dashes, and returns `XXXX-XXXX`, or null when the input is not a code. */
export function normalizeUserCode(input: string | undefined): string | null {
  if (!input) return null;
  const compact = input.toUpperCase().replace(/[\s-]/g, '');
  if (compact.length !== USER_CODE_LENGTH) return null;
  for (const ch of compact) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface Entry {
  userCode: string;
  request: DeviceRequest;
  expiresAt: number;
  lastPollAt: number;
  outcome?: DeviceOutcome;
  /** True while a poll holds the decided outcome and builds the answer from it. */
  issuing?: boolean;
  /** The page confirmation of this code, kept as a hash. */
  confirm?: { hash: string; expiresAt: number };
}

/**
 * Device codes in memory (RFC 8628 in shape). One Panel process holds them, so a restart drops logins in
 * progress and the person starts again. The device code is kept only as its hash.
 */
export class DeviceFlow {
  private readonly byHash = new Map<string, Entry>();
  private readonly byUserCode = new Map<string, string>();
  private readonly now: () => number;
  private readonly max: number;

  constructor(
    private readonly opts: { ttlMs: number; intervalSec: number; max?: number; now?: () => number },
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.max = opts.max ?? 5000;
  }

  /** Null when the store is full of live codes. */
  start(req: DeviceRequest): { deviceCode: string; userCode: string; expiresIn: number; interval: number } | null {
    if (this.byHash.size >= this.max) this.sweep();
    if (this.byHash.size >= this.max) return null;
    let userCode: string | null = null;
    for (let attempt = 0; attempt < USER_CODE_ATTEMPTS && !userCode; attempt += 1) {
      let raw = '';
      for (let i = 0; i < USER_CODE_LENGTH; i += 1) raw += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
      const candidate = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      if (!this.byUserCode.has(candidate)) userCode = candidate;
    }
    if (!userCode) return null;
    const deviceCode = randomBytes(32).toString('base64url');
    const time = this.now();
    const hash = sha256Hex(deviceCode);
    this.byHash.set(hash, { userCode, request: { ...req }, expiresAt: time + this.opts.ttlMs, lastPollAt: time });
    this.byUserCode.set(userCode, hash);
    return { deviceCode, userCode, expiresIn: Math.floor(this.opts.ttlMs / 1000), interval: this.opts.intervalSec };
  }

  /** Only while the code is undecided and unexpired. */
  findByUserCode(userCode: string): { request: DeviceRequest; expiresAt: number } | null {
    const entry = this.liveByUserCode(userCode);
    return entry && !entry.outcome ? { request: { ...entry.request }, expiresAt: entry.expiresAt } : null;
  }

  /** False when the code is unknown, expired or already decided. */
  decide(userCode: string, outcome: DeviceOutcome): boolean {
    const entry = this.liveByUserCode(userCode);
    if (!entry || entry.outcome) return false;
    entry.outcome = outcome;
    return true;
  }

  /**
   * `done` locks the decided outcome: a poll that comes while the answer is built sees `authorization_pending`,
   * so a key is never minted twice. The caller ends it with `complete` (answer sent) or `release` (the answer
   * failed before a key went out, so the next poll tries again).
   */
  poll(deviceCode: string): PollResult {
    const hash = sha256Hex(deviceCode);
    const entry = this.byHash.get(hash);
    if (!entry) return { status: 'expired_token' };
    const time = this.now();
    if (entry.expiresAt <= time) {
      this.remove(hash, entry);
      return { status: 'expired_token' };
    }
    // A refused poll does not move the mark, so a client that backs off is served as soon as the interval passed.
    if (time - entry.lastPollAt < this.opts.intervalSec * 1000) return { status: 'slow_down' };
    entry.lastPollAt = time;
    if (!entry.outcome || entry.issuing) return { status: 'authorization_pending' };
    entry.issuing = true;
    return { status: 'done', ticket: hash, request: entry.request, outcome: entry.outcome };
  }

  /** The answer went out: the code is spent and the outcome is never handed out again. */
  complete(ticket: string): void {
    const entry = this.byHash.get(ticket);
    if (entry) this.remove(ticket, entry);
  }

  /** The answer could not be built: unlock the outcome for the next poll. */
  release(ticket: string): void {
    const entry = this.byHash.get(ticket);
    if (entry) delete entry.issuing;
  }

  /**
   * One-time proof that the person saw the device page (RFC 8628 section 5.4). Only the page route issues
   * it, and the login route asks for it, so a link that goes straight to the login cannot approve a device.
   * A later page view replaces the earlier token.
   */
  issueConfirm(userCode: string): string | null {
    const entry = this.liveByUserCode(userCode);
    if (!entry || entry.outcome) return null;
    const token = randomBytes(24).toString('base64url');
    entry.confirm = { hash: sha256Hex(token), expiresAt: Math.min(this.now() + CONFIRM_TTL_MS, entry.expiresAt) };
    return token;
  }

  /** True once per issued token. A wrong token does not use it up, so a stray request cannot cancel the person's own. */
  takeConfirm(userCode: string, token: string | undefined): boolean {
    const entry = this.liveByUserCode(userCode);
    const confirm = entry?.confirm;
    if (!entry || !confirm || !token) return false;
    if (confirm.expiresAt <= this.now()) {
      delete entry.confirm;
      return false;
    }
    const given = Buffer.from(sha256Hex(token));
    const stored = Buffer.from(confirm.hash);
    if (given.length !== stored.length || !timingSafeEqual(given, stored)) return false;
    delete entry.confirm;
    return true;
  }

  sweep(): void {
    const time = this.now();
    for (const [hash, entry] of this.byHash) if (entry.expiresAt <= time) this.remove(hash, entry);
  }

  private liveByUserCode(userCode: string): Entry | null {
    const hash = this.byUserCode.get(userCode);
    const entry = hash ? this.byHash.get(hash) : undefined;
    if (!hash || !entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.remove(hash, entry);
      return null;
    }
    return entry;
  }

  private remove(hash: string, entry: Entry): void {
    this.byHash.delete(hash);
    this.byUserCode.delete(entry.userCode);
  }
}
