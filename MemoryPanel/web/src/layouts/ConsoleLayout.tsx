/**
 * ConsoleLayout — 主布局壳。
 *
 * 基于 tea-component 的 `Layout` + `Menu` 组件，包含 TabBar、路由、菜单过滤等业务逻辑。
 */
import { Suspense, useEffect, useMemo, useState, useCallback } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth';
import { useCurrentRole, type TeamRole } from '@/services/useCurrentRole';
import { isGlobalAdmin, isTeamAdmin, useTeams } from '@/services';
import { usePanelAnalyticsEnabled, useAnalyticsChConfigured } from '@/services/usePanelCapabilities';
import { GlobalHeader } from '@/layouts/GlobalHeader';
import { TabBar } from '@/layouts/TabBar';
import { OnboardingGuide, shouldShowOnboarding, resetOnboarding } from '@/layouts/OnboardingGuide';
import { usePageCatalog, GROUP_ORDER_KEYS, type PageId } from '@/constants/menu';
import { menuGroups as buildMenuGroups, pageForPath } from '@/extensions/catalog';

const { Body, Sider, Content } = Layout;

function legacyHashToPath(): string | null {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const leaf = raw.split('/').filter(Boolean).pop();
  if (!leaf) return null;
  if (leaf === 'wiki') return '/wiki';
  if (leaf === 'code') return '/code';
  if (leaf === 'skills' || leaf === 'skill') return '/skills';
  if (leaf === 'chat_memory' || leaf === 'memory' || leaf === 'chat-memory') return '/memory';
  if (leaf === 'agents' || leaf === 'team_agents') return '/team/agents';
  if (leaf === 'team' || leaf === 'members' || leaf === 'team_members') return '/team/members';
  if (leaf === 'api_keys' || leaf === 'apikey' || leaf === 'api-keys') return '/team/api-keys';
  return null;
}

export function ConsoleLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { auth, logout } = useAuthStore();
  const userRole: TeamRole | null = useCurrentRole();
  const { activeTeam } = useTeams();
  // Processing History holds prompts and memory text: team admins and system admins only.
  const historyVisible =
    !!auth && (isGlobalAdmin(auth.user, auth.isAdmin) || isTeamAdmin(activeTeam, auth.user_id));
  const catalog = usePageCatalog();

  const activePage = useMemo(
    () => pageForPath(catalog.map((item) => item.entry), location.pathname) as PageId,
    [catalog, location.pathname],
  );

  useEffect(() => {
    const legacyPath = legacyHashToPath();
    if (legacyPath && legacyPath !== location.pathname) {
      navigate(legacyPath, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 使用说明页为独立页（自带返回按钮与页头），不占用多标签页栏
  const isGuide = location.pathname === '/guide';

  const [openPages, setOpenPages] = useState<PageId[]>(() => (isGuide ? [] : [activePage]));

  useEffect(() => {
    // /guide 独立页不把 workbench_board 等页面追加进标签栏，避免返回时多出标签
    if (isGuide) return;
    setOpenPages((prev) => (prev.includes(activePage) ? prev : [...prev, activePage]));
  }, [activePage, isGuide]);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // 首次使用引导：登录后按「每用户仅首次」判定自动弹出
  const currentUserId = auth?.user_id;
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  useEffect(() => {
    if (currentUserId && shouldShowOnboarding(currentUserId)) {
      setOnboardingVisible(true);
    }
  }, [currentUserId]);

  /**
   * 回顾引导：清掉 onboarded 标记 + 把 Guide 重新置为可见。
   * 必须先清标记再 setVisible，否则 Guide 内部的 close→markOnboarded 链路里
   * 立刻又会重新标记为已看过（虽然本次不冲突，但下次自动判定仍会按"已看过"处理）。
   *
   * 入口仅保留「使用说明」页底部（GuidePage 触发 tdai-replay-onboarding 事件），
   * 顶栏「我的资料」等处的回顾引导入口已按需求收敛删除。
   */
  const handleReplayOnboarding = useCallback(() => {
    if (!currentUserId) return;
    resetOnboarding(currentUserId);
    setOnboardingVisible(true);
  }, [currentUserId]);

  // GuidePage 底部「引导回放」通过自定义事件触发回顾引导
  useEffect(() => {
    const onReplay = () => handleReplayOnboarding();
    window.addEventListener('tdai-replay-onboarding', onReplay);
    return () => window.removeEventListener('tdai-replay-onboarding', onReplay);
  }, [handleReplayOnboarding]);

  const navigateTo = useCallback(
    (id: PageId) => {
      const path = catalog.find((item) => item.id === id)?.path;
      if (path) navigate(path);
    },
    [navigate, catalog],
  );

  const closePage = useCallback(
    (id: PageId) => {
      setOpenPages((prev) => {
        const next = prev.filter((p) => p !== id);
        if (id === activePage && next.length > 0) {
          navigateTo(next[next.length - 1]);
        }
        return next;
      });
    },
    [activePage, navigateTo],
  );

  // ===== 基于 team role 的菜单过滤 =====
  // admin 可访问所有页面（含资源管理）
  // 「成员管理」项：reviewer 不可见
  //
  // 「可观测」（analytics）入口三层收敛（缺一即隐藏）：
  //   1. 仅 system_admin 可见（useCurrentRole() === 'admin'）
  //   2. 面板 env 开关 PANEL_FEATURE_ANALYTICS_ENABLED（默认关闭，经
  //      /meta/instances 的 capabilities 下发；开关关闭时不发起 CH 探测）
  //   3. 运行时 CH 探测：内核未配置 analytics ClickHouse 时自动隐藏
  //      （探测中先保持展示，确认未配置后收敛隐藏，避免闪烁）
  const analyticsSwitchOn = usePanelAnalyticsEnabled();
  const analyticsChConfigured = useAnalyticsChConfigured(analyticsSwitchOn === true);
  const analyticsVisible =
    analyticsSwitchOn === true && analyticsChConfigured !== false;

  const isSystemAdmin = !!auth && isGlobalAdmin(auth.user, auth.isAdmin);

  const menuGroups = useMemo(() => {
    const byId = new Map(catalog.map((item) => [item.id as string, item]));
    return buildMenuGroups(
      catalog.map((item) => item.entry),
      { userRole, isSystemAdmin, historyVisible, analyticsVisible },
      GROUP_ORDER_KEYS,
    ).map(({ group, ids }) => ({
      title: t(`menu.group.${group}`),
      items: ids.map((id) => byId.get(id)!),
    }));
  }, [catalog, userRole, isSystemAdmin, t, analyticsVisible, historyVisible]);

  const workbenchGroupTitle = t('menu.group.workbench');
  const pinnedGroup = menuGroups.find((g) => g.title === workbenchGroupTitle);
  const restGroups = menuGroups.filter((g) => g.title !== workbenchGroupTitle);

  const renderMenuItem = (item: (typeof catalog)[number]) => {
    const isActive = activePage === item.id;
    return (
      <Menu.Item
        key={item.id}
        title={
          item.Badge ? (
            <>
              {item.label}
              <Suspense fallback={null}>
                <item.Badge />
              </Suspense>
            </>
          ) : (
            item.label
          )
        }
        icon={item.icon}
        selected={isActive}
        onClick={() => navigateTo(item.id)}
      />
    );
  };

  return (
    <div className="_memory-app-shell">
      <OnboardingGuide
        visible={onboardingVisible}
        userId={currentUserId}
        userRole={userRole}
        onClose={() => setOnboardingVisible(false)}
      />
      <GlobalHeader
        userRole={userRole}
        currentUser={auth?.user ?? ''}
        currentUserId={auth?.user_id}
        instanceName={auth?.instance_name}
        onLogout={logout}
      />
      <Layout>
        <Body>
          <Sider>
            {/* 品牌已在全局 Header 展示，侧栏只承载导航（与 Memory项目公共壳层一致）。 */}
            <Menu collapsable collapsed={sidebarCollapsed} onCollapsedChange={setSidebarCollapsed}>
              {pinnedGroup?.items.map((item) => renderMenuItem(item))}
              {restGroups.map((group) => (
                <Menu.Group key={group.title} title={group.title}>
                  {group.items.map((item) => renderMenuItem(item))}
                </Menu.Group>
              ))}
            </Menu>
          </Sider>
          <Content>
            {!isGuide && (
              <TabBar
                pages={openPages}
                activePage={activePage}
                onNavigate={navigateTo}
                onClose={closePage}
              />
            )}
            <Content.Body className="_memory-content-body">
              {/* key 绑定 pathname：路由切换时重挂载页面帧，触发 _page-enter 过渡，保持跨页连续性 */}
              <main key={location.pathname} className="_memory-page-frame">
                <Outlet />
              </main>
            </Content.Body>
          </Content>
        </Body>
      </Layout>
    </div>
  );
}
