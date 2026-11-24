import type { Hono } from 'hono';
import { redirectResponse } from './pages.js';

/**
 * Where a browser navigation should land, or null to handle it locally.
 *
 * Tailscale serve keeps the browser's Host and, for TLS, sets X-Forwarded-Proto
 * to https (it does not set that header for plain HTTP). The redirect fires only
 * when the request host differs from the public origin's host, so a request that
 * already arrived on the public host is not redirected even if X-Forwarded-Proto
 * is missing. A client-supplied X-Forwarded-Proto or X-Forwarded-Host cannot
 * suppress or aim the redirect: the target is the public origin plus the request
 * path and query.
 */
export function publicHttpsRedirectLocation(input: {
  method: string;
  requestUrl: string;
  publicBaseUrl: string;
}): string | null {
  if (input.method !== 'GET' && input.method !== 'HEAD') return null;
  let req: URL;
  let pub: URL;
  try {
    // The node server sees plain http:// URLs built from the Host header. Parse them
    // with https: default-port rules, as the public origin is, so Host "host:443"
    // matches "https://host" and Host "host:80" does not.
    req = new URL(input.requestUrl.replace(/^http:/i, 'https:'));
    pub = new URL(input.publicBaseUrl);
  } catch {
    return null;
  }
  if (pub.protocol !== 'https:') return null;
  if (req.host.toLowerCase() === pub.host.toLowerCase()) return null;
  if (isMachinePath(req.pathname)) return null;
  if (!isPlainPath(req.pathname) || req.username || req.password) return null;
  const target = new URL(`${pub.origin}${req.pathname}${req.search}`);
  if (target.origin !== pub.origin || !isPlainPath(target.pathname)) return null;
  return `${target.origin}${target.pathname}${target.search}`;
}

/** Health probes and JSON/CLI callers. Browser pages and /ext/vtc/* navigations are not in this set. */
function isMachinePath(pathname: string): boolean {
  return pathname === '/health' || pathname.startsWith('/api/');
}

// Same shape as the SSO return-path check: one slash, no control characters, no backslash.
const UNSAFE_PATH_CHARS = /[\x00-\x1f\x7f\\]/;

function isPlainPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !UNSAFE_PATH_CHARS.test(value);
}

export function registerPublicUrlRedirect(app: Hono, publicBaseUrl: string): void {
  app.use('*', async (c, next) => {
    const location = publicHttpsRedirectLocation({
      method: c.req.method,
      requestUrl: c.req.url,
      publicBaseUrl,
    });
    if (!location) return next();
    return redirectResponse(location);
  });
}
