import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import { buildExpiredSessionCookie, buildSessionCookie, readCookie } from '../auth/cookies.js';
import type { AuthProvider } from '../auth/types.js';
import { respondControlError } from '../http/envelope.js';
import { META_HEADER_SERVICE_ID, META_HEADER_USER_KEY } from '../kernel/headers.js';
import type { PanelDeps } from '../panel-deps.js';
import { createJsonStorage } from './json-store.js';
import { createLocalSecrets } from './local-secret.js';
import { createMetaFacade } from './meta-facade.js';
import { createRateLimiter } from './rate-limit.js';
import type {
  ExtensionAuthPort,
  ExtensionContext,
  ExtensionHooks,
  ExtensionInstancesPort,
  ExtensionSecretsPort,
  ExtensionWebPage,
  PanelExtension,
  RateLimiter,
} from './types.js';

export type ExtensionStatus = 'active' | 'degraded' | 'failed';
export interface ExtensionRecord {
  id: string;
  version: string;
  displayName: string;
  status: ExtensionStatus;
  reason?: string;
  pages: ExtensionWebPage[];
  loginMethodIds: string[];
}
export interface ExtensionHost {
  records(): ExtensionRecord[];
  /** GET /extensions and the /ext/<id> sub-apps. Call before app.route('/api/v1', api). */
  mountApi(api: Hono): void;
  /** The /ext/<id> page sub-apps. Call before the static and SPA fallbacks. */
  mountPages(app: Hono): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const ID_PATTERN = /^[a-z0-9-]+$/;
const REASON_MAX = 300;
const STOP_TIMEOUT_MS = 5000;
const SECRET_FIELDS = new Set([
  'ud',
  'user_key',
  'userkey',
  'key_value',
  'device_code',
  'user_code',
  'claim_token',
  'private_key',
  'secret',
  'password',
  'token',
  'cookie',
]);
const SECRET_SUFFIXES = ['_key', '_token', '_secret', '_password'];

/** Drops fields that look like secrets before an audit line is written. `key_id` is not a secret. */
function cleanFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields ?? {})) {
    const lower = name.toLowerCase();
    if (SECRET_FIELDS.has(lower) || SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix))) continue;
    out[name] = value;
  }
  return out;
}

function shortReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, REASON_MAX);
}

/** Builds the reason from the issue path and code only, so no config value can leak into a log or a response. */
function configReason(issues: Array<{ path: Array<string | number>; code: string }>): string {
  return issues
    .map((issue) => `${issue.path.join('.')} ${issue.code}`.trim())
    .join('; ')
    .slice(0, REASON_MAX);
}

function readConfigVars(vars: NodeJS.ProcessEnv, id: string): Record<string, string> {
  const prefix = `PANEL_EXT_${id.toUpperCase().replace(/-/g, '_')}_`;
  const raw: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (!key.startsWith(prefix) || value === undefined || value === '') continue;
    raw[key.slice(prefix.length)] = value;
  }
  return raw;
}

interface Runtime {
  record: ExtensionRecord;
  api: Hono;
  pages: Hono;
  hooks?: ExtensionHooks;
}

export function createExtensionHost(input: {
  deps: PanelDeps;
  // The catalog holds extensions with different config types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  catalog: PanelExtension<any>[];
  env?: NodeJS.ProcessEnv;
}): ExtensionHost | undefined {
  const { deps, catalog } = input;
  const configVars = input.env ?? process.env;
  const selected = deps.config.extensions.enabled;
  if (selected.length === 0) return undefined;

  const meta = createMetaFacade(deps);
  const runtimes = new Map<string, Runtime>();
  const inProgress = new Set<string>();

  function fail(id: string, reason: string, base?: Partial<ExtensionRecord>): Runtime {
    deps.logger.error('extension failed', { ext: id, reason });
    const runtime: Runtime = {
      record: {
        id,
        version: base?.version ?? '',
        displayName: base?.displayName ?? id,
        status: 'failed',
        reason,
        pages: [],
        loginMethodIds: [],
      },
      api: new Hono(),
      pages: new Hono(),
    };
    runtimes.set(id, runtime);
    return runtime;
  }

  async function requireSystemAdmin(c: Context): Promise<{ userId: string; instanceId: string } | Response> {
    const instanceId = c.req.header(META_HEADER_SERVICE_ID)?.trim();
    if (!instanceId) return respondControlError(c, 400, 'MISSING_INSTANCE_ID');
    let entry;
    try {
      entry = deps.instanceRegistry.resolve(instanceId);
    } catch {
      return respondControlError(c, 400, 'INVALID_INSTANCE');
    }
    const userKey =
      c.req.header(META_HEADER_USER_KEY)?.trim() ||
      deps.auth.resolveSession(entry.instance_id, readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName))
        ?.userKey;
    if (!userKey) return respondControlError(c, 401, 'MISSING_USER_KEY');
    let user;
    try {
      user = await meta.auth.verify(entry.instance_id, userKey);
    } catch {
      // Core down is not a bad key: a 401 would sign the administrator out of the Panel.
      return respondControlError(c, 503, 'CORE_UNAVAILABLE');
    }
    if (!user) return respondControlError(c, 401, 'INVALID_USER_KEY');
    if (user.user_type !== 'system_admin') return respondControlError(c, 403, 'NOT_SYSTEM_ADMIN');
    return { userId: user.user_id, instanceId: entry.instance_id };
  }

  function createAuthPort(staged: AuthProvider[]): ExtensionAuthPort {
    const { sessionCookieName, sessionTtlSeconds, sessionSecure } = deps.config.auth;
    return {
      cookieSecure: sessionSecure,
      registerProvider: (provider) => {
        staged.push(provider);
      },
      createSession: (session) => {
        const created = deps.auth.createSession(session);
        return {
          token: created.token,
          setCookie: buildSessionCookie(sessionCookieName, created.token, sessionTtlSeconds, sessionSecure),
        };
      },
      destroySession: (c) => {
        const token = readCookie(c.req.header('cookie'), sessionCookieName);
        deps.auth.destroySession(token);
        return { clearCookie: buildExpiredSessionCookie(sessionCookieName, sessionSecure), hadSessionCookie: !!token };
      },
      requireSystemAdmin,
    };
  }

  const instances: ExtensionInstancesPort = {
    list: () => deps.instanceRegistry.listAll().map((e) => ({ instance_id: e.instance_id, name: e.name })),
    resolveDefault: () => deps.instanceRegistry.listAll()[0]?.instance_id ?? null,
    has: (instanceId) => {
      try {
        deps.instanceRegistry.resolve(instanceId);
        return true;
      } catch {
        return false;
      }
    },
  };

  // Dependencies come first. A cycle or a missing dependency fails the dependent extension.
  function load(id: string): Runtime {
    const known = runtimes.get(id);
    if (known) return known;
    const extension = catalog.find((e) => e.id === id);
    if (!extension) return fail(id, 'unknown extension');
    const base = { version: extension.version, displayName: extension.displayName };
    if (extension.apiVersion !== 1 || !ID_PATTERN.test(extension.id)) {
      return fail(id, 'unsupported extension api version or id', base);
    }
    if (inProgress.has(id)) return fail(id, 'circular extension requirement', base);
    inProgress.add(id);
    try {
      for (const required of extension.requires ?? []) {
        const dependency = selected.includes(required) ? load(required) : undefined;
        if (!dependency || dependency.record.status === 'failed') {
          return fail(id, `missing required extension ${required}`, base);
        }
      }
      return build(extension);
    } finally {
      inProgress.delete(id);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function build(extension: PanelExtension<any>): Runtime {
    const id = extension.id;
    const base = { version: extension.version, displayName: extension.displayName };
    const parsed = extension.configSchema.safeParse(readConfigVars(configVars, id));
    if (!parsed.success) return fail(id, configReason(parsed.error.issues), base);

    const logger = deps.logger.child({ ext: id });
    const dataDir = join(deps.config.extensions.dataDir, id);
    const api = new Hono();
    const pages = new Hono();
    const stagedProviders: AuthProvider[] = [];
    const advertised = { pages: [] as ExtensionWebPage[], loginMethodIds: [] as string[] };
    const limiters = new Map<string, RateLimiter>();
    let secrets: ExtensionSecretsPort | undefined;

    const ctx: ExtensionContext<unknown> = {
      id,
      config: parsed.data,
      logger,
      auth: createAuthPort(stagedProviders),
      meta,
      instances,
      storage: createJsonStorage(dataDir),
      // The secret file is created on first use, so an extension that never encrypts leaves no file.
      get secrets(): ExtensionSecretsPort {
        secrets ??= createLocalSecrets(dataDir);
        return secrets;
      },
      http: { api, pages },
      audit: (event, fields) => logger.info('audit', { audit: true, ext: id, event, ...cleanFields(fields) }),
      rateLimit: (name, opts) => {
        let limiter = limiters.get(name);
        if (!limiter) {
          limiter = createRateLimiter(opts.perMinute);
          limiters.set(name, limiter);
        }
        return limiter;
      },
      web: {
        advertise: (value) => {
          // In place: the record built at registration holds these same arrays.
          advertised.pages.splice(0, advertised.pages.length, ...value.pages);
          advertised.loginMethodIds.splice(0, advertised.loginMethodIds.length, ...value.loginMethodIds);
        },
      },
    };

    let hooks: ExtensionHooks | undefined;
    try {
      hooks = extension.register(ctx) ?? undefined;
    } catch (err) {
      return fail(id, shortReason(err), base);
    }

    // Only one provider per extension is expected: a duplicate id throws and earlier ones stay registered.
    try {
      for (const provider of stagedProviders) deps.auth.registerProvider(provider);
    } catch (err) {
      return fail(id, shortReason(err), base);
    }

    const onError = (err: Error, c: Context) => {
      logger.error('extension handler failed', { ext: id, err: err.message, path: c.req.path });
      return c.json({ code: 500, message: 'EXTENSION_ERROR', request_id: c.get('reqId') ?? '', data: null }, 500);
    };
    api.onError(onError);
    pages.onError(onError);

    const runtime: Runtime = {
      record: { id, ...base, status: 'active', pages: advertised.pages, loginMethodIds: advertised.loginMethodIds },
      api,
      pages,
      hooks,
    };
    runtimes.set(id, runtime);
    logger.info('extension active', { ext: id, version: extension.version });
    return runtime;
  }

  for (const id of selected) load(id);

  const records = (): ExtensionRecord[] => selected.map((id) => runtimes.get(id)!.record);

  if (deps.config.extensions.strict) {
    const failed = records().find((record) => record.status === 'failed');
    if (failed) throw new Error(`extension failed: ${failed.id}: ${failed.reason ?? 'unknown'}`);
  }

  function hasPanelCredentials(c: Context): boolean {
    return (
      !!c.req.header(META_HEADER_USER_KEY)?.trim() ||
      !!readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName)
    );
  }

  return {
    records,
    mountApi(api) {
      api.get('/extensions', async (c) => {
        let isAdmin = false;
        if (hasPanelCredentials(c)) isAdmin = !((await requireSystemAdmin(c)) instanceof Response);
        const visible = records().filter((record) => isAdmin || record.status !== 'failed');
        return c.json({
          extensions: visible.map((record) => ({
            id: record.id,
            version: record.version,
            status: record.status,
            ...(isAdmin && record.reason ? { reason: record.reason } : {}),
            web: { pages: record.pages },
            login_method_ids: record.loginMethodIds,
          })),
        });
      });
      for (const runtime of runtimes.values()) {
        if (runtime.record.status !== 'failed') api.route(`/ext/${runtime.record.id}`, runtime.api);
      }
    },
    mountPages(app) {
      for (const runtime of runtimes.values()) {
        if (runtime.record.status !== 'failed') app.route(`/ext/${runtime.record.id}`, runtime.pages);
      }
    },
    async start() {
      for (const runtime of runtimes.values()) {
        const start = runtime.hooks?.start;
        if (runtime.record.status === 'failed' || !start) continue;
        try {
          await start.call(runtime.hooks);
        } catch (err) {
          runtime.record.status = 'degraded';
          runtime.record.reason = shortReason(err);
          deps.logger.warn('extension start failed', { ext: runtime.record.id, reason: runtime.record.reason });
        }
      }
    },
    async stop() {
      for (const runtime of runtimes.values()) {
        const stop = runtime.hooks?.stop;
        if (!stop) continue;
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            stop.call(runtime.hooks),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('stop timed out')), STOP_TIMEOUT_MS);
            }),
          ]);
        } catch (err) {
          deps.logger.warn('extension stop failed', { ext: runtime.record.id, reason: shortReason(err) });
        } finally {
          clearTimeout(timer);
        }
      }
    },
  };
}
