import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';

export type MenuGroupKey = 'workbench' | 'observability' | 'organization' | 'assets';
export type ExtPageId = `ext.${string}.${string}`;
export type ExtensionLang = 'en-US' | 'zh-CN' | 'vi-VN';

export interface MenuVisibilityContext {
  userRole: 'admin' | 'member' | 'reviewer' | null;
  isSystemAdmin: boolean;
  historyVisible: boolean;
  analyticsVisible: boolean;
}

export interface WebExtensionPage {
  /** 'ext.<extension>.<page>' */
  id: ExtPageId;
  /** Hash route path, '/ext/<extension>/<page-kebab>'. */
  path: string;
  group: MenuGroupKey;
  order: number;
  /** Key in the extension namespace. */
  labelKey: string;
  descKey?: string;
  icon: ReactNode;
  visibleTo: 'system_admin' | 'team_admin' | 'all';
  /** Shown after the menu label; owns its data hooks. Lazy so the menu module stays alias-free. */
  Badge?: LazyExoticComponent<ComponentType>;
  Component: LazyExoticComponent<ComponentType>;
}

export interface WebExtension {
  id: string;
  namespace: `ext-${string}`;
  i18n: Partial<Record<ExtensionLang, Record<string, string>>>;
  pages: WebExtensionPage[];
}
