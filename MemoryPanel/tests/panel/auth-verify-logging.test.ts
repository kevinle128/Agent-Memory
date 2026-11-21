import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchKernelHttpAdapter } from '../../src/panel/kernel/adapters/fetch-kernel-http-adapter.js';
import { FetchMetaKernelAdapter } from '../../src/panel/kernel/adapters/fetch-meta-kernel-adapter.js';
import type { Logger } from '../../src/panel/infra/logger.js';

const SECRET_KEY = 'tdai-secret-key-0123456789';
const ctx = {
  instanceId: 'default',
  gatewayEndpoint: 'http://core.test',
  gatewayApiKey: 'gateway-key',
  userKey: SECRET_KEY,
};

function recordingLogger(lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>): Logger {
  const log = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  const logger: Logger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: () => logger,
  };
  return logger;
}

afterEach(() => vi.unstubAllGlobals());

describe('kernel call logging', () => {
  it('keeps the body of auth/verify, and so the user key, out of the logs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: 0, message: 'ok', data: { valid: true } }))),
    );
    const lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
    const adapter = new FetchMetaKernelAdapter(new FetchKernelHttpAdapter(recordingLogger(lines)), 1000);

    const env = await adapter.invoke('auth/verify', { user_key: SECRET_KEY }, ctx);

    expect(env.code).toBe(0);
    expect(JSON.stringify(lines)).not.toContain(SECRET_KEY.slice(0, 8));
    expect(JSON.stringify(lines)).not.toContain('requestBody');
    // The call itself still carries the key in the body.
    const sent = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { body: string };
    expect(JSON.parse(sent.body)).toEqual({ user_key: SECRET_KEY });
  });

  it('still logs a failure of auth/verify, with no body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 401, message: 'bad' }))));
    const lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
    const adapter = new FetchMetaKernelAdapter(new FetchKernelHttpAdapter(recordingLogger(lines)), 1000);
    await adapter.invoke('auth/verify', { user_key: SECRET_KEY }, ctx);
    expect(lines.map((l) => l.level)).toEqual(['warn']);
    expect(JSON.stringify(lines)).not.toContain(SECRET_KEY.slice(0, 8));
  });

  it('logs the body of other actions as before', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: 0, message: 'ok', data: {} }))),
    );
    const lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
    const adapter = new FetchMetaKernelAdapter(new FetchKernelHttpAdapter(recordingLogger(lines)), 1000);
    await adapter.invoke('team/get', { team_id: 'T1' }, ctx);
    expect(JSON.stringify(lines)).toContain('requestBody');
  });
});
