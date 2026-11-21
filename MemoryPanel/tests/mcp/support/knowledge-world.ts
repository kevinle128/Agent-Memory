import type { McpHarness } from './meta-fixture.js';

/**
 * Teams A (Alpha) and B (Beta), each with a team wiki, a team code graph and a restricted wiki.
 * A also has a private wiki of its owner `ann`. Users:
 * mia member of A; rev reviewer of A; adm admin of A; ann owner and admin of A; bob owner and admin of B;
 * mixed member of A and admin of B; dual admin of A and B; root system admin, admin of A, not in B;
 * lone has no team.
 */
export function seedKnowledgeWorld(h: McpHarness): void {
  const { world, ks } = h;
  for (const u of ['ann', 'bob', 'mia', 'rev', 'adm', 'mixed', 'dual', 'lone']) world.addUser(u);
  world.addUser('root', 'system_admin');
  world.addTeam('A', 'Alpha', 'ann');
  world.addTeam('B', 'Beta', 'bob');
  world.addMember('A', 'mia', 'member');
  world.addMember('A', 'rev', 'reviewer');
  world.addMember('A', 'adm', 'admin');
  world.addMember('A', 'mixed', 'member');
  world.addMember('B', 'mixed', 'admin');
  world.addMember('A', 'dual', 'admin');
  world.addMember('B', 'dual', 'admin');
  world.addMember('A', 'root', 'admin');

  const sets: Array<[string, string, string]> = [['A', 'ann', 'a'], ['B', 'bob', 'b']];
  for (const [team, owner, tag] of sets) {
    world.addAsset({ asset_id: `wiki-${tag}-team`, team_id: team, owner_user_id: owner });
    world.addAsset({ asset_id: `cg-${tag}-team`, team_id: team, owner_user_id: owner, asset_type: 'code_graph' });
    world.addAsset({ asset_id: `wiki-${tag}-restricted`, team_id: team, owner_user_id: owner, visibility: 'restricted' });
    ks.addWiki(`wiki-${tag}-team`, {
      team_id: team,
      pages: [{ ref: 'overview', title: 'Overview', content: `Overview of the ${tag} team wiki` }],
    });
    ks.addWiki(`wiki-${tag}-restricted`, {
      team_id: team,
      pages: [{ ref: 'plan', title: 'Plan', content: `Secret plan of ${tag}` }],
    });
    ks.addCodeGraph(`cg-${tag}-team`, {
      team_id: team,
      text: {
        search: `symbol hit in ${tag} graph`,
        callers: `callers of sym in ${tag} graph: handleRequest, runJob`,
        impact: `impact of sym in ${tag} graph: 12 files`,
      },
    });
  }
  world.addAsset({ asset_id: 'wiki-a-private', team_id: 'A', owner_user_id: 'ann', visibility: 'private' });
  ks.addWiki('wiki-a-private', { team_id: 'A', pages: [{ ref: 'diary', title: 'Diary', content: 'Private notes' }] });
}
