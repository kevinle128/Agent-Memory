import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StorageAdapter } from "../storage/adapter.js";
import { LocalStorageBackend } from "../storage/local-backend.js";
import { MANUAL_BACKUP_KEEP, backupPersonaFile } from "./persona-backup.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "persona-backup-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const names = () => readdirSync(path.join(dir, ".backup", "persona-manual")).sort();

describe.each([["plain files", false], ["storage view", true]])("backupPersonaFile (%s)", (_label, useStorage) => {
  const opts = () => ({ dataDir: dir, storage: useStorage ? new StorageAdapter(new LocalStorageBackend(dir)) : undefined });

  it("returns null when there is no persona", async () => {
    expect(await backupPersonaFile(opts())).toBeNull();
  });

  it("does not copy again when the newest copy has the same bytes", async () => {
    writeFileSync(path.join(dir, "persona.md"), "same");
    const first = await backupPersonaFile({ ...opts(), now: new Date("2026-10-01T00:00:00Z") });
    const second = await backupPersonaFile({ ...opts(), now: new Date("2026-10-01T00:00:05Z") });
    expect(second).toBe(first);
    expect(names()).toHaveLength(1);
  });

  it("keeps only the newest copies", async () => {
    for (let i = 0; i < MANUAL_BACKUP_KEEP + 5; i++) {
      writeFileSync(path.join(dir, "persona.md"), `version ${i}`);
      await backupPersonaFile({ ...opts(), now: new Date(Date.UTC(2026, 9, 1, 0, 0, i)) });
    }
    const kept = names();
    expect(kept).toHaveLength(MANUAL_BACKUP_KEEP);
    expect(readFileSync(path.join(dir, ".backup", "persona-manual", kept[kept.length - 1]), "utf-8")).toBe(`version ${MANUAL_BACKUP_KEEP + 4}`);
    expect(readFileSync(path.join(dir, ".backup", "persona-manual", kept[0]), "utf-8")).toBe("version 5");
  });
});
