import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequestAccess, resolveCaller, resolveScope } from '../../src/panel/mcp/access.js';
import { resolveTeamRole } from '../../src/panel/authz/team-role.js';
import {
  MCP_URL,
  callTool,
  createMcpHarness,
  mcpHeaders,
  rpc,
  type McpHarness,
} from './support/meta-fixture.js';

const NO_TEAM = 'You are not an active member of any team.';

let h: McpHarness;
beforeEach(async () => {
  h = await createMcpHarness();
});
afterEach(() => h.cleanup());

const ctxOf = (key: string) => ({
  instanceId: 'default',
  gatewayEndpoint: 'http://127.0.0.1:1',
  gatewayApiKey: 'test-gateway-key-not-real',
  userKey: key,
});

async function whoami(key: string, args: Record<string, unknown> = {}) {
  return callTool(h.app, key, 'whoami', args);
}

describe('whoami scope per persona', () => {
  it('member of one team: that team with scope own', async () => {
    const { world } = h;
    const owner = world.addUser('owner');
    const key = world.addUser('mia');
    world.addTeam('A', 'Alpha', 'owner');
    world.addMember('A', 'mia', 'member');
    const res = await whoami(key);
    expect(res.json().teams).toEqual([{ team_id: 'A', team_name: 'Alpha', role: 'member', scope: 'own' }]);
    expect(res.json().message).toBeUndefined();
    expect(owner).toBeTruthy();
  });

  it('reviewer: scope own', async () => {
    const { world } = h;
    world.addUser('owner');
    const key = world.addUser('rev');
    world.addTeam('A', 'Alpha', 'owner');
    world.addMember('A', 'rev', 'reviewer');
    const res = await whoami(key);
    expect(res.json().teams).toEqual([{ team_id: 'A', team_name: 'Alpha', role: 'reviewer', scope: 'own' }]);
  });

  it('admin of one team: scope team; team_id of another team is not readable', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    world.addUser('bob');
    world.addTeam('A', 'Alpha', 'ann');
    world.addTeam('B', 'Beta', 'bob');
    const ok = await whoami(key);
    expect(ok.json().teams).toEqual([{ team_id: 'A', team_name: 'Alpha', role: 'admin', scope: 'team' }]);
    const denied = await whoami(key, { team_id: 'B' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toBe('No readable team with id B.');
  });

  it('admin of two teams: both, labelled, scope team', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    world.addTeam('A', 'Alpha', 'ann');
    world.addTeam('B', 'Beta', 'ann');
    const res = await whoami(key);
    expect(res.json().teams).toEqual([
      { team_id: 'A', team_name: 'Alpha', role: 'admin', scope: 'team' },
      { team_id: 'B', team_name: 'Beta', role: 'admin', scope: 'team' },
    ]);
  });

  it('member of A and admin of B: A own, B team', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    world.addUser('bob');
    world.addTeam('A', 'Alpha', 'bob');
    world.addMember('A', 'ann', 'member');
    world.addTeam('B', 'Beta', 'ann');
    const res = await whoami(key);
    expect(res.json().teams).toEqual([
      { team_id: 'A', team_name: 'Alpha', role: 'member', scope: 'own' },
      { team_id: 'B', team_name: 'Beta', role: 'admin', scope: 'team' },
    ]);
  });

  it('system admin that created A and is not in B: A team; B gives the unknown-team error with no team/get', async () => {
    const { world } = h;
    const key = world.addUser('root', 'system_admin');
    world.addUser('bob');
    world.addTeam('A', 'Alpha', 'root');
    world.addTeam('B', 'Beta', 'bob');
    const res = await whoami(key);
    expect(res.json().user_type).toBe('system_admin');
    expect(res.json().teams).toEqual([{ team_id: 'A', team_name: 'Alpha', role: 'admin', scope: 'team' }]);
    world.clearCalls();
    const denied = await whoami(key, { team_id: 'B' });
    expect(denied.text).toBe('No readable team with id B.');
    expect(world.callsTo('team/get')).toHaveLength(0);
  });

  it('system admin with no membership: empty scope and message', async () => {
    const { world } = h;
    const key = world.addUser('root', 'system_admin');
    world.addUser('bob');
    world.addTeam('B', 'Beta', 'bob');
    const res = await whoami(key);
    expect(res.json().teams).toEqual([]);
    expect(res.json().message).toBe(NO_TEAM);
  });

  it('user with no team: empty scope and message; any team_id is not readable', async () => {
    const { world } = h;
    const key = world.addUser('lone');
    world.addUser('bob');
    world.addTeam('B', 'Beta', 'bob');
    const res = await whoami(key);
    expect(res.json().teams).toEqual([]);
    expect(res.json().message).toBe(NO_TEAM);
    const denied = await whoami(key, { team_id: 'B' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toBe('No readable team with id B.');
  });

  it('lists all 45 teams across Core pages', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    for (let i = 0; i < 45; i++) world.addTeam(`T${String(i).padStart(2, '0')}`, `Team ${i}`, 'ann');
    const res = await whoami(key);
    expect(res.json().teams).toHaveLength(45);
    expect(new Set(res.json().teams.map((t: { team_id: string }) => t.team_id)).size).toBe(45);
  });
});

describe('team_id handling', () => {
  it('reads team-member/get for that team only, with no team/list', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    world.addTeam('A', 'Alpha', 'ann');
    world.addTeam('B', 'Beta', 'ann');
    world.clearCalls();
    const res = await whoami(key, { team_id: 'B' });
    expect(res.json().teams.map((t: { team_id: string }) => t.team_id)).toEqual(['B']);
    expect(world.callsTo('team/list')).toHaveLength(0);
    const roleCalls = world.callsTo('team-member/get');
    expect(roleCalls).toHaveLength(1);
    expect(roleCalls[0]?.body.team_id).toBe('B');
  });

  it('a nonexistent team and a foreign team give byte-identical errors', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    world.addUser('bob');
    world.addTeam('A', 'Alpha', 'ann');
    world.addTeam('FOREIGN', 'Foreign', 'bob');
    const foreign = await whoami(key, { team_id: 'FOREIGN' });
    const missing = await whoami(key, { team_id: 'NOPE' });
    // Only the echoed id differs.
    expect(foreign.text).toBe('No readable team with id FOREIGN.');
    expect(missing.text.replace('NOPE', 'FOREIGN')).toBe(foreign.text);
    expect(missing.status).toBe(foreign.status);
    expect(missing.isError && foreign.isError).toBe(true);
  });

  it('a malformed team_id gets the same not-readable message and no Core call', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    world.addTeam('A', 'Alpha', 'ann');
    world.clearCalls();
    const res = await whoami(key, { team_id: 'a b;drop' });
    expect(res.isError).toBe(true);
    expect(res.text).toBe('No readable team with id a b;drop.');
    expect(world.callsTo('team-member/get')).toHaveLength(0);
    expect(world.callsTo('team/get')).toHaveLength(0);
  });

  it('never sends a user_id other than the caller to Core', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    world.addUser('bob');
    world.addTeam('A', 'Alpha', 'ann');
    await whoami(key, { team_id: 'A', user_id: 'bob' });
    await whoami(key, { user_id: 'bob' });
    for (const call of world.calls) {
      if ('user_id' in call.body) expect(call.body.user_id).toBe('ann');
    }
  });
});

describe('access changes between two calls', () => {
  it('removed member: first call sees the team, second does not', async () => {
    const { world } = h;
    world.addUser('owner');
    const key = world.addUser('mia');
    world.addTeam('A', 'Alpha', 'owner');
    world.addMember('A', 'mia', 'member');
    expect((await whoami(key)).json().teams).toHaveLength(1);
    world.removeMember('A', 'mia');
    const second = await whoami(key);
    expect(second.json().teams).toEqual([]);
    expect(second.json().message).toBe(NO_TEAM);
    expect((await whoami(key, { team_id: 'A' })).text).toBe('No readable team with id A.');
  });

  it('demoted admin: first call team, second call own', async () => {
    const { world } = h;
    world.addUser('owner');
    const key = world.addUser('ann');
    world.addTeam('A', 'Alpha', 'owner');
    world.addMember('A', 'ann', 'admin');
    expect((await whoami(key)).json().teams[0].scope).toBe('team');
    world.setRole('A', 'ann', 'member');
    expect((await whoami(key)).json().teams[0].scope).toBe('own');
  });

  it('revoked key: next request is HTTP 401', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    world.addTeam('A', 'Alpha', 'ann');
    expect((await whoami(key)).status).toBe(200);
    world.setKeyStatus(key, 'revoked');
    expect((await whoami(key)).status).toBe(401);
  });

  it('expired key: HTTP 401', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    world.setKeyStatus(key, 'expired');
    const res = await rpc(h.app, key, 'tools/list');
    expect(res.status).toBe(401);
  });

  it('unknown key: HTTP 401', async () => {
    const res = await rpc(h.app, 'key-nobody', 'tools/list');
    expect(res.status).toBe(401);
  });
});

describe('Core failures', () => {
  it('a team/list failure fails the call instead of returning a short scope', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    world.addTeam('A', 'Alpha', 'ann');
    world.failWith('team/list', 503);
    const res = await whoami(key);
    expect(res.isError).toBe(true);
    expect(res.text).toBe('Agent-Memory could not answer this call.');
  });

  it('a team-member/get 5xx is an error, not a denial', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    world.addTeam('A', 'Alpha', 'ann');
    world.failWith('team-member/get', 502);
    const res = await whoami(key, { team_id: 'A' });
    expect(res.text).toBe('Agent-Memory could not answer this call.');
  });

  it('an auth/verify 5xx is HTTP 503, not 401', async () => {
    const { world } = h;
    const key = world.addUser('ann');
    world.failWith('auth/verify', 502);
    expect((await rpc(h.app, key, 'tools/list')).status).toBe(503);
  });
});

describe('resolveScope and resolveCaller', () => {
  it('memoizes inside one request and calls Core again in the next', async () => {
    const { world, fixture } = h;
    const key = world.addUser('ann');
    world.addTeam('A', 'Alpha', 'ann');
    const ctx = ctxOf(key);
    const caller = (await resolveCaller(fixture.deps, ctx))!;
    expect(caller.userId).toBe('ann');
    const access = createRequestAccess(fixture.deps, ctx, caller);
    world.clearCalls();
    await access.scope();
    await access.scope();
    expect(world.callsTo('team/list')).toHaveLength(1);
    const next = createRequestAccess(fixture.deps, ctx, caller);
    await next.scope();
    expect(world.callsTo('team/list')).toHaveLength(2);
    expect(access.resolvedTeamIds()).toEqual(['A']);
  });

  it('resolveScope without a key returns no caller', async () => {
    const caller = await resolveCaller(h.fixture.deps, { ...ctxOf(''), userKey: undefined });
    expect(caller).toBeNull();
  });

  it('resolveScope with a team id of a member returns the role', async () => {
    const { world, fixture } = h;
    const key = world.addUser('ann');
    world.addUser('bob');
    world.addTeam('A', 'Alpha', 'bob');
    world.addMember('A', 'ann', 'reviewer');
    const ctx = ctxOf(key);
    const caller = (await resolveCaller(fixture.deps, ctx))!;
    expect(await resolveScope(fixture.deps, ctx, caller, 'A')).toEqual([
      { team_id: 'A', team_name: 'Alpha', role: 'reviewer', scope: 'own' },
    ]);
  });
});

describe('resolveTeamRole owner fallback', () => {
  it('is off by default: a removed owner has no role and team/get is not called', async () => {
    const { world, fixture } = h;
    const key = world.addUser('owner');
    world.addUser('other');
    world.addTeam('A', 'Alpha', 'owner');
    world.addMember('A', 'other', 'admin');
    world.removeMember('A', 'owner');
    const ctx = ctxOf(world.keyOf('other'));
    world.clearCalls();
    expect(await resolveTeamRole(fixture.deps, ctx, 'owner', 'A')).toBeNull();
    expect(world.callsTo('team/get')).toHaveLength(0);
    expect(key).toBeTruthy();
  });

  it('is on for the processing history gate: the owner counts as admin', async () => {
    const { world, fixture } = h;
    world.addUser('owner');
    world.addUser('other');
    world.addTeam('A', 'Alpha', 'owner');
    world.addMember('A', 'other', 'admin');
    world.removeMember('A', 'owner');
    const ctx = ctxOf(world.keyOf('other'));
    expect(await resolveTeamRole(fixture.deps, ctx, 'owner', 'A', { ownerFallback: true })).toBe('admin');
  });

  it('is on: an owner whose row has a lower role still counts as admin', async () => {
    const { world, fixture } = h;
    const key = world.addUser('owner');
    world.addTeam('A', 'Alpha', 'owner');
    world.setRole('A', 'owner', 'member');
    const ctx = ctxOf(key);
    expect(await resolveTeamRole(fixture.deps, ctx, 'owner', 'A')).toBe('member');
    expect(await resolveTeamRole(fixture.deps, ctx, 'owner', 'A', { ownerFallback: true })).toBe('admin');
  });

  it('is on: a non-owner member keeps the member role, and any Core error is no role', async () => {
    const { world, fixture } = h;
    world.addUser('owner');
    const key = world.addUser('mia');
    world.addTeam('A', 'Alpha', 'owner');
    world.addMember('A', 'mia', 'member');
    expect(await resolveTeamRole(fixture.deps, ctxOf(key), 'mia', 'A', { ownerFallback: true })).toBe('member');
    world.failWith('team-member/get', 500);
    expect(await resolveTeamRole(fixture.deps, ctxOf(key), 'mia', 'A', { ownerFallback: true })).toBeNull();
  });
});

describe('request headers feed the same checks', () => {
  it('uses the key of the request, not a shared one', async () => {
    const { world } = h;
    const k1 = world.addUser('u1');
    const k2 = world.addUser('u2');
    world.addTeam('A', 'Alpha', 'u1');
    world.addTeam('B', 'Beta', 'u2');
    const [r1, r2] = await Promise.all([whoami(k1), whoami(k2)]);
    expect(r1.json().teams.map((t: { team_id: string }) => t.team_id)).toEqual(['A']);
    expect(r2.json().teams.map((t: { team_id: string }) => t.team_id)).toEqual(['B']);
    expect(MCP_URL).toContain('/api/v1/mcp');
    expect(mcpHeaders(k1)['x-tdai-user-key']).toBe(k1);
  });
});
