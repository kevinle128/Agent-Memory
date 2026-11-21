import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOOL_REGISTRY } from '../../src/panel/mcp/registry.js';
import { callTool, createMcpHarness, type McpHarness } from './support/meta-fixture.js';

const SECRET_TEAM_ID = 'team-secret-77';
const SECRET_TEAM_NAME = 'Hidden Skunkworks Team';
const SECRET_ASSET_ID = 'wiki-secret-42';
const SECRET_CODE_GRAPH_ID = 'cg-secret-43';
const SECRET_OWNER = 'secret-owner';
const SECRET_OWNER_NAME = 'name-secret-owner';

let h: McpHarness;
beforeEach(async () => {
  h = await createMcpHarness();
  h.world.addUser(SECRET_OWNER);
  h.world.addTeam(SECRET_TEAM_ID, SECRET_TEAM_NAME, SECRET_OWNER);
  // Real assets that are shared with the whole secret team, so only the team boundary can refuse a caller.
  h.world.addAsset({ asset_id: SECRET_ASSET_ID, team_id: SECRET_TEAM_ID, owner_user_id: SECRET_OWNER });
  h.world.addAsset({
    asset_id: SECRET_CODE_GRAPH_ID,
    team_id: SECRET_TEAM_ID,
    owner_user_id: SECRET_OWNER,
    asset_type: 'code_graph',
  });
  h.ks.addWiki(SECRET_ASSET_ID, { team_id: SECRET_TEAM_ID, pages: [{ ref: 'x', title: 'x', content: 'x' }] });
  h.ks.addCodeGraph(SECRET_CODE_GRAPH_ID, { team_id: SECRET_TEAM_ID });
});
afterEach(() => h.cleanup());

/** Supplies every id-like property, so a tool that needs an asset id gets the secret one of its type. */
function argsFor(tool: (typeof TOOL_REGISTRY)[number], extra: Record<string, unknown>) {
  const args: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
    if (name === 'team_id') continue;
    if (name === 'code_graph_id') args[name] = SECRET_CODE_GRAPH_ID;
    else if (name.endsWith('_id')) args[name] = SECRET_ASSET_ID;
    else if (tool.inputSchema.required.includes(name)) {
      args[name] = (schema as { type?: string }).type === 'integer' ? 1 : 'x';
    }
  }
  return { ...args, ...extra };
}

/** The message that echoes an id the caller supplied is allowed. Remove it, then look for leaks. */
function withoutAllowedEchoes(text: string): string {
  return text
    .replaceAll(`No readable team with id ${SECRET_TEAM_ID}.`, '')
    .replaceAll(`No readable wiki or code graph with id ${SECRET_ASSET_ID}.`, '')
    .replaceAll(`No readable wiki or code graph with id ${SECRET_CODE_GRAPH_ID}.`, '');
}

function expectNoLeak(text: string) {
  const stripped = withoutAllowedEchoes(text);
  for (const secret of [
    SECRET_TEAM_ID,
    SECRET_TEAM_NAME,
    SECRET_ASSET_ID,
    SECRET_CODE_GRAPH_ID,
    SECRET_OWNER,
    SECRET_OWNER_NAME,
  ]) {
    expect(stripped).not.toContain(secret);
  }
}

describe('every registered tool denies a caller outside the team', () => {
  it('registers whoami, help and the 13 knowledge tools', () => {
    expect(TOOL_REGISTRY.map((t) => t.name)).toEqual(expect.arrayContaining(['whoami', 'help']));
    expect(TOOL_REGISTRY.filter((t) => t.group === 'knowledge')).toHaveLength(13);
    expect(TOOL_REGISTRY).toHaveLength(15);
  });

  const callers: Array<{ label: string; setup: (w: McpHarness['world']) => string }> = [
    { label: 'a user with no team', setup: (w) => w.addUser('lone') },
    {
      label: 'a member of another team',
      setup: (w) => {
        const key = w.addUser('mia');
        w.addUser('other-owner');
        w.addTeam('team-other', 'Other Team', 'other-owner');
        w.addMember('team-other', 'mia', 'member');
        return key;
      },
    },
    {
      label: 'a system admin outside the team',
      setup: (w) => w.addUser('root', 'system_admin'),
    },
  ];

  for (const caller of callers) {
    for (const withTeamId of [false, true]) {
      it(`${caller.label}, ${withTeamId ? 'with' : 'without'} team_id of the secret team`, async () => {
        const key = caller.setup(h.world);
        for (const tool of TOOL_REGISTRY) {
          h.ks.clearCalls();
          const extra = withTeamId ? { team_id: SECRET_TEAM_ID } : {};
          const res = await callTool(h.app, key, tool.name, argsFor(tool, extra));
          expect(res.status, tool.name).toBe(200);
          expectNoLeak(res.text);
          // The fake knowledge service answers any id, so a data call that reaches it means the gate let the caller in.
          // Only `code_status` may probe `codeGraphGet`: it lets the owner of a graph that has no asset row read the status.
          const allowed = tool.name === 'code_status' ? ['codeGraphGet'] : [];
          expect(h.ks.calls.filter((c) => !allowed.includes(c.method)), tool.name).toEqual([]);
          if (withTeamId && res.isError) {
            // The only error that names the team is the fixed not-readable message.
            expect([
              `No readable team with id ${SECRET_TEAM_ID}.`,
              `No readable wiki or code graph with id ${SECRET_ASSET_ID}.`,
              `No readable wiki or code graph with id ${SECRET_CODE_GRAPH_ID}.`,
            ]).toContain(res.text);
          }
        }
      });
    }
  }

  it('whoami gives the exact not-readable message for the secret team', async () => {
    const key = h.world.addUser('lone');
    const res = await callTool(h.app, key, 'whoami', { team_id: SECRET_TEAM_ID });
    expect(res.isError).toBe(true);
    expect(res.text).toBe(`No readable team with id ${SECRET_TEAM_ID}.`);
  });
});
