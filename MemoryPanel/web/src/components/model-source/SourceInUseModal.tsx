/**
 * SourceInUseModal — tells an admin why a source cannot be turned off or deleted: clients still
 * use it. Lists those clients. For an API source it links to the API Key page, where the selection
 * is changed. A team pool has its clients on the Subscription Pool page, so there it only explains.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, Modal } from 'tea-component';
import { clientSourcesApi } from '@/lib/api/client-sources';
import type { SourceInUse } from '@/lib/client-sources';

export type InUseAction = 'off' | 'delete' | 'pool';

interface Props {
  inUse: SourceInUse;
  action: InUseAction;
  onClose: () => void;
}

export function SourceInUseModal({ inUse, action, onClose }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Agent id to display name. A failed read keeps the ids, which is still readable.
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    let live = true;
    void clientSourcesApi
      .list()
      .then((v) => {
        if (live) setNames(new Map(v.agents.map((a) => [a.agent, a.display_name])));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return (
    <Modal visible size="m" caption={t(`modelSource.inUse.title.${action}`, { name: inUse.sourceName })} onClose={onClose}>
      <Modal.Body>
        <p>{t('modelSource.inUse.lead', { name: inUse.sourceName })}</p>
        <ul className="_memory-ms-inuse">
          {inUse.clients.map((c) => (
            <li key={c}>{names.get(c) ?? c}</li>
          ))}
        </ul>
        <p className="_memory-ms-weak">{t(action === 'pool' ? 'modelSource.inUse.hint.pool' : 'modelSource.inUse.hint')}</p>
      </Modal.Body>
      <Modal.Footer>
        {action !== 'pool' && (
          <Button
            type="primary"
            onClick={() => {
              onClose();
              navigate('/team/api-keys');
            }}
          >
            {t('modelSource.inUse.go')}
          </Button>
        )}
        <Button onClick={onClose}>{t('modelSource.inUse.close')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
