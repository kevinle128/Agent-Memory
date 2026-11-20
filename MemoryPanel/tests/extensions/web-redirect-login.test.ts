import { describe, expect, it, vi } from 'vitest';
import { redirectLoginHref, redirectLogoutTarget, redirectLogoutUrl, type RedirectMethodLike } from '../../web/src/lib/redirect-login';

const METHODS: RedirectMethodLike[] = [
  { id: 'user_key', type: 'user_key' },
  { id: 'woa', type: 'woa' },
  { id: 'sso', type: 'redirect', login_url: '/ext/demo/sso/login?flow=web', logout_url: '/ext/demo/sso/logout' },
  { id: 'evil', type: 'redirect', login_url: 'https://evil.example/x', logout_url: 'https://evil.example/out' },
];

describe('redirect login helpers', () => {
  it('adds the instance and return path to a local login URL', () => {
    expect(redirectLoginHref('/ext/vtc/sso/login?flow=web', 'default')).toBe(
      '/ext/vtc/sso/login?flow=web&instance_id=default&return_to=%2F',
    );
    expect(redirectLoginHref('/login', 'a b', '/team/members')).toBe('/login?instance_id=a+b&return_to=%2Fteam%2Fmembers');
    // A value the URL already carries is replaced, not repeated.
    expect(redirectLoginHref('/login?instance_id=x&return_to=%2Fy', 'default')).toBe('/login?instance_id=default&return_to=%2F');
  });

  it('refuses login URLs that leave the site', () => {
    for (const url of ['https://evil.example/x', '//evil.example', '/\\evil', '/\t/evil.example', '/\n/evil.example', 'javascript:alert(1)', 'login', '']) {
      expect(redirectLoginHref(url, 'default'), JSON.stringify(url)).toBeNull();
    }
  });

  it('finds the logout URL of the redirect method that owns the session', () => {
    expect(redirectLogoutUrl(METHODS, 'sso')).toBe('/ext/demo/sso/logout');
  });

  it('does nothing for WOA, user_key or unknown providers', () => {
    expect(redirectLogoutUrl(METHODS, 'woa')).toBeNull();
    expect(redirectLogoutUrl(METHODS, 'user_key')).toBeNull();
    expect(redirectLogoutUrl(METHODS, 'missing')).toBeNull();
    expect(redirectLogoutUrl(METHODS, undefined)).toBeNull();
    expect(redirectLogoutUrl([], 'sso')).toBeNull();
  });

  it('refuses a non-local logout URL', () => {
    expect(redirectLogoutUrl(METHODS, 'evil')).toBeNull();
    expect(redirectLogoutUrl([{ id: 'x', type: 'redirect', logout_url: '//evil.example' }], 'x')).toBeNull();
    expect(redirectLogoutUrl([{ id: 'x', type: 'redirect' }], 'x')).toBeNull();
  });

  it('resolves the logout target from the session and method lookups alone', async () => {
    const session = vi.fn().mockResolvedValue({ provider_id: 'sso' });
    const methods = vi.fn().mockResolvedValue({ methods: METHODS });
    await expect(redirectLogoutTarget({ session, methods })).resolves.toBe('/ext/demo/sso/logout');
    // Only the two lookups exist: nothing here can POST the Panel logout and expire the cookie first.
    expect(session).toHaveBeenCalledTimes(1);
    expect(methods).toHaveBeenCalledTimes(1);
  });

  it('returns no target for a WOA session or a failed lookup', async () => {
    const methods = vi.fn().mockResolvedValue({ methods: METHODS });
    await expect(redirectLogoutTarget({ session: async () => ({ provider_id: 'woa' }), methods })).resolves.toBeNull();
    await expect(
      redirectLogoutTarget({ session: async () => Promise.reject(new Error('offline')), methods }),
    ).resolves.toBeNull();
  });
});
