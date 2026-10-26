/**
 * ClientPreview — what omp, hermes and openclaw get from `GET /<agent>/<space>/v1/models`.
 * It merges API-key sources and subscription sources from the read actions open to every signed-in
 * user, and does not call the proxy. Claude Code and Codex are not here: they keep their own pool.
 */
import './style.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Tabs, Tag, Text } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import { modelProvidersApi, type ProviderGroup } from '@/lib/api/model-providers';
import { subscriptionPoolApi, type SubscriptionPoolProviderStatus } from '@/lib/api/subscription-pool';
import {
  PREVIEW_AGENTS,
  exposedFor,
  modelSourceCounts,
  ompModelsYaml,
  previewSourcesFrom,
  sourcesOffByPool,
  type PreviewAgent,
} from '@/lib/model-source';

interface Props {
  /** Change this value to reload the data after a write on the page. */
  refreshKey?: number;
}

export function ClientPreview({ refreshKey = 0 }: Props) {
  const { t } = useTranslation();
  const [agent, setAgent] = useState<PreviewAgent>('omp');
  const [groups, setGroups] = useState<ProviderGroup[]>([]);
  const [pools, setPools] = useState<SubscriptionPoolProviderStatus[]>([]);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [g, p] = await Promise.all([modelProvidersApi.view(), subscriptionPoolApi.status()]);
      setGroups(g);
      setPools(p.providers);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const sources = useMemo(
    () =>
      previewSourcesFrom(
        groups,
        pools.map((p) => ({ provider: p.provider, enabled: p.enabled, source: p.source })),
        (provider) => t(`subscriptionPool.agent.${provider}`),
      ),
    [groups, pools, t],
  );
  const list = exposedFor(agent, sources);
  const counts = modelSourceCounts(list);
  const off = sourcesOffByPool(agent, sources);
  const sourceCount = new Set(list.map((x) => x.source.name)).size;
  const yaml = useMemo(() => ompModelsYaml(exposedFor('omp', sources), '<proxy-url>'), [sources]);

  async function copyYaml() {
    try {
      await navigator.clipboard.writeText(yaml);
      tea.notify.success(t('modelSource.preview.copied'));
    } catch {
      tea.notify.warning(t('modelSource.preview.copyBlocked'));
    }
  }

  return (
    <Card>
      <Card.Body title={t('modelSource.preview.title')} subtitle={t('modelSource.preview.subtitle')}>
        {failed && <Alert type="error">{t('modelSource.preview.loadFailed')}</Alert>}
        <Tabs
          tabs={PREVIEW_AGENTS.map((a) => ({ id: a, label: `${a} (${exposedFor(a, sources).length})` }))}
          activeId={agent}
          disableTabScrolling
          onActive={(tab) => setAgent(tab.id as PreviewAgent)}
        />
        <Text theme="weak" parent="div" style={{ marginTop: 12 }}>
          {t('modelSource.preview.note')}
        </Text>
        {off.map((s) => (
          <Alert key={s.name} type="warning" style={{ marginTop: 12 }}>
            {t('modelSource.preview.offByPool', { name: s.name })}
          </Alert>
        ))}
        <div className="_memory-ms-two-col">
          <div>
            <Text parent="div" style={{ margin: '12px 0' }}>
              {t('modelSource.preview.summary', { agent, count: list.length, sources: sourceCount })}
            </Text>
            {list.length === 0 ? (
              <div className="_memory-ms-empty">{t('modelSource.preview.empty', { agent })}</div>
            ) : (
              <div className="_memory-ms-table-wrap">
                <table className="_memory-ms-table">
                  <thead>
                    <tr>
                      <th>{t('modelSource.preview.col.id')}</th>
                      <th>{t('modelSource.preview.col.source')}</th>
                      <th>{t('modelSource.preview.col.provider')}</th>
                      <th>{t('modelSource.preview.col.format')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((x) => (
                      <tr key={x.id}>
                        <td className="_memory-ms-mono">
                          <b className={x.source.kind === 'sub' ? '_memory-ms-sub' : '_memory-ms-api'}>{x.source.name}</b>/{x.model}
                          {(counts.get(x.model) ?? 0) > 1 && (
                            <Tag theme="warning">{t('modelSource.preview.sources', { count: counts.get(x.model) })}</Tag>
                          )}
                        </td>
                        <td>
                          <Tag>{t(x.source.kind === 'sub' ? 'modelSource.preview.kind.sub' : 'modelSource.preview.kind.api')}</Tag>
                        </td>
                        <td>{x.source.providerLabel}</td>
                        <td>{x.source.formats.join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div>
            {agent === 'omp' ? (
              <>
                <div className="_memory-ms-row" style={{ marginTop: 12 }}>
                  <b>{t('modelSource.preview.ompTitle')}</b>
                  <code>~/.omp/agent/models.yml</code>
                  <Button type="weak" style={{ marginLeft: 'auto' }} onClick={() => void copyYaml()}>
                    {t('modelSource.preview.copy')}
                  </Button>
                </div>
                <pre className="_memory-ms-code">{yaml}</pre>
                <div className="_memory-ms-help">{t('modelSource.preview.ompHelp')}</div>
              </>
            ) : (
              <Alert type="info" style={{ marginTop: 12 }}>
                {t('modelSource.preview.otherAgent', { agent })}
              </Alert>
            )}
          </div>
        </div>
      </Card.Body>
    </Card>
  );
}
