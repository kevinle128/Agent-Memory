import { describe, expect, it } from 'vitest';
import { ALLOWED_PANEL_ACTIONS } from '../src/panel/api/meta-actions';

const SOURCE_ACTIONS = [
  'upstream/supported-agents',
  'instance-upstream/groups/view',
  'instance-upstream/groups/create',
  'instance-upstream/groups/update',
  'instance-upstream/groups/toggle',
  'instance-upstream/groups/delete',
  'instance-upstream/groups/suggest-source-name',
  'instance-upstream/groups/source-models/update',
  'instance-upstream/groups/source-refresh',
  'instance-upstream/client-sources/list',
  'instance-upstream/client-sources/update',
];

describe('model provider panel actions', () => {
  it.each(SOURCE_ACTIONS)('allows %s through the meta proxy', (action) => {
    expect(ALLOWED_PANEL_ACTIONS.has(action as never)).toBe(true);
  });

  it('keeps the masked-key list and the internal list closed to the Panel', () => {
    expect(ALLOWED_PANEL_ACTIONS.has('instance-upstream/groups/list' as never)).toBe(false);
    expect(ALLOWED_PANEL_ACTIONS.has('instance-upstream/list' as never)).toBe(false);
  });
});
