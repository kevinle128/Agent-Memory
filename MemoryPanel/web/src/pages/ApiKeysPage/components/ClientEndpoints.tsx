/**
 * ClientEndpoints — one card per client of Client Access Endpoint: the endpoint URL and the
 * model sources the client uses. The clients come from Core, so a client that Core adds shows up
 * without a Panel change. A System Admin picks the sources; everyone else sees them read-only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Copy, StatusTip, Tag, Text } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import { clientSourcesApi, type ClientSourceAgent, type ClientSourcesView } from '@/lib/api/client-sources';
import { sourceErrorCode, sourceErrorMessage, STALE_SOURCE_CODES } from '@/lib/source-error';
import { SourceSelect } from '@/components/model-source/SourceSelect';

interface Props {
  /** Client base URL without a trailing slash. */
  baseUrl: string;
  instanceId: string;
  canEdit: boolean;
}

export function ClientEndpoints({ baseUrl, instanceId, canEdit }: Props) {
  const { t } = useTranslation();
  const [view, setView] = useState<ClientSourcesView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // Only the newest list request may write state.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await clientSourcesApi.list();
      if (mine !== seq.current) return;
      setView(next);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);

  function setBusyFor(agent: string, on: boolean) {
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(agent);
      else next.delete(agent);
      return next;
    });
  }

  async function change(agent: ClientSourceAgent, names: string[]) {
    // Removing a source hides its models from the client, so ask first.
    const removed = agent.selected.filter((n) => !names.includes(n));
    if (agent.mode === 'multi' && removed.length > 0) {
      const ok = await tea.confirm({
        message: t('clientSources.confirmRemove', { name: removed.join(', '), client: agent.display_name }),
        description: t('clientSources.confirmRemove.desc'),
      });
      if (!ok) return;
    }
    setBusyFor(agent.agent, true);
    try {
      const saved = await clientSourcesApi.update(agent.agent, names);
      setView((v) => (v ? { ...v, agents: v.agents.map((a) => (a.agent === saved.agent ? { ...a, ...saved } : a)) } : v));
    } catch (e) {
      const message = sourceErrorMessage(e);
      if (message) tea.notify.error(message);
      else tea.notify.error(e);
      const code = sourceErrorCode(e);
      if (code && STALE_SOURCE_CODES.has(code)) await load();
    } finally {
      setBusyFor(agent.agent, false);
    }
  }

  if (!view) {
    return error ? (
      <StatusTip status="error" emptyText={t('clientSources.loadFailed')} onRetry={() => void load()} retryText={t('subscriptionPool.retry')} />
    ) : (
      <Text theme="weak" style={{ fontSize: 11 }}>{t('apiKey.endpoint.loading')}</Text>
    );
  }

  return (
    <div className="_memory-apikey-endpoints">
      {view.agents.map((agent) => {
        const url = `${baseUrl}/${agent.agent}/${instanceId}`;
        return (
          <div className="_memory-apikey-endpoint" key={agent.agent}>
            <Text theme="label" parent="div" style={{ marginBottom: 4 }}>
              {agent.display_name}{' '}
              <Tag theme={agent.mode === 'multi' ? 'primary' : 'default'}>
                {t(agent.mode === 'multi' ? 'clientSources.badge.multi' : 'clientSources.badge.single')}
              </Tag>
            </Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <code
                style={{
                  flex: 1,
                  fontSize: 11,
                  wordBreak: 'break-all',
                  background: 'var(--tea-color-bg-secondary-default)',
                  padding: '4px 8px',
                  borderRadius: 4,
                }}
              >
                {url}
              </code>
              <Copy text={url}>
                <Button>{t('apiKey.endpoint.copy')}</Button>
              </Copy>
            </div>
            <SourceSelect
              agent={agent}
              sources={view.sources}
              readOnly={!canEdit}
              busy={busy.has(agent.agent)}
              onChange={(names) => void change(agent, names)}
            />
          </div>
        );
      })}
    </div>
  );
}
