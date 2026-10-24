/** True unless the instance runs in chat prompt mode. Defaults to true while loading or on failure. */
import { useEffect, useState } from 'react';
import { getSkillSettings } from '@/lib/api/skill-api';
import { getPanelSession } from '@/lib/panelSession';
import { createPromptModeLoader, showsProjectUi } from '../lib/prompt-mode';

const loadPromptMode = createPromptModeLoader(getSkillSettings);

export function useShowProjectUi(): boolean {
  const instanceId = getPanelSession()?.instanceId ?? '';
  const [show, setShow] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void loadPromptMode(instanceId).then((mode) => {
      if (!cancelled) setShow(showsProjectUi(mode));
    });
    return () => {
      cancelled = true;
    };
  }, [instanceId]);
  return show;
}
