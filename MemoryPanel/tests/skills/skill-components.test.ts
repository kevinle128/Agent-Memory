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
import { isSafeLocalInventoryRow, LocalInventoryListView } from '../../web/src/pages/SkillsPage/components/LocalInventorySection';
import { OriginBadge, PendingBadge, ScopeBadge } from '../../web/src/pages/SkillsPage/components/SkillBadges';
import { VersionCard } from '../../web/src/pages/SkillsPage/components/VersionCard';
import type { LocalSkillInventoryRow } from '../../web/src/lib/api/skills';

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

describe('local inventory list', () => {
  const hash = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  const row = (over: Partial<LocalSkillInventoryRow>): LocalSkillInventoryRow => ({
    inventory_id: 1,
    machine_id: 'machine-a',
    harness: 'claude',
    source: 'user',
    name: 'demo',
    root_kind: 'claude_user',
    relative_path: 'demo/SKILL.md',
    content_hash: hash,
    reported_at_ms: Date.UTC(2026, 10, 25, 2, 0),
    present: 1,
    ...over,
  });

  it('renders name, harness, source, root, path, and a short hash for each allowed source', () => {
    const html = render(createElement(LocalInventoryListView, {
      items: [
        row({ inventory_id: 1, source: 'user', name: 'user-demo', harness: 'claude', root_kind: 'claude_user', relative_path: 'demo/SKILL.md' }),
        row({ inventory_id: 2, source: 'project', name: 'project-demo', harness: 'codex', root_kind: 'codex_project', relative_path: 'repo/skills/demo/SKILL.md' }),
        row({ inventory_id: 3, source: 'third_party_plugin', name: 'plugin-demo', harness: 'agy', root_kind: 'plugin_root', relative_path: 'ponytail/skills/demo/SKILL.md' }),
      ],
    }));
    for (const text of [
      'user-demo', 'project-demo', 'plugin-demo',
      'claude', 'codex', 'agy',
      'user', 'project', 'third_party_plugin',
      'claude_user', 'codex_project', 'plugin_root',
      'demo/SKILL.md', 'repo/skills/demo/SKILL.md', 'ponytail/skills/demo/SKILL.md',
      'abcdef012345',
    ]) {
      expect(html).toContain(text);
    }
  });

  it('drops a home path, an absolute path, and a parent segment', () => {
    const bad = [
      '/Users/dale/.claude/skills/demo/SKILL.md',
      'Users/dale/demo/SKILL.md',
      '~/skills/demo/SKILL.md',
      '../demo/SKILL.md',
      'C:/skills/demo/SKILL.md',
    ];
    const html = render(createElement(LocalInventoryListView, {
      items: [
        row({ inventory_id: 9, name: 'kept', relative_path: 'kept/SKILL.md' }),
        ...bad.map((relative_path, index) => row({
          inventory_id: index + 1,
          name: 'hidden',
          relative_path,
        })),
      ],
    }));
    expect(html).toContain('kept/SKILL.md');
    for (const relative_path of bad) {
      expect(html).not.toContain(relative_path);
    }
    expect(bad.every((relative_path) => isSafeLocalInventoryRow(row({ relative_path })) === false)).toBe(true);
  });

  it('keeps a multi-segment project path and drops a row that would throw while rendering', () => {
    const kept = row({
      name: 'demo',
      relative_path: 'ws-abcdef012345/demo/SKILL.md',
    });
    const malformed: unknown[] = [
      null,
      { ...kept, root_kind: undefined },
      { ...kept, root_kind: null },
      { ...kept, root_kind: 12 },
      { ...kept, name: { nested: true } },
      { ...kept, name: null },
      { ...kept, name: '' },
      { ...kept, name: '..' },
      { ...kept, name: 'a/b' },
      { ...kept, name: 'bad\u0001name' },
      { ...kept, name: 'n'.repeat(129) },
      { ...kept, content_hash: undefined },
      { ...kept, content_hash: 64 },
      { ...kept, content_hash: 'not-a-hash' },
      { ...kept, reported_at_ms: Number.NaN },
      { ...kept, reported_at_ms: Number.POSITIVE_INFINITY },
      { ...kept, reported_at_ms: '1710000000000' },
      { ...kept, reported_at_ms: 1e20 },
      { ...kept, harness: '' },
      { ...kept, source: 1 },
      { ...kept, inventory_id: Number.NaN },
    ];
    for (const item of malformed) {
      expect(isSafeLocalInventoryRow(item)).toBe(false);
    }
    expect(isSafeLocalInventoryRow(kept)).toBe(true);
    const html = render(createElement(LocalInventoryListView, {
      items: [kept, ...malformed],
    }));
    expect(html).toContain('ws-abcdef012345/demo/SKILL.md');
    expect(html).toContain('demo');
    expect(html.match(/_memory-local-inventory-row/g)).toHaveLength(1);
    expect(() => render(createElement(LocalInventoryListView, {
      items: malformed as never,
    }))).not.toThrow();
  });

  it('renders an inherited source name as text and leaves a non-array list empty', () => {
    const html = render(createElement(LocalInventoryListView, {
      items: [
        row({ inventory_id: 1, source: 'toString', name: 'proto-a' }),
        row({ inventory_id: 2, source: 'constructor', name: 'proto-b' }),
      ],
    }));
    expect(html).toContain('>toString<');
    expect(html).toContain('>constructor<');
    expect(html).not.toContain('function');
    const empty = render(createElement(LocalInventoryListView, { items: null as never }));
    expect(empty).toContain('skills.localInventory.empty');
    expect(empty).not.toContain('_memory-local-inventory-row');
  });

  it('rejects a path segment outside the folder allowlist', () => {
    expect(isSafeLocalInventoryRow(row({ relative_path: 'bad<seg>/SKILL.md' }))).toBe(false);
  });
});
