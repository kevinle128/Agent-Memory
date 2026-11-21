/**
 * Loads the custom upstream groups (key-free view), so the page knows which source names the
 * groups already use. The fixed names of the team pools are always taken.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { modelProvidersApi, type ProviderGroup } from '@/lib/api/model-providers';
import { POOL_SOURCE_NAMES } from '@/lib/subscription-pool-display';

export interface ProviderGroupsState {
  groups: ProviderGroup[];
  loading: boolean;
  error: unknown;
  /** Source names held by other groups, and the fixed names of the team pools. */
  takenNames: (exceptGroupId?: string) => Set<string>;
  /** Reload now and return the new list. */
  reload: () => Promise<ProviderGroup[]>;
}

export function useProviderGroups(): ProviderGroupsState {
  const [groups, setGroups] = useState<ProviderGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // Only the newest request may write state.
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const g = await modelProvidersApi.view();
      if (mine !== seq.current) return g;
      setGroups(g);
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
      const out = new Set<string>(POOL_SOURCE_NAMES);
      for (const g of groups) if (g.source_name && g.group_id !== exceptGroupId) out.add(g.source_name);
      return out;
    },
    [groups],
  );

  return { groups, loading, error, takenNames, reload };
}
