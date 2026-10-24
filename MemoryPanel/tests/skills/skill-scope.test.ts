import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER,
  collapseUnchanged,
  collectProjects,
  countPending,
  describeSkillError,
  diffLines,
  filterSkills,
  formatSaigon,
  improvementsBetween,
  lostImprovements,
  pendingBySkill,
  previousVersion,
  projectLabel,
  scopeOf,
  skillErrorKey,
  sortVersionsDesc,
  type ScopedSkillFields,
} from '../../web/src/pages/SkillsPage/lib/skill-scope';
import {
  buildSkillContent,
  placementFor,
  validateNewSkill,
  validateNewSkillAll,
} from '../../web/src/pages/SkillsPage/lib/new-skill';

const skills: ScopedSkillFields[] = [
  { skill_id: 's1', name: 'code-review', scope: 'global', origin: 'template' },
  { skill_id: 's2', name: 'old-row', description: 'written before scoping' },
  { skill_id: 's3', name: 'paseo-gating', scope: 'project', project_hash: 'aaaaaaaaaaaaaaaa', project_name: 'kevinle128/paseo', project_key: 'k1', origin: 'extracted' },
  { skill_id: 's4', name: 'paseo-release', scope: 'project', project_hash: 'aaaaaaaaaaaaaaaa', project_name: 'kevinle128/paseo', origin: 'manual' },
  { skill_id: 's5', name: 'unnamed-project', scope: 'project', project_hash: 'bbbbbbbbbbbbbbbb' },
];

describe('scope helpers', () => {
  it('reads a row without scope as global', () => {
    expect(scopeOf(skills[1])).toBe('global');
    expect(scopeOf(skills[2])).toBe('project');
  });

  it('labels a project by name, else by the first 8 hash characters', () => {
    expect(projectLabel(skills[2])).toBe('kevinle128/paseo');
    expect(projectLabel(skills[4])).toBe('bbbbbbbb');
  });

  it('collects distinct projects and keeps a known key', () => {
    const projects = collectProjects(skills);
    expect(projects.map((p) => p.hash)).toEqual(['bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa']);
    expect(projects.find((p) => p.hash === 'aaaaaaaaaaaaaaaa')?.key).toBe('k1');
  });
});

describe('filterSkills', () => {
  it('filters by type', () => {
    expect(filterSkills(skills, { ...EMPTY_FILTER, type: 'global' }).map((s) => s.skill_id)).toEqual(['s1', 's2']);
    expect(filterSkills(skills, { ...EMPTY_FILTER, type: 'project' })).toHaveLength(3);
  });

  it('filters by project and drops global skills', () => {
    const out = filterSkills(skills, { ...EMPTY_FILTER, project: 'aaaaaaaaaaaaaaaa' });
    expect(out.map((s) => s.skill_id)).toEqual(['s3', 's4']);
  });

  it('filters by origin, treating a missing origin as extracted', () => {
    expect(filterSkills(skills, { ...EMPTY_FILTER, origin: 'extracted' }).map((s) => s.skill_id)).toEqual(['s2', 's3', 's5']);
  });

  it('searches name and description', () => {
    expect(filterSkills(skills, { ...EMPTY_FILTER, query: 'BEFORE' }).map((s) => s.skill_id)).toEqual(['s2']);
  });
});

describe('error mapping', () => {
  const t = (k: string) => `T:${k}`;
  it('maps known codes', () => {
    expect(skillErrorKey({ code: 42204 })).toBe('skills.error.nameOtherScope');
    expect(describeSkillError({ code: 42205 }, t)).toBe('T:skills.error.projectRequired');
    expect(describeSkillError({ code: 40901 }, t)).toBe('T:skills.error.versionMoved');
    expect(describeSkillError({ code: 40902 }, t)).toBe('T:skills.error.proposalNotPending');
  });
  it('falls back to the raw message', () => {
    expect(describeSkillError(Object.assign(new Error('boom'), { code: 50000 }), t)).toBe('boom');
    expect(describeSkillError('plain', t)).toBe('plain');
  });
});

describe('version audit helpers', () => {
  const versions = [
    { version: 1, change_source: 'extracted', change_summary: ['Created'] },
    { version: 3, change_source: 'rollback', change_summary: ['Restored content of v1'] },
    { version: 2, change_source: 'manual', change_summary: ['Clarified'] },
    { version: 4, change_source: 'extracted', change_summary: [] },
  ];
  it('sorts newest first', () => {
    expect(sortVersionsDesc(versions).map((v) => v.version)).toEqual([4, 3, 2, 1]);
  });
  it('lists improvements after the target and skips empty summaries', () => {
    expect(lostImprovements(versions, 1).map((v) => v.version)).toEqual([3, 2]);
    expect(lostImprovements(versions, 4)).toEqual([]);
  });
  it('lists improvements between two versions in either order', () => {
    expect(improvementsBetween(versions, 3, 1).map((v) => v.version)).toEqual([3, 2]);
    expect(improvementsBetween(versions, 1, 3).map((v) => v.version)).toEqual([3, 2]);
  });
  it('finds the previous version', () => {
    expect(previousVersion(versions, 3)).toBe(2);
    expect(previousVersion(versions, 1)).toBeUndefined();
  });
});

describe('proposals', () => {
  const proposals = [
    { skill_id: 'a', status: 'pending' },
    { skill_id: 'a', status: 'pending' },
    { skill_id: 'b', status: 'stale' },
    { skill_id: 'c', status: 'pending' },
  ];
  it('counts pending per skill and ignores stale', () => {
    expect(pendingBySkill(proposals)).toEqual({ a: 2, c: 1 });
    expect(countPending(proposals)).toBe(3);
  });
});

describe('formatSaigon', () => {
  it('formats in UTC+7 whatever the host zone is', () => {
    // 2026-10-24T01:05:00Z is 08:05 in Asia/Saigon.
    expect(formatSaigon(Date.UTC(2026, 9, 24, 1, 5))).toBe('2026-10-24 08:05');
    // Crosses midnight: 18:30Z is 01:30 the next day.
    expect(formatSaigon(Date.UTC(2026, 9, 24, 18, 30))).toBe('2026-10-25 01:30');
  });
  it('returns empty text for no time', () => {
    expect(formatSaigon(0)).toBe('');
  });
});

describe('diffLines', () => {
  it('marks added and removed lines with line numbers', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(d.removed).toBe(1);
    expect(d.added).toBe(2);
    expect(d.lines.map((l) => `${l.type[0]}:${l.text}`)).toEqual(['u:a', 'r:b', 'a:B', 'u:c', 'a:d']);
    expect(d.lines[1].old_line).toBe(2);
    expect(d.lines[2].new_line).toBe(2);
  });
  it('shows a whole text as added when there is no base', () => {
    const d = diffLines('', 'x\ny');
    expect(d.added).toBe(2);
    expect(d.removed).toBe(0);
  });
  it('reports no change for equal text', () => {
    const d = diffLines('same', 'same');
    expect(d.added + d.removed).toBe(0);
  });
  it('collapses long unchanged runs around changes', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l10', 'changed');
    const blocks = collapseUnchanged(diffLines(before, after).lines, 2);
    expect(blocks[0]).toEqual({ kind: 'collapsed', count: 8 });
    expect(blocks.filter((b) => b.kind === 'collapsed')).toHaveLength(2);
  });
});

describe('new skill input', () => {
  const base = { name: 'my-skill', description: '', body: '', scope: 'global' as const, projectHash: '', agentId: 'agt-1' };
  it('accepts a global skill', () => {
    expect(validateNewSkill(base)).toBeNull();
  });
  it('requires a project for a project skill', () => {
    expect(validateNewSkill({ ...base, scope: 'project' })).toBe('project');
    expect(validateNewSkill({ ...base, scope: 'project', projectHash: 'a'.repeat(16) })).toBeNull();
  });
  it('reports both the missing name and the missing project', () => {
    expect(validateNewSkillAll({ ...base, name: '', scope: 'project' })).toEqual(['name', 'project']);
    expect(validateNewSkillAll(base)).toEqual([]);
  });
  it('rejects a bad name or a missing agent', () => {
    expect(validateNewSkill({ ...base, name: '  ' })).toBe('name');
    expect(validateNewSkill({ ...base, name: 'x'.repeat(65) })).toBe('nameLength');
    expect(validateNewSkill({ ...base, name: 'a\nb' })).toBe('nameLines');
    expect(validateNewSkill({ ...base, agentId: '' })).toBe('agent');
  });
  it('builds content whose frontmatter name equals the skill name', () => {
    const c = buildSkillContent({ name: ' my-skill ', description: 'Does\n a thing', body: '' });
    expect(c).toBe('---\nname: my-skill\ndescription: "Does a thing"\n---\n\n# my-skill\n');
  });
  it('sends no project fields for a global skill and the known key for a project skill', () => {
    const projects = [{ hash: 'a'.repeat(16), key: 'k1', label: 'repo' }];
    expect(placementFor('global', '', projects)).toEqual({ scope: 'global' });
    expect(placementFor('project', 'a'.repeat(16), projects)).toEqual({
      scope: 'project',
      project_hash: 'a'.repeat(16),
      project_key: 'k1',
      project_name: 'repo',
    });
  });
});
