import type { ExtensionHooks, PanelExtension } from '../../panel/extensions/types.js';
import { vtcConfigSchema, type VtcConfig } from './config.js';
import { AccountResolver } from './accounts/account-resolver.js';
import { LinkStore, type LinkFile } from './accounts/link-store.js';
import { PendingStore, type PendingFile } from './accounts/pending-store.js';
import { ClaimStore, type ClaimFile } from './device/claim-store.js';
import { DeviceFlow } from './device/device-flow.js';
import { DeviceStore, type DeviceFile } from './device/device-store.js';
import { KeyIssuer } from './device/key-issuer.js';
import { registerAdminRoutes } from './http/admin-routes.js';
import { registerDeviceApiRoutes, registerDevicePageRoutes } from './http/device-routes.js';
import { registerSsoRoutes } from './http/sso-routes.js';
import { NonceStore } from './sso/nonce-store.js';
import { ReplayGuard } from './sso/replay-guard.js';
import { VtcSsoProvider } from './sso/vtc-sso-provider.js';

const SWEEP_INTERVAL_MS = 60_000;

export const vtcExtension: PanelExtension<VtcConfig> = {
  id: 'vtc',
  version: '1.0.0',
  apiVersion: 1,
  displayName: 'VTC Mail login',
  configSchema: vtcConfigSchema,
  register(ctx): ExtensionHooks {
    const { config } = ctx;
    const instanceId = config.instanceId ?? ctx.instances.resolveDefault();
    if (!instanceId || !ctx.instances.has(instanceId)) {
      throw new Error('PANEL_EXT_VTC_INSTANCE_ID does not name a configured instance');
    }
    // The Panel defaults the Secure flag from the WOA URL only, so an https public URL needs it set by hand.
    if (new URL(config.publicBaseUrl).protocol === 'https:' && !ctx.auth.cookieSecure) {
      throw new Error('PANEL_AUTH_SESSION_SECURE must be true when PANEL_EXT_VTC_PUBLIC_BASE_URL uses https');
    }

    // An unreadable file throws here, so the extension fails and the file is never overwritten.
    const pending = new PendingStore(ctx.storage.json<PendingFile>('pending', { version: 1, records: [] }));
    const links = new LinkStore(ctx.storage.json<LinkFile>('links', { version: 1, links: [] }));
    const devices = new DeviceStore(ctx.storage.json<DeviceFile>('devices', { version: 1, devices: [] }));
    const claims = new ClaimStore(ctx.storage.json<ClaimFile>('claims', { version: 1, claims: [] }));
    const flow = new DeviceFlow({ ttlMs: config.deviceCodeTtlSeconds * 1000, intervalSec: 5 });
    const resolver = new AccountResolver({ meta: ctx.meta, pending, links, audit: ctx.audit });
    const keys = new KeyIssuer({
      meta: ctx.meta,
      devices,
      secrets: ctx.secrets,
      audit: ctx.audit,
      logger: ctx.logger,
      keyTtlDays: config.keyTtlDays,
    });

    const replay = new ReplayGuard();
    const nonces = new NonceStore();
    const provider = new VtcSsoProvider(config, replay);
    registerSsoRoutes(ctx.http.pages, {
      config,
      instanceId,
      provider,
      nonces,
      auth: ctx.auth,
      logger: ctx.logger,
      audit: ctx.audit,
      loginLimiter: ctx.rateLimit('sso-login', { perMinute: 30 }),
      continueLimiter: ctx.rateLimit('sso-continue', { perMinute: 30 }),
      meta: ctx.meta,
      resolver,
      keys,
      flow,
    });
    registerDevicePageRoutes(ctx.http.pages, { flow, auth: ctx.auth, limiter: ctx.rateLimit('device-page', { perMinute: 30 }) });
    registerDeviceApiRoutes(ctx.http.api, {
      config,
      instanceId,
      flow,
      claims,
      resolver,
      keys,
      meta: ctx.meta,
      audit: ctx.audit,
      logger: ctx.logger,
      limiters: {
        start: ctx.rateLimit('device-start', { perMinute: 10 }),
        token: ctx.rateLimit('device-token', { perMinute: 60 }),
        claim: ctx.rateLimit('device-claim', { perMinute: 10 }),
        logout: ctx.rateLimit('device-logout', { perMinute: 10 }),
      },
    });
    registerAdminRoutes(ctx.http.api, {
      instanceId,
      auth: ctx.auth,
      meta: ctx.meta,
      pending,
      links,
      audit: ctx.audit,
      logger: ctx.logger,
    });
    ctx.web.advertise({ pages: [{ id: 'pending_users', visible_to: 'system_admin' }], loginMethodIds: ['vtc'] });
    // Last, so a failure above leaves no provider registered.
    ctx.auth.registerProvider(provider);

    let timer: NodeJS.Timeout | undefined;
    return {
      async start() {
        timer = setInterval(() => {
          nonces.sweep();
          replay.sweep();
          flow.sweep();
          // A failed sweep only leaves expired claims for the next round.
          void claims.sweepExpired().catch((err: unknown) => {
            ctx.logger.warn('vtc claim sweep failed', { code: err instanceof Error ? err.name : 'unexpected' });
          });
        }, SWEEP_INTERVAL_MS);
        timer.unref();
        if (!(await ctx.meta.system.verify(instanceId))) {
          throw new Error(
            'no system admin user key in Core: make the instance api_key one, or set PANEL_EXTENSIONS_SYSTEM_USER_KEY',
          );
        }
      },
      async stop() {
        if (timer) clearInterval(timer);
        timer = undefined;
      },
    };
  },
};
