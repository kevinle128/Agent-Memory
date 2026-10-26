/**
 * api/client-sources.ts — which model sources each client uses (meta/instance-upstream/client-sources/*).
 *
 * `list` is open to every signed-in user and carries no key field. `update` needs System Admin
 * and the kernel enforces the role. Sources are shared by the whole instance.
 */
import { metaPost } from './base';
import type { SourceFormat } from './model-providers';

export type SourceKind = 'subscription' | 'api';

export interface ClientSourceAgent {
  agent: string;
  display_name: string;
  /** single: exactly one source, no model prefix. multi: any number, models are `<source>/<model>`. */
  mode: 'single' | 'multi';
  /** Wire format of a single-source client. */
  format?: SourceFormat;
  /** Wire formats the client speaks. Older Core builds leave it out. */
  formats?: SourceFormat[];
  /** Names of the sources the client uses now. */
  selected: string[];
}

export interface ClientSource {
  source_name: string;
  source_type: SourceKind;
  provider: string;
  formats: SourceFormat[];
  /** The source is on: group on, and for an API source its source switch on. */
  enabled: boolean;
  models_on: number;
  models_total: number;
}

export interface ClientSourcesView {
  agents: ClientSourceAgent[];
  sources: ClientSource[];
}

export const clientSourcesApi = {
  list: async (): Promise<ClientSourcesView> => {
    const res = await metaPost<Partial<ClientSourcesView>>('instance-upstream/client-sources/list', {});
    return { agents: res.agents ?? [], sources: res.sources ?? [] };
  },

  /** Replace the sources of one client. Returns the stored entry of that client. */
  update: (agent: string, sources: string[]) =>
    metaPost<ClientSourceAgent>('instance-upstream/client-sources/update', { agent, sources }),
};
