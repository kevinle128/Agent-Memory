import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, H3, Justify, Segment, Table, Tag, Text } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { tea } from '@/lib/tea-bridge';
import { PENDING_CHANGED_EVENT, vtcApi } from '../api';
import ApproveDialog from '../components/ApproveDialog';
import RejectDialog from '../components/RejectDialog';
import { reportError } from '../components/report-error';
import { formatSaigon, type PendingItem } from '../logic';

const { autotip } = Table.addons;

type Tab = 'pending' | 'rejected';

export default function PendingUsersPage() {
  const { t } = useTranslation('ext-vtc');
  const [items, setItems] = useState<PendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<Tab>('pending');
  const [approving, setApproving] = useState<PendingItem | null>(null);
  const [rejecting, setRejecting] = useState<PendingItem | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);

  // Only the newest reload may write state, so a slow older answer cannot replace a newer list.
  const reloadSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    setLoading(true);
    setFailed(false);
    try {
      const result = await vtcApi.list();
      if (seq === reloadSeq.current) setItems(result.items);
    } catch (err) {
      if (seq !== reloadSeq.current) return;
      setFailed(true);
      tea.notify.error(err);
    } finally {
      if (seq === reloadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const pending = items.filter((item) => item.status === 'pending');
  const rejected = items.filter((item) => item.status === 'rejected');
  const records = tab === 'pending' ? pending : rejected;

  function closeAfterChange() {
    setApproving(null);
    setRejecting(null);
    void reload();
  }

  async function allowAgain(item: PendingItem) {
    setResetting(item.pending_id);
    try {
      await vtcApi.reset(item.pending_id);
      tea.notify.success(t('action.allowAgain.done'));
      window.dispatchEvent(new CustomEvent(PENDING_CHANGED_EVENT));
      await reload();
    } catch (err) {
      reportError(t, err);
      await reload();
    } finally {
      setResetting(null);
    }
  }

  const mailCell = (item: PendingItem) => (
    <div>
      <div>{item.email}</div>
      {item.kind === 'no_team' && (
        <Text theme="weak" parent="div">
          {t('kind.noTeam', { name: item.core_username ?? item.core_user_id ?? '' })}
        </Text>
      )}
    </div>
  );

  const idCell = (item: PendingItem) => (
    <Text parent="code" style={{ fontSize: 12 }}>
      {item.vtc_user_id}
    </Text>
  );

  const pendingColumns = [
    { key: 'email', header: t('col.email'), render: mailCell },
    { key: 'vtc_user_id', header: t('col.vtcId'), render: idCell },
    { key: 'first_login_at', header: t('col.firstLogin'), width: 160, render: (item: PendingItem) => formatSaigon(item.first_login_at) },
    { key: 'source', header: t('col.source'), width: 100, render: (item: PendingItem) => <Tag>{t(`source.${item.source}`)}</Tag> },
    {
      key: 'actions',
      header: t('col.actions'),
      width: 190,
      render: (item: PendingItem) => (
        <>
          <Button type="link" onClick={() => setApproving(item)}>
            {t('action.addToTeam')}
          </Button>
          <Button type="link" onClick={() => setRejecting(item)}>
            {t('action.reject')}
          </Button>
        </>
      ),
    },
  ];

  const rejectedColumns = [
    { key: 'email', header: t('col.email'), render: mailCell },
    { key: 'vtc_user_id', header: t('col.vtcId'), render: idCell },
    {
      key: 'rejected_at',
      header: t('col.rejectedAt'),
      width: 160,
      render: (item: PendingItem) => (item.rejected_at ? formatSaigon(item.rejected_at) : '—'),
    },
    { key: 'reason', header: t('col.reason'), render: (item: PendingItem) => item.reason || '—' },
    {
      key: 'actions',
      header: t('col.actions'),
      width: 120,
      render: (item: PendingItem) => (
        <Button type="link" loading={resetting === item.pending_id} disabled={resetting !== null} onClick={() => void allowAgain(item)}>
          {t('action.allowAgain')}
        </Button>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Justify
        left={
          <div>
            <H3>{t('page.title')}</H3>
            <Text theme="text" parent="div" style={{ marginTop: 4 }}>
              {t('page.lead')}
            </Text>
          </div>
        }
      />
      <Alert type="info">{t('page.adminNote')}</Alert>
      <Segment
        value={tab}
        onChange={(value) => setTab(value as Tab)}
        options={[
          { value: 'pending', text: t('tab.pending', { count: pending.length }) },
          { value: 'rejected', text: t('tab.rejected', { count: rejected.length }) },
        ]}
      />
      <Card>
        <Table<PendingItem>
          verticalTop
          records={records}
          recordKey="pending_id"
          columns={tab === 'pending' ? pendingColumns : rejectedColumns}
          addons={[
            autotip({
              isLoading: loading,
              isError: failed,
              emptyText: tab === 'pending' ? t('empty.pending') : t('empty.rejected'),
              onRetry: () => void reload(),
            }),
          ]}
        />
      </Card>
      <Text theme="weak" parent="div">
        {t('page.footnote')}
      </Text>
      {approving && <ApproveDialog item={approving} onClose={() => setApproving(null)} onDone={closeAfterChange} />}
      {rejecting && <RejectDialog item={rejecting} onClose={() => setRejecting(null)} onDone={closeAfterChange} />}
    </div>
  );
}
