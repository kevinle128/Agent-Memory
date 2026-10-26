/**
 * client-sources.ts — pure rules for choosing model sources per client on the API Key page.
 * No React, no network: the components call these helpers and tests cover them directly.
 */
import type { ClientSource, ClientSourceAgent } from './api/client-sources';
import type { SourceFormat } from './api/model-providers';

const ALL_FORMATS: readonly SourceFormat[] = ['anthropic-messages', 'openai-responses', 'openai-chat'];

/** Wire formats of a client. A Core build that does not send `formats` is treated as "all three". */
export function agentFormats(agent: ClientSourceAgent): readonly SourceFormat[] {
  if (agent.mode === 'single' && agent.format) return [agent.format];
  return agent.formats && agent.formats.length > 0 ? agent.formats : ALL_FORMATS;
}

/**
 * Sources a client may pick: only sources that are on and fit the client format.
 * A single-source client needs its own format; a multi-source client needs one shared format.
 */
export function sourceOptions(agent: ClientSourceAgent, sources: readonly ClientSource[]): ClientSource[] {
  const formats = agentFormats(agent);
  return sources.filter((s) => s.enabled && s.formats.some((f) => formats.includes(f)));
}

/** Selected sources that exist in the list, in the order the client holds them. */
export function selectedSources(agent: ClientSourceAgent, sources: readonly ClientSource[]): ClientSource[] {
  const byName = new Map(sources.map((s) => [s.source_name, s]));
  return agent.selected.flatMap((name) => byName.get(name) ?? []);
}

/** Models a multi-source client lists under `/v1/models`: ticked models of the sources that are on. */
export function exposedModelCount(selected: readonly ClientSource[]): number {
  return selected.filter((s) => s.enabled).reduce((sum, s) => sum + s.models_on, 0);
}

/** Next selection after a multi-source client adds or removes one source. */
export function toggleSource(selected: readonly string[], name: string): string[] {
  return selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name];
}

/** Clients that hold the source, in list order. */
export function clientsUsing(agents: readonly ClientSourceAgent[], sourceName: string): ClientSourceAgent[] {
  return agents.filter((a) => a.selected.includes(sourceName));
}

/** Option rows of a dropdown, filtered by the search text on source name or provider. */
export function filterOptions(options: readonly ClientSource[], query: string): ClientSource[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  return options.filter((s) => s.source_name.toLowerCase().includes(q) || s.provider.toLowerCase().includes(q));
}

export interface SourceInUse {
  sourceName: string;
  /** Agent ids of the clients that still use the source. */
  clients: string[];
}

/**
 * Reads a SOURCE_IN_USE error. Core sends `{source_name, clients}` in the envelope `data`; when the
 * body is not JSON the client list comes from the message "source x is used by: a,b".
 */
export function parseSourceInUse(body: string | undefined, rawMessage: string | undefined): SourceInUse | null {
  if (!rawMessage || !/^SOURCE_IN_USE\b/.test(rawMessage.trim())) return null;
  try {
    const env = JSON.parse(body ?? '') as { data?: { source_name?: unknown; clients?: unknown } | null };
    const clients = env.data?.clients;
    if (Array.isArray(clients) && clients.every((c) => typeof c === 'string')) {
      return { sourceName: typeof env.data?.source_name === 'string' ? env.data.source_name : '', clients };
    }
  } catch {
    /* fall through to the message */
  }
  const m = /source (\S+) is used by:\s*(.+)$/.exec(rawMessage);
  if (!m) return { sourceName: '', clients: [] };
  return { sourceName: m[1]!, clients: m[2]!.split(',').map((c) => c.trim()).filter(Boolean) };
}

/** Codes that mean the shown client or source data is older than the stored data. */
export const CLIENT_SOURCE_STALE_CODES: ReadonlySet<string> = new Set([
  'WRITE_CONFLICT',
  'SOURCE_DISABLED',
  'SOURCE_NOT_FOUND',
  'SOURCE_FORMAT_MISMATCH',
]);
