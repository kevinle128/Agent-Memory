import type { MetaFacade } from '../../../panel/extensions/types.js';
import type { LinkStore } from './link-store.js';
import type { PendingRecord, PendingStore } from './pending-store.js';

export type AccountDecision =
  | { kind: 'approved'; coreUserId: string }
  | { kind: 'pending'; record: PendingRecord }
  | { kind: 'rejected'; record: PendingRecord };

export interface SsoPerson {
  vtcUserId: string;
  email: string;
}

export const VTC_AUTH_PROVIDER = 'vtc-sso';

type Audit = (event: string, fields?: Record<string, unknown>) => void;

/**
 * Decides what a person who passed the SSO may do. It reads Core and never writes to it: Core users are
 * created only when an administrator approves. An error from Core is never read as approval.
 */
export class AccountResolver {
  constructor(
    private readonly deps: { meta: MetaFacade; pending: PendingStore; links: LinkStore; audit: Audit },
  ) {}

  async resolve(
    instanceId: string,
    person: SsoPerson,
    opts: { source: 'web' | 'device'; touch: boolean },
  ): Promise<AccountDecision> {
    const { meta, pending, links, audit } = this.deps;
    const { vtcUserId, email } = person;

    const known = pending.findByVtcUser(instanceId, vtcUserId);
    // A person with an open or refused first request has no access until an administrator approves. The link
    // is written during approval, so one left by an approval that failed or was refused must not count.
    const awaitingFirstApproval = known?.kind === 'new';

    // The first stored email wins. Only the fact of a difference is logged, never the addresses.
    if (known && known.email !== email) {
      audit('vtc.identity.email_mismatch', { vtc_user_id: vtcUserId, email_changed: true });
    }
    // A refused person gets no access, so Core is not read and the links are not touched.
    if (known?.status === 'rejected') return this.rejected(instanceId, person, known, opts);

    let coreUserId: string | null = null;
    const link = awaitingFirstApproval ? null : links.find(instanceId, vtcUserId);
    if (link) {
      if (await meta.users.get(instanceId, link.coreUserId)) {
        coreUserId = link.coreUserId;
      } else {
        // The Core user was deleted; the person starts again as a new request.
        await links.remove(instanceId, vtcUserId);
        audit('vtc.link.dropped', { vtc_user_id: vtcUserId, core_user_id: link.coreUserId });
      }
    }
    if (!coreUserId && !awaitingFirstApproval) {
      // A lost links file is rebuilt from the account Core already bound to this VTC user.
      const found = await meta.users.findByExternal(instanceId, VTC_AUTH_PROVIDER, vtcUserId);
      if (found) {
        coreUserId = found.user_id;
        await links.upsert({
          instanceId,
          vtcUserId,
          coreUserId,
          mode: 'recovered',
          linkedAt: new Date().toISOString(),
        });
        audit('vtc.link.recovered', { vtc_user_id: vtcUserId, core_user_id: coreUserId });
      }
    }

    if (!coreUserId) {
      const record = await pending.recordLogin({
        instanceId,
        vtcUserId,
        email,
        kind: 'new',
        source: opts.source,
        touch: opts.touch,
      });
      return { kind: 'pending', record };
    }

    const teams = await meta.teams.listForUser(instanceId, coreUserId);
    if (teams.total > 0) {
      if (known) {
        // An administrator may have refused the request while Core was being read: the refusal wins.
        const current = pending.get(known.id);
        if (current?.status === 'rejected') return this.rejected(instanceId, person, current, opts);
        if (current) await pending.remove(current.id);
      }
      return { kind: 'approved', coreUserId };
    }
    const record = await pending.recordLogin({
      instanceId,
      vtcUserId,
      email,
      kind: 'no_team',
      coreUserId,
      source: opts.source,
      touch: opts.touch,
    });
    return { kind: 'pending', record };
  }

  private async rejected(
    instanceId: string,
    person: SsoPerson,
    known: PendingRecord,
    opts: { source: 'web' | 'device'; touch: boolean },
  ): Promise<AccountDecision> {
    const record = await this.deps.pending.recordLogin({
      instanceId,
      vtcUserId: person.vtcUserId,
      email: person.email,
      kind: known.kind,
      ...(known.coreUserId ? { coreUserId: known.coreUserId } : {}),
      source: opts.source,
      touch: opts.touch,
    });
    return { kind: 'rejected', record };
  }
}
