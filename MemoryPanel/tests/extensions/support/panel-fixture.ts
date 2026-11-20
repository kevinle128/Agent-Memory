import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { PanelDeps } from '../../../src/panel/panel-deps.js';

const CLEARED_VARS = [
  'PANEL_EXTENSIONS',
  'PANEL_EXTENSIONS_DATA_DIR',
  'PANEL_EXTENSIONS_STRICT',
  'PANEL_EXTENSIONS_SYSTEM_USER_KEY',
  'PANEL_AUTH_MODE',
  'PANEL_AUTH_USER_KEY_ENABLED',
  'PANEL_AUTH_IDP_ENABLED',
  'PANEL_AUTH_IDP_WOA_ENABLED',
  // An https app URL from a local .env would turn Secure cookies on when PANEL_AUTH_SESSION_SECURE is empty.
  'PANEL_AUTH_WOA_APP_URL',
  'PANEL_AUTH_IDP_WOA_APP_URL',
  'PANEL_AUTH_SESSION_SECURE',
  'PANEL_AUTH_SESSION_COOKIE_NAME',
  'PANEL_FEATURE_ANALYTICS_ENABLED',
  'PANEL_CLICKHOUSE_ENABLED',
];

export interface PanelFixture {
  root: string;
  dataDir: string;
  deps: PanelDeps;
  logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>;
  cleanup(): void;
}

/** A logger that records lines and returns itself from child(), so tests can read what a child logged. */
function recordingLogger(logs: PanelFixture['logs']): PanelDeps['logger'] {
  const log = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    logs.push({ level, msg, fields });
  };
  const logger: PanelDeps['logger'] = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: () => logger,
  };
  return logger;
}

/**
 * Real config and deps built in a temp folder with no extension selected. Tests then set
 * `deps.config.extensions` and call createExtensionHost with their own catalog, so the empty
 * product catalog never gets in the way.
 */
export async function createPanelFixture(settings: Record<string, string> = {}): Promise<PanelFixture> {
  const root = mkdtempSync(join(tmpdir(), 'vtc-ext-'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(
    join(root, 'instances.json'),
    JSON.stringify({
      instances: [
        {
          id: 'default',
          name: 'Test',
          gateway_endpoint: 'http://127.0.0.1:1',
          api_key: 'test-gateway-key-not-real',
        },
      ],
    }),
  );
  const stubs: Record<string, string> = {
    METADATA_INSTANCES_CONFIG: join(root, 'instances.json'),
    UI_DIST_DIR: join(root, 'dist'),
    TDAI_AGENT_TEMPLATE_DIR: join(root, 'knowledge', 'agent-templates'),
    PANEL_AUTH_IDENTITY_STORE_PATH: join(root, 'auth', 'identities.json'),
    PANEL_AUTH_SESSION_SECRET_FILE: join(root, 'auth', 'secret'),
    PANEL_FEEDBACK_STORE_PATH: join(root, 'feedback.json'),
    KNOWLEDGE_LLM_BINDING_SYNC: '0',
  };
  for (const key of CLEARED_VARS) stubs[key] = '';
  for (const [key, value] of Object.entries({ ...stubs, ...settings })) vi.stubEnv(key, value);

  // Import after stubbing: the config module loads a dotenv file at import time.
  const { loadPanelConfig } = await import('../../../src/panel/config/panel-config.js');
  const { buildPanelDeps } = await import('../../../src/panel/panel-deps.js');
  const deps = buildPanelDeps(loadPanelConfig());
  const logs: PanelFixture['logs'] = [];
  deps.logger = recordingLogger(logs);
  return {
    root,
    dataDir: join(root, 'knowledge', 'extensions'),
    deps,
    logs,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Replaces the Core gateway with a function keyed by action. The facade sends actions that carry
 * profile data or keys through the HTTP port (so their bodies stay out of the logs), so the same
 * handler also answers `/v3/meta/<action>` posts there.
 */
export function stubMetaKernel(
  deps: PanelDeps,
  handler: (action: string, body: Record<string, unknown>, ctx: unknown) => unknown,
) {
  const invoke = vi.fn(async (action: string, body: Record<string, unknown>, ctx: unknown) => {
    const result = (await handler(action, body, ctx)) as
      | { code: number; message: string; data?: unknown }
      | { data: unknown }
      | undefined;
    if (result && 'code' in result) return { request_id: '', data: null, ...result };
    return { code: 0, message: 'ok', request_id: '', data: result && 'data' in result ? result.data : null };
  });
  deps.metaKernel = { invoke } as unknown as PanelDeps['metaKernel'];
  const postEnvelope = vi.fn(
    async (
      path: string,
      body: Record<string, unknown>,
      cred: { instanceId: string; endpoint: string; apiKey: string; userKey?: string },
    ) => {
      const action = path.replace(/^\/v3\/meta\//, '');
      return invoke(action, body, {
        instanceId: cred.instanceId,
        gatewayEndpoint: cred.endpoint,
        gatewayApiKey: cred.apiKey,
        userKey: cred.userKey,
      });
    },
  );
  deps.kernelHttp = { postEnvelope } as unknown as PanelDeps['kernelHttp'];
  return invoke;
}
