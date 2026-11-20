import { useState } from 'react';
import { Button, Form, Input, Modal } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { tea } from '@/lib/tea-bridge';
import { PENDING_CHANGED_EVENT, vtcApi } from '../api';
import type { PendingItem } from '../logic';
import { PersonBlock } from './PersonBlock';
import { isStaleRequestError, reportError } from './report-error';

const REASON_MAX = 500;

export default function RejectDialog({ item, onClose, onDone }: { item: PendingItem; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation('ext-vtc');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    try {
      await vtcApi.reject(item.pending_id, reason);
      tea.notify.success(t('reject.done'));
      window.dispatchEvent(new CustomEvent(PENDING_CHANGED_EVENT));
      onDone();
    } catch (err) {
      reportError(t, err);
      if (isStaleRequestError(err)) onDone();
    } finally {
      setSubmitting(false);
    }
  }

  const guardedClose = () => {
    if (!submitting) onClose();
  };

  return (
    <Modal visible caption={t('reject.title')} size="m" onClose={guardedClose} disableEscape={submitting}>
      <Modal.Body>
        <Form>
          <Form.Item label={t('person.label')}>
            <PersonBlock item={item} />
          </Form.Item>
          <Form.Item label={t('reject.reason')}>
            <div>
              <Input.TextArea
                size="full"
                rows={3}
                maxLength={REASON_MAX}
                value={reason}
                onChange={setReason}
                placeholder={t('reject.reason.placeholder')}
              />
              <div className="_memory-field-hint">{t('reject.note')}</div>
            </div>
          </Form.Item>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void submit()} disabled={submitting} loading={submitting}>
          {t('reject.submit')}
        </Button>
        <Button onClick={guardedClose} disabled={submitting}>
          {t('reject.cancel')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
