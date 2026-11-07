/**
 * Skill suggestions: change proposals that skill extraction made for global
 * skills. The detail shows the reason the model gave, its tool calls, the
 * SKILL.md diff against the base version, and the decision with its reason.
 * Core decides which proposals the user may see and decide.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Select } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import {
  approveSkillProposal,
  getSkill,
  listSkillProposals,
  rejectSkillProposal,
  type ProposalStatus,
  type SkillProposal,
} from '@/lib/api/skill-api';
import { describeSkillError, diffLines, formatSaigon, type DiffRow } from '@/pages/SkillsPage/lib/skill-scope';
import { DiffStats, DiffView } from '@/pages/SkillsPage/components/DiffView';
import { ImprovementList } from '@/pages/SkillsPage/components/VersionCard';
import '@/pages/SkillsPage/styles/skill-scope.css';
import { useFeedback } from '../hooks/useFeedback';
import { DetailSection, FeedbackBar, Pill, SessionLink, shortId, useErrorText, type Tone } from './shared';

const PAGE_SIZE = 50;
const STATUSES: ProposalStatus[] = ['pending', 'approved', 'rejected', 'stale', 'expired'];
const STATUS_TONE: Record<ProposalStatus, Tone> = {
  pending: 'warn',
  approved: 'ok',
  rejected: 'bad',
  stale: 'plain',
  expired: 'plain',
};

function ProposalDiff({ teamId, proposal }: { teamId: string; proposal: SkillProposal }) {
  const { t } = useTranslation();
  const [diff, setDiff] = useState<{ lines: DiffRow[]; added: number; removed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    getSkill({
      skill_id: proposal.skill_id,
      team_id: teamId,
      version: proposal.base_version,
      include_content: true,
      include_manifest: false,
    })
      .then((base) => {
        if (!cancelled) setDiff(diffLines(base.content, proposal.proposed_content));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, proposal.skill_id, proposal.base_version, proposal.proposed_content]);

  return (
    <DetailSection title={t('history.skills.diff', { base: proposal.base_version })}>
      {diff && <DiffStats added={diff.added} removed={diff.removed} />}
      {!diff && !error && <div className="_ph-mut">{t('skills.detail.loading')}</div>}
      {error && <div className="_ph-error">{error}</div>}
      {diff && <DiffView lines={diff.lines} />}
    </DetailSection>
  );
}

export function SkillSuggestionsTab(props: {
  teamId: string;
  userId: string;
  memberName: (userId: string) => string;
}) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [status, setStatus] = useState<ProposalStatus | ''>('');
  const [items, setItems] = useState<SkillProposal[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [deciding, setDeciding] = useState(false);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setError(null);
      try {
        const page = await listSkillProposals({
          team_id: props.teamId,
          user_id: props.userId,
          status: status ? [status] : undefined,
          pagination: { limit: PAGE_SIZE, offset },
        });
        setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
        setTotal(page.total);
        if (offset === 0) setSelectedId((cur) => (page.items.some((p) => p.proposal_id === cur) ? cur : (page.items[0]?.proposal_id ?? null)));
      } catch (err) {
        setError(errorText(err));
        if (offset === 0) setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [props.teamId, props.userId, status, errorText],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  useEffect(() => setReason(''), [selectedId]);

  const ids = useMemo(() => items.map((p) => p.proposal_id), [items]);
  const feedback = useFeedback(props.teamId, 'skill', ids);
  const selected = items.find((p) => p.proposal_id === selectedId) ?? null;

  async function decide(p: SkillProposal, decision: 'approve' | 'reject') {
    if (decision === 'reject' && !reason.trim()) {
      tea.notify.warning(t('history.skills.reasonRequired'));
      return;
    }
    setDeciding(true);
    try {
      const params = {
        team_id: props.teamId,
        user_id: props.userId,
        proposal_id: p.proposal_id,
        agent_id: p.owner_agent_id,
        reason: reason.trim() || undefined,
      };
      if (decision === 'approve') {
        const res = await approveSkillProposal(params);
        tea.notify.success(t('skillScope.proposals.applied', { name: p.skill_name, version: res.skill.version }));
      } else {
        await rejectSkillProposal(params);
        tea.notify.success(t('history.skills.rejected', { name: p.skill_name }));
      }
    } catch (err) {
      tea.notify.error(describeSkillError(err, t));
    } finally {
      setDeciding(false);
      void load(0);
    }
  }

  return (
    <div className="_ph-row">
      <div className="_ph-list">
        <div className="_ph-filters">
          <Select
            size="m"
            value={status}
            onChange={(v) => setStatus(v as ProposalStatus | '')}
            options={[
              { value: '', text: t('history.filter.allStatuses') },
              ...STATUSES.map((s) => ({ value: s, text: t(`history.proposalStatus.${s}`) })),
            ]}
          />
          <Button type="weak" loading={loading} onClick={() => void load(0)}>
            {t('history.refresh')}
          </Button>
          <span className="_ph-mut">{t('history.skills.scopeNote')}</span>
        </div>
        {error && <div className="_ph-error">{error}</div>}
        <table className="_ph-table">
          <thead>
            <tr>
              <th>{t('history.col.time')}</th>
              <th>{t('history.col.fromSession')}</th>
              <th>{t('history.col.proposal')}</th>
              <th>{t('history.col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr
                key={p.proposal_id}
                className={p.proposal_id === selectedId ? '_ph-sel' : ''}
                onClick={() => setSelectedId(p.proposal_id)}
              >
                <td className="_ph-nowrap">{formatSaigon(p.created_at_ms)}</td>
                <td className="_ph-mono">{shortId(p.source_session_id)}</td>
                <td>
                  {t('history.skills.proposalLine', { name: p.skill_name })}
                  {p.change_summary?.[0] && <div className="_ph-mut _ph-clip">{p.change_summary[0]}</div>}
                </td>
                <td>
                  <Pill tone={STATUS_TONE[p.status]}>{t(`history.proposalStatus.${p.status}`)}</Pill>
                  {p.decided_by && <div className="_ph-mut">{t('history.skills.by', { name: props.memberName(p.decided_by) })}</div>}
                  {p.decision_reason && <div className="_ph-mut _ph-clip">“{p.decision_reason}”</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !error && items.length === 0 && <div className="_ph-empty">{t('history.skills.empty')}</div>}
        {items.length < total && (
          <div className="_ph-more">
            <Button loading={loading} onClick={() => void load(items.length)}>
              {t('history.loadMore', { shown: items.length, total })}
            </Button>
          </div>
        )}
      </div>

      <div className="_ph-detail">
        {!selected ? (
          <div className="_ph-empty">{t('history.selectRow')}</div>
        ) : (
          <>
            <div className="_ph-detail-head">
              <b>{t('history.skills.title', { name: selected.skill_name, time: formatSaigon(selected.created_at_ms) })}</b>{' '}
              <Pill tone={STATUS_TONE[selected.status]}>{t(`history.proposalStatus.${selected.status}`)}</Pill>
            </div>
            <div className="_ph-mut">
              {t('history.skills.owner', {
                owner: selected.owner_name || shortId(selected.owner_user_id),
                agent: selected.owner_agent_name || shortId(selected.owner_agent_id),
              })}{' '}
              <SessionLink agentId={selected.owner_agent_id} sessionId={selected.source_session_id} />
            </div>

            <DetailSection title={t('history.skills.why')}>
              <div>{selected.change_reason || '—'}</div>
              {selected.change_summary?.length > 0 && <ImprovementList items={selected.change_summary} />}
            </DetailSection>

            <DetailSection title={t('history.skills.toolCalls', { count: selected.tool_calls?.length ?? 0 })}>
              {selected.tool_calls && selected.tool_calls.length > 0 ? (
                <ol className="_ph-tools">
                  {selected.tool_calls.map((c, i) => (
                    <li key={i}>
                      <span className="_ph-mono">
                        <b>{c.name}</b>({c.input})
                      </span>
                      {c.output !== undefined && <div className="_ph-mut _ph-mono _ph-clip2">→ {c.output}</div>}
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="_ph-mut">{t('history.skills.noToolCalls')}</div>
              )}
            </DetailSection>

            <ProposalDiff teamId={props.teamId} proposal={selected} />

            <DetailSection title={t('history.skills.decision')}>
              {selected.decided_at_ms ? (
                <div>
                  {t('history.skills.decidedLine', {
                    status: t(`history.proposalStatus.${selected.status}`),
                    name: selected.decided_by ? props.memberName(selected.decided_by) : '—',
                    time: formatSaigon(selected.decided_at_ms),
                  })}
                  <div className="_ph-quote">{selected.decision_reason || t('history.skills.noReason')}</div>
                </div>
              ) : (
                <div className="_ph-mut">{t('history.skills.notDecided')}</div>
              )}
              {(selected.status === 'pending' || selected.status === 'stale') && (
                <div className="_ph-decide">
                  <textarea
                    className="_ph-textarea"
                    rows={2}
                    maxLength={1000}
                    placeholder={t('history.skills.reasonPlaceholder')}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <div className="_ph-feedback-row">
                    {selected.status === 'pending' && (
                      <Button type="primary" loading={deciding} onClick={() => void decide(selected, 'approve')}>
                        {t('skillScope.proposals.approve')}
                      </Button>
                    )}
                    <Button disabled={deciding} onClick={() => void decide(selected, 'reject')}>
                      {t('history.skills.rejectWithReason')}
                    </Button>
                  </div>
                </div>
              )}
            </DetailSection>

            <DetailSection title={t('history.feedback.title')}>
              <FeedbackBar
                entries={feedback.of(selected.proposal_id)}
                userId={feedback.userId}
                busy={feedback.busyId === selected.proposal_id}
                onSet={(rating, note) => void feedback.set(selected.proposal_id, rating, note)}
                upLabel={t('history.feedback.skillUp')}
                downLabel={t('history.feedback.skillDown')}
              />
            </DetailSection>
          </>
        )}
      </div>
    </div>
  );
}
