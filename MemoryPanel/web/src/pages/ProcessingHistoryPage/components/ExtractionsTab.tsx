/**
 * Extractions: one row per memory generation run (L1, L2, L3). The detail
 * shows the input and output records, the prompt version, the model, the
 * error and the L3 scope check. The raw LLM output and the dedup decisions
 * are not stored; with a Langfuse project URL the run links to its session.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Select } from 'tea-component';
import { formatSaigon } from '@/pages/SkillsPage/lib/skill-scope';
import {
  processingHistoryApi,
  type ExtractionItem,
  type ExtractionStatusFilter,
  type GenerationLayer,
  type GenerationLog,
  type GenerationRef,
} from '@/lib/api/processing-history';
import { useFeedback } from '../hooks/useFeedback';
import {
  DetailSection,
  FeedbackBar,
  Pill,
  RANGE_HOURS,
  SessionLink,
  shortId,
  useErrorText,
  type RangeHours,
} from './shared';

const PAGE_SIZE = 30;
const MAX_REFS_SHOWN = 30;

function isEmptyRun(log: GenerationLog): boolean {
  return log.status === 'succeeded' && log.output_refs.length === 0;
}

function countByLayer(refs: GenerationRef[]): string {
  const counts = new Map<string, number>();
  for (const r of refs) counts.set(r.layer, (counts.get(r.layer) ?? 0) + 1);
  return [...counts.entries()].map(([layer, n]) => `${n} ${layer.toUpperCase()}`).join(' · ') || '0';
}

function StatusPill({ log }: { log: GenerationLog }) {
  const { t } = useTranslation();
  if (log.status === 'failed') return <Pill tone="bad">{t('history.status.failed')}</Pill>;
  if (isEmptyRun(log)) return <Pill tone="warn">{t('history.status.empty')}</Pill>;
  return <Pill tone="ok">{t('history.status.succeeded')}</Pill>;
}

function RefList({ refs }: { refs: GenerationRef[] }) {
  const { t } = useTranslation();
  if (refs.length === 0) return <div className="_ph-mut">—</div>;
  return (
    <div className="_ph-refs">
      {refs.slice(0, MAX_REFS_SHOWN).map((r) => (
        <span key={`${r.layer}:${r.record_id}`} className="_ph-mono _ph-ref" title={r.record_id}>
          {r.layer.toUpperCase()} {shortId(r.record_id)}
        </span>
      ))}
      {refs.length > MAX_REFS_SHOWN && (
        <span className="_ph-mut">{t('history.extractions.moreRefs', { count: refs.length - MAX_REFS_SHOWN })}</span>
      )}
    </div>
  );
}

export function ExtractionsTab(props: {
  teamId: string;
  agents: Array<{ agent_id: string; name: string }>;
  langfuseProjectUrl: string | null;
}) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [layer, setLayer] = useState<GenerationLayer | ''>('');
  const [status, setStatus] = useState<ExtractionStatusFilter | ''>('');
  const [sessionId, setSessionId] = useState('');
  const [sessionInput, setSessionInput] = useState('');
  const [range, setRange] = useState<RangeHours>(24 * 7);
  const [items, setItems] = useState<ExtractionItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [scanned, setScanned] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(
    async (from?: string) => {
      setLoading(true);
      setError(null);
      try {
        const end = new Date();
        const start = new Date(end.getTime() - range * 3_600_000);
        const page = await processingHistoryApi.extractions({
          teamId: props.teamId,
          limit: PAGE_SIZE,
          cursor: from,
          layer: layer || undefined,
          status: status || undefined,
          sessionId: sessionId || undefined,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
        });
        setItems((prev) => (from ? [...prev, ...page.items] : page.items));
        setCursor(page.next_cursor);
        setScanned((prev) => (from ? prev : 0) + (page.scanned ?? page.items.length));
        if (!from) setSelectedId(page.items[0]?.log_id ?? null);
      } catch (err) {
        setError(errorText(err));
        if (!from) setItems([]);
        setCursor(undefined);
      } finally {
        setLoading(false);
      }
    },
    [props.teamId, layer, status, sessionId, range, errorText],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const ids = useMemo(() => items.map((i) => i.log_id), [items]);
  const feedback = useFeedback(props.teamId, 'extraction', ids);
  const selected = items.find((i) => i.log_id === selectedId)?.log ?? null;
  const agentName = (id?: string) => props.agents.find((a) => a.agent_id === id)?.name ?? shortId(id);

  return (
    <div className="_ph-row">
      <div className="_ph-list">
        <div className="_ph-filters">
          <Select
            size="s"
            value={layer}
            onChange={(v) => setLayer(v as GenerationLayer | '')}
            options={[
              { value: '', text: t('history.filter.allLayers') },
              { value: 'l1', text: 'L1' },
              { value: 'l2', text: 'L2' },
              { value: 'l3', text: 'L3' },
            ]}
          />
          <Select
            size="m"
            value={status}
            onChange={(v) => setStatus(v as ExtractionStatusFilter | '')}
            options={[
              { value: '', text: t('history.filter.allStatuses') },
              { value: 'succeeded', text: t('history.status.succeeded') },
              { value: 'empty', text: t('history.status.empty') },
              { value: 'failed', text: t('history.status.failed') },
            ]}
          />
          <input
            className="_ph-input"
            placeholder={t('history.filter.sessionPlaceholder')}
            value={sessionInput}
            onChange={(e) => setSessionInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setSessionId(sessionInput.trim());
            }}
            onBlur={() => setSessionId(sessionInput.trim())}
          />
          <Select
            size="s"
            value={String(range)}
            onChange={(v) => setRange(Number(v) as RangeHours)}
            options={RANGE_HOURS.map((h) => ({ value: String(h), text: t(`history.range.${h}`) }))}
          />
          <Button type="weak" loading={loading} onClick={() => void load()}>
            {t('history.refresh')}
          </Button>
        </div>
        {error && <div className="_ph-error">{error}</div>}
        <table className="_ph-table">
          <thead>
            <tr>
              <th>{t('history.col.time')}</th>
              <th>{t('history.col.layer')}</th>
              <th>{t('history.col.agent')}</th>
              <th>{t('history.col.session')}</th>
              <th>{t('history.col.input')}</th>
              <th>{t('history.col.output')}</th>
              <th>{t('history.col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map(({ log }) => (
              <tr
                key={log.log_id}
                className={log.log_id === selectedId ? '_ph-sel' : ''}
                onClick={() => setSelectedId(log.log_id)}
              >
                <td className="_ph-nowrap">{formatSaigon(log.finished_at_ms)}</td>
                <td>{log.layer.toUpperCase()}</td>
                <td>{agentName(log.agent_id)}</td>
                <td className="_ph-mono">{shortId(log.session_id)}</td>
                <td>{countByLayer(log.input_refs)}</td>
                <td>{countByLayer(log.output_refs)}</td>
                <td className="_ph-nowrap">
                  <StatusPill log={log} /> <span className="_ph-mut">{(log.latency_ms / 1000).toFixed(1)}s</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !error && items.length === 0 && (
          <div className="_ph-empty">
            {cursor ? t('history.extractions.noneYet', { scanned }) : t('history.extractions.empty')}
          </div>
        )}
        {cursor && (
          <div className="_ph-more">
            <Button loading={loading} onClick={() => void load(cursor)}>
              {t('history.extractions.loadMore')}
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
              <b>
                {t('history.extractions.title', {
                  layer: selected.layer.toUpperCase(),
                  time: formatSaigon(selected.finished_at_ms),
                })}
              </b>{' '}
              <StatusPill log={selected} />
            </div>
            <div className="_ph-mut">
              {t('history.extractions.prompt', {
                id: selected.prompt.memory_prompt_id,
                version: selected.prompt.version,
                source: selected.prompt.source,
                sha: selected.prompt.prompt_sha256 ? selected.prompt.prompt_sha256.slice(0, 8) : '—',
              })}
              {' · '}
              {t('history.extractions.model', { model: selected.model ?? '—', mode: selected.prompt_mode ?? '—' })}
            </div>
            <div className="_ph-mut _ph-mono">{selected.log_id}</div>

            {(selected.error_code || selected.error_message) && (
              <DetailSection title={t('history.extractions.error')}>
                <div className="_ph-error">
                  {selected.error_code}
                  {selected.error_kind ? ` (${selected.error_kind})` : ''} {selected.error_message}
                </div>
              </DetailSection>
            )}

            <DetailSection title={t('history.extractions.input', { count: selected.input_refs.length })}>
              <div className="_ph-mut">
                {t('history.extractions.inputFrom', {
                  agent: agentName(selected.agent_id),
                  session: selected.session_id ? shortId(selected.session_id) : '—',
                })}{' '}
                {selected.input_refs.some((r) => r.layer === 'l0') && (
                  <SessionLink
                    agentId={selected.agent_id}
                    sessionId={selected.session_id}
                    messageId={selected.input_refs.find((r) => r.layer === 'l0')?.record_id}
                  />
                )}
              </div>
              <RefList refs={selected.input_refs} />
            </DetailSection>

            <DetailSection title={t('history.extractions.output', { count: selected.output_refs.length })}>
              {isEmptyRun(selected) ? (
                <div className="_ph-mut">
                  {t('history.extractions.emptyOutput')}
                  {selected.empty_reason && (
                    <>
                      {' '}
                      {t('history.extractions.emptyReason', { reason: selected.empty_reason })}
                    </>
                  )}
                </div>
              ) : (
                <RefList refs={selected.output_refs} />
              )}
            </DetailSection>

            {selected.scope_check && (
              <DetailSection title={t('history.extractions.scopeCheck')}>
                <Pill tone={selected.scope_check.result === 'passed' ? 'ok' : 'warn'}>
                  {selected.scope_check.result}
                </Pill>{' '}
                <span className="_ph-mut">
                  {t('history.extractions.judgeAttempts', { count: selected.scope_check.judge_attempts })}
                  {selected.scope_check.reason ? ` · ${selected.scope_check.reason}` : ''}
                </span>
                {selected.scope_check.leaks && selected.scope_check.leaks.length > 0 && (
                  <ul className="_ph-notes">
                    {selected.scope_check.leaks.map((leak, i) => (
                      <li key={i}>{leak}</li>
                    ))}
                  </ul>
                )}
              </DetailSection>
            )}

            <DetailSection title={t('history.extractions.decisions')}>
              <div className="_ph-mut">{t('history.extractions.decisionsNotStored')}</div>
            </DetailSection>

            <DetailSection title={t('history.extractions.rawOutput')}>
              <div className="_ph-mut">{t('history.extractions.rawNotStored')}</div>
              {props.langfuseProjectUrl && selected.session_id && (
                <a
                  className="_ph-link"
                  href={`${props.langfuseProjectUrl}/sessions/${encodeURIComponent(selected.session_id)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('history.extractions.openLangfuse')} ↗
                </a>
              )}
            </DetailSection>

            <DetailSection title={t('history.feedback.title')}>
              <FeedbackBar
                key={selected.log_id}
                entries={feedback.of(selected.log_id)}
                userId={feedback.userId}
                busy={feedback.busyId === selected.log_id}
                onSet={(rating, note) => void feedback.set(selected.log_id, rating, note)}
                upLabel={t('history.feedback.extractionUp')}
                downLabel={t('history.feedback.extractionDown')}
              />
            </DetailSection>
          </>
        )}
      </div>
    </div>
  );
}
