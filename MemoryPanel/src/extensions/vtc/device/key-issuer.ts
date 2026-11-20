import { createHash, timingSafeEqual } from 'node:crypto';
import {
  MetaError,
  type ExtensionLogger,
  type ExtensionSecretsPort,
  type MetaFacade,
} from '../../../panel/extensions/types.js';
import type { DeviceRequest } from './device-flow.js';
import { WEB_INSTALL_ID, type DeviceStore } from './device-store.js';

export class KeyLimitError extends Error {
  constructor() {
    super('key_limit_exceeded');
    this.name = 'KeyLimitError';
  }
}

/** A device key is never stored, only this digest, so logout can tell the device's own key from the user's others. */
const keyDigest = (keyValue: string): string => createHash('sha256').update(keyValue).digest('hex');

function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

type Audit = (event: string, fields?: Record<string, unknown>) => void;

const DAY_MS = 86_400_000;
// A key that is already gone or the user's last one is not a failure of the swap.
const IGNORED_REVOKE_CODES = new Set(['user_key_not_found', 'last_key_cannot_revoke']);

/**
 * Issues and renews the per-user keys the extension hands out. It only ever touches keys it created and
 * tracks in the device store; the default key made with the Core user is never read, stored or revoked.
 */
export class KeyIssuer {
  private readonly now: () => Date;
  // Per user: two logins at once must not each create a key, or one of them would be left untracked.
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: {
      meta: MetaFacade;
      devices: DeviceStore;
      secrets: ExtensionSecretsPort;
      audit: Audit;
      logger: ExtensionLogger;
      keyTtlDays: number;
      now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  /** One tracked Core key per user for Panel web sessions, renewed at each web login. */
  issueWebKey(instanceId: string, coreUserId: string): Promise<{ userKey: string; keyId: string; expiresAt: string }> {
    return this.serialized(instanceId, coreUserId, () => this.issueWebKeyNow(instanceId, coreUserId));
  }

  /** Runs `task` after every earlier task of the same user, so two logins at once never both create a key. */
  private serialized<T>(instanceId: string, coreUserId: string, task: () => Promise<T>): Promise<T> {
    const queueKey = `${instanceId}\u0000${coreUserId}`;
    const run = (this.queues.get(queueKey) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => undefined);
    this.queues.set(queueKey, tail);
    void tail.then(() => {
      if (this.queues.get(queueKey) === tail) this.queues.delete(queueKey);
    });
    return run;
  }

  private async issueWebKeyNow(
    instanceId: string,
    coreUserId: string,
  ): Promise<{ userKey: string; keyId: string; expiresAt: string }> {
    const { meta, devices, secrets, audit } = this.deps;
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.deps.keyTtlDays * DAY_MS);
    const expiresIso = expiresAt.toISOString();
    const loginIso = now.toISOString();
    const row = devices.find(instanceId, coreUserId, WEB_INSTALL_ID);

    if (row?.encryptedKey) {
      const key = await meta.keys.get(instanceId, row.keyId);
      if (key && key.status === 'active' && key.user_id === coreUserId) {
        let value: string | null = null;
        try {
          value = secrets.decrypt(row.encryptedKey);
        } catch {
          // The local secret changed or the row is damaged: fall through and issue a new key.
        }
        if (value) {
          await meta.keys.update(instanceId, row.keyId, { expiresAt });
          await devices.upsert({ ...row, expiresAt: expiresIso, lastLoginAt: loginIso });
          return { userKey: value, keyId: row.keyId, expiresAt: expiresIso };
        }
      }
    }

    const created = await this.createKey(instanceId, coreUserId, 'panel-web', expiresAt);
    // Prune may already have revoked and dropped the old row (it had run out); do not revoke it twice.
    const replaced = row !== null && devices.find(instanceId, coreUserId, WEB_INSTALL_ID)?.keyId === row.keyId;
    try {
      await devices.upsert({
        instanceId,
        coreUserId,
        installId: WEB_INSTALL_ID,
        keyId: created.key_id,
        deviceName: 'Panel web',
        expiresAt: expiresIso,
        lastLoginAt: loginIso,
        encryptedKey: secrets.encrypt(created.key_value),
      });
    } catch (err) {
      // An untracked key could never be renewed or pruned, so do not leave one behind.
      await this.revokeQuietly(instanceId, created.key_id);
      throw err;
    }
    // Create first, revoke second: the person never has a moment without a working key.
    if (row && replaced && row.keyId !== created.key_id) await this.revokeQuietly(instanceId, row.keyId);
    audit('vtc.key.issued', { kind: 'web', key_id: created.key_id });
    return { userKey: created.key_value, keyId: created.key_id, expiresAt: expiresIso };
  }

  /** Prunes ran-out keys first (Core counts them toward its cap), then creates; a full cap is a KeyLimitError. */
  private async createKey(instanceId: string, coreUserId: string, name: string, expiresAt: Date) {
    await this.prune(instanceId, coreUserId);
    try {
      return await this.deps.meta.keys.create(instanceId, coreUserId, { name, expiresAt });
    } catch (err) {
      if (err instanceof MetaError && err.code === 'key_limit_exceeded') {
        this.deps.audit('vtc.key.limit_exceeded', { core_user_id: coreUserId });
        throw new KeyLimitError();
      }
      throw err;
    }
  }

  /**
   * One key per device. A device that still holds its key gets the same key with a later expiry and no value
   * back; a device that lost it (reinstall) gets a new key, and the old one is revoked only after that.
   */
  issueDeviceKey(
    instanceId: string,
    coreUserId: string,
    req: DeviceRequest,
  ): Promise<
    | { renewed: true; key_id: string; expires_at: string }
    | { renewed: false; key_id: string; key_value: string; expires_at: string }
  > {
    if (req.installId === WEB_INSTALL_ID) return Promise.reject(new Error('install id is reserved for the Panel web key'));
    return this.serialized(instanceId, coreUserId, () => this.issueDeviceKeyNow(instanceId, coreUserId, req));
  }

  private async issueDeviceKeyNow(instanceId: string, coreUserId: string, req: DeviceRequest) {
    const { meta, devices, audit } = this.deps;
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.deps.keyTtlDays * DAY_MS);
    const expiresIso = expiresAt.toISOString();
    const loginIso = now.toISOString();
    const row = devices.find(instanceId, coreUserId, req.installId);

    if (row && req.hasKey) {
      const key = await meta.keys.get(instanceId, row.keyId);
      // A key that ran out (logout sets the expiry to now) stays dead: renewing it would undo the logout, so
      // the device gets a new key like a reinstall does.
      const live = key?.expires_at == null || Date.parse(key.expires_at) > now.getTime();
      if (key && key.status === 'active' && key.user_id === coreUserId && live) {
        await meta.keys.update(instanceId, row.keyId, { expiresAt });
        await devices.upsert({ ...row, deviceName: req.deviceName, expiresAt: expiresIso, lastLoginAt: loginIso });
        return { renewed: true as const, key_id: row.keyId, expires_at: expiresIso };
      }
    }

    const created = await this.createKey(instanceId, coreUserId, `paseo:${req.deviceName}`, expiresAt);
    // Prune may already have revoked and dropped the old row (it had run out); do not revoke it twice.
    const replaced = row !== null && devices.find(instanceId, coreUserId, req.installId)?.keyId === row.keyId;
    try {
      // The value of a device key is never stored: only its owner holds it after this response.
      await devices.upsert({
        instanceId,
        coreUserId,
        installId: req.installId,
        keyId: created.key_id,
        deviceName: req.deviceName,
        expiresAt: expiresIso,
        lastLoginAt: loginIso,
        keyHash: keyDigest(created.key_value),
      });
    } catch (err) {
      // An untracked key could never be renewed or pruned, so do not leave one behind.
      await this.revokeQuietly(instanceId, created.key_id);
      throw err;
    }
    if (row && replaced && row.keyId !== created.key_id) await this.revokeQuietly(instanceId, row.keyId);
    audit('vtc.key.issued', { kind: 'device', key_id: created.key_id, replaced: Boolean(row) });
    return { renewed: false as const, key_id: created.key_id, key_value: created.key_value, expires_at: expiresIso };
  }

  /**
   * Logout: the key stops working now. Only the device's own key is accepted. It is not revoked and its row stays (with the expiry set to now), so
   * the next prune revokes it and frees the slot Core still counts for an expired key.
   */
  async expireDeviceKey(
    instanceId: string,
    userKey: string,
    installId: string,
  ): Promise<'ok' | 'invalid_key' | 'unknown_device'> {
    if (installId === WEB_INSTALL_ID) return 'unknown_device';
    const user = await this.deps.meta.auth.verify(instanceId, userKey);
    if (!user) return 'invalid_key';
    return this.serialized(instanceId, user.user_id, async () => {
      const { meta, devices, audit } = this.deps;
      const row = devices.find(instanceId, user.user_id, installId);
      if (!row) return 'unknown_device' as const;
      // Only the key this device holds may log it out; another key of the same user must not.
      if (!row.keyHash || !sameDigest(row.keyHash, keyDigest(userKey))) return 'invalid_key' as const;
      const now = this.now();
      await meta.keys.update(instanceId, row.keyId, { expiresAt: now });
      await devices.upsert({ ...row, expiresAt: now.toISOString() });
      audit('vtc.key.expired', { key_id: row.keyId });
      return 'ok' as const;
    });
  }

  /**
   * Revokes the user's tracked keys that ran out and drops their rows. Core counts expired keys that are
   * still active toward its cap, so this runs before every create.
   */
  protected async prune(instanceId: string, coreUserId: string): Promise<void> {
    const { meta, devices, logger, audit } = this.deps;
    const time = this.now().getTime();
    let count = 0;
    for (const row of devices.listForUser(instanceId, coreUserId)) {
      // A live key of the current install is kept (create first, revoke second); a dead one frees its slot now.
      if (Date.parse(row.expiresAt) > time) continue;
      try {
        await meta.keys.revoke(instanceId, row.keyId);
      } catch (err) {
        if (!(err instanceof MetaError)) throw err;
        if (err.code === 'last_key_cannot_revoke') {
          // Core keeps its last active key even when it ran out. Keep tracking it so it is revoked once the
          // replacement exists (same install) or at the next prune (another install).
          const existing = await meta.keys.get(instanceId, row.keyId);
          if (existing?.status === 'active') continue;
        } else if (!IGNORED_REVOKE_CODES.has(err.code)) {
          // Keep the row so the next login tries again.
          logger.warn('vtc key prune skipped', { code: err.code });
          continue;
        }
      }
      await devices.remove(instanceId, coreUserId, row.installId);
      count += 1;
    }
    if (count > 0) audit('vtc.key.pruned', { count });
  }

  /** Best effort: the caller already holds a working key, so a failed revoke must not fail the login. */
  private async revokeQuietly(instanceId: string, keyId: string): Promise<void> {
    try {
      await this.deps.meta.keys.revoke(instanceId, keyId);
    } catch (err) {
      this.deps.logger.warn('vtc key revoke skipped', { code: err instanceof MetaError ? err.code : 'unexpected' });
    }
  }
}
