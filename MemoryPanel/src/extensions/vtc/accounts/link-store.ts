import type { JsonDocument } from '../../../panel/extensions/types.js';

export interface LinkRecord {
  instanceId: string;
  vtcUserId: string;
  coreUserId: string;
  mode: 'created' | 'linked' | 'recovered';
  linkedAt: string;
  linkedBy?: string;
}

export interface LinkFile {
  version: 1;
  links: LinkRecord[];
}

/**
 * Which Core user a VTC person is. Kept here instead of in `external_id` because rebinding that field would
 * break an existing WOA binding of the same Core user.
 */
export class LinkStore {
  constructor(private readonly doc: JsonDocument<LinkFile>) {}

  find(instanceId: string, vtcUserId: string): LinkRecord | null {
    const found = this.doc.read().links.find((l) => l.instanceId === instanceId && l.vtcUserId === vtcUserId);
    return found ? { ...found } : null;
  }

  findByCoreUser(instanceId: string, coreUserId: string): LinkRecord | null {
    const found = this.doc.read().links.find((l) => l.instanceId === instanceId && l.coreUserId === coreUserId);
    return found ? { ...found } : null;
  }

  async upsert(link: LinkRecord): Promise<void> {
    await this.doc.update((current) => {
      const rest = current.links.filter((l) => !(l.instanceId === link.instanceId && l.vtcUserId === link.vtcUserId));
      return { ...current, links: [...rest, { ...link }] };
    });
  }

  async remove(instanceId: string, vtcUserId: string): Promise<void> {
    if (!this.find(instanceId, vtcUserId)) return;
    await this.doc.update((current) => ({
      ...current,
      links: current.links.filter((l) => !(l.instanceId === instanceId && l.vtcUserId === vtcUserId)),
    }));
  }
}
