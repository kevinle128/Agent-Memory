/**
 * Helpers for login methods that leave the SPA for a server-side redirect. Pure and import-free so the
 * Panel Vitest suite can run them.
 */
export interface RedirectMethodLike {
  id: string;
  type: string;
  login_url?: string;
  logout_url?: string;
}

// Browsers drop tabs and newlines inside a URL and read a backslash as a slash, so any of them can turn
// "/<TAB>/host" or "/\host" into a protocol-relative URL.
function hasUnsafeChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

const PROBE_ORIGIN = 'http://local.invalid';

function isLocalPath(value: string | undefined): value is string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || hasUnsafeChar(value)) return false;
  try {
    const resolved = new URL(value, PROBE_ORIGIN);
    return resolved.origin === PROBE_ORIGIN && !resolved.pathname.startsWith('//');
  } catch {
    return false;
  }
}

/** Same-origin login href with instance_id and return_to added; null for anything that is not a local path. */
export function redirectLoginHref(loginUrl: string, instanceId: string, returnTo = '/'): string | null {
  if (!isLocalPath(loginUrl)) return null;
  const url = new URL(loginUrl, PROBE_ORIGIN);
  url.searchParams.set('instance_id', instanceId);
  url.searchParams.set('return_to', returnTo);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** logout_url of the redirect method that owns the current session; null for WOA, user_key, unknown or non-local URLs. */
export function redirectLogoutUrl(methods: RedirectMethodLike[], providerId: string | undefined): string | null {
  if (!providerId) return null;
  const method = methods.find((m) => m.id === providerId && m.type === 'redirect');
  return method && isLocalPath(method.logout_url) ? method.logout_url : null;
}

export interface RedirectLogoutLoaders {
  session(): Promise<{ provider_id?: string }>;
  methods(): Promise<{ methods: RedirectMethodLike[] }>;
}

/**
 * Where the browser goes to end a redirect-method session, or null for any other session or a failed lookup.
 * The caller must navigate there without calling the Panel logout route first: that route expires the session
 * cookie, and the provider's own logout route only ends the provider session while it still sees that cookie.
 */
export async function redirectLogoutTarget(load: RedirectLogoutLoaders): Promise<string | null> {
  try {
    const [session, list] = await Promise.all([load.session(), load.methods()]);
    return redirectLogoutUrl(list.methods, session.provider_id);
  } catch {
    return null;
  }
}
