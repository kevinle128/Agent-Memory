/**
 * SelectedModelsModal — picks which models of one source clients can call as `<source>/<model>`.
 * Opens from the Subscription Pool tab and the Model Provider tab. It holds no model state: it
 * writes a change, asks the page to reload, and shows the models the page passes back in.
 * Members can read the list but every control is locked.
 */
import './style.css';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Modal } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import { modelProvidersApi, type SourceModel } from '@/lib/api/model-providers';
import { formatFetchedAt } from '@/lib/model-source';
import { sourceErrorMessage } from '@/lib/source-error';
import { SourceModelTable, type ModelChange } from './SourceModelTable';

export interface SelectedModelsSource {
  groupId: string;
  sourceName: string;
  kind: 'subscription' | 'api';
  models: readonly SourceModel[];
  fetchedAt: string | null;
  fetchError: string | null;
  /** The source is off, so its models are hidden from clients now. */
  off: boolean;
}

interface Props {
  source: SelectedModelsSource;
  readOnly: boolean;
  /** Reload the page data after a write. */
  onChanged: () => Promise<void>;
  onClose: () => void;
}

export function SelectedModelsModal({ source, readOnly, onChanged, onClose }: Props) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  function fail(e: unknown) {
    const message = sourceErrorMessage(e);
    if (message) tea.notify.error(message);
    else tea.notify.error(e);
  }

  async function write(changes: ModelChange[]) {
    if (changes.length === 0 || busy) return;
    setBusy(true);
    try {
      await modelProvidersApi.updateModels(source.groupId, changes);
      await onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await modelProvidersApi.refresh(source.groupId);
      if (res.source_models_error) tea.notify.warning(t('modelProvider.toast.fetchFailed'));
      else tea.notify.success(t('modelProvider.toast.fetched'));
      await onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Modal visible size="l" caption={t('selectedModels.title', { name: source.sourceName })} onClose={onClose}>
      <Modal.Body>
        <div className="_memory-ms-help" style={{ marginTop: 0, marginBottom: 8 }}>
          {t(source.kind === 'subscription' ? 'selectedModels.hint.sub' : 'selectedModels.hint.api', { name: source.sourceName })}{' '}
          {source.fetchedAt ? t('selectedModels.fetchedAt', { time: formatFetchedAt(source.fetchedAt) }) : t('modelProvider.source.notFetched')}
        </div>
        {source.off && (
          <Alert type="warning" style={{ marginBottom: 8 }}>
            {t('selectedModels.off', { name: source.sourceName })}
          </Alert>
        )}
        {source.fetchError && (
          <Alert type="warning" style={{ marginBottom: 8 }}>
            {t('modelProvider.form.lastError')} {source.fetchError}
          </Alert>
        )}
        <SourceModelTable
          models={source.models}
          sourceName={source.sourceName}
          readOnly={readOnly}
          busy={busy}
          dimmed={source.off}
          onChange={(c) => void write(c)}
        />
      </Modal.Body>
      <Modal.Footer>
        {!readOnly && (
          <Button type="weak" loading={refreshing} disabled={refreshing || busy} onClick={() => void refresh()}>
            {t('modelProvider.form.refresh')}
          </Button>
        )}
        <Button type="primary" onClick={onClose}>{t('selectedModels.done')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
