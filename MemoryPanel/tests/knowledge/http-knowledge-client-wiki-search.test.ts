import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpKnowledgeClient } from '../../src/panel/kernel/adapters/http-knowledge-client.js';

afterEach(() => vi.unstubAllGlobals());

async function searchBody(graph?: { hop?: number; decay?: number; minScore?: number }) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { results: [], count: 0 } })));
  vi.stubGlobal('fetch', fetchMock);
  const client = new HttpKnowledgeClient({ baseUrl: 'http://ks.test', authToken: 't', serviceId: 'default' });
  await client.wikiSearch('wiki-1', 'memory', 5, graph);
  const init = (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1];
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('HttpKnowledgeClient.wikiSearch', () => {
  it('sends hop, decay and minScore at the top level, where the knowledge service reads them', async () => {
    expect(await searchBody({ hop: 2, decay: 0.4, minScore: 0.2 })).toEqual({
      wiki_id: 'wiki-1',
      query: 'memory',
      limit: 5,
      hop: 2,
      decay: 0.4,
      minScore: 0.2,
    });
  });

  it('sends no graph fields when none are given', async () => {
    expect(await searchBody()).toEqual({ wiki_id: 'wiki-1', query: 'memory', limit: 5 });
  });
});
