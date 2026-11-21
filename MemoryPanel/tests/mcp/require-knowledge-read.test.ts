/**
 * Pins the behavior of the Panel read gate for wikis and code graphs: status codes, error codes,
 * the data returned on success, and the order of the Core calls. The 16 route callers rely on all of it.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkKnowledgeRead, requireKnowledgeRead } from '../../src/panel/http/routes/knowledge/common.js';
import { createMcpHarness, type McpHarness } from './support/meta-fixture.js';

let h: McpHarness;
beforeEach(async () => {
  h = await createMcpHarness();
  const { world } = h;
  world.addUser('ann');
  world.addTeam('A', 'Alpha', 'ann');
  world.addUser('mia');
  world.addMember('A', 'mia', 'member');
});
afterEach(() => h.cleanup());

type GateOptions = Parameters<typeof requireKnowledgeRead>[4];

async function gate(userKey: string | null, knowledgeId: string, opts?: GateOptions) {
  const app = new Hono();
  app.post('/gate', async (c) => {
    const ctx = {
      instanceId: 'default',
      gatewayEndpoint: 'http://127.0.0.1:1',
      gatewayApiKey: 'test-gateway-key-not-real',
      userKey: userKey ?? undefined,
      reqId: 'req-1',
    };
    const result = await requireKnowledgeRead(h.fixture.deps, c, ctx, knowledgeId, opts);
    return 'error' in result ? result.error : c.json({ ok: true, ...result });
  });
  h.world.clearCalls();
  const res = await app.request('/gate', { method: 'POST' });
  const body = (await res.json()) as Record<string, any>;
  return { status: res.status, body, actions: h.world.calls.map((c) => c.action) };
}

describe('requireKnowledgeRead', () => {
  it('lets a member read a team-visible wiki and returns the user id and the asset', async () => {
    h.world.addAsset({ asset_id: 'wiki-1', team_id: 'A', owner_user_id: 'ann' });
    const res = await gate(h.world.keyOf('mia'), 'wiki-1');
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('mia');
    expect(res.body.asset).toMatchObject({ asset_id: 'wiki-1', team_id: 'A', visibility: 'team' });
    expect(res.actions).toEqual(['auth/verify', 'asset/get', 'acl/check', 'team-member/get']);
  });

  it('answers 401 INVALID_USER_KEY for a revoked key, a missing key and an unknown key', async () => {
    h.world.addAsset({ asset_id: 'wiki-1', team_id: 'A', owner_user_id: 'ann' });
    h.world.setKeyStatus(h.world.keyOf('mia'), 'revoked');
    for (const key of [h.world.keyOf('mia'), null, 'key-nobody']) {
      const res = await gate(key, 'wiki-1');
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('INVALID_USER_KEY');
    }
    expect((await gate(null, 'wiki-1')).actions).toEqual([]);
  });

  it('answers 404 KNOWLEDGE_NOT_FOUND for a missing asset, and stops after asset/get', async () => {
    const res = await gate(h.world.keyOf('mia'), 'wiki-none');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('KNOWLEDGE_NOT_FOUND');
    expect(res.actions).toEqual(['auth/verify', 'asset/get']);
  });

  it('answers 404 for a restricted wiki that the member cannot see (asset/get hides it)', async () => {
    h.world.addAsset({ asset_id: 'wiki-r', team_id: 'A', owner_user_id: 'ann', visibility: 'restricted' });
    const res = await gate(h.world.keyOf('mia'), 'wiki-r');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('KNOWLEDGE_NOT_FOUND');
  });

  it('answers 403 FORBIDDEN when the ACL check denies an asset that asset/get shows', async () => {
    // A system admin outside the team sees the asset in asset/get but fails acl/check.
    h.world.addAsset({ asset_id: 'wiki-1', team_id: 'A', owner_user_id: 'ann' });
    const root = h.world.addUser('root', 'system_admin');
    const res = await gate(root, 'wiki-1');
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('FORBIDDEN');
    expect(res.actions).toEqual(['auth/verify', 'asset/get', 'acl/check']);
  });

  it('answers 403 FORBIDDEN when a member asks for write on a team wiki', async () => {
    h.world.addAsset({ asset_id: 'wiki-1', team_id: 'A', owner_user_id: 'ann' });
    const res = await gate(h.world.keyOf('mia'), 'wiki-1', { action: 'write' });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('FORBIDDEN');
  });

  it('lets an admin reach a restricted wiki', async () => {
    h.world.addUser('adm');
    h.world.addMember('A', 'adm', 'admin');
    h.world.addAsset({ asset_id: 'wiki-r', team_id: 'A', owner_user_id: 'mia', visibility: 'restricted' });
    const res = await gate(h.world.keyOf('adm'), 'wiki-r');
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('adm');
  });

  it('answers 403 NOT_TEAM_MEMBER for the owner of an asset who left the team', async () => {
    h.world.addAsset({ asset_id: 'wiki-m', team_id: 'A', owner_user_id: 'mia' });
    h.world.removeMember('A', 'mia');
    const res = await gate(h.world.keyOf('mia'), 'wiki-m');
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('NOT_TEAM_MEMBER');
    expect(res.actions).toEqual(['auth/verify', 'asset/get', 'acl/check', 'team-member/get']);
  });

  describe('in-flight code graph owner', () => {
    const inFlight: GateOptions = { allowInFlightCodeOwner: true };

    it('lets the owner member read a graph that has no meta asset yet, with no asset in the result', async () => {
      h.ks.addCodeGraph('cg-new', { team_id: 'A', owner_user_id: 'mia', status: 'processing' });
      const res = await gate(h.world.keyOf('mia'), 'cg-new', inFlight);
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe('mia');
      expect(res.body.asset).toBeUndefined();
      expect(res.actions).toEqual(['auth/verify', 'asset/get', 'team-member/get']);
    });

    it('lets the owner member pass with the write action, as the code graph routes use it', async () => {
      h.ks.addCodeGraph('cg-new', { team_id: 'A', owner_user_id: 'mia', status: 'processing' });
      const res = await gate(h.world.keyOf('mia'), 'cg-new', { ...inFlight, action: 'write' });
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe('mia');
      h.ks.addCodeGraph('cg-other', { team_id: 'A', owner_user_id: 'ann' });
      expect((await gate(h.world.keyOf('mia'), 'cg-other', { ...inFlight, action: 'write' })).status).toBe(404);
      h.world.removeMember('A', 'mia');
      const left = await gate(h.world.keyOf('mia'), 'cg-new', { ...inFlight, action: 'write' });
      expect(left.status).toBe(403);
      expect(left.body.message).toBe('NOT_TEAM_MEMBER');
    });

    it('answers 404 without the option', async () => {
      h.ks.addCodeGraph('cg-new', { team_id: 'A', owner_user_id: 'mia' });
      const res = await gate(h.world.keyOf('mia'), 'cg-new');
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('KNOWLEDGE_NOT_FOUND');
    });

    it('answers 404 for another user, and for an action other than read or write', async () => {
      h.ks.addCodeGraph('cg-new', { team_id: 'A', owner_user_id: 'ann' });
      expect((await gate(h.world.keyOf('mia'), 'cg-new', inFlight)).status).toBe(404);
      h.ks.addCodeGraph('cg-mine', { team_id: 'A', owner_user_id: 'mia' });
      expect((await gate(h.world.keyOf('mia'), 'cg-mine', { ...inFlight, action: 'use' })).status).toBe(404);
    });

    it('answers 403 NOT_TEAM_MEMBER for an owner who is not a member of the team', async () => {
      h.ks.addCodeGraph('cg-new', { team_id: 'A', owner_user_id: 'mia' });
      h.world.removeMember('A', 'mia');
      const res = await gate(h.world.keyOf('mia'), 'cg-new', inFlight);
      expect(res.status).toBe(403);
      expect(res.body.message).toBe('NOT_TEAM_MEMBER');
    });

    it('answers 404 when the knowledge service fails or does not know the graph', async () => {
      expect((await gate(h.world.keyOf('mia'), 'cg-none', inFlight)).status).toBe(404);
      h.ks.addCodeGraph('cg-new', { team_id: 'A', owner_user_id: 'mia' });
      h.ks.failWith('codeGraphGet');
      expect((await gate(h.world.keyOf('mia'), 'cg-new', inFlight)).status).toBe(404);
    });
  });
});

describe('checkKnowledgeRead', () => {
  const ctxOf = (userKey: string) => ({
    instanceId: 'default',
    gatewayEndpoint: 'http://127.0.0.1:1',
    gatewayApiKey: 'test-gateway-key-not-real',
    userKey,
    reqId: 'req-1',
  });

  it('names each denial and gives the team of the asset', async () => {
    h.world.addAsset({ asset_id: 'wiki-1', team_id: 'A', owner_user_id: 'ann' });
    const ctx = ctxOf(h.world.keyOf('mia'));
    expect(await checkKnowledgeRead(h.fixture.deps, ctx, 'wiki-1')).toMatchObject({ ok: true, userId: 'mia', teamId: 'A' });
    expect(await checkKnowledgeRead(h.fixture.deps, ctx, 'wiki-none')).toEqual({ ok: false, reason: 'not_found' });
    expect(await checkKnowledgeRead(h.fixture.deps, ctx, 'wiki-1', { action: 'write' })).toEqual({ ok: false, reason: 'forbidden' });
    expect(await checkKnowledgeRead(h.fixture.deps, ctxOf('key-nobody'), 'wiki-1')).toEqual({ ok: false, reason: 'invalid_key' });
    h.world.removeMember('A', 'mia');
    h.world.addAsset({ asset_id: 'wiki-m', team_id: 'A', owner_user_id: 'mia' });
    expect(await checkKnowledgeRead(h.fixture.deps, ctx, 'wiki-m')).toEqual({ ok: false, reason: 'not_member' });
  });

  it('takes the team of an in-flight code graph from the knowledge service', async () => {
    h.ks.addCodeGraph('cg-new', { team_id: 'A', owner_user_id: 'mia', status: 'processing' });
    const res = await checkKnowledgeRead(h.fixture.deps, ctxOf(h.world.keyOf('mia')), 'cg-new', {
      allowInFlightCodeOwner: true,
    });
    expect(res).toEqual({ ok: true, userId: 'mia', teamId: 'A' });
  });

  it('skips auth/verify when the caller is already known', async () => {
    h.world.addAsset({ asset_id: 'wiki-1', team_id: 'A', owner_user_id: 'ann' });
    h.world.clearCalls();
    const res = await checkKnowledgeRead(h.fixture.deps, ctxOf(h.world.keyOf('mia')), 'wiki-1', { userId: 'mia' });
    expect(res.ok).toBe(true);
    expect(h.world.callsTo('auth/verify')).toHaveLength(0);
  });
});
