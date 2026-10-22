/**
 * DeviceSetupService — per-user registry of the devices that have the client hook installed.
 *
 * Permission: a user may read and write only the rows of their own user_id.
 * A system admin may act on any user_id. Errors are thrown as MetadataError,
 * and the router maps them to the envelope error code.
 */

import type { IMetadataStore } from "../store/interface.js";
import type { V3AuthContext } from "../router/auth.js";
import { MetadataError } from "./metadata-service.js";
import type { DeviceSetupEntity } from "../types.js";

/** Router input. os, arch and hostname are optional and are stored as "" when absent. */
export interface UpsertDeviceInput {
  user_id: string;
  device_id: string;
  client: string;
  os?: string;
  arch?: string;
  hostname?: string;
  hook_version: string;
}

export interface IDeviceSetupService {
  upsert(ctx: V3AuthContext, input: UpsertDeviceInput): Promise<DeviceSetupEntity>;
  list(ctx: V3AuthContext, userId: string): Promise<{ items: DeviceSetupEntity[] }>;
}

export class DeviceSetupService implements IDeviceSetupService {
  constructor(private readonly store: IMetadataStore) {}

  async upsert(ctx: V3AuthContext, input: UpsertDeviceInput): Promise<DeviceSetupEntity> {
    this.assertCanAccess(ctx, input.user_id);
    return await this.store.upsertDeviceSetup({
      user_id: input.user_id,
      device_id: input.device_id,
      client: input.client,
      os: input.os ?? "",
      arch: input.arch ?? "",
      hostname: input.hostname ?? "",
      hook_version: input.hook_version,
    });
  }

  async list(ctx: V3AuthContext, userId: string): Promise<{ items: DeviceSetupEntity[] }> {
    this.assertCanAccess(ctx, userId);
    return { items: await this.store.listDeviceSetups(userId) };
  }

  private assertCanAccess(ctx: V3AuthContext, targetUserId: string): void {
    if (ctx.isAdmin || ctx.isSystemAdmin || ctx.userId === targetUserId) return;
    throw new MetadataError("permission_denied", "user_id does not match caller");
  }
}
