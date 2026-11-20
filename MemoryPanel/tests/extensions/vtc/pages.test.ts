import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  htmlResponse,
  pickLang,
  renderPage,
  type PageKind,
} from '../../../src/extensions/vtc/http/pages.js';

describe('VTC status pages', () => {
  it('picks the language from Accept-Language', () => {
    expect(pickLang('vi-VN,vi;q=0.9')).toBe('vi');
    expect(pickLang('zh-CN')).toBe('zh-CN');
    expect(pickLang('zh-TW,zh;q=0.8')).toBe('zh-CN');
    expect(pickLang('fr')).toBe('en');
    expect(pickLang(undefined)).toBe('en');
    expect(pickLang('')).toBe('en');
    expect(pickLang('en;q=0.5, vi;q=0.8')).toBe('vi');
    expect(pickLang('fr, vi;q=0.2')).toBe('vi');
    expect(pickLang('vi;q=0, en')).toBe('en');
  });

  it('escapes values', () => {
    const html = renderPage({
      lang: 'en',
      kind: 'waiting',
      email: '"<script>x</script>@vtc.vn',
      requestedAt: '2026-11-19T14:40:00Z',
    });
    expect(html).toContain('&quot;&lt;script&gt;x&lt;/script&gt;@vtc.vn');
    expect(html).not.toContain('<script');

    const device = renderPage({
      lang: 'en',
      kind: 'device_confirm',
      deviceName: `<b>Mac</b> & 'co'`,
      userCode: 'AB-<1>',
      loginHref: '/ext/vtc/sso/login?flow=device&a="b"',
    });
    expect(device).toContain('&lt;b&gt;Mac&lt;/b&gt; &amp; &#39;co&#39;');
    expect(device).toContain('AB-&lt;1&gt;');
    expect(device).toContain('flow=device&amp;a=&quot;b&quot;');
  });

  it('uses the given logout link on the waiting and refused pages and escapes it', () => {
    const logoutHref = 'https://sso.test.invalid/sso/Logout/?url=a&b="c"';
    for (const kind of ['waiting', 'refused'] as const) {
      const html = renderPage({ lang: 'en', kind, logoutHref });
      expect(html).toContain('href="https://sso.test.invalid/sso/Logout/?url=a&amp;b=&quot;c&quot;"');
    }
  });

  it('does not render a script URL as the device login link', () => {
    const html = renderPage({ lang: 'en', kind: 'device_confirm', loginHref: 'javascript:alert(1)' });
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('class="btn"');
  });

  it('sets the security headers and renders no script for any page', async () => {
    const kinds: PageKind[] = [
      'error',
      'waiting',
      'refused',
      'device_confirm',
      'device_done',
      'device_waiting',
      'device_refused',
      'device_expired',
    ];
    const app = new Hono();
    app.get('/:kind/:lang', (c) =>
      htmlResponse(
        c,
        200,
        renderPage({
          lang: c.req.param('lang') as 'en',
          kind: c.req.param('kind') as PageKind,
          error: 'expired',
          email: 'a.b@vtc.vn',
          deviceName: 'Paseo',
          userCode: 'ABCD-1234',
          loginHref: '/x',
        }),
      ),
    );
    for (const kind of kinds) {
      for (const lang of ['en', 'vi', 'zh-CN']) {
        const res = await app.request(`/${kind}/${lang}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        const csp = res.headers.get('content-security-policy') ?? '';
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("frame-ancestors 'none'");
        const html = await res.text();
        expect(html).not.toContain('<script');
        expect(html).toContain('Memory Hub');
        expect(html).toContain('TencentDB · AI Memory Hub');
      }
    }
  });

  it('shows times in Asia/Saigon', () => {
    const html = renderPage({ lang: 'en', kind: 'waiting', email: 'a@vtc.vn', requestedAt: '2026-11-19T14:40:00Z' });
    expect(html).toContain('2026-11-19 21:40 (UTC+7)');
    const late = renderPage({ lang: 'en', kind: 'waiting', email: 'a@vtc.vn', requestedAt: '2026-11-19T17:30:00Z' });
    expect(late).toContain('2026-11-20 00:30 (UTC+7)');
  });

  it('writes each language in its own words', () => {
    expect(renderPage({ lang: 'vi', kind: 'refused' })).toContain('Đăng xuất');
    expect(renderPage({ lang: 'zh-CN', kind: 'refused' })).toContain('退出登录');
    expect(renderPage({ lang: 'en', kind: 'error', error: 'replayed' })).toContain(
      'This login link was already used. Start again.',
    );
  });
});
