/**
 * A vectors.db created before project_key / project_hash existed must gain the
 * columns when the store opens it, and must keep its rows.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { VectorStore } from "./sqlite/memory-store.js";

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function indexes(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((i) => i.name);
}

describe("sqlite project columns migration", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tdai-sqlite-project-"));
    dbPath = path.join(dir, "old.db");
    const old = new DatabaseSync(dbPath);
    // Shape of the tables before the project columns were added.
    old.exec(`
      CREATE TABLE l1_records (
        record_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT DEFAULT '',
        priority INTEGER DEFAULT 50,
        scene_name TEXT DEFAULT '',
        session_key TEXT DEFAULT '',
        session_id TEXT DEFAULT 'default',
        team_id TEXT DEFAULT 'default',
        task_id TEXT DEFAULT '',
        user_id TEXT NOT NULL DEFAULT 'default',
        agent_id TEXT NOT NULL DEFAULT 'default',
        version INTEGER NOT NULL DEFAULT 0,
        timestamp_str TEXT DEFAULT '',
        timestamp_start TEXT DEFAULT '',
        timestamp_end TEXT DEFAULT '',
        created_time TEXT DEFAULT '',
        updated_time TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}'
      );
      CREATE TABLE l0_conversations (
        record_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        session_id TEXT DEFAULT 'default',
        team_id TEXT DEFAULT 'default',
        task_id TEXT DEFAULT '',
        user_id TEXT NOT NULL DEFAULT 'default',
        agent_id TEXT NOT NULL DEFAULT 'default',
        role TEXT NOT NULL DEFAULT '',
        message_text TEXT NOT NULL,
        recorded_at TEXT DEFAULT '',
        timestamp INTEGER DEFAULT 0
      );
    `);
    old.prepare(
      "INSERT INTO l1_records (record_id, content, session_key, session_id, user_id, agent_id, updated_time) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("old-l1", "an old memory", "sk-old", "sid-old", "u1", "a1", "2026-01-01T00:00:00.000Z");
    old.prepare(
      "INSERT INTO l0_conversations (record_id, session_key, session_id, user_id, agent_id, role, message_text, recorded_at, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("old-l0", "sk-old", "sid-old", "u1", "a1", "user", "an old message", "2026-01-01T00:00:00.000Z", 1);
    expect(columns(old, "l1_records")).not.toContain("project_key");
    expect(columns(old, "l0_conversations")).not.toContain("project_hash");
    old.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds the columns and the hash indexes and keeps old rows", async () => {
    const store = new VectorStore(dbPath, 0);
    store.init();
    try {
      const db = store.getRawDb();
      for (const table of ["l1_records", "l0_conversations"]) {
        expect(columns(db, table)).toEqual(expect.arrayContaining(["project_key", "project_hash"]));
      }
      expect(indexes(db, "l1_records")).toContain("idx_l1_project_hash");
      expect(indexes(db, "l0_conversations")).toContain("idx_l0_project_hash");

      // Old rows survive and read back with an empty project.
      const [l1Row] = await store.queryL1Records({ recordIds: ["old-l1"] });
      expect(l1Row?.content).toBe("an old memory");
      expect(l1Row?.project_key ?? "").toBe("");
      expect(l1Row?.project_hash ?? "").toBe("");
      const [l0Row] = store.queryL0ForL1("sk-old");
      expect(l0Row?.message_text).toBe("an old message");
      expect(l0Row?.project_key ?? "").toBe("");
      expect(l0Row?.project_hash ?? "").toBe("");
    } finally {
      store.close();
    }
  });

  it("opens an already migrated database a second time", () => {
    const first = new VectorStore(dbPath, 0);
    first.init();
    first.close();
    const second = new VectorStore(dbPath, 0);
    expect(() => second.init()).not.toThrow();
    second.close();
  });

  it("stores project values on a migrated database", async () => {
    const store = new VectorStore(dbPath, 0);
    store.init();
    try {
      const now = "2026-02-01T00:00:00.000Z";
      store.upsertL1({
        id: "new-l1", content: "a new memory", type: "persona", priority: 50, scene_name: "",
        source_message_ids: [], metadata: {}, timestamps: [now], createdAt: now, updatedAt: now,
        sessionKey: "sk-new", sessionId: "sid-new", userId: "u1", agentId: "a1",
        projectKey: "git:github.com/acme/app", projectHash: "0123456789abcdef",
      }, undefined);
      const [row] = await store.queryL1Records({ recordIds: ["new-l1"] });
      expect(row?.project_key).toBe("git:github.com/acme/app");
      expect(row?.project_hash).toBe("0123456789abcdef");
    } finally {
      store.close();
    }
  });
});
