/**
 * Opening a database that already has skills and skill_change_proposals
 * must add local_skill_inventory and leave those rows unchanged.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteSkillStore } from "./skill-store.js";

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
`;

/** The proposals table before the later columns. */
const OLD_PROPOSALS_DDL = `
  CREATE TABLE skill_change_proposals (
    proposal_id           TEXT PRIMARY KEY,
    team_id               TEXT NOT NULL,
    owner_agent_id        TEXT NOT NULL,
    skill_id              TEXT NOT NULL,
    skill_name            TEXT NOT NULL,
    base_version          INTEGER NOT NULL,
    proposed_content      TEXT NOT NULL,
    proposed_description  TEXT NOT NULL DEFAULT '',
    proposed_files_json   TEXT NOT NULL DEFAULT '{"write":[],"remove":[]}',
    change_reason         TEXT NOT NULL DEFAULT '',
    change_summary        TEXT NOT NULL DEFAULT '[]',
    source_session_id     TEXT NOT NULL DEFAULT '',
    created_by            TEXT NOT NULL DEFAULT '',
    status                TEXT NOT NULL DEFAULT 'pending',
    created_at_ms         INTEGER NOT NULL,
    decided_at_ms         INTEGER NOT NULL DEFAULT 0,
    decided_by            TEXT NOT NULL DEFAULT '',
    result_version        INTEGER NOT NULL DEFAULT 0
  );
`;

let db: DatabaseSync | undefined;
afterEach(() => { try { db?.close(); } catch { /* closed */ } });

describe("SqliteSkillStore.init adds local_skill_inventory on an old database", () => {
  it("creates the table and keeps existing skills and proposal rows", () => {
    db = new DatabaseSync(":memory:");
    db.exec(OLD_SKILLS_DDL);
    db.exec(OLD_PROPOSALS_DDL);
    db.prepare(
      `INSERT INTO skills (row_id, skill_id, version, is_head, user_id, owner_agent_id, team_id,
         name, content, content_hash, storage_dir, created_at_ms, updated_at_ms)
       VALUES ('row-1', 'skl-old', 1, 1, 'u', 'a', 't', 'old-skill', 'body', 'h', 'skills/x', 1, 2)`,
    ).run();
    db.prepare(
      `INSERT INTO skill_change_proposals (
         proposal_id, team_id, owner_agent_id, skill_id, skill_name, base_version,
         proposed_content, created_at_ms
       ) VALUES ('pr-1', 't', 'a', 'skl-old', 'old-skill', 1, 'proposed body', 3)`,
    ).run();

    new SqliteSkillStore({ db, dimensions: 0 }).init();

    const skill = db.prepare("SELECT content, name FROM skills WHERE skill_id='skl-old'").get() as { content: string; name: string };
    expect(skill).toEqual({ content: "body", name: "old-skill" });
    expect(db.prepare("SELECT COUNT(*) AS c FROM skills").get()).toEqual({ c: 1 });

    const proposal = db.prepare("SELECT proposed_content, status FROM skill_change_proposals WHERE proposal_id='pr-1'").get() as {
      proposed_content: string;
      status: string;
    };
    expect(proposal).toEqual({ proposed_content: "proposed body", status: "pending" });

    const columns = (db.prepare("PRAGMA table_info('local_skill_inventory')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual([
      "inventory_id", "user_id", "machine_id", "harness", "source", "name",
      "root_kind", "relative_path", "content_hash", "reported_at_ms", "present",
    ]);
    expect(columns).not.toContain("content");
    expect(db.prepare("SELECT COUNT(*) AS c FROM local_skill_inventory").get()).toEqual({ c: 0 });
  });
});
