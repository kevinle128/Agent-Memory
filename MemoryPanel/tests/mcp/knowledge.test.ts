import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequestAccess } from '../../src/panel/mcp/access.js';
import { DeadlineExceededError, createRequestLifecycle } from '../../src/panel/mcp/guards.js';
import { CUT_NOTICE, MAX_RESULT_CHARS } from '../../src/panel/mcp/tools/knowledge.js';
import { NO_TEAM_MESSAGE } from '../../src/panel/mcp/tools/whoami.js';
import { seedKnowledgeWorld } from './support/knowledge-world.js';
import { callTool, createMcpHarness, type McpHarness } from './support/meta-fixture.js';

let h: McpHarness;
beforeEach(async () => {
  h = await createMcpHarness();
  seedKnowledgeWorld(h);
});
afterEach(() => h.cleanup());

const keyOf = (u: string) => h.world.keyOf(u);
const notReadable = (id: string) => `No readable wiki or code graph with id ${id}.`;

async function listIds(user: string, args: Record<string, unknown> = {}): Promise<string[]> {
  const res = await callTool(h.app, keyOf(user), 'knowledge_list', args);
  expect(res.isError, res.text).toBe(false);
  return (res.json().items as Array<{ knowledge_id: string }>).map((i) => i.knowledge_id).sort();
}

async function readWiki(user: string, id: string, args: Record<string, unknown> = {}) {
  return callTool(h.app, keyOf(user), 'wiki_read', { wiki_id: id, refs: ['overview'], ...args });
}

async function searchCode(user: string, id: string, args: Record<string, unknown> = {}) {
  return callTool(h.app, keyOf(user), 'code_search', { code_graph_id: id, query: 'sym', ...args });
}

function expectRefused(res: { isError: boolean; text: string }, id: string) {
  expect(res.isError).toBe(true);
  expect(res.text).toBe(notReadable(id));
}

describe('persona: member of A', () => {
  it('lists the team wiki and code graph of A, labelled, and nothing else', async () => {
    const res = await callTool(h.app, keyOf('mia'), 'knowledge_list');
    expect(res.json().items).toEqual([
      expect.objectContaining({
        team_id: 'A', team_name: 'Alpha', knowledge_id: 'wiki-a-team', type: 'wiki', visibility: 'team',
        page_count: 1, status: 'ready',
      }),
      expect.objectContaining({
        team_id: 'A', team_name: 'Alpha', knowledge_id: 'cg-a-team', type: 'code_graph', visibility: 'team',
        repo_name: 'repo-cg-a-team', branch: 'main', status: 'ready',
      }),
    ]);
  });

  it('reads a team wiki and searches a team code graph, each result starting with the team', async () => {
    const wiki = await readWiki('mia', 'wiki-a-team');
    expect(wiki.isError).toBe(false);
    expect(wiki.text.startsWith('team: Alpha (A)\n')).toBe(true);
    expect(wiki.text).toContain('Overview of the a team wiki');
    const code = await searchCode('mia', 'cg-a-team');
    expect(code.isError).toBe(false);
    expect(code.text).toBe('team: Alpha (A)\nsymbol hit in a graph');
  });

  it('cannot read a restricted wiki or the private wiki of another member', async () => {
    expectRefused(await readWiki('mia', 'wiki-a-restricted'), 'wiki-a-restricted');
    expectRefused(await readWiki('mia', 'wiki-a-private'), 'wiki-a-private');
    expect(await listIds('mia')).toEqual(['cg-a-team', 'wiki-a-team']);
  });

  it('is refused for every id of team B, and for team_id=B', async () => {
    for (const id of ['wiki-b-team', 'wiki-b-restricted']) expectRefused(await readWiki('mia', id), id);
    expectRefused(await searchCode('mia', 'cg-b-team'), 'cg-b-team');
    const list = await callTool(h.app, keyOf('mia'), 'knowledge_list', { team_id: 'B' });
    expect(list.isError).toBe(true);
    expect(list.text).toBe('No readable team with id B.');
    expect(h.ks.calls).toEqual([]);
  });

  it('gets the same answer as a reviewer', async () => {
    expect(await listIds('rev')).toEqual(['cg-a-team', 'wiki-a-team']);
    expectRefused(await readWiki('rev', 'wiki-a-restricted'), 'wiki-a-restricted');
  });

  it('can read the wiki of A with team_id=A, and is refused when team_id names another team', async () => {
    expect((await readWiki('mia', 'wiki-a-team', { team_id: 'A' })).isError).toBe(false);
    expectRefused(await readWiki('mia', 'wiki-a-team', { team_id: 'B' }), 'wiki-a-team');
  });
});

describe('persona: admin of A', () => {
  it('adds the restricted wiki, never the private wiki of another member', async () => {
    expect(await listIds('adm')).toEqual(['cg-a-team', 'wiki-a-restricted', 'wiki-a-team']);
    expect((await readWiki('adm', 'wiki-a-restricted', { refs: ['plan'] })).text).toContain('Secret plan of a');
    expectRefused(await readWiki('adm', 'wiki-a-private'), 'wiki-a-private');
  });

  it('is refused for B, by id and by team_id', async () => {
    expectRefused(await readWiki('adm', 'wiki-b-team'), 'wiki-b-team');
    expectRefused(await searchCode('adm', 'cg-b-team'), 'cg-b-team');
    const list = await callTool(h.app, keyOf('adm'), 'knowledge_list', { team_id: 'B' });
    expect(list.text).toBe('No readable team with id B.');
  });

  it('lets the owner see their own private wiki', async () => {
    expect(await listIds('ann')).toContain('wiki-a-private');
    expect((await readWiki('ann', 'wiki-a-private', { refs: ['diary'] })).isError).toBe(false);
  });
});

describe('persona: member of A and admin of B', () => {
  it('sees A without the restricted wiki and B with it, every row labelled', async () => {
    const res = await callTool(h.app, keyOf('mixed'), 'knowledge_list');
    const rows = res.json().items as Array<{ knowledge_id: string; team_id: string; team_name: string }>;
    expect(rows.map((r) => r.knowledge_id).sort()).toEqual([
      'cg-a-team', 'cg-b-team', 'wiki-a-team', 'wiki-b-restricted', 'wiki-b-team',
    ]);
    for (const r of rows) {
      expect(r.team_name).toBe(r.team_id === 'A' ? 'Alpha' : 'Beta');
    }
    expectRefused(await readWiki('mixed', 'wiki-a-restricted'), 'wiki-a-restricted');
    expect((await readWiki('mixed', 'wiki-b-restricted', { refs: ['plan'] })).isError).toBe(false);
  });
});

describe('persona: admin of A and B', () => {
  it('sees both teams, labelled', async () => {
    expect(await listIds('dual')).toEqual([
      'cg-a-team', 'cg-b-team', 'wiki-a-restricted', 'wiki-a-team', 'wiki-b-restricted', 'wiki-b-team',
    ]);
    expect((await readWiki('dual', 'wiki-b-team')).text.startsWith('team: Beta (B)\n')).toBe(true);
    expect(await listIds('dual', { team_id: 'B', type: 'wiki' })).toEqual(['wiki-b-restricted', 'wiki-b-team']);
  });
});

describe('persona: system admin, admin of A, not in B', () => {
  it('reads A as an admin', async () => {
    expect(await listIds('root')).toEqual(['cg-a-team', 'wiki-a-restricted', 'wiki-a-team']);
  });

  it('is refused for B although asset/get shows the asset to a system admin', async () => {
    h.world.clearCalls();
    expectRefused(await readWiki('root', 'wiki-b-team'), 'wiki-b-team');
    expectRefused(await searchCode('root', 'cg-b-team'), 'cg-b-team');
    expect(h.world.callsTo('asset/get').length).toBeGreaterThan(0);
    expect(h.ks.calls).toEqual([]);
    const list = await callTool(h.app, keyOf('root'), 'knowledge_list', { team_id: 'B' });
    expect(list.text).toBe('No readable team with id B.');
  });
});

describe('persona: user with no team', () => {
  it('lists nothing, with the message, and is refused for every id', async () => {
    const res = await callTool(h.app, keyOf('lone'), 'knowledge_list');
    expect(res.json()).toEqual({ items: [], message: NO_TEAM_MESSAGE });
    for (const id of ['wiki-a-team', 'wiki-b-team']) expectRefused(await readWiki('lone', id), id);
    expectRefused(await searchCode('lone', 'cg-a-team'), 'cg-a-team');
  });
});

describe('changes between two calls', () => {
  it('refuses a member who was removed, and lists nothing for them', async () => {
    expect((await readWiki('mia', 'wiki-a-team')).isError).toBe(false);
    h.world.removeMember('A', 'mia');
    expectRefused(await readWiki('mia', 'wiki-a-team'), 'wiki-a-team');
    expect((await callTool(h.app, keyOf('mia'), 'knowledge_list')).json()).toEqual({ items: [], message: NO_TEAM_MESSAGE });
  });

  it('takes the restricted wiki from an admin who was demoted', async () => {
    expect((await readWiki('adm', 'wiki-a-restricted', { refs: ['plan'] })).isError).toBe(false);
    h.world.setRole('A', 'adm', 'member');
    expectRefused(await readWiki('adm', 'wiki-a-restricted'), 'wiki-a-restricted');
    expect(await listIds('adm')).toEqual(['cg-a-team', 'wiki-a-team']);
  });

  it('refuses the owner of an asset who left the team', async () => {
    h.world.addAsset({ asset_id: 'wiki-mia', team_id: 'A', owner_user_id: 'mia' });
    h.ks.addWiki('wiki-mia', { team_id: 'A', pages: [{ ref: 'overview', title: 'x', content: 'mine' }] });
    expect((await readWiki('mia', 'wiki-mia')).isError).toBe(false);
    h.world.removeMember('A', 'mia');
    expectRefused(await readWiki('mia', 'wiki-mia'), 'wiki-mia');
  });

  it('refuses a revoked key with HTTP 401', async () => {
    h.world.setKeyStatus(keyOf('mia'), 'revoked');
    expect((await readWiki('mia', 'wiki-a-team')).status).toBe(401);
  });
});

describe('asset type and error shape', () => {
  it('refuses a wiki id on a code tool and a code graph id on a wiki tool', async () => {
    expectRefused(await searchCode('mia', 'wiki-a-team'), 'wiki-a-team');
    expectRefused(await readWiki('mia', 'cg-a-team'), 'cg-a-team');
  });

  it('answers a missing id, a forbidden id and an id of another team with the same text', async () => {
    const texts = [
      (await readWiki('mia', 'wiki-nothing')).text,
      (await readWiki('mia', 'wiki-a-restricted')).text,
      (await readWiki('mia', 'wiki-b-team')).text,
      (await readWiki('mia', 'wiki-a-private')).text,
    ];
    expect(texts.map((t) => t.replace(/wiki-[a-z-]+/, 'ID'))).toEqual(Array(4).fill('No readable wiki or code graph with id ID.'));
  });

  it('refuses before it checks the other arguments', async () => {
    const res = await callTool(h.app, keyOf('mia'), 'wiki_read', { wiki_id: 'wiki-b-team', refs: 'not-an-array' });
    expectRefused(res, 'wiki-b-team');
  });

  it('refuses an id that is too long without calling the knowledge service', async () => {
    const id = 'w'.repeat(500);
    const res = await readWiki('mia', id);
    expect(res.isError).toBe(true);
    expect(res.text).toBe(notReadable(id.slice(0, 64)));
  });
});

describe('arguments', () => {
  it('names a missing id and a bad argument for a readable asset', async () => {
    const noId = await callTool(h.app, keyOf('mia'), 'wiki_read', { refs: ['overview'] });
    expect(noId.text).toBe('Missing argument wiki_id.');
    const noQuery = await callTool(h.app, keyOf('mia'), 'code_search', { code_graph_id: 'cg-a-team' });
    expect(noQuery.text).toBe('Missing argument query.');
    const badLimit = await searchCode('mia', 'cg-a-team', { limit: 1000 });
    expect(badLimit.text).toBe('Invalid argument limit: expected a value of at most 100.');
    const badKind = await searchCode('mia', 'cg-a-team', { kind: 'file' });
    expect(badKind.text).toContain('one of function, method');
    const badRefs = await readWiki('mia', 'wiki-a-team', { refs: 'overview' });
    expect(badRefs.text).toBe('Invalid argument refs: expected a non-empty array.');
    const badType = await callTool(h.app, keyOf('mia'), 'knowledge_list', { type: 'skill' });
    expect(badType.text).toBe('Invalid argument type: expected one of wiki, code_graph.');
    expect(h.ks.calls.filter((c) => c.method === 'codeGraphQuery' || c.method === 'wikiPageRead')).toEqual([]);
  });

  it('sends the knowledge service the arguments of the tool schema, and never team_id', async () => {
    await searchCode('mia', 'cg-a-team', { kind: 'class', limit: 5, team_id: 'A', extra: 'x' });
    expect(h.ks.calls.find((c) => c.method === 'codeGraphQuery')?.args).toEqual([
      'cg-a-team', 'search', { query: 'sym', kind: 'class', limit: 5 },
    ]);
    await callTool(h.app, keyOf('mia'), 'wiki_search', {
      wiki_id: 'wiki-a-team', query: 'team', limit: 3, hop: 1, decay: 0.3, minScore: 0.2, team_id: 'A',
    });
    expect(h.ks.calls.find((c) => c.method === 'wikiSearch')?.args).toEqual([
      'wiki-a-team', 'team', 3, { hop: 1, decay: 0.3, minScore: 0.2 },
    ]);
  });

  it('runs each code tool against the query of the knowledge service that its endpoint names', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['code_explore', { query: 'q' }],
      ['code_callers', { symbol: 's' }],
      ['code_callees', { symbol: 's' }],
      ['code_impact', { symbol: 's', depth: 3 }],
      ['code_node', { symbol: 's', includeCode: true, line: 4 }],
      ['code_status', {}],
      ['code_files', { format: 'flat' }],
    ];
    for (const [tool, args] of calls) {
      const res = await callTool(h.app, keyOf('mia'), tool, { code_graph_id: 'cg-a-team', ...args });
      expect(res.isError, `${tool}: ${res.text}`).toBe(false);
    }
    expect(h.ks.calls.filter((c) => c.method === 'codeGraphQuery').map((c) => c.args[1])).toEqual([
      'explore', 'callers', 'callees', 'impact', 'node', 'status', 'files',
    ]);
  });

  it('reads the list, graph and pages of a wiki', async () => {
    const list = await callTool(h.app, keyOf('mia'), 'wiki_list', { wiki_id: 'wiki-a-team' });
    expect(JSON.parse(list.text.split('\n').slice(1).join('\n')).items[0].title).toBe('Overview');
    const graph = await callTool(h.app, keyOf('mia'), 'wiki_graph', { wiki_id: 'wiki-a-team' });
    expect(graph.text).toContain('"nodes"');
  });
});

describe('code graph that is still building', () => {
  it('lets the owner read its status, but not search it', async () => {
    h.ks.addCodeGraph('cg-new', { team_id: 'A', owner_user_id: 'mia', status: 'processing', text: { status: 'indexing 40%' } });
    const status = await callTool(h.app, keyOf('mia'), 'code_status', { code_graph_id: 'cg-new' });
    expect(status.text).toBe('team: Alpha (A)\nindexing 40%');
    expectRefused(await searchCode('mia', 'cg-new'), 'cg-new');
  });

  it('refuses another member and a user outside the team', async () => {
    h.ks.addCodeGraph('cg-new', { team_id: 'A', owner_user_id: 'mia', status: 'processing' });
    expectRefused(await callTool(h.app, keyOf('rev'), 'code_status', { code_graph_id: 'cg-new' }), 'cg-new');
    expectRefused(await callTool(h.app, keyOf('lone'), 'code_status', { code_graph_id: 'cg-new' }), 'cg-new');
  });
});

describe('result size and failures', () => {
  it('cuts a result over the limit and tells the agent', async () => {
    h.ks.addCodeGraph('cg-big', { team_id: 'A', text: { search: 'x'.repeat(MAX_RESULT_CHARS + 5000) } });
    h.world.addAsset({ asset_id: 'cg-big', team_id: 'A', owner_user_id: 'ann', asset_type: 'code_graph' });
    const res = await searchCode('mia', 'cg-big');
    expect(res.isError).toBe(false);
    expect(res.text.endsWith(`\n${CUT_NOTICE}`)).toBe(true);
    expect(res.text.length).toBeLessThan(MAX_RESULT_CHARS + 200);
    expect(CUT_NOTICE).toBe('Output cut at 60000 characters. Narrow the query.');
  });

  it('keeps a small result whole', async () => {
    expect((await searchCode('mia', 'cg-a-team')).text).not.toContain('Output cut');
  });

  it('passes the error flag of a code tool through', async () => {
    h.ks.client.codeGraphQuery = async () => ({ text: 'symbol not found', isError: true });
    const res = await searchCode('mia', 'cg-a-team');
    expect(res.isError).toBe(true);
    expect(res.text).toBe('team: Alpha (A)\nsymbol not found');
  });

  it('answers a knowledge service failure with the generic error and no detail', async () => {
    h.ks.failWith('wikiPageRead');
    const res = await readWiki('mia', 'wiki-a-team');
    expect(res.isError).toBe(true);
    expect(res.text).toBe('Agent-Memory could not answer this call.');
  });

  it('does not read a Core failure in knowledge_list as an empty list', async () => {
    h.world.failWith('asset/list-accessible', 500);
    const res = await callTool(h.app, keyOf('mia'), 'knowledge_list');
    expect(res.isError).toBe(true);
    expect(res.text).toBe('Agent-Memory could not answer this call.');
  });

  it('lists more than one Core page of assets', async () => {
    for (let i = 0; i < 130; i++) {
      h.world.addAsset({ asset_id: `wiki-bulk-${i}`, team_id: 'A', owner_user_id: 'ann' });
      h.ks.addWiki(`wiki-bulk-${i}`, { team_id: 'A' });
    }
    const res = await callTool(h.app, keyOf('mia'), 'knowledge_list', { type: 'wiki' });
    expect(res.json().total).toBe(131);
    expect(h.world.callsTo('asset/list-accessible').length).toBeGreaterThanOrEqual(2);
  });

  it('sends the caller as user_id to Core and never an id from the arguments', async () => {
    await callTool(h.app, keyOf('mia'), 'knowledge_list', { user_id: 'ann' });
    for (const call of h.world.callsTo('asset/list-accessible')) expect(call.body.user_id).toBe('mia');
  });
});

describe('knowledge access of a request', () => {
  it('refuses a knowledge call once the request is over, and tracks calls that are running', async () => {
    const ctx = { instanceId: 'default', gatewayEndpoint: 'x', gatewayApiKey: 'y', userKey: keyOf('mia') };
    const lifecycle = createRequestLifecycle();
    const access = createRequestAccess(h.fixture.deps, ctx, { userId: 'mia', username: 'n', userType: 'user' }, lifecycle);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = h.ks.client.wikiGraph;
    h.ks.client.wikiGraph = async (id: string) => {
      await gate;
      return original(id);
    };
    const running = access.knowledge().wikiGraph('wiki-a-team');
    let idle = false;
    void lifecycle.whenIdle().then(() => (idle = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(idle).toBe(false);
    release();
    await running;
    await lifecycle.whenIdle();
    await new Promise((r) => setTimeout(r, 0));
    expect(idle).toBe(true);

    lifecycle.stop();
    await expect(access.knowledge().wikiGraph('wiki-a-team')).rejects.toBeInstanceOf(DeadlineExceededError);
    await expect(access.checkKnowledgeRead('wiki-a-team')).rejects.toBeInstanceOf(DeadlineExceededError);
  });
});

describe('assets that are not active', () => {
  beforeEach(() => {
    for (const status of ['deprecated', 'failed']) {
      h.world.addAsset({ asset_id: `wiki-${status}`, team_id: 'A', owner_user_id: 'ann', status });
      h.ks.addWiki(`wiki-${status}`, { team_id: 'A', pages: [{ ref: 'overview', title: 'x', content: 'old' }] });
      h.world.addAsset({ asset_id: `cg-${status}`, team_id: 'A', owner_user_id: 'mia', asset_type: 'code_graph', status });
      h.ks.addCodeGraph(`cg-${status}`, { team_id: 'A', owner_user_id: 'mia', text: { status: `${status} because of x` } });
    }
  });

  it('refuses a deprecated or failed wiki and code graph for a member and an admin, and hides them from the list', async () => {
    for (const status of ['deprecated', 'failed']) {
      for (const user of ['rev', 'adm']) {
        expectRefused(await readWiki(user, `wiki-${status}`), `wiki-${status}`);
        expectRefused(await searchCode(user, `cg-${status}`), `cg-${status}`);
      }
    }
    expect(await listIds('adm')).toEqual(['cg-a-team', 'wiki-a-restricted', 'wiki-a-team']);
  });

  it('lets the owner of a failed or deprecated code graph read its status only', async () => {
    for (const status of ['deprecated', 'failed']) {
      const res = await callTool(h.app, keyOf('mia'), 'code_status', { code_graph_id: `cg-${status}` });
      expect(res.text).toBe(`team: Alpha (A)\n${status} because of x`);
      expectRefused(await searchCode('mia', `cg-${status}`), `cg-${status}`);
    }
  });

  it('refuses the status to every other member, an admin included, and to the owner of a wiki', async () => {
    for (const user of ['rev', 'adm', 'ann']) {
      const res = await callTool(h.app, keyOf(user), 'code_status', { code_graph_id: 'cg-failed' });
      expectRefused(res, 'cg-failed');
    }
    expectRefused(await readWiki('ann', 'wiki-failed'), 'wiki-failed');
  });

  it('keeps the status of a code graph that is still building for its owner only', async () => {
    h.ks.addCodeGraph('cg-building', { team_id: 'A', owner_user_id: 'mia', status: 'processing', text: { status: 'building' } });
    expect((await callTool(h.app, keyOf('mia'), 'code_status', { code_graph_id: 'cg-building' })).isError).toBe(false);
    expectRefused(await callTool(h.app, keyOf('adm'), 'code_status', { code_graph_id: 'cg-building' }), 'cg-building');
  });
});

describe('listing', () => {
  it('drops a row that Core returns for another team', async () => {
    h.world.addAsset({ asset_id: 'wiki-stray', team_id: 'B', owner_user_id: 'bob' });
    h.ks.addWiki('wiki-stray', { team_id: 'B' });
    const original = h.fixture.deps.metaKernel.invoke;
    h.fixture.deps.metaKernel = {
      invoke: async (action: string, body: Record<string, unknown>, ctx: never) => {
        const env = await original(action, body, ctx);
        const data = env.data as { items?: unknown[] } | null;
        if (action === 'asset/list-accessible' && body.team_id === 'A' && data?.items) {
          const stray = { asset_id: 'wiki-stray', team_id: 'B', asset_type: 'llm_wiki', name: 'x', owner_user_id: 'bob', visibility: 'team', status: 'active' };
          return { ...env, data: { ...data, items: [...data.items, stray] } };
        }
        return env;
      },
    } as typeof h.fixture.deps.metaKernel;
    expect(await listIds('mia', { type: 'wiki' })).toEqual(['wiki-a-team']);
  });
});

describe('limits', () => {
  it('clamps wiki_search limit and code_files maxDepth, and leaves smaller values alone', async () => {
    await callTool(h.app, keyOf('mia'), 'wiki_search', { wiki_id: 'wiki-a-team', query: 'team', limit: 100000 });
    await callTool(h.app, keyOf('mia'), 'wiki_search', { wiki_id: 'wiki-a-team', query: 'team', limit: 7 });
    const limits = h.ks.calls.filter((c) => c.method === 'wikiSearch').map((c) => c.args[2]);
    expect(limits).toEqual([100, 7]);
    await callTool(h.app, keyOf('mia'), 'code_files', { code_graph_id: 'cg-a-team', maxDepth: 5000 });
    await callTool(h.app, keyOf('mia'), 'code_files', { code_graph_id: 'cg-a-team', maxDepth: 3 });
    const depths = h.ks.calls.filter((c) => c.method === 'codeGraphQuery').map((c) => (c.args[2] as { maxDepth: number }).maxDepth);
    expect(depths).toEqual([20, 3]);
  });
});

describe('Core outage during the read check', () => {
  for (const action of ['asset/get', 'acl/check', 'team-member/get']) {
    it(`answers "could not answer" when ${action} fails, not "not readable"`, async () => {
      h.world.failWith(action, 503);
      const res = await readWiki('mia', 'wiki-a-team');
      expect(res.isError).toBe(true);
      expect(res.text).toBe('Agent-Memory could not answer this call.');
    });
  }
});
