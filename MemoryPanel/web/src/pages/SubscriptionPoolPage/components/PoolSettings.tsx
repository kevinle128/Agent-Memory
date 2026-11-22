/**
 * PoolSettings — start threshold for new accounts (System Admin only), usage-check info and "Check all now".
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, InputNumber, Text } from 'tea-component';
import i18n from '@/i18n';
import { formatClock, isValidThreshold, MAX_THRESHOLD_PCT, MIN_THRESHOLD_PCT } from '@/lib/subscription-pool-display';

interface Props {
  /** The user cannot manage the pool: no check-all button. */
  readOnly: boolean;
  /** Only a System Admin sees and sets the start threshold. */
  canSetStartThreshold: boolean;
  startThresholdPct: number;
  /** Newest usage update across the accounts, epoch ms. Null when there is none. */
  lastUpdate: number | null;
  saving: boolean;
  checking: boolean;
  onSave: (thresholdPct: number) => void;
  onCheckAll: () => void;
}

export function PoolSettings({ readOnly, canSetStartThreshold, startThresholdPct, lastUpdate, saving, checking, onSave, onCheckAll }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<number>(startThresholdPct);
  useEffect(() => setDraft(startThresholdPct), [startThresholdPct]);

  const valid = isValidThreshold(draft);
  return (
    <Card>
      <Card.Body title={t('subscriptionPool.settings.title')}>
        <div className="_memory-pool-settings">
          {canSetStartThreshold && (
            <>
              <Text theme="label">{t('subscriptionPool.settings.startThreshold')}</Text>
              <div>
                <div className="_memory-pool-row">
                  <InputNumber
                    min={MIN_THRESHOLD_PCT}
                    max={MAX_THRESHOLD_PCT}
                    step={1}
                    hideButton
                    value={draft}
                    onChange={(v) => setDraft(v)}
                  />
                  <Text theme="weak">{t('subscriptionPool.settings.ofEither')}</Text>
                  <Button
                    type="primary"
                    disabled={!valid || draft === startThresholdPct}
                    loading={saving}
                    onClick={() => onSave(draft)}
                  >
                    {t('subscriptionPool.settings.save')}
                  </Button>
                  {!valid && <Text theme="danger">{t('subscriptionPool.settings.invalid')}</Text>}
                </div>
                <Text theme="weak" parent="div">{t('subscriptionPool.settings.startThresholdNote')}</Text>
              </div>
            </>
          )}

          <Text theme="label">{t('subscriptionPool.settings.usageCheck')}</Text>
          <div className="_memory-pool-row">
            <Text>{t('subscriptionPool.settings.usageCheckInfo')}</Text>
            {lastUpdate !== null && (
              <Text theme="weak">
                {t('subscriptionPool.settings.lastUpdate', { time: formatClock(lastUpdate, { locale: i18n.language }) })}
              </Text>
            )}
            {!readOnly && <Button loading={checking} onClick={onCheckAll}>
              {t('subscriptionPool.settings.checkAll')}
            </Button>}
          </div>

          <Text theme="label">{t('subscriptionPool.settings.allExhausted')}</Text>
          <Text theme="weak">{t('subscriptionPool.settings.allExhaustedInfo')}</Text>
        </div>
      </Card.Body>
    </Card>
  );
}
