/**
 * DeleteGroupDialog — confirms removing an API-key model source.
 */
import { useTranslation } from 'react-i18next';
import { Button, Modal, Text } from 'tea-component';
import type { ProviderGroup } from '@/lib/api/model-providers';

interface Props {
  group: ProviderGroup;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function DeleteGroupDialog({ group, busy, onConfirm, onClose }: Props) {
  const { t } = useTranslation();
  return (
    <Modal visible size="s" caption={t('modelProvider.delete.title')} onClose={onClose} disableEscape={busy}>
      <Modal.Body>
        <p><b>{t('modelProvider.delete.name', { name: group.source_name || group.name })}</b> {t('modelProvider.delete.keyGone')}</p>
        <Text theme="weak" parent="p">{t('modelProvider.delete.note')}</Text>
      </Modal.Body>
      <Modal.Footer>
        <Button type="error" loading={busy} disabled={busy} onClick={onConfirm}>
          {t('modelProvider.delete.ok')}
        </Button>
        <Button disabled={busy} onClick={onClose}>{t('modelProvider.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
