/**
 * PoolSourceCard — the "use as a source" part of one subscription pool. One pool has at most one
 * source. The source follows the pool switch, so there is no switch of its own here. Writes send
 * only source fields: never `agents`, `enabled`, `mode` or `source_enabled`.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Tag } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import { modelProvidersApi } from '@/lib/api/model-providers';
import { subscriptionPoolApi, type PoolProvider, type SubscriptionPoolProviderStatus } from '@/lib/api/subscription-pool';
import {
  DEFAULT_SOURCE_AGENTS,
  buildPoolSourceUpdate,
  countEnabled,
  formatFetchedAt,
  toggleInList,
  validateSourceName,
} from '@/lib/model-source';
import { sourceErrorMessage } from '@/lib/source-error';
import { SourceNameField } from '@/components/model-source/SourceNameField';
import { SourceAgentsTable } from '@/components/model-source/SourceAgentsTable';
import { SourceModelTable, type ModelChange } from '@/components/model-source/SourceModelTable';
import { ClientPreview } from '@/components/model-source/ClientPreview';

interface Props {
  provider: PoolProvider;
  pool: SubscriptionPoolProviderStatus;
  readOnly: boolean;
  /** Reload the pool status after a write. */
  onChanged: () => Promise<void>;
}

/** Source name that Core proposes for a pool of this provider. */
const SUGGEST_PROVIDER: Record<PoolProvider, string> = { claude: 'claude', codex: 'openai' };
const AGENT_OPTIONS = DEFAULT_SOURCE_AGENTS.map((id) => ({ id, label: id }));

export function PoolSourceCard({ provider, pool, readOnly, onChanged }: Props) {
  const { t } = useTranslation();
  const source = pool.source && pool.source.source_name ? pool.source : null;
  const groupId = pool.group_id;
  const [name, setName] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const [agents, setAgents] = useState<string[]>([...DEFAULT_SOURCE_AGENTS]);
  const [taken, setTaken] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  const needsCreate = Boolean(groupId) && !source && !readOnly;

  // The create step proposes a name and learns which names are already used.
  useEffect(() => {
    if (!needsCreate) return;
    let live = true;
    setAgents([...DEFAULT_SOURCE_AGENTS]);
    void (async () => {
      try {
        const [proposal, groups, status] = await Promise.all([
          modelProvidersApi.suggestSourceName('subscription', SUGGEST_PROVIDER[provider]),
          modelProvidersApi.view(),
          subscriptionPoolApi.status(),
        ]);
        if (!live) return;
        const names = new Set<string>();
        for (const g of groups) if (g.source_name) names.add(g.source_name);
        for (const p of status.providers) if (p.source?.source_name) names.add(p.source.source_name);
        setTaken(names);
        setSuggestion(proposal);
        setName(proposal);
      } catch (e) {
        if (live) tea.notify.error(e);
      }
    })();
    return () => {
      live = false;
    };
  }, [needsCreate, provider]);

  function fail(e: unknown) {
    const message = sourceErrorMessage(e);
    if (message) tea.notify.error(message);
    else tea.notify.error(e);
  }

  async function changed() {
    setPreviewKey((k) => k + 1);
    await onChanged();
  }

  async function createSource() {
    if (!groupId || busy) return;
    setBusy(true);
    try {
      await modelProvidersApi.update(buildPoolSourceUpdate(groupId, { sourceName: name, sourceAgents: agents }));
      // First read of the model list. A failed read is stored on the group, not thrown.
      await modelProvidersApi.refresh(groupId).catch(() => undefined);
      tea.notify.success(t('subscriptionPool.source.created', { name }));
      await changed();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function saveAgents(next: string[]) {
    if (!groupId || busy) return;
    setBusy(true);
    try {
      await modelProvidersApi.update(buildPoolSourceUpdate(groupId, { sourceAgents: next }));
      tea.notify.success(t('subscriptionPool.source.agentsSaved', { name: source?.source_name }));
      await changed();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function writeModels(changes: ModelChange[]) {
    if (!groupId || changes.length === 0 || busy) return;
    setBusy(true);
    try {
      await modelProvidersApi.updateModels(groupId, changes);
      await changed();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function refreshModels() {
    if (!groupId) return;
    setRefreshing(true);
    try {
      const res = await modelProvidersApi.refresh(groupId);
      if (res.source_models_error) tea.notify.warning(t('modelProvider.toast.fetchFailed'));
      else tea.notify.success(t('modelProvider.toast.fetched'));
      await changed();
    } catch (e) {
      fail(e);
    } finally {
      setRefreshing(false);
    }
  }

  const head = (
    <Card.Body
      title={t('subscriptionPool.source.title')}
      subtitle={t('subscriptionPool.source.subtitle', { agent: t(`subscriptionPool.agent.${provider}`) })}
      operation={readOnly ? <Tag>{t('subscriptionPool.source.readOnly')}</Tag> : undefined}
    >
      {renderBody()}
    </Card.Body>
  );

  function renderBody() {
    if (!groupId) {
      return <Alert type="info">{t('subscriptionPool.source.noPool')}</Alert>;
    }
    const exampleModel = source?.source_models[0]?.id ?? '';
    const off = source ? !source.source_active : !pool.enabled;
    const offAlert = off ? (
      <Alert type="warning" style={{ marginBottom: 16 }}>
        <b>{t('modelSource.offByPool')}.</b>{' '}
        {t('subscriptionPool.source.offDetail', { name: source?.source_name || name || '…' })}
      </Alert>
    ) : null;

    if (!source) {
      if (readOnly) return <div className="_memory-ms-empty">{t('subscriptionPool.source.adminOnly')}</div>;
      const nameProblem = validateSourceName(name, taken);
      return (
        <>
          {offAlert}
          <Alert type="info" style={{ marginBottom: 16 }}>
            {t('subscriptionPool.source.createHint')} <b>{t('modelSource.name.immutable')}</b>
          </Alert>
          <div className="_memory-pool-source-form">
            <div className="_memory-pool-source-label">{t('modelProvider.form.sourceName')}</div>
            <div>
              <SourceNameField
                value={name}
                onChange={setName}
                saved={false}
                taken={taken}
                suggestion={suggestion}
                exampleModel={exampleModel}
              />
            </div>
            <div className="_memory-pool-source-label">{t('modelProvider.form.formats')}</div>
            <div>
              <Tag>{t(`modelSource.format.${provider === 'claude' ? 'anthropic-messages' : 'openai-responses'}`)}</Tag>
              <div className="_memory-ms-help">{t('subscriptionPool.source.formatFixed')}</div>
            </div>
            <div className="_memory-pool-source-label">{t('modelProvider.form.sourceAgents')}</div>
            <div>
              <SourceAgentsTable
                options={AGENT_OPTIONS}
                selected={agents}
                sourceName={name}
                enabledModelCount={0}
                onToggle={(agent, on) => setAgents((list) => toggleInList(list, agent, on))}
              />
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <Button
              type="primary"
              loading={busy}
              disabled={busy || nameProblem !== null || agents.length === 0}
              onClick={() => void createSource()}
            >
              {t('subscriptionPool.source.create')}
            </Button>
          </div>
        </>
      );
    }

    return (
      <>
        {offAlert}
        <div className="_memory-pool-source-form">
          <div className="_memory-pool-source-label">{t('modelProvider.form.sourceName')}</div>
          <div>
            <SourceNameField
              value={source.source_name}
              onChange={() => undefined}
              saved
              taken={taken}
              suggestion=""
              exampleModel={exampleModel}
            />
          </div>
          <div className="_memory-pool-source-label">{t('modelProvider.form.formats')}</div>
          <div>
            {source.source_formats.map((f) => <Tag key={f}>{t(`modelSource.format.${f}`)}</Tag>)}
            <div className="_memory-ms-help">{t('subscriptionPool.source.formatFixed')}</div>
          </div>
          <div className="_memory-pool-source-label">{t('modelProvider.form.sourceAgents')}</div>
          <div>
            <SourceAgentsTable
              options={AGENT_OPTIONS}
              selected={source.source_agents}
              readOnly={readOnly || busy}
              sourceName={source.source_name}
              enabledModelCount={countEnabled(source.source_models)}
              onToggle={(agent, on) => void saveAgents(toggleInList(source.source_agents, agent, on))}
            />
          </div>
          <div className="_memory-pool-source-label">{t('modelProvider.form.models')}</div>
          <div>
            <div className="_memory-ms-row" style={{ marginBottom: 8 }}>
              {!readOnly && (
                <Button type="weak" loading={refreshing} disabled={refreshing} onClick={() => void refreshModels()}>
                  {t('modelProvider.form.refresh')}
                </Button>
              )}
              <span className="_memory-ms-weak">
                {source.source_models_fetched_at
                  ? t('subscriptionPool.source.fetchedAt', { time: formatFetchedAt(source.source_models_fetched_at) })
                  : t('modelProvider.source.notFetched')}
              </span>
            </div>
            {source.source_models_error && (
              <Alert type="warning" style={{ marginBottom: 8, maxWidth: 760 }}>
                {t('modelProvider.form.lastError')} {source.source_models_error}
              </Alert>
            )}
            <SourceModelTable
              models={source.source_models}
              sourceName={source.source_name}
              kind="switch"
              readOnly={readOnly}
              busy={busy}
              dimmed={off}
              onChange={(c) => void writeModels(c)}
            />
          </div>
          <div className="_memory-pool-source-label">{t('subscriptionPool.source.state')}</div>
          <div>
            <Tag theme={source.source_active ? 'success' : 'default'}>
              {t(source.source_active ? 'subscriptionPool.source.on' : 'subscriptionPool.source.off')}
            </Tag>{' '}
            <span className="_memory-ms-weak">{t('subscriptionPool.source.followsPool')}</span>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Card className="_memory-pool-source-card">{head}</Card>
      {groupId && (
        <div>
          <Button type="weak" onClick={() => setShowPreview((v) => !v)}>
            {t(showPreview ? 'subscriptionPool.source.hidePreview' : 'subscriptionPool.source.showPreview')}
          </Button>
        </div>
      )}
      {showPreview && <ClientPreview refreshKey={previewKey} />}
    </>
  );
}
