/**
 * model-source.ts — pure rules for model sources on the Model Provider and Subscription Pool pages
 * and their model picker.
 * No React, no network: the pages call these helpers and tests cover them directly.
 */
import type { SourceFormat, SourceModel } from './api/model-providers';

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

// ───────────── model list ─────────────

export function countEnabled(models: readonly SourceModel[]): number {
  return models.filter((m) => m.enabled && m.available).length;
}

export function countAvailable(models: readonly SourceModel[]): number {
  return models.filter((m) => m.available).length;
}

/** Models that match the search text (id or display name). */
export function filterModels(models: readonly SourceModel[], query: string): SourceModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...models];
  return models.filter((m) => m.id.toLowerCase().includes(q) || m.display_name.toLowerCase().includes(q));
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

export function toggleInList(list: readonly string[], value: string, on: boolean): string[] {
  const without = list.filter((x) => x !== value);
  return on ? [...without, value] : without;
}
