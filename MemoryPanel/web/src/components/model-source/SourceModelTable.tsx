/**
 * SourceModelTable — models of a source with search and bulk on/off for the filtered rows. It holds no model state: the page applies a change and passes the new list in.
 */
import './style.css';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Switch, Tag } from 'tea-component';
import { bulkChanges, countAvailable, countEnabled, filterModels } from '@/lib/model-source';
import type { SourceModel } from '@/lib/api/model-providers';

export type ModelChange = { id: string; enabled: boolean };

interface Props {
  models: readonly SourceModel[];
  sourceName: string;
  readOnly?: boolean;
  /** A write is in flight. */
  busy?: boolean;
  /** Pool source whose pool is off: rows look dim. */
  dimmed?: boolean;
  onChange: (changes: ModelChange[]) => void;
}

export function SourceModelTable({ models, sourceName, readOnly, busy, dimmed, onChange }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const visible = useMemo(() => filterModels(models, query), [models, query]);
  const locked = Boolean(readOnly) || Boolean(busy);
  const filtered = query.trim() !== '';
  const canOn = bulkChanges(visible, true).length > 0;
  const canOff = bulkChanges(visible, false).length > 0;

  return (
    <div className={`_memory-ms-models${dimmed ? ' _memory-ms-dim' : ''}`}>
      <div className="_memory-ms-toolbar">
        <Input
          value={query}
          onChange={setQuery}
          placeholder={t('modelSource.models.search')}
          size="m"
          autoComplete="off"
        />
        {!readOnly && (
          <>
            <Button type="weak" disabled={locked || !canOn} onClick={() => onChange(bulkChanges(visible, true))}>
              {t(filtered ? 'modelSource.models.onFiltered' : 'modelSource.models.onAll')}
            </Button>
            <Button type="weak" disabled={locked || !canOff} onClick={() => onChange(bulkChanges(visible, false))}>
              {t(filtered ? 'modelSource.models.offFiltered' : 'modelSource.models.offAll')}
            </Button>
          </>
        )}
        <span className="_memory-ms-count">
          {t('modelSource.models.count', { on: countEnabled(models), total: countAvailable(models) })}
        </span>
      </div>
      <div className="_memory-ms-models-body" role="list">
        {visible.length === 0 ? (
          <div className="_memory-ms-empty">
            {models.length === 0 ? t('modelSource.models.empty') : t('modelSource.models.noMatch', { query })}
          </div>
        ) : (
          visible.map((m) => {
            const disabled = locked || !m.available;
            return (
              <div key={m.id} className={`_memory-ms-model${m.available ? '' : ' _memory-ms-gone'}`} role="listitem">
                <div>
                  <div className="_memory-ms-id">
                    {m.id}
                    {!m.available && <Tag>{t('modelSource.models.gone')}</Tag>}
                  </div>
                  <div className="_memory-ms-id">
                    <span className="_memory-ms-weak">→ {sourceName || '…'}/</span>
                    {m.id}
                  </div>
                </div>
                <Switch
                  value={m.enabled}
                  disabled={disabled}
                  onChange={(v) => onChange([{ id: m.id, enabled: v }])}
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
