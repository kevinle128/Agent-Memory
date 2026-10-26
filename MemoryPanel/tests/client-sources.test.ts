import { describe, expect, it } from 'vitest';
import {
  agentFormats,
  clientsUsing,
  exposedModelCount,
  filterOptions,
  parseSourceInUse,
  selectedSources,
  sourceOptions,
  toggleSource,
} from '../web/src/lib/client-sources';
import type { ClientSource, ClientSourceAgent } from '../web/src/lib/api/client-sources';

function source(over: Partial<ClientSource> = {}): ClientSource {
  return {
    source_name: 'api-deepseek',
    source_type: 'api',
    provider: 'deepseek',
    formats: ['openai-chat'],
    enabled: true,
    models_on: 3,
    models_total: 4,
    ...over,
  };
}

function agent(over: Partial<ClientSourceAgent> = {}): ClientSourceAgent {
  return { agent: 'omp', display_name: 'oh-my-pi (omp)', mode: 'multi', selected: [], ...over };
}

const SOURCES: ClientSource[] = [
  source({ source_name: 'sub-claude', source_type: 'subscription', provider: 'claude', formats: ['anthropic-messages'], models_on: 14, models_total: 14 }),
  source({ source_name: 'sub-openai', source_type: 'subscription', provider: 'openai', formats: ['openai-responses'], models_on: 7, models_total: 7 }),
  source({ source_name: 'api-deepseek', formats: ['openai-chat', 'anthropic-messages'] }),
  source({ source_name: 'api-off', provider: 'openrouter', formats: ['openai-chat'], enabled: false }),
];

describe('sourceOptions', () => {
  it('lists only on sources of the single client format', () => {
    const claude = agent({ agent: 'claude-code', mode: 'single', format: 'anthropic-messages' });
    expect(sourceOptions(claude, SOURCES).map((s) => s.source_name)).toEqual(['sub-claude', 'api-deepseek']);
    const codex = agent({ agent: 'codex', mode: 'single', format: 'openai-responses' });
    expect(sourceOptions(codex, SOURCES).map((s) => s.source_name)).toEqual(['sub-openai']);
  });

  it('lists sources that share one format with a multi-source client', () => {
    const dsh = agent({ agent: 'dsh', formats: ['openai-chat'] });
    expect(sourceOptions(dsh, SOURCES).map((s) => s.source_name)).toEqual(['api-deepseek']);
  });

  it('treats a client without formats as speaking all three', () => {
    expect(agentFormats(agent())).toHaveLength(3);
    expect(sourceOptions(agent(), SOURCES).map((s) => s.source_name)).toEqual(['sub-claude', 'sub-openai', 'api-deepseek']);
  });

  it('never offers a source that is off', () => {
    expect(sourceOptions(agent(), SOURCES).some((s) => s.source_name === 'api-off')).toBe(false);
  });
});

describe('selection helpers', () => {
  it('keeps the order of the client and skips names that are gone', () => {
    const a = agent({ selected: ['api-deepseek', 'ghost', 'sub-claude'] });
    expect(selectedSources(a, SOURCES).map((s) => s.source_name)).toEqual(['api-deepseek', 'sub-claude']);
  });

  it('counts ticked models of the selected sources that are on', () => {
    const chosen = selectedSources(agent({ selected: ['sub-claude', 'api-deepseek', 'api-off'] }), SOURCES);
    expect(exposedModelCount(chosen)).toBe(17);
  });

  it('adds and removes one source', () => {
    expect(toggleSource(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleSource(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('names the clients that hold a source', () => {
    const agents = [agent({ agent: 'omp', selected: ['sub-claude'] }), agent({ agent: 'dsh', selected: [] })];
    expect(clientsUsing(agents, 'sub-claude').map((a) => a.agent)).toEqual(['omp']);
    expect(clientsUsing(agents, 'api-deepseek')).toEqual([]);
  });

  it('searches options by source name or provider', () => {
    expect(filterOptions(SOURCES, 'DEEP').map((s) => s.source_name)).toEqual(['api-deepseek']);
    expect(filterOptions(SOURCES, '  ')).toHaveLength(4);
  });
});

describe('parseSourceInUse', () => {
  const message = 'SOURCE_IN_USE: source sub-claude is used by: claude-code,omp';

  it('reads the clients from the envelope data', () => {
    const body = JSON.stringify({ code: 40900, message, data: { source_name: 'sub-claude', group_id: 'g', clients: ['claude-code', 'omp'] } });
    expect(parseSourceInUse(body, message)).toEqual({ sourceName: 'sub-claude', clients: ['claude-code', 'omp'] });
  });

  it('falls back to the message when the body has no data', () => {
    expect(parseSourceInUse('not json', message)).toEqual({ sourceName: 'sub-claude', clients: ['claude-code', 'omp'] });
  });

  it('ignores other errors', () => {
    expect(parseSourceInUse('{}', 'SOURCE_NOT_FOUND: x')).toBeNull();
    expect(parseSourceInUse('{}', undefined)).toBeNull();
  });
});
