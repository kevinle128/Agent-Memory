/**
 * Project-scoped storage views.
 *
 * Scene extraction is written against a plain key space (`scene_blocks/`,
 * `.metadata/`, `.backup/`, `persona.md`). A project-scoped view lets the same
 * code run unchanged inside one project: it maps every key into the project
 * prefix (see project-paths.ts) and maps listed keys back. The extractor, its
 * LLM file tools, the checkpoint and the scene index therefore cannot read or
 * write a file outside the project.
 *
 * Two views are built here:
 *  - {@link createProjectScopedStorage}: the key-mapping view for one project.
 *  - {@link createAllProjectsSceneView}: a pass-through view whose scene index
 *    is the union of the root scenes and every project's scenes. Only the
 *    user-global L3 run uses it.
 */

import { readSceneIndex, type SceneIndexEntry } from "../scene/scene-index.js";
import { StorageAdapter } from "./adapter.js";
import {
  PROJECT_DIR,
  PROJECT_HASH_PATTERN,
  assertProjectHash,
  projectPersonaKey,
  projectSceneFilenamePrefix,
} from "./project-paths.js";
import {
  StoragePaths,
  type IStorageBackend,
  type ListEntry,
  type ListObjectsOptions,
  type ListResult,
  type PutObjectOptions,
  type StorageObject,
} from "./types.js";

/** Optional index capability of a row-view backend (see scene-index.ts). */
interface ProjectIndexDerivable {
  deriveSceneIndex(opts?: { projectHash?: string }): Promise<SceneIndexEntry[]>;
}

function asProjectIndexDerivable(backend: IStorageBackend): ProjectIndexDerivable | null {
  const candidate = backend as unknown as Partial<ProjectIndexDerivable>;
  return typeof candidate.deriveSceneIndex === "function" ? candidate as ProjectIndexDerivable : null;
}

class ProjectScopedStorageBackend implements IStorageBackend {
  readonly type: IStorageBackend["type"];
  /**
   * Present only when the base backend derives its scene index from rows.
   * The scene-index code detects this method by shape, so it must not exist
   * on a view over a file backend: that view reads `.metadata/projects/<H>/`.
   */
  deriveSceneIndex?: () => Promise<SceneIndexEntry[]>;

  private readonly projectDir: string;
  private readonly personaKey: string;

  constructor(private readonly base: IStorageBackend, private readonly projectHash: string) {
    // Type is copied on purpose: profile sync skips row-view backends by type.
    this.type = base.type;
    this.projectDir = `${PROJECT_DIR}${projectHash}/`;
    this.personaKey = projectPersonaKey(projectHash);

    const derivable = asProjectIndexDerivable(base);
    if (derivable) {
      this.deriveSceneIndex = () => derivable.deriveSceneIndex({ projectHash });
    }
  }

  /** Same validation as the profile scope wrapper: no NUL, no absolute path, no `..`. */
  private normalize(key: string): string {
    if (typeof key !== "string" || key.includes("\0") || key.startsWith("/") || key.startsWith("\\")) {
      throw new Error(`Invalid project storage key: ${JSON.stringify(key)}`);
    }
    const parts = key.replace(/\\+/g, "/").split("/");
    if (parts.some((part) => part === "..")) {
      throw new Error(`Path traversal rejected in project storage key: ${key}`);
    }
    // Drop empty and "." segments: the local backend resolves them away, so a
    // key such as "./persona.md" must map like "persona.md".
    const trailing = key.endsWith("/") && parts.some((p) => p !== "" && p !== ".") ? "/" : "";
    return parts.filter((part) => part !== "" && part !== ".").join("/") + trailing;
  }

  /**
   * `persona.md` -> `project_personas/<H>.md`, `D/rest` -> `D/projects/<H>/rest`.
   * A bare top-level name has no directory to put the prefix in, so it is
   * rejected instead of being written next to the user-global files.
   */
  private toBase(key: string): string {
    const normalized = this.normalize(key);
    if (normalized === StoragePaths.persona) return this.personaKey;
    const slash = normalized.indexOf("/");
    if (slash <= 0) {
      throw new Error(`Project storage key has no directory and cannot be scoped: ${JSON.stringify(key)}`);
    }
    return `${normalized.slice(0, slash)}/${this.projectDir}${normalized.slice(slash + 1)}`;
  }

  /** Inverse of {@link toBase}. Returns null for a key outside this project. */
  private fromBase(baseKey: string): string | null {
    if (baseKey === this.personaKey) return StoragePaths.persona;
    const slash = baseKey.indexOf("/");
    if (slash <= 0) return null;
    const rest = baseKey.slice(slash + 1);
    if (!rest.startsWith(this.projectDir)) return null;
    return `${baseKey.slice(0, slash)}/${rest.slice(this.projectDir.length)}`;
  }

  async putObject(key: string, content: string | Buffer, opts?: PutObjectOptions): Promise<void> {
    return this.base.putObject(this.toBase(key), content, opts);
  }

  async appendObject(key: string, content: string | Buffer): Promise<void> {
    return this.base.appendObject(this.toBase(key), content);
  }

  async getObject(key: string): Promise<StorageObject | null> {
    const obj = await this.base.getObject(this.toBase(key));
    return obj ? { ...obj, key: this.fromBase(obj.key) ?? key } : null;
  }

  async exists(key: string): Promise<boolean> {
    return this.base.exists(this.toBase(key));
  }

  async listObjects(prefix: string, opts?: ListObjectsOptions): Promise<ListResult> {
    const result = await this.base.listObjects(this.toBase(prefix), opts ? {
      ...opts,
      marker: opts.marker ? this.toBase(opts.marker) : undefined,
    } : undefined);
    const entries: ListEntry[] = [];
    for (const entry of result.entries) {
      const key = this.fromBase(entry.key);
      if (key !== null) entries.push({ ...entry, key });
    }
    return {
      ...result,
      entries,
      nextMarker: result.nextMarker ? this.fromBase(result.nextMarker) ?? undefined : undefined,
    };
  }

  async deleteObject(key: string): Promise<void> {
    return this.base.deleteObject(this.toBase(key));
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    return this.base.deleteByPrefix(this.toBase(prefix));
  }
}

/**
 * View of `base` that reads and writes only inside one project.
 *
 * `base` is already the profile-scope view (`team|agent`); do not scope the
 * result again. The view has no `withProfileIsolation`, so a second scoping
 * attempt on a row-view backend fails loudly.
 */
export function createProjectScopedStorage(base: StorageAdapter, projectHash: string): StorageAdapter {
  assertProjectHash(projectHash);
  return new StorageAdapter(new ProjectScopedStorageBackend(base.getBackend(), projectHash));
}

/**
 * Hashes of the projects that hold scene files in this scope, sorted.
 * Reads the directory level only, so the cost does not depend on scene count.
 */
export async function listProjectHashes(storage: StorageAdapter): Promise<string[]> {
  const result = await storage.getBackend().listObjects(
    `${StoragePaths.sceneBlocksDir}${PROJECT_DIR}`,
    { maxKeys: 10_000 },
  );
  const hashes = new Set<string>();
  for (const entry of result.entries) {
    if (!entry.isDirectory) continue;
    const name = entry.key.slice(StoragePaths.sceneBlocksDir.length + PROJECT_DIR.length).replace(/\/$/, "");
    if (PROJECT_HASH_PATTERN.test(name)) hashes.add(name);
  }
  return [...hashes].sort();
}

/** Whether any project holds at least one scene file in this scope. */
export async function hasProjectSceneFiles(storage: StorageAdapter): Promise<boolean> {
  const result = await storage.getBackend().listObjects(
    `${StoragePaths.sceneBlocksDir}${PROJECT_DIR}`,
    { recursive: true, maxKeys: 10_000 },
  );
  return result.entries.some((entry) => !entry.isDirectory && entry.key.endsWith(".md"));
}

/**
 * Backend that forwards every call and replaces only the scene index.
 * The index lists the root scenes plus each project's scenes. A project
 * filename carries the `projects/<H>/` prefix, so reading
 * `scene_blocks/<filename>` through this view reaches the project file.
 *
 * The index is derived, so `syncSceneIndex` through this view writes nothing.
 * Use the view for reading the index only.
 */
class AllProjectsSceneViewBackend implements IStorageBackend {
  readonly type: IStorageBackend["type"];

  constructor(private readonly base: StorageAdapter) {
    this.type = base.type;
  }

  async deriveSceneIndex(): Promise<SceneIndexEntry[]> {
    const entries = [...await readSceneIndex("", this.base)];
    for (const hash of await listProjectHashes(this.base)) {
      const prefix = projectSceneFilenamePrefix(hash);
      const projectEntries = await readSceneIndex("", createProjectScopedStorage(this.base, hash));
      for (const entry of projectEntries) entries.push({ ...entry, filename: `${prefix}${entry.filename}` });
    }
    return entries;
  }

  putObject(key: string, content: string | Buffer, opts?: PutObjectOptions): Promise<void> {
    return this.base.getBackend().putObject(key, content, opts);
  }

  appendObject(key: string, content: string | Buffer): Promise<void> {
    return this.base.getBackend().appendObject(key, content);
  }

  getObject(key: string): Promise<StorageObject | null> {
    return this.base.getBackend().getObject(key);
  }

  exists(key: string): Promise<boolean> {
    return this.base.getBackend().exists(key);
  }

  listObjects(prefix: string, opts?: ListObjectsOptions): Promise<ListResult> {
    return this.base.getBackend().listObjects(prefix, opts);
  }

  deleteObject(key: string): Promise<void> {
    return this.base.getBackend().deleteObject(key);
  }

  deleteByPrefix(prefix: string): Promise<number> {
    return this.base.getBackend().deleteByPrefix(prefix);
  }
}

/**
 * View of the user-global scope whose scene index also covers every project.
 * Use it only for the user-global L3 run, which must read all scenes. Writes
 * (`persona.md`, checkpoint) go to the root files exactly as on `base`.
 */
export function createAllProjectsSceneView(base: StorageAdapter): StorageAdapter {
  return new StorageAdapter(new AllProjectsSceneViewBackend(base));
}
