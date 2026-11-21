import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHarness, MCP_URL, type McpHarness } from './support/meta-fixture.js';

let h: McpHarness;
beforeEach(async () => {
  h = await createMcpHarness();
});
afterEach(() => h.cleanup());

/** An SDK client that talks to the in-process app, so no port is opened. */
async function connect(userKey: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { 'x-tdai-service-id': 'default', 'x-tdai-user-key': userKey } },
    fetch: (input, init) => Promise.resolve(h.app.request(String(input), init)),
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

describe('agent-memory MCP over HTTP', () => {
  it('completes initialize, tools/list, tools/call, resources/list and resources/read', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    world.addTeam('A', 'Alpha', 'ann');
    const client = await connect(key);
    try {
      expect(client.getServerVersion()?.name).toBe('agent-memory');
      expect(client.getInstructions()).toContain('whoami');

      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual([
        'code_callees', 'code_callers', 'code_explore', 'code_files', 'code_impact', 'code_node',
        'code_search', 'code_status', 'help', 'knowledge_list', 'whoami', 'wiki_graph', 'wiki_list',
        'wiki_read', 'wiki_search',
      ]);
      for (const tool of tools.tools) {
        expect(tool.inputSchema.properties).toHaveProperty('team_id');
      }

      const result = await client.callTool({ name: 'whoami', arguments: {} });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(text).teams).toEqual([
        { team_id: 'A', team_name: 'Alpha', role: 'admin', scope: 'team' },
      ]);

      const resources = await client.listResources();
      expect(resources.resources.map((r) => r.uri)).toContain('agent-memory://help/access');
      const read = await client.readResource({ uri: 'agent-memory://help/access' });
      expect(read.contents[0]).toMatchObject({ mimeType: 'text/markdown' });
      expect(String(read.contents[0]!.text)).toContain('What you can read');
    } finally {
      await client.close();
    }
  });

  it('keeps two users apart when their calls run in parallel', async () => {
    const { world } = h;
    const k1 = world.addUser('u1');
    const k2 = world.addUser('u2');
    world.addTeam('A', 'Alpha', 'u1');
    world.addTeam('B', 'Beta', 'u2');
    const [c1, c2] = await Promise.all([connect(k1), connect(k2)]);
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          (i % 2 === 0 ? c1 : c2).callTool({ name: 'whoami', arguments: {} }),
        ),
      );
      results.forEach((r, i) => {
        const teams = JSON.parse((r.content as Array<{ text: string }>)[0]!.text).teams;
        expect(teams.map((t: { team_id: string }) => t.team_id)).toEqual([i % 2 === 0 ? 'A' : 'B']);
      });
    } finally {
      await Promise.all([c1.close(), c2.close()]);
    }
  });

  it('answers an unknown resource with a protocol error', async () => {
    const key = h.world.addUser('ann');
    const client = await connect(key);
    try {
      await expect(client.readResource({ uri: 'agent-memory://help/nope' })).rejects.toThrow(/Unknown resource/);
    } finally {
      await client.close();
    }
  });

  it('logs one line per tool call without keys or arguments', async () => {
    const { world, fixture } = h;
    const key = world.addUser('ann');
    world.addTeam('A', 'Alpha', 'ann');
    const client = await connect(key);
    try {
      await client.callTool({ name: 'whoami', arguments: { team_id: 'A' } });
    } finally {
      await client.close();
    }
    const lines = fixture.logs.filter((l) => l.msg === 'mcp tool call');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.fields).toMatchObject({
      component: 'mcp',
      tool: 'whoami',
      user_id: 'ann',
      team_ids: ['A'],
      outcome: 'ok',
    });
    expect(JSON.stringify(fixture.logs)).not.toContain(key);
  });
});
