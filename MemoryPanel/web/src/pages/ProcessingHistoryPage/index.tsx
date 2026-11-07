/**
 * Processing History — audit of what the memory system did, for team admins:
 * injections (client-hook recall), extractions (memory generation runs) and
 * skill suggestions (proposals), each with 👍/👎 ratings.
 *
 * The menu hides the page from other users, and the Panel server checks the
 * role again on every call.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth';
import { isGlobalAdmin, isTeamAdmin, useAgents, useTeams } from '@/services';
import { processingHistoryApi, type ProcessingHistoryConfig } from '@/lib/api/processing-history';
import { InjectionsTab } from './components/InjectionsTab';
import { ExtractionsTab } from './components/ExtractionsTab';
import { SkillSuggestionsTab } from './components/SkillSuggestionsTab';
import { shortId, useErrorText } from './components/shared';
import './styles/processing-history.css';

type TabId = 'injections' | 'extractions' | 'skills';
const TABS: TabId[] = ['injections', 'extractions', 'skills'];

export function ProcessingHistoryPage() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { auth } = useAuthStore();
  const { activeTeam, activeTeamId } = useTeams();
  const { agents } = useAgents(activeTeamId);
  const [tab, setTab] = useState<TabId>('injections');
  const [config, setConfig] = useState<ProcessingHistoryConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const userId = auth?.user_id ?? '';
  const allowed = !!auth && (isGlobalAdmin(auth.user, auth.isAdmin) || isTeamAdmin(activeTeam, userId));

  useEffect(() => {
    if (!activeTeamId || !allowed) return;
    let cancelled = false;
    setConfig(null);
    setConfigError(null);
    processingHistoryApi
      .config(activeTeamId)
      .then((c) => {
        if (!cancelled) setConfig(c);
      })
      .catch((err) => {
        if (!cancelled) setConfigError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [activeTeamId, allowed, errorText]);

  const memberName = (id: string) =>
    activeTeam?.members.find((m) => m.user_id === id)?.username || (id === userId ? auth?.user ?? id : shortId(id));

  if (!activeTeamId) return <div className="_ph-page _ph-empty">{t('history.noTeam')}</div>;
  if (!allowed) return <div className="_ph-page _ph-empty">{t('history.adminOnly')}</div>;

  return (
    <div className="_ph-page">
      <div className="_ph-head">
        <h2>{t('history.pageTitle')}</h2>
        <div className="_ph-mut">{t('history.pageSub')}</div>
      </div>
      {configError && <div className="_ph-error">{configError}</div>}
      <div className="_ph-frame">
        <div className="_ph-subtabs" role="tablist">
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? '_ph-subtab _ph-subtab--on' : '_ph-subtab'}
              onClick={() => setTab(id)}
            >
              {t(`history.tab.${id}`)}
            </button>
          ))}
        </div>
        {config && tab === 'injections' && !config.injections_configured && (
          <div className="_ph-error">{t('history.error.INJECTION_LOG_NOT_CONFIGURED')}</div>
        )}
        {config && tab === 'injections' && config.injections_configured && (
          <InjectionsTab teamId={activeTeamId} agents={agents} />
        )}
        {config && tab === 'extractions' && (
          <ExtractionsTab teamId={activeTeamId} agents={agents} langfuseProjectUrl={config.langfuse_project_url} />
        )}
        {config && tab === 'skills' && (
          <SkillSuggestionsTab teamId={activeTeamId} userId={userId} memberName={memberName} />
        )}
      </div>
    </div>
  );
}
