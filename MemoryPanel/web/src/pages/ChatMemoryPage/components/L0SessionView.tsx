/**
 * L0 view in two columns: the session list on the left (grouped by day) and
 * the conversation of the selected session on the right, in message order.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from 'tea-component';
import { InfoCircleIcon } from 'tea-icons-react';
import type { ChatMemoryLayerItem, ChatMemorySession } from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';
import type { L0SessionsStore } from '../hooks/useL0Sessions';
import { copyToClipboard } from '../utils/memory-utils';
import { extractRole, formatDisplayTime } from '../utils/utils';

type L0Tone = 'user' | 'assistant' | 'system' | 'tool';
function toneOfRole(role: string): L0Tone {
  if (role === 'user') return 'user';
  if (role === 'system') return 'system';
  if (role === 'tool') return 'tool';
  return 'assistant';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local calendar day as YYYY-MM-DD. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clockTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-3)}` : id;
}

/** Sessions grouped by the local day of their last message, newest day first. */
function groupByDay(sessions: ChatMemorySession[]): Array<{ day: string; items: ChatMemorySession[] }> {
  const groups: Array<{ day: string; items: ChatMemorySession[] }> = [];
  for (const s of sessions) {
    const d = s.last_ts ? new Date(s.last_ts) : null;
    const day = d && !Number.isNaN(d.getTime()) ? dayKey(d) : '';
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(s);
    else groups.push({ day, items: [s] });
  }
  return groups;
}

/** Messages with runs of tool messages folded into one row when tools are hidden. */
type ConversationRow =
  | { kind: 'message'; msg: ChatMemoryLayerItem; role: string }
  | { kind: 'tools'; key: string; count: number };

function buildRows(messages: ChatMemoryLayerItem[], showTools: boolean): ConversationRow[] {
  const rows: ConversationRow[] = [];
  for (const msg of messages) {
    const role = extractRole(msg.role || msg.title || '');
    if (role === 'tool' && !showTools) {
      const last = rows[rows.length - 1];
      if (last && last.kind === 'tools') last.count += 1;
      else rows.push({ kind: 'tools', key: `tools-${msg.id}`, count: 1 });
      continue;
    }
    rows.push({ kind: 'message', msg, role });
  }
  return rows;
}

export function L0SessionView({
  l0,
  timeFiltered,
  onShowSessionMemories,
}: {
  l0: L0SessionsStore;
  /** The session list is limited by the time range (changes the empty text). */
  timeFiltered: boolean;
  /** Open L1 filtered by a session. */
  onShowSessionMemories: (sessionId: string, title: string) => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [showTools, setShowTools] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const today = dayKey(new Date());
  const yesterday = dayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
  function dayLabel(day: string): string {
    if (!day) return '—';
    if (day === today) return `${t('memory.l0.today')} · ${day}`;
    if (day === yesterday) return `${t('memory.l0.yesterday')} · ${day}`;
    return day;
  }

  const visibleSessions = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return l0.sessions;
    return l0.sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.session_id.toLowerCase().includes(q) ||
        (s.project_name ?? '').toLowerCase().includes(q),
    );
  }, [l0.sessions, filter]);
  const groups = useMemo(() => groupByDay(visibleSessions), [visibleSessions]);

  const toolCount = useMemo(
    () => l0.messages.filter((m) => extractRole(m.role || m.title || '') === 'tool').length,
    [l0.messages],
  );
  const rows = useMemo(() => buildRows(l0.messages, showTools), [l0.messages, showTools]);

  // A new session starts at the top with tool calls hidden.
  useEffect(() => {
    setShowTools(false);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [l0.selectedSessionId]);

  // Scroll to the focused message once it is loaded. A hidden tool message is shown first.
  const focusId = l0.focusMessageId;
  const focusLoaded = !!focusId && l0.messages.some((m) => m.id === focusId);
  useEffect(() => {
    if (!focusId || !focusLoaded) return;
    const focusMsg = l0.messages.find((m) => m.id === focusId);
    if (focusMsg && extractRole(focusMsg.role || focusMsg.title || '') === 'tool' && !showTools) {
      setShowTools(true);
      return;
    }
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(focusId)}"]`);
    el?.scrollIntoView({ block: 'center' });
  }, [focusId, focusLoaded, showTools, l0.messages]);

  const sel = l0.selectedSession;
  const selId = l0.selectedSessionId;
  const title = sel?.title || (selId ? t('memory.l0.untitled') : '');

  async function copySessionId() {
    if (!selId) return;
    const ok = await copyToClipboard(selId);
    if (ok) tea.notify.success(t('memory.notify.copied'));
    else tea.notify.error(t('memory.notify.copyFailed'));
  }

  return (
    <div className="_memory-l0">
      <div className="_memory-l0-sessions">
        <div className="_memory-l0-sessions-filter">
          <Input
            size="full"
            value={filter}
            onChange={(v) => setFilter(v)}
            placeholder={t('memory.l0.filterPlaceholder')}
          />
        </div>
        <div className="_memory-l0-sessions-list">
          {l0.sessionsLoading ? (
            <div className="_memory-l0-hint">{t('memory.detail.loading')}</div>
          ) : visibleSessions.length === 0 ? (
            <div className="_memory-l0-hint">
              {l0.sessions.length > 0
                ? t('memory.l0.noSessionsMatch')
                : timeFiltered
                  ? t('memory.l0.noSessionsInRange')
                  : t('memory.detail.noL0')}
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.day || 'unknown'}>
                <div className="_memory-l0-day">{dayLabel(g.day)}</div>
                {g.items.map((s) => {
                  const active = s.session_id === selId;
                  const project = s.project_name || '—';
                  return (
                    <button
                      type="button"
                      key={s.session_id}
                      className={`_memory-l0-session${active ? ' _memory-l0-session--active' : ''}`}
                      onClick={() => l0.openSession(s.session_id)}
                      title={s.session_id}
                    >
                      <div className="_memory-l0-session-title">{s.title || t('memory.l0.untitled')}</div>
                      <div className="_memory-l0-session-meta">
                        <span>
                          {clockTime(s.first_ts)} → {clockTime(s.last_ts)} · {project}
                        </span>
                        <span>
                          {t('memory.l0.msgCount', { count: s.message_count })} ·{' '}
                          <span
                            className={
                              s.l1_count > 0 ? '_memory-l0-l1-count' : '_memory-l0-l1-count--zero'
                            }
                            title={s.l1_count > 0 ? undefined : t('memory.l0.noL1Hint')}
                          >
                            {t('memory.l0.l1Count', { count: s.l1_count })}
                          </span>
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
          {!l0.sessionsLoading && l0.hasMoreSessions && !filter.trim() && (
            <div className="_memory-l0-more">
              <Button type="link" loading={l0.sessionsLoadingMore} onClick={() => void l0.loadMoreSessions()}>
                {t('memory.l0.loadMoreSessions', { loaded: l0.sessions.length, total: l0.sessionsTotal })}
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="_memory-l0-conv">
        {!selId ? (
          <div className="_memory-l0-hint">{t('memory.l0.selectSession')}</div>
        ) : (
          <>
            <div className="_memory-l0-conv-head">
              <div className="_memory-l0-conv-head-info">
                <div className="_memory-l0-conv-title" title={title}>
                  {title}
                </div>
                <div className="_memory-l0-conv-meta" title={selId}>
                  {[
                    t('memory.l0.sessionLabel', { id: shortId(selId) }),
                    sel?.project_name ? t('memory.l0.projectLabel', { name: sel.project_name }) : null,
                    t('memory.l0.messageTotal', { count: l0.messagesTotal }),
                    sel ? `${formatDisplayTime(sel.first_ts)} → ${clockTime(sel.last_ts)}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <div className="_memory-l0-conv-actions">
                {toolCount > 0 && (
                  <Button type="weak" onClick={() => setShowTools((v) => !v)}>
                    {showTools ? t('memory.l0.hideTools') : t('memory.l0.showTools', { count: toolCount })}
                  </Button>
                )}
                {sel && sel.l1_count > 0 && (
                  <Button type="weak" onClick={() => onShowSessionMemories(selId, sel.title)}>
                    {t('memory.l0.viewL1', { count: sel.l1_count })}
                  </Button>
                )}
                <Button type="weak" onClick={() => void copySessionId()}>
                  {t('memory.l0.copySessionId')}
                </Button>
              </div>
            </div>
            <div className="_memory-chat-scroll _memory-l0-conv-body" ref={scrollRef}>
              {l0.messagesLoading ? (
                <div className="_memory-l0-hint">{t('memory.detail.loading')}</div>
              ) : l0.messages.length === 0 ? (
                <div className="_memory-l0-hint">{t('memory.detail.noL0')}</div>
              ) : (
                <div className="_memory-chat-list">
                  {rows.map((row) => {
                    if (row.kind === 'tools') {
                      return (
                        <div key={row.key} className="_memory-l0-tools">
                          {t('memory.l0.toolsHidden', { count: row.count })}
                        </div>
                      );
                    }
                    const { msg, role } = row;
                    const tone = toneOfRole(role);
                    const time = formatDisplayTime(msg.created_at);
                    const focused = msg.id === focusId;
                    const l1Count = l0.l1CountByMessage.get(msg.id) ?? 0;
                    if (tone === 'system') {
                      return (
                        <div key={msg.id} data-msg-id={msg.id} className="_memory-chat-system">
                          <InfoCircleIcon size={12} />
                          <span className="_memory-chat-system-text">{msg.body}</span>
                          {time && <span className="_memory-chat-system-time">{time}</span>}
                        </div>
                      );
                    }
                    return (
                      <div
                        key={msg.id}
                        data-msg-id={msg.id}
                        className={`_memory-chat-row _memory-chat-row--${tone}${
                          focused ? ' _memory-l0-msg--focus' : ''
                        }`}
                      >
                        <div className="_memory-chat-main">
                          <div className="_memory-chat-meta">
                            <span className="_memory-chat-role">{role.toUpperCase()}</span>
                            {time && (
                              <span className="_memory-chat-time" title={msg.created_at}>
                                {time}
                              </span>
                            )}
                          </div>
                          <div className={`_memory-chat-bubble _memory-chat-bubble--${tone}`}>
                            <pre className="_memory-chat-body">{msg.body}</pre>
                          </div>
                          {l1Count > 0 && (
                            <button
                              type="button"
                              className="_memory-l0-msg-l1"
                              onClick={() => onShowSessionMemories(selId, sel?.title ?? '')}
                            >
                              {t('memory.l0.msgL1', { count: l1Count })}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {!l0.messagesLoading && l0.hasMoreMessages && (
                <div className="_memory-l0-more">
                  <Button
                    type="link"
                    loading={l0.messagesLoadingMore}
                    onClick={() => void l0.loadMoreMessages()}
                  >
                    {t('memory.l0.loadMoreMessages', {
                      loaded: l0.messages.length,
                      total: l0.messagesTotal,
                    })}
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
