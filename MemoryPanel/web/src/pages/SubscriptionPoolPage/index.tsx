/**
 * SubscriptionPoolPage — subscription account pool status, with System Admin management actions.
 *
 * Claude Code and Codex each have a pool tab. The page only calls Core's public pool actions.
 * Core keeps the login tokens and never returns them.
 */
import { Component, useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, StatusTip } from 'tea-component';
import { useAuthStore } from '@/stores/auth';
import { isGlobalAdmin } from '@/services';
import { tea } from '@/lib/tea-bridge';
import { subscriptionPoolApi, type PoolProvider, type SubscriptionAccount } from '@/lib/api/subscription-pool';
import { accountState, classifyRedeemOutcome } from '@/lib/subscription-pool-display';
import { countAvailable, countEnabled } from '@/lib/model-source';
import { sourceInUseOf } from '@/lib/source-error';
import { clientSourcesApi } from '@/lib/api/client-sources';
import { clientsUsing, type SourceInUse } from '@/lib/client-sources';
import { SelectedModelsModal } from '@/components/model-source/SelectedModelsModal';
import { SourceInUseModal } from '@/components/model-source/SourceInUseModal';
import { usePoolStatus } from './use-pool-status';
import { poolErrorCode, poolErrorMessage } from './pool-errors';
import { PoolHeader } from './components/PoolHeader';
import { PoolSummary } from './components/PoolSummary';
import { PoolSettings } from './components/PoolSettings';
import { AccountTable } from './components/AccountTable';
import { AddAccountDialog } from './components/AddAccountDialog';
import { PoolSwitchConfirmDialog } from './components/PoolSwitchConfirmDialog';
import { DeleteAccountDialog } from './components/DeleteAccountDialog';
import { ResetCreditsDialog } from './components/ResetCreditsDialog';
import './style.css';

/** Pool errors that mean the shown data is stale. */
const STALE_CODES = new Set(['account_not_found', 'version_mismatch']);

export function SubscriptionPoolPage() {
  const { auth } = useAuthStore();
  if (!auth) return null;
  return (
    <SubscriptionPoolBoundary>
      <SubscriptionPoolContent />
    </SubscriptionPoolBoundary>
  );
}

/** Keeps a DOM conflict on this page from replacing the whole app with the router error screen. */
class SubscriptionPoolBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="_memory-pool-body">
          <Alert type="error">
            The account was saved. Reload the page to show it.
          </Alert>
          <Button type="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

function SubscriptionPoolContent() {
  const { t } = useTranslation();
  const { auth } = useAuthStore();
  const readOnly = !auth || !isGlobalAdmin(auth.user, auth.isAdmin);
  const [provider, setProvider] = useState<PoolProvider>('claude');
  const { provider: pool, thresholdPct, loading, error, refresh } = usePoolStatus(provider);

  const [switchTarget, setSwitchTarget] = useState<boolean | null>(null);
  const [switching, setSwitching] = useState(false);
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState<{ reloginName?: string } | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SubscriptionAccount | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [creditsAccountId, setCreditsAccountId] = useState<string | null>(null);
  const [redeemingCreditId, setRedeemingCreditId] = useState<string | null>(null);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [inUse, setInUse] = useState<SourceInUse | null>(null);

  const now = Date.now();
  const accounts = pool?.accounts ?? [];
  const poolEnabled = pool ? pool.enabled : null;

  /** Shows a pool error; refreshes the list when the error means the shown data is stale. */
  const reportError = useCallback(
    (e: unknown) => {
      const message = poolErrorMessage(e);
      if (message) tea.notify.error(message);
      else tea.notify.error(e);
      const code = poolErrorCode(e);
      if (code && STALE_CODES.has(code)) void refresh();
    },
    [refresh],
  );

  const withBusy = useCallback(async (accountId: string, run: () => Promise<void>) => {
    setBusyIds((prev) => new Set(prev).add(accountId));
    try {
      await run();
    } catch (e) {
      reportError(e);
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(accountId);
        return next;
      });
    }
  }, [reportError]);

  async function confirmSwitch() {
    if (switchTarget === null) return;
    setSwitching(true);
    try {
      if (switchTarget) await subscriptionPoolApi.enable(provider);
      else await subscriptionPoolApi.disable(provider);
      tea.notify.success(t(switchTarget ? 'subscriptionPool.toast.poolOn' : 'subscriptionPool.toast.poolOff'));
      setSwitchTarget(null);
      await refresh();
    } catch (e) {
      const blocked = sourceInUseOf(e);
      if (blocked) {
        setSwitchTarget(null);
        setInUse(blocked);
      } else {
        reportError(e);
      }
    } finally {
      setSwitching(false);
    }
  }

  /**
   * Turning the pool off asks Core's client list first, so a pool that clients still use shows the
   * blocking dialog at once. Core refuses the write as well, which covers a stale list.
   */
  async function requestSwitch(next: boolean) {
    const name = pool?.source?.source_name;
    if (!next && name) {
      try {
        const clients = clientsUsing((await clientSourcesApi.list()).agents, name);
        if (clients.length > 0) {
          setInUse({ sourceName: name, clients: clients.map((c) => c.agent) });
          return;
        }
      } catch {
        /* Core still checks when the switch is sent. */
      }
    }
    setSwitchTarget(next);
  }

  async function saveThreshold(value: number) {
    setSavingThreshold(true);
    try {
      await subscriptionPoolApi.updateThreshold(value);
      tea.notify.success(t('subscriptionPool.toast.thresholdSaved'));
      await refresh();
    } catch (e) {
      reportError(e);
    } finally {
      setSavingThreshold(false);
    }
  }

  async function checkAll() {
    setCheckingAll(true);
    try {
      const result = await subscriptionPoolApi.checkAll();
      tea.notify.success(t('subscriptionPool.toast.checkedAll', result));
      await refresh();
    } catch (e) {
      reportError(e);
    } finally {
      setCheckingAll(false);
    }
  }

  const checkAccount = (account: SubscriptionAccount) =>
    withBusy(account.account_id, async () => {
      await subscriptionPoolApi.checkUsage(account.account_id);
      tea.notify.success(t('subscriptionPool.toast.checked', { name: account.display_name }));
      await refresh();
    });

  /** Redeems one credit. The outcome decides the message; only "reset" counts as success. */
  async function redeemCredit(account: SubscriptionAccount, creditId: string, requestId: string) {
    setRedeemingCreditId(creditId);
    try {
      const result = await subscriptionPoolApi.redeemResetCredit({
        account_id: account.account_id,
        credit_id: creditId,
        request_id: requestId,
      });
      const name = account.display_name;
      switch (classifyRedeemOutcome(result.outcome)) {
        case 'success':
          tea.notify.success(t('subscriptionPool.toast.redeemed', { name }));
          break;
        case 'info':
          tea.notify.warning(t('subscriptionPool.toast.redeemNothing', { name }));
          break;
        case 'already':
          tea.notify.warning(t('subscriptionPool.toast.redeemAlready', { name }));
          break;
        default:
          tea.notify.error(result.message || t('subscriptionPool.toast.redeemFailed', { outcome: result.outcome }));
      }
      await refresh();
    } catch (e) {
      reportError(e);
    } finally {
      setRedeemingCreditId(null);
    }
  }

  const toggleEnabled = (account: SubscriptionAccount) =>
    withBusy(account.account_id, async () => {
      const enable = !account.enabled;
      await subscriptionPoolApi.updateAccount({
        account_id: account.account_id,
        enabled: enable,
        expected_version: account.version,
        // A stored "disabled" status would keep the account out of service after the switch is on again.
        ...(enable && account.status === 'disabled' ? { status: 'active' as const } : {}),
      });
      tea.notify.success(t(enable ? 'subscriptionPool.toast.enabled' : 'subscriptionPool.toast.disabled', { name: account.display_name }));
      await refresh();
    });

  async function confirmDelete() {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await subscriptionPoolApi.deleteAccount(deleting.account_id);
      tea.notify.success(t('subscriptionPool.toast.deleted'));
      setDeleting(null);
      await refresh();
    } catch (e) {
      reportError(e);
      setDeleting(null);
    } finally {
      setDeletingBusy(false);
    }
  }

  const creditsAccount = accounts.find((a) => a.account_id === creditsAccountId) ?? null;
  const lastUpdate = accounts.reduce<number | null>(
    (best, a) => (a.usage_updated_at !== null && (best === null || a.usage_updated_at > best) ? a.usage_updated_at : best),
    null,
  );
  const availableCount = pool?.summary.available ?? 0;
  const disabledCount = accounts.filter(
    (a) => accountState(a, { now, threshold: thresholdPct, poolEnabled: poolEnabled === true }) === 'disabled',
  ).length;

  return (
    <div className="_memory-pool-body">
      {savedNotice && (
        <Alert type="success" onClose={() => setSavedNotice(null)}>
          {savedNotice}
        </Alert>
      )}
      <PoolHeader
        readOnly={readOnly}
        provider={provider}
        onProviderChange={setProvider}
        poolEnabled={poolEnabled}
        switchDisabled={switching}
        onToggle={(next) => void requestSwitch(next)}
        instanceName={auth?.instance_name || auth?.instance_id || ''}
      />

      {error && !pool ? (
        <Card>
          <Card.Body>
            <StatusTip
              status="error"
              emptyText={t('subscriptionPool.loadFailed')}
              onRetry={() => void refresh()}
              retryText={t('subscriptionPool.retry')}
            />
          </Card.Body>
        </Card>
      ) : (
        <>
          {pool && !pool.enabled && (
            <Alert type="info">
              {t('subscriptionPool.offNotice', { agent: t(`subscriptionPool.agent.${provider}`) })}
            </Alert>
          )}
          <Alert type="warning">{t(`subscriptionPool.fallbackWarn.${provider}`)}</Alert>

          {pool && <PoolSummary status={pool} thresholdPct={thresholdPct} now={now} />}

          <PoolSettings
            readOnly={readOnly}
            thresholdPct={thresholdPct}
            lastUpdate={lastUpdate}
            saving={savingThreshold}
            checking={checkingAll}
            onSave={(v) => void saveThreshold(v)}
            onCheckAll={() => void checkAll()}
          />

          <Card>
            <Card.Body
              title={t('subscriptionPool.accounts.title')}
              subtitle={t('subscriptionPool.accounts.tokensHidden')}
              operation={
                <>
                  <Button disabled={!pool?.group_id || !pool.source?.source_name} onClick={() => setModelsOpen(true)}>
                    {t('selectedModels.button')}{' '}
                    <span className="_memory-ms-weak">
                      {pool?.source ? `${countEnabled(pool.source.source_models)}/${countAvailable(pool.source.source_models)}` : '–'}
                    </span>
                  </Button>
                  {!readOnly && (
                    <Button type="primary" onClick={() => setAdding({})}>
                      {t('subscriptionPool.accounts.add')}
                    </Button>
                  )}
                </>
              }
            >
              <AccountTable
                readOnly={readOnly}
                accounts={accounts}
                poolEnabled={poolEnabled === true}
                thresholdPct={thresholdPct}
                now={now}
                loading={loading}
                busyIds={busyIds}
                onCheck={(a) => void checkAccount(a)}
                onToggleEnabled={(a) => void toggleEnabled(a)}
                onDelete={setDeleting}
                onRelogin={(a) => setAdding({ reloginName: a.display_name })}
                onShowCredits={(a) => setCreditsAccountId(a.account_id)}
                emptyText={t(`subscriptionPool.accounts.empty.${provider}`)}
              />
              {accounts.length > 0 && (
                <div className="_memory-pool-footnote">
                  {t('subscriptionPool.summary.availableHint')}{' '}
                  {t('subscriptionPool.accounts.summary', { total: accounts.length, disabled: disabledCount })}
                </div>
              )}
            </Card.Body>
          </Card>
        </>
      )}

      {!readOnly && switchTarget !== null && (
        <PoolSwitchConfirmDialog
          provider={provider}
          turnOn={switchTarget}
          accountCount={accounts.length}
          availableCount={availableCount}
          activeSessions={pool?.summary.active_sessions ?? 0}
          busy={switching}
          onConfirm={() => void confirmSwitch()}
          onClose={() => setSwitchTarget(null)}
        />
      )}
      {modelsOpen && pool?.group_id && pool.source?.source_name && (
        <SelectedModelsModal
          source={{
            groupId: pool.group_id,
            sourceName: pool.source.source_name,
            kind: 'subscription',
            models: pool.source.source_models,
            fetchedAt: pool.source.source_models_fetched_at,
            fetchError: pool.source.source_models_error,
            off: !pool.source.source_active,
          }}
          readOnly={readOnly}
          onChanged={refresh}
          onClose={() => setModelsOpen(false)}
        />
      )}
      {inUse && <SourceInUseModal inUse={inUse} action="pool" onClose={() => setInUse(null)} />}
      {!readOnly && adding && (
        <AddAccountDialog
          provider={provider}
          reloginName={adding.reloginName}
          onClose={() => setAdding(null)}
          onDone={({ name, created }) => {
            setAdding(null);
            setSavedNotice(t(created ? 'subscriptionPool.toast.added' : 'subscriptionPool.toast.reloggedIn', { name }));
            void refresh();
          }}
        />
      )}
      {creditsAccount && (
        <ResetCreditsDialog
          account={creditsAccount}
          now={now}
          canRedeem={!readOnly}
          busyCreditId={redeemingCreditId}
          onRedeem={(creditId, requestId) => redeemCredit(creditsAccount, creditId, requestId)}
          onClose={() => setCreditsAccountId(null)}
        />
      )}
      {!readOnly && deleting && (
        <DeleteAccountDialog
          accountName={deleting.display_name}
          busy={deletingBusy}
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
