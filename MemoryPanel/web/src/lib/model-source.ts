/**
 * model-source.ts — pure rules for model sources on the Model Provider and Subscription Pool pages.
 * No React, no network: the pages call these helpers and tests cover them directly.
 */
import type {
  GroupMode,
  PoolSourceView,
  ProviderGroup,
  SourceFormat,
  SourceInput,
  SourceModel,
  SupportedAgent,
  UpdateGroupInput,
} from './api/model-providers';

/** Agents that a new source offers by default. The admin may untick any of them. */
export const DEFAULT_SOURCE_AGENTS = ['omp', 'hermes', 'openclaw'] as const;

/** Agents that choose a source by the model-name prefix. The preview shows only these. */
export const PREVIEW_AGENTS = ['omp', 'hermes', 'openclaw'] as const;
export type PreviewAgent = (typeof PREVIEW_AGENTS)[number];

/** Agents of the subscription pools. They keep their own pool and never use a source prefix. */
export const POOL_AGENTS = { claude: 'claude-code', codex: 'codex' } as const;

export const SOURCE_FORMATS: readonly SourceFormat[] = ['anthropic-messages', 'openai-responses', 'openai-chat'];

export const SOURCE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export type NameProblem = 'required' | 'tooLong' | 'uppercase' | 'chars' | 'edge' | 'taken';

/** Checks a source name while the admin types. Returns null when the name is usable. */
export function validateSourceName(name: string, taken: ReadonlySet<string>): NameProblem | null {
  if (!name) return 'required';
  if (name.length > 40) return 'tooLong';
  if (/[A-Z]/.test(name)) return 'uppercase';
  if (!/^[a-z0-9-]+$/.test(name)) return 'chars';
  if (!SOURCE_NAME_RE.test(name)) return 'edge';
  if (taken.has(name)) return 'taken';
  return null;
}

/** Presets of the provider select. `custom` is "other". */
export interface ProviderPreset {
  slug: string;
  label: string;
  baseUrl: string;
  format: SourceFormat;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { slug: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', format: 'openai-responses' },
  { slug: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', format: 'anthropic-messages' },
  { slug: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', format: 'openai-chat' },
  { slug: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', format: 'openai-chat' },
  { slug: 'moonshot', label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', format: 'openai-chat' },
  { slug: 'custom', label: '', baseUrl: '', format: 'openai-chat' },
];

export function presetOf(slug: string): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.slug === slug) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]!;
}

/** Suggested group name for a preset (empty for "other"). */
export function presetGroupName(slug: string): string {
  return presetOf(slug).label;
}

// ───────────── model list ─────────────

export function countEnabled(models: readonly SourceModel[]): number {
  return models.filter((m) => m.enabled && m.available).length;
}

export function countAvailable(models: readonly SourceModel[]): number {
  return models.filter((m) => m.available).length;
}

export interface ModelFilter {
  query: string;
  /** Show only models that are listed by the provider and not ticked. */
  onlyUnticked: boolean;
}

/** Models that match the search text (id or display name) and the "unticked" filter. */
export function filterModels(models: readonly SourceModel[], filter: ModelFilter): SourceModel[] {
  const q = filter.query.trim().toLowerCase();
  return models.filter((m) => {
    if (filter.onlyUnticked && (m.enabled || !m.available)) return false;
    if (!q) return true;
    return m.id.toLowerCase().includes(q) || m.display_name.toLowerCase().includes(q);
  });
}

/**
 * Changes that tick every listed model on or off. Models the provider no longer lists are skipped,
 * and so are models that already have the wanted state, so one call carries only real changes.
 */
export function bulkChanges(models: readonly SourceModel[], enabled: boolean): { id: string; enabled: boolean }[] {
  return models.filter((m) => m.available && m.enabled !== enabled).map((m) => ({ id: m.id, enabled }));
}

export function formatFetchedAt(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ───────────── agents ─────────────

/** Ids of the agents that may be listed in `source_agents`. */
export function multiSourceAgents(supported: readonly SupportedAgent[]): SupportedAgent[] {
  return supported.filter((a) => a.multi_source === true);
}

export function toggleInList(list: readonly string[], value: string, on: boolean): string[] {
  const without = list.filter((x) => x !== value);
  return on ? [...without, value] : without;
}

// ───────────── group form ─────────────

/** State of the group form. Key text is only held while the admin types it. */
export interface GroupDraft {
  name: string;
  providerSlug: string;
  mode: GroupMode;
  baseUrl: string;
  apiKey: string;
  description: string;
  agents: string[];
  modelId: string;
  enabled: boolean;
  useSource: boolean;
  sourceName: string;
  sourceFormats: SourceFormat[];
  sourceAgents: string[];
  sourceEnabled: boolean;
}

export function emptyDraft(takenSourceName: string): GroupDraft {
  const preset = PROVIDER_PRESETS[0]!;
  return {
    name: preset.label,
    providerSlug: preset.slug,
    mode: 'custom_unified',
    baseUrl: preset.baseUrl,
    apiKey: '',
    description: '',
    agents: [],
    modelId: '',
    enabled: true,
    useSource: true,
    sourceName: takenSourceName,
    sourceFormats: [preset.format],
    sourceAgents: [...DEFAULT_SOURCE_AGENTS],
    sourceEnabled: true,
  };
}

/** Draft of an existing group. A group without a source starts with the defaults of a new source. */
export function draftOf(group: ProviderGroup, suggestedName: string): GroupDraft {
  const isSource = Boolean(group.source_name);
  const preset = presetOf(group.source_provider || 'custom');
  return {
    name: group.name,
    providerSlug: group.source_provider || 'custom',
    mode: group.mode,
    baseUrl: group.base_url,
    apiKey: '',
    description: group.description,
    agents: [...group.agents],
    modelId: group.model_id,
    enabled: group.enabled,
    useSource: isSource,
    sourceName: isSource ? group.source_name : suggestedName,
    sourceFormats: isSource ? [...group.source_formats] : [preset.format],
    sourceAgents: isSource ? [...group.source_agents] : [...DEFAULT_SOURCE_AGENTS],
    sourceEnabled: isSource ? group.source_enabled : true,
  };
}

export type DraftProblem = 'name' | 'baseUrl' | 'apiKey' | 'sourceName' | 'formats' | 'noAgent';

/** Problems that block saving. Same rule as Core: at least one agent or one source agent. */
export function draftProblems(
  draft: GroupDraft,
  opts: { original: ProviderGroup | null; takenNames: ReadonlySet<string> },
): DraftProblem[] {
  const out: DraftProblem[] = [];
  const unified = draft.mode === 'custom_unified';
  const sourceAllowed = unified && draft.useSource;
  const savedSource = Boolean(opts.original?.source_name);
  if (!draft.name.trim()) out.push('name');
  if (!draft.baseUrl.trim()) out.push('baseUrl');
  // A stored key is enough when the group stays unified.
  const keyStored = Boolean(opts.original?.api_key_configured) && opts.original?.mode === 'custom_unified';
  if (unified && !draft.apiKey.trim() && !keyStored) out.push('apiKey');
  if (sourceAllowed) {
    if (!savedSource && validateSourceName(draft.sourceName, opts.takenNames)) out.push('sourceName');
    if (draft.sourceFormats.length === 0) out.push('formats');
  }
  if (draft.agents.length === 0 && !(sourceAllowed && draft.sourceAgents.length > 0)) out.push('noAgent');
  return out;
}

export function sourceInputOf(draft: GroupDraft, includeName: boolean): SourceInput {
  return {
    ...(includeName ? { source_name: draft.sourceName } : {}),
    source_provider: draft.providerSlug,
    source_formats: draft.sourceFormats,
    source_agents: draft.sourceAgents,
    source_enabled: draft.sourceEnabled,
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * PATCH body for an edit: only the fields that differ from the stored group.
 * The key is sent only when the admin typed one. The source name is sent only for the first save
 * of a source, because Core refuses to rename a saved source.
 */
export function buildUpdate(original: ProviderGroup, draft: GroupDraft): UpdateGroupInput {
  const patch: UpdateGroupInput = { group_id: original.group_id, expected_version: original.version };
  if (draft.name.trim() !== original.name) patch.name = draft.name.trim();
  if (draft.mode !== original.mode) patch.mode = draft.mode;
  if (draft.baseUrl.trim() !== original.base_url) patch.base_url = draft.baseUrl.trim();
  if (draft.apiKey.trim()) patch.api_key = draft.apiKey.trim();
  if (draft.description !== original.description) patch.description = draft.description;
  if (!sameSet(draft.agents, original.agents)) patch.agents = draft.agents;
  if (draft.modelId.trim() !== original.model_id) patch.model_id = draft.modelId.trim();
  if (draft.enabled !== original.enabled) patch.enabled = draft.enabled;

  if (draft.mode === 'custom_unified' && draft.useSource) {
    if (!original.source_name) {
      Object.assign(patch, sourceInputOf(draft, true));
    } else {
      if (!sameSet(draft.sourceFormats, original.source_formats)) patch.source_formats = draft.sourceFormats;
      if (!sameSet(draft.sourceAgents, original.source_agents)) patch.source_agents = draft.sourceAgents;
      if (draft.sourceEnabled !== original.source_enabled) patch.source_enabled = draft.sourceEnabled;
      if (draft.providerSlug !== original.source_provider) patch.source_provider = draft.providerSlug;
    }
  }
  return patch;
}

/** True when the patch carries anything besides the identity fields. */
export function hasChanges(patch: UpdateGroupInput): boolean {
  return Object.keys(patch).some((k) => k !== 'group_id' && k !== 'expected_version');
}

/**
 * PATCH body for the source part of a subscription pool group. It never carries `agents`,
 * `enabled`, `mode` or `source_enabled`: the pool switch owns the first three and the pool
 * source follows the switch.
 */
export function buildPoolSourceUpdate(
  groupId: string,
  input: { sourceName?: string; sourceAgents: string[] },
): UpdateGroupInput {
  return {
    group_id: groupId,
    ...(input.sourceName ? { source_name: input.sourceName } : {}),
    source_agents: input.sourceAgents,
  };
}

// ───────────── what clients see ─────────────

/** One source in the preview, from an API-key group or from a pool. */
export interface PreviewSource {
  kind: 'api' | 'sub';
  name: string;
  providerLabel: string;
  formats: readonly SourceFormat[];
  agents: readonly string[];
  /** API group: `source_enabled`. Pool: the pool switch. */
  active: boolean;
  models: readonly SourceModel[];
}

export function previewSourcesFrom(
  groups: readonly ProviderGroup[],
  pools: readonly { provider: 'claude' | 'codex'; enabled: boolean; source: PoolSourceView | null }[],
  poolLabel: (provider: 'claude' | 'codex') => string,
): PreviewSource[] {
  const out: PreviewSource[] = [];
  for (const pool of pools) {
    const s = pool.source;
    if (!s || !s.source_name) continue;
    out.push({
      kind: 'sub',
      name: s.source_name,
      providerLabel: poolLabel(pool.provider),
      formats: s.source_formats,
      agents: s.source_agents,
      active: s.source_active,
      models: s.source_models,
    });
  }
  for (const g of groups) {
    if (!g.source_name || g.mode !== 'custom_unified') continue;
    out.push({
      kind: 'api',
      name: g.source_name,
      providerLabel: g.name,
      formats: g.source_formats,
      agents: g.source_agents,
      active: g.source_enabled,
      models: g.source_models,
    });
  }
  return out;
}

export interface ExposedModel {
  /** `<source>/<model>`: what the client sends. */
  id: string;
  model: string;
  source: PreviewSource;
}

/** Models `GET /<agent>/<space>/v1/models` lists: open sources, ticked and still listed models. */
export function exposedFor(agent: string, sources: readonly PreviewSource[]): ExposedModel[] {
  const out: ExposedModel[] = [];
  for (const source of sources) {
    if (!source.active || !source.agents.includes(agent)) continue;
    for (const m of source.models) {
      if (m.enabled && m.available) out.push({ id: `${source.name}/${m.id}`, model: m.id, source });
    }
  }
  return out;
}

/** Subscription sources that are off because their pool is off and that the agent would use. */
export function sourcesOffByPool(agent: string, sources: readonly PreviewSource[]): PreviewSource[] {
  return sources.filter((s) => s.kind === 'sub' && !s.active && s.agents.includes(agent));
}

/** How many sources offer each bare model id. */
export function modelSourceCounts(list: readonly ExposedModel[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const x of list) counts.set(x.model, (counts.get(x.model) ?? 0) + 1);
  return counts;
}

const OMP_API: Record<SourceFormat, string> = {
  'anthropic-messages': 'anthropic-messages',
  'openai-responses': 'openai-responses',
  'openai-chat': 'openai-completions',
};
const OMP_PROVIDER: Record<SourceFormat, string> = {
  'anthropic-messages': 'memory-anthropic',
  'openai-responses': 'memory-responses',
  'openai-chat': 'memory-chat',
};
const OMP_PATH: Record<SourceFormat, string> = {
  'anthropic-messages': '/omp/<space>',
  'openai-responses': '/omp/<space>/v1',
  'openai-chat': '/omp/<space>/v1',
};

/**
 * The `models.yml` block that setup-proxy writes for omp: one provider per format; a source with
 * several formats is listed under its first format. The key is always a placeholder.
 */
export function ompModelsYaml(list: readonly ExposedModel[], origin: string): string {
  const lines = ['# Written by setup-proxy --agent omp. Do not edit the memory-* providers by hand.', 'providers:'];
  let written = 0;
  for (const format of SOURCE_FORMATS) {
    const items = list.filter((x) => x.source.formats[0] === format);
    if (items.length === 0) continue;
    written += items.length;
    lines.push(
      `  ${OMP_PROVIDER[format]}:`,
      `    api: ${OMP_API[format]}`,
      `    baseUrl: ${origin}${OMP_PATH[format]}`,
      '    apiKey: sk-••••',
      '    headers:',
      '      x-team-id: <team-id>',
      '      x-agent-id: <agent-id>',
      '    compat:',
      '      supportsPromptCacheKey: true',
      '    models:',
      ...items.map((x) => `      - id: ${x.id}`),
    );
  }
  if (written === 0) lines.push('  {}  # no model for omp');
  return lines.join('\n');
}
