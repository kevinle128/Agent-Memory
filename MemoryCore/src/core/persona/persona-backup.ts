/**
 * Timestamped copy of the current L3 document, made before a manual
 * regeneration. The copy sits in `.backup/persona-manual/`, a directory that
 * the automatic backup rotation does not prune and that profile sync does not
 * read.
 */

import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";

const BACKUP_DIR = ".backup/persona-manual/";
/** Copies kept in the manual backup directory. */
export const MANUAL_BACKUP_KEEP = 20;

/**
 * Copy the current persona file. Returns the key of the copy (relative to the
 * storage view that was given), or null when there is no file to copy. When the
 * newest copy already has the same bytes, no new copy is made and its key is
 * returned. Only the newest MANUAL_BACKUP_KEEP copies are kept.
 * Throws when the copy cannot be written, so a caller never goes on without it.
 */
export async function backupPersonaFile(opts: {
  storage?: StorageAdapter;
  dataDir: string;
  now?: Date;
}): Promise<string | null> {
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const relKey = `${BACKUP_DIR}persona-${stamp}.md`;
  if (opts.storage) {
    const current = await opts.storage.readFile(StoragePaths.persona);
    if (!current) return null;
    const names = (await opts.storage.readdirNames(BACKUP_DIR, ".md")).sort();
    const newest = names[names.length - 1];
    if (newest && (await opts.storage.readFile(`${BACKUP_DIR}${newest}`)) === current) return `${BACKUP_DIR}${newest}`;
    await opts.storage.writeFile(relKey, current);
    for (const old of [...names, relKey.slice(BACKUP_DIR.length)].sort().slice(0, -MANUAL_BACKUP_KEEP)) {
      await opts.storage.unlink(`${BACKUP_DIR}${old}`);
    }
    return relKey;
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const source = path.default.join(opts.dataDir, StoragePaths.persona);
  let current: string;
  try {
    current = await fs.default.readFile(source, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!current) return null;
  const dir = path.default.join(opts.dataDir, BACKUP_DIR);
  await fs.default.mkdir(dir, { recursive: true });
  const names = (await fs.default.readdir(dir)).filter((n) => n.endsWith(".md")).sort();
  const newest = names[names.length - 1];
  if (newest && (await fs.default.readFile(path.default.join(dir, newest), "utf-8")) === current) return `${BACKUP_DIR}${newest}`;
  await fs.default.writeFile(path.default.join(opts.dataDir, relKey), current, "utf-8");
  for (const old of [...names, relKey.slice(BACKUP_DIR.length)].sort().slice(0, -MANUAL_BACKUP_KEEP)) {
    await fs.default.rm(path.default.join(dir, old), { force: true });
  }
  return relKey;
}
