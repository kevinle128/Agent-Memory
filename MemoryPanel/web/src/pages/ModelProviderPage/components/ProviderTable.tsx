/**
 * ProviderTable — custom upstream groups in four columns: group, use for whole agents (old path),
 * use as a source (new path), actions. People who cannot edit get no switches and no write buttons.
 */
import { useTranslation } from 'react-i18next';
import { Button, Switch, Tag } from 'tea-component';
import { countAvailable, countEnabled, formatFetchedAt, presetOf } from '@/lib/model-source';
import type { ProviderGroup } from '@/lib/api/model-providers';

interface Props {
  groups: readonly ProviderGroup[];
  readOnly: boolean;
  busyIds: ReadonlySet<string>;
  onEdit: (group: ProviderGroup, attach: boolean) => void;
  onDelete: (group: ProviderGroup) => void;
  onToggleAgents: (group: ProviderGroup, enabled: boolean) => void;
  onToggleSource: (group: ProviderGroup, enabled: boolean) => void;
}

function Tags({ list }: { list: readonly string[] }) {
  if (list.length === 0) return <span className="_memory-mp-weak">—</span>;
  return (
    <div className="_memory-mp-tags">
      {list.map((a) => <Tag key={a} theme="primary">{a}</Tag>)}
    </div>
  );
}

export function ProviderTable({ groups, readOnly, busyIds, onEdit, onDelete, onToggleAgents, onToggleSource }: Props) {
  const { t } = useTranslation();
  return (
    <div className="_memory-ms-table-wrap" style={{ maxWidth: 'none' }}>
      <table className="_memory-ms-table" style={{ minWidth: 1000 }}>
        <thead>
          <tr>
            <th style={{ width: '26%' }}>{t('modelProvider.col.group')}</th>
            <th style={{ width: '22%' }}>{t('modelProvider.col.agents')}</th>
            <th>{t('modelProvider.col.source')}</th>
            <th style={{ width: 130 }}>{readOnly ? t('modelProvider.col.details') : t('modelProvider.col.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {groups.length === 0 && (
            <tr><td colSpan={4} className="_memory-ms-empty">{t('modelProvider.empty')}</td></tr>
          )}
          {groups.map((g) => {
            const busy = busyIds.has(g.group_id);
            const unified = g.mode === 'custom_unified';
            const providerLabel = presetOf(g.source_provider || 'custom').label || t('modelProvider.provider.other');
            return (
              <tr key={g.group_id}>
                <td>
                  <b>{g.name}</b>
                  {g.source_provider && <div className="_memory-mp-weak">{providerLabel}</div>}
                  <div className="_memory-ms-mono" style={{ overflowWrap: 'anywhere' }}>{g.base_url}</div>
                  <div className="_memory-mp-tags" style={{ marginTop: 4 }}>
                    <Tag theme={unified ? 'default' : 'warning'}>{g.mode}</Tag>
                    {unified && (
                      <Tag theme={g.api_key_configured ? 'success' : 'error'}>
                        {t(g.api_key_configured ? 'modelProvider.key.set' : 'modelProvider.key.missing')}
                      </Tag>
                    )}
                  </div>
                </td>
                <td>
                  <Tags list={g.agents} />
                  <div style={{ marginTop: 4 }}>
                    <span className="_memory-mp-weak">model_id:</span>{' '}
                    {g.model_id ? <code>{g.model_id}</code> : <span className="_memory-mp-weak">{t('modelProvider.empty.modelId')}</span>}
                  </div>
                  {g.agents.length > 0 && (
                    <div className="_memory-mp-switch">
                      {!readOnly && (
                        <Switch value={g.enabled} disabled={busy} onChange={(v) => onToggleAgents(g, v)} />
                      )}
                      <Tag theme={g.enabled ? 'success' : 'default'}>
                        {t(g.enabled ? 'modelProvider.agents.on' : 'modelProvider.agents.off')}
                      </Tag>
                    </div>
                  )}
                </td>
                <td>
                  {g.source_name ? (
                    <>
                      <b className="_memory-ms-mono">{g.source_name}</b>
                      <div className="_memory-mp-tags" style={{ marginTop: 4 }}>
                        {g.source_formats.map((f) => <Tag key={f}>{f}</Tag>)}
                      </div>
                      <div style={{ marginTop: 4 }}>
                        {t('modelProvider.source.modelsOn')} <b>{countEnabled(g.source_models)}</b>
                        <span className="_memory-mp-weak">/{countAvailable(g.source_models)}</span>
                      </div>
                      <div style={{ marginTop: 4 }}><Tags list={g.source_agents} /></div>
                      {g.source_models_error ? (
                        <div className="_memory-mp-warn">⚠ {g.source_models_error}</div>
                      ) : (
                        <div className="_memory-mp-weak">
                          {g.source_models_fetched_at
                            ? t('modelProvider.source.fetchedAt', { time: formatFetchedAt(g.source_models_fetched_at) })
                            : t('modelProvider.source.notFetched')}
                        </div>
                      )}
                      <div className="_memory-mp-switch">
                        {!readOnly && (
                          <Switch value={g.source_enabled} disabled={busy} onChange={(v) => onToggleSource(g, v)} />
                        )}
                        <Tag theme={g.source_enabled ? 'success' : 'default'}>
                          {t(g.source_enabled ? 'modelProvider.source.on' : 'modelProvider.source.off')}
                        </Tag>
                      </div>
                    </>
                  ) : !unified ? (
                    <>
                      <Tag theme="warning">{t('modelProvider.source.notAllowed')}</Tag>
                      <div className="_memory-mp-weak" style={{ marginTop: 4 }}>{t('modelProvider.source.notAllowedWhy')}</div>
                    </>
                  ) : (
                    <>
                      <span className="_memory-mp-weak">{t('modelProvider.source.none')}</span>
                      {!readOnly && (
                        <div style={{ marginTop: 6 }}>
                          <Button type="weak" onClick={() => onEdit(g, true)}>{t('modelProvider.source.attach')}</Button>
                        </div>
                      )}
                    </>
                  )}
                </td>
                <td>
                  <div className="_memory-mp-tags">
                    <Button type="link" onClick={() => onEdit(g, false)}>
                      {t(readOnly ? 'modelProvider.view' : 'modelProvider.edit')}
                    </Button>
                    {!readOnly && (
                      <Button type="error" disabled={busy} onClick={() => onDelete(g)}>{t('modelProvider.delete')}</Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
