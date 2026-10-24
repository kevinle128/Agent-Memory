/** Create a skill as global or as a skill of one known project. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Modal, Segment, Select, Text } from 'tea-component';
import { createSkill } from '@/lib/api/skill-api';
import { describeSkillError, type KnownProject, type SkillScope } from '../lib/skill-scope';
import { buildSkillContent, placementFor, validateNewSkillAll, type NewSkillIssue } from '../lib/new-skill';
import '../styles/skill-scope.css';

export function NewSkillDialog(props: {
  teamId: string;
  userId: string;
  agents: Array<{ id: string; name: string }>;
  defaultAgentId?: string;
  projects: KnownProject[];
  /** False when the instance has no project skills (chat prompt mode). */
  showProjectOption: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [scope, setScope] = useState<SkillScope>('global');
  const [projectHash, setProjectHash] = useState('');
  const [agentId, setAgentId] = useState(props.defaultAgentId || props.agents[0]?.id || '');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const issueText: Record<NewSkillIssue, string> = {
    name: t('skillScope.new.error.name'),
    nameLength: t('skillScope.new.error.nameLength'),
    nameLines: t('skillScope.new.error.nameLines'),
    agent: t('skillScope.new.error.agent'),
    project: t('skillScope.new.error.project'),
  };

  async function submit() {
    const issues = validateNewSkillAll({ name, description, body, scope, projectHash, agentId });
    if (issues.length > 0) {
      setErrors(issues.map((i) => issueText[i]));
      return;
    }
    setSaving(true);
    setErrors([]);
    try {
      await createSkill({
        user_id: props.userId,
        team_id: props.teamId,
        agent_id: agentId,
        name: name.trim(),
        content: buildSkillContent({ name, description, body }),
        ...placementFor(scope, projectHash, props.projects),
      });
      props.onCreated();
    } catch (err) {
      setErrors([describeSkillError(err, t)]);
    } finally {
      setSaving(false);
    }
  }

  const field = (label: string, node: JSX.Element, hint?: string) => (
    <div className="_memory-skill-field">
      <Text theme="label" parent="div">
        {label}
      </Text>
      {node}
      {hint && (
        <Text theme="weak" parent="div">
          {hint}
        </Text>
      )}
    </div>
  );

  return (
    <Modal visible size="l" caption={t('skillScope.new.title')} onClose={props.onClose}>
      <Modal.Body>
        {props.showProjectOption &&
          field(
            t('skillScope.new.scope'),
            <Segment
              value={scope}
              onChange={(v) => {
                setScope(v as SkillScope);
                setErrors([]);
              }}
              options={[
                { value: 'global', text: t('skillScope.badge.global') },
                { value: 'project', text: t('skillScope.new.scopeProject') },
              ]}
            />,
            scope === 'global' ? t('skillScope.new.globalHint') : t('skillScope.new.projectHint'),
          )}
        {scope === 'project' &&
          field(
            `${t('skillScope.new.project')} *`,
            props.projects.length === 0 ? (
              <Text theme="warning" parent="div">
                {t('skillScope.new.noProjects')}
              </Text>
            ) : (
              <Select
                appearance="button"
                matchButtonWidth
                value={projectHash}
                placeholder={t('skillScope.new.pickProject')}
                onChange={(v) => {
                  setProjectHash(v);
                  setErrors([]);
                }}
                options={props.projects.map((p) => ({ value: p.hash, text: `${p.label} (${p.hash.slice(0, 8)})` }))}
              />
            ),
          )}
        {field(
          t('skillScope.new.agent'),
          <Select
            appearance="button"
            matchButtonWidth
            value={agentId}
            onChange={(v) => setAgentId(v)}
            options={props.agents.map((a) => ({ value: a.id, text: `${a.name}（${a.id}）` }))}
          />,
        )}
        {field(
          `${t('skillScope.new.name')} *`,
          <Input size="full" value={name} onChange={(v) => setName(v)} disabled={saving} maxLength={64} />,
        )}
        {field(
          t('skillScope.new.description'),
          <Input size="full" value={description} onChange={(v) => setDescription(v)} disabled={saving} />,
        )}
        {field(
          t('skillScope.new.body'),
          <Input.TextArea size="full" value={body} onChange={(v) => setBody(v)} disabled={saving} />,
        )}
        {errors.map((message) => (
          <Text key={message} theme="danger" parent="div" className="_memory-skill-inline-error">
            {message}
          </Text>
        ))}
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" loading={saving} onClick={() => void submit()}>
          {t('skillScope.new.create')}
        </Button>
        <Button onClick={props.onClose} disabled={saving}>
          {t('skills.detail.cancel')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
