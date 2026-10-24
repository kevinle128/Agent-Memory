/** Display name for a user id: "name (you)" for the logged-in user, the id when no name is known. */
import { useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getPanelSession } from '@/lib/panelSession';
import { useUserDisplayName } from '@/services/user-profile-store';
import { UserRenderContext } from '../lib/user-render-context';

function UserName({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const name = useUserDisplayName(userId);
  const me = getPanelSession()?.user?.user_id;
  return (
    <>
      {name || userId}
      {me && me === userId ? t('skills.ownerTag.you') : ''}
    </>
  );
}

export function UserNameProvider({ children }: { children: ReactNode }) {
  const render = useCallback((userId: string) => <UserName userId={userId} />, []);
  return <UserRenderContext.Provider value={render}>{children}</UserRenderContext.Provider>;
}
