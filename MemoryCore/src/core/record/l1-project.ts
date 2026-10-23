/**
 * Project resolution for L1 memories.
 *
 * An L1 memory is extracted from several L0 messages. Those messages may come
 * from different projects (one session can move between projects). A memory is
 * tagged with a project only when all of its sources agree. Any doubt gives
 * "no project", so a memory is never shown under a wrong project.
 */

/** A project label as carried by L0 and L1 records. Empty or absent means no project. */
export interface ProjectRef {
  projectKey?: string;
  projectHash?: string;
}

/** The result of project resolution. Both fields are empty strings for "no project". */
export interface ResolvedProject {
  projectKey: string;
  projectHash: string;
}

const NO_PROJECT: ResolvedProject = { projectKey: "", projectHash: "" };

/**
 * Return the common project of all items.
 *
 * The hash is the identity of a project. The result is empty when the list is
 * empty, when any item has no hash or no key, or when the hashes differ.
 */
export function resolveUnanimousProject(items: readonly ProjectRef[]): ResolvedProject {
  if (items.length === 0) return NO_PROJECT;
  const first = items[0]!;
  if (!first.projectHash || !first.projectKey) return NO_PROJECT;
  for (const item of items) {
    if (!item.projectHash || !item.projectKey) return NO_PROJECT;
    if (item.projectHash !== first.projectHash) return NO_PROJECT;
  }
  return { projectKey: first.projectKey, projectHash: first.projectHash };
}

/**
 * Resolve the project of one extracted memory from its source messages.
 *
 * When the memory names source message ids, only those messages count. An id
 * that matches no message in `pool` counts as "no project", because the memory
 * then has a source that cannot be checked. When the memory names no source,
 * the batch it was extracted from (`fallback`, default `pool`) is the source.
 */
export function resolveMemoryProject(
  sourceMessageIds: readonly string[],
  pool: ReadonlyArray<ProjectRef & { id: string }>,
  fallback: readonly ProjectRef[] = pool,
): ResolvedProject {
  if (sourceMessageIds.length === 0) return resolveUnanimousProject(fallback);
  const byId = new Map(pool.map((m) => [m.id, m] as const));
  const sources: ProjectRef[] = [];
  for (const id of sourceMessageIds) {
    const message = byId.get(id);
    if (!message) return NO_PROJECT;
    sources.push(message);
  }
  return resolveUnanimousProject(sources);
}
