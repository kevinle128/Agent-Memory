import { describe, expect, it } from 'vitest';
import { isAllowedSkillAction, SKILL_ACTIONS } from '../../src/panel/api/skill-actions.js';

describe('skill action allowlist', () => {
  it.each([
    'versions/diff',
    'rollback',
    'promote',
    'settings',
    'proposals/list',
    'proposals/approve',
    'proposals/reject',
  ])('allows %s', (action) => {
    expect(isAllowedSkillAction(action)).toBe(true);
  });

  it('keeps the existing actions', () => {
    for (const action of ['create', 'update', 'get', 'list', 'versions', 'files/read', 'export']) {
      expect(SKILL_ACTIONS).toContain(action);
    }
  });

  it.each(['', 'proposals', 'proposals/delete', 'rollback/force', 'promote/all', 'settings/set', 'VERSIONS'])(
    'rejects %j',
    (action) => {
      expect(isAllowedSkillAction(action)).toBe(false);
    },
  );
});
