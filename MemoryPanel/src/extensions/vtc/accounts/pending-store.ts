import { ulid } from 'ulid';
import type { JsonDocument } from '../../../panel/extensions/types.js';

export interface PendingRecord {
  id: string;
  instanceId: string;
  vtcUserId: string;
  email: string;
  /** 'no_team' is a linked Core user who has no active team. */
  kind: 'new' | 'no_team';
  coreUserId?: string;
  status: 'pending' | 'rejected';
  /** Where the person first logged in. */
  source: 'web' | 'device';
  firstLoginAt: string;
  lastLoginAt: string;
  loginCount: number;
  rejectedAt?: string;
  rejectedBy?: string;
  reason?: string;
}

export interface PendingFile {
  version: 1;
  records: PendingRecord[];
}

export interface RecordLoginInput {
  instanceId: string;
  vtcUserId: string;
  email: string;
  kind: 'new' | 'no_team';
  coreUserId?: string;
  source: 'web' | 'device';
  /** False keeps the counters, for example while a device polls. */
  touch: boolean;
}

/** People who logged in through the SSO and wait for an administrator. (instanceId, vtcUserId) is unique. */
export class PendingStore {
  constructor(
    private readonly doc: JsonDocument<PendingFile>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  findByVtcUser(instanceId: string, vtcUserId: string): PendingRecord | null {
    const found = this.doc.read().records.find((r) => r.instanceId === instanceId && r.vtcUserId === vtcUserId);
    return found ? { ...found } : null;
  }

  get(id: string): PendingRecord | null {
    const found = this.doc.read().records.find((r) => r.id === id);
    return found ? { ...found } : null;
  }

  /** Newest login first. */
  list(instanceId: string): PendingRecord[] {
    return this.doc
      .read()
      .records.filter((r) => r.instanceId === instanceId)
      .map((r) => ({ ...r }))
      .sort((a, b) => b.lastLoginAt.localeCompare(a.lastLoginAt));
  }

  /** Creates or refreshes the record of a person who logged in. A rejected record stays rejected. */
  async recordLogin(input: RecordLoginInput): Promise<PendingRecord> {
    const at = this.now().toISOString();
    let result!: PendingRecord;
    await this.doc.update((current) => {
      const index = current.records.findIndex(
        (r) => r.instanceId === input.instanceId && r.vtcUserId === input.vtcUserId,
      );
      if (index < 0) {
        result = {
          id: `pnd_${ulid()}`,
          instanceId: input.instanceId,
          vtcUserId: input.vtcUserId,
          email: input.email,
          kind: input.kind,
          ...(input.coreUserId ? { coreUserId: input.coreUserId } : {}),
          status: 'pending',
          source: input.source,
          firstLoginAt: at,
          lastLoginAt: at,
          loginCount: 1,
        };
        return { ...current, records: [...current.records, result] };
      }
      const existing = current.records[index]!;
      const next: PendingRecord = { ...existing };
      // The email stays as first stored: the ticket has no MAC, so a later ticket could carry a spliced address.
      // The rest of the details only follow the SSO while a decision is open.
      if (existing.status === 'pending') {
        next.kind = input.kind;
        if (input.coreUserId) next.coreUserId = input.coreUserId;
        else delete next.coreUserId;
      }
      if (input.touch) {
        next.lastLoginAt = at;
        next.loginCount = existing.loginCount + 1;
      }
      result = next;
      return { ...current, records: current.records.map((r, i) => (i === index ? next : r)) };
    });
    return { ...result };
  }

  async reject(id: string, actorUserId: string, reason?: string): Promise<PendingRecord | null> {
    let result: PendingRecord | null = null;
    await this.doc.update((current) => {
      const index = current.records.findIndex((r) => r.id === id);
      if (index < 0) return current;
      const next: PendingRecord = {
        ...current.records[index]!,
        status: 'rejected',
        rejectedAt: this.now().toISOString(),
        rejectedBy: actorUserId,
      };
      if (reason) next.reason = reason;
      else delete next.reason;
      result = next;
      return { ...current, records: current.records.map((r, i) => (i === index ? next : r)) };
    });
    return result ? { ...(result as PendingRecord) } : null;
  }

  /**
   * Puts a refused request back to pending. The record is kept, not deleted: a request that is gone looks like
   * a person nobody has seen, so a Core user an earlier failed approval left behind would be given access
   * without a new approval.
   */
  async reopen(id: string): Promise<PendingRecord | null> {
    let result: PendingRecord | null = null;
    await this.doc.update((current) => {
      const index = current.records.findIndex((r) => r.id === id);
      if (index < 0) return current;
      const next: PendingRecord = { ...current.records[index]!, status: 'pending' };
      delete next.rejectedAt;
      delete next.rejectedBy;
      delete next.reason;
      result = next;
      return { ...current, records: current.records.map((r, i) => (i === index ? next : r)) };
    });
    return result ? { ...(result as PendingRecord) } : null;
  }

  async remove(id: string): Promise<void> {
    if (!this.doc.read().records.some((r) => r.id === id)) return;
    await this.doc.update((current) => ({ ...current, records: current.records.filter((r) => r.id !== id) }));
  }
}
