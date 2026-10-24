/** Diff of two stored versions of a skill. */
import { useEffect, useState } from 'react';
import { diffSkillVersions, type SkillDiff } from '@/lib/api/skill-api';

export function useVersionDiff(
  skillId: string | undefined,
  teamId: string | undefined,
  from: number | undefined,
  to: number | undefined,
) {
  const [diff, setDiff] = useState<SkillDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!skillId || !from || !to) {
      setDiff(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    diffSkillVersions({ skill_id: skillId, team_id: teamId, from_version: from, to_version: to })
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((err) => {
        if (cancelled) return;
        setDiff(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skillId, teamId, from, to]);

  return { diff, loading, error };
}
