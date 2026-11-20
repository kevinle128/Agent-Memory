import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeSsoUserData } from '../../../src/extensions/vtc/sso/triple-des.js';
import { vtcExtension } from '../../../src/extensions/vtc/index.js';
import { createExtensionHost } from '../../../src/panel/extensions/host.js';
import { createPanelFixture, stubMetaKernel, type PanelFixture } from '../support/panel-fixture.js';
import type { FakeCore } from './fake-core.js';

export const PRIVATE_KEY = 'test-private-key-not-real';
export const PUBLIC_KEY = 'test-public-key-not-real';

export const VTC_ENV: Record<string, string> = {
  PANEL_EXT_VTC_SSO_BASE_URL: 'https://sso.test.invalid/sso',
  PANEL_EXT_VTC_SERVICE_ID: '123456',
  PANEL_EXT_VTC_PRIVATE_KEY: PRIVATE_KEY,
  PANEL_EXT_VTC_PUBLIC_BASE_URL: 'https://panel.test.invalid',
};

export function makeUd(input: {
  email?: string;
  userId?: string;
  time: string;
  publicKey?: string;
  privateKey?: string;
  requestIp?: string;
}): string {
  return encodeSsoUserData(input.privateKey ?? PRIVATE_KEY, input.publicKey ?? PUBLIC_KEY, {
    email: input.email ?? 'a.b@vtc.vn',
    userId: input.userId ?? '10482',
    requestLoginDateTime: input.time,
    requestIp: input.requestIp ?? '10.0.0.1',
  });
}

export interface VtcAppOptions {
  /** Extra or replacement PANEL_EXT_VTC_* values. */
  env?: Record<string, string>;
  /** Extra or replacement Panel settings, for example an empty PANEL_AUTH_SESSION_SECURE. */
  settings?: Record<string, string>;
  /** What auth/verify returns for the instance api_key. */
  apiKeyUserType?: string;
  /** An in-memory Core to use instead of the fixed answers above. */
  core?: FakeCore;
  /** Runs before the extension opens its data files, for example to write a record. */
  prepare?: (dataDir: string) => void;
}

/** The login time the SSO writes for "now": local time in Vietnam, without a zone. */
export function ssoNow(offsetSeconds = 0): string {
  return new Date(Date.now() + 7 * 3600_000 + offsetSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

const fixtures: PanelFixture[] = [];

export function cleanupVtcApps(): void {
  while (fixtures.length) fixtures.pop()!.cleanup();
}

/** The real Panel app with only the VTC extension selected and a fake Core. */
export async function buildVtcApp(options: VtcAppOptions = {}) {
  const fixture = await createPanelFixture({ PANEL_AUTH_SESSION_SECURE: 'true', ...options.settings });
  fixtures.push(fixture);
  const { deps } = fixture;
  deps.config.extensions = { enabled: ['vtc'], dataDir: fixture.dataDir, strict: false };
  if (options.core) {
    options.core.install(deps);
  } else {
    stubMetaKernel(deps, (action) => {
      if (action === 'auth/verify') {
        return {
          data: { valid: true, user: { user_id: 'usr-admin', user_type: options.apiKeyUserType ?? 'system_admin' } },
        };
      }
      return { data: {} };
    });
  }
  options.prepare?.(join(fixture.dataDir, 'vtc'));
  const host = createExtensionHost({ deps, catalog: [vtcExtension], env: { ...VTC_ENV, ...options.env } });
  if (host) deps.extensions = host;
  const { buildPanelApp } = await import('../../../src/panel/http/app.js');
  return { ...fixture, host: host!, app: buildPanelApp(deps) };
}

type VtcApp = Awaited<ReturnType<typeof buildVtcApp>>;

/** Starts a web login and returns what the browser holds when the SSO sends it back. */
export async function startWebLogin(app: VtcApp['app'], returnTo?: string) {
  const query = returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : '';
  const res = await app.request(`/ext/vtc/sso/login?flow=web${query}`);
  const location = new URL(res.headers.get('location')!);
  const cookie = res.headers.getSetCookie().find((line) => line.startsWith('tdai_ext_vtc_state='))!.split(';')[0]!;
  return { returnUrl: location.searchParams.get('url')!, cookie };
}

/** The request the SSO triggers: the browser lands on `continue` with the ticket and the state cookie. */
export function continueRequest(
  app: VtcApp['app'],
  login: { returnUrl: string; cookie?: string },
  ud: string | undefined,
  extra: { r?: string; headers?: Record<string, string> } = {},
) {
  const params = new URLSearchParams({ url: login.returnUrl, r: extra.r ?? '1' });
  if (ud !== undefined) params.set('ud', ud);
  return app.request(`/ext/vtc/sso/continue?${params.toString()}`, {
    headers: { ...(login.cookie ? { cookie: login.cookie } : {}), ...extra.headers },
  });
}

/** Writes a data file of the extension before the app starts. */
export function writeExtensionFile(dir: string, name: string, content: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(content));
}
