/**
 * 菜单元数据 — 从 App.tsx 抽出
 *
 * 包含页面 ID 类型、页面元信息、分组排序、分组图标。
 * Sidebar / TabBar / 路由等模块共用。
 */
import { useMemo, type ComponentType, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  DashboardIcon,
  UserIcon,
  UsergroupIcon,
  LockOnIcon,
  BooksIcon,
  CodeIcon,
  ToolsIcon,
  ChatIcon,
} from 'tea-icons-react';
// Relative on purpose: the Panel test suite loads this file and has no '@' alias.
import { buildCatalog, type CatalogEntry } from '../extensions/catalog';
import { WEB_EXTENSIONS, useEnabledExtensions } from '../extensions/registry';
import type { ExtPageId, MenuGroupKey } from '../extensions/types';

export type { ExtPageId } from '../extensions/types';

export type CorePageId =
  | 'workbench_board'
  | 'wiki'
  | 'code'
  | 'skills'
  | 'chat_memory'
  | 'processing_history'
  | 'team_members'
  | 'team_agents'
  | 'api_keys'
  | 'subscription_pool'
  | 'model_provider'
  | 'analytics';

/** Core pages and the pages that extensions add. */
export type PageId = CorePageId | ExtPageId;

/** 页面元数据 */
export interface PageMeta {
  id: PageId;
  label: string;
  desc?: string;
  /** 所属分组，用于侧边栏菜单分组标题 */
  group: string;
  /** Group key, the stable name behind the translated `group`. */
  groupKey: MenuGroupKey;
  /** 分组内排序，越小越靠前 */
  order: number;
  /** 固定标签页不可关闭（工作台看板） */
  affix?: boolean;
}

function corePageMeta(t: TFunction): Record<CorePageId, PageMeta> {
  const entry = (id: CorePageId, groupKey: MenuGroupKey, order: number, affix?: boolean): PageMeta => ({
    id,
    label: t(`menu.${id}`),
    desc: t(`menu.desc.${id}`),
    group: t(`menu.group.${groupKey}`),
    groupKey,
    order,
    ...(affix ? { affix } : {}),
  });
  return {
    workbench_board: entry('workbench_board', 'workbench', 0, true),
    analytics: entry('analytics', 'observability', 0),
    wiki: entry('wiki', 'assets', 2),
    code: entry('code', 'assets', 3),
    skills: entry('skills', 'assets', 4),
    chat_memory: entry('chat_memory', 'assets', 5),
    processing_history: entry('processing_history', 'assets', 6),
    team_members: entry('team_members', 'organization', 0),
    team_agents: entry('team_agents', 'organization', 1),
    api_keys: entry('api_keys', 'organization', 2),
    subscription_pool: entry('subscription_pool', 'organization', 3),
    model_provider: entry('model_provider', 'organization', 4),
  };
}

// 使用 useTranslation 的 hook 版本
export function usePageMeta(): Record<CorePageId, PageMeta> {
  const { t } = useTranslation();
  return corePageMeta(t);
}

/** 路由 path（核心页面） */
export const CORE_PAGE_PATHS: Record<CorePageId, string> = {
  workbench_board: '/',
  wiki: '/wiki',
  code: '/code',
  skills: '/skills',
  chat_memory: '/memory',
  processing_history: '/processing-history',
  analytics: '/analytics',
  team_members: '/team/members',
  team_agents: '/team/agents',
  api_keys: '/team/api-keys',
  subscription_pool: '/team/subscription-pool',
  model_provider: '/team/model-provider',
};

/** 分组排序顺序 */
export const GROUP_ORDER_KEYS = ['workbench', 'observability', 'organization', 'assets'] as const;

/** 每个页面在侧边栏菜单中的图标（Tea 官方图标，size 16） */
export const ITEM_ICON: Record<CorePageId, JSX.Element> = {
  workbench_board: <DashboardIcon size={16} />,
  analytics: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="20" x2="20" y2="20" />
      <rect x="6" y="10" width="3" height="6" rx="0.8" />
      <rect x="10.5" y="6" width="3" height="10" rx="0.8" />
      <rect x="15" y="13" width="3" height="3" rx="0.8" />
    </svg>
  ),
  team_members: <UserIcon size={16} />,
  team_agents: <UsergroupIcon size={16} />,
  api_keys: <LockOnIcon size={16} />,
  subscription_pool: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3l4 4-4 4" />
      <path d="M3 7h18" />
      <path d="M7 21l-4-4 4-4" />
      <path d="M21 17H3" />
    </svg>
  ),
  model_provider: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <path d="M8.5 6h3a3 3 0 0 1 3 3v0M8.5 18h3a3 3 0 0 0 3-3v0" />
    </svg>
  ),
  wiki: <BooksIcon size={16} />,
  code: <CodeIcon size={16} />,
  skills: <ToolsIcon size={16} />,
  chat_memory: <ChatIcon size={16} />,
  processing_history: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v4h4" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
};

export interface PageCatalogItem {
  id: PageId;
  label: string;
  desc?: string;
  groupKey: MenuGroupKey;
  order: number;
  affix?: boolean;
  icon: ReactNode;
  path: string;
  Badge?: ComponentType;
  entry: CatalogEntry;
}

/**
 * Every page the shell can show: the core pages and the pages of the extensions the server turned on.
 * Menu, tabs and routes read this one list.
 */
export function usePageCatalog(): PageCatalogItem[] {
  const { t } = useTranslation();
  const enabled = useEnabledExtensions();
  return useMemo(() => {
    const meta = corePageMeta(t);
    const coreItems: PageCatalogItem[] = (Object.keys(meta) as CorePageId[]).map((id) => {
      const entry: CatalogEntry = {
        id,
        group: meta[id].groupKey,
        order: meta[id].order,
        path: CORE_PAGE_PATHS[id],
        ...(meta[id].affix ? { affix: true } : {}),
      };
      return {
        id,
        label: meta[id].label,
        desc: meta[id].desc,
        groupKey: meta[id].groupKey,
        order: meta[id].order,
        ...(meta[id].affix ? { affix: true } : {}),
        icon: ITEM_ICON[id],
        path: CORE_PAGE_PATHS[id],
        entry,
      };
    });
    const entries = buildCatalog(
      coreItems.map((item) => item.entry),
      WEB_EXTENSIONS,
      enabled ?? [],
    );
    const items = [...coreItems];
    for (const entry of entries) {
      if (!entry.extensionId) continue;
      const extension = WEB_EXTENSIONS.find((candidate) => candidate.id === entry.extensionId);
      const page = extension?.pages.find((candidate) => candidate.id === entry.id);
      if (!extension || !page) continue;
      items.push({
        id: page.id,
        label: t(page.labelKey, { ns: extension.namespace }),
        ...(page.descKey ? { desc: t(page.descKey, { ns: extension.namespace }) } : {}),
        groupKey: page.group,
        order: page.order,
        icon: page.icon,
        path: page.path,
        ...(page.Badge ? { Badge: page.Badge } : {}),
        entry,
      });
    }
    return items;
  }, [t, enabled]);
}

/** 分组图标（工作台 / 可观测 / 组织与权限 / 资产管理） */
export const GROUP_ICON: Record<string, JSX.Element> = {
  workbench: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  observability: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  ),
  organization: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  assets: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l9 5-9 5-9-5 9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 17l9 5 9-5" />
    </svg>
  ),
};
