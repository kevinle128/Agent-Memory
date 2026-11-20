/**
 * Page catalog rules. Pure and free of JSX and alias imports, so the Panel Vitest suite can run them.
 */
import type { MenuGroupKey, MenuVisibilityContext, WebExtension, WebExtensionPage } from './types';

export interface CatalogEntry {
  id: string;
  group: MenuGroupKey;
  order: number;
  path: string;
  affix?: boolean;
  visibleTo?: 'system_admin' | 'all';
  extensionId?: string;
}

type ExtensionPages = Pick<WebExtension, 'id'> & {
  pages: Array<Pick<WebExtensionPage, 'id' | 'group' | 'order' | 'path' | 'visibleTo'>>;
};

/** The menu rules of the core pages. */
export function coreVisible(id: string, ctx: MenuVisibilityContext): boolean {
  switch (id) {
    case 'team_members':
      return ctx.userRole !== 'reviewer';
    case 'processing_history':
      return ctx.historyVisible;
    case 'analytics':
      return ctx.userRole === 'admin' && ctx.analyticsVisible;
    default:
      return true;
  }
}

/** Core entries first, then the pages of every enabled extension. A page of an extension that is off never enters. */
export function buildCatalog(
  core: CatalogEntry[],
  extensions: ExtensionPages[],
  enabledIds: readonly string[],
): CatalogEntry[] {
  const entries = [...core];
  for (const extension of extensions) {
    if (!enabledIds.includes(extension.id)) continue;
    for (const page of extension.pages) {
      entries.push({
        id: page.id,
        group: page.group,
        order: page.order,
        path: page.path,
        visibleTo: page.visibleTo,
        extensionId: extension.id,
      });
    }
  }
  return entries;
}

function entryVisible(entry: CatalogEntry, ctx: MenuVisibilityContext): boolean {
  if (!entry.extensionId) return coreVisible(entry.id, ctx);
  // A team admin is not a system admin: a system_admin page never shows for one.
  return entry.visibleTo === 'all' || ctx.isSystemAdmin;
}

export function menuGroups(
  entries: CatalogEntry[],
  ctx: MenuVisibilityContext,
  groupOrder: readonly MenuGroupKey[],
): Array<{ group: MenuGroupKey; ids: string[] }> {
  const byGroup = new Map<MenuGroupKey, CatalogEntry[]>();
  for (const entry of entries) {
    if (!entryVisible(entry, ctx)) continue;
    const list = byGroup.get(entry.group) ?? [];
    list.push(entry);
    byGroup.set(entry.group, list);
  }
  return groupOrder
    .filter((group) => byGroup.has(group))
    .map((group) => ({
      group,
      // Array#sort is stable, so equal orders keep the catalog order.
      ids: [...byGroup.get(group)!].sort((a, b) => a.order - b.order).map((entry) => entry.id),
    }));
}

/** Longest path prefix wins; '/' only matches exactly; default 'workbench_board'. */
export function pageForPath(entries: CatalogEntry[], pathname: string): string {
  let best: CatalogEntry | undefined;
  for (const entry of entries) {
    if (entry.path === '/') continue;
    const matches = pathname === entry.path || pathname.startsWith(`${entry.path}/`);
    if (matches && (!best || entry.path.length > best.path.length)) best = entry;
  }
  return best?.id ?? 'workbench_board';
}

/** GET /api/v1/extensions: ids of known extensions with status active or degraded. Anything else gives []. */
export function enabledIdsFrom(status: number, body: unknown, knownIds: readonly string[]): string[] {
  if (status !== 200 || typeof body !== 'object' || body === null) return [];
  const list = (body as { extensions?: unknown }).extensions;
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, status: state } = item as { id?: unknown; status?: unknown };
    if (typeof id !== 'string' || !knownIds.includes(id)) continue;
    if ((state === 'active' || state === 'degraded') && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
