/**
 * Opening a database that was created before the scope and audit columns
 * existed must add them with the documented defaults and keep every row.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { SKILLS_ADDED_COLUMNS } from "../../skill/skill-store-ddl.js";
import { SqliteSkillStore } from "./skill-store.js";

/** The `skills` table exactly as it was before scope and audit columns. */
const OLD_SKILLS_DDL = `
  CREATE TABLE skills (
    row_id          TEXT PRIMARY KEY,
    skill_id        TEXT NOT NULL,
    version         INTEGER NOT NULL,
    is_head         INTEGER NOT NULL DEFAULT 1,
    user_id         TEXT NOT NULL,
    owner_agent_id  TEXT NOT NULL,
    team_id         TEXT NOT NULL,
    task_id         TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    manifest_json   TEXT NOT NULL DEFAULT '[]',
    storage_dir     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at_ms   INTEGER NOT NULL,
    updated_at_ms   INTEGER NOT NULL,
    UNIQUE(skill_id, version)
  );
  CREATE UNIQUE INDEX uniq_skills_team_agent_name_head
    ON skills(team_id, owner_agent_id, name) WHERE is_head=1 AND status='active';
`;

function insertOldRow(db: DatabaseSync, skillId: string, version: number, isHead: number): void {
  db.prepare(
    `INSERT INTO skills (row_id, skill_id, version, is_head, user_id, owner_agent_id, team_id, task_id,
       name, description, content, content_hash, manifest_json, storage_dir, status, metadata_json,
       created_at_ms, updated_at_ms)
     VALUES (?,?,?,?, 'u','a','t','k', 'old-skill','d','body','h','[]','skills/x', 'active','{}', 1, 2)`,
  ).run(`row-${skillId}-${version}`, skillId, version, isHead);
}

let db: DatabaseSync | undefined;
afterEach(() => { try { db?.close(); } catch { /* closed */ } });

function columns(d: DatabaseSync, table: string): string[] {
  return (d.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe("SqliteSkillStore.init on a database from before scope and audit columns", () => {
  it("adds every column, keeps the rows, and reads old rows with the defaults", async () => {
    db = new DatabaseSync(":memory:");
    db.exec(OLD_SKILLS_DDL);
    insertOldRow(db, "skl-old", 1, 0);
    insertOldRow(db, "skl-old", 2, 1);

    const store = new SqliteSkillStore({ db, dimensions: 0 });
    store.init();

    for (const c of SKILLS_ADDED_COLUMNS) expect(columns(db, "skills")).toContain(c.name);

    const head = await store.getHead("skl-old", "t");
    expect(head).toMatchObject({
      version: 2, content: "body",
      scope: "global", project_key: "", project_hash: "", project_name: "", origin: "extracted",
      source_session_id: "", change_source: "", change_reason: "", change_summary: [],
      approved_by: "", approved_at_ms: 0, base_version: 0, proposal_id: "",
    });
    expect(await store.countVersions("skl-old", "t")).toBe(2);
    expect((await store.getByVersion("skl-old", 1, "t"))?.is_head).toBe(false);
  });

  it("creates the scope index and the proposals table", () => {
    db = new DatabaseSync(":memory:");
    db.exec(OLD_SKILLS_DDL);
    new SqliteSkillStore({ db, dimensions: 0 }).init();

    const index = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_skills_scope_project'").get();
    expect(index).toBeTruthy();
    const info = db.prepare("PRAGMA index_info('idx_skills_scope_project')").all() as Array<{ name: string }>;
    expect(info.map((i) => i.name)).toEqual(["team_id", "owner_agent_id", "is_head", "status", "scope", "project_hash"]);
    expect(columns(db, "skill_change_proposals")).toEqual(
      expect.arrayContaining(["proposal_id", "base_version", "status", "decided_by", "result_version", "proposed_files_json"]),
    );
  });

  it("is safe to run again, and a new version can be written on the migrated table", async () => {
    db = new DatabaseSync(":memory:");
    db.exec(OLD_SKILLS_DDL);
    insertOldRow(db, "skl-old", 1, 1);

    const store = new SqliteSkillStore({ db, dimensions: 0 });
    store.init();
    store.init();
    new SqliteSkillStore({ db, dimensions: 0 }).init();

    const v2 = await store.appendVersion({
      skill_id: "skl-old", name: "old-skill", description: "d", content: "new body", content_hash: "h2",
      manifest: [], storage_dir: "skills/skl-old/v2", team_id: "t", user_id: "u", change_source: "manual", approved_by: "u",
    });
    // No scope given: the head's placement (the migration default) is kept.
    expect(v2).toMatchObject({ version: 2, scope: "global", origin: "extracted", change_source: "manual", approved_by: "u" });
  });

  it("a fresh database has the same columns as a migrated one", () => {
    db = new DatabaseSync(":memory:");
    new SqliteSkillStore({ db, dimensions: 0 }).init();
    const fresh = columns(db, "skills");
    const migrated = new DatabaseSync(":memory:");
    migrated.exec(OLD_SKILLS_DDL);
    new SqliteSkillStore({ db: migrated, dimensions: 0 }).init();
    expect([...columns(migrated, "skills")].sort()).toEqual([...fresh].sort());
    migrated.close();
  });
});
