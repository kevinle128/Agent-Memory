/**
 * ModelProviderPage — custom upstream groups, which are the API-key model sources.
 *
 * Everyone signed in can read the groups (the read action has no key field). Only a System Admin
 * can create, edit, delete or tick models; the kernel checks the role on every write. Subscription
 * sources are edited on the Subscription Pool page.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, StatusTip, Tabs, Tag, Text, H3 } from 'tea-component';
import { useAuthStore } from '@/stores/auth';
import { isGlobalAdmin } from '@/services';
import { tea } from '@/lib/tea-bridge';
import { modelProvidersApi, type ProviderGroup } from '@/lib/api/model-providers';
import { countEnabled } from '@/lib/model-source';
import { sourceErrorCode, sourceErrorMessage, STALE_SOURCE_CODES } from '@/lib/source-error';
import { ClientPreview } from '@/components/model-source/ClientPreview';
import { useProviderGroups } from './use-provider-groups';
import { ProviderTable } from './components/ProviderTable';
import { ProviderForm } from './components/ProviderForm';
import { DeleteGroupDialog } from './components/DeleteGroupDialog';
import './style.css';

type View = { kind: 'list' } | { kind: 'preview' } | { kind: 'form'; groupId: string | null; attach: boolean; seq: number };

export function ModelProviderPage() {
  const { auth } = useAuthStore();
  if (!auth) return null;
  return <ModelProviderContent />;
}

function ModelProviderContent() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { auth } = useAuthStore();
  const readOnly = !auth || !isGlobalAdmin(auth.user, auth.isAdmin);
  const state = useProviderGroups();
  const { groups, pools, loading, error, poolAgents, takenNames, reload } = state;
  const [view, setView] = useState<View>({ kind: 'list' });
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<ProviderGroup | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  // Bumped after every write so the preview reloads its own data.
  const [previewKey, setPreviewKey] = useState(0);

  function reportError(e: unknown) {
    const message = sourceErrorMessage(e);
    if (message) tea.notify.error(message);
    else tea.notify.error(e);
    const code = sourceErrorCode(e);
    if (code && STALE_SOURCE_CODES.has(code)) void reload();
  }

  async function withBusy(id: string, run: () => Promise<void>) {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await run();
    } catch (e) {
      reportError(e);
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const toggleAgents = (g: ProviderGroup, enabled: boolean) =>
    withBusy(g.group_id, async () => {
      await modelProvidersApi.toggle(g.group_id, enabled, g.version);
      tea.notify.success(t(enabled ? 'modelProvider.toast.agentsOn' : 'modelProvider.toast.agentsOff', { name: g.name }));
      await reload();
      setPreviewKey((k) => k + 1);
    });

  const toggleSource = (g: ProviderGroup, enabled: boolean) =>
    withBusy(g.group_id, async () => {
      await modelProvidersApi.update({ group_id: g.group_id, expected_version: g.version, source_enabled: enabled });
      tea.notify.success(t(enabled ? 'modelProvider.toast.sourceOn' : 'modelProvider.toast.sourceOff', { name: g.source_name }));
      await reload();
      setPreviewKey((k) => k + 1);
    });

  async function confirmDelete() {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await modelProvidersApi.remove(deleting.group_id);
      tea.notify.success(t('modelProvider.toast.deleted', { name: deleting.name }));
      setDeleting(null);
      await reload();
      setPreviewKey((k) => k + 1);
    } catch (e) {
      reportError(e);
      setDeleting(null);
    } finally {
      setDeletingBusy(false);
    }
  }

  async function onSaved(groupId: string, created: boolean) {
    await reload();
    setPreviewKey((k) => k + 1);
    setView((v) => ({ kind: 'form', groupId, attach: false, seq: (v.kind === 'form' ? v.seq : 0) + 1 }));
    void created;
  }

  if (view.kind === 'form') {
    const group = view.groupId ? groups.find((g) => g.group_id === view.groupId) ?? null : null;
    if (view.groupId && !group) {
      // The group is gone (deleted elsewhere): back to the list.
      return (
        <div className="_memory-mp-body">
          <Alert type="warning">{t('modelProvider.gone')}</Alert>
          <Button onClick={() => setView({ kind: 'list' })}>{t('modelProvider.back')}</Button>
        </div>
      );
    }
    return (
      <div className="_memory-mp-body">
        <Card>
          <Card.Body>
            <ProviderForm
              key={`${view.groupId ?? 'new'}:${view.seq}`}
              mode={group ? 'edit' : 'add'}
              group={group}
              attach={view.attach}
              readOnly={readOnly}
              groups={groups}
              poolAgents={poolAgents}
              takenNames={takenNames(group?.group_id)}
              onBack={() => {
                setView({ kind: 'list' });
                void reload();
              }}
              onSaved={(id, created) => void onSaved(id, created)}
              onChanged={() => {
                setPreviewKey((k) => k + 1);
                void reload();
              }}
            />
          </Card.Body>
        </Card>
      </div>
    );
  }

  return (
    <div className="_memory-mp-body">
      <Card>
        <Card.Body>
          <div className="_memory-mp-header">
            <H3>{t('modelProvider.title')}</H3>
            <Tabs
              tabs={[
                { id: 'list', label: t('modelProvider.tab.list') },
                { id: 'preview', label: t('modelProvider.tab.preview') },
              ]}
              activeId={view.kind}
              disableTabScrolling
              onActive={(tab) => setView({ kind: tab.id as 'list' | 'preview' })}
            />
          </div>
          <Text theme="weak" parent="div" style={{ marginTop: 8 }}>
            {t('modelProvider.subtitle', { instance: auth?.instance_name || auth?.instance_id || '' })}
          </Text>
        </Card.Body>
      </Card>

      {readOnly && <Alert type="warning">{t('modelProvider.readOnly')}</Alert>}

      {view.kind === 'preview' ? (
        <ClientPreview refreshKey={previewKey} />
      ) : error && groups.length === 0 ? (
        <Card>
          <Card.Body>
            <StatusTip
              status="error"
              emptyText={t('modelProvider.loadFailed')}
              onRetry={() => void reload()}
              retryText={t('subscriptionPool.retry')}
            />
          </Card.Body>
        </Card>
      ) : (
        <>
          <Alert type="info">{t('modelProvider.twoPaths')}</Alert>
          <Card>
            <Card.Body
              title={t('modelProvider.list.title')}
              subtitle={t('modelProvider.list.subtitle')}
              operation={
                !readOnly && (
                  <Button type="primary" onClick={() => setView({ kind: 'form', groupId: null, attach: false, seq: 0 })}>
                    {t('modelProvider.add')}
                  </Button>
                )
              }
            >
              {loading && groups.length === 0 ? (
                <StatusTip status="loading" />
              ) : (
                <ProviderTable
                  groups={groups}
                  readOnly={readOnly}
                  busyIds={busyIds}
                  onEdit={(g, attach) => setView({ kind: 'form', groupId: g.group_id, attach, seq: 0 })}
                  onDelete={setDeleting}
                  onToggleAgents={(g, v) => void toggleAgents(g, v)}
                  onToggleSource={(g, v) => void toggleSource(g, v)}
                />
              )}
              <div className="_memory-mp-footnote">{t('modelProvider.list.footnote', { count: groups.length })}</div>
            </Card.Body>
          </Card>
          <Card>
            <Card.Body
              title={t('modelProvider.subs.title')}
              subtitle={t('modelProvider.subs.subtitle')}
              operation={<Button onClick={() => navigate('/team/subscription-pool')}>{t('modelProvider.subs.open')}</Button>}
            >
              <div className="_memory-mp-tags">
                {pools.map((p) =>
                  p.source?.source_name ? (
                    <span key={p.provider} className="_memory-mp-sub">
                      <Tag theme="primary">{p.source.source_name}</Tag>
                      <span>
                        {t(`subscriptionPool.agent.${p.provider}`)} · {t('modelProvider.subs.models', { count: countEnabled(p.source.source_models) })} ·{' '}
                        {p.source.source_active ? t('modelProvider.subs.followsPool') : t('modelSource.offByPool')}
                      </span>
                    </span>
                  ) : (
                    <span key={p.provider} className="_memory-mp-sub">
                      <Tag>{t(`subscriptionPool.agent.${p.provider}`)}</Tag>
                      <span className="_memory-mp-weak">{t('modelProvider.subs.none')}</span>
                    </span>
                  ),
                )}
              </div>
            </Card.Body>
          </Card>
        </>
      )}

      {!readOnly && deleting && (
        <DeleteGroupDialog
          group={deleting}
          busy={deletingBusy}
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
