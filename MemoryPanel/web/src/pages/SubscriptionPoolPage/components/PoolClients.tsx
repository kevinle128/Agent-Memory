/**
 * PoolClients — which clients use the pool of the active team.
 *
 * The list of clients comes from Core. A client can use the pool when its wire format fits the
 * pool format. A team admin or a System Admin changes the choice; a member only sees it.
 * The choice is off while the pool is off, because Core refuses new clients on a pool that is off.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Checkbox, Text } from 'tea-component';
import { clientSourcesApi, type ClientSourceAgent } from '@/lib/api/client-sources';
import type { PoolProvider } from '@/lib/api/subscription-pool';
import { poolClientCandidates, toggleSource } from '@/lib/client-sources';

interface Props {
  readOnly: boolean;
  provider: PoolProvider;
  poolEnabled: boolean;
  /** Agent ids that use the pool now. */
  clients: readonly string[];
  saving: boolean;
  onSave: (agents: string[]) => void;
}

export function PoolClients({ readOnly, provider, poolEnabled, clients, saving, onSave }: Props) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<ClientSourceAgent[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<string[]>([...clients]);
  const stored = clients.join('\n');
  useEffect(() => setDraft([...clients]), [stored]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    clientSourcesApi
      .list()
      .then((view) => {
        if (live) setAgents(view.agents);
      })
      .catch(() => {
        if (live) setLoadFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const candidates = useMemo(() => (agents ? poolClientCandidates(agents, provider) : []), [agents, provider]);
  // A stored client that is not in the list of Core still shows, so it can be cleared.
  const known = new Set(candidates.map((a) => a.agent));
  const extra = clients.filter((id) => !known.has(id));
  const changed = draft.length !== clients.length || draft.some((id) => !clients.includes(id));
  const locked = readOnly || !poolEnabled || saving;

  return (
    <Card>
      <Card.Body title={t('subscriptionPool.clients.title')} subtitle={t('subscriptionPool.clients.hint')}>
        {loadFailed && <Text theme="danger">{t('subscriptionPool.clients.loadFailed')}</Text>}
        {!loadFailed && agents && candidates.length === 0 && extra.length === 0 && (
          <Text theme="weak">{t('subscriptionPool.clients.none')}</Text>
        )}
        <div className="_memory-pool-row">
          {[...candidates.map((a) => ({ id: a.agent, label: a.display_name })), ...extra.map((id) => ({ id, label: id }))].map((c) => (
            <Checkbox
              key={c.id}
              disabled={locked}
              value={draft.includes(c.id)}
              onChange={() => setDraft((prev) => toggleSource(prev, c.id))}
            >
              {c.label}
            </Checkbox>
          ))}
          {!readOnly && (
            <Button type="primary" disabled={!poolEnabled || !changed} loading={saving} onClick={() => onSave(draft)}>
              {t('subscriptionPool.clients.save')}
            </Button>
          )}
        </div>
        {!readOnly && !poolEnabled && <Text theme="weak" parent="div">{t('subscriptionPool.clients.poolOff')}</Text>}
      </Card.Body>
    </Card>
  );
}
