import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import { registerSkillProxyRoutes } from '../../src/panel/http/routes/skill/proxy.js';

function proxyApp(invoke: ReturnType<typeof vi.fn>) {
  const api = new Hono();
  const deps = {
    instanceRegistry: {
      resolve: () => ({
        instance_id: 'default',
        gateway_endpoint: 'http://core.test',
        api_key: 'gateway-key',
      }),
    },
    skillKernel: { invoke },
  } as unknown as PanelDeps;
  registerSkillProxyRoutes(api, deps);
  return api;
}

async function post(api: Hono, action: string, body: Record<string, unknown>, userKey = 'header-key') {
  return api.request(`/skill/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'default',
      'x-tdai-user-key': userKey,
    },
    body: JSON.stringify(body),
  });
}

describe('local inventory proxy user key', () => {
  it.each(['local-inventory/list', 'local-inventory/replace'])(
    'binds %s user_key to the authenticated header',
    async (action) => {
      const invoke = vi.fn(async () => ({ code: 0, message: 'ok', request_id: 'r', data: { items: [] } }));
      const api = proxyApp(invoke);
      const res = await post(api, action, { user_key: 'spoofed-key', machine_id: 'machine-a' }, 'header-key');
      expect(res.status).toBe(200);
      expect(invoke).toHaveBeenCalledTimes(1);
      const [calledAction, body] = invoke.mock.calls[0] as [string, { user_key?: string; machine_id?: string }];
      expect(calledAction).toBe(action);
      expect(body.user_key).toBe('header-key');
      expect(body.user_key).not.toBe('spoofed-key');
      expect(body.machine_id).toBe('machine-a');
    },
  );

  it('supplies user_key when the web body omits it', async () => {
    const invoke = vi.fn(async () => ({ code: 0, message: 'ok', request_id: 'r', data: { items: [] } }));
    const api = proxyApp(invoke);
    const res = await post(api, 'local-inventory/list', {});
    expect(res.status).toBe(200);
    const body = invoke.mock.calls[0]![1] as { user_key?: string };
    expect(body.user_key).toBe('header-key');
  });
});
