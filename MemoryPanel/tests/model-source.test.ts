import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCE_AGENTS,
  PREVIEW_AGENTS,
  bulkChanges,
  buildPoolSourceUpdate,
  buildUpdate,
  countEnabled,
  draftOf,
  draftProblems,
  emptyDraft,
  exposedFor,
  filterModels,
  hasChanges,
  modelSourceCounts,
  ompModelsYaml,
  previewSourcesFrom,
  sourcesOffByPool,
  toggleInList,
  validateSourceName,
} from '../web/src/lib/model-source';
import type { PoolSourceView, ProviderGroup, SourceModel } from '../web/src/lib/api/model-providers';

function model(id: string, enabled: boolean, available = true): SourceModel {
  return { id, display_name: id, enabled, available, first_seen_at: '', last_seen_at: '' };
}

function group(over: Partial<ProviderGroup> = {}): ProviderGroup {
  return {
    group_id: 'grp-1',
    group_type: 'custom',
    name: 'DeepSeek',
    agents: ['dsh'],
    enabled: true,
    mode: 'custom_unified',
    base_url: 'https://api.deepseek.com/v1',
    api_key_configured: true,
    model_id: 'deepseek-v4',
    description: '',
    source_name: 'api-deepseek',
    source_provider: 'deepseek',
    source_formats: ['openai-chat'],
    source_agents: ['omp', 'openclaw'],
    source_enabled: true,
    source_models: [model('deepseek-v4', true), model('deepseek-v4-flash', false)],
    source_models_fetched_at: null,
    source_models_error: null,
    version: 3,
    updated_at: '',
    ...over,
  };
}

function poolSource(over: Partial<PoolSourceView> = {}): PoolSourceView {
  return {
    source_name: 'sub-claude',
    source_provider: 'claude',
    source_formats: ['anthropic-messages'],
    source_agents: ['omp', 'hermes', 'openclaw'],
    source_models: [model('claude-sonnet-5', true)],
    source_models_fetched_at: null,
    source_models_error: null,
    source_active: true,
    ...over,
  };
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

  it('searches by id and shows only unticked models on request', () => {
    expect(filterModels(models, { query: 'gpt', onlyUnticked: false }).map((m) => m.id)).toEqual(['gpt-6', 'gpt-6-mini']);
    expect(filterModels(models, { query: '', onlyUnticked: true }).map((m) => m.id)).toEqual(['gpt-6', 'gpt-6-mini']);
  });

  it('bulk change after a search touches only the matching models', () => {
    const visible = filterModels(models, { query: 'mini', onlyUnticked: false });
    expect(bulkChanges(visible, true)).toEqual([{ id: 'gpt-6-mini', enabled: true }]);
  });

  it('bulk change skips models the provider no longer lists and models already in the state', () => {
    expect(bulkChanges(models, true).map((c) => c.id)).toEqual(['gpt-6', 'gpt-6-mini']);
    expect(bulkChanges(models, false).map((c) => c.id)).toEqual(['o5']);
  });

  it('counts only listed ticked models', () => {
    expect(countEnabled([model('a', true), model('b', true, false)])).toBe(1);
  });
});

describe('group draft', () => {
  it('a new source offers omp, hermes and openclaw ticked', () => {
    expect(emptyDraft('api-openai').sourceAgents).toEqual([...DEFAULT_SOURCE_AGENTS]);
    expect(draftOf(group({ source_name: '', source_agents: [] }), 'api-x').sourceAgents).toEqual([...DEFAULT_SOURCE_AGENTS]);
  });

  it('a saved source shows its stored agents, not the defaults', () => {
    const d = draftOf(group({ source_agents: ['omp'] }), 'api-x');
    expect(d.sourceAgents).toEqual(['omp']);
    expect(d.sourceName).toBe('api-deepseek');
  });

  it('untick one agent then save: the patch has no such agent', () => {
    const g = group({ source_agents: ['omp', 'hermes', 'openclaw'] });
    const d = draftOf(g, '');
    d.sourceAgents = toggleInList(d.sourceAgents, 'hermes', false);
    expect(buildUpdate(g, d).source_agents).toEqual(['omp', 'openclaw']);
  });

  it('never sends the source name or an empty key on edit', () => {
    const g = group();
    const patch = buildUpdate(g, draftOf(g, ''));
    expect(hasChanges(patch)).toBe(false);
    expect('source_name' in patch).toBe(false);
    expect('api_key' in patch).toBe(false);
  });

  it('sends a typed key and the source name only for the first save of a source', () => {
    const old = group({ source_name: '', source_agents: [], source_formats: [], source_models: [] });
    const d = draftOf(old, 'api-moonshot');
    d.useSource = true;
    d.apiKey = ' sk-test ';
    const patch = buildUpdate(old, d);
    expect(patch.api_key).toBe('sk-test');
    expect(patch.source_name).toBe('api-moonshot');
    expect(patch.source_agents).toEqual([...DEFAULT_SOURCE_AGENTS]);
  });

  it('a passthrough group sends no source field', () => {
    const g = group({ mode: 'custom_passthrough', source_name: '', source_agents: [], api_key_configured: false });
    const d = draftOf(g, 'api-x');
    d.useSource = true;
    const patch = buildUpdate(g, d);
    expect(Object.keys(patch).some((k) => k.startsWith('source_'))).toBe(false);
  });

  it('blocks saving without an agent or a source agent', () => {
    const d = emptyDraft('api-openai');
    d.apiKey = 'sk-x';
    d.sourceAgents = [];
    expect(draftProblems(d, { original: null, takenNames: new Set() })).toContain('noAgent');
    d.agents = ['dsh'];
    expect(draftProblems(d, { original: null, takenNames: new Set() })).toEqual([]);
  });

  it('requires a key for a new unified group and a free source name', () => {
    const d = emptyDraft('api-openai');
    expect(draftProblems(d, { original: null, takenNames: new Set(['api-openai']) })).toEqual(['apiKey', 'sourceName']);
  });

  it('does not check the name of a saved source', () => {
    const g = group();
    expect(draftProblems(draftOf(g, ''), { original: g, takenNames: new Set(['api-deepseek']) })).toEqual([]);
  });
});

describe('pool source update', () => {
  it('carries only the source fields', () => {
    const patch = buildPoolSourceUpdate('grp-pool', { sourceName: 'sub-openai', sourceAgents: ['omp'] });
    expect(Object.keys(patch).sort()).toEqual(['group_id', 'source_agents', 'source_name']);
    for (const banned of ['agents', 'enabled', 'mode', 'source_enabled']) expect(banned in patch).toBe(false);
  });

  it('leaves the name out once the source is saved', () => {
    expect('source_name' in buildPoolSourceUpdate('grp-pool', { sourceAgents: ['omp'] })).toBe(false);
  });
});

describe('client preview', () => {
  const pools = (enabled: boolean) => [
    { provider: 'claude' as const, enabled, source: poolSource({ source_active: enabled }) },
    { provider: 'codex' as const, enabled: false, source: null },
  ];
  const sources = (poolOn: boolean) => previewSourcesFrom([group()], pools(poolOn), (p) => p);

  it('has tabs for omp, hermes and openclaw only', () => {
    expect([...PREVIEW_AGENTS]).toEqual(['omp', 'hermes', 'openclaw']);
  });

  it('lists ticked models of open sources for agents in source_agents', () => {
    expect(exposedFor('omp', sources(true)).map((x) => x.id)).toEqual(['sub-claude/claude-sonnet-5', 'api-deepseek/deepseek-v4']);
    expect(exposedFor('hermes', sources(true)).map((x) => x.id)).toEqual(['sub-claude/claude-sonnet-5']);
  });

  it('hides pool models when the pool is off and names the source that went off', () => {
    const list = sources(false);
    expect(exposedFor('omp', list).map((x) => x.id)).toEqual(['api-deepseek/deepseek-v4']);
    expect(sourcesOffByPool('omp', list).map((s) => s.name)).toEqual(['sub-claude']);
  });

  it('hides a closed API source', () => {
    const list = previewSourcesFrom([group({ source_enabled: false })], [], (p) => p);
    expect(exposedFor('omp', list)).toEqual([]);
  });

  it('counts a model offered by several sources', () => {
    const a = group({ group_id: 'a', source_name: 'api-a', source_models: [model('m', true)] });
    const b = group({ group_id: 'b', source_name: 'api-b', source_models: [model('m', true)] });
    const counts = modelSourceCounts(exposedFor('omp', previewSourcesFrom([a, b], [], (p) => p)));
    expect(counts.get('m')).toBe(2);
  });

  it('models.yml has three providers by format and a key placeholder', () => {
    const anthropic = group({ group_id: 'a', source_name: 'api-a', source_formats: ['anthropic-messages'], source_models: [model('m', true)] });
    const responses = group({ group_id: 'r', source_name: 'api-r', source_formats: ['openai-responses'], source_models: [model('m', true)] });
    const chat = group({ group_id: 'c', source_name: 'api-c', source_formats: ['openai-chat'], source_models: [model('m', true)] });
    const yaml = ompModelsYaml(exposedFor('omp', previewSourcesFrom([anthropic, responses, chat], [], (p) => p)), 'https://hub.example');
    expect(yaml).toContain('memory-anthropic:');
    expect(yaml).toContain('memory-responses:');
    expect(yaml).toContain('memory-chat:');
    expect(yaml).toContain('apiKey: sk-••••');
    expect(yaml).toContain('- id: api-a/m');
  });
});
