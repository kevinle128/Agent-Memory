/**
 * api/model-providers.ts — custom upstream groups used as model sources (meta/instance-upstream/groups/*).
 *
 * Reads use `groups/view`, which has no key field at all (only `api_key_configured`).
 * Writes need System Admin and the kernel enforces the role. This module never sends an empty
 * api_key, because Core reads an empty string as "clear the key".
 */
import { metaPost } from './base';

export type SourceFormat = 'anthropic-messages' | 'openai-chat' | 'openai-responses';
export type GroupMode = 'custom_unified' | 'custom_passthrough';

export interface SourceModel {
  id: string;
  display_name: string;
  enabled: boolean;
  /** False when the provider no longer lists the model. */
  available: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

/** Source fields shared by API-key groups and subscription pool groups. */
export interface SourceFields {
  source_name: string;
  source_provider: string;
  source_formats: SourceFormat[];
  source_agents: string[];
  source_models: SourceModel[];
  source_models_fetched_at: string | null;
  source_models_error: string | null;
}

/** One custom group as `groups/view` returns it. No key field. */
export interface ProviderGroup extends SourceFields {
  group_id: string;
  group_type: 'custom';
  name: string;
  agents: string[];
  enabled: boolean;
  mode: GroupMode;
  base_url: string;
  api_key_configured: boolean;
  model_id: string;
  description: string;
  source_enabled: boolean;
  version: number;
  updated_at: string;
}

/** Source block that `subscription-pool/status` adds for each provider. */
export interface PoolSourceView extends SourceFields {
  /** Follows the pool switch. */
  source_active: boolean;
}

/** Fields a caller may send for the source part of a group. Fetch results are written by Core only. */
export interface SourceInput {
  source_name?: string;
  source_provider?: string;
  source_formats?: SourceFormat[];
  source_agents?: string[];
  source_enabled?: boolean;
}

export interface CreateGroupInput extends SourceInput {
  name: string;
  agents: string[];
  enabled?: boolean;
  mode: GroupMode;
  base_url: string;
  api_key?: string;
  model_id?: string;
  description?: string;
}

export interface UpdateGroupInput extends SourceInput {
  group_id: string;
  expected_version?: number;
  name?: string;
  agents?: string[];
  enabled?: boolean;
  mode?: GroupMode;
  base_url?: string;
  /** Leave out to keep the stored key. */
  api_key?: string;
  model_id?: string;
  description?: string;
}

/** Group as the write actions return it. Admin shape: a masked key that this Panel never reads. */
export type WrittenGroup = ProviderGroup;

export const modelProvidersApi = {
  view: async (): Promise<ProviderGroup[]> => {
    const res = await metaPost<{ items: ProviderGroup[] }>('instance-upstream/groups/view', {});
    return res.items ?? [];
  },

  suggestSourceName: async (kind: 'subscription' | 'api', provider: string): Promise<string> => {
    const res = await metaPost<{ source_name: string }>('instance-upstream/groups/suggest-source-name', {
      kind,
      provider,
    });
    return res.source_name;
  },

  create: (input: CreateGroupInput) =>
    metaPost<WrittenGroup>('instance-upstream/groups/create', { group_type: 'custom', ...input }),

  update: (input: UpdateGroupInput) =>
    metaPost<WrittenGroup>('instance-upstream/groups/update', { group_type: 'custom', ...input }),

  toggle: (groupId: string, enabled: boolean, expectedVersion?: number) =>
    metaPost<{ enabled: boolean }>('instance-upstream/groups/toggle', {
      group_id: groupId,
      group_type: 'custom',
      enabled,
      ...(expectedVersion !== undefined ? { expected_version: expectedVersion } : {}),
    }),

  remove: (groupId: string) =>
    metaPost<{ deleted: boolean }>('instance-upstream/groups/delete', { group_id: groupId, group_type: 'custom' }),

  /** Tick models on or off in one call. */
  updateModels: (groupId: string, models: { id: string; enabled: boolean }[], expectedVersion?: number) =>
    metaPost<WrittenGroup>('instance-upstream/groups/source-models/update', {
      group_id: groupId,
      models,
      ...(expectedVersion !== undefined ? { expected_version: expectedVersion } : {}),
    }),

  /** Fetch the provider model list now. A failed fetch comes back as `source_models_error`, not as an error. */
  refresh: (groupId: string) =>
    metaPost<WrittenGroup>('instance-upstream/groups/source-refresh', { group_id: groupId }),
};
