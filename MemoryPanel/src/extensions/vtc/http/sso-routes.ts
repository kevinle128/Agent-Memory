import type { Context, Hono } from 'hono';
import { buildExpiredSessionCookie, buildSessionCookie, readCookie } from '../../../panel/auth/cookies.js';
import {
  MetaError,
  type ExtensionAuthPort,
  type ExtensionContext,
  type ExtensionLogger,
  type MetaFacade,
  type RateLimiter,
} from '../../../panel/extensions/types.js';
import type { AccountResolver } from '../accounts/account-resolver.js';
import type { VtcConfig } from '../config.js';
import { normalizeUserCode, type DeviceFlow, type DeviceOutcome } from '../device/device-flow.js';
import { KeyLimitError, type KeyIssuer } from '../device/key-issuer.js';
import { extractReturnNonce, type NonceStore } from '../sso/nonce-store.js';
import type { VtcFailReason, VtcSsoProvider } from '../sso/vtc-sso-provider.js';
import { DEVICE_CONFIRM_COOKIE } from './device-routes.js';
import { htmlResponse, pickLang, redirectResponse, renderPage, type ErrorCode, type PageInput } from './pages.js';

export interface SsoRouteDeps {
  config: VtcConfig;
  instanceId: string;
  provider: VtcSsoProvider;
  nonces: NonceStore;
  auth: ExtensionAuthPort;
  logger: ExtensionLogger;
  audit: ExtensionContext<VtcConfig>['audit'];
  loginLimiter: RateLimiter;
  continueLimiter: RateLimiter;
  meta: MetaFacade;
  resolver: AccountResolver;
  keys: KeyIssuer;
  flow: DeviceFlow;
}

const FAILURE_PAGE: Record<VtcFailReason, ErrorCode> = {
  sso_failed: 'sso_failed',
  missing_ticket: 'unreadable',
  decrypt_failed: 'unreadable',
  malformed: 'unreadable',
  time_unparsed: 'expired',
  stale: 'expired',
  clock_skew: 'expired',
  replayed: 'replayed',
};

function errorCodeOf(err: unknown): string {
  return err instanceof MetaError ? err.code : 'unexpected';
}

export const STATE_COOKIE = 'tdai_ext_vtc_state';
const STATE_COOKIE_MAX_AGE_SECONDS = 600;

// Browsers drop tabs and newlines inside a URL and read a backslash as a slash, so any of them can turn
// "/<TAB>/host" or "/\host" into a protocol-relative URL.
const UNSAFE_PATH_CHARS = /[\x00-\x1f\x7f\\]/;

function isPlainPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !UNSAFE_PATH_CHARS.test(value);
}

/**
 * A same-origin absolute path only. The value and its percent-decoded form must both be plain paths (a
 * consumer that decodes once must not find "//host" or a control character), and the value must resolve
 * against the public base URL to the same origin and a plain path. The resolved form is returned.
 */
export function safeReturnTo(value: string | undefined, publicBaseUrl: string): string {
  if (!value || !isPlainPath(value)) return '/';
  try {
    if (!isPlainPath(decodeURIComponent(value))) return '/';
    const base = new URL(publicBaseUrl);
    const resolved = new URL(value, base);
    // Dot segments can leave "//host" after resolving ("/.//host"), so the resolved path is checked again.
    if (resolved.origin !== base.origin || !isPlainPath(resolved.pathname)) return '/';
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/';
  }
}

export function registerSsoRoutes(pages: Hono, deps: SsoRouteDeps): void {
  const { config, provider, nonces, auth } = deps;

  const logoutHref = () => provider.buildLogoutUrl(`${config.publicBaseUrl}/`);

  function errorPage(c: Context, status: number, error: ErrorCode): Response {
    const lang = pickLang(c.req.header('accept-language'));
    return htmlResponse(c, status, renderPage({ lang, kind: 'error', error }));
  }

  pages.get('/sso/login', (c) => {
    if (!deps.loginLimiter.allow(c)) return errorPage(c, 429, 'busy');
    const flowName = c.req.query('flow');
    if (flowName !== 'web' && flowName !== 'device') return errorPage(c, 400, 'bad_request');
    const requested = c.req.query('instance_id');
    if (requested !== undefined && requested !== '' && requested !== deps.instanceId) {
      return errorPage(c, 400, 'wrong_instance');
    }
    let userCode: string | undefined;
    if (flowName === 'device') {
      // A code that is gone must not start a login nobody can finish.
      const code = normalizeUserCode(c.req.query('code'));
      if (!code || !deps.flow.findByUserCode(code)) {
        const lang = pickLang(c.req.header('accept-language'));
        return htmlResponse(c, 400, renderPage({ lang, kind: 'device_expired' }));
      }
      // The person must have pressed the button of the device page in this browser: a link that jumps straight here could
      // otherwise approve a device for someone who never saw which device it is (RFC 8628 section 5.4).
      const cookieToken = readCookie(c.req.header('cookie'), DEVICE_CONFIRM_COOKIE);
      const linkToken = c.req.query('confirm');
      if (!cookieToken || cookieToken !== linkToken || !deps.flow.takeConfirm(code, cookieToken)) {
        return redirectResponse(`/ext/vtc/device?code=${encodeURIComponent(code)}`, [
          buildExpiredSessionCookie(DEVICE_CONFIRM_COOKIE, auth.cookieSecure),
        ]);
      }
      userCode = code;
    }
    const nonce = nonces.create({
      kind: flowName,
      instanceId: deps.instanceId,
      returnTo: flowName === 'web' ? safeReturnTo(c.req.query('return_to'), config.publicBaseUrl) : '/',
      ...(userCode ? { userCode } : {}),
    });
    if (!nonce) return errorPage(c, 503, 'busy');
    // SameSite=Lax lets the cookie come back on the top-level GET from the SSO.
    const cookie = buildSessionCookie(STATE_COOKIE, nonce, STATE_COOKIE_MAX_AGE_SECONDS, auth.cookieSecure);
    const returnUrl = `${config.publicBaseUrl}/ext/vtc/sso/return?n=${nonce}`;
    const cookies = [cookie];
    if (userCode) cookies.push(buildExpiredSessionCookie(DEVICE_CONFIRM_COOKIE, auth.cookieSecure));
    return redirectResponse(provider.buildLoginUrl(returnUrl), cookies);
  });

  // The SSO sends the browser here with the ticket. Every answer expires the state cookie and refuses to
  // leak the URL, which carries the ticket, in a Referer header.
  pages.get('/sso/continue', async (c) => {
    const expireState = buildExpiredSessionCookie(STATE_COOKIE, auth.cookieSecure);
    const lang = pickLang(c.req.header('accept-language'));
    const answer = (status: number, input: Omit<PageInput, 'lang'>): Response => {
      const response = htmlResponse(c, status, renderPage({ lang, ...input }));
      response.headers.append('Set-Cookie', expireState);
      return response;
    };
    const failure = (status: number, error: ErrorCode): Response => answer(status, { kind: 'error', error });

    if (!deps.continueLimiter.allow(c)) return failure(429, 'busy');

    // The nonce comes first: a forged request must not use up a ticket in the replay guard.
    const cookieNonce = readCookie(c.req.header('cookie'), STATE_COOKIE);
    const urlNonce = extractReturnNonce(c.req.query('url'), config.publicBaseUrl);
    if (!cookieNonce || !urlNonce || cookieNonce !== urlNonce) {
      deps.audit('vtc.login.refused', { reason: 'state_mismatch' });
      return failure(400, 'state_mismatch');
    }
    const nonce = nonces.take(urlNonce);
    if (!nonce) {
      deps.audit('vtc.login.refused', { reason: 'expired' });
      return failure(400, 'expired');
    }

    const result = provider.verify(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!result.ok) {
      deps.logger.warn('vtc sso ticket refused', { reason: result.reason, time_shape: result.timeShape });
      deps.audit('vtc.login.refused', { reason: result.reason });
      return failure(400, FAILURE_PAGE[result.reason]);
    }
    const { identity } = result;
    // The time shape settles how the SSO writes the login time; the value itself stays out of the log.
    deps.logger.info('vtc sso ticket accepted', { vtc_user_id: identity.subject, time_shape: result.timeShape });

    const instanceId = nonce.instanceId;
    let decision;
    try {
      decision = await deps.resolver.resolve(
        instanceId,
        { vtcUserId: identity.subject, email: identity.email ?? '' },
        { source: nonce.kind, touch: true },
      );
    } catch (err) {
      deps.logger.error('vtc account lookup failed', { code: errorCodeOf(err) });
      return failure(503, 'unavailable');
    }

    // The device login ends here: no Panel session opens, the decision goes to the waiting plugin.
    if (nonce.kind === 'device') {
      const outcome: DeviceOutcome =
        decision.kind === 'approved'
          ? { kind: 'approved', coreUserId: decision.coreUserId, subject: identity.subject, email: identity.email ?? '' }
          : decision.kind === 'pending'
            ? { kind: 'pending', subject: identity.subject, email: decision.record.email }
            : { kind: 'rejected' };
      if (!nonce.userCode || !deps.flow.decide(nonce.userCode, outcome)) return answer(400, { kind: 'device_expired' });
      if (decision.kind === 'approved') return answer(200, { kind: 'device_done' });
      // The SSO session stays open; without this link a wrong account would land here again at the next try.
      if (decision.kind === 'pending') return answer(200, { kind: 'device_waiting', logoutHref: logoutHref() });
      deps.audit('vtc.login.rejected', { vtc_user_id: identity.subject });
      return answer(403, { kind: 'device_refused', logoutHref: logoutHref() });
    }

    if (decision.kind === 'pending') {
      deps.audit('vtc.login.pending', { vtc_user_id: identity.subject, kind: decision.record.kind });
      return answer(200, {
        kind: 'waiting',
        email: decision.record.email,
        requestedAt: decision.record.firstLoginAt,
        logoutHref: logoutHref(),
      });
    }
    if (decision.kind === 'rejected') {
      deps.audit('vtc.login.rejected', { vtc_user_id: identity.subject });
      return answer(403, { kind: 'refused', logoutHref: logoutHref() });
    }

    const coreUserId = decision.coreUserId;
    let userKey: string;
    try {
      userKey = (await deps.keys.issueWebKey(instanceId, coreUserId)).userKey;
    } catch (err) {
      if (err instanceof KeyLimitError) return failure(409, 'key_limit');
      deps.logger.error('vtc web key failed', { code: errorCodeOf(err) });
      return failure(503, 'unavailable');
    }
    let user;
    try {
      user = await deps.meta.auth.verify(instanceId, userKey);
    } catch (err) {
      deps.logger.error('vtc web key check failed', { code: errorCodeOf(err) });
      return failure(503, 'unavailable');
    }
    if (!user) {
      deps.logger.error('vtc web key check failed', { code: 'key_not_valid' });
      return failure(503, 'unavailable');
    }
    // A session must never open for a user other than the one the decision approved.
    if (user.user_id !== coreUserId) {
      deps.logger.error('vtc web key check failed', { code: 'key_user_mismatch', core_user_id: coreUserId });
      return failure(503, 'unavailable');
    }
    const { setCookie } = auth.createSession({
      instanceId,
      coreUserId,
      userKey,
      providerId: 'vtc',
      externalSubject: identity.subject,
      displayName: user.display_name || user.username || identity.loginName,
      user,
    });
    deps.audit('vtc.login.succeeded', { flow: 'web', core_user_id: coreUserId, vtc_user_id: identity.subject });
    return redirectResponse(nonce.returnTo, [setCookie, expireState]);
  });

  // The SSO calls `continue`; this route only catches a browser it sends to `url` instead.
  pages.get('/sso/return', () => redirectResponse('/'));

  // GET because the SSO logout is a browser redirect. A cross-site page can still trigger it, so it only acts
  // when the request carries the Panel session cookie (SameSite=Lax sends it on top-level navigation). The
  // worst case is a forced logout, which is accepted: the person logs in again.
  pages.get('/sso/logout', (c) => {
    const { clearCookie, hadSessionCookie } = auth.destroySession(c);
    if (!hadSessionCookie) return redirectResponse('/');
    deps.audit('vtc.logout.web');
    return redirectResponse(logoutHref(), [
      clearCookie,
      buildExpiredSessionCookie(STATE_COOKIE, auth.cookieSecure),
    ]);
  });
}
