/**
 * ProviderTable — API-key model sources: source, provider, base URL, formats, selected models,
 * status and delete. People who cannot edit get no status switch and no delete button.
 */
import { useTranslation } from 'react-i18next';
import { Button, Switch, Tag } from 'tea-component';
import { countAvailable, countEnabled, presetOf } from '@/lib/model-source';
import type { ProviderGroup } from '@/lib/api/model-providers';

interface Props {
  groups: readonly ProviderGroup[];
  readOnly: boolean;
  busyIds: ReadonlySet<string>;
  onModels: (group: ProviderGroup) => void;
  onDelete: (group: ProviderGroup) => void;
  onToggle: (group: ProviderGroup, on: boolean) => void;
}

/** A source serves clients only when its group and its source switch are both on. */
export function sourceIsOn(group: ProviderGroup): boolean {
  return group.enabled && group.source_enabled;
}

export function ProviderTable({ groups, readOnly, busyIds, onModels, onDelete, onToggle }: Props) {
  const { t } = useTranslation();
  return (
    <div className="_memory-ms-table-wrap" style={{ maxWidth: 'none' }}>
      <table className="_memory-ms-table">
        <thead>
          <tr>
            <th>{t('modelProvider.col.source')}</th>
            <th>{t('modelProvider.col.provider')}</th>
            <th>{t('modelProvider.col.baseUrl')}</th>
            <th>{t('modelProvider.col.formats')}</th>
            <th>{t('modelProvider.col.models')}</th>
            <th>{t('modelProvider.col.status')}</th>
            {!readOnly && <th>{t('modelProvider.col.actions')}</th>}
          </tr>
        </thead>
        <tbody>
          {groups.length === 0 && (
            <tr><td colSpan={readOnly ? 6 : 7} className="_memory-ms-empty">{t('modelProvider.empty')}</td></tr>
          )}
          {groups.map((g) => {
            const busy = busyIds.has(g.group_id);
            const on = sourceIsOn(g);
            return (
              <tr key={g.group_id}>
                <td><b className="_memory-ms-mono">{g.source_name}</b></td>
                <td>{presetOf(g.source_provider || 'custom').label || t('modelProvider.provider.other')}</td>
                <td className="_memory-ms-mono" style={{ overflowWrap: 'anywhere' }}>{g.base_url}</td>
                <td>
                  <div className="_memory-mp-tags">
                    {g.source_formats.map((f) => <Tag key={f}>{t(`modelSource.format.${f}`)}</Tag>)}
                  </div>
                </td>
                <td>
                  <Button onClick={() => onModels(g)}>
                    {t('selectedModels.button')}{' '}
                    <span className="_memory-ms-weak">{countEnabled(g.source_models)}/{countAvailable(g.source_models)}</span>
                  </Button>
                </td>
                <td>
                  <div className="_memory-mp-tags">
                    {!readOnly && <Switch value={on} disabled={busy} onChange={(v) => onToggle(g, v)} />}
                    <Tag theme={on ? 'success' : 'default'}>{t(on ? 'modelProvider.source.on' : 'modelProvider.source.off')}</Tag>
                  </div>
                </td>
                {!readOnly && (
                  <td>
                    <Button type="error" disabled={busy} onClick={() => onDelete(g)}>{t('modelProvider.delete')}</Button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
