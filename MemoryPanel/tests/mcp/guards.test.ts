import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { stubMetaKernel } from '../extensions/support/panel-fixture.js';
import { createRequestAccess } from '../../src/panel/mcp/access.js';
import {
  DeadlineExceededError,
  createInFlightLimiter,
  withDeadline,
} from '../../src/panel/mcp/guards.js';
import { createMcpServer } from '../../src/panel/mcp/server.js';
import type { RegisteredTool } from '../../src/panel/mcp/registry.js';
import { MCP_URL, callTool, createMcpHarness, mcpHeaders, rpc, type McpHarness } from './support/meta-fixture.js';

let h: McpHarness;
beforeEach(async () => {
  h = await createMcpHarness();
});
afterEach(() => h.cleanup());

describe('request guards', () => {
  it('refuses a request with an Origin header (403) before any Core call', async () => {
    const key = h.world.addUser('ann');
    const res = await rpc(h.app, key, 'tools/list', {}, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(h.world.calls).toHaveLength(0);
  });

  it('refuses a cookie session without the header key (401)', async () => {
    const key = h.world.addUser('ann');
    h.fixture.deps.auth.resolveSession = () => ({ userKey: key, coreUserId: 'ann' }) as never;
    const res = await rpc(h.app, null, 'tools/list', {}, { cookie: 'panel_session=anything' });
    expect(res.status).toBe(401);
    expect(h.world.calls).toHaveLength(0);
  });

  it('answers 400 when x-tdai-service-id is missing', async () => {
    const key = h.world.addUser('ann');
    const res = await h.app.request(MCP_URL, {
      method: 'POST',
      headers: (() => {
        const headers = mcpHeaders(key);
        delete headers['x-tdai-service-id'];
        return headers;
      })(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
  });

  it('answers 400 when no user key is sent', async () => {
    const res = await rpc(h.app, null, 'tools/list');
    expect(res.status).toBe(400);
  });

  it('answers 413 for a body over 1 MB', async () => {
    const key = h.world.addUser('ann');
    const res = await h.app.request(MCP_URL, {
      method: 'POST',
      headers: mcpHeaders(key),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { pad: 'x'.repeat(1024 * 1024 + 10) } }),
    });
    expect(res.status).toBe(413);
    expect(h.world.calls).toHaveLength(0);
  });

  it('answers 405 to GET and DELETE', async () => {
    const key = h.world.addUser('ann');
    for (const method of ['GET', 'DELETE']) {
      const res = await h.app.request(MCP_URL, { method, headers: mcpHeaders(key) });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  it('answers 429 to the 17th parallel request and makes no Core call for it', async () => {
    const { world, fixture } = h;
    const key = world.addUser('ann');
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    stubMetaKernel(fixture.deps, async (action, body, ctx) => {
      await gate;
      return world.handle(action, body, ctx);
    });

    const held = Array.from({ length: 16 }, () => rpc(h.app, key, 'tools/list'));
    // Let the 16 requests reach the gate.
    await new Promise((r) => setTimeout(r, 50));
    const callsBefore = world.calls.length;
    const extra = await rpc(h.app, key, 'tools/list');
    expect(extra.status).toBe(429);
    expect(extra.headers.get('retry-after')).toBe('1');
    expect(world.calls.length).toBe(callsBefore);

    open();
    const done = await Promise.all(held);
    expect(done.map((r) => r.status)).toEqual(Array(16).fill(200));
    // The slots are free again.
    expect((await rpc(h.app, key, 'tools/list')).status).toBe(200);
  });

  it('refuses a batch and makes no Core call', async () => {
    const key = h.world.addUser('ann');
    const batch = Array.from({ length: 100 }, (_, i) => ({
      jsonrpc: '2.0',
      id: i + 1,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    }));
    const res = await h.app.request(MCP_URL, { method: 'POST', headers: mcpHeaders(key), body: JSON.stringify(batch) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32600);
    expect(h.world.calls).toHaveLength(0);
  });

  it('refuses an empty body, a bad JSON body and a non-object body before any Core call', async () => {
    const key = h.world.addUser('ann');
    const send = (body: string) => h.app.request(MCP_URL, { method: 'POST', headers: mcpHeaders(key), body });
    const empty = await send('');
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { code: number } }).error.code).toBe(-32600);
    const broken = await send('{"jsonrpc":');
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as { error: { code: number } }).error.code).toBe(-32700);
    expect((await send('[]')).status).toBe(400);
    expect((await send('7')).status).toBe(400);
    expect((await send('null')).status).toBe(400);
    expect(h.world.calls).toHaveLength(0);
  });

  it('makes one Core call for a bad key and leaves the audit lookup out', async () => {
    const get = vi.spyOn(h.fixture.deps.userIdResolver, 'get');
    const res = await rpc(h.app, 'key-nobody', 'tools/list');
    expect(res.status).toBe(401);
    expect(h.world.calls).toHaveLength(1);
    expect(h.world.callsTo('auth/verify')).toHaveLength(1);
    expect(get).not.toHaveBeenCalled();
  });

  it('leaves the audit lookup out when Core fails and when the key is good', async () => {
    const get = vi.spyOn(h.fixture.deps.userIdResolver, 'get');
    const key = h.world.addUser('ann');
    expect((await rpc(h.app, key, 'tools/list')).status).toBe(200);
    h.world.failWith('auth/verify', 502);
    expect((await rpc(h.app, key, 'tools/list')).status).toBe(503);
    expect(get).not.toHaveBeenCalled();
  });

  it('survives a tool that throws and keeps serving', async () => {
    const { world, fixture } = h;
    const key = world.addUser('ann');
    const tools: RegisteredTool[] = [
      {
        name: 'boom',
        group: 'test',
        description: 'throws',
        inputSchema: { type: 'object', properties: {}, required: [] },
        run: async () => {
          throw new Error('secret internal detail');
        },
      },
      {
        name: 'ok',
        group: 'test',
        description: 'works',
        inputSchema: { type: 'object', properties: {}, required: [] },
        run: async () => ({ text: 'fine', isError: false }),
      },
    ];
    const ctx = { instanceId: 'default', gatewayEndpoint: 'x', gatewayApiKey: 'y', userKey: key };
    const access = createRequestAccess(fixture.deps, ctx, { userId: 'ann', username: 'a', userType: 'user' });
    const server = createMcpServer({ access, logger: fixture.deps.logger, tools });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const boom = await client.callTool({ name: 'boom', arguments: {} });
      expect(boom.isError).toBe(true);
      expect(JSON.stringify(boom.content)).toContain('Agent-Memory could not answer this call.');
      expect(JSON.stringify(boom.content)).not.toContain('secret internal detail');
      const ok = await client.callTool({ name: 'ok', arguments: {} });
      expect(ok.isError).toBe(false);
      expect(fixture.logs.some((l) => l.level === 'error' && l.msg === 'mcp tool failed')).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('returns a tool error when the deadline passes', async () => {
    const { world, fixture } = h;
    const key = world.addUser('ann');
    const tools: RegisteredTool[] = [
      {
        name: 'slow',
        group: 'test',
        description: 'never ends',
        inputSchema: { type: 'object', properties: {}, required: [] },
        run: () => new Promise(() => undefined),
      },
    ];
    const ctx = { instanceId: 'default', gatewayEndpoint: 'x', gatewayApiKey: 'y', userKey: key };
    const access = createRequestAccess(fixture.deps, ctx, { userId: 'ann', username: 'a', userType: 'user' });
    const server = createMcpServer({ access, logger: fixture.deps.logger, tools, deadlineMs: 30 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const res = await client.callTool({ name: 'slow', arguments: {} });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('Agent-Memory timed out.');
    } finally {
      await client.close();
    }
    expect(fixture.logs.find((l) => l.msg === 'mcp tool call')?.fields).toMatchObject({ outcome: 'timeout' });
  });

  it('answers an unknown tool with a tool error', async () => {
    const key = h.world.addUser('ann');
    const res = await callTool(h.app, key, 'nope');
    expect(res.isError).toBe(true);
    expect(res.text).toBe('Unknown tool: nope');
  });
});

describe('guard helpers', () => {
  it('the limiter never goes below zero and frees slots', () => {
    const limiter = createInFlightLimiter(2);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    limiter.release();
    expect(limiter.tryAcquire()).toBe(true);
    limiter.release();
    limiter.release();
    limiter.release();
    expect(limiter.active()).toBe(0);
  });

  it('two limiters do not share a counter', () => {
    const one = createInFlightLimiter(1);
    const two = createInFlightLimiter(1);
    expect(one.tryAcquire()).toBe(true);
    expect(two.tryAcquire()).toBe(true);
  });

  it('withDeadline rejects after the time and passes a result before it', async () => {
    await expect(withDeadline(new Promise(() => undefined), 20)).rejects.toBeInstanceOf(DeadlineExceededError);
    await expect(withDeadline(Promise.resolve(7), 1000)).resolves.toBe(7);
    await expect(withDeadline(Promise.reject(new Error('x')), 1000)).rejects.toThrow('x');
  });
});

/** A request body that never ends, to model a slow sender. */
function stalledBody(): { body: ReadableStream<Uint8Array>; end: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return { body, end: () => controller.close() };
}

describe('in-flight slots', () => {
  let small: McpHarness;
  beforeEach(async () => {
    small = await createMcpHarness(undefined, { maxInFlight: 1, deadlineMs: 40 });
  });
  afterEach(() => small.cleanup());

  it('does not give a slot to a sender with no key that stalls its body', async () => {
    const key = small.world.addUser('ann');
    const slow = stalledBody();
    const stalled = small.app.request(MCP_URL, {
      method: 'POST',
      headers: mcpHeaders(null),
      body: slow.body,
      duplex: 'half',
    } as RequestInit);
    expect((await stalled).status).toBe(400);
    expect((await rpc(small.app, key, 'tools/list')).status).toBe(200);
  });

  it('does not give a slot to a keyed sender that has not finished its body', async () => {
    const key = small.world.addUser('ann');
    const slow = stalledBody();
    const pending = small.app.request(MCP_URL, {
      method: 'POST',
      headers: mcpHeaders(key),
      body: slow.body,
      duplex: 'half',
    } as RequestInit);
    await new Promise((r) => setTimeout(r, 30));
    expect((await rpc(small.app, key, 'tools/list')).status).toBe(200);
    expect(small.world.callsTo('auth/verify')).toHaveLength(1);
    slow.end();
    expect((await pending).status).toBe(400);
  });

  it('keeps the slot until the slow Core work settles, and stops the chain at the next step', async () => {
    const { world, fixture } = small;
    const key = world.addUser('ann');
    world.addTeam('A', 'Alpha', 'ann');
    world.addTeam('B', 'Beta', 'ann');
    let started!: () => void;
    const teamListStarted = new Promise<void>((resolve) => (started = resolve));
    stubMetaKernel(fixture.deps, async (action, body, ctx) => {
      if (action === 'team/list') {
        started();
        await new Promise((r) => setTimeout(r, 200));
      }
      return world.handle(action, body, ctx);
    });

    const first = callTool(small.app, key, 'whoami');
    await teamListStarted;
    const firstResult = await first;
    expect(firstResult.isError).toBe(true);
    expect(firstResult.text).toBe('Agent-Memory timed out.');

    // The response is out, but the Core call is still running: the slot is still taken.
    const busy = await rpc(small.app, key, 'tools/list');
    expect(busy.status).toBe(429);

    await new Promise((r) => setTimeout(r, 300));
    // team/list ended after the deadline; no role lookup was started for it.
    expect(world.callsTo('team-member/get')).toHaveLength(0);
    // The slot is free again.
    expect((await rpc(small.app, key, 'tools/list')).status).toBe(200);
  });
  it('keeps the slot while role lookups still run after another one failed fast', async () => {
    const { world, fixture } = small;
    const key = world.addUser('ann');
    for (const id of ['T1', 'T2', 'T3']) world.addTeam(id, id, 'ann');
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    stubMetaKernel(fixture.deps, async (action, body, ctx) => {
      if (action === 'team-member/get') {
        if (body.team_id === 'T1') return { code: 502, message: 'down' };
        await gate;
      }
      return world.handle(action, body, ctx);
    });

    const first = await callTool(small.app, key, 'whoami');
    expect(first.text).toBe('Agent-Memory could not answer this call.');
    // Two lookups are still running, so the slot is still taken.
    expect((await rpc(small.app, key, 'tools/list')).status).toBe(429);
    open();
    await new Promise((r) => setTimeout(r, 30));
    expect((await rpc(small.app, key, 'tools/list')).status).toBe(200);
  });
});

/** A tool that starts a Core call and does not wait for it. */
const fireAndForgetTool: RegisteredTool = {
  name: 'fire',
  group: 'test',
  description: 'starts a Core call and returns at once',
  inputSchema: { type: 'object', properties: {}, required: [] },
  async run(_args, access) {
    void access.core('team/get', { team_id: 'A' }).catch(() => undefined);
    return { text: 'done', isError: false };
  },
};

describe('slot hold limits', () => {
  it('keeps the slot for a Core call that the tool did not await', async () => {
    const hold = await createMcpHarness(undefined, { maxInFlight: 1, tools: [fireAndForgetTool] });
    try {
      const { world, fixture } = hold;
      const key = world.addUser('ann');
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      stubMetaKernel(fixture.deps, async (action, body, ctx) => {
        if (action === 'team/get') await gate;
        return world.handle(action, body, ctx);
      });
      expect((await callTool(hold.app, key, 'fire')).text).toBe('done');
      expect((await rpc(hold.app, key, 'tools/list')).status).toBe(429);
      open();
      await new Promise((r) => setTimeout(r, 30));
      expect((await rpc(hold.app, key, 'tools/list')).status).toBe(200);
    } finally {
      hold.cleanup();
    }
  });

  it('frees the slot after the hard maximum when a Core call never settles', async () => {
    const hold = await createMcpHarness(undefined, { maxInFlight: 1, holdMaxMs: 80, tools: [fireAndForgetTool] });
    try {
      const { world, fixture } = hold;
      const key = world.addUser('ann');
      stubMetaKernel(fixture.deps, async (action, body, ctx) => {
        if (action === 'team/get') await new Promise(() => undefined);
        return world.handle(action, body, ctx);
      });
      expect((await callTool(hold.app, key, 'fire')).text).toBe('done');
      expect((await rpc(hold.app, key, 'tools/list')).status).toBe(429);
      await new Promise((r) => setTimeout(r, 150));
      expect((await rpc(hold.app, key, 'tools/list')).status).toBe(200);
      const warn = fixture.logs.find((l) => l.msg === 'mcp slot freed with Core work still running');
      expect(warn?.level).toBe('warn');
      expect(JSON.stringify(warn)).not.toContain(key);
      expect(Object.keys(warn!.fields!).sort()).toEqual(['component', 'hold_max_ms']);
    } finally {
      hold.cleanup();
    }
  });
});
