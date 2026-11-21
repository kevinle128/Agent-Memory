/**
 * Removes two headers that Node's built-in fetch (undici) adds to every request, so the
 * proxy sends the client's request upstream without them:
 *
 * - `sec-fetch-mode`: fetch always sets it to the request mode (`cors`) and overwrites any
 *   value the caller gives, so removing it never loses a client value.
 * - `accept-language: *`: fetch adds it only when the caller sets no `accept-language`.
 *   A real client value is kept; only the literal `*` is removed.
 *
 * Node keeps its fetch dispatcher on `globalThis[Symbol.for("undici.globalDispatcher.1")]`.
 * This is the shared slot that every undici copy reads, so the filter wraps the dispatcher
 * there and changes only the request headers before it calls the original dispatcher.
 */

const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

type HeaderInput = Record<string, string | string[] | undefined> | string[] | null | undefined;

interface Dispatcher {
  dispatch(opts: { headers?: HeaderInput }, handler: unknown): boolean;
}

function isFetchDefault(name: string, value: unknown): boolean {
  const lower = name.toLowerCase();
  if (lower === "sec-fetch-mode") return true;
  return lower === "accept-language" && value === "*";
}

/** The request headers without the two fetch defaults. Other headers keep their order. */
export function withoutFetchDefaultHeaders(headers: HeaderInput): HeaderInput {
  if (!headers) return headers;
  if (Array.isArray(headers)) {
    const out: string[] = [];
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (!isFetchDefault(headers[i]!, headers[i + 1])) out.push(headers[i]!, headers[i + 1]!);
    }
    return out;
  }
  const out: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isFetchDefault(name, value)) out[name] = value;
  }
  return out;
}

let installed = false;

/**
 * Wraps the global fetch dispatcher once. A `data:` fetch makes Node create its dispatcher
 * without any network call. Call it at start, before the first upstream request.
 */
export async function installFetchDefaultHeaderFilter(): Promise<void> {
  if (installed) return;
  await fetch("data:,");
  const slot = globalThis as unknown as Record<symbol, Dispatcher | undefined>;
  const inner = slot[GLOBAL_DISPATCHER];
  if (!inner || typeof inner.dispatch !== "function") return;
  slot[GLOBAL_DISPATCHER] = new Proxy(inner, {
    get(target, prop) {
      if (prop === "dispatch") {
        return (opts: { headers?: HeaderInput }, handler: unknown) =>
          target.dispatch({ ...opts, headers: withoutFetchDefaultHeaders(opts.headers) }, handler);
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  installed = true;
}
