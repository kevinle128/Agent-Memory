/**
 * DeleteGroupDialog — confirms removing a custom group. Names the agents and source clients it affects.
 */
import { useTranslation } from 'react-i18next';
import { Button, Modal, Tag, Text } from 'tea-component';
import { countEnabled } from '@/lib/model-source';
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
        <p><b>{t('modelProvider.delete.name', { name: group.name })}</b> {t('modelProvider.delete.keyGone')}</p>
        {group.agents.length > 0 && (
          <p>
            {t('modelProvider.delete.agents')}{' '}
            {group.agents.map((a) => <Tag key={a} theme="primary">{a}</Tag>)}
          </p>
        )}
        {group.source_name && (
          <p>
            {t('modelProvider.delete.source', { count: countEnabled(group.source_models), name: group.source_name })}{' '}
            {group.source_agents.map((a) => <Tag key={a} theme="primary">{a}</Tag>)}
          </p>
        )}
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
