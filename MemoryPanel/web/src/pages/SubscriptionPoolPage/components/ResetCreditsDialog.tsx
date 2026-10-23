/**
 * ResetCreditsDialog — lists every reset credit of one account. A System Admin can redeem one
 * credit after a confirmation. The request id is made once per confirmed click, so a retry of
 * the same click cannot spend a second credit.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Modal, Tag, Text } from 'tea-component';
import i18n from '@/i18n';
import type { SubscriptionAccount } from '@/lib/api/subscription-pool';
import { describeCreditExpiry, type PoolResetCredit } from '@/lib/subscription-pool-display';

interface Props {
  account: SubscriptionAccount;
  now: number;
  /** Only a System Admin can redeem. */
  canRedeem: boolean;
  /** Credit id that has a running redeem call, or null. */
  busyCreditId: string | null;
  onRedeem: (creditId: string, requestId: string) => Promise<void>;
  onClose: () => void;
}

interface Pending {
  creditId: string;
  requestId: string;
}

export function ResetCreditsDialog({ account, now, canRedeem, busyCreditId, onRedeem, onClose }: Props) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Pending | null>(null);
  const data = account.reset_credits;
  const credits = data?.credits ?? [];
  const busy = busyCreditId !== null;

  async function confirm() {
    if (!pending) return;
    try {
      await onRedeem(pending.creditId, pending.requestId);
    } finally {
      setPending(null);
    }
  }

  function renderCredit(credit: PoolResetCredit) {
    const expiry = describeCreditExpiry(credit.expires_at, now, { locale: i18n.language });
    const confirming = pending?.creditId === credit.id;
    const inFlight = busyCreditId === credit.id;
    return (
      <div className="_memory-pool-credit" key={credit.id}>
        <div className="_memory-pool-credit-main">
          <b>{credit.label || credit.id}</b>
          <div className="_memory-pool-small">
            {credit.total !== null
              ? t('subscriptionPool.credits.remainingOf', { remaining: credit.remaining, total: credit.total })
              : t('subscriptionPool.credits.remaining', { remaining: credit.remaining })}
          </div>
          <div className="_memory-pool-small">
            {expiry.at === null ? (
              <Text theme="weak">{t('subscriptionPool.credits.noExpiry')}</Text>
            ) : expiry.expired ? (
              <Text theme="danger">{t('subscriptionPool.credits.expired', { at: expiry.at })}</Text>
            ) : (
              <Text theme={expiry.soon ? 'warning' : undefined}>
                {t('subscriptionPool.credits.expiresAt', { at: expiry.at, remaining: expiry.remaining })}
              </Text>
            )}
          </div>
          <div className="_memory-pool-small">
            {credit.usable_now === true && <Tag theme="success">{t('subscriptionPool.credits.usable')}</Tag>}
            {credit.usable_now === false && <Tag theme="warning">{t('subscriptionPool.credits.notUsable')}</Tag>}
            {credit.unavailable_reason && (
              <Text theme="weak"> {credit.unavailable_reason}</Text>
            )}
          </div>
        </div>
        {canRedeem && (
          <div className="_memory-pool-credit-action">
            <Button
              type="primary"
              loading={inFlight}
              disabled={busy || (pending !== null && !confirming)}
              onClick={() => setPending({ creditId: credit.id, requestId: crypto.randomUUID() })}
            >
              {t('subscriptionPool.credits.redeem')}
            </Button>
          </div>
        )}
        {canRedeem && confirming && (
          <div className="_memory-pool-credit-confirm">
            <Alert type="warning">
              <div>{t('subscriptionPool.credits.confirmIrreversible')}</div>
              <div>{t('subscriptionPool.credits.confirmEffect')}</div>
              {account.provider === 'codex' && <div>{t('subscriptionPool.credits.confirmCodex')}</div>}
              {credit.usable_now === false && <div>{t('subscriptionPool.credits.confirmUnusable')}</div>}
            </Alert>
            <div className="_memory-pool-actions">
              <Button type="error" loading={inFlight} disabled={busy} onClick={() => void confirm()}>
                {t('subscriptionPool.credits.confirmOk')}
              </Button>
              <Button disabled={busy} onClick={() => setPending(null)}>
                {t('subscriptionPool.dialog.cancel')}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <Modal
      visible
      size="m"
      caption={t('subscriptionPool.credits.title', { name: account.display_name })}
      onClose={onClose}
      disableEscape={busy}
    >
      <Modal.Body>
        {credits.length === 0 ? (
          <Text theme="weak">
            {data?.note ? t('subscriptionPool.credits.emptyNote', { note: data.note }) : t('subscriptionPool.credits.empty')}
          </Text>
        ) : (
          credits.map(renderCredit)
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button disabled={busy} onClick={onClose}>
          {t('subscriptionPool.credits.close')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
