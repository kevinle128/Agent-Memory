/** Loads every version of one skill (newest first) with its audit fields. */
import { useEffect, useState } from 'react';
import { listSkillVersions, type SkillSummary } from '@/lib/api/skill-api';
import { sortVersionsDesc } from '../lib/skill-scope';

export function useSkillVersions(
  skillId: string | undefined,
  teamId: string | undefined,
  /** Change this value to force a reload (after a rollback, for example). */
  reloadKey: number,
) {
  const [versions, setVersions] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!skillId) {
      setVersions([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listSkillVersions({
      skill_id: skillId,
      team_id: teamId,
      pagination: { limit: 200, offset: 0 },
    })
      .then((res) => {
        if (!cancelled) setVersions(sortVersionsDesc(res.items));
      })
      .catch((err) => {
        if (cancelled) return;
        setVersions([]);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skillId, teamId, reloadKey]);

  return { versions, loading, error };
}
