/**
 * Loads the custom upstream groups (key-free view) and the pool status, so the page knows which
 * source names the groups and the pools already use.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { modelProvidersApi, type ProviderGroup } from '@/lib/api/model-providers';
import { subscriptionPoolApi, type SubscriptionPoolProviderStatus } from '@/lib/api/subscription-pool';

export interface ProviderGroupsState {
  groups: ProviderGroup[];
  pools: SubscriptionPoolProviderStatus[];
  loading: boolean;
  error: unknown;
  /** Source names held by other groups and by pools. */
  takenNames: (exceptGroupId?: string) => Set<string>;
  /** Reload now and return the new list. */
  reload: () => Promise<ProviderGroup[]>;
}

export function useProviderGroups(): ProviderGroupsState {
  const [groups, setGroups] = useState<ProviderGroup[]>([]);
  const [pools, setPools] = useState<SubscriptionPoolProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // Only the newest request may write state.
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [g, p] = await Promise.all([modelProvidersApi.view(), subscriptionPoolApi.status()]);
      if (mine !== seq.current) return g;
      setGroups(g);
      setPools(p.providers);
      setError(null);
      return g;
    } catch (e) {
      if (mine === seq.current) setError(e);
      return [];
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      seq.current++;
    };
  }, [reload]);

  const takenNames = useCallback(
    (exceptGroupId?: string) => {
      const out = new Set<string>();
      for (const g of groups) if (g.source_name && g.group_id !== exceptGroupId) out.add(g.source_name);
      for (const p of pools) if (p.source?.source_name) out.add(p.source.source_name);
      return out;
    },
    [groups, pools],
  );

  return { groups, pools, loading, error, takenNames, reload };
}
