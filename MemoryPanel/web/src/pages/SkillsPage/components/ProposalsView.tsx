/**
 * Pending changes to global skills. A proposal is applied only when a person approves it here.
 * Approve creates the new version at once; a stale proposal (head moved) can only be rejected.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Text } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import {
  approveSkillProposal,
  getSkill,
  rejectSkillProposal,
  type SkillProposal,
} from '@/lib/api/skill-api';
import { describeSkillError, diffLines, formatSaigon, type DiffRow } from '../lib/skill-scope';
import { DiffStats, DiffView } from './DiffView';
import { ImprovementList } from './VersionCard';
import { ScopeBadge } from './SkillBadges';
import '../styles/skill-scope.css';

function StatusTag({ status }: { status: string }) {
  const { t } = useTranslation();
  if (status !== 'stale') return null;
  return <span className="_memory-skill-stale">{t('skillScope.proposals.stale')}</span>;
}

function ProposalDetail(props: {
  teamId: string;
  proposal: SkillProposal;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const p = props.proposal;
  const [diff, setDiff] = useState<{ lines: DiffRow[]; added: number; removed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    getSkill({
      skill_id: p.skill_id,
      team_id: props.teamId,
      version: p.base_version,
      include_content: true,
      include_manifest: false,
    })
      .then((base) => {
        if (!cancelled) setDiff(diffLines(base.content, p.proposed_content));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [p.proposal_id, p.skill_id, p.base_version, p.proposed_content, props.teamId]);

  return (
    <div className="_memory-skill-screen">
      <div className="_memory-skill-screen-head">
        <div className="_memory-skill-screen-title">
          {p.skill_name} <StatusTag status={p.status} />
        </div>
        <div className="_memory-skill-screen-actions">
          {p.status === 'pending' && (
            <Button type="primary" loading={props.busy} onClick={props.onApprove}>
              {t('skillScope.proposals.approve')}
            </Button>
          )}
          <Button disabled={props.busy} onClick={props.onReject}>
            {t('skillScope.proposals.reject')}
          </Button>
          <Button onClick={props.onBack}>{t('skillScope.proposals.backToList')}</Button>
        </div>
      </div>
      <div className="_memory-skill-section">
        <Text theme="label" parent="div">
          {t('skillScope.version.reason')}
        </Text>
        <div>{p.change_reason || '—'}</div>
      </div>
      <div className="_memory-skill-section">
        <Text theme="label" parent="div">
          {t('skillScope.proposals.brings')}
        </Text>
        {p.change_summary?.length ? <ImprovementList items={p.change_summary} /> : <div>—</div>}
      </div>
      <div className="_memory-skill-section">
        <Text theme="label" parent="div">
          {t('skillScope.proposals.diffTitle', { base: p.base_version })}{' '}
          {diff && <DiffStats added={diff.added} removed={diff.removed} />}
        </Text>
        {!diff && !error && <Text theme="weak">{t('skills.detail.loading')}</Text>}
        {error && <Text theme="danger">{error}</Text>}
        {diff && <DiffView lines={diff.lines} />}
      </div>
    </div>
  );
}

export function ProposalsView(props: {
  teamId: string;
  userId: string;
  proposals: SkillProposal[];
  loading: boolean;
  onBack: () => void;
  /** Refresh proposals and the skill list after a decision. */
  onChanged: () => void;
  onOpenSkill: (skillId: string) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ skillId: string; name: string; version: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = props.proposals.find((p) => p.proposal_id === openId);

  async function approve(p: SkillProposal) {
    setBusy(p.proposal_id);
    setError(null);
    try {
      const res = await approveSkillProposal({
        team_id: props.teamId,
        user_id: props.userId,
        proposal_id: p.proposal_id,
        agent_id: p.owner_agent_id,
      });
      setApplied({ skillId: p.skill_id, name: p.skill_name, version: res.skill.version });
      setOpenId(null);
      props.onChanged();
    } catch (err) {
      setError(describeSkillError(err, t));
      setOpenId(null);
      props.onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function reject(p: SkillProposal) {
    const ok = await tea.confirm({
      message: t('skillScope.proposals.rejectConfirm', { name: p.skill_name }),
      description: t('skillScope.proposals.rejectDesc'),
      okText: t('skillScope.proposals.reject'),
      cancelText: t('skills.detail.cancel'),
    });
    if (!ok) return;
    setBusy(p.proposal_id);
    setError(null);
    try {
      await rejectSkillProposal({
        team_id: props.teamId,
        user_id: props.userId,
        proposal_id: p.proposal_id,
        agent_id: p.owner_agent_id,
      });
      setApplied(null);
      setOpenId(null);
      props.onChanged();
    } catch (err) {
      setError(describeSkillError(err, t));
      setOpenId(null);
      props.onChanged();
    } finally {
      setBusy(null);
    }
  }

  if (open) {
    return (
      <ProposalDetail
        teamId={props.teamId}
        proposal={open}
        busy={busy === open.proposal_id}
        onApprove={() => void approve(open)}
        onReject={() => void reject(open)}
        onBack={() => setOpenId(null)}
      />
    );
  }

  return (
    <div className="_memory-skill-screen">
      <div className="_memory-skill-screen-head">
        <div>
          <div className="_memory-skill-screen-title">{t('skillScope.proposals.title')}</div>
          <Text theme="weak" parent="div">
            {t('skillScope.proposals.sub')}
          </Text>
        </div>
        <Button onClick={props.onBack}>{t('skillScope.proposals.backToSkills')}</Button>
      </div>

      {applied && (
        <Alert type="success">
          {t('skillScope.proposals.applied', { name: applied.name, version: applied.version })}{' '}
          <button
            type="button"
            className="_memory-skill-link"
            onClick={() => props.onOpenSkill(applied.skillId)}
          >
            {t('skillScope.proposals.openSkill')} ›
          </button>
        </Alert>
      )}
      {error && <Alert type="error">{error}</Alert>}
      {props.loading && <Text theme="weak">{t('skills.detail.loading')}</Text>}
      {!props.loading && props.proposals.length === 0 && (
        <Text theme="weak" parent="div">
          {t('skillScope.proposals.empty')}
        </Text>
      )}

      {props.proposals.map((p) => (
        <div
          key={p.proposal_id}
          className={`_memory-skill-vcard${p.status === 'stale' ? ' _memory-skill-vcard--stale' : ''}`}
          data-proposal={p.proposal_id}
        >
          <div className="_memory-skill-vcard-top">
            <div className="_memory-skill-vcard-title">
              <b>{p.skill_name}</b>
              <ScopeBadge skill={{ skill_id: p.skill_id, name: p.skill_name, scope: 'global' }} />
              <span className="_memory-skill-vtag">
                v{p.base_version} → {t('skillScope.proposals.proposed')}
              </span>
              <StatusTag status={p.status} />
              <span className="_memory-skill-vcard-time">{formatSaigon(p.created_at_ms)}</span>
            </div>
            <div className="_memory-skill-vcard-topright">
              {p.status === 'pending' && (
                <Button
                  type="primary"
                  loading={busy === p.proposal_id}
                  onClick={() => void approve(p)}
                >
                  {t('skillScope.proposals.approve')}
                </Button>
              )}
              <Button disabled={busy === p.proposal_id} onClick={() => void reject(p)}>
                {t('skillScope.proposals.reject')}
              </Button>
            </div>
          </div>
          {p.status === 'stale' && (
            <div className="_memory-skill-vcard-meta">{t('skillScope.proposals.staleHint')}</div>
          )}
          {p.change_reason && (
            <div className="_memory-skill-vcard-reason _memory-skill-clamp">
              <span className="_memory-skill-vcard-label">{t('skillScope.version.reason')}</span> {p.change_reason}
            </div>
          )}
          {p.change_summary?.length > 0 && <ImprovementList items={p.change_summary} />}
          <div className="_memory-skill-vcard-bottom">
            <div className="_memory-skill-vcard-bottomleft" />
            <div className="_memory-skill-vcard-bottomright">
              <button type="button" className="_memory-skill-link" onClick={() => setOpenId(p.proposal_id)}>
                {t('skillScope.version.viewDetails')} ›
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
