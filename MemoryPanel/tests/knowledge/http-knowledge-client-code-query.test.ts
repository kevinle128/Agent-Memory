import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpKnowledgeClient } from '../../src/panel/kernel/adapters/http-knowledge-client.js';

/** A real HTTP server that answers like the knowledge service: a failed code query is `code: 0` with HTTP 500. */
let server: Server;
let client: HttpKnowledgeClient;
const seen: Array<{ url: string; body: unknown }> = [];

beforeEach(async () => {
  seen.length = 0;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', body: JSON.parse(raw || '{}') });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/v3/code-graph/search') return send(500, { code: 0, message: 'ok', data: { text: 'symbol not found', isError: true } });
      if (req.url === '/v3/code-graph/explore') return send(200, { code: 0, data: { text: 'two files', isError: false } });
      if (req.url === '/v3/code-graph/callers') return send(502, { code: 502, message: 'engine down' });
      return send(500, { message: 'no envelope' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  client = new HttpKnowledgeClient({ baseUrl: `http://127.0.0.1:${port}`, authToken: 't', serviceId: 'default' });
});
afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('HttpKnowledgeClient.codeGraphQuery', () => {
  it('keeps the old behavior by default: a failed query answered with HTTP 500 throws', async () => {
    await expect(client.codeGraphQuery('cg-1', 'search', { query: 'x' })).rejects.toMatchObject({ httpStatus: 500 });
  });

  it('returns the text of a failed query when returnToolErrors is set', async () => {
    const result = await client.codeGraphQuery('cg-1', 'search', { query: 'x' }, { returnToolErrors: true });
    expect(result).toEqual({ text: 'symbol not found', isError: true });
    expect(seen[0]).toEqual({ url: '/v3/code-graph/search', body: { code_graph_id: 'cg-1', query: 'x' } });
  });

  it('returns a good answer in both modes', async () => {
    expect(await client.codeGraphQuery('cg-1', 'explore', {})).toEqual({ text: 'two files', isError: false });
    expect(await client.codeGraphQuery('cg-1', 'explore', {}, { returnToolErrors: true })).toEqual({ text: 'two files', isError: false });
  });

  it('still throws for an envelope that carries an error code or no envelope, even with the option', async () => {
    await expect(client.codeGraphQuery('cg-1', 'callers', {}, { returnToolErrors: true })).rejects.toMatchObject({ httpStatus: 502 });
    await expect(client.codeGraphQuery('cg-1', 'files', {}, { returnToolErrors: true })).rejects.toMatchObject({ httpStatus: 500 });
  });
});
