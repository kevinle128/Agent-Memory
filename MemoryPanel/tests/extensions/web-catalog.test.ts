import { createElement } from '../../web/node_modules/react';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import baseline from './fixtures/web-catalog-baseline.json';
import {
  buildCatalog,
  enabledIdsFrom,
  menuGroups,
  pageForPath,
  type CatalogEntry,
} from '../../web/src/extensions/catalog';
import type { MenuGroupKey, MenuVisibilityContext } from '../../web/src/extensions/types';

// The menu module reads labels through react-i18next; the test needs the keys, not an i18n instance.
vi.mock('../../web/node_modules/react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { usePageMeta, CORE_PAGE_PATHS, GROUP_ORDER_KEYS } = await import('../../web/src/constants/menu');

type Group = { group: string; ids: string[] };
const groupOrder = baseline.groupOrder as MenuGroupKey[];

const fixturePages: CatalogEntry[] = baseline.pages.map((page) => ({
  id: page.id,
  group: page.group as MenuGroupKey,
  order: page.order,
  path: page.path,
  ...('affix' in page ? { affix: (page as { affix: boolean }).affix } : {}),
}));

const menus = baseline.menus as Record<string, { ctx: MenuVisibilityContext; groups: Group[] }>;

const DEMO = {
  id: 'demo',
  pages: [
    {
      id: 'ext.demo.pending' as const,
      group: 'organization' as const,
      order: 0.5,
      path: '/ext/demo/pending',
      visibleTo: 'system_admin' as const,
    },
  ],
};

describe('web page catalog', () => {
  it("keeps today's menu with no extension", () => {
    for (const [name, menu] of Object.entries(menus)) {
      expect(menuGroups(buildCatalog(fixturePages, [], []), menu.ctx, groupOrder), name).toEqual(menu.groups);
    }
  });

  it('maps paths to pages as today', () => {
    for (const page of baseline.pages) expect(pageForPath(fixturePages, page.path), page.path).toBe(page.id);
    expect(pageForPath(fixturePages, '/team/members/x')).toBe('team_members');
    expect(pageForPath(fixturePages, '/nope')).toBe('workbench_board');
    expect(pageForPath(fixturePages, '/')).toBe('workbench_board');
  });

  it('lets the longest path prefix win', () => {
    const entries: CatalogEntry[] = [
      ...fixturePages,
      { id: 'ext.demo.team', group: 'organization', order: 9, path: '/team/members/extra', extensionId: 'demo', visibleTo: 'all' },
    ];
    expect(pageForPath(entries, '/team/members/extra')).toBe('ext.demo.team');
    expect(pageForPath(entries, '/team/members/other')).toBe('team_members');
  });

  it('adds an enabled extension page under Members for system admins only', () => {
    const catalog = buildCatalog(fixturePages, [DEMO], ['demo']);
    const organization = (name: string) => menuGroups(catalog, menus[name]!.ctx, groupOrder).find((g) => g.group === 'organization')?.ids;
    expect(organization('systemAdmin')).toEqual([
      'team_members',
      'ext.demo.pending',
      'team_agents',
      'api_keys',
      'subscription_pool',
      'model_provider',
    ]);
    for (const name of ['teamAdmin', 'member', 'reviewer']) {
      expect(organization(name), name).not.toContain('ext.demo.pending');
    }
  });

  it('shows a team_admin page for a team admin and a system admin, and hides it for a member', () => {
    const page = { id: 'demo', pages: [{ ...DEMO.pages[0]!, visibleTo: 'team_admin' as const }] };
    const catalog = buildCatalog(fixturePages, [page], ['demo']);
    const organization = (name: string) =>
      menuGroups(catalog, menus[name]!.ctx, groupOrder).find((g) => g.group === 'organization')?.ids;
    expect(organization('systemAdmin')).toContain('ext.demo.pending');
    expect(organization('teamAdmin')).toContain('ext.demo.pending');
    expect(organization('member')).not.toContain('ext.demo.pending');
    expect(organization('reviewer')).not.toContain('ext.demo.pending');
  });

  it('shows a page for everyone when it is open to all', () => {
    const open = { id: 'demo', pages: [{ ...DEMO.pages[0]!, visibleTo: 'all' as const }] };
    const catalog = buildCatalog(fixturePages, [open], ['demo']);
    const ids = menuGroups(catalog, menus.member!.ctx, groupOrder).flatMap((g) => g.ids);
    expect(ids).toContain('ext.demo.pending');
  });

  it('ignores a known extension that is not enabled', () => {
    expect(buildCatalog(fixturePages, [DEMO], [])).toEqual(fixturePages);
    expect(buildCatalog(fixturePages, [DEMO], ['other'])).toEqual(fixturePages);
    const ids = menuGroups(buildCatalog(fixturePages, [DEMO], []), menus.systemAdmin!.ctx, groupOrder).flatMap((g) => g.ids);
    expect(ids).not.toContain('ext.demo.pending');
  });

  it('reads only active or degraded known extensions', () => {
    const known = ['demo'];
    expect(enabledIdsFrom(404, { extensions: [{ id: 'demo', status: 'active' }] }, known)).toEqual([]);
    expect(enabledIdsFrom(200, { extensions: [{ id: 'demo', status: 'failed' }] }, known)).toEqual([]);
    expect(enabledIdsFrom(200, { extensions: [{ id: 'demo', status: 'active' }] }, known)).toEqual(['demo']);
    expect(enabledIdsFrom(200, { extensions: [{ id: 'demo', status: 'degraded' }] }, known)).toEqual(['demo']);
    expect(enabledIdsFrom(200, { extensions: [{ id: 'unknown', status: 'active' }] }, known)).toEqual([]);
    for (const body of [null, undefined, 'x', 3, {}, { extensions: 'x' }, { extensions: [null, 1, { id: 5, status: 'active' }] }]) {
      expect(enabledIdsFrom(200, body, known), JSON.stringify(body)).toEqual([]);
    }
  });

  it('keeps the core page paths', () => {
    let meta: ReturnType<typeof usePageMeta> | undefined;
    const Probe = () => {
      meta = usePageMeta();
      return null;
    };
    renderToStaticMarkup(createElement(Probe));
    expect(meta).toBeDefined();
    for (const page of baseline.pages) {
      expect(CORE_PAGE_PATHS[page.id as keyof typeof CORE_PAGE_PATHS], page.id).toBe(page.path);
      expect(meta![page.id as keyof typeof CORE_PAGE_PATHS].groupKey, page.id).toBe(page.group);
    }
    expect(Object.keys(CORE_PAGE_PATHS)).toHaveLength(baseline.pages.length);
    expect([...GROUP_ORDER_KEYS]).toEqual(baseline.groupOrder);
  });
});
