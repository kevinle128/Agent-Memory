/** Type, project, origin and text filters, plus the "N pending changes" entry. */
import { useTranslation } from 'react-i18next';
import { Input, Segment, Select } from 'tea-component';
import type { KnownProject, SkillFilter } from '../lib/skill-scope';
import '../styles/skill-scope.css';

export function SkillFilterBar(props: {
  filter: SkillFilter;
  onChange: (next: SkillFilter) => void;
  projects: KnownProject[];
  showProjectFilters: boolean;
  pendingTotal: number;
  onOpenProposals: () => void;
}) {
  const { t } = useTranslation();
  const { filter } = props;
  return (
    <div className="_memory-skill-filterbar">
      {props.showProjectFilters && (
        <>
          <span className="_memory-skill-filter-label">{t('skillScope.filter.scope')}</span>
          <Segment
            value={filter.type}
            onChange={(v) => {
              const type = v as SkillFilter['type'];
              // A global-only view cannot keep a project filter.
              props.onChange({ ...filter, type, project: type === 'global' ? '' : filter.project });
            }}
            options={[
              { value: 'all', text: t('skillScope.filter.all') },
              { value: 'global', text: t('skillScope.badge.global') },
              { value: 'project', text: t('skillScope.filter.project') },
            ]}
          />
          <span className="_memory-skill-filter-label">{t('skillScope.filter.project')}</span>
          <Select
            appearance="button"
            value={filter.project}
            disabled={filter.type === 'global'}
            onChange={(v) => props.onChange({ ...filter, project: v })}
            options={[
              { value: '', text: t('skillScope.filter.allProjects') },
              ...props.projects.map((p) => ({ value: p.hash, text: p.label })),
            ]}
          />
        </>
      )}
      <span className="_memory-skill-filter-label">{t('skillScope.filter.origin')}</span>
      <Select
        appearance="button"
        value={filter.origin}
        onChange={(v) => props.onChange({ ...filter, origin: v as SkillFilter['origin'] })}
        options={[
          { value: 'all', text: t('skillScope.filter.all') },
          { value: 'extracted', text: t('skillScope.origin.extracted') },
          { value: 'manual', text: t('skillScope.origin.manual') },
          { value: 'template', text: t('skillScope.origin.template') },
        ]}
      />
      <Input
        value={filter.query}
        onChange={(v) => props.onChange({ ...filter, query: v })}
        placeholder={t('skillScope.filter.search')}
      />
      {props.pendingTotal > 0 && (
        <button type="button" className="_memory-skill-pending-link" onClick={props.onOpenProposals}>
          {'● '}
          {t('skillScope.pending.header', { count: props.pendingTotal })} ›
        </button>
      )}
    </div>
  );
}
