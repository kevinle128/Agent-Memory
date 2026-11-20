import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Characterization of the Panel with no extension selected: routes, login methods and
// instances must stay the same once the extension framework exists.

const EXTENSION_VARS = [
  'PANEL_EXTENSIONS',
  'PANEL_EXTENSIONS_DATA_DIR',
  'PANEL_EXTENSIONS_STRICT',
  'PANEL_EXT_VTC_SSO_BASE_URL',
  'PANEL_EXT_VTC_SERVICE_ID',
  'PANEL_EXT_VTC_PRIVATE_KEY',
  'PANEL_EXT_VTC_PUBLIC_BASE_URL',
  'PANEL_EXT_VTC_SUCCESS_STATE',
  'PANEL_EXT_VTC_INSTANCE_ID',
  'PANEL_EXT_VTC_KEY_TTL_DAYS',
  'PANEL_EXT_VTC_LOGIN_MAX_AGE_SECONDS',
  'PANEL_EXT_VTC_DEVICE_CODE_TTL_SECONDS',
];

const AUTH_VARS = [
  'PANEL_AUTH_MODE',
  'PANEL_AUTH_USER_KEY_ENABLED',
  'PANEL_AUTH_IDP_ENABLED',
  'PANEL_AUTH_IDP_WOA_ENABLED',
  'PANEL_AUTH_WOA_APP_TOKEN',
  'PANEL_AUTH_WOA_APP_URL',
  'PANEL_AUTH_WOA_LOGIN_URL',
  'PANEL_AUTH_WOA_LOGOUT_URL',
  'PANEL_AUTH_SESSION_SECURE',
];

const WOA_SETTINGS = {
  PANEL_AUTH_WOA_APP_TOKEN: '0123456789abcdef0123456789abcdef',
  PANEL_AUTH_WOA_APP_URL: 'https://panel.test.invalid',
  PANEL_AUTH_WOA_LOGIN_URL: 'https://woa.test.invalid/login',
  PANEL_AUTH_WOA_LOGOUT_URL: 'https://woa.test.invalid/logout',
};

const VARIANTS: Array<{ name: string; settings: Record<string, string> }> = [
  { name: 'default', settings: {} },
  { name: 'user_key', settings: { PANEL_AUTH_MODE: 'user_key' } },
  { name: 'user_key,woa', settings: { PANEL_AUTH_MODE: 'user_key,woa', ...WOA_SETTINGS } },
  { name: 'woa', settings: { PANEL_AUTH_MODE: 'woa', ...WOA_SETTINGS } },
];

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'vtc-baseline-'));
  roots.push(root);
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
  return root;
}

async function buildAppWith(root: string, settings: Record<string, string> = {}) {
  const stubs: Record<string, string> = {
    METADATA_INSTANCES_CONFIG: join(root, 'instances.json'),
    UI_DIST_DIR: join(root, 'dist'),
    TDAI_AGENT_TEMPLATE_DIR: join(root, 'knowledge', 'agent-templates'),
    PANEL_AUTH_IDENTITY_STORE_PATH: join(root, 'auth', 'identities.json'),
    PANEL_AUTH_SESSION_SECRET_FILE: join(root, 'auth', 'secret'),
    PANEL_FEEDBACK_STORE_PATH: join(root, 'feedback.json'),
    PANEL_FEATURE_ANALYTICS_ENABLED: '',
    PANEL_CLICKHOUSE_ENABLED: '',
    KNOWLEDGE_LLM_BINDING_SYNC: '0',
  };
  for (const key of [...AUTH_VARS, ...EXTENSION_VARS]) stubs[key] = '';
  for (const [key, value] of Object.entries({ ...stubs, ...settings })) vi.stubEnv(key, value);

  // Import after stubbing: the config module loads a dotenv file at import time.
  const { loadPanelConfig } = await import('../../src/panel/config/panel-config.js');
  const { buildPanelDeps } = await import('../../src/panel/panel-deps.js');
  const { buildPanelApp } = await import('../../src/panel/http/app.js');
  return buildPanelApp(buildPanelDeps(loadPanelConfig()));
}

function routeList(app: Awaited<ReturnType<typeof buildAppWith>>): string[] {
  return [...new Set(app.routes.map((r) => `${r.method} ${r.path}`))].sort();
}

describe('panel with no extension selected', () => {
  for (const variant of VARIANTS) {
    it(`serves the same routes when no extension is selected (${variant.name})`, async () => {
      const app = await buildAppWith(makeRoot(), variant.settings);
      expect(routeList(app)).toMatchSnapshot();
    });

    it(`lists the same login methods (${variant.name})`, async () => {
      const app = await buildAppWith(makeRoot(), variant.settings);
      const res = await app.request('/api/v1/auth/methods');
      expect({ status: res.status, body: await res.json() }).toMatchSnapshot();
    });
  }

  it('lists the same instances and capabilities', async () => {
    const app = await buildAppWith(makeRoot());
    const res = await app.request('/api/v1/meta/instances');
    expect({ status: res.status, body: await res.json() }).toMatchSnapshot();
  });

  it('has no extensions endpoint', async () => {
    const app = await buildAppWith(makeRoot());
    const res = await app.request('/api/v1/extensions');
    expect(res.status).toBe(404);
  });

  it('has no VTC pages', async () => {
    const app = await buildAppWith(makeRoot());
    expect((await app.request('/ext/vtc/device')).status).toBe(404);
    expect((await app.request('/ext/vtc/sso/login')).status).toBe(404);
    const post = await app.request('/api/v1/ext/vtc/device/start', { method: 'POST' });
    expect(post.status).toBe(404);
  });

  it('falls back to the SPA for unknown non-API paths', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html><title>spa</title>');
    const app = await buildAppWith(root);
    const res = await app.request('/ext/vtc/device');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>spa</title>');
  });

  it('creates no extension files on disk', async () => {
    const root = makeRoot();
    await buildAppWith(root);
    expect(existsSync(join(root, 'knowledge', 'extensions'))).toBe(false);
  });
});
