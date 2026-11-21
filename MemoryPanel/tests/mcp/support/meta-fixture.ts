import { vi } from 'vitest';
import { Hono } from 'hono';
import { registerMcpRoutes, type McpRouteOptions } from '../../../src/panel/mcp/route.js';
import type { PanelDeps } from '../../../src/panel/panel-deps.js';
import { createPanelFixture, stubMetaKernel, type PanelFixture } from '../../extensions/support/panel-fixture.js';

/** Core page size when a call sends no `limit` (DEFAULT_PAGINATION in Core). */
const CORE_DEFAULT_LIMIT = 20;

type KeyStatus = 'active' | 'revoked' | 'expired';
type Role = 'admin' | 'member' | 'reviewer';
type Visibility = 'team' | 'private' | 'restricted';

export interface FakeAsset {
  asset_id: string;
  team_id: string;
  asset_type: 'llm_wiki' | 'code_graph';
  name: string;
  description: string | null;
  owner_user_id: string;
  visibility: Visibility;
  status: string;
}

export interface WorldCall {
  action: string;
  body: Record<string, unknown>;
  userKey?: string;
}

class Refusal {
  constructor(readonly code: number, readonly message: string) {}
}

/**
 * In-memory copy of the Core rules that the MCP access layer relies on:
 * - `auth/verify` answers `valid: false` for a revoked or expired key;
 * - `team/list` returns the teams of the active memberships, paged (default page of 20);
 * - `team-member/get` refuses a caller that is not an active member of the team (403);
 * - `team/get` has no caller check;
 * - a new team has its owner as an active admin member;
 * - `asset/get` shows an asset to a system admin and to its owner, and to anyone who passes `acl/check`;
 * - `acl/check` runs the Core permission order: owner, active member, visibility, role default, ACL row;
 * - `asset/list-accessible` is empty for a team without an active membership and checks each asset.
 * State can change between two calls.
 */
export function createMetaWorld() {
  const users = new Map<string, { username: string; user_type: string }>();
  const keys = new Map<string, { userId: string; status: KeyStatus }>();
  const teams = new Map<string, { name: string; owner: string }>();
  const members = new Map<string, { role: Role; status: 'active' | 'removed' }>();
  const assets = new Map<string, FakeAsset>();
  const acl = new Set<string>();
  const calls: WorldCall[] = [];
  let failAction: { action: string; code: number } | null = null;

  const memberKey = (team: string, user: string) => `${team}|${user}`;

  const world = {
    calls,
    addUser(userId: string, userType = 'user') {
      users.set(userId, { username: `name-${userId}`, user_type: userType });
      keys.set(`key-${userId}`, { userId, status: 'active' });
      return `key-${userId}`;
    },
    keyOf: (userId: string) => `key-${userId}`,
    setKeyStatus(key: string, status: KeyStatus) {
      const k = keys.get(key);
      if (k) k.status = status;
    },
    addTeam(teamId: string, name: string, owner: string) {
      teams.set(teamId, { name, owner });
      members.set(memberKey(teamId, owner), { role: 'admin', status: 'active' });
    },
    addMember(teamId: string, userId: string, role: Role) {
      members.set(memberKey(teamId, userId), { role, status: 'active' });
    },
    removeMember(teamId: string, userId: string) {
      const m = members.get(memberKey(teamId, userId));
      if (m) m.status = 'removed';
    },
    setRole(teamId: string, userId: string, role: Role) {
      const m = members.get(memberKey(teamId, userId));
      if (m) m.role = role;
    },
    addAsset(asset: Partial<FakeAsset> & Pick<FakeAsset, 'asset_id' | 'team_id' | 'owner_user_id'>) {
      assets.set(asset.asset_id, {
        asset_type: 'llm_wiki',
        name: `name-${asset.asset_id}`,
        description: null,
        visibility: 'team',
        status: 'active',
        ...asset,
      });
    },
    /** An explicit `read` ACL row for one user. */
    grantRead(assetId: string, userId: string) {
      acl.add(`${assetId}|${userId}`);
    },
    removeAsset(assetId: string) {
      assets.delete(assetId);
    },
    /** Makes every call of `action` answer with a Core failure code. */
    failWith(action: string, code: number) {
      failAction = { action, code };
    },
    callsTo: (action: string) => calls.filter((c) => c.action === action),
    clearCalls() {
      calls.length = 0;
    },
    handle(action: string, body: Record<string, unknown>, ctx: unknown): unknown {
      const userKey = (ctx as { userKey?: string } | undefined)?.userKey;
      calls.push({ action, body, userKey });
      if (failAction && failAction.action === action) {
        return { code: failAction.code, message: 'injected failure' };
      }
      try {
        return answer(action, body, userKey);
      } catch (err) {
        if (err instanceof Refusal) return { code: err.code, message: err.message };
        throw err;
      }
    },
  };

  function isActiveMember(teamId: string, userId: string): { role: Role } | null {
    const m = members.get(memberKey(teamId, userId));
    return m?.status === 'active' ? { role: m.role } : null;
  }

  /** Core `checkPermission` for the `read` action. Same order as `permission-checker.ts`. */
  function mayRead(userId: string, asset: FakeAsset | undefined): boolean {
    if (!asset || asset.status === 'archived') return false;
    if (asset.owner_user_id === userId) return true;
    const member = isActiveMember(asset.team_id, userId);
    if (!member) return false;
    if (asset.visibility === 'private') return false;
    if (asset.visibility === 'restricted' && member.role !== 'admin') return acl.has(`${asset.asset_id}|${userId}`);
    return true;
  }

  function callerOf(userKey: string | undefined): string {
    const k = userKey ? keys.get(userKey) : undefined;
    if (!k || k.status !== 'active') throw new Refusal(401, 'invalid_user_key');
    return k.userId;
  }

  function page<T>(items: T[], body: Record<string, unknown>) {
    const limit = typeof body.limit === 'number' ? body.limit : CORE_DEFAULT_LIMIT;
    const offset = typeof body.offset === 'number' ? body.offset : 0;
    return { data: { items: items.slice(offset, offset + limit), total: items.length, limit, offset } };
  }

  function answer(action: string, body: Record<string, unknown>, userKey: string | undefined): unknown {
    switch (action) {
      case 'auth/verify': {
        const k = keys.get(String(body.user_key));
        if (!k || k.status !== 'active') return { data: { valid: false, user: null } };
        const u = users.get(k.userId)!;
        return { data: { valid: true, user: { user_id: k.userId, username: u.username, user_type: u.user_type } } };
      }
      case 'team/list': {
        callerOf(userKey);
        const userId = String(body.user_id);
        const rows = [...teams.entries()]
          .filter(([id]) => members.get(memberKey(id, userId))?.status === 'active')
          .map(([id, t]) => ({ team_id: id, name: t.name, owner_user_id: t.owner }));
        return page(rows, body);
      }
      case 'team-member/get': {
        const caller = callerOf(userKey);
        const teamId = String(body.team_id);
        if (members.get(memberKey(teamId, caller))?.status !== 'active') {
          throw new Refusal(403, 'permission_denied');
        }
        const row = members.get(memberKey(teamId, String(body.user_id)));
        if (!row) throw new Refusal(404, 'member_not_found');
        return { data: { team_id: teamId, user_id: body.user_id, role: row.role, status: row.status } };
      }
      case 'team/get': {
        callerOf(userKey);
        const t = teams.get(String(body.team_id));
        if (!t) throw new Refusal(404, 'team_not_found');
        return { data: { team_id: body.team_id, name: t.name, owner_user_id: t.owner } };
      }
      case 'asset/get': {
        const caller = callerOf(userKey);
        const asset = assets.get(String(body.asset_id));
        const visible =
          asset &&
          (users.get(caller)?.user_type === 'system_admin' || asset.owner_user_id === caller || mayRead(caller, asset));
        if (!visible) throw new Refusal(404, 'asset_not_found');
        return { data: asset };
      }
      case 'acl/check': {
        callerOf(userKey);
        const asset = assets.get(String(body.asset_id));
        const allowed = body.action === 'read' && mayRead(String(body.user_id), asset);
        return { data: { allowed, reason: allowed ? 'allowed' : 'denied' } };
      }
      case 'asset/list-accessible': {
        callerOf(userKey);
        const userId = String(body.user_id);
        const teamId = typeof body.team_id === 'string' ? body.team_id : null;
        if (teamId && !isActiveMember(teamId, userId)) return page([], body);
        const rows = [...assets.values()]
          .filter((a) => (teamId ? a.team_id === teamId : !!isActiveMember(a.team_id, userId)))
          .filter((a) => !body.asset_type || a.asset_type === body.asset_type)
          .filter((a) => !body.visibility || a.visibility === body.visibility)
          .filter((a) => !['archived', 'deprecated', 'failed'].includes(a.status))
          .filter((a) => mayRead(userId, a));
        return page(rows, body);
      }
      default:
        throw new Refusal(404, `unknown action ${action}`);
    }
  }

  return world;
}

export type MetaWorld = ReturnType<typeof createMetaWorld>;

export interface FakeWikiPage {
  ref: string;
  title: string;
  content: string;
}

interface FakeWiki {
  team_id: string;
  summary: string | null;
  status: string;
  pages: FakeWikiPage[];
}

interface FakeCodeGraph {
  team_id: string;
  repo_name: string;
  branch: string;
  status: string;
  owner_user_id: string | null;
  /** Text that the query of one code tool answers with. */
  text: Record<string, string>;
}

export interface KsCall {
  method: string;
  args: unknown[];
}

/**
 * Fake knowledge service. It answers by id and checks nothing: the access rules are the
 * job of the Panel, so a test sees a call here only when the gate let it through.
 */
export function createFakeKnowledge() {
  const wikis = new Map<string, FakeWiki>();
  const codeGraphs = new Map<string, FakeCodeGraph>();
  const calls: KsCall[] = [];
  let failMethod: string | null = null;

  const record = (method: string, args: unknown[]) => {
    calls.push({ method, args });
    if (failMethod === method) throw new Error(`injected knowledge failure in ${method}`);
  };
  const wikiOf = (id: string) => {
    const w = wikis.get(id);
    if (!w) throw new Error(`wiki not found: ${id}`);
    return w;
  };
  const graphOf = (id: string) => {
    const g = codeGraphs.get(id);
    if (!g) throw new Error(`code graph not found: ${id}`);
    return g;
  };
  const stamp = '2026-11-01T00:00:00.000Z';

  const client = {
    async wikiGet(id: string) {
      record('wikiGet', [id]);
      const w = wikiOf(id);
      return {
        wiki_id: id, team_id: w.team_id, name: id, status: w.status, summary: w.summary,
        page_count: w.pages.length, sync_error: null, source_type: null, source_url: null,
        created_at: stamp, updated_at: stamp, last_sync_at: stamp,
      };
    },
    async codeGraphGet(id: string) {
      record('codeGraphGet', [id]);
      const g = graphOf(id);
      return {
        code_graph_id: id, team_id: g.team_id, repo_name: g.repo_name, repo_url: `https://git.test/${g.repo_name}`,
        branch: g.branch, status: g.status, summary: null, sync_error: null, commit_hash: 'abc123',
        owner_user_id: g.owner_user_id, stats: { files: 3, nodes: 9, edges: 12 },
        created_at: stamp, updated_at: stamp, last_sync_at: stamp,
      };
    },
    async codeGraphQuery(id: string, tool: string, params: Record<string, unknown>) {
      record('codeGraphQuery', [id, tool, params]);
      const g = graphOf(id);
      return { text: g.text[tool] ?? `${tool} found nothing in ${g.repo_name}`, isError: false };
    },
    async wikiSearch(id: string, query: string, limit?: number, graph?: Record<string, unknown>) {
      record('wikiSearch', [id, query, limit, graph]);
      const hits = wikiOf(id).pages.filter((p) => `${p.title} ${p.content}`.toLowerCase().includes(query.toLowerCase()));
      return {
        results: hits.map((p) => ({ path: p.ref, title: p.title, snippet: p.content.slice(0, 80), score: 1, type: 'concept' })),
        count: hits.length,
      };
    },
    async wikiPageRead(id: string, refs: string[]) {
      record('wikiPageRead', [id, refs]);
      const w = wikiOf(id);
      return {
        items: refs.map((ref) => {
          const page = w.pages.find((p) => p.ref === ref);
          return page ? { ref, content: page.content } : { ref, not_found: true };
        }),
      };
    },
    async wikiPageLs(id: string) {
      record('wikiPageLs', [id]);
      return { items: wikiOf(id).pages.map((p) => ({ id: p.ref, title: p.title, type: 'concept', path: p.ref })) };
    },
    async wikiGraph(id: string) {
      record('wikiGraph', [id]);
      const w = wikiOf(id);
      return { nodes: w.pages.map((p) => ({ id: p.ref, title: p.title })), edges: [], communities: [] };
    },
  };

  return {
    client,
    calls,
    addWiki(id: string, wiki: Partial<FakeWiki> & Pick<FakeWiki, 'team_id'>) {
      wikis.set(id, { summary: null, status: 'ready', pages: [], ...wiki });
    },
    addCodeGraph(id: string, graph: Partial<FakeCodeGraph> & Pick<FakeCodeGraph, 'team_id'>) {
      codeGraphs.set(id, {
        repo_name: `repo-${id}`, branch: 'main', status: 'ready', owner_user_id: null, text: {}, ...graph,
      });
    },
    failWith(method: string | null) {
      failMethod = method;
    },
    clearCalls() {
      calls.length = 0;
    },
  };
}

export type FakeKnowledge = ReturnType<typeof createFakeKnowledge>;

export interface McpHarness {
  fixture: PanelFixture;
  world: MetaWorld;
  ks: FakeKnowledge;
  app: Hono;
  invoke: ReturnType<typeof stubMetaKernel>;
  cleanup(): void;
}

/** The real Panel app over a fake Core. */
export async function createMcpHarness(
  world: MetaWorld = createMetaWorld(),
  routeOptions?: McpRouteOptions,
): Promise<McpHarness> {
  const fixture = await createPanelFixture();
  const invoke = stubMetaKernel(fixture.deps, (action, body, ctx) => world.handle(action, body, ctx));
  const ks = createFakeKnowledge();
  fixture.deps.knowledgeClientFactory = () => ks.client as unknown as ReturnType<PanelDeps['knowledgeClientFactory']>;
  const { buildPanelApp } = await import('../../../src/panel/http/app.js');
  let app: Hono;
  if (routeOptions) {
    // Only the MCP route, with its caps set by the test.
    const api = new Hono();
    registerMcpRoutes(api, fixture.deps, routeOptions);
    app = new Hono().route('/api/v1', api);
  } else {
    app = buildPanelApp(fixture.deps);
  }
  return {
    fixture,
    world,
    ks,
    app,
    invoke,
    cleanup() {
      fixture.cleanup();
      vi.unstubAllEnvs();
    },
  };
}

export const MCP_URL = 'http://panel.test/api/v1/mcp';

export function mcpHeaders(userKey: string | null, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-tdai-service-id': 'default',
    ...extra,
  };
  if (userKey) headers['x-tdai-user-key'] = userKey;
  return headers;
}

let rpcId = 0;

/** One JSON-RPC call over HTTP. Returns the HTTP response. */
export function rpc(
  app: Hono,
  userKey: string | null,
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Response | Promise<Response> {
  return app.request(MCP_URL, {
    method: 'POST',
    headers: mcpHeaders(userKey, extraHeaders),
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
}

export async function callTool(
  app: Hono,
  userKey: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; isError: boolean; text: string; json: () => any }> {
  const res = await rpc(app, userKey, 'tools/call', { name, arguments: args });
  if (res.status !== 200) return { status: res.status, isError: true, text: await res.text(), json: () => null };
  const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
  const text = body.result?.content?.[0]?.text ?? '';
  return { status: 200, isError: body.result?.isError === true, text, json: () => JSON.parse(text) };
}
