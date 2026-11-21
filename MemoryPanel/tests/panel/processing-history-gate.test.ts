import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpHarness, mcpHeaders, type McpHarness } from '../mcp/support/meta-fixture.js';

let h: McpHarness;
beforeEach(async () => {
  h = await createMcpHarness();
});
afterEach(() => h.cleanup());

async function config(key: string, teamId: string) {
  const res = await h.app.request('http://panel.test/api/v1/processing-history/config', {
    method: 'POST',
    headers: mcpHeaders(key),
    body: JSON.stringify({ team_id: teamId }),
  });
  return { status: res.status, body: (await res.json()) as { code: number; message: string } };
}

describe('processing history team admin gate', () => {
  it('lets a team admin in', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    world.addTeam('A', 'Alpha', 'ann');
    world.addUser('bob');
    world.addMember('A', 'bob', 'admin');
    expect((await config(key, 'A')).status).toBe(200);
    expect((await config(world.keyOf('bob'), 'A')).status).toBe(200);
  });

  it('lets a system admin in with no membership and reads no role', async () => {
    const { world } = h;
    const key = world.addUser('root', 'system_admin');
    world.addUser('bob');
    world.addTeam('A', 'Alpha', 'bob');
    world.clearCalls();
    expect((await config(key, 'A')).status).toBe(200);
    expect(world.callsTo('team-member/get')).toHaveLength(0);
    expect(world.callsTo('team/get')).toHaveLength(0);
  });

  it('refuses a member and a reviewer with 403 NOT_TEAM_ADMIN', async () => {
    const { world } = h;
    world.addUser('ann');
    world.addTeam('A', 'Alpha', 'ann');
    const member = world.addUser('mia');
    world.addMember('A', 'mia', 'member');
    const reviewer = world.addUser('rev');
    world.addMember('A', 'rev', 'reviewer');
    for (const key of [member, reviewer]) {
      const res = await config(key, 'A');
      expect(res.status).toBe(403);
      expect(res.body.message).toBe('NOT_TEAM_ADMIN');
    }
  });

  it('refuses a user outside the team with 403 NOT_TEAM_ADMIN', async () => {
    const { world } = h;
    world.addUser('ann');
    world.addTeam('A', 'Alpha', 'ann');
    const key = world.addUser('eve');
    const res = await config(key, 'A');
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('NOT_TEAM_ADMIN');
  });

  it('treats the team owner as admin when the owner row is not an active admin', async () => {
    const { world } = h;
    const key = world.addUser('owner');
    world.addTeam('A', 'Alpha', 'owner');
    world.setRole('A', 'owner', 'member');
    expect((await config(key, 'A')).status).toBe(200);
  });

  it('treats the owner as admin when the owner row is gone, if Core still answers', async () => {
    const { world } = h;
    const key = world.addUser('owner');
    world.addUser('other');
    world.addTeam('A', 'Alpha', 'owner');
    world.addMember('A', 'other', 'admin');
    world.removeMember('A', 'owner');
    // Core refuses team-member/get for a caller that is not an active member; team/get still names the owner.
    const res = await config(key, 'A');
    expect(res.status).toBe(200);
  });

  it('reads any Core failure of the member lookup as no admin', async () => {
    const { world } = h;
    world.addUser('ann');
    world.addTeam('A', 'Alpha', 'ann');
    const key = world.addUser('mia');
    world.addMember('A', 'mia', 'member');
    world.failWith('team-member/get', 500);
    expect((await config(key, 'A')).status).toBe(403);
  });

  it('answers 401 for an invalid key and 400 for a missing team id', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    expect((await config('key-nobody', 'A')).status).toBe(401);
    expect((await config(key, '')).status).toBe(400);
  });
});
