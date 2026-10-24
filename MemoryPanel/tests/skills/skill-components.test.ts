import { createElement } from '../../web/node_modules/react';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Echo the key and its parameters so the markup shows which text each part uses.
vi.mock('../../web/node_modules/react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}|${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(';')}` : key,
  }),
}));

import { DiffView } from '../../web/src/pages/SkillsPage/components/DiffView';
import { OriginBadge, PendingBadge, ScopeBadge } from '../../web/src/pages/SkillsPage/components/SkillBadges';
import { VersionCard } from '../../web/src/pages/SkillsPage/components/VersionCard';

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe('badges', () => {
  it('shows Global for a global skill', () => {
    const html = render(createElement(ScopeBadge, { skill: { skill_id: 's', name: 'n', scope: 'global' } }));
    expect(html).toContain('skillScope.badge.global');
  });

  it('shows the project name, and the short hash when the name is empty', () => {
    const named = render(createElement(ScopeBadge, {
      skill: { skill_id: 's', name: 'n', scope: 'project', project_hash: 'abcdef0123456789', project_name: 'org/repo' },
    }));
    expect(named).toContain('>skillScope.badge.project|name=org/repo<');
    const unnamed = render(createElement(ScopeBadge, {
      skill: { skill_id: 's', name: 'n', scope: 'project', project_hash: 'abcdef0123456789' },
    }));
    expect(unnamed).toContain('>skillScope.badge.project|name=abcdef01<');
  });

  it('drops the project badge in chat mode but keeps Global', () => {
    const project = { skill_id: 's', name: 'n', scope: 'project' as const, project_hash: 'abcdef0123456789', project_name: 'org/repo' };
    expect(render(createElement(ScopeBadge, { skill: project, hideProject: true }))).toBe('');
    const global = render(createElement(ScopeBadge, { skill: { skill_id: 's', name: 'n' }, hideProject: true }));
    expect(global).toContain('skillScope.badge.global');
  });

  it('shows the origin and hides a zero pending count', () => {
    expect(render(createElement(OriginBadge, { origin: 'template' }))).toContain('skillScope.origin.template');
    expect(render(createElement(PendingBadge, { count: 0 }))).toBe('');
    expect(render(createElement(PendingBadge, { count: 2 }))).toContain('skillScope.pending.badge|count=2');
  });
});

describe('DiffView', () => {
  const lines = [
    { type: 'unchanged' as const, text: 'keep', old_line: 1, new_line: 1 },
    { type: 'removed' as const, text: 'old text', old_line: 2 },
    { type: 'added' as const, text: 'new text', new_line: 2 },
  ];

  it('colors added and removed rows', () => {
    const html = render(createElement(DiffView, { lines }));
    expect(html).toContain('_memory-skill-diff-row--removed');
    expect(html).toContain('_memory-skill-diff-row--added');
    expect(html).toContain('old text');
    expect(html).toContain('new text');
  });

  it('renders side by side', () => {
    const html = render(createElement(DiffView, { lines, mode: 'split' }));
    expect(html).toContain('_memory-skill-diff-split');
  });

  it('says so when there is no change', () => {
    const html = render(createElement(DiffView, { lines: [lines[0]] }));
    expect(html).toContain('skillScope.diff.noChanges');
  });
});

describe('VersionCard', () => {
  const version = {
    version: 4,
    owner_user_id: 'admin',
    change_source: 'extracted',
    change_reason: 'A session hit a prompt',
    change_summary: ['Added a step', '(auto) Clarified', 'Third item'],
    approved_by: '',
    source_session_id: 'a81c03fe99',
    updated_at_ms: Date.UTC(2026, 9, 23, 9, 42),
  };

  it('puts the set button top right and the details link bottom right', () => {
    const html = render(createElement(VersionCard, {
      version,
      isCurrent: false,
      topRight: createElement('button', null, 'SET'),
      bottomRight: createElement('a', null, 'DETAILS'),
    }));
    const top = html.indexOf('_memory-skill-vcard-topright');
    const bottomRight = html.indexOf('_memory-skill-vcard-bottomright');
    expect(top).toBeGreaterThan(-1);
    expect(html.indexOf('SET')).toBeGreaterThan(top);
    expect(html.indexOf('SET')).toBeLessThan(html.indexOf('_memory-skill-vcard-reason'));
    expect(html.indexOf('DETAILS')).toBeGreaterThan(bottomRight);
    expect(html).not.toContain('_memory-skill-diff');
  });

  it('shows source, time in Asia/Saigon, changed by, approver, reason and a collapsed summary', () => {
    const html = render(createElement(VersionCard, { version, isCurrent: false }));
    expect(html).toContain('skillScope.source.extracted');
    expect(html).toContain('2026-10-23 16:42');
    expect(html).toContain('extractor');
    expect(html).toContain('a81c03fe');
    expect(html).toContain('skillScope.version.systemAuto');
    expect(html).toContain('A session hit a prompt');
    expect(html).toContain('Added a step');
    expect(html).not.toContain('Third item');
    expect(html).toContain('skillScope.version.showAll');
  });

  it('marks the current version and shows the person who approved a manual change', () => {
    const html = render(createElement(VersionCard, {
      version: { ...version, version: 6, change_source: 'manual', approved_by: 'admin' },
      isCurrent: true,
    }));
    expect(html).toContain('v6');
    expect(html).toContain('skillScope.version.current');
    expect(html).toContain('_memory-skill-vcard--current');
    expect(html).toContain('admin');
  });
});
