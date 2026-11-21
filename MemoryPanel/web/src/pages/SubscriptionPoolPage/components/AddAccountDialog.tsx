/**
 * AddAccountDialog — Codex login in two steps, also used for re-login of an account.
 *
 * Step 1 opens the authorize URL in a new tab. After the login the browser lands on a
 * localhost page that fails to load; the admin copies the full URL from the address bar and
 * pastes it in step 2. The login state lives in Core for a limited time, so an expired or
 * mismatched state asks the admin to start again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Input, InputNumber } from 'tea-component';
import i18n from '@/i18n';
import { tea } from '@/lib/tea-bridge';
import { copyToClipboard } from '@/pages/ChatMemoryPage/utils/memory-utils';
import { subscriptionPoolApi, type OAuthStart, type PoolProvider } from '@/lib/api/subscription-pool';
import { addAccountKeyPrefix, formatClock, isValidThreshold, MAX_THRESHOLD_PCT, MIN_THRESHOLD_PCT, oauthCompleteInput } from '@/lib/subscription-pool-display';
import { poolErrorCode, poolErrorMessage } from '../pool-errors';

interface Props {
  teamId: string;
  provider: PoolProvider;
  /** Start value for a new account. An empty threshold field uses it. */
  startThresholdPct: number;
  /** Set for a re-login: the name is fixed and the title shows it. */
  reloginName?: string;
  onClose: () => void;
  /** Called after the account was saved. `created` is false when an existing account got new tokens. */
  onDone: (result: { name: string; created: boolean }) => void;
}

/** Errors that mean the login has to start again. */
const RESTART_CODES = new Set(['INVALID_OAUTH_STATE', 'OAUTH_EXCHANGE_FAILED']);

export function AddAccountDialog({ teamId, provider, startThresholdPct, reloginName, onClose, onDone }: Props) {
  const { t } = useTranslation();
  const [start, setStart] = useState<OAuthStart | null>(null);
  const [starting, setStarting] = useState(true);
  const [displayName, setDisplayName] = useState('');
  // Null means the field is empty, so the account gets the start value.
  const [threshold, setThreshold] = useState<number | null>(null);
  const [pasted, setPasted] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [needRestart, setNeedRestart] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);

  const begin = useCallback(async () => {
    setStarting(true);
    setNeedRestart(false);
    setInlineError(null);
    setPasted('');
    try {
      const next = await subscriptionPoolApi.oauthStart(teamId, provider);
      if (alive.current) setStart(next);
    } catch (e) {
      if (!alive.current) return;
      setStart(null);
      setInlineError(poolErrorMessage(e) ?? (e instanceof Error ? e.message : String(e)));
    } finally {
      if (alive.current) setStarting(false);
    }
  }, [teamId, provider]);

  useEffect(() => {
    alive.current = true;
    void begin();
    return () => {
      alive.current = false;
    };
  }, [begin]);

  const input = oauthCompleteInput(pasted);
  const thresholdInvalid = threshold !== null && !isValidThreshold(threshold);

  async function submit() {
    if (!start || !input || thresholdInvalid) return;
    setSubmitting(true);
    setInlineError(null);
    try {
      const name = displayName.trim();
      const account = await subscriptionPoolApi.oauthComplete(teamId, {
        provider,
        state: start.state,
        ...input,
        ...(name && !reloginName ? { display_name: name } : {}),
        ...(threshold !== null && !reloginName ? { threshold_pct: threshold } : {}),
      });
      onDone({ name: account.display_name, created: account.created });
    } catch (e) {
      if (!alive.current) return;
      const code = poolErrorCode(e);
      setInlineError(poolErrorMessage(e) ?? (e instanceof Error ? e.message : String(e)));
      if (code && RESTART_CODES.has(code)) setNeedRestart(true);
      else if (!code) tea.notify.error(e);
    } finally {
      if (alive.current) setSubmitting(false);
    }
  }

  const addKey = (name: string) => t(`${addAccountKeyPrefix(provider)}.${name}`);

  const openLogin = () => {
    if (start) window.open(start.authorize_url, '_blank', 'noopener,noreferrer');
  };

  const copyAuthorizeUrl = () => {
    if (!start) return;
    void copyToClipboard(start.authorize_url).then((ok) => {
      if (!alive.current) return;
      if (ok) {
        setCopied(true);
        window.setTimeout(() => {
          if (alive.current) setCopied(false);
        }, 1500);
      } else {
        setInlineError(t('subscriptionPool.add.copyFailed'));
      }
    });
  };

  return (
    <div className="_memory-pool-mask" role="presentation" translate="no">
      <div className="_memory-pool-dialog" role="dialog" aria-modal="true">
        <h3 className="_memory-pool-dialog-title">
          {reloginName ? t('subscriptionPool.relogin.title', { name: reloginName }) : addKey('title')}
        </h3>
        <Alert type="info">{addKey('redirectNote')}</Alert>
        <Form style={{ marginTop: 12 }}>
          {!reloginName && (
            <Form.Item label={t('subscriptionPool.add.displayName')}>
              <Input
                value={displayName}
                onChange={setDisplayName}
                placeholder={t('subscriptionPool.add.displayName.placeholder')}
                size="full"
              />
            </Form.Item>
          )}
          {!reloginName && (
            <Form.Item
              label={t('subscriptionPool.add.threshold')}
              extra={thresholdInvalid ? t('subscriptionPool.settings.invalid') : t('subscriptionPool.add.threshold.hint', { pct: startThresholdPct })}
            >
              <InputNumber
                min={MIN_THRESHOLD_PCT}
                max={MAX_THRESHOLD_PCT}
                step={1}
                hideButton
                value={threshold ?? undefined}
                onChange={(v) => setThreshold(Number.isFinite(v) ? v : null)}
              />
            </Form.Item>
          )}
          <Form.Item
            label={addKey('step1')}
            extra={
              start
                ? t('subscriptionPool.add.expires', { time: formatClock(start.expires_at, { locale: i18n.language }) })
                : starting
                  ? t('subscriptionPool.add.starting')
                  : undefined
            }
          >
            <div className="_memory-pool-row">
              <Input value={start?.authorize_url ?? ''} readonly size="full" />
              <Button disabled={!start} onClick={copyAuthorizeUrl}>
                {copied ? t('subscriptionPool.add.copied') : t('subscriptionPool.add.copy')}
              </Button>
              <Button type="primary" disabled={!start} onClick={openLogin}>
                {t('subscriptionPool.add.open')} ↗
              </Button>
            </div>
          </Form.Item>
          <Form.Item label={addKey('step2')}>
            <Input.TextArea
              value={pasted}
              onChange={setPasted}
              placeholder={addKey('pastePlaceholder')}
              size="full"
              rows={3}
              disabled={!start || submitting}
            />
          </Form.Item>
        </Form>
        {inlineError && (
          <Alert type="error" style={{ marginBottom: 8 }}>
            {inlineError}
          </Alert>
        )}
        <Alert type="warning">{addKey('terms')}</Alert>
        <div className="_memory-pool-dialog-footer">
          {needRestart || (start === null && !starting) ? (
            <Button type="primary" loading={starting} onClick={() => void begin()}>
              {t('subscriptionPool.add.restart')}
            </Button>
          ) : (
            <Button type="primary" loading={submitting} disabled={!start || !input || submitting || thresholdInvalid} onClick={() => void submit()}>
              {t('subscriptionPool.add.submit')}
            </Button>
          )}
          <Button disabled={submitting} onClick={onClose}>
            {t('subscriptionPool.add.cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}
