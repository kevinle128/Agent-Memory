import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaEnvelope } from '../../src/panel/kernel/envelope.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import { registerChatMemoryRoutes } from '../../src/panel/http/routes/chat-memory.js';

// Session list route, session filter on /layer L0 and L1, and L1 source refs.

const INSTANCE_ID = 'inst-test';
const TEAM_ID = 'team-1';
const AGENT_ID = 'agt-1';
const OWNER_ID = 'usr-owner';
const BLOCK_ID = `chat_memory-${TEAM_ID}-${AGENT_ID}`;

function ok<T>(data: T): MetaEnvelope<T> {
  return { code: 0, message: 'ok', request_id: 'req', data };
}

interface KernelCall {
  path: string;
  body: Record<string, unknown>;
}

describe('chat-memory sessions and session-aware layers', () => {
  let app: Hono;
  let kernelCalls: KernelCall[];
  let callerId: string;
  let assetVisibility: string;
  let kernelReply: (path: string, body: Record<string, unknown>) => MetaEnvelope<unknown>;

  beforeEach(() => {
    kernelCalls = [];
    callerId = OWNER_ID;
    assetVisibility = 'private';
    kernelReply = () => ok({});

    const invoke = vi.fn(async (action: string) => {
      switch (action) {
        case 'auth/verify':
          return ok({ valid: true, user: { user_id: callerId } });
        case 'asset/get':
          return ok({
            asset_id: BLOCK_ID,
            team_id: TEAM_ID,
            asset_type: 'chat_memory',
            name: 'mem',
            owner_user_id: OWNER_ID,
            visibility: assetVisibility,
            status: 'active',
            updated_at: '2026-11-07T00:00:00.000Z',
          });
        case 'team-member/list':
        case 'agent/list':
        case 'agent-fixed-asset/list':
          return ok({ items: [], total: 0 });
        default:
          throw new Error(`unexpected action ${action}`);
      }
    });
    const postEnvelope = vi.fn(async (path: string, body: Record<string, unknown>) => {
      kernelCalls.push({ path, body });
      return kernelReply(path, body);
    });

    const deps = {
      config: { auth: { sessionCookieName: 'sid' } },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      instanceRegistry: {
        resolve: () => ({ instance_id: INSTANCE_ID, gateway_endpoint: 'http://core', api_key: 'k' }),
      },
      auth: { resolveSession: () => null },
      metaKernel: { invoke },
      kernelHttp: { postEnvelope },
      userIdResolver: { warm: vi.fn() },
    } as unknown as PanelDeps;

    app = new Hono();
    registerChatMemoryRoutes(app, deps);
  });

  async function post(path: string, body: Record<string, unknown>) {
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tdai-service-id': INSTANCE_ID,
        'x-tdai-user-key': 'key-1',
      },
      body: JSON.stringify(body),
    });
    return (await res.json()) as MetaEnvelope<Record<string, unknown>>;
  }

  describe('POST /chat-memory/sessions', () => {
    it('maps kernel sessions and passes the owner scope and time range', async () => {
      kernelReply = () =>
        ok({
          sessions: [
            {
              session_id: 'sess-a',
              first_ts: '2026-11-07T08:00:00.000Z',
              last_ts: '2026-11-07T08:08:00.000Z',
              message_count: 42,
              first_user_message: 'Add a quick key to switch models',
              project_name: 'paseo',
              project_hash: '0123456789abcdef',
              l1_count: 5,
            },
          ],
          total: 1,
        });

      const env = await post('/chat-memory/sessions', {
        block_id: BLOCK_ID,
        limit: 20,
        offset: 0,
        time_start: '2026-11-01T00:00',
      });

      expect(env.code).toBe(0);
      expect(env.data).toEqual({
        sessions: [
          {
            session_id: 'sess-a',
            first_ts: '2026-11-07T08:00:00.000Z',
            last_ts: '2026-11-07T08:08:00.000Z',
            message_count: 42,
            title: 'Add a quick key to switch models',
            project_name: 'paseo',
            project_hash: '0123456789abcdef',
            l1_count: 5,
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      });
      expect(kernelCalls).toHaveLength(1);
      expect(kernelCalls[0]!.path).toBe('/v3/conversation/sessions');
      expect(kernelCalls[0]!.body).toMatchObject({
        team_id: TEAM_ID,
        agent_id: AGENT_ID,
        user_id: OWNER_ID,
        limit: 20,
        offset: 0,
      });
      expect(kernelCalls[0]!.body.time_start).toBe(new Date('2026-11-01T00:00').toISOString());
      expect(kernelCalls[0]!.body).not.toHaveProperty('session_id');
    });

    it('rejects a caller who cannot read the asset', async () => {
      callerId = 'usr-stranger';
      const env = await post('/chat-memory/sessions', { block_id: BLOCK_ID });

      expect(env.code).toBe(403);
      expect(kernelCalls).toHaveLength(0);
    });

    it('requires block_id and returns an empty list for a user-built asset', async () => {
      expect((await post('/chat-memory/sessions', {})).code).toBe(400);

      const env = await post('/chat-memory/sessions', { block_id: 'mem-123' });
      expect(env.code).toBe(0);
      expect(env.data).toMatchObject({ sessions: [], total: 0 });
    });

    it('passes a kernel error through', async () => {
      kernelReply = () => ({ code: 501, message: 'not supported', request_id: 'r', data: null });
      const env = await post('/chat-memory/sessions', { block_id: BLOCK_ID });

      expect(env.code).toBe(501);
    });
  });

  describe('POST /chat-memory/layer with session_id', () => {
    it('L0 returns one session in conversation order across kernel pages', async () => {
      const all = Array.from({ length: 150 }, (_, i) => ({
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`,
        session_id: 'sess-a',
        timestamp: '2026-11-07T09:00:00.000Z',
        message_time: new Date(Date.UTC(2026, 10, 7, 8, 0, i)).toISOString(),
      }));
      kernelReply = (_path, body) => {
        const offset = body.offset as number;
        const limit = body.limit as number;
        return ok({ messages: all.slice(offset, offset + limit), total: all.length });
      };

      const env = await post('/chat-memory/layer', {
        block_id: BLOCK_ID,
        layer: 'L0',
        session_id: 'sess-a',
        limit: 120,
        offset: 0,
        time_start: '2026-11-07T08:00:30.000Z',
      });

      expect(env.code).toBe(0);
      const items = env.data!.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(120);
      expect(items[0]).toMatchObject({
        id: 'm0',
        role: 'user',
        session_id: 'sess-a',
        created_at: '2026-11-07T08:00:00.000Z',
      });
      expect(items[119]!.id).toBe('m119');
      expect(env.data!.total).toBe(150);
      expect(kernelCalls.map((c) => [c.body.offset, c.body.limit])).toEqual([
        [0, 100],
        [100, 20],
      ]);
      for (const call of kernelCalls) {
        expect(call.path).toBe('/v3/conversation/query');
        expect(call.body).toMatchObject({ session_id: 'sess-a', order: 'asc', user_id: OWNER_ID });
        // The date range selects sessions; it does not cut a conversation.
        expect(call.body).not.toHaveProperty('time_start');
      }
    });

    it('L0 without session_id still returns session_id on each item', async () => {
      kernelReply = () =>
        ok({
          messages: [{ id: 'm1', role: 'user', content: 'hi', session_id: 'sess-b', timestamp: '2026-11-07T09:00:00.000Z' }],
          total: 1,
        });

      const env = await post('/chat-memory/layer', { block_id: BLOCK_ID, layer: 'L0' });

      expect(env.code).toBe(0);
      expect((env.data!.items as Array<Record<string, unknown>>)[0]).toMatchObject({
        id: 'm1',
        session_id: 'sess-b',
        created_at: '2026-11-07T09:00:00.000Z',
      });
      expect(kernelCalls[0]!.body).not.toHaveProperty('session_id');
      expect(kernelCalls[0]!.body).not.toHaveProperty('order');
    });

    it('L1 sends session_id only for a filter and returns refs from source ids', async () => {
      kernelReply = () =>
        ok({
          items: [
            { id: 'l1-a', type: 'persona', content: 'fact', session_id: 'sess-a', source_message_ids: ['m1', 'm2'], created_at: '2026-11-07T08:00:00.000Z' },
            { id: 'l1-old', type: 'persona', content: 'old fact', created_at: '2026-11-01T08:00:00.000Z' },
          ],
          total: 2,
        });

      const unfiltered = await post('/chat-memory/layer', { block_id: BLOCK_ID, layer: 'L1' });
      expect(unfiltered.code).toBe(0);
      expect(kernelCalls[0]!.path).toBe('/v3/atomic/query');
      // Without a filter, no session_id goes to the kernel, so every memory of the agent is returned.
      expect(kernelCalls[0]!.body).not.toHaveProperty('session_id');
      const items = unfiltered.data!.items as Array<Record<string, unknown>>;
      expect(items[0]).toMatchObject({ id: 'l1-a', refs: ['m1', 'm2'], session_id: 'sess-a' });
      expect(items[1]).toMatchObject({ id: 'l1-old', refs: [] });
      expect(items[1]!.session_id).toBeUndefined();

      await post('/chat-memory/layer', { block_id: BLOCK_ID, layer: 'L1', session_id: ' sess-a ' });
      expect(kernelCalls[1]!.body.session_id).toBe('sess-a');
    });

    it('rejects a session_id that is not a string', async () => {
      const env = await post('/chat-memory/layer', { block_id: BLOCK_ID, layer: 'L0', session_id: 42 });

      expect(env.code).toBe(400);
      expect(kernelCalls).toHaveLength(0);
    });
  });
});
