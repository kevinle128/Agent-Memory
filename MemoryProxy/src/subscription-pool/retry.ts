/** Per-request retry budgets; shared account scheduling and Check now deduplication. */
export const POOL_RETRY_BUDGET_MS = 30_000;
export const POOL_RETRY_MAX_WAIT_MS = 8_000;
const RETRY_SPACING_MS = 100;
const scheduling = new Map<string, { notBefore: number; nextSlot: number }>();
const checks = new Map<string, { expiresAt: number; promise: Promise<unknown> }>();

export class PoolRetryDeadline extends Error {}

/** Bounds both waiting and upstream calls, and aborts the actual fetch at the deadline. */
export async function withinRetryDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>, deadline: number, signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (deadline <= Date.now()) throw new PoolRetryDeadline();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      run(combined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new PoolRetryDeadline();
          controller.abort(error);
          reject(error);
        }, Math.max(0, deadline - Date.now()));
        onAbort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export function retryAfterAt(headers: Headers, now = Date.now()): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  const at = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(raw);
  return Number.isFinite(at) && at > now ? at : null;
}

/** Cancel an incomplete upstream error body at the deadline rather than leaking its stream. */
export async function readPoolErrorBody(response: Response, deadline: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const chunk = await withinRetryDeadline(() => reader.read(), deadline, signal);
      if (chunk.done) return text + decoder.decode();
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

function scheduleFor(key: string) {
  const now = Date.now();
  for (const [id, entry] of scheduling) {
    if (entry.notBefore < now - POOL_RETRY_BUDGET_MS && entry.nextSlot < now - POOL_RETRY_BUDGET_MS) scheduling.delete(id);
  }
  let entry = scheduling.get(key);
  if (!entry) {
    entry = { notBefore: 0, nextSlot: now };
    scheduling.set(key, entry);
  }
  return entry;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Waits for the caller's own backoff and shared provider Retry-After, with staggered slots. */
export async function waitForPoolRetry(key: string, delayMs: number, deadline: number, signal?: AbortSignal): Promise<void> {
  const state = scheduleFor(key);
  await withinRetryDeadline((abort) => wait(delayMs, abort), deadline, signal);
  while (true) {
    const slot = Math.max(state.notBefore, state.nextSlot);
    if (slot <= Date.now()) {
      // Reserve only when this request is ready, not during its own backoff. A request
      // waiting 8s must not force another request's 1s retry to wait behind it.
      state.nextSlot = Date.now() + RETRY_SPACING_MS;
      return;
    }
    await withinRetryDeadline((abort) => wait(slot - Date.now(), abort), deadline, signal);
  }
}

export function notePoolRetryAfter(key: string, headers: Headers): void {
  const state = scheduleFor(key);
  state.notBefore = Math.max(state.notBefore, retryAfterAt(headers) ?? 0);
}

export function originalRateLimitResponse(body: string, headers: Headers, key: string): Response {
  const out = new Headers(headers);
  out.delete("content-length");
  out.delete("content-encoding");
  out.set("x-tdai-pool-status", "rate_limited");
  out.set("retry-after", String(Math.max(1, Math.ceil(((scheduleFor(key).notBefore || Date.now() + POOL_RETRY_MAX_WAIT_MS) - Date.now()) / 1000))));
  return new Response(body, { status: 429, headers: out });
}

/** A cancelled waiter must not cancel the shared check needed by other requests. */
export function sharedPoolUsageCheck<T>(key: string, load: () => Promise<T>): Promise<T> {
  for (const [id, entry] of checks) if (entry.expiresAt <= Date.now()) checks.delete(id);
  let entry = checks.get(key);
  if (!entry) {
    entry = { expiresAt: Infinity, promise: load() };
    checks.set(key, entry);
    const current = entry;
    void current.promise.then(() => { current.expiresAt = Date.now() + 10_000; }, () => {
      if (checks.get(key) === current) checks.delete(key);
    });
  }
  return entry.promise as Promise<T>;
}

export function resetPoolRetryForTests(): void { scheduling.clear(); checks.clear(); }
