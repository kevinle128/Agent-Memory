/**
 * Ratings of the records that a tab shows. Loads the ratings of the given
 * target ids and keeps them in sync after the user rates a record.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { tea } from '@/lib/tea-bridge';
import {
  processingHistoryApi,
  type FeedbackEntry,
  type FeedbackRating,
  type FeedbackTargetType,
} from '@/lib/api/processing-history';

export function useFeedback(teamId: string | null, targetType: FeedbackTargetType, targetIds: string[]) {
  const [entries, setEntries] = useState<FeedbackEntry[]>([]);
  const [userId, setUserId] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  // A stable key, so a new array with the same ids does not load again.
  const idsKey = targetIds.join('\u0000');

  useEffect(() => {
    if (!teamId || !idsKey) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    const ids = idsKey.split('\u0000');
    processingHistoryApi
      .feedbackList(
        teamId,
        ids.map((id) => ({ target_type: targetType, target_id: id })),
      )
      .then((res) => {
        if (cancelled) return;
        setEntries(res.items);
        setUserId(res.user_id);
      })
      .catch((err) => {
        if (!cancelled) tea.notify.error(err);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, targetType, idsKey]);

  const byTarget = useMemo(() => {
    const map = new Map<string, FeedbackEntry[]>();
    for (const e of entries) map.set(e.target_id, [...(map.get(e.target_id) ?? []), e]);
    return map;
  }, [entries]);

  const set = useCallback(
    async (targetId: string, rating: FeedbackRating | null, note: string) => {
      if (!teamId) return;
      setBusyId(targetId);
      try {
        const res = await processingHistoryApi.feedbackSet({ teamId, targetType, targetId, rating, note });
        setEntries((prev) => {
          const rest = prev.filter((e) => !(e.target_id === targetId && e.user_id === userId));
          return res.entry ? [...rest, res.entry] : rest;
        });
        if (res.entry) setUserId(res.entry.user_id);
      } catch (err) {
        tea.notify.error(err);
      } finally {
        setBusyId(null);
      }
    },
    [teamId, targetType, userId],
  );

  const of = useCallback((targetId: string) => byTarget.get(targetId) ?? [], [byTarget]);
  return { of, set, userId, busyId };
}
