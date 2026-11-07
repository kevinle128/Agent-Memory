/**
 * Small parts that the three Processing History tabs share: id and time
 * display, the score bar, the status pill, the link to an L0 session, the
 * error text and the 👍/👎 bar.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from 'tea-component';
import { ApiError } from '@/lib/api/base';
import { getErrorMessage } from '@/lib/error-message';
import type { FeedbackEntry, FeedbackRating } from '@/lib/api/processing-history';

/** "7f3a…c21": enough to tell ids apart in a table. */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-3)}` : id;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'blue' | 'plain';

export function Pill({ tone = 'plain', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`_ph-pill _ph-pill--${tone}`}>{children}</span>;
}

/** Score in 0..1 as a bar and two decimals. */
export function ScoreBar({ score }: { score?: number }) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return <span className="_ph-mut">—</span>;
  const pct = Math.max(0, Math.min(1, score)) * 100;
  return (
    <span className="_ph-score">
      <span className="_ph-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="_ph-mono">{score.toFixed(3)}</span>
    </span>
  );
}

/** Opens the session in Chat_Memory → L0. Works for agents of the current user. */
export function SessionLink(props: { agentId?: string | null; sessionId?: string | null; messageId?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (!props.agentId || !props.sessionId) return null;
  const qs = new URLSearchParams({ agent: props.agentId, session: props.sessionId });
  if (props.messageId) qs.set('message', props.messageId);
  return (
    <button type="button" className="_ph-link" onClick={() => navigate(`/memory?${qs.toString()}`)}>
      {t('history.openSession')} ↗
    </button>
  );
}

/** Error text of a failed call. Known server codes get a translated text. */
export function useErrorText(): (err: unknown) => string {
  const { t } = useTranslation();
  return useCallback(
    (err: unknown) => {
      const raw = err instanceof ApiError ? (err.rawMessage ?? '') : '';
      const code = raw.split(':')[0]?.trim() ?? '';
      const key = `history.error.${code}`;
      const text = code ? t(key) : '';
      return text && text !== key ? text : getErrorMessage(err);
    },
    [t],
  );
}

export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="_ph-section">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

/**
 * 👍/👎 on one record, with an optional note. A click on the active button
 * removes the rating. Ratings of other admins are shown as counts.
 */
export function FeedbackBar(props: {
  entries: FeedbackEntry[];
  userId: string;
  busy: boolean;
  onSet: (rating: FeedbackRating | null, note: string) => void;
  upLabel: string;
  downLabel: string;
}) {
  const { t } = useTranslation();
  const mine = props.entries.find((e) => e.user_id === props.userId);
  const [note, setNote] = useState(mine?.note ?? '');
  useEffect(() => setNote(mine?.note ?? ''), [mine?.note, mine?.target_id]);
  const up = props.entries.filter((e) => e.rating === 'up').length;
  const down = props.entries.filter((e) => e.rating === 'down').length;
  const others = props.entries.filter((e) => e.user_id !== props.userId && e.note);
  const click = (rating: FeedbackRating) => props.onSet(mine?.rating === rating ? null : rating, note);

  return (
    <div className="_ph-feedback">
      <div className="_ph-feedback-row">
        <Button
          type={mine?.rating === 'up' ? 'primary' : 'weak'}
          disabled={props.busy}
          onClick={() => click('up')}
        >
          👍 {props.upLabel}
        </Button>
        <Button
          type={mine?.rating === 'down' ? 'primary' : 'weak'}
          disabled={props.busy}
          onClick={() => click('down')}
        >
          👎 {props.downLabel}
        </Button>
        <span className="_ph-mut">{t('history.feedback.counts', { up, down })}</span>
      </div>
      <div className="_ph-feedback-row">
        <textarea
          className="_ph-textarea"
          rows={2}
          maxLength={1000}
          placeholder={t('history.feedback.notePlaceholder')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {mine && (
          <Button disabled={props.busy || note === mine.note} onClick={() => props.onSet(mine.rating, note)}>
            {t('history.feedback.saveNote')}
          </Button>
        )}
      </div>
      {others.length > 0 && (
        <ul className="_ph-notes">
          {others.map((e) => (
            <li key={e.user_id}>
              {e.rating === 'up' ? '👍' : '👎'} <span className="_ph-mono">{shortId(e.user_id)}</span>: {e.note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Time windows of the filter bars. */
export const RANGE_HOURS = [24, 24 * 7, 24 * 30] as const;
export type RangeHours = (typeof RANGE_HOURS)[number];

export function sinceIso(hours: RangeHours): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}
