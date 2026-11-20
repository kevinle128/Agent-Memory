import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/panel/extensions/rate-limit.js';

function request(forwarded: string): Context {
  return { req: { header: (name: string) => (name === 'x-forwarded-for' ? forwarded : undefined) } } as unknown as Context;
}

describe('rate limiter', () => {
  it('evicts the oldest bucket when full instead of refusing new clients', () => {
    let now = 1_000_000;
    const limiter = createRateLimiter(1, () => now);
    expect(limiter.allow(request('client-0'))).toBe(true);
    expect(limiter.allow(request('client-0'))).toBe(false);
    now += 1;
    for (let i = 1; i < 10_000; i += 1) expect(limiter.allow(request(`client-${i}`))).toBe(true);
    // The map is full now. A new client is served and pushes out client-0, the oldest.
    expect(limiter.allow(request('newcomer'))).toBe(true);
    expect(limiter.allow(request('newcomer'))).toBe(false);
    // client-0 lost its bucket, so it starts a fresh window; the other buckets survive.
    expect(limiter.allow(request('client-0'))).toBe(true);
    expect(limiter.allow(request('client-5'))).toBe(false);
  });

  it('reads the last forwarded address and ignores the forged leftmost entries', () => {
    const limiter = createRateLimiter(1);
    expect(limiter.allow(request('9.9.9.9, 8.8.8.8, 10.0.0.1'))).toBe(true);
    expect(limiter.allow(request('7.7.7.7, 10.0.0.1'))).toBe(false);
    expect(limiter.allow(request('10.0.0.2'))).toBe(true);
  });
});
