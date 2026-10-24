/** Timeline of every version with a compare panel for any two of them. */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Segment, Select, Text } from 'tea-component';
import type { SkillSummary } from '@/lib/api/skill-api';
import { useVersionDiff } from '../hooks/useVersionDiff';
import { improvementsBetween, previousVersion } from '../lib/skill-scope';
import { DiffStats, DiffView, type DiffMode } from './DiffView';
import { VersionCard } from './VersionCard';
import { DetailsLink, SetVersionButton } from './VersionHistorySection';
import '../styles/skill-scope.css';

export function VersionTimelineScreen(props: {
  skillId: string;
  skillName: string;
  teamId: string;
  versions: SkillSummary[]; // newest first
  currentVersion: number;
  canRollback: boolean;
  onBack: () => void;
  onOpenVersion: (version: number) => void;
  onSetVersion: (version: number) => void;
}) {
  const { t } = useTranslation();
  const [from, setFrom] = useState<number | undefined>(() =>
    previousVersion(props.versions, props.currentVersion),
  );
  const [to, setTo] = useState<number>(props.currentVersion);
  const [mode, setMode] = useState<DiffMode>('unified');

  const { diff, loading, error } = useVersionDiff(
    props.skillId,
    props.teamId,
    from !== undefined && from !== to ? from : undefined,
    from !== undefined && from !== to ? to : undefined,
  );
  const between = useMemo(
    () => (from === undefined ? [] : improvementsBetween(props.versions, from, to)),
    [props.versions, from, to],
  );
  const options = props.versions.map((v) => ({
    value: String(v.version),
    text: `v${v.version}${v.version === props.currentVersion ? ` (${t('skillScope.version.current').toLowerCase()})` : ''} · ${t(
      `skillScope.source.${v.change_source ?? 'legacy'}`,
      { defaultValue: t('skillScope.source.legacy') },
    )}`,
  }));
  const lo = from === undefined ? undefined : Math.min(from, to);
  const hi = from === undefined ? undefined : Math.max(from, to);

  // Ticking a version makes it the "To" side; the previous "To" becomes "From".
  const tick = (version: number) => {
    setFrom(to);
    setTo(version);
  };

  return (
    <div className="_memory-skill-screen">
      <div className="_memory-skill-screen-head">
        <div>
          <div className="_memory-skill-screen-title">{props.skillName}</div>
          <Text theme="weak" parent="div">
            {t('skillScope.timeline.sub', { count: props.versions.length })}
          </Text>
        </div>
        <Button onClick={props.onBack}>{t('skillScope.screen.back')}</Button>
      </div>

      <div className="_memory-skill-timeline-grid">
        <div className="_memory-skill-timeline">
          <Text theme="label" parent="div">
            {t('skillScope.timeline.title')}
          </Text>
          {props.versions.map((v) => {
            const isCurrent = v.version === props.currentVersion;
            const checked = v.version === from || v.version === to;
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
                bottomLeft={
                  <label className="_memory-skill-compare-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={checked}
                      onChange={() => tick(v.version)}
                    />{' '}
                    {t('skillScope.timeline.compare')}
                  </label>
                }
                bottomRight={<DetailsLink version={v.version} onClick={props.onOpenVersion} />}
              />
            );
          })}
        </div>

        <div className="_memory-skill-comparepanel">
          <Text theme="label" parent="div">
            {t('skillScope.timeline.compareTitle')}
          </Text>
          <div className="_memory-skill-compare-bar">
            <span>{t('skillScope.timeline.from')}</span>
            <Select
              appearance="button"
              value={from === undefined ? '' : String(from)}
              onChange={(v) => setFrom(v ? Number(v) : undefined)}
              options={options}
            />
            <span>{t('skillScope.timeline.to')}</span>
            <Select
              appearance="button"
              value={String(to)}
              onChange={(v) => setTo(Number(v))}
              options={options}
            />
            <Button
              disabled={from === undefined}
              onClick={() => {
                if (from === undefined) return;
                setFrom(to);
                setTo(from);
              }}
            >
              {t('skillScope.timeline.swap')}
            </Button>
          </div>
          <Segment
            value={mode}
            onChange={(v) => setMode(v as DiffMode)}
            options={[
              { value: 'unified', text: t('skillScope.timeline.unified') },
              { value: 'split', text: t('skillScope.timeline.split') },
            ]}
          />
          {from === undefined || from === to ? (
            <Text theme="weak" parent="div">
              {t('skillScope.timeline.pickTwo')}
            </Text>
          ) : (
            <>
              {between.length > 0 && lo !== undefined && hi !== undefined && (
                <div className="_memory-skill-between">
                  <b>{t('skillScope.timeline.improvements', { from: lo, to: hi })}</b>
                  {between.map((b) => (
                    <div key={b.version}>
                      <span className="_memory-skill-vtag">v{b.version}</span>
                      <ul>
                        {b.summary.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
              <Text theme="label" parent="div">
                {t('skillScope.timeline.changes', { from: lo, to: hi })}{' '}
                {diff && <DiffStats added={diff.added} removed={diff.removed} />}
              </Text>
              {loading && <Text theme="weak">{t('skills.detail.loading')}</Text>}
              {error && <Text theme="danger">{error}</Text>}
              {diff && <DiffView lines={diff.lines} mode={mode} approximate={diff.approximate} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
