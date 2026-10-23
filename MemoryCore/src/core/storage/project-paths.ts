/**
 * Key layout for per-project L2/L3 files inside one profile scope.
 *
 * A project partitions memory INSIDE the existing `team|agent` scope, by key
 * prefix. The scope string itself never changes. The reason: the row backends
 * filter profile rows by team, agent and filename prefix only, so a prefix can
 * be filtered everywhere, but a new scope string would mix projects.
 *
 *   scene_blocks/<name>.md  ->  scene_blocks/projects/<H>/<name>.md
 *   .metadata/<...>         ->  .metadata/projects/<H>/<...>
 *   .backup/<...>           ->  .backup/projects/<H>/<...>
 *   persona.md              ->  project_personas/<H>.md
 *
 * This module has no imports on purpose: the row backend, the composite router
 * and the project storage wrapper all need these names, and a shared leaf
 * module keeps them from importing each other.
 */

/** A project hash is 16 lowercase hex characters. */
export const PROJECT_HASH_PATTERN = /^[0-9a-f]{16}$/;

/** Directory below `scene_blocks/` (and below any other directory) that holds project files. */
export const PROJECT_DIR = "projects/";

/** Top-level directory that holds project L3 documents. */
export const PROJECT_PERSONA_DIR = "project_personas/";

const PROJECT_PERSONA_KEY_PATTERN = /^project_personas\/([0-9a-f]{16})\.md$/;
const PROJECT_SCENE_FILENAME_PATTERN = /^projects\/([0-9a-f]{16})\//;

export function isProjectHash(value: unknown): value is string {
  return typeof value === "string" && PROJECT_HASH_PATTERN.test(value);
}

/** Throw unless `value` is a valid project hash. Returns it for chaining. */
export function assertProjectHash(value: unknown): string {
  if (!isProjectHash(value)) {
    throw new Error(`Invalid project hash: ${JSON.stringify(value)} (expected 16 lowercase hex characters)`);
  }
  return value;
}

/** Filename prefix of a project's scenes, relative to `scene_blocks/`. */
export function projectSceneFilenamePrefix(hash: string): string {
  return `${PROJECT_DIR}${assertProjectHash(hash)}/`;
}

/** Storage key of a project's L3 document. */
export function projectPersonaKey(hash: string): string {
  return `${PROJECT_PERSONA_DIR}${assertProjectHash(hash)}.md`;
}

/**
 * Whether a scene filename (relative to `scene_blocks/`) lies below `projects/`.
 * Deliberately wider than "valid project hash": anything below `projects/` is
 * outside the user-global (root) scene set.
 */
export function isProjectSceneFilename(filename: string): boolean {
  return filename.startsWith(PROJECT_DIR);
}

/** Project hash of a project L3 key (`project_personas/<H>.md`), or undefined. */
export function projectHashOfPersonaKey(key: string): string | undefined {
  return PROJECT_PERSONA_KEY_PATTERN.exec(key)?.[1];
}

/** Project hash of a project scene filename (`projects/<H>/<name>.md`), or undefined. */
export function projectHashOfSceneFilename(filename: string): string | undefined {
  return PROJECT_SCENE_FILENAME_PATTERN.exec(filename)?.[1];
}

/**
 * Project hash a profile row belongs to, or undefined for a user-global row.
 * Uses the row's own `type` and `filename`, the same two columns the row
 * backend keys on.
 */
export function projectHashOfProfile(row: { type: "l2" | "l3"; filename: string }): string | undefined {
  return row.type === "l2"
    ? projectHashOfSceneFilename(row.filename)
    : projectHashOfPersonaKey(row.filename);
}

/**
 * Whether a profile row is outside the user-global set. L2 rows below
 * `projects/` count even when the hash is malformed, so a bad name can never
 * leak into the root view.
 */
export function isProjectProfile(row: { type: "l2" | "l3"; filename: string }): boolean {
  return row.type === "l2"
    ? isProjectSceneFilename(row.filename)
    : row.filename.startsWith(PROJECT_PERSONA_DIR);
}
