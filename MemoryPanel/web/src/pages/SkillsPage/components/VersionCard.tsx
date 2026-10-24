/** One version with its audit trail: source, who changed it, who approved it, reason, improvements. */
import { useContext, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SourceTag } from './SkillBadges';
import { UserRenderContext } from '../lib/user-render-context';
import { formatSaigon, isAutoSummary, stripAuto } from '../lib/skill-scope';
import '../styles/skill-scope.css';

export interface VersionAuditView {
  version: number;
  owner_user_id?: string;
  change_source?: string | null;
  change_reason?: string;
  change_summary?: string[];
  approved_by?: string;
  approved_at_ms?: number;
  source_session_id?: string;
  updated_at_ms: number;
}

const COLLAPSED_ITEMS = 2;

export function ImprovementList({ items }: { items: string[] }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, COLLAPSED_ITEMS);
  return (
    <div className="_memory-skill-improvements">
      <ul>
        {shown.map((item, i) => (
          <li key={i}>
            {isAutoSummary(item) && <span className="_memory-skill-auto">{t('skillScope.version.auto')}</span>}
            {stripAuto(item)}
          </li>
        ))}
      </ul>
      {items.length > COLLAPSED_ITEMS && (
        <button type="button" className="_memory-skill-link" onClick={() => setAll((v) => !v)}>
          {all ? t('skillScope.version.showLess') : t('skillScope.version.showAll', { count: items.length })}
        </button>
      )}
    </div>
  );
}

/** User id of the person who made the change; empty for the extractor. */
export function changedByUser(v: VersionAuditView): string {
  if (v.change_source === 'extracted') return '';
  return v.approved_by || v.owner_user_id || '';
}

export function VersionCard(props: {
  version: VersionAuditView;
  isCurrent: boolean;
  /** Top right: normally "Set skill to this version". */
  topRight?: ReactNode;
  /** Bottom left: normally the compare checkbox. */
  bottomLeft?: ReactNode;
  /** Bottom right: normally "View details & diff". */
  bottomRight?: ReactNode;
  /** Show the full reason and every improvement (detail screen). */
  expanded?: boolean;
}) {
  const { t } = useTranslation();
  const v = props.version;
  const renderUser = useContext(UserRenderContext);
  const byUser = changedByUser(v);
  const isExtractor = v.change_source === 'extracted';
  const approvedBy: ReactNode = v.approved_by
    ? renderUser(v.approved_by)
    : isExtractor
      ? t('skillScope.version.systemAuto')
      : '';
  const summary = v.change_summary ?? [];
  const restored = v.change_source === 'rollback';
  return (
    <div
      className={`_memory-skill-vcard${props.isCurrent ? ' _memory-skill-vcard--current' : ''}${
        restored ? ' _memory-skill-vcard--rollback' : ''
      }`}
      data-version={v.version}
    >
      <div className="_memory-skill-vcard-top">
        <div className="_memory-skill-vcard-title">
          <span className="_memory-skill-vtag">
            v{v.version}
            {props.isCurrent && ` · ${t('skillScope.version.current')}`}
          </span>
          <SourceTag source={v.change_source} />
          <span className="_memory-skill-vcard-time">{formatSaigon(v.updated_at_ms)}</span>
        </div>
        {props.topRight && <div className="_memory-skill-vcard-topright">{props.topRight}</div>}
      </div>
      <div className="_memory-skill-vcard-meta">
        {(isExtractor || byUser) && (
          <span>
            {t('skillScope.version.changedBy')} {isExtractor ? 'extractor' : renderUser(byUser)}
            {isExtractor && v.source_session_id
              ? ` · ${t('skillScope.version.session')} ${v.source_session_id.slice(0, 8)}`
              : ''}
          </span>
        )}
        {approvedBy && (
          <span>
            {t('skillScope.version.approvedBy')} {approvedBy}
          </span>
        )}
      </div>
      {v.change_reason && (
        <div className={`_memory-skill-vcard-reason${props.expanded ? '' : ' _memory-skill-clamp'}`}>
          <span className="_memory-skill-vcard-label">{t('skillScope.version.reason')}</span> {v.change_reason}
        </div>
      )}
      {summary.length > 0 && <ImprovementList items={summary} />}
      <div className="_memory-skill-vcard-bottom">
        <div className="_memory-skill-vcard-bottomleft">{props.bottomLeft}</div>
        {props.bottomRight && <div className="_memory-skill-vcard-bottomright">{props.bottomRight}</div>}
      </div>
    </div>
  );
}
