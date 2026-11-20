import type { MetaEnvelope } from '../kernel/envelope.js';
import { toKernelCredentials, type MetaCallContext } from '../kernel/types.js';
import { cloneDefaultAgentForNewMember } from '../http/routes/meta/proxy.js';
import type { PanelDeps } from '../panel-deps.js';
import {
  MetaError,
  type ExtensionSessionUser,
  type MetaFacade,
  type MetaUserDetail,
  type MetaUserSummary,
  type TeamRole,
} from './types.js';

const PAGE_SIZE = 100;
const MAX_USER_ROWS = 5000;
const KEY_NAME_MAX = 128;

type Row = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function items(data: unknown): Row[] {
  const list = (data as { items?: unknown } | null)?.items;
  return Array.isArray(list) ? (list as Row[]) : [];
}
function summary(row: Row): MetaUserSummary {
  const out: MetaUserSummary = { user_id: str(row.user_id), username: str(row.username) };
  if (typeof row.user_type === 'string') out.user_type = row.user_type;
  return out;
}

/** Core writes "<code>: <message>"; the code is the text before the first colon. */
function errorCode(envelope: MetaEnvelope): string {
  const index = envelope.message.indexOf(':');
  const code = index > 0 ? envelope.message.slice(0, index).trim() : '';
  return /^[a-z0-9_]+$/.test(code) ? code : 'kernel_error';
}

/**
 * The only door from an extension to Core. Every call reaches the gateway with the instance api_key and
 * acts as a system admin user key: PANEL_EXTENSIONS_SYSTEM_USER_KEY when set, otherwise the instance
 * api_key itself (a system admin key by deployment precondition). Returns narrow, mapped shapes.
 */
export function createMetaFacade(deps: PanelDeps): MetaFacade {
  function context(instanceId: string): MetaCallContext {
    let entry;
    try {
      entry = deps.instanceRegistry.resolve(instanceId);
    } catch {
      throw new MetaError('invalid_instance', 'invalid metadata instance');
    }
    return {
      instanceId: entry.instance_id,
      gatewayEndpoint: entry.gateway_endpoint,
      gatewayApiKey: entry.api_key,
      userKey: deps.config.extensions.systemUserKey?.trim() || entry.api_key,
    };
  }

  /**
   * Runs a meta action with its bodies kept out of the logs. The metaKernel port has no such option,
   * so this posts the same path with the same credentials through the HTTP port. Actions that
   * return or take user profile fields or keys go through here.
   */
  function invokeQuiet(
    instanceId: string,
    action: string,
    body: Record<string, unknown>,
    omitUserKey = false,
  ): Promise<MetaEnvelope> {
    return deps.kernelHttp.postEnvelope(
      `/v3/meta/${action}`,
      body,
      toKernelCredentials(context(instanceId), { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey }),
      { logBodies: false },
    );
  }

  async function call(
    instanceId: string,
    action: string,
    body: Record<string, unknown>,
    quiet = false,
  ): Promise<unknown> {
    const envelope = quiet
      ? await invokeQuiet(instanceId, action, body)
      : await deps.metaKernel.invoke(action, body, context(instanceId));
    if (envelope.code !== 0) throw new MetaError(errorCode(envelope), envelope.message);
    return envelope.data;
  }

  /** Like call, but the listed "not found" codes return null. */
  async function callOrNull(
    instanceId: string,
    action: string,
    body: Record<string, unknown>,
    notFound: RegExp,
    quiet = false,
  ): Promise<unknown | null> {
    try {
      return (await call(instanceId, action, body, quiet)) ?? null;
    } catch (err) {
      if (err instanceof MetaError && notFound.test(err.code)) return null;
      throw err;
    }
  }

  const NOT_FOUND = /_not_found$/;

  async function ownedAgents(instanceId: string, teamId: string, ownerUserId: string) {
    const data = await call(instanceId, 'agent/list', {
      team_id: teamId,
      owner_user_id: ownerUserId,
      status: 'active',
      limit: 50,
      offset: 0,
    });
    return items(data).map((row) => ({ agent_id: str(row.agent_id), name: str(row.name) }));
  }

  return {
    users: {
      async findByExternal(instanceId, authProvider, externalId) {
        const data = (await callOrNull(
          instanceId,
          'user/find-by-external',
          { external_id: externalId, auth_provider: authProvider },
          /^user_not_found$/,
          true,
        )) as Row | null;
        const userId = data ? str(data.user_id) : '';
        return userId ? { user_id: userId } : null;
      },
      async create(instanceId, input) {
        const body: Record<string, unknown> = {
          username: input.username,
          external_id: input.external_id,
          auth_provider: input.auth_provider,
        };
        if (input.email !== undefined) body.email = input.email;
        if (input.display_name !== undefined) body.display_name = input.display_name;
        const data = (await call(instanceId, 'user/create', body, true)) as Row | null;
        const userId = str(data?.user_id);
        if (!userId) throw new MetaError('kernel_error', 'user/create returned no user_id');
        // The response also carries a default user key. It is dropped on purpose: nobody receives it.
        return { user_id: userId };
      },
      async get(instanceId, userId) {
        const data = (await callOrNull(instanceId, 'user/get', { user_id: userId }, NOT_FOUND, true)) as Row | null;
        return data && str(data.user_id) ? summary(data) : null;
      },
      async listByUsername(instanceId, username) {
        // Quiet: the filter value is a username, which must stay out of the logs.
        const data = await call(instanceId, 'user/list', { username, limit: PAGE_SIZE, offset: 0 }, true);
        return items(data).map(summary);
      },
      async listAllDetailed(instanceId) {
        const ctx = context(instanceId);
        const out: MetaUserDetail[] = [];
        for (let offset = 0; out.length < MAX_USER_ROWS; offset += PAGE_SIZE) {
          // Rows carry emails and the password hash, so the transport must not log the bodies.
          const envelope = await deps.kernelHttp.postEnvelope<unknown>(
            '/v3/internal/meta/user/list-by-instance',
            { instance_id: instanceId, limit: PAGE_SIZE, offset },
            toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true }),
            { logBodies: false },
          );
          if (envelope.code !== 0) throw new MetaError(errorCode(envelope), envelope.message);
          const page = items(envelope.data);
          // Field by field: a row also holds the password hash, which must not leave this function.
          for (const row of page) {
            out.push({
              ...summary(row),
              email: strOrNull(row.email),
              display_name: strOrNull(row.display_name),
              auth_provider: str(row.auth_provider),
              external_id: str(row.external_id),
              status: str(row.status),
            });
          }
          if (page.length < PAGE_SIZE) break;
        }
        return out.slice(0, MAX_USER_ROWS);
      },
    },
    keys: {
      async create(instanceId, userId, input) {
        const data = (await call(
          instanceId,
          'user-key/create',
          { user_id: userId, name: input.name.slice(0, KEY_NAME_MAX), expires_at: input.expiresAt.toISOString() },
          true,
        )) as Row | null;
        const keyId = str(data?.key_id);
        const keyValue = str(data?.key_value);
        // An empty key would be handed out as a working credential, so a malformed reply is a failure.
        if (!keyId || !keyValue) throw new MetaError('kernel_error', 'user-key/create returned no key');
        return { key_id: keyId, key_value: keyValue, expires_at: strOrNull(data?.expires_at) };
      },
      async get(instanceId, keyId) {
        const data = (await callOrNull(instanceId, 'user-key/get', { key_id: keyId }, /^user_key_not_found$/)) as Row | null;
        if (!data) return null;
        return {
          key_id: str(data.key_id),
          user_id: str(data.user_id),
          status: str(data.status),
          expires_at: strOrNull(data.expires_at),
        };
      },
      async update(instanceId, keyId, input) {
        await call(instanceId, 'user-key/update', { key_id: keyId, expires_at: input.expiresAt.toISOString() });
      },
      async revoke(instanceId, keyId) {
        await call(instanceId, 'user-key/revoke', { key_id: keyId });
      },
    },
    teams: {
      async get(instanceId, teamId) {
        const data = (await callOrNull(instanceId, 'team/get', { team_id: teamId }, NOT_FOUND)) as Row | null;
        if (!data || !str(data.team_id)) return null;
        return { team_id: str(data.team_id), name: str(data.name), owner_user_id: str(data.owner_user_id) };
      },
      async listForUser(instanceId, userId) {
        const data = (await call(instanceId, 'team/list', { user_id: userId, limit: PAGE_SIZE, offset: 0 })) as Row | null;
        const list = items(data).map((row) => ({ team_id: str(row.team_id), name: str(row.name) }));
        const total = typeof data?.total === 'number' ? data.total : list.length;
        return { total, items: list };
      },
    },
    members: {
      async get(instanceId, teamId, userId) {
        const data = (await callOrNull(
          instanceId,
          'team-member/get',
          { team_id: teamId, user_id: userId },
          NOT_FOUND,
        )) as Row | null;
        if (!data || !str(data.role)) return null;
        return { role: str(data.role) as TeamRole, status: str(data.status) };
      },
      async add(instanceId, teamId, userId, role) {
        try {
          await call(instanceId, 'team-member/add', { team_id: teamId, user_id: userId, role });
        } catch (err) {
          // Core raises this for an unchanged active membership, so a retry or a race is a success.
          if (err instanceof MetaError && err.code === 'member_already_exists') return;
          throw err;
        }
      },
      async provisionDefaults(instanceId, teamId, userId) {
        try {
          await cloneDefaultAgentForNewMember({ team_id: teamId, user_id: userId }, context(instanceId), deps);
        } catch (err) {
          // The function has no top-level catch; a template read or a Core call can throw.
          deps.logger.warn('default agent provisioning failed', {
            instanceId,
            teamId,
            userId,
            code: err instanceof MetaError ? err.code : 'unexpected',
          });
        }
        try {
          return (await ownedAgents(instanceId, teamId, userId)).length > 0;
        } catch {
          return false;
        }
      },
    },
    agents: { listOwned: ownedAgents },
    auth: {
      async verify(instanceId, userKey) {
        if (!userKey.trim()) return null;
        const envelope = await invokeQuiet(instanceId, 'auth/verify', { user_key: userKey }, true);
        // Core answers an unknown key with code 0 and valid false; any other code is Core or the transport
        // failing, which must not read as "this key is invalid".
        if (envelope.code !== 0) throw new MetaError(errorCode(envelope), envelope.message);
        const data = envelope.data as { valid?: boolean; user?: Row } | null;
        if (data?.valid !== true || !data.user) return null;
        const user = data.user;
        const out: ExtensionSessionUser = { user_id: str(user.user_id) };
        if (typeof user.username === 'string') out.username = user.username;
        if (typeof user.display_name === 'string') out.display_name = user.display_name;
        if (typeof user.email === 'string') out.email = user.email;
        if (typeof user.user_type === 'string') out.user_type = user.user_type;
        if (typeof user.status === 'string') out.status = user.status;
        return out;
      },
    },
    system: {
      async verify(instanceId) {
        try {
          const userKey = context(instanceId).userKey;
          const envelope = await invokeQuiet(instanceId, 'auth/verify', { user_key: userKey }, true);
          const data = envelope.data as { valid?: boolean; user?: { user_type?: string } } | null;
          return envelope.code === 0 && data?.valid === true && data.user?.user_type === 'system_admin';
        } catch {
          return false;
        }
      },
    },
  };
}
