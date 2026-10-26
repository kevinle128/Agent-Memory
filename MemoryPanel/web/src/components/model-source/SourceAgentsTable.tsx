/**
 * SourceAgentsTable — the agents that may use a source. Only multi-source agents can be ticked;
 * Claude Code and Codex stay on their own pool and show as locked rows.
 */
import './style.css';
import { useTranslation } from 'react-i18next';
import { Checkbox, Tag } from 'tea-component';

export interface SourceAgentOption {
  id: string;
  label: string;
}

interface Props {
  options: readonly SourceAgentOption[];
  selected: readonly string[];
  onToggle: (agent: string, on: boolean) => void;
  readOnly?: boolean;
  sourceName: string;
  enabledModelCount: number;
}

const LOCKED = ['claude-code', 'codex'] as const;

export function SourceAgentsTable({ options, selected, onToggle, readOnly, sourceName, enabledModelCount }: Props) {
  const { t } = useTranslation();
  return (
    <div className="_memory-ms-table-wrap">
      <table className="_memory-ms-table">
        <thead>
          <tr>
            <th style={{ width: 36 }} />
            <th>{t('modelSource.agents.agent')}</th>
            <th>{t('modelSource.agents.kind')}</th>
            <th>{t('modelSource.agents.result')}</th>
          </tr>
        </thead>
        <tbody>
          {options.map((a) => {
            const on = selected.includes(a.id);
            return (
              <tr key={a.id}>
                <td>
                  <Checkbox
                    value={on}
                    disabled={readOnly}
                    onChange={(v) => onToggle(a.id, v)}
                    aria-label={a.id}
                  />
                </td>
                <td><b>{a.id}</b></td>
                <td><Tag theme="primary">multi_source</Tag></td>
                <td className="_memory-ms-weak">
                  {on
                    ? t('modelSource.agents.sees', { count: enabledModelCount, name: sourceName || '…' })
                    : t('modelSource.agents.hidden')}
                </td>
              </tr>
            );
          })}
          {LOCKED.map((id) => (
            <tr key={id} className="_memory-ms-locked">
              <td><span aria-hidden="true">🔒</span></td>
              <td><b>{id}</b></td>
              <td><Tag>{t('modelSource.agents.single')}</Tag></td>
              <td>{t('modelSource.agents.lockedNote')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
