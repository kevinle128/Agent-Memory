/** One version in full: reason, approver, improvements, and a diff against another version. */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Modal, Select, Text } from 'tea-component';
import {
  getSkill,
  readSkillFile,
  type ReadFileResult,
  type SkillManifestEntry,
  type SkillSummary,
} from '@/lib/api/skill-api';
import { useVersionDiff } from '../hooks/useVersionDiff';
import { diffLines, previousVersion, type DiffRow } from '../lib/skill-scope';
import { DiffStats, DiffView } from './DiffView';
import { FileTreeView, buildFileTree } from './SkillFileTree';
import { VersionCard } from './VersionCard';
import { SetVersionButton } from './VersionHistorySection';
import '../styles/skill-scope.css';

export function VersionDetailView(props: {
  skillId: string;
  skillName: string;
  teamId: string;
  version: number;
  versions: SkillSummary[]; // newest first
  currentVersion: number;
  canRollback: boolean;
  onBack: () => void;
  onSetVersion: (version: number) => void;
}) {
  const { t } = useTranslation();
  const record = props.versions.find((v) => v.version === props.version);
  const [compareWith, setCompareWith] = useState<number | undefined>(() =>
    previousVersion(props.versions, props.version),
  );
  useEffect(() => {
    setCompareWith(previousVersion(props.versions, props.version));
  }, [props.version, props.versions]);

  const { diff, loading, error } = useVersionDiff(props.skillId, props.teamId, compareWith, props.version);

  // The first version has nothing before it: show its whole text as added lines.
  const [firstLines, setFirstLines] = useState<{ lines: DiffRow[]; added: number } | null>(null);
  const [firstError, setFirstError] = useState<string | null>(null);
  useEffect(() => {
    setFirstLines(null);
    setFirstError(null);
    if (compareWith !== undefined) return;
    let cancelled = false;
    getSkill({
      skill_id: props.skillId,
      team_id: props.teamId,
      version: props.version,
      include_content: true,
      include_manifest: false,
    })
      .then((v) => {
        if (cancelled) return;
        const d = diffLines('', v.content);
        setFirstLines({ lines: d.lines, added: d.added });
      })
      .catch((err) => {
        if (!cancelled) setFirstError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [compareWith, props.skillId, props.teamId, props.version]);

  // Resource files of this version, read only.
  const [manifest, setManifest] = useState<SkillManifestEntry[] | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<ReadFileResult | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  useEffect(() => {
    setManifest(null);
    setManifestError(null);
    setFilePreview(null);
    let cancelled = false;
    getSkill({
      skill_id: props.skillId,
      team_id: props.teamId,
      version: props.version,
      include_content: false,
      include_manifest: true,
    })
      .then((v) => {
        if (!cancelled) setManifest(v.manifest ?? []);
      })
      .catch((err) => {
        if (!cancelled) setManifestError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [props.skillId, props.teamId, props.version]);
  const fileTree = useMemo(() => buildFileTree((manifest ?? []).map((e) => e.path)), [manifest]);

  async function viewFile(path: string) {
    setFileLoading(true);
    setFilePreview({ path, content: '', encoding: 'utf-8', size_bytes: 0, mime_type: 'text/plain', version: props.version });
    try {
      setFilePreview(
        await readSkillFile({
          skill_id: props.skillId,
          team_id: props.teamId,
          path,
          version: props.version,
          encoding: 'utf-8',
        }),
      );
    } catch (err) {
      setFilePreview({
        path,
        content: t('skills.detail.readFailed', { msg: err instanceof Error ? err.message : String(err) }),
        encoding: 'utf-8',
        size_bytes: 0,
        mime_type: 'text/plain',
        version: props.version,
      });
    } finally {
      setFileLoading(false);
    }
  }

  const options = useMemo(
    () =>
      props.versions
        .filter((v) => v.version !== props.version)
        .map((v) => ({ value: String(v.version), text: `v${v.version}` })),
    [props.versions, props.version],
  );

  if (!record) {
    return (
      <div className="_memory-skill-screen">
        <Button onClick={props.onBack}>{t('skillScope.screen.back')}</Button>
        <Text theme="weak" parent="div">
          {t('skills.detail.versionsEmpty')}
        </Text>
      </div>
    );
  }
  const isCurrent = props.version === props.currentVersion;

  return (
    <div className="_memory-skill-screen">
      <div className="_memory-skill-screen-head">
        <div>
          <div className="_memory-skill-screen-title">
            {props.skillName} · v{props.version}
          </div>
        </div>
        <div className="_memory-skill-screen-actions">
          {!isCurrent && props.canRollback && (
            <SetVersionButton version={props.version} onClick={props.onSetVersion} />
          )}
          <Button onClick={props.onBack}>{t('skillScope.screen.back')}</Button>
        </div>
      </div>

      <VersionCard version={record} isCurrent={isCurrent} expanded />

      <div className="_memory-skill-section">
        <div className="_memory-skill-section-head">
          <Text theme="label" parent="div">
            {compareWith === undefined
              ? t('skillScope.detail.firstVersion')
              : t('skillScope.detail.diffTitle', { from: compareWith, to: props.version })}{' '}
            {diff && <DiffStats added={diff.added} removed={diff.removed} />}
            {!diff && firstLines && <DiffStats added={firstLines.added} removed={0} />}
          </Text>
          <span className="_memory-skill-compare-pick">
            {t('skillScope.detail.compareWith')}{' '}
            <Select
              appearance="button"
              size="s"
              value={compareWith === undefined ? '' : String(compareWith)}
              onChange={(v) => setCompareWith(v ? Number(v) : undefined)}
              options={[{ value: '', text: t('skillScope.detail.compareNone') }, ...options]}
            />
          </span>
        </div>
        {loading && <Text theme="weak">{t('skills.detail.loading')}</Text>}
        {(error || firstError) && <Text theme="danger">{error || firstError}</Text>}
        {diff && <DiffView lines={diff.lines} approximate={diff.approximate} />}
        {!diff && firstLines && <DiffView lines={firstLines.lines} />}
      </div>

      <div className="_memory-skill-section">
        <Text theme="label" parent="div">
          {t('skills.detail.files', { count: manifest?.length ?? 0 })}
        </Text>
        {manifestError && <Text theme="danger" parent="div">{manifestError}</Text>}
        {manifest && manifest.length === 0 && (
          <Text theme="weak" parent="div">
            {t('skills.detail.noFiles')}
          </Text>
        )}
        {manifest && manifest.length > 0 && (
          <div className="_memory-skill-files-box">
            <FileTreeView nodes={fileTree} onPick={(path) => void viewFile(path)} />
          </div>
        )}
      </div>

      {filePreview && (
        <Modal visible caption={filePreview.path} size="xl" onClose={() => setFilePreview(null)}>
          <Modal.Body>
            {fileLoading ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.loading')}
              </Text>
            ) : filePreview.encoding === 'base64' ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.binaryFile', { size: filePreview.size_bytes })}
              </Text>
            ) : (
              <pre className="_memory-skill-file-content">{filePreview.content}</pre>
            )}
          </Modal.Body>
        </Modal>
      )}
    </div>
  );
}
