/** "Version history" section under the skill body: current version first, then older ones. */
import { useTranslation } from 'react-i18next';
import { Button, Text } from 'tea-component';
import type { SkillSummary } from '@/lib/api/skill-api';
import { VersionCard } from './VersionCard';
import '../styles/skill-scope.css';

export function SetVersionButton({ version, onClick }: { version: number; onClick: (v: number) => void }) {
  const { t } = useTranslation();
  return (
    <Button onClick={() => onClick(version)} data-set-version={version}>
      {t('skillScope.version.setTo')}
    </Button>
  );
}

export function DetailsLink({ version, onClick }: { version: number; onClick: (v: number) => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="_memory-skill-link" onClick={() => onClick(version)}>
      {t('skillScope.version.viewDetails')} ›
    </button>
  );
}

export function VersionHistorySection(props: {
  versions: SkillSummary[]; // newest first
  currentVersion: number;
  loading: boolean;
  error: string | null;
  /** Only people who can write the skill may set it to an older version. */
  canRollback: boolean;
  onSetVersion: (version: number) => void;
  onOpenVersion: (version: number) => void;
  onOpenAll: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="_memory-skill-section">
      <div className="_memory-skill-section-head">
        <Text theme="label" parent="div">
          {t('skillScope.history.title', { count: props.versions.length })}
        </Text>
        <span className="_memory-skill-section-note">
          {t('skillScope.history.note')}{' '}
          <button type="button" className="_memory-skill-link" onClick={props.onOpenAll}>
            {t('skillScope.history.compare')} ›
          </button>
        </span>
      </div>
      {props.loading && <Text theme="weak">{t('skills.detail.loading')}</Text>}
      {props.error && <Text theme="danger">{props.error}</Text>}
      {!props.loading && !props.error && props.versions.length === 0 && (
        <Text theme="weak">{t('skills.detail.versionsEmpty')}</Text>
      )}
      {props.versions.map((v) => {
        const isCurrent = v.version === props.currentVersion;
        return (
          <VersionCard
            key={v.version}
            version={v}
            isCurrent={isCurrent}
            topRight={
              !isCurrent && props.canRollback ? (
                <SetVersionButton version={v.version} onClick={props.onSetVersion} />
              ) : undefined
            }
            bottomRight={<DetailsLink version={v.version} onClick={props.onOpenVersion} />}
          />
        );
      })}
    </div>
  );
}
