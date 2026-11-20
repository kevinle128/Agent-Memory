import type { JsonDocument } from '../../../panel/extensions/types.js';

/** The install id of the Panel web session, so the web key is one more tracked key of the user. */
export const WEB_INSTALL_ID = 'panel-web';

export interface DeviceRecord {
  instanceId: string;
  coreUserId: string;
  installId: string;
  keyId: string;
  deviceName: string;
  expiresAt: string;
  lastLoginAt: string;
  /** Only for WEB_INSTALL_ID. The value of a device key is never stored. */
  encryptedKey?: string;
  /** SHA-256 of a device key, to recognise it at logout without keeping it. */
  keyHash?: string;
}

export interface DeviceFile {
  version: 1;
  devices: DeviceRecord[];
}

const same = (r: DeviceRecord, instanceId: string, coreUserId: string, installId: string): boolean =>
  r.instanceId === instanceId && r.coreUserId === coreUserId && r.installId === installId;

/** The keys the extension issued, one row per (instance, user, install). */
export class DeviceStore {
  constructor(private readonly doc: JsonDocument<DeviceFile>) {}

  find(instanceId: string, coreUserId: string, installId: string): DeviceRecord | null {
    const found = this.doc.read().devices.find((r) => same(r, instanceId, coreUserId, installId));
    return found ? { ...found } : null;
  }

  listForUser(instanceId: string, coreUserId: string): DeviceRecord[] {
    return this.doc
      .read()
      .devices.filter((r) => r.instanceId === instanceId && r.coreUserId === coreUserId)
      .map((r) => ({ ...r }));
  }

  async upsert(record: DeviceRecord): Promise<void> {
    await this.doc.update((current) => {
      const rest = current.devices.filter((r) => !same(r, record.instanceId, record.coreUserId, record.installId));
      return { ...current, devices: [...rest, { ...record }] };
    });
  }

  async remove(instanceId: string, coreUserId: string, installId: string): Promise<void> {
    if (!this.find(instanceId, coreUserId, installId)) return;
    await this.doc.update((current) => ({
      ...current,
      devices: current.devices.filter((r) => !same(r, instanceId, coreUserId, installId)),
    }));
  }
}
