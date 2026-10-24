/** Small badges for scope, origin, change source and pending proposals. */
import { useTranslation } from 'react-i18next';
import {
  projectLabel,
  scopeOf,
  type ScopedSkillFields,
} from '../lib/skill-scope';
import '../styles/skill-scope.css';

export function ScopeBadge({
  skill,
  hideProject = false,
}: {
  skill: ScopedSkillFields;
  /** Chat prompt mode has no projects: drop the project part of the badge. */
  hideProject?: boolean;
}) {
  const { t } = useTranslation();
  if (scopeOf(skill) === 'global') {
    return (
      <span className="_memory-skill-badge _memory-skill-badge--global">
        {t('skillScope.badge.global')}
      </span>
    );
  }
  if (hideProject) return null;
  const label = projectLabel(skill);
  return (
    <span
      className="_memory-skill-badge _memory-skill-badge--project"
      title={skill.project_hash || undefined}
    >
      {t('skillScope.badge.project', { name: label })}
    </span>
  );
}

export function OriginBadge({ origin }: { origin?: string }) {
  const { t } = useTranslation();
  // Rows written before scoping read as extracted.
  const value = origin === 'manual' || origin === 'template' ? origin : 'extracted';
  return (
    <span className={`_memory-skill-origin _memory-skill-origin--${value}`}>
      <span className="_memory-skill-origin-dot" />
      {t(`skillScope.origin.${value}`)}
    </span>
  );
}

const KNOWN_SOURCES = ['manual', 'extracted', 'rollback', 'promotion', 'template'];

export function SourceTag({ source }: { source?: string | null }) {
  const { t } = useTranslation();
  const value = source && KNOWN_SOURCES.includes(source) ? source : 'legacy';
  return (
    <span className={`_memory-skill-source _memory-skill-source--${value}`}>
      {t(`skillScope.source.${value}`)}
    </span>
  );
}

export function PendingBadge({ count }: { count: number }) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return (
    <span className="_memory-skill-pending-badge">
      {'● '}
      {t('skillScope.pending.badge', { count })}
    </span>
  );
}
