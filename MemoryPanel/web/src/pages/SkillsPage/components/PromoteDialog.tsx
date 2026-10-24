/** Confirm making a project skill global. The content stays the same; a new version records it. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Modal, Text } from 'tea-component';
import { promoteSkill, type SkillSummary } from '@/lib/api/skill-api';
import { describeSkillError, projectLabel } from '../lib/skill-scope';
import '../styles/skill-scope.css';

export function PromoteDialog(props: {
  skill: SkillSummary;
  teamId: string;
  userId: string;
  agentId?: string;
  onClose: () => void;
  onDone: (head: SkillSummary) => void;
}) {
  const { t } = useTranslation();
  const { skill } = props;
  const [checked, setChecked] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = projectLabel(skill);
  const origin = skill.origin === 'manual' || skill.origin === 'template' ? skill.origin : 'extracted';

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const head = await promoteSkill({
        user_id: props.userId,
        team_id: props.teamId,
        agent_id: props.agentId,
        skill_id: skill.skill_id,
        reason: reason.trim() || undefined,
        expected_version: skill.version,
      });
      props.onDone(head);
    } catch (err) {
      setError(describeSkillError(err, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible size="l" caption={t('skillScope.promote.title', { name: skill.name })} onClose={props.onClose}>
      <Modal.Body>
        <div className="_memory-skill-promote-flow">
          <div className="_memory-skill-promote-box">
            <div className="_memory-skill-promote-label">{t('skillScope.promote.now')}</div>
            {t('skillScope.badge.project', { name: project })} · {t(`skillScope.origin.${origin}`)}
          </div>
          <span>→</span>
          <div className="_memory-skill-promote-box">
            <div className="_memory-skill-promote-label">{t('skillScope.promote.after')}</div>
            {t('skillScope.promote.afterValue', { version: skill.version + 1 })}
          </div>
        </div>
        <ul className="_memory-skill-promote-warning">
          <li>{t('skillScope.promote.warnGlobal', { project })}</li>
          <li>{t('skillScope.promote.warnExtractor')}</li>
          <li>{t('skillScope.promote.warnApproval')}</li>
          <li>{t('skillScope.promote.warnCheck')}</li>
        </ul>
        <label className="_memory-skill-compare-check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} disabled={saving} />{' '}
          {t('skillScope.promote.checkbox')}
        </label>
        <div className="_memory-skill-section">
          <Text theme="label" parent="div">
            {t('skillScope.promote.reason')}
          </Text>
          <Input.TextArea size="full" value={reason} maxLength={1000} onChange={(v) => setReason(v)} disabled={saving} />
        </div>
        {error && (
          <Text theme="danger" parent="div" className="_memory-skill-inline-error">
            {error}
          </Text>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" disabled={!checked} loading={saving} onClick={() => void submit()}>
          {t('skillScope.promote.button')}
        </Button>
        <Button onClick={props.onClose} disabled={saving}>
          {t('skills.detail.cancel')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
