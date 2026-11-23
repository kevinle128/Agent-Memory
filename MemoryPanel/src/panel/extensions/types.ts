import type { Context, Hono } from 'hono';
import type { ZodType, ZodTypeDef } from 'zod';
import type { AuthProvider } from '../auth/types.js';

/** The whole contract between the Panel core and an extension. Extensions import nothing else from the core. */
export interface PanelExtension<C = unknown> {
  /** /^[a-z0-9-]+$/; used for routes, the storage folder and the env prefix. */
  id: string;
  /** Shown in GET /api/v1/extensions. */
  version: string;
  /** The host refuses any other value. */
  apiVersion: 1;
  displayName: string;
  requires?: string[];
  /** Parses a Record<string,string> built from PANEL_EXT_<ID>_*. */
  configSchema: ZodType<C, ZodTypeDef, unknown>;
  /** Synchronous; all fallible setup happens here so a failure commits nothing. */
  register(ctx: ExtensionContext<C>): void | ExtensionHooks;
}
export interface ExtensionHooks {
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface ExtensionLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface ExtensionSessionUser {
  user_id: string;
  username?: string;
  display_name?: string;
  email?: string;
  user_type?: string;
  status?: string;
}
export interface ExtensionSessionInput {
  instanceId: string;
  coreUserId: string;
  userKey: string;
  providerId: string;
  externalSubject: string;
  displayName?: string;
  user?: ExtensionSessionUser;
}
export interface ExtensionAuthPort {
  /** PANEL_AUTH_SESSION_SECURE as resolved by the Panel config. Extensions use it for their own cookies. */
  readonly cookieSecure: boolean;
  registerProvider(provider: AuthProvider): void;
  /** Creates a Panel session (same store, cookie name, TTL and Secure flag as WOA) and returns its Set-Cookie value. */
  createSession(input: ExtensionSessionInput): { token: string; setCookie: string };
  /**
   * Destroys the session named by the request cookie (if any) and returns the Set-Cookie value that expires it.
   * `hadSessionCookie` tells whether the request carried the Panel session cookie at all.
   */
  destroySession(c: Context): { clearCookie: string; hadSessionCookie: boolean };
  /**
   * Panel headers (X-Tdai-Service-Id + X-Tdai-User-Key) or the Panel session cookie, then auth/verify.
   * `isSystemAdmin` is user_type === 'system_admin'. A normal user is still returned.
   */
  requireUser(c: Context): Promise<{ userId: string; instanceId: string; isSystemAdmin: boolean } | Response>;
  /** Same credential path as requireUser, then refuses anyone who is not a system admin. */
  requireSystemAdmin(c: Context): Promise<{ userId: string; instanceId: string } | Response>;
}
export interface ExtensionInstancesPort {
  list(): Array<{ instance_id: string; name: string }>;
  /** First instance, the same rule as routes/auth.ts. */
  resolveDefault(): string | null;
  has(instanceId: string): boolean;
}
export interface JsonDocument<T> {
  /** In-memory copy; callers must not mutate it. */
  read(): T;
  /** Serialized per document, written atomically. */
  update(mutate: (current: T) => T): Promise<T>;
}
export interface ExtensionStoragePort {
  json<T extends { version: 1 }>(name: string, initial: T): JsonDocument<T>;
}
export interface ExtensionSecretsPort {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}
export interface RateLimiter {
  allow(c: Context): boolean;
}
export interface ExtensionWebPage {
  id: string;
  visible_to: 'system_admin' | 'team_admin' | 'all';
}

export type TeamRole = 'admin' | 'member' | 'reviewer';
export class MetaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MetaError';
  }
}
export interface MetaUserSummary {
  user_id: string;
  username: string;
  user_type?: string;
}
export interface MetaUserDetail extends MetaUserSummary {
  email: string | null;
  display_name: string | null;
  auth_provider: string;
  external_id: string;
  status: string;
}
export interface MetaFacade {
  users: {
    findByExternal(instanceId: string, authProvider: string, externalId: string): Promise<{ user_id: string } | null>;
    create(
      instanceId: string,
      input: { username: string; external_id: string; auth_provider: string; email?: string; display_name?: string },
    ): Promise<{ user_id: string }>;
    get(instanceId: string, userId: string): Promise<MetaUserSummary | null>;
    listByUsername(instanceId: string, username: string): Promise<MetaUserSummary[]>;
    listAllDetailed(instanceId: string): Promise<MetaUserDetail[]>;
  };
  keys: {
    create(
      instanceId: string,
      userId: string,
      input: { name: string; expiresAt: Date },
    ): Promise<{ key_id: string; key_value: string; expires_at: string | null }>;
    get(
      instanceId: string,
      keyId: string,
    ): Promise<{ key_id: string; user_id: string; status: string; expires_at: string | null } | null>;
    update(instanceId: string, keyId: string, input: { expiresAt: Date }): Promise<void>;
    revoke(instanceId: string, keyId: string): Promise<void>;
  };
  teams: {
    get(instanceId: string, teamId: string): Promise<{ team_id: string; name: string; owner_user_id: string } | null>;
    /**
     * One page of team/list. `total` is the full count, so a caller that needs every team
     * repeats the call with a higher offset until the pages are exhausted.
     */
    listForUser(
      instanceId: string,
      userId: string,
      page?: { limit?: number; offset?: number },
    ): Promise<{ total: number; items: Array<{ team_id: string; name: string }> }>;
  };
  members: {
    get(instanceId: string, teamId: string, userId: string): Promise<{ role: TeamRole; status: string } | null>;
    /** team-member/add only; an unchanged active membership counts as success. */
    add(instanceId: string, teamId: string, userId: string, role: TeamRole): Promise<void>;
    /** The default-agent provisioning of the Panel add-member path, awaited and never throwing; true when the user then owns an agent in the team. */
    provisionDefaults(instanceId: string, teamId: string, userId: string): Promise<boolean>;
  };
  agents: {
    listOwned(instanceId: string, teamId: string, ownerUserId: string): Promise<Array<{ agent_id: string; name: string }>>;
  };
  auth: { verify(instanceId: string, userKey: string): Promise<ExtensionSessionUser | null> };
  system: {
    /** True when the extension system key (PANEL_EXTENSIONS_SYSTEM_USER_KEY, else the instance api_key) resolves to a system_admin user key in Core. */
    verify(instanceId: string): Promise<boolean>;
  };
}

export interface ExtensionContext<C> {
  readonly id: string;
  readonly config: C;
  readonly logger: ExtensionLogger;
  readonly auth: ExtensionAuthPort;
  readonly meta: MetaFacade;
  readonly instances: ExtensionInstancesPort;
  readonly storage: ExtensionStoragePort;
  readonly secrets: ExtensionSecretsPort;
  readonly http: { api: Hono; pages: Hono };
  audit(event: string, fields?: Record<string, unknown>): void;
  rateLimit(name: string, opts: { perMinute: number }): RateLimiter;
  readonly web: { advertise(input: { pages: ExtensionWebPage[]; loginMethodIds: string[] }): void };
}
