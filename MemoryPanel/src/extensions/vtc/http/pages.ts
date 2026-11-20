import type { Context } from 'hono';
import { PAGE_STRINGS, type ErrorCode, type PageKind, type PageLang } from './page-strings.js';

export { pickLang } from './page-strings.js';
export type { ErrorCode, PageKind, PageLang } from './page-strings.js';

// No script runs on these pages. They are reached by full-page redirects before any SPA session exists.
const PAGE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  // The continue URL carries the ticket; no Referer may leak it.
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const STYLE = `
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;color:#1f2937;
background:radial-gradient(circle at 1px 1px,#d5dae3 1px,transparent 0) 0 0/22px 22px,#f6f8fb}
.card{width:100%;max-width:420px;background:#fff;border-radius:16px;padding:32px 36px;box-shadow:0 12px 40px rgba(15,23,42,.10);text-align:center}
.brand{font-size:26px;font-weight:700;color:#0f172a;margin:0}
.tag{display:inline-block;margin:6px 0 18px;padding:1px 8px;border-radius:999px;background:#e8f0ff;color:#1d4ed8;font-size:12px;font-weight:600}
h2{font-size:17px;margin:0 0 10px;color:#111827}
p{margin:0 0 14px;line-height:1.55;color:#4b5563;font-size:14px}
.rows{margin:18px 0;text-align:left;font-size:14px;border-top:1px solid #eef0f4}
.row{display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid #eef0f4}
.row span:first-child{color:#6b7280}.row span:last-child{color:#111827;word-break:break-all;text-align:right}
.btn{display:block;margin:14px 0 10px;padding:11px 16px;border-radius:10px;background:#1677ff;color:#fff;text-decoration:none;font-weight:600;font-size:15px}
.link{color:#1d4ed8;text-decoration:none;font-weight:600;font-size:14px}
.note{font-size:12px;color:#6b7280}
.foot{font-size:12px;color:#8b95a5}
`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** `YYYY-MM-DD HH:mm (UTC+7)` in Asia/Saigon; the input is returned unchanged if it is not a date. */
function formatSaigon(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Saigon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(time);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} (UTC+7)`;
}

export interface PageInput {
  lang: PageLang;
  kind: PageKind;
  error?: ErrorCode;
  email?: string;
  requestedAt?: string;
  deviceName?: string;
  userCode?: string;
  loginHref?: string;
  /** SSO logout URL for the waiting and refused pages, where the person holds no Panel session. */
  logoutHref?: string;
}

export function renderPage(input: PageInput): string {
  const t = PAGE_STRINGS[input.lang];
  const e = escapeHtml;
  // These pages come before any Panel session, so the Panel logout route (gated by that cookie) would do nothing.
  const logout = `<a class="link" href="${e(input.logoutHref ?? '/ext/vtc/sso/logout')}">${e(t.logout)}</a>`;
  let title: string;
  let body: string;

  switch (input.kind) {
    case 'waiting':
      title = t.waitingTitle;
      body = `<p>${e(t.waitingText)}</p>
<div class="rows">
<div class="row"><span>${e(t.account)}</span><span>${e(input.email ?? '')}</span></div>
<div class="row"><span>${e(t.status)}</span><span>${e(t.pending)}</span></div>
<div class="row"><span>${e(t.requested)}</span><span>${e(input.requestedAt ? formatSaigon(input.requestedAt) : '')}</span></div>
</div>${logout}`;
      break;
    case 'refused':
      title = t.refusedTitle;
      body = `<p>${e(t.refusedText)}</p>${logout}`;
      break;
    case 'error':
      title = t.errorTitle;
      body = `<p>${e(t.errors[input.error ?? 'bad_request'])}</p><a class="link" href="/">${e(t.backToLogin)}</a>`;
      break;
    case 'device_confirm': {
      title = t.deviceTitle;
      // A same-site path or an http(s) URL only, so the button can never run a script URL.
      const href = input.loginHref && /^(\/(?![/\\])|https?:\/\/)/.test(input.loginHref) ? input.loginHref : '';
      // The person confirms by logging in; the code is a small cross-check, not the centre of the page.
      body = `<p>${e(t.deviceLead(input.deviceName ?? ''))}</p>
${href ? `<a class="btn" href="${e(href)}">${e(t.deviceLogin)}</a>` : ''}
<p class="note">${e(t.deviceCode)} ${e(input.userCode ?? '')}. ${e(t.deviceCheck)}</p>
<p class="note">${e(t.deviceNote)}</p>`;
      break;
    }
    case 'device_done':
      title = t.deviceDoneTitle;
      body = `<p>${e(t.deviceDone)}</p>`;
      break;
    case 'device_waiting':
      title = t.deviceWaitingTitle;
      body = `<p>${e(t.deviceWaiting)}</p>`;
      break;
    case 'device_refused':
      title = t.deviceRefusedTitle;
      body = `<p>${e(t.deviceRefused)}</p>`;
      break;
    case 'device_expired':
      title = t.deviceExpiredTitle;
      body = `<p>${e(t.deviceExpired)}</p>`;
      break;
  }

  return `<!doctype html>
<html lang="${e(t.htmlLang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Memory Hub</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">
<h1 class="brand">Memory Hub</h1>
<div class="tag">VTC</div>
<h2>${e(title)}</h2>
${body}
</main>
<div class="foot">TencentDB · AI Memory Hub</div>
</body>
</html>`;
}

/** Applies the page security headers to a response a route builds itself, for example a redirect. */
export function withPageHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(PAGE_HEADERS)) response.headers.set(name, value);
  return response;
}

export function htmlResponse(c: Context, status: number, html: string): Response {
  const response = c.newResponse(html, status as 200, {
    'Content-Type': 'text/html; charset=utf-8',
    ...PAGE_HEADERS,
  });
  return response;
}

/** 302 with the page headers and optional cookies. */
export function redirectResponse(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return withPageHeaders(new Response(null, { status: 302, headers }));
}
