/**
 * AccountTable — one row per subscription account with status, two quota meters
 * (threshold mark and reset time in local time), a column with the per-model windows,
 * sessions, last update and actions.
 */
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { Button, InputNumber, StatusTip, Table, Tag, Text, Bubble } from 'tea-component';

const { scrollable } = Table.addons;
import i18n from '@/i18n';
import type { SubscriptionAccount } from '@/lib/api/subscription-pool';
import {
  accountState,
  describeCreditExpiry,
  describeWindow,
  formatClock,
  formatResetAt,
  groupBuckets,
  groupWindows,
  isValidThreshold,
  MAX_THRESHOLD_PCT,
  MIN_THRESHOLD_PCT,
  windowColumns,
  latestObservation,
  nearestExpiringCredit,
  quotaGroupColumns,
  remainingPct,
  supportsResetCredits,
  thresholdMark,
  usageCheckFailing,
  type AccountState,
  type PoolWindow,
} from '@/lib/subscription-pool-display';

interface Props {
  readOnly: boolean;
  accounts: SubscriptionAccount[];
  poolEnabled: boolean;
  now: number;
  loading: boolean;
  /** Account ids with a running action (check, enable/disable). */
  busyIds: ReadonlySet<string>;
  onCheck: (account: SubscriptionAccount) => void;
  onToggleEnabled: (account: SubscriptionAccount) => void;
  /** Save the threshold of one account. Only called with a value from 50 to 100. */
  onSaveThreshold: (account: SubscriptionAccount, thresholdPct: number) => void;
  onDelete: (account: SubscriptionAccount) => void;
  onRelogin: (account: SubscriptionAccount) => void;
  onShowCredits: (account: SubscriptionAccount) => void;
  emptyText: React.ReactNode;
}

const STATE_TAG: Record<AccountState, { theme: 'default' | 'primary' | 'success' | 'warning' | 'error'; mark: string }> = {
  active: { theme: 'success', mark: '●' },
  ready_pool_off: { theme: 'primary', mark: '●' },
  near_limit: { theme: 'warning', mark: '▲' },
  exhausted: { theme: 'error', mark: '■' },
  auth_error: { theme: 'error', mark: '✕' },
  disabled: { theme: 'default', mark: '○' },
};

/** Threshold of one account: an editable number for a manager, plain text for a viewer. */
function ThresholdCell({
  account,
  editable,
  busy,
  onSave,
}: {
  account: SubscriptionAccount;
  editable: boolean;
  busy: boolean;
  onSave: (thresholdPct: number) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<number>(account.threshold_pct);
  useEffect(() => setDraft(account.threshold_pct), [account.threshold_pct, account.version]);
  if (!editable) return <Text>{account.threshold_pct}%</Text>;
  const valid = isValidThreshold(draft);
  return (
    <div>
      <div className="_memory-pool-row">
        <InputNumber
          min={MIN_THRESHOLD_PCT}
          max={MAX_THRESHOLD_PCT}
          step={1}
          hideButton
          disabled={busy}
          value={draft}
          onChange={(v) => setDraft(v)}
        />
        <Text theme="weak">%</Text>
        <Button type="link" disabled={busy || !valid || draft === account.threshold_pct} onClick={() => onSave(draft)}>
          {t('subscriptionPool.settings.save')}
        </Button>
      </div>
      {!valid && <Text theme="danger" parent="div" className="_memory-pool-small">{t('subscriptionPool.settings.invalid')}</Text>}
    </div>
  );
}

function Meter({
  window,
  now,
  thresholdPct,
  showMark,
  label,
  showRemaining = false,
}: {
  window: PoolWindow | null;
  now: number;
  thresholdPct: number;
  showMark: boolean;
  label?: string;
  /** Show the percent left and fill the bar with it, like the AntiGravity app. */
  showRemaining?: boolean;
}) {
  const { t } = useTranslation();
  if (!window) {
    return (
      <div className="_memory-pool-meter">
        <div className="_memory-pool-meter-label">—</div>
        <div className="_memory-pool-bar" />
        <Text theme="weak" className="_memory-pool-small">{t('subscriptionPool.window.noData')}</Text>
      </div>
    );
  }
  const view = describeWindow(window, now, thresholdPct, { locale: i18n.language });
  let note: string;
  if (view.reset) note = t('subscriptionPool.window.hasReset');
  else if (view.resetAt && view.remaining) note = t('subscriptionPool.window.resetsIn', { at: view.resetAt, remaining: view.remaining });
  else note = '';
  return (
    <div className="_memory-pool-meter">
      <div className="_memory-pool-meter-label">
        {label && <span className="_memory-pool-meter-name">{label} </span>}
        {showRemaining ? t('subscriptionPool.window.pctLeft', { pct: remainingPct(view.pct) }) : `${Math.round(view.pct)}%`}
      </div>
      <div className="_memory-pool-bar">
        <i className={`_memory-pool-fill _memory-pool-fill--${view.level}`} style={{ width: `${showRemaining ? 100 - view.pct : view.pct}%` }} />
        {showMark && (
          <span
            className="_memory-pool-mark"
            style={{ left: `${showRemaining ? 100 - thresholdMark(thresholdPct) : thresholdMark(thresholdPct)}%` }}
            title={t('subscriptionPool.window.thresholdTip', { pct: thresholdPct })}
          />
        )}
      </div>
      {note && <Text theme="weak" className="_memory-pool-small">{note}</Text>}
    </div>
  );
}

/** Short label of a window in the model limits column: the model, or the window name for a shared window. */
function windowLabel(window: PoolWindow, t: (key: string) => string): string {
  if (window.model_scope && !window.group_label) return window.model_scope;
  const key = `subscriptionPool.window.name.${window.name}`;
  return i18n.exists(key) ? t(key) : window.name;
}

/** One quota group of an account: its weekly and 5h limits as "% left", with the models they cover. */
function QuotaGroupCell({
  account,
  groupKey,
  now,
  showMark,
}: {
  account: SubscriptionAccount;
  groupKey: string;
  now: number;
  showMark: boolean;
}) {
  const { t } = useTranslation();
  const buckets = groupBuckets(account.usage.windows, groupKey);
  if (buckets.length === 0) return <Text theme="weak">—</Text>;
  const models = buckets.find((w) => w.shared_models && w.shared_models.length > 0)?.shared_models ?? [];
  return (
    <div>
      <div className="_memory-pool-meter-list">
        {buckets.map((window) => (
          <Meter
            key={window.name}
            window={window}
            now={now}
            thresholdPct={account.threshold_pct}
            showMark={showMark}
            showRemaining
            label={windowLabel(window, t)}
          />
        ))}
      </div>
      {models.length > 0 && (
        <Bubble content={models.join(', ')}>
          <Text theme="weak" className="_memory-pool-small">{t('subscriptionPool.group.models', { count: models.length })}</Text>
        </Bubble>
      )}
    </div>
  );
}

function sourceLabel(source: string, t: (key: string) => string): string {
  if (source === 'usage_api') return t('subscriptionPool.source.usage_api');
  if (source === '429') return t('subscriptionPool.source.429');
  return t('subscriptionPool.source.proxy');
}

export function AccountTable({
  readOnly,
  accounts,
  poolEnabled,
  now,
  loading,
  busyIds,
  onCheck,
  onToggleEnabled,
  onSaveThreshold,
  onDelete,
  onRelogin,
  onShowCredits,
  emptyText,
}: Props) {
  const { t } = useTranslation();

  const stateOf = (account: SubscriptionAccount) =>
    accountState(account, { now, threshold: account.threshold_pct, poolEnabled });

  // Empty and loading stay outside the table. Tea Table's autotip row is a SlideTransition
  // inside <tbody>. Turning that row off in the same commit that inserts the first account
  // makes the browser throw NotFoundError (insertBefore) and the route error boundary
  // replaces the page. That happens right after the first OAuth account is saved.
  if (accounts.length === 0) {
    return (
      <StatusTip
        status={loading ? 'loading' : 'empty'}
        emptyText={emptyText}
      />
    );
  }

  const visible = windowColumns(accounts);
  const groupColumns = quotaGroupColumns(accounts);
  // Group columns replace the weekly column and the per-model column of an account that has groups.
  // A model window without a group (the fallback reading) keeps the per-model column.
  const showWeekly = groupColumns.length === 0 || accounts.some((a) => groupWindows(a.usage.windows).secondary);
  const showModels = visible.models && accounts.some((a) => groupWindows(a.usage.windows).extra.some((w) => !w.group_label));
  // The pool page lists one provider at a time, so the column goes only when none of the rows can have credits.
  const showCredits = accounts.some((account) => supportsResetCredits(account.provider));
  // Every column has a fixed width. When their sum is wider than the page, the table scrolls
  // sideways instead of squeezing the account name into one letter per line.
  const minWidth = 220 + 150 + (visible.primary ? 220 : 0) + (showWeekly ? 220 : 0) + (showModels ? 220 : 0) + groupColumns.length * 240 + (showCredits ? 170 : 0) + 140 + 120 + 150 + 260;

  return (
    <Table
      verticalTop
      addons={[scrollable({ minWidth })]}
      records={accounts}
      recordKey="account_id"
      columns={[
        {
          key: 'account',
          header: t('subscriptionPool.col.account'),
          width: 220,
          render: (account: SubscriptionAccount) => (
            <div className="_memory-pool-account">
              <b>{account.display_name}</b>
              <Text theme="weak" parent="div" className="_memory-pool-small _memory-pool-account-id" title={account.account_id}>
                {account.account_id}
              </Text>
              <Text theme="weak" parent="div" className="_memory-pool-small">{account.account_label}</Text>
              {account.project_id && (
                <Text theme="weak" parent="div" className="_memory-pool-small">{account.project_id}</Text>
              )}
            </div>
          ),
        },
        {
          key: 'status',
          header: t('subscriptionPool.col.status'),
          width: 150,
          render: (account: SubscriptionAccount) => {
            const state = stateOf(account);
            const tag = STATE_TAG[state];
            let note: string | null = null;
            if (state === 'near_limit') note = t('subscriptionPool.status.near_limit.note');
            else if (state === 'exhausted') {
              note = account.exhausted_until && account.exhausted_until > now
                ? t('subscriptionPool.status.exhausted.note', {
                    time: formatResetAt(account.exhausted_until, now, { locale: i18n.language }),
                  })
                : t('subscriptionPool.status.exhausted.noteNoTime');
            } else if (state === 'auth_error') note = account.last_error;
            return (
              <div>
                <Tag theme={tag.theme}>{tag.mark} {t(`subscriptionPool.status.${state}`)}</Tag>
                {note && <Text theme="weak" parent="div" className="_memory-pool-small">{note}</Text>}
                {usageCheckFailing(account) && (
                  <Bubble content={t('subscriptionPool.usageFailing.tip', { count: account.usage_fail_count })}>
                    <Text theme="warning" parent="div" className="_memory-pool-small">⚠ {t('subscriptionPool.usageFailing')}</Text>
                  </Bubble>
                )}
              </div>
            );
          },
        },
        {
          key: 'threshold',
          header: t('subscriptionPool.col.threshold'),
          width: 140,
          render: (account: SubscriptionAccount) => (
            <ThresholdCell
              account={account}
              editable={!readOnly}
              busy={busyIds.has(account.account_id)}
              onSave={(value) => onSaveThreshold(account, value)}
            />
          ),
        },
        ...(visible.primary ? [{
          key: 'primary',
          header: t('subscriptionPool.col.primary'),
          width: 220,
          render: (account: SubscriptionAccount) => {
            const state = stateOf(account);
            return (
              <Meter
                window={groupWindows(account.usage.windows).primary}
                now={now}
                thresholdPct={account.threshold_pct}
                showMark={state !== 'disabled' && state !== 'auth_error'}
              />
            );
          },
        }] : []),
        ...(showWeekly ? [{
          key: 'secondary',
          header: t('subscriptionPool.col.secondary'),
          width: 220,
          render: (account: SubscriptionAccount) => {
            const state = stateOf(account);
            return (
              <Meter
                window={groupWindows(account.usage.windows).secondary}
                now={now}
                thresholdPct={account.threshold_pct}
                showMark={state !== 'disabled' && state !== 'auth_error'}
              />
            );
          },
        }] : []),
        ...(showModels ? [{
          key: 'models',
          header: t('subscriptionPool.col.models'),
          width: 220,
          render: (account: SubscriptionAccount) => {
            const extra = groupWindows(account.usage.windows).extra.filter((w) => !w.group_label);
            if (extra.length === 0) return <Text theme="weak">—</Text>;
            return (
              <div className="_memory-pool-meter-list">
                {extra.map((window) => (
                  <Meter
                    key={`${window.name}:${window.model_scope ?? ''}`}
                    window={window}
                    now={now}
                    thresholdPct={account.threshold_pct}
                    showMark={false}
                    label={windowLabel(window, t)}
                  />
                ))}
              </div>
            );
          },
        }] : []),
        ...groupColumns.map((group) => ({
          key: `group:${group.key}`,
          header: group.label,
          width: 240,
          render: (account: SubscriptionAccount) => {
            const state = stateOf(account);
            return (
              <QuotaGroupCell
                account={account}
                groupKey={group.key}
                now={now}
                showMark={state !== 'disabled' && state !== 'auth_error'}
              />
            );
          },
        })),
        ...(showCredits ? [{
          key: 'credits',
          header: t('subscriptionPool.col.credits'),
          width: 170,
          render: (account: SubscriptionAccount) => {
            const credits = account.reset_credits;
            if (!credits) {
              return (
                <div>
                  <div>—</div>
                  <Text theme="weak" className="_memory-pool-small">{t('subscriptionPool.window.noData')}</Text>
                </div>
              );
            }
            const nearest = nearestExpiringCredit(credits.credits, now);
            const expiry = nearest ? describeCreditExpiry(nearest.expires_at, now, { locale: i18n.language }) : null;
            return (
              <div>
                <Button type="link" onClick={() => onShowCredits(account)}>
                  {t('subscriptionPool.credits.available', { count: credits.available })}
                </Button>
                {expiry?.at && expiry.remaining && (
                  <Text theme={expiry.soon ? 'warning' : 'weak'} parent="div" className="_memory-pool-small">
                    {t('subscriptionPool.credits.nearest', { at: expiry.at, remaining: expiry.remaining })}
                  </Text>
                )}
                {credits.available === 0 && credits.note && (
                  <Bubble content={credits.note}>
                    <Text theme="weak" parent="div" className="_memory-pool-small">{credits.note}</Text>
                  </Bubble>
                )}
              </div>
            );
          },
        }] : []),
        {
          key: 'sessions',
          header: t('subscriptionPool.col.sessions'),
          width: 120,
          render: (account: SubscriptionAccount) => <Text>{account.active_sessions || '—'}</Text>,
        },
        {
          key: 'updated',
          header: t('subscriptionPool.col.updated'),
          width: 150,
          render: (account: SubscriptionAccount) => {
            const seen = latestObservation(account.usage.windows);
            if (!seen) return <Text theme="weak">{t('subscriptionPool.updated.none')}</Text>;
            return (
              <Text theme="weak" className="_memory-pool-small">
                {sourceLabel(seen.source, t)} · {formatClock(seen.observedAt, { locale: i18n.language })}
              </Text>
            );
          },
        },
        {
          key: 'actions',
          header: t('subscriptionPool.col.actions'),
          width: 260,
          render: (account: SubscriptionAccount) => {
            const busy = busyIds.has(account.account_id);
            const state = stateOf(account);
            return (
              <div className="_memory-pool-actions">
                {state === 'auth_error' ? (
                  <Button type="primary" disabled={busy} onClick={() => onRelogin(account)}>
                    {t('subscriptionPool.action.relogin')}
                  </Button>
                ) : (
                  <>
                    <Button type="link" disabled={busy} onClick={() => onCheck(account)}>
                      {t('subscriptionPool.action.checkNow')}
                    </Button>
                    <Button type="link" disabled={busy} onClick={() => onToggleEnabled(account)}>
                      {account.enabled ? t('subscriptionPool.action.disable') : t('subscriptionPool.action.enable')}
                    </Button>
                  </>
                )}
                <Button type="error" disabled={busy} onClick={() => onDelete(account)}>
                  {t('subscriptionPool.action.delete')}
                </Button>
              </div>
            );
          },
        },
      ].filter((column) => !readOnly || column.key !== 'actions')}
    />
  );
}
