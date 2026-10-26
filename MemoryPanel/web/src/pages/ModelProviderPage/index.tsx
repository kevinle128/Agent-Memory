/**
 * ModelProviderPage — API-key model sources (custom upstream groups).
 *
 * Everyone signed in can read the sources (the read action has no key field). Only a System Admin
 * can add, turn off, delete or pick models; the kernel checks the role on every write. Which
 * clients use a source is chosen on the API Key page. Subscription sources live on the
 * Subscription Pool page.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, StatusTip } from 'tea-component';
import { useAuthStore } from '@/stores/auth';
import { isGlobalAdmin } from '@/services';
import { tea } from '@/lib/tea-bridge';
import { modelProvidersApi, type ProviderGroup } from '@/lib/api/model-providers';
import type { SourceInUse } from '@/lib/client-sources';
import { sourceErrorCode, sourceErrorMessage, sourceInUseOf, STALE_SOURCE_CODES } from '@/lib/source-error';
import { SelectedModelsModal } from '@/components/model-source/SelectedModelsModal';
import { SourceInUseModal, type InUseAction } from '@/components/model-source/SourceInUseModal';
import { useProviderGroups } from './use-provider-groups';
import { ProviderTable } from './components/ProviderTable';
import { AddProviderModal } from './components/AddProviderModal';
import { DeleteGroupDialog } from './components/DeleteGroupDialog';
import './style.css';

export function ModelProviderPage() {
  const { auth } = useAuthStore();
  if (!auth) return null;
  return <ModelProviderContent />;
}

function ModelProviderContent() {
  const { t } = useTranslation();
  const { auth } = useAuthStore();
  const readOnly = !auth || !isGlobalAdmin(auth.user, auth.isAdmin);
  const { groups, loading, error, takenNames, reload } = useProviderGroups();
  // Legacy groups without a source name are not model sources and stay out of this table.
  const sources = groups.filter((g) => g.source_name && g.mode === 'custom_unified');
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ProviderGroup | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [modelsOf, setModelsOf] = useState<string | null>(null);
  const [inUse, setInUse] = useState<{ info: SourceInUse; action: InUseAction } | null>(null);

  function reportError(e: unknown, action: InUseAction) {
    const blocked = sourceInUseOf(e);
    if (blocked) {
      setInUse({ info: blocked, action });
      return;
    }
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
      reportError(e, 'off');
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  /** One write sets the group switch and the source switch together, so the row has one status. */
  const toggle = (g: ProviderGroup, on: boolean) =>
    withBusy(g.group_id, async () => {
      await modelProvidersApi.update({
        group_id: g.group_id,
        expected_version: g.version,
        enabled: on,
        source_enabled: on,
      });
      tea.notify.success(t(on ? 'modelProvider.toast.sourceOn' : 'modelProvider.toast.sourceOff', { name: g.source_name }));
      await reload();
    });

  async function confirmDelete() {
    if (!deleting) return;
    const target = deleting;
    setDeletingBusy(true);
    try {
      await modelProvidersApi.remove(target.group_id);
      tea.notify.success(t('modelProvider.toast.deleted', { name: target.source_name }));
      setDeleting(null);
      await reload();
    } catch (e) {
      setDeleting(null);
      reportError(e, 'delete');
    } finally {
      setDeletingBusy(false);
    }
  }

  const modelsGroup = modelsOf ? sources.find((g) => g.group_id === modelsOf) ?? null : null;

  return (
    <div className="_memory-mp-body">
      {readOnly && <Alert type="warning">{t('modelProvider.readOnly')}</Alert>}
      {error && groups.length === 0 ? (
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
        <Card>
          <Card.Body
            title={t('modelProvider.list.title')}
            subtitle={t('modelProvider.list.subtitle')}
            operation={
              !readOnly && (
                <Button type="primary" onClick={() => setAdding(true)}>
                  {t('modelProvider.add')}
                </Button>
              )
            }
          >
            {loading && groups.length === 0 ? (
              <StatusTip status="loading" />
            ) : (
              <ProviderTable
                groups={sources}
                readOnly={readOnly}
                busyIds={busyIds}
                onModels={(g) => setModelsOf(g.group_id)}
                onDelete={setDeleting}
                onToggle={(g, on) => void toggle(g, on)}
              />
            )}
          </Card.Body>
        </Card>
      )}

      {!readOnly && adding && (
        <AddProviderModal
          takenNames={takenNames()}
          onClose={() => setAdding(false)}
          onCreated={async () => {
            setAdding(false);
            await reload();
          }}
        />
      )}
      {modelsGroup && (
        <SelectedModelsModal
          source={{
            groupId: modelsGroup.group_id,
            sourceName: modelsGroup.source_name,
            kind: 'api',
            models: modelsGroup.source_models,
            fetchedAt: modelsGroup.source_models_fetched_at,
            fetchError: modelsGroup.source_models_error,
            off: !(modelsGroup.enabled && modelsGroup.source_enabled),
          }}
          readOnly={readOnly}
          onChanged={async () => {
            await reload();
          }}
          onClose={() => setModelsOf(null)}
        />
      )}
      {!readOnly && deleting && (
        <DeleteGroupDialog
          group={deleting}
          busy={deletingBusy}
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleting(null)}
        />
      )}
      {inUse && <SourceInUseModal inUse={inUse.info} action={inUse.action} onClose={() => setInUse(null)} />}
    </div>
  );
}
