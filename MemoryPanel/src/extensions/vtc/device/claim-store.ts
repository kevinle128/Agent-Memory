import { createHash, randomBytes } from 'node:crypto';
import type { JsonDocument } from '../../../panel/extensions/types.js';

export const CLAIM_TTL_DAYS = 7;
const DAY_MS = 86_400_000;

export interface ClaimRecord {
  tokenHash: string;
  instanceId: string;
  vtcUserId: string;
  email: string;
  installId: string;
  deviceName: string;
  hasKey: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface ClaimFile {
  version: 1;
  claims: ClaimRecord[];
}

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * What a person who waits for an admin gets back from the device flow. The token is stored hashed and is
 * bound to the install that asked, so only that plugin can collect the key after approval.
 */
export class ClaimStore {
  private readonly now: () => Date;

  constructor(
    private readonly doc: JsonDocument<ClaimFile>,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** One live claim per (instance, VTC user, install); a new one replaces the old. */
  async create(input: Omit<ClaimRecord, 'tokenHash' | 'createdAt' | 'expiresAt'>): Promise<{ token: string }> {
    const token = randomBytes(32).toString('base64url');
    const created = this.now();
    const record: ClaimRecord = {
      ...input,
      tokenHash: hashOf(token),
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + CLAIM_TTL_DAYS * DAY_MS).toISOString(),
    };
    await this.doc.update((current) => ({
      ...current,
      claims: [
        ...current.claims.filter(
          (c) => !(c.instanceId === input.instanceId && c.vtcUserId === input.vtcUserId && c.installId === input.installId),
        ),
        record,
      ],
    }));
    return { token };
  }

  findByToken(token: string): ClaimRecord | null {
    const hash = hashOf(token);
    const found = this.doc.read().claims.find((c) => c.tokenHash === hash);
    return found ? { ...found } : null;
  }

  isExpired(record: ClaimRecord): boolean {
    return Date.parse(record.expiresAt) <= this.now().getTime();
  }

  async remove(tokenHash: string): Promise<void> {
    if (!this.doc.read().claims.some((c) => c.tokenHash === tokenHash)) return;
    await this.doc.update((current) => ({ ...current, claims: current.claims.filter((c) => c.tokenHash !== tokenHash) }));
  }

  async sweepExpired(): Promise<void> {
    const time = this.now().getTime();
    if (!this.doc.read().claims.some((c) => Date.parse(c.expiresAt) <= time)) return;
    await this.doc.update((current) => ({
      ...current,
      claims: current.claims.filter((c) => Date.parse(c.expiresAt) > time),
    }));
  }
}
