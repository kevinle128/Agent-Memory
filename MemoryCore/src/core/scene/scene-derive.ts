/**
 * Derive the scene index from L2 profile rows (phase-2 task T2.1).
 *
 * The file-backed pipeline keeps a `.metadata/scene_index.json` that
 * `syncSceneIndex()` rebuilds by scanning `scene_blocks/`. A row-backed store
 * needs no such sidecar: the rows already carry the block content, so the index
 * is a projection of them and can be computed on demand.
 *
 * This module deliberately holds no path knowledge. It selects rows by type and
 * isolation, and the row's own `filename` becomes the entry's filename — the
 * same value `syncSceneIndex()` gets from the directory listing, so both
 * producers agree without either one spelling a prefix (design doc D12 ①).
 */

import type { ProfileIsolation } from "../profile/profile-scope.js";
import { profileScopeFilter } from "../profile/profile-scope.js";
import type { ProfileRowCapableStore } from "../store/types.js";
import { parseSceneBlock } from "./scene-format.js";
import { isProjectSceneFilename, projectSceneFilenamePrefix } from "../storage/project-paths.js";
import type { SceneIndexEntry } from "./scene-index.js";

/**
 * Which rows of one isolation scope an index covers.
 *  - omitted: every L2 row of the scope, unfiltered;
 *  - `"root"`: the user-global scenes, without anything below `projects/`;
 *  - `{ projectHash }`: one project's scenes, filenames relative to that project.
 */
export type SceneIndexView = "root" | { projectHash: string };

/**
 * Build scene index entries from the L2 rows of one isolation scope.
 *
 * @param store     Data plane holding the profile rows.
 * @param isolation Tenancy to read; omitted reads the store's whole L2 set.
 * @param view      Row subset to project (see {@link SceneIndexView}).
 * @returns Entries sorted by filename, so repeated calls are comparable.
 *          Ordering for display is the caller's business —
 *          `generateSceneNavigation()` re-sorts by heat.
 *
 * Heat comes from the block's META section. M4 (T4.3) will prefer a dedicated
 * `heat` row column and keep this as the fallback for rows written before it.
 */
export async function deriveSceneIndexFromProfiles(
  store: ProfileRowCapableStore,
  isolation?: ProfileIsolation,
  view?: SceneIndexView,
): Promise<SceneIndexEntry[]> {
  const projectPrefix = typeof view === "object" ? projectSceneFilenamePrefix(view.projectHash) : undefined;
  const rows = await store.queryProfiles(profileScopeFilter(isolation, {
    type: "l2",
    ...(projectPrefix ? { pathPrefix: projectPrefix } : {}),
  }));

  return rows
    .filter((row) => view !== "root" || !isProjectSceneFilename(row.filename))
    .map((row) => {
      const filename = projectPrefix ? row.filename.slice(projectPrefix.length) : row.filename;
      const { meta } = parseSceneBlock(row.content, filename);
      return {
        filename,
        summary: meta.summary,
        heat: meta.heat,
        created: meta.created,
        updated: meta.updated,
      };
    })
    .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
}
