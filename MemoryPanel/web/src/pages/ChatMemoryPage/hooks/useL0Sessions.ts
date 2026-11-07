/**
 * useL0Sessions — state and data for the L0 view: the session list (left
 * column) and the conversation of the selected session (right column).
 *
 * The time range selects which sessions show in the list. It does not cut the
 * conversation: a selected session always loads from its first message.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tea } from '@/lib/tea-bridge';
import { chatMemoryApi, type ChatMemoryLayerItem, type ChatMemorySession } from '@/lib/teamApi';
import type { TimeRange } from '../utils/memory-utils';

/** Sessions per list page. */
export const SESSION_PAGE_SIZE = 50;
/** Messages per conversation page (the panel route accepts at most 200). */
export const SESSION_MESSAGE_PAGE_SIZE = 200;
/** L1 memories read for one session to count them per source message (kernel maximum). */
const SESSION_L1_LIMIT = 100;
/** Most pages a source link may load while it looks for its message (10 x 200 = 2000 messages). */
const MAX_FOCUS_PAGES = 10;

function errorText(e: unknown, fallback: string): string {
  return (e instanceof Error ? e.message : String(e)) || fallback;
}

export function useL0Sessions(params: {
  blockId?: string;
  /** False while another layer is open: no request is sent. */
  enabled: boolean;
  timeRange: TimeRange;
  refreshNonce: number;
}) {
  const { blockId, enabled, timeRange, refreshNonce } = params;
  const { t } = useTranslation();

  const [sessions, setSessions] = useState<ChatMemorySession[]>([]);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  // Mirror of focusMessageId for the session-list effect, which must not refetch when it changes.
  const focusMessageIdRef = useRef<string | null>(null);
  focusMessageIdRef.current = focusMessageId;

  const [messages, setMessages] = useState<ChatMemoryLayerItem[]>([]);
  const [messagesTotal, setMessagesTotal] = useState(0);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesLoadingMore, setMessagesLoadingMore] = useState(false);
  /** Source message id → number of L1 memories made from it (selected session only). */
  const [l1CountByMessage, setL1CountByMessage] = useState<Map<string, number>>(new Map());

  // A new block starts with a clean view.
  useEffect(() => {
    setSessions([]);
    setSessionsTotal(0);
    setSelectedSessionId(null);
    setFocusMessageId(null);
    setMessages([]);
    setMessagesTotal(0);
    setL1CountByMessage(new Map());
  }, [blockId]);

  // ── Session list ──
  const listSeqRef = useRef(0);
  useEffect(() => {
    if (!blockId || !enabled) return;
    const seq = ++listSeqRef.current;
    setSessionsLoading(true);
    chatMemoryApi
      .sessions(blockId, {
        limit: SESSION_PAGE_SIZE,
        offset: 0,
        timeStart: timeRange.start || undefined,
        timeEnd: timeRange.end || undefined,
      })
      .then((res) => {
        if (seq !== listSeqRef.current) return;
        setSessions(res.sessions);
        setSessionsTotal(res.total);
        // Keep a session opened from an L1 source link even when it is outside the list.
        // Otherwise a selection that the new range no longer contains moves to the first session.
        setSelectedSessionId((cur) => {
          if (cur && (focusMessageIdRef.current || res.sessions.some((s) => s.session_id === cur))) return cur;
          return res.sessions[0]?.session_id ?? null;
        });
      })
      .catch((e: unknown) => {
        if (seq !== listSeqRef.current) return;
        setSessions([]);
        setSessionsTotal(0);
        tea.notify.error(errorText(e, t('memory.notify.layerFailed')));
      })
      .finally(() => {
        if (seq === listSeqRef.current) setSessionsLoading(false);
      });
  }, [blockId, enabled, timeRange.start, timeRange.end, refreshNonce, t]);

  const hasMoreSessions = sessions.length < sessionsTotal;
  const loadMoreSessions = useCallback(async () => {
    if (!blockId || sessionsLoading || sessionsLoadingMore || !hasMoreSessions) return;
    const seq = listSeqRef.current;
    setSessionsLoadingMore(true);
    try {
      const res = await chatMemoryApi.sessions(blockId, {
        limit: SESSION_PAGE_SIZE,
        offset: sessions.length,
        timeStart: timeRange.start || undefined,
        timeEnd: timeRange.end || undefined,
      });
      if (seq !== listSeqRef.current) return;
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.session_id));
        return [...prev, ...res.sessions.filter((s) => !seen.has(s.session_id))];
      });
      setSessionsTotal(res.total);
    } catch (e: unknown) {
      tea.notify.error(errorText(e, t('memory.notify.layerFailed')));
    } finally {
      setSessionsLoadingMore(false);
    }
  }, [blockId, sessionsLoading, sessionsLoadingMore, hasMoreSessions, sessions.length, timeRange, t]);

  // ── Conversation of the selected session ──
  const msgSeqRef = useRef(0);
  useEffect(() => {
    if (!blockId || !enabled || !selectedSessionId) {
      // Invalidate requests in flight so a late response cannot refill the cleared view.
      ++msgSeqRef.current;
      setMessages([]);
      setMessagesTotal(0);
      setL1CountByMessage(new Map());
      return;
    }
    const seq = ++msgSeqRef.current;
    setMessagesLoading(true);
    setMessages([]);
    chatMemoryApi
      .layer(blockId, 'L0', SESSION_MESSAGE_PAGE_SIZE, 0, undefined, undefined, undefined, undefined, selectedSessionId)
      .then((res) => {
        if (seq !== msgSeqRef.current) return;
        setMessages(res.items);
        setMessagesTotal(res.total);
      })
      .catch((e: unknown) => {
        if (seq !== msgSeqRef.current) return;
        tea.notify.error(errorText(e, t('memory.notify.layerFailed')));
      })
      .finally(() => {
        if (seq === msgSeqRef.current) setMessagesLoading(false);
      });

    // L1 memories of this session, counted per source message for the "→ N L1" chip.
    // Memories written before the kernel kept source ids have no refs and add nothing.
    chatMemoryApi
      .layer(blockId, 'L1', SESSION_L1_LIMIT, 0, undefined, undefined, undefined, undefined, selectedSessionId)
      .then((res) => {
        if (seq !== msgSeqRef.current) return;
        const counts = new Map<string, number>();
        for (const item of res.items) {
          for (const ref of item.refs ?? []) counts.set(ref, (counts.get(ref) ?? 0) + 1);
        }
        setL1CountByMessage(counts);
      })
      .catch(() => {
        // The chip is extra information; the conversation still shows without it.
        if (seq === msgSeqRef.current) setL1CountByMessage(new Map());
      });
  }, [blockId, enabled, selectedSessionId, refreshNonce, t]);

  const hasMoreMessages = messages.length < messagesTotal;
  const loadMoreMessages = useCallback(async () => {
    if (!blockId || !selectedSessionId || messagesLoading || messagesLoadingMore || !hasMoreMessages) return;
    const seq = msgSeqRef.current;
    setMessagesLoadingMore(true);
    try {
      const res = await chatMemoryApi.layer(
        blockId,
        'L0',
        SESSION_MESSAGE_PAGE_SIZE,
        messages.length,
        undefined,
        undefined,
        undefined,
        undefined,
        selectedSessionId,
      );
      if (seq !== msgSeqRef.current) return;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...res.items.filter((m) => !seen.has(m.id))];
      });
      setMessagesTotal(res.total);
    } catch (e: unknown) {
      tea.notify.error(errorText(e, t('memory.notify.layerFailed')));
    } finally {
      setMessagesLoadingMore(false);
    }
  }, [blockId, selectedSessionId, messagesLoading, messagesLoadingMore, hasMoreMessages, messages.length, t]);

  // A source link can point past the first page: load pages until the message shows,
  // but stop after a fixed number of pages so a missing message cannot load a whole long session.
  const focusPagesRef = useRef(0);
  useEffect(() => {
    focusPagesRef.current = 0;
  }, [focusMessageId, selectedSessionId]);
  useEffect(() => {
    if (!focusMessageId || messagesLoading || messagesLoadingMore) return;
    if (messages.some((m) => m.id === focusMessageId)) return;
    if (!hasMoreMessages || focusPagesRef.current >= MAX_FOCUS_PAGES) return;
    focusPagesRef.current += 1;
    void loadMoreMessages();
  }, [focusMessageId, messages, messagesLoading, messagesLoadingMore, hasMoreMessages, loadMoreMessages]);

  /** Open a session. With `messageId`, the view scrolls to that message and highlights it. */
  const openSession = useCallback((sessionId: string, messageId?: string) => {
    setSelectedSessionId(sessionId);
    setFocusMessageId(messageId ?? null);
  }, []);

  const clearFocus = useCallback(() => setFocusMessageId(null), []);

  const selectedSession = useMemo(
    () => sessions.find((s) => s.session_id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  return {
    sessions,
    sessionsTotal,
    sessionsLoading,
    sessionsLoadingMore,
    hasMoreSessions,
    loadMoreSessions,
    selectedSessionId,
    selectedSession,
    openSession,
    focusMessageId,
    clearFocus,
    messages,
    messagesTotal,
    messagesLoading,
    messagesLoadingMore,
    hasMoreMessages,
    loadMoreMessages,
    l1CountByMessage,
  };
}

export type L0SessionsStore = ReturnType<typeof useL0Sessions>;
