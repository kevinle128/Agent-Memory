import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { RateLimiter } from './types.js';

const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

/**
 * The trusted reverse proxy (Tailscale serve, nginx) appends the address it saw to the right end of
 * X-Forwarded-For. Entries to the left come from the client and can be forged, so only the last one counts.
 *
 * Precondition: the Panel binds to 127.0.0.1 (compose.yaml:63, `BIND_ADDRESS` default) and is reached only
 * through `tailscale serve`, which appends the client address. Any other exposure, such as a public bind,
 * lets a client set the header and choose its own limiter key.
 */
function clientKey(c: Context): string {
  const entries = c.req.header('x-forwarded-for')?.split(',') ?? [];
  const forwarded = entries[entries.length - 1]?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    // getConnInfo throws outside a real socket, for example in app.request() tests.
    return 'unknown';
  }
}

/** Fixed one-minute window per client. In memory: one Panel process, a restart resets the counts. */
export function createRateLimiter(perMinute: number, now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    allow(c: Context): boolean {
      const key = clientKey(c);
      const time = now();
      const current = windows.get(key);
      if (!current || time - current.start >= WINDOW_MS) {
        // Re-inserting keeps the map ordered by window start, so the first key is always the oldest window.
        windows.delete(key);
        if (windows.size >= MAX_KEYS) {
          const oldest = windows.keys().next().value;
          if (oldest !== undefined) windows.delete(oldest);
        }
        windows.set(key, { start: time, count: 1 });
        return perMinute > 0;
      }
      current.count += 1;
      return current.count <= perMinute;
    },
  };
}
