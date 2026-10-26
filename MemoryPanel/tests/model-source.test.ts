import { describe, expect, it } from 'vitest';
import {
  bulkChanges,
  countAvailable,
  countEnabled,
  filterModels,
  toggleInList,
  validateSourceName,
} from '../web/src/lib/model-source';
import type { SourceModel } from '../web/src/lib/api/model-providers';

function model(id: string, enabled: boolean, available = true): SourceModel {
  return { id, display_name: id, enabled, available, first_seen_at: '', last_seen_at: '' };
}

describe('validateSourceName', () => {
  const taken = new Set(['api-openai']);
  it('accepts a lowercase slug', () => {
    expect(validateSourceName('api-deepseek', taken)).toBeNull();
  });
  it('rejects empty, long, uppercase, slash and edge hyphen', () => {
    expect(validateSourceName('', taken)).toBe('required');
    expect(validateSourceName('a'.repeat(41), taken)).toBe('tooLong');
    expect(validateSourceName('Api', taken)).toBe('uppercase');
    expect(validateSourceName('api/x', taken)).toBe('chars');
    expect(validateSourceName('-api', taken)).toBe('edge');
    expect(validateSourceName('api-', taken)).toBe('edge');
  });
  it('reports a name that another group holds', () => {
    expect(validateSourceName('api-openai', taken)).toBe('taken');
  });
});

describe('model list', () => {
  const models = [model('gpt-6', false), model('gpt-6-mini', false), model('o5', true), model('old', false, false)];

  it('searches by id', () => {
    expect(filterModels(models, 'gpt').map((m) => m.id)).toEqual(['gpt-6', 'gpt-6-mini']);
    expect(filterModels(models, '  ')).toHaveLength(4);
  });

  it('bulk change after a search touches only the matching models', () => {
    const visible = filterModels(models, 'mini');
    expect(bulkChanges(visible, true)).toEqual([{ id: 'gpt-6-mini', enabled: true }]);
  });

  it('bulk change skips models the provider no longer lists and models already in the state', () => {
    expect(bulkChanges(models, true).map((c) => c.id)).toEqual(['gpt-6', 'gpt-6-mini']);
    expect(bulkChanges(models, false).map((c) => c.id)).toEqual(['o5']);
  });

  it('counts only listed ticked models, and all listed models', () => {
    expect(countEnabled([model('a', true), model('b', true, false)])).toBe(1);
    expect(countAvailable([model('a', true), model('b', true, false)])).toBe(1);
  });
});

describe('toggleInList', () => {
  it('adds once and removes', () => {
    expect(toggleInList(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleInList(['a', 'b'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleInList(['a', 'b'], 'a', false)).toEqual(['b']);
  });
});
