/** Line diff in unified or side-by-side layout. Unchanged runs far from a change are collapsed. */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { collapseUnchanged, type DiffRow } from '../lib/skill-scope';
import '../styles/skill-scope.css';

export type DiffMode = 'unified' | 'split';

interface SplitRow {
  left?: DiffRow;
  right?: DiffRow;
}

/** Pair each run of removed lines with the added lines that follow it. */
function toSplitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.type === 'unchanged') {
      out.push({ left: row, right: row });
      i++;
      continue;
    }
    const removed: DiffRow[] = [];
    const added: DiffRow[] = [];
    while (i < rows.length && rows[i].type === 'removed') removed.push(rows[i++]);
    while (i < rows.length && rows[i].type === 'added') added.push(rows[i++]);
    const n = Math.max(removed.length, added.length);
    for (let k = 0; k < n; k++) out.push({ left: removed[k], right: added[k] });
  }
  return out;
}

const MARK: Record<DiffRow['type'], string> = { added: '+', removed: '-', unchanged: ' ' };

export function DiffStats({ added, removed }: { added: number; removed: number }) {
  const { t } = useTranslation();
  return (
    <span className="_memory-skill-diff-stats">
      <span className="_memory-skill-diff-stat--add">+{added}</span>{' '}
      <span className="_memory-skill-diff-stat--del">{`−${removed}`}</span>{' '}
      {t('skillScope.diff.lines')}
    </span>
  );
}

export function DiffView({
  lines,
  mode = 'unified',
  approximate = false,
}: {
  lines: DiffRow[];
  mode?: DiffMode;
  approximate?: boolean;
}) {
  const { t } = useTranslation();
  const blocks = useMemo(() => collapseUnchanged(lines), [lines]);
  const hasChange = lines.some((l) => l.type !== 'unchanged');

  if (!hasChange) {
    return <div className="_memory-skill-diff-empty">{t('skillScope.diff.noChanges')}</div>;
  }

  const collapsed = (count: number, key: number) => (
    <div key={`c${key}`} className="_memory-skill-diff-collapsed">
      {t('skillScope.diff.unchangedLines', { count })}
    </div>
  );

  return (
    <div className="_memory-skill-diff" data-mode={mode}>
      {approximate && <div className="_memory-skill-diff-note">{t('skillScope.diff.approximate')}</div>}
      {mode === 'unified'
        ? blocks.map((b, idx) =>
            b.kind === 'collapsed' ? (
              collapsed(b.count, idx)
            ) : (
              <div key={idx} className={`_memory-skill-diff-row _memory-skill-diff-row--${b.row.type}`}>
                <span className="_memory-skill-diff-no">{b.row.old_line ?? ''}</span>
                <span className="_memory-skill-diff-no">{b.row.new_line ?? ''}</span>
                <span className="_memory-skill-diff-mark">{MARK[b.row.type]}</span>
                <span className="_memory-skill-diff-text">{b.row.text}</span>
              </div>
            ),
          )
        : splitBlocks(blocks, collapsed)}
    </div>
  );
}

function splitBlocks(
  blocks: ReturnType<typeof collapseUnchanged>,
  collapsed: (count: number, key: number) => JSX.Element,
) {
  const out: JSX.Element[] = [];
  let run: DiffRow[] = [];
  const flush = (key: number) => {
    if (run.length === 0) return;
    toSplitRows(run).forEach((r, i) => {
      out.push(
        <div key={`s${key}-${i}`} className="_memory-skill-diff-split">
          {[r.left, r.right].map((side, k) => (
            <div
              key={k}
              className={`_memory-skill-diff-row _memory-skill-diff-row--${side ? side.type : 'empty'}`}
            >
              <span className="_memory-skill-diff-no">{side ? (k === 0 ? side.old_line : side.new_line) ?? '' : ''}</span>
              <span className="_memory-skill-diff-text">{side?.text ?? ''}</span>
            </div>
          ))}
        </div>,
      );
    });
    run = [];
  };
  blocks.forEach((b, idx) => {
    if (b.kind === 'collapsed') {
      flush(idx);
      out.push(collapsed(b.count, idx));
    } else {
      run.push(b.row);
    }
  });
  flush(blocks.length);
  return out;
}
