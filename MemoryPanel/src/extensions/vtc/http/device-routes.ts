import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { buildSessionCookie } from '../../../panel/auth/cookies.js';
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
import type { ClaimStore } from '../device/claim-store.js';
import { normalizeUserCode, type DeviceFlow, type DeviceOutcome, type DeviceRequest } from '../device/device-flow.js';
import { WEB_INSTALL_ID } from '../device/device-store.js';
import { KeyLimitError, type KeyIssuer } from '../device/key-issuer.js';
import { htmlResponse, pickLang, renderPage } from './pages.js';

export interface DeviceApiDeps {
  config: VtcConfig;
  instanceId: string;
  flow: DeviceFlow;
  claims: ClaimStore;
  resolver: AccountResolver;
  keys: KeyIssuer;
  meta: MetaFacade;
  audit: ExtensionContext<VtcConfig>['audit'];
  logger: ExtensionLogger;
  limiters: { start: RateLimiter; token: RateLimiter; claim: RateLimiter; logout: RateLimiter };
}

export const DEVICE_CONFIRM_COOKIE = 'tdai_ext_vtc_device_confirm';
const CONFIRM_COOKIE_MAX_AGE_SECONDS = 300;
const RETRY_AFTER_SECONDS = 60;
const MAX_TEAMS = 100;

// The Core device_id character set, with a minimum length; the Panel web key has its own reserved id.
const installId = z
  .string()
  .regex(/^[A-Za-z0-9-]{8,128}$/)
  .refine((value) => value !== WEB_INSTALL_ID);

const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
const deviceName = z
  .string()
  .max(1024)
  .transform((value) => value.replace(CONTROL_CHARS, '').trim())
  .pipe(z.string().min(1).max(64));

const startBody = z.object({
  install_id: installId,
  device_name: deviceName,
  has_key: z.boolean().default(false),
});
const tokenBody = z.object({ device_code: z.string().min(1).max(256) });
const claimBody = z.object({ install_id: installId, claim_token: z.string().min(1).max(256) });
const logoutBody = z.object({ install_id: installId });

function errorCodeOf(err: unknown): string {
  return err instanceof MetaError ? err.code : 'unexpected';
}

interface Profile {
  user: { user_id: string; email: string; display_name: string };
  teams: Array<{ team_id: string; name: string; role: string }>;
}

/**
 * The device API: plain JSON in RFC 8628 / RFC 6749 shape, because the client is the plugin and not the
 * Panel SPA. No answer is cached and no secret reaches a log line.
 */
export function registerDeviceApiRoutes(api: Hono, deps: DeviceApiDeps): void {
  const { config, instanceId, flow, claims, resolver, keys, meta, audit, logger, limiters } = deps;
  // One Panel process serves the claims, so this keeps two requests with the same token from each minting a key.
  const claiming = new Set<string>();

  const reply = (c: Context, status: number, body: Record<string, unknown>): Response => {
    c.header('Cache-Control', 'no-store');
    return c.json(body, status as 200);
  };
  const fail = (c: Context, status: number, error: string): Response => reply(c, status, { error });
  const unavailable = (c: Context): Response => fail(c, 503, 'temporarily_unavailable');

  async function readBody<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S> | null> {
    const raw = await c.req.json().catch(() => null);
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /**
   * What the plugin shows after login. The Core account supplies the name; the email is the one the
   * person logged in with. Read before a key is minted, so a Core failure never loses a key value.
   */
  async function loadProfile(coreUserId: string, email: string): Promise<Profile> {
    const account = await meta.users.get(instanceId, coreUserId);
    if (!account) throw new MetaError('user_not_found', 'user is gone');
    const listed = await meta.teams.listForUser(instanceId, coreUserId);
    const teams: Profile['teams'] = [];
    for (const team of listed.items.slice(0, MAX_TEAMS)) {
      const member = await meta.members.get(instanceId, team.team_id, coreUserId);
      if (member?.status === 'active') teams.push({ team_id: team.team_id, name: team.name, role: member.role });
    }
    return { user: { user_id: coreUserId, email, display_name: account.username }, teams };
  }

  /** Issues or renews the device key and builds the success answer; every failure is answered here. */
  async function approved(
    c: Context,
    input: { coreUserId: string; vtcUserId: string; email: string; request: DeviceRequest },
  ): Promise<Response> {
    let profile: Profile;
    try {
      profile = await loadProfile(input.coreUserId, input.email);
    } catch (err) {
      logger.error('vtc device profile failed', { code: errorCodeOf(err) });
      return unavailable(c);
    }
    let issued;
    try {
      issued = await keys.issueDeviceKey(instanceId, input.coreUserId, input.request);
    } catch (err) {
      if (err instanceof KeyLimitError) return fail(c, 409, 'key_limit_exceeded');
      logger.error('vtc device key failed', { code: errorCodeOf(err) });
      return unavailable(c);
    }
    audit('vtc.login.succeeded', {
      flow: 'device',
      core_user_id: input.coreUserId,
      vtc_user_id: input.vtcUserId,
      renewed: issued.renewed,
    });
    return reply(c, 200, {
      status: 'approved',
      key_id: issued.key_id,
      expires_at: issued.expires_at,
      renewed: issued.renewed,
      ...(issued.renewed ? {} : { user_key: issued.key_value }),
      ...profile,
    });
  }

  async function answerOutcome(c: Context, request: DeviceRequest, outcome: DeviceOutcome): Promise<Response> {
    if (outcome.kind === 'rejected') return fail(c, 400, 'access_denied');
    if (outcome.kind === 'approved') {
      return approved(c, { coreUserId: outcome.coreUserId, vtcUserId: outcome.subject, email: outcome.email, request });
    }
    try {
      const { token } = await claims.create({
        instanceId,
        vtcUserId: outcome.subject,
        email: outcome.email,
        installId: request.installId,
        deviceName: request.deviceName,
        hasKey: request.hasKey,
      });
      audit('vtc.login.pending', { flow: 'device', vtc_user_id: outcome.subject });
      return reply(c, 200, { status: 'account_pending', claim_token: token, retry_after: RETRY_AFTER_SECONDS });
    } catch (err) {
      logger.error('vtc claim create failed', { code: errorCodeOf(err) });
      return unavailable(c);
    }
  }

  api.post('/device/start', async (c) => {
    if (!limiters.start.allow(c)) return fail(c, 429, 'slow_down');
    const body = await readBody(c, startBody);
    if (!body) return fail(c, 400, 'invalid_request');
    const started = flow.start({ installId: body.install_id, deviceName: body.device_name, hasKey: body.has_key });
    if (!started) return unavailable(c);
    const verificationUri = `${config.publicBaseUrl}/ext/vtc/device`;
    return reply(c, 200, {
      device_code: started.deviceCode,
      user_code: started.userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?code=${started.userCode}`,
      interval: started.interval,
      expires_in: started.expiresIn,
    });
  });

  api.post('/device/token', async (c) => {
    if (!limiters.token.allow(c)) return fail(c, 429, 'slow_down');
    const body = await readBody(c, tokenBody);
    if (!body) return fail(c, 400, 'invalid_request');
    const result = flow.poll(body.device_code);
    if (result.status !== 'done') return fail(c, 400, result.status);

    // The outcome is locked while the answer is built. A 503 leaves it for the next poll, because no key
    // went out; any other answer spends the code.
    let response: Response;
    try {
      response = await answerOutcome(c, result.request, result.outcome);
    } catch (err) {
      flow.release(result.ticket);
      throw err;
    }
    if (response.status === 503) flow.release(result.ticket);
    else flow.complete(result.ticket);
    return response;
  });

  api.post('/device/claim', async (c) => {
    if (!limiters.claim.allow(c)) return fail(c, 429, 'slow_down');
    const body = await readBody(c, claimBody);
    if (!body) return fail(c, 400, 'invalid_request');
    const claim = claims.findByToken(body.claim_token);
    // The same answer for an unknown token and for another install's token.
    if (!claim || claim.installId !== body.install_id || claim.instanceId !== instanceId) {
      return fail(c, 400, 'invalid_grant');
    }
    // Nothing awaits between the lookup and this mark, so only one request holds a claim at a time.
    if (claiming.has(claim.tokenHash)) return fail(c, 409, 'claim_in_progress');
    claiming.add(claim.tokenHash);
    try {
      if (claims.isExpired(claim)) {
        await claims.remove(claim.tokenHash);
        return fail(c, 400, 'expired_token');
      }
      const decision = await resolver.resolve(
        instanceId,
        { vtcUserId: claim.vtcUserId, email: claim.email },
        { source: 'device', touch: false },
      );
      if (decision.kind === 'pending') return reply(c, 200, { status: 'account_pending', retry_after: RETRY_AFTER_SECONDS });
      if (decision.kind === 'rejected') {
        await claims.remove(claim.tokenHash);
        return fail(c, 400, 'access_denied');
      }
      const response = await approved(c, {
        coreUserId: decision.coreUserId,
        vtcUserId: claim.vtcUserId,
        email: claim.email,
        request: { installId: claim.installId, deviceName: claim.deviceName, hasKey: claim.hasKey },
      });
      // Spent only once a key went out; a failed attempt can be retried with the same token.
      if (response.status === 200) {
        await claims.remove(claim.tokenHash).catch((err: unknown) => {
          logger.error('vtc claim spend failed', { code: errorCodeOf(err) });
        });
      }
      return response;
    } catch (err) {
      logger.error('vtc claim failed', { code: errorCodeOf(err) });
      return unavailable(c);
    } finally {
      claiming.delete(claim.tokenHash);
    }
  });

  api.post('/device/logout', async (c) => {
    if (!limiters.logout.allow(c)) return fail(c, 429, 'slow_down');
    const body = await readBody(c, logoutBody);
    if (!body) return fail(c, 400, 'invalid_request');
    const userKey = c.req.header('x-tdai-user-key');
    if (!userKey) return fail(c, 401, 'invalid_token');
    try {
      const result = await keys.expireDeviceKey(instanceId, userKey, body.install_id);
      if (result === 'invalid_key') return fail(c, 401, 'invalid_token');
      if (result === 'unknown_device') return fail(c, 404, 'unknown_device');
      return reply(c, 200, { ok: true });
    } catch (err) {
      logger.error('vtc device logout failed', { code: errorCodeOf(err) });
      return unavailable(c);
    }
  });
}

export function registerDevicePageRoutes(
  pages: Hono,
  deps: { flow: DeviceFlow; auth: ExtensionAuthPort; limiter: RateLimiter },
): void {
  pages.get('/device', (c) => {
    const lang = pickLang(c.req.header('accept-language'));
    // The page looks up live user codes and replaces their confirm value, so guessing is limited like the API.
    if (!deps.limiter.allow(c)) return htmlResponse(c, 429, renderPage({ lang, kind: 'error', error: 'busy' }));
    const code = normalizeUserCode(c.req.query('code'));
    const found = code ? deps.flow.findByUserCode(code) : null;
    if (!code || !found) return htmlResponse(c, 404, renderPage({ lang, kind: 'device_expired' }));
    const confirm = deps.flow.issueConfirm(code);
    if (!confirm) return htmlResponse(c, 404, renderPage({ lang, kind: 'device_expired' }));
    const response = htmlResponse(
      c,
      200,
      renderPage({
        lang,
        kind: 'device_confirm',
        deviceName: found.request.deviceName,
        userCode: code,
        loginHref: `/ext/vtc/sso/login?flow=device&code=${encodeURIComponent(code)}&confirm=${encodeURIComponent(confirm)}`,
      }),
    );
    // The login needs both copies. The cookie exists only in the browser that loaded this page, so a link built
    // from an attacker's own page lacks it. The link copy is readable only from this page, so a page that
    // opens this one in a window and then navigates that window to the login (which sends the cookie) lacks it.
    response.headers.append(
      'Set-Cookie',
      buildSessionCookie(DEVICE_CONFIRM_COOKIE, confirm, CONFIRM_COOKIE_MAX_AGE_SECONDS, deps.auth.cookieSecure),
    );
    return response;
  });
}
