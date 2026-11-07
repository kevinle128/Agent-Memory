/**
 * Opens an L0 session from a link: `#/memory?agent=<agent_id>&session=<id>[&message=<id>]`.
 * Other pages (Processing History) use it to show the conversation behind a
 * record. Steps: select the agent in the fixed tab, select the chat memory
 * of that agent, then open the session in L0. Only agents of the current
 * user can be opened here; for another agent the page shows a notice.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { tea } from '@/lib/tea-bridge';
import type { ChatMemoryStore } from './useChatMemory';

type Stage = 'agent' | 'block' | 'session' | 'done';

export function useSessionDeepLink(store: ChatMemoryStore): void {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const agent = params.get('agent');
  const session = params.get('session');
  const message = params.get('message') ?? undefined;
  const stage = useRef<Stage>('agent');
  const blockId = useRef<string | null>(null);
  // True when selecting the agent starts a new block list load. Then a missing
  // block is known only after that load: the list before it is of another agent.
  const needsLoad = useRef(false);
  const sawLoading = useRef(false);

  const {
    activeTeamId,
    teamAgents,
    ownedTeamAgents,
    setScopeTab,
    setAgentFilter,
    agentFilter,
    scopeTab,
    blocks,
    blocksLoading,
    selectedId,
    setSelectedId,
    openL1Source,
  } = store;

  useEffect(() => {
    if (!agent || !session) return;
    const finish = (notice?: string) => {
      stage.current = 'done';
      if (notice) tea.notify.warning(notice);
      setParams({}, { replace: true });
    };

    if (stage.current === 'agent') {
      // Wait until the agents of the team are known.
      if (teamAgents.length === 0) return;
      if (!ownedTeamAgents.some((a) => a.agent_id === agent)) {
        finish(t('memory.deepLink.notOwnAgent'));
        return;
      }
      needsLoad.current = !(scopeTab === 'fixed' && agentFilter === agent);
      setScopeTab('fixed');
      setAgentFilter(agent);
      stage.current = 'block';
      return;
    }

    if (stage.current === 'block') {
      if (blocksLoading) sawLoading.current = true;
      if (scopeTab !== 'fixed' || agentFilter !== agent) return;
      // The agent's own chat memory; borrowed ones have other ids.
      const block = blocks.find((b) => b.id === `chat_memory-${activeTeamId}-${agent}`);
      if (!block) {
        if (blocksLoading || (needsLoad.current && !sawLoading.current)) return;
        finish(t('memory.deepLink.noMemory'));
        return;
      }
      blockId.current = block.id;
      setSelectedId(block.id);
      stage.current = 'session';
      return;
    }

    if (stage.current === 'session' && selectedId === blockId.current) {
      // The L0 view resets its session when the block changes; that reset
      // runs before this effect, so the session opened here stays selected.
      openL1Source(session, message);
      finish();
    }
  }, [
    agent,
    session,
    message,
    activeTeamId,
    teamAgents,
    ownedTeamAgents,
    scopeTab,
    agentFilter,
    blocks,
    blocksLoading,
    selectedId,
    setScopeTab,
    setAgentFilter,
    setSelectedId,
    openL1Source,
    setParams,
    t,
  ]);
}
