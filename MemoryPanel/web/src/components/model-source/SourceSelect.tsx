/**
 * SourceSelect — dropdown that picks the model sources of one client.
 * A single-source client (Claude Code, Codex) picks exactly one source; every other client picks
 * many and shows them as tags. It holds no source state: the page writes a change and passes the
 * stored selection back in. Members get a read-only box.
 */
import './style.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClientSource, ClientSourceAgent } from '@/lib/api/client-sources';
import { exposedModelCount, filterOptions, selectedSources, sourceOptions, toggleSource } from '@/lib/client-sources';

interface Props {
  agent: ClientSourceAgent;
  sources: readonly ClientSource[];
  readOnly?: boolean;
  /** A write for this client is in flight. */
  busy?: boolean;
  /** Called with the full new selection. */
  onChange: (names: string[]) => void;
}

function Dot({ source }: { source: ClientSource }) {
  return <span className={`_memory-ms-dot _memory-ms-dot--${source.source_type}`} aria-hidden="true" />;
}

export function SourceSelect({ agent, sources, readOnly, busy, onChange }: Props) {
  const { t } = useTranslation();
  const single = agent.mode === 'single';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const chosen = useMemo(() => selectedSources(agent, sources), [agent, sources]);
  const options = useMemo(() => filterOptions(sourceOptions(agent, sources), query), [agent, sources, query]);
  const locked = Boolean(readOnly) || Boolean(busy);

  // Close on a click outside the box.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  function pick(name: string) {
    if (single) {
      setOpen(false);
      if (!agent.selected.includes(name)) onChange([name]);
      return;
    }
    onChange(toggleSource(agent.selected, name));
  }

  const kindLabel = (s: ClientSource) => t(s.source_type === 'subscription' ? 'clientSources.kind.sub' : 'clientSources.kind.api');
  const hint = single
    ? t('clientSources.hint.single')
    : t('clientSources.hint.multi', { count: exposedModelCount(chosen) });

  return (
    <div className="_memory-ms-select" ref={root}>
      <div className="_memory-ms-select-label">
        {t(single ? 'clientSources.label.single' : 'clientSources.label.multi')}
      </div>
      <div className="_memory-ms-select-wrap">
        <div
          className={`_memory-ms-select-box${locked ? ' _memory-ms-select-box--ro' : ''}`}
          role="combobox"
          aria-expanded={open}
          aria-label={t(single ? 'clientSources.label.single' : 'clientSources.label.multi')}
          tabIndex={locked ? -1 : 0}
          onClick={() => !locked && setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (!locked && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              setOpen((v) => !v);
            }
          }}
        >
          {chosen.length === 0 && (
            <span className="_memory-ms-select-ph">
              {t(single ? 'clientSources.empty.single' : 'clientSources.empty.multi')}
            </span>
          )}
          {single
            ? chosen.map((s) => (
                <span key={s.source_name} className="_memory-ms-one">
                  <Dot source={s} />
                  {s.source_name}
                  <span className="_memory-ms-weak">{kindLabel(s)} · {t('clientSources.models', { count: s.models_on })}</span>
                </span>
              ))
            : chosen.map((s) => (
                <span key={s.source_name} className={`_memory-ms-chip${s.enabled ? '' : ' _memory-ms-chip--off'}`}>
                  <Dot source={s} />
                  {s.source_name}
                  <span className="_memory-ms-weak">{s.models_on}</span>
                  {!s.enabled && <span className="_memory-ms-offtag">{t('clientSources.off')}</span>}
                  {!locked && (
                    <button
                      type="button"
                      className="_memory-ms-chip-x"
                      aria-label={t('clientSources.remove', { name: s.source_name })}
                      onClick={(e) => {
                        e.stopPropagation();
                        onChange(agent.selected.filter((n) => n !== s.source_name));
                      }}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
        </div>
        {open && (
          <div className="_memory-ms-select-list" role="listbox">
            <input
              className="_memory-ms-select-search"
              placeholder={t('clientSources.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            {options.length === 0 && <div className="_memory-ms-empty">{t('clientSources.noOptions')}</div>}
            {options.map((s) => {
              const on = agent.selected.includes(s.source_name);
              return (
                <div
                  key={s.source_name}
                  role="option"
                  aria-selected={on}
                  className={`_memory-ms-select-opt${on ? ' _memory-ms-select-opt--cur' : ''}`}
                  onClick={() => pick(s.source_name)}
                >
                  <input type={single ? 'radio' : 'checkbox'} checked={on} readOnly tabIndex={-1} />
                  <Dot source={s} />
                  <span>{s.source_name}</span>
                  <span className="_memory-ms-weak _memory-ms-select-meta">
                    {kindLabel(s)} · {t('clientSources.models', { count: s.models_on })}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="_memory-ms-help">{hint}</div>
    </div>
  );
}
