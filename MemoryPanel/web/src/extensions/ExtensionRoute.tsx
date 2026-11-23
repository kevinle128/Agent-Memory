import { Suspense, useRef, type ReactNode } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth';
import { useBackendStore } from '@/stores/backend';
import { isGlobalAdmin } from '@/services/permissions';
import { useCurrentRole } from '@/services/useCurrentRole';
import { WEB_EXTENSIONS, useEnabledExtensions } from './registry';

/** Renders its page only when the extension is on and the user may see it; otherwise goes to the workbench. */
export function ExtensionRoute({
  extensionId,
  visibleTo,
  children,
}: {
  extensionId: string;
  visibleTo: 'system_admin' | 'team_admin' | 'all';
  children: ReactNode;
}): JSX.Element | null {
  const enabled = useEnabledExtensions();
  const { auth } = useAuthStore();
  // Same rule as the menu: a system admin, or an admin of the team that is open.
  const role = useCurrentRole();
  const teamsLoaded = useBackendStore((s) => s.teamsLoaded);
  const allowedOnce = useRef(false);
  if (enabled === null) return null;
  if (!enabled.includes(extensionId)) return <Navigate to="/" replace />;
  if (visibleTo === 'system_admin' && !(auth && isGlobalAdmin(auth.user, auth.isAdmin))) {
    return <Navigate to="/" replace />;
  }
  if (visibleTo === 'team_admin') {
    const allowed = !!auth && (isGlobalAdmin(auth.user, auth.isAdmin) || role === 'admin');
    if (allowed) {
      allowedOnce.current = true;
    } else if (auth && !teamsLoaded) {
      // The team role is not known until the teams load (first load, or a reload after a write such as an
      // approval). Keep a page that was already allowed on screen, and wait otherwise.
      return allowedOnce.current ? <>{children}</> : null;
    } else {
      return <Navigate to="/" replace />;
    }
  }
  return <>{children}</>;
}

/** One child route per page of the built-in extensions. Pages are lazy, so an extension that is off loads no page code. */
export function extensionRouteObjects(): RouteObject[] {
  return WEB_EXTENSIONS.flatMap((extension) =>
    extension.pages.map((page) => ({
      path: page.path.replace(/^\//, ''),
      element: (
        <ExtensionRoute extensionId={extension.id} visibleTo={page.visibleTo}>
          <Suspense fallback={null}>
            <page.Component />
          </Suspense>
        </ExtensionRoute>
      ),
    })),
  );
}
