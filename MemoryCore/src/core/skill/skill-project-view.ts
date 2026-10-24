/**
 * What the extractor may see of the skill library.
 *
 * With a project, the extractor sees the global skills and the skills of that
 * project, and never the skills of another project. A row written before the
 * scope column existed reads back as global, so it stays visible.
 */

import type { IdFields, Skill } from "./types.js";
import type { SkillCore } from "./skill-core.js";
import type { SkillSearchResult } from "./skill-store.interface.js";

/** Rows read from the store per round trip while collecting visible skills. */
const PAGE_SIZE = 200;
/** Upper bound of rows scanned for one listing. Guards a very large library. */
const MAX_SCANNED_ROWS = 5000;
/** A search asks for more hits than needed, because hits of other projects are removed. */
const SEARCH_OVERFETCH = 4;
const SEARCH_MAX_TOP_K = 100;

/**
 * True when a session of `projectHash` may see the skill.
 * A `null` hash means a session without a project: only global skills are visible.
 */
export function isVisibleToProject(
  skill: Pick<Skill, "scope" | "project_hash">,
  projectHash: string | null,
): boolean {
  return skill.scope !== "project" || (projectHash !== null && skill.project_hash === projectHash);
}

type ListFilters = Parameters<SkillCore["list"]>[0]["filters"];

/**
 * The newest visible skills, at most `limit`, with the count of all visible
 * skills. The store has no project filter, so pages are read and filtered here.
 * `offset` skips visible skills, not stored rows, so paging stays correct.
 */
export async function listVisibleSkills(
  core: SkillCore,
  ids: IdFields,
  projectHash: string | null,
  limit: number,
  opts: { offset?: number; filters?: ListFilters } = {},
): Promise<{ items: Skill[]; total: number }> {
  const items: Skill[] = [];
  const skip = opts.offset ?? 0;
  let total = 0;
  let offset = 0;
  let truncated = false;
  while (true) {
    if (offset >= MAX_SCANNED_ROWS) { truncated = true; break; }
    const page = await core.list({
      ...ids,
      ...(opts.filters ? { filters: opts.filters } : {}),
      pagination: { limit: PAGE_SIZE, offset },
    });
    for (const s of page.items) {
      if (!isVisibleToProject(s, projectHash)) continue;
      total++;
      if (total > skip && items.length < limit) items.push(s);
    }
    offset += PAGE_SIZE;
    if (page.items.length < PAGE_SIZE || offset >= page.total) break;
  }
  if (truncated) {
    console.warn(`[skill-project-view] scan stopped at ${MAX_SCANNED_ROWS} rows; the listing may miss skills`);
  }
  return { items, total };
}

/** Best matches among the visible skills, at most `topK`. */
export async function searchVisibleSkills(
  core: SkillCore,
  ids: IdFields,
  projectHash: string | null,
  query: string,
  topK: number,
  mode?: "bm25" | "embedding" | "hybrid",
): Promise<SkillSearchResult[]> {
  const hits = await core.search({
    ...ids,
    query,
    ...(mode ? { mode } : {}),
    top_k: Math.min(topK * SEARCH_OVERFETCH, SEARCH_MAX_TOP_K),
  });
  return hits.filter((h) => isVisibleToProject(h.skill, projectHash)).slice(0, topK);
}
