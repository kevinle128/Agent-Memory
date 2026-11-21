/**
 * Guards of the MCP route. They run before any call to Core, so a flood of bad requests
 * does not reach Core.
 */
import type { MiddlewareHandler } from 'hono';

export const MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_MAX_IN_FLIGHT = 16;
export const DEFAULT_DEADLINE_MS = 20_000;

/** JSON-RPC error body for an HTTP-level refusal. The `id` is unknown at this point. */
export function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, error: { code, message }, id: null };
}

/**
 * Refuse any request that has an `Origin` header. Agent clients are not browsers and send none.
 * A browser always sends one on a cross-site request, so this blocks CSRF and DNS rebinding.
 */
export const refuseOrigin: MiddlewareHandler = async (c, next) => {
  if (c.req.header('origin') !== undefined) {
    return c.json(jsonRpcError(-32600, 'Requests with an Origin header are not accepted.'), 403);
  }
  await next();
};

export interface InFlightLimiter {
  /** Takes one slot. Returns `false` when all slots are in use. */
  tryAcquire(): boolean;
  release(): void;
  active(): number;
}

/** A counter per route registration. No module-level state, so each Panel app has its own cap. */
export function createInFlightLimiter(max: number): InFlightLimiter {
  let active = 0;
  return {
    tryAcquire() {
      if (active >= max) return false;
      active += 1;
      return true;
    },
    release() {
      if (active > 0) active -= 1;
    },
    active: () => active,
  };
}

export class DeadlineExceededError extends Error {
  constructor() {
    super('deadline exceeded');
    this.name = 'DeadlineExceededError';
  }
}

/**
 * Rejects with `DeadlineExceededError` after `ms` and calls `onTimeout` first, so the
 * orphaned work can stop at its next step. The work itself is not cancelled: a Core call
 * that already started ends by its own timeout.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new DeadlineExceededError());
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    // The work may still reject later. Mark it handled so it does not become an unhandled rejection.
    work.catch(() => undefined);
  }
}

/**
 * Work of one HTTP request. After a deadline, the tool call can still run in the background.
 * The route keeps its in-flight slot until that work settles, and the work checks `stopped()`
 * before each Core call, so it ends at its next step.
 */
export interface RequestLifecycle {
  /** Marks the request as over. Later Core calls of this request do not start. */
  stop(): void;
  stopped(): boolean;
  /** Follows a promise that can outlive the response. */
  track<T>(work: Promise<T>): Promise<T>;
  /** Resolves when every tracked promise has settled. */
  whenIdle(): Promise<void>;
}

export function createRequestLifecycle(): RequestLifecycle {
  let over = false;
  const pending = new Set<Promise<unknown>>();
  return {
    stop() {
      over = true;
    },
    stopped: () => over,
    track(work) {
      pending.add(work);
      const done = () => pending.delete(work);
      work.then(done, done);
      return work;
    },
    async whenIdle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}
