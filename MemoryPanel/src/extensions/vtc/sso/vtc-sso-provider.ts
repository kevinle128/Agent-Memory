import type { ExternalIdentity, RedirectCallbackProvider } from '../../../panel/auth/types.js';
import type { VtcConfig } from '../config.js';
import { describeShape, latestInstant, parseSsoLoginTimeCandidates } from './login-time.js';
import type { ReplayGuard } from './replay-guard.js';
import { TripleDesError, decodeSsoUserData } from './triple-des.js';

export type VtcFailReason =
  | 'sso_failed'
  | 'missing_ticket'
  | 'decrypt_failed'
  | 'malformed'
  | 'time_unparsed'
  | 'stale'
  | 'clock_skew'
  | 'replayed';

export type VtcVerifyResult =
  | { ok: true; identity: ExternalIdentity; loginAt: Date; requestIp: string; timeShape: string }
  | { ok: false; reason: VtcFailReason; timeShape?: string };

const SKEW_MS = 60_000;

const MAX_EMAIL_LENGTH = 254;

/** One '@' with text on both sides and a dotted domain, no spaces or control characters, within the address limit. */
export function isPlausibleEmail(value: string): boolean {
  const email = value.trim();
  // eslint-disable-next-line no-control-regex
  return email.length <= MAX_EMAIL_LENGTH && /^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f.]+(\.[^\s@\x00-\x1f.]+)+$/.test(email);
}

/**
 * Checks the callback of the VTC SSO. It never logs: its results carry reasons and shapes, never
 * the ticket, the email or the raw time.
 */
export class VtcSsoProvider implements RedirectCallbackProvider {
  readonly id = 'vtc';
  readonly type = 'ticket';
  readonly kind = 'redirect-callback';
  readonly displayName = 'VTC Mail';
  readonly authProviderDomain = 'vtc-sso';
  readonly loginPath = '/ext/vtc/sso/login?flow=web';
  readonly logoutPath = '/ext/vtc/sso/logout';

  constructor(
    private readonly config: VtcConfig,
    private readonly replay: ReplayGuard,
    private readonly now: () => number = Date.now,
  ) {}

  /** The SSO sends `m` back as `r`, so the value we send is the value we expect. */
  buildLoginUrl(returnUrl: string): string {
    const { ssoBaseUrl, serviceId, publicBaseUrl, successState } = this.config;
    const continueUrl = `${publicBaseUrl}/ext/vtc/sso/continue`;
    return (
      `${ssoBaseUrl}/Login/?id=${encodeURIComponent(serviceId)}` +
      `&url=${encodeURIComponent(returnUrl)}` +
      `&continue=${encodeURIComponent(continueUrl)}` +
      `&m=${encodeURIComponent(successState)}`
    );
  }

  buildLogoutUrl(returnTo: string): string {
    return `${this.config.ssoBaseUrl}/Logout/?url=${encodeURIComponent(returnTo)}`;
  }

  verify(query: Record<string, string>): VtcVerifyResult {
    if (query.r !== this.config.successState) return { ok: false, reason: 'sso_failed' };
    const ud = query.ud;
    if (!ud) return { ok: false, reason: 'missing_ticket' };

    let data;
    try {
      data = decodeSsoUserData(this.config.privateKey, ud);
    } catch (err) {
      if (err instanceof TripleDesError) return { ok: false, reason: err.reason };
      return { ok: false, reason: 'malformed' };
    }

    const timeShape = describeShape(data.requestLoginDateTime);
    const candidates = parseSsoLoginTimeCandidates(data.requestLoginDateTime);
    if (candidates.length === 0) return { ok: false, reason: 'time_unparsed', timeShape };

    const now = this.now();
    const maxAgeMs = this.config.loginMaxAgeSeconds * 1000 + SKEW_MS;
    const loginAt = candidates.find((t) => now - t.getTime() <= maxAgeMs && t.getTime() - now <= SKEW_MS);
    if (!loginAt) {
      // Several readings of an ambiguous date: stale unless every one of them lies in the future.
      const allFuture = candidates.every((t) => t.getTime() - now > SKEW_MS);
      return { ok: false, reason: allFuture ? 'clock_skew' : 'stale', timeShape };
    }

    // Only valid, fresh tickets enter the replay set, so garbage cannot fill it. The record lasts until the
    // latest reading of the time would stop being fresh, so no reading of an ambiguous date can reuse the ticket.
    const until = (latestInstant(candidates) ?? loginAt).getTime() + maxAgeMs;
    if (!this.replay.firstUse({ userId: data.userId, loginTime: data.requestLoginDateTime }, until)) return { ok: false, reason: 'replayed', timeShape };

    // The ticket has no MAC, so a clearly malformed address is refused before it can reach the pending list.
    // The check follows the replay record: copied or cut cipher blocks are reported as a replay first.
    if (!isPlausibleEmail(data.email)) return { ok: false, reason: 'malformed', timeShape };

    const email = data.email.trim().toLowerCase();
    const local = email.split('@')[0] ?? email;
    return {
      ok: true,
      identity: {
        providerId: 'vtc',
        subject: data.userId,
        loginName: local,
        displayName: local,
        email,
        claims: { loginAt: loginAt.toISOString() },
      },
      loginAt,
      requestIp: data.requestIp,
      timeShape,
    };
  }

  async authenticateFromCallback(query: Record<string, string>): Promise<ExternalIdentity | null> {
    const result = this.verify(query);
    return result.ok ? result.identity : null;
  }
}
