/**
 * Test harness: a real `SkillCore` on a temporary SQLite database and a local
 * file store. Used by the change-service, handler and migration tests, so they
 * run the real store, versioning and policy instead of mocks.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { MemoryPromptMode } from "../../../config.js";
import { LocalStorageBackend } from "../../storage/local-backend.js";
import { StorageAdapter } from "../../storage/adapter.js";
import { SqliteSkillStore } from "../../store/sqlite/skill-store.js";
import { SkillCore, type SkillCoreOptions } from "../skill-core.js";
import { SkillResourceStore } from "../skill-resource-store.js";
import { SkillVersioning } from "../skill-versioning.js";

export const PROJECT_A = "aaaaaaaaaaaaaaaa";
export const PROJECT_B = "bbbbbbbbbbbbbbbb";

/** A valid SKILL.md. */
export function skillMd(name: string, body = "Do the thing."): string {
  return `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`;
}

export interface SkillHarness {
  core: SkillCore;
  store: SqliteSkillStore;
  db: DatabaseSync;
  setMode(mode: MemoryPromptMode): void;
  dispose(): void;
}

export function createSkillHarness(
  opts: { mode?: MemoryPromptMode; coreOptions?: Partial<SkillCoreOptions> } = {},
): SkillHarness {
  const dir = mkdtempSync(join(tmpdir(), "skill-harness-"));
  const db = new DatabaseSync(join(dir, "skills.db"));
  const store = new SqliteSkillStore({ db, dimensions: 0 });
  store.init();
  const storage = new StorageAdapter(new LocalStorageBackend(join(dir, "files")));
  const resources = new SkillResourceStore({ storage });
  const versioning = new SkillVersioning({ store, resources, storage });
  let mode: MemoryPromptMode = opts.mode ?? "code";
  const core = new SkillCore({
    store,
    resources,
    versioning,
    getPromptMode: () => mode,
    ...opts.coreOptions,
  });
  return {
    core,
    store,
    db,
    setMode: (m) => { mode = m; },
    dispose: () => {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Identity used by the tests: one team, one agent. */
export const IDS = { user_id: "user-1", team_id: "team-1", agent_id: "agent-1" } as const;
