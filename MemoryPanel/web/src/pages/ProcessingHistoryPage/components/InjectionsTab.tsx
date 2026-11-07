/**
 * Injections: one row per client-hook recall request. The detail shows the
 * query, every candidate with its score and the decision about it, and the
 * exact text that went to the model.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Select } from 'tea-component';
import { formatSaigon } from '@/pages/SkillsPage/lib/skill-scope';
import {
  processingHistoryApi,
  type CandidateDecision,
  type InjectionEntry,
  type RecallOutcome,
} from '@/lib/api/processing-history';
import { useFeedback } from '../hooks/useFeedback';
import {
  DetailSection,
  FeedbackBar,
  Pill,
  RANGE_HOURS,
  ScoreBar,
  SessionLink,
  shortId,
  sinceIso,
  useErrorText,
  type RangeHours,
  type Tone,
} from './shared';

const PAGE_SIZE = 50;
const OUTCOMES: RecallOutcome[] = ['injected', 'empty', 'no_session', 'no_project', 'timeout', 'error'];

const DECISION_TONE: Record<CandidateDecision, Tone> = {
  injected: 'ok',
  below_min_score: 'plain',
  over_budget: 'warn',
  scope_blocked: 'bad',
};

const OUTCOME_TONE: Record<RecallOutcome, Tone> = {
  injected: 'ok',
  empty: 'warn',
  no_session: 'plain',
  no_project: 'plain',
  timeout: 'bad',
  error: 'bad',
};

export function InjectionsTab(props: {
  teamId: string;
  agents: Array<{ agent_id: string; name: string }>;
}) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [agentId, setAgentId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [sessionInput, setSessionInput] = useState('');
  const [outcome, setOutcome] = useState<RecallOutcome | ''>('');
  const [range, setRange] = useState<RangeHours>(24);
  const [items, setItems] = useState<InjectionEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setError(null);
      try {
        const page = await processingHistoryApi.injections({
          teamId: props.teamId,
          limit: PAGE_SIZE,
          offset,
          agentId: agentId || undefined,
          sessionId: sessionId || undefined,
          outcome: outcome || undefined,
          since: sinceIso(range),
        });
        setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
        setTotal(page.total);
        if (offset === 0) setSelectedId(page.items[0]?.id ?? null);
      } catch (err) {
        setError(errorText(err));
        if (offset === 0) setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [props.teamId, agentId, sessionId, outcome, range, errorText],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  const ids = useMemo(() => items.map((i) => String(i.id)), [items]);
  const feedback = useFeedback(props.teamId, 'injection', ids);
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const agentName = (id: string | null) => props.agents.find((a) => a.agent_id === id)?.name ?? shortId(id);

  return (
    <div className="_ph-row">
      <div className="_ph-list">
        <div className="_ph-filters">
          <Select
            size="m"
            value={agentId}
            onChange={setAgentId}
            options={[
              { value: '', text: t('history.filter.allAgents') },
              ...props.agents.map((a) => ({ value: a.agent_id, text: a.name })),
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
            size="m"
            value={outcome}
            onChange={(v) => setOutcome(v as RecallOutcome | '')}
            options={[
              { value: '', text: t('history.filter.allResults') },
              ...OUTCOMES.map((o) => ({ value: o, text: t(`history.outcome.${o}`) })),
            ]}
          />
          <Select
            size="s"
            value={String(range)}
            onChange={(v) => setRange(Number(v) as RangeHours)}
            options={RANGE_HOURS.map((h) => ({ value: String(h), text: t(`history.range.${h}`) }))}
          />
          <Button type="weak" loading={loading} onClick={() => void load(0)}>
            {t('history.refresh')}
          </Button>
        </div>
        {error && <div className="_ph-error">{error}</div>}
        <table className="_ph-table">
          <thead>
            <tr>
              <th>{t('history.col.time')}</th>
              <th>{t('history.col.agent')}</th>
              <th>{t('history.col.session')}</th>
              <th>{t('history.col.query')}</th>
              <th>{t('history.col.injected')}</th>
              <th>{t('history.col.tokens')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr
                key={row.id}
                className={row.id === selectedId ? '_ph-sel' : ''}
                onClick={() => setSelectedId(row.id)}
              >
                <td className="_ph-nowrap">{formatSaigon(row.createdAt)}</td>
                <td>{agentName(row.agentId)}</td>
                <td className="_ph-mono">{shortId(row.sessionId)}</td>
                <td className="_ph-clip">{row.query}</td>
                <td>
                  {row.outcome === 'injected' ? (
                    t('history.injections.injectedOf', { n: row.injectedCount, total: row.candidates.length })
                  ) : (
                    <Pill tone={OUTCOME_TONE[row.outcome]}>{t(`history.outcome.${row.outcome}`)}</Pill>
                  )}
                </td>
                <td>{row.tokens}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !error && items.length === 0 && <div className="_ph-empty">{t('history.injections.empty')}</div>}
        {items.length < total && (
          <div className="_ph-more">
            <Button loading={loading} onClick={() => void load(items.length)}>
              {t('history.loadMore', { shown: items.length, total })}
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
              <b>{t('history.injections.title', { time: formatSaigon(selected.createdAt) })}</b>{' '}
              <span className="_ph-mut _ph-mono">#{selected.id}</span>{' '}
              <Pill tone={OUTCOME_TONE[selected.outcome]}>{t(`history.outcome.${selected.outcome}`)}</Pill>
            </div>
            <div className="_ph-mut">
              {t('history.injections.meta', {
                agent: agentName(selected.agentId),
                client: selected.client ?? '—',
                project: selected.projectLabel ?? '—',
                latency: selected.latencyMs,
              })}{' '}
              <SessionLink agentId={selected.agentId} sessionId={selected.sessionId} />
            </div>
            {selected.error && <div className="_ph-error">{selected.error}</div>}

            <DetailSection title={t('history.injections.query')}>
              <div className="_ph-quote">{selected.query}</div>
            </DetailSection>

            <DetailSection title={t('history.injections.candidates', { count: selected.candidates.length })}>
              {selected.candidates.length === 0 ? (
                <div className="_ph-mut">{t('history.injections.noCandidates')}</div>
              ) : (
                <table className="_ph-table _ph-table--inner">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t('history.col.memory')}</th>
                      <th>{t('history.col.score')}</th>
                      <th>{t('history.col.decision')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.candidates.map((cand, i) => (
                      <tr key={`${cand.id}-${i}`}>
                        <td>{i + 1}</td>
                        <td>
                          <div className="_ph-clip2">{cand.preview || '—'}</div>
                          <div className="_ph-mut _ph-mono">
                            {shortId(cand.id)} · {agentName(cand.agentId)}
                          </div>
                        </td>
                        <td>
                          <ScoreBar score={cand.score} />
                        </td>
                        <td>
                          <Pill tone={DECISION_TONE[cand.decision]}>{t(`history.decision.${cand.decision}`)}</Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </DetailSection>

            <DetailSection
              title={t('history.injections.exactText', { tokens: selected.tokens })}
            >
              {selected.injectedText ? (
                <pre className="_ph-pre">{selected.injectedText}</pre>
              ) : (
                <div className="_ph-mut">{t('history.injections.nothingInjected')}</div>
              )}
            </DetailSection>

            <DetailSection title={t('history.feedback.title')}>
              <FeedbackBar
                key={selected.id}
                entries={feedback.of(String(selected.id))}
                userId={feedback.userId}
                busy={feedback.busyId === String(selected.id)}
                onSet={(rating, note) => void feedback.set(String(selected.id), rating, note)}
                upLabel={t('history.feedback.injectionUp')}
                downLabel={t('history.feedback.injectionDown')}
              />
            </DetailSection>
          </>
        )}
      </div>
    </div>
  );
}
