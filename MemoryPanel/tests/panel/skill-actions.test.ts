import { describe, expect, it } from 'vitest';
import { isAllowedSkillAction, SKILL_ACTIONS, SKILL_LIST_ACTIONS } from '../../src/panel/api/skill-actions.js';

describe('skill action allowlist', () => {
  it.each([
    'versions/diff',
    'rollback',
    'promote',
    'settings',
    'proposals/list',
    'proposals/approve',
    'proposals/reject',
    'local-inventory/replace',
    'local-inventory/list',
  ])('allows %s', (action) => {
    expect(isAllowedSkillAction(action)).toBe(true);
  });

  it('keeps the existing actions', () => {
    for (const action of ['create', 'update', 'get', 'list', 'versions', 'files/read', 'export']) {
      expect(SKILL_ACTIONS).toContain(action);
    }
    expect(SKILL_LIST_ACTIONS.has('local-inventory/list')).toBe(true);
    expect(SKILL_LIST_ACTIONS.has('local-inventory/replace')).toBe(false);
  });

  it.each(['', 'proposals', 'proposals/delete', 'rollback/force', 'promote/all', 'settings/set', 'VERSIONS'])(
    'rejects %j',
    (action) => {
      expect(isAllowedSkillAction(action)).toBe(false);
    },
  );
});
