/**
 * Confirm dialog for "Set skill to this version". It shows the diff from the current head
 * to the target, the improvements the rollback drops, and requires a reason.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Input, Modal, Text } from 'tea-component';
import { rollbackSkill, type SkillSummary } from '@/lib/api/skill-api';
import { useVersionDiff } from '../hooks/useVersionDiff';
import { describeSkillError, lostImprovements } from '../lib/skill-scope';
import { DiffStats, DiffView } from './DiffView';
import '../styles/skill-scope.css';

export function RollbackDialog(props: {
  skillId: string;
  teamId: string;
  userId: string;
  agentId?: string;
  currentVersion: number;
  targetVersion: number;
  versions: SkillSummary[];
  onClose: () => void;
  /** Called with the new head after the rollback succeeds. */
  onDone: (head: SkillSummary) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { diff, loading: diffLoading, error: diffError } = useVersionDiff(
    props.skillId,
    props.teamId,
    props.currentVersion,
    props.targetVersion,
  );
  const lost = lostImprovements(props.versions, props.targetVersion);
  const reasonOk = reason.trim().length > 0;

  async function confirm() {
    if (!reasonOk) {
      setError(t('skillScope.rollback.reasonRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const head = await rollbackSkill({
        user_id: props.userId,
        team_id: props.teamId,
        agent_id: props.agentId,
        skill_id: props.skillId,
        target_version: props.targetVersion,
        reason: reason.trim(),
        expected_version: props.currentVersion,
      });
      props.onDone(head);
    } catch (err) {
      setError(describeSkillError(err, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      visible
      size="xl"
      caption={t('skillScope.rollback.title', { version: props.targetVersion })}
      onClose={props.onClose}
    >
      <Modal.Body>
        <Alert type="warning">
          {t('skillScope.rollback.explain', {
            next: props.currentVersion + 1,
            target: props.targetVersion,
          })}
        </Alert>

        <div className="_memory-skill-section">
          <Text theme="label" parent="div">
            {t('skillScope.rollback.lost')}
          </Text>
          {lost.length === 0 ? (
            <Text theme="weak" parent="div">
              {t('skillScope.rollback.lostNone')}
            </Text>
          ) : (
            lost.map((l) => (
              <div key={l.version} className="_memory-skill-lost">
                <b>v{l.version}</b>
                <ul>
                  {l.summary.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>

        <div className="_memory-skill-section">
          <Text theme="label" parent="div">
            {t('skillScope.rollback.diffTitle', {
              from: props.currentVersion,
              to: props.targetVersion,
            })}{' '}
            {diff && <DiffStats added={diff.added} removed={diff.removed} />}
          </Text>
          {diffLoading && <Text theme="weak">{t('skills.detail.loading')}</Text>}
          {diffError && <Text theme="danger">{diffError}</Text>}
          {diff && <DiffView lines={diff.lines} approximate={diff.approximate} />}
        </div>

        <div className="_memory-skill-section">
          <Text theme="label" parent="div">
            {t('skillScope.rollback.reason')} *
          </Text>
          <Input.TextArea
            size="full"
            value={reason}
            maxLength={1000}
            placeholder={t('skillScope.rollback.reasonPlaceholder')}
            onChange={(v) => setReason(v)}
            disabled={saving}
          />
        </div>
        {error && (
          <Text theme="danger" parent="div" className="_memory-skill-inline-error">
            {error}
          </Text>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={confirm} loading={saving} disabled={!reasonOk}>
          {t('skillScope.rollback.confirm', { version: props.targetVersion })}
        </Button>
        <Button onClick={props.onClose} disabled={saving}>
          {t('skills.detail.cancel')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
