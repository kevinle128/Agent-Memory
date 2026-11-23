// Relative imports only: the menu module loads this file and the Panel tests have no '@' alias.
import { lazy } from 'react';
import type { WebExtension } from '../types';
import { enUS } from './i18n/en-US';
import { viVN } from './i18n/vi-VN';
import { zhCN } from './i18n/zh-CN';

export const vtcWebExtension: WebExtension = {
  id: 'vtc',
  namespace: 'ext-vtc',
  i18n: { 'en-US': enUS, 'zh-CN': zhCN, 'vi-VN': viVN },
  pages: [
    {
      id: 'ext.vtc.pending_users',
      path: '/ext/vtc/pending-users',
      group: 'organization',
      // Directly under Members (order 0), before Agents (order 1).
      order: 0.5,
      labelKey: 'menu.pendingUsers',
      descKey: 'menu.pendingUsersDesc',
      icon: (
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3 20c0-3.3 2.7-6 6-6" />
          <circle cx="17" cy="16" r="4" />
          <path d="M17 14v2.2l1.4 1" />
        </svg>
      ),
      visibleTo: 'team_admin',
      Badge: lazy(() => import('./components/PendingCountBadge')),
      Component: lazy(() => import('./pages/PendingUsersPage')),
    },
  ],
};
