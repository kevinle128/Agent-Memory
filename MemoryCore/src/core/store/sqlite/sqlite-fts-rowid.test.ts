import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import { DatabaseSync } from "node:sqlite";

import { VectorStore } from "./memory-store.js";
import { buildFtsQuery, tokenizeForFts } from "../tokenize.js";
import type { L0Record } from "../types.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import { handleV2Route, type V2RouterDeps } from "../../../gateway/v2-router.js";

function makeL0(id: string, messageText: string, overrides: Partial<L0Record> = {}): L0Record {
  return {
    id,
    sessionKey: "sess-1",
    sessionId: "sess-1",
    teamId: "team-1",
    userId: "user-1",
    agentId: "agent-1",
    role: "user",
    messageText,
    recordedAt: "2026-01-01T00:00:00.000Z",
    timestamp: 1_735_689_600_000,
    ...overrides,
  };
}

function makeL1(id: string, content: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "default",
    source_message_ids: [],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    version: 1,
    sessionKey: "sess-1",
    sessionId: "sess-1",
    teamId: "team-1",
    userId: "user-1",
    agentId: "agent-1",
    ...overrides,
  };
}

type Pair = { record_id: string; meta_rowid: number; fts_rowid: number | null };

function pairs(db: DatabaseSync, meta: "l0_conversations" | "l1_records", fts: "l0_fts" | "l1_fts"): Pair[] {
  return db.prepare(`
    SELECT m.record_id AS record_id, m.rowid AS meta_rowid, f.rowid AS fts_rowid
    FROM ${meta} m
    LEFT JOIN ${fts} f ON f.record_id = m.record_id
  `).all() as Pair[];
}

function insertL0Fts(db: DatabaseSync, rowid: number, recordId: string, text: string): void {
  db.prepare(
    `INSERT INTO l0_fts (rowid, message_text, message_text_original, record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, recorded_at, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(rowid, text, text, recordId, "sess-1", "sess-1", "team-1", "", "user-1", "agent-1", "user", "2026-01-01T00:00:00.000Z", 1);
}

function insertL1Fts(db: DatabaseSync, rowid: number, recordId: string, text: string): void {
  db.prepare(
    `INSERT INTO l1_fts (rowid, content, content_original, record_id, type, priority, scene_name,
      session_key, session_id, team_id, task_id, user_id, agent_id, version,
      timestamp_str, timestamp_start, timestamp_end, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rowid, text, text, recordId, "episodic", 50, "default",
    "sess-1", "sess-1", "team-1", "", "user-1", "agent-1", 1,
    "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "{}",
  );
}

function expectSynced(rows: Pair[]): void {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.fts_rowid).toBe(row.meta_rowid);
  }
}

function planDetail(db: DatabaseSync, sql: string): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1) as Array<{ detail?: string }>)
    .map((row) => row.detail ?? "")
    .join("\n");
}

function vfilterConstraint(db: DatabaseSync, sql: string): string {
  const rows = db.prepare(`EXPLAIN ${sql}`).all(1) as Array<{ opcode: string; p4: string | null }>;
  const filter = rows.find((row) => row.opcode === "VFilter");
  return filter?.p4 ?? "";
}

describe("sqlite FTS5 rowid alignment", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tdai-fts-rowid-"));
    store = new VectorStore(path.join(dir, "test.db"), 0);
    store.init();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sets synchronous NORMAL under WAL", () => {
    const db = store.getRawDb();
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const sync = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    expect(journal.journal_mode).toBe("wal");
    expect(sync.synchronous).toBe(1);
  });

  it("keeps l0 and l1 FTS rowids aligned across insert, update, delete, and rebuild", () => {
    const db = store.getRawDb();
    expect(store.upsertL0(makeL0("l0-a", "alpha pelican token"), undefined)).toBe(true);
    expect(store.upsertL0(makeL0("l0-b", "beta quarry token"), undefined)).toBe(true);
    expect(store.upsertL1(makeL1("l1-a", "alpha zebra memory"), undefined)).toBe(true);
    expect(store.upsertL1(makeL1("l1-b", "beta quarry memory"), undefined)).toBe(true);
    expectSynced(pairs(db, "l0_conversations", "l0_fts"));
    expectSynced(pairs(db, "l1_records", "l1_fts"));

    const before = db.prepare("SELECT rowid FROM l0_conversations WHERE record_id = ?").get("l0-a") as { rowid: number };
    expect(store.upsertL0(makeL0("l0-a", "alpha revised token"), undefined)).toBe(true);
    const after = db.prepare("SELECT rowid FROM l0_conversations WHERE record_id = ?").get("l0-a") as { rowid: number };
    expect(after.rowid).toBe(before.rowid);
    expectSynced(pairs(db, "l0_conversations", "l0_fts"));
    expect(store.searchL0Fts(buildFtsQuery("revised")!, 5).map((hit) => hit.record_id)).toContain("l0-a");
    expect(store.searchL0Fts(buildFtsQuery("pelican")!, 5).map((hit) => hit.record_id)).not.toContain("l0-a");

    expect(store.upsertL1(makeL1("l1-a", "alpha zebra revised"), undefined)).toBe(true);
    expectSynced(pairs(db, "l1_records", "l1_fts"));

    expect(store.deleteL0("l0-b")).toBe(true);
    expect(store.deleteL1("l1-b")).toBe(true);
    expect(pairs(db, "l0_conversations", "l0_fts").map((row) => row.record_id)).toEqual(["l0-a"]);
    expect(pairs(db, "l1_records", "l1_fts").map((row) => row.record_id)).toEqual(["l1-a"]);
    expectSynced(pairs(db, "l0_conversations", "l0_fts"));
    expectSynced(pairs(db, "l1_records", "l1_fts"));

    db.exec("DELETE FROM l0_fts");
    db.exec("DELETE FROM l1_fts");
    store.rebuildFtsIndex();
    expectSynced(pairs(db, "l0_conversations", "l0_fts"));
    expectSynced(pairs(db, "l1_records", "l1_fts"));
  });

  it("uses an FTS5 integer rowid lookup on the fast path", () => {
    const db = store.getRawDb();
    store.upsertL0(makeL0("l0-a", "alpha zebra token"), undefined);
    const deleteByRowid = "DELETE FROM l0_fts WHERE rowid = ?";
    const selectByRowid = "SELECT record_id FROM l0_fts WHERE rowid = ?";
    const deleteById = "DELETE FROM l0_fts WHERE record_id = ?";

    expect(planDetail(db, deleteByRowid)).toContain("INDEX 0:=");
    expect(planDetail(db, selectByRowid)).toContain("INDEX 0:=");
    expect(vfilterConstraint(db, deleteByRowid)).toBe("=");
    expect(vfilterConstraint(db, selectByRowid)).toBe("=");
    expect(planDetail(db, deleteById)).not.toContain("INDEX 0:=");
    expect(vfilterConstraint(db, deleteById)).toBe("");

    expect(planDetail(db, "DELETE FROM l1_fts WHERE rowid = ?")).toContain("INDEX 0:=");
    expect(vfilterConstraint(db, "SELECT record_id FROM l1_fts WHERE rowid = ?")).toBe("=");
  });

  it("does not corrupt an unrelated FTS row when rowids have drifted", () => {
    const db = store.getRawDb();
    store.upsertL0(makeL0("l0-a", "alpha original token"), undefined);
    store.upsertL0(makeL0("l0-b", "beta original token"), undefined);
    const metaA = db.prepare("SELECT rowid FROM l0_conversations WHERE record_id = ?").get("l0-a") as { rowid: number };

    db.exec("DELETE FROM l0_fts");
    db.prepare(
      "INSERT INTO l0_fts (rowid, message_text, message_text_original, record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, recorded_at, timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(9000, "alpha original token", "alpha original token", "l0-a", "sess-1", "sess-1", "team-1", "", "user-1", "agent-1", "user", "2026-01-01T00:00:00.000Z", 1);
    db.prepare(
      "INSERT INTO l0_fts (rowid, message_text, message_text_original, record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, recorded_at, timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(metaA.rowid, "beta original token", "beta original token", "l0-b", "sess-1", "sess-1", "team-1", "", "user-1", "agent-1", "user", "2026-01-01T00:00:00.000Z", 1);

    expect(store.upsertL0(makeL0("l0-a", "alpha revised token"), undefined)).toBe(true);

    const squatter = db.prepare("SELECT record_id, message_text_original FROM l0_fts WHERE rowid = ?").get(metaA.rowid) as {
      record_id: string;
      message_text_original: string;
    };
    expect(squatter.record_id).toBe("l0-b");
    expect(squatter.message_text_original).toBe("beta original token");
    expect(store.searchL0Fts(buildFtsQuery("revised")!, 5).map((hit) => hit.record_id)).toContain("l0-a");
    expect(store.searchL0Fts(buildFtsQuery("beta")!, 5).map((hit) => hit.record_id)).toContain("l0-b");

    db.exec("DELETE FROM l0_fts");
    db.prepare(
      "INSERT INTO l0_fts (rowid, message_text, message_text_original, record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, recorded_at, timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(9001, "alpha revised token", "alpha revised token", "l0-a", "sess-1", "sess-1", "team-1", "", "user-1", "agent-1", "user", "2026-01-01T00:00:00.000Z", 1);
    db.prepare(
      "INSERT INTO l0_fts (rowid, message_text, message_text_original, record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, recorded_at, timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(metaA.rowid, "beta original token", "beta original token", "l0-b", "sess-1", "sess-1", "team-1", "", "user-1", "agent-1", "user", "2026-01-01T00:00:00.000Z", 1);

    expect(store.deleteL0("l0-a")).toBe(true);
    const stillThere = db.prepare("SELECT record_id FROM l0_fts WHERE rowid = ?").get(metaA.rowid) as { record_id: string };
    expect(stillThere.record_id).toBe("l0-b");
    expect(store.searchL0Fts(buildFtsQuery("revised")!, 5)).toEqual([]);
    expect(store.searchL0Fts(buildFtsQuery("beta")!, 5).map((hit) => hit.record_id)).toContain("l0-b");
  });

  it("falls back to an automatic FTS rowid when the metadata rowid is already occupied", () => {
    const db = store.getRawDb();
    store.upsertL0(makeL0("l0-b", "beta keeper token"), undefined);
    store.upsertL0(makeL0("l0-temp", "temp throwaway token"), undefined);
    const temp = db.prepare("SELECT rowid FROM l0_conversations WHERE record_id = ?").get("l0-temp") as { rowid: number };
    db.prepare("DELETE FROM l0_conversations WHERE record_id = ?").run("l0-temp");
    db.prepare("DELETE FROM l0_fts WHERE record_id = ?").run("l0-temp");
    db.prepare(
      "INSERT INTO l0_fts (rowid, message_text, message_text_original, record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, recorded_at, timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(temp.rowid, "squatter unique token", "squatter unique token", "l0-squatter", "sess-1", "sess-1", "team-1", "", "user-1", "agent-1", "user", "2026-01-01T00:00:00.000Z", 1);

    expect(store.upsertL0(makeL0("l0-new", "newcomer unique token"), undefined)).toBe(true);
    const meta = db.prepare("SELECT rowid FROM l0_conversations WHERE record_id = ?").get("l0-new") as { rowid: number };
    expect(meta.rowid).toBe(temp.rowid);
    const occupant = db.prepare("SELECT record_id, message_text_original FROM l0_fts WHERE rowid = ?").get(temp.rowid) as {
      record_id: string;
      message_text_original: string;
    };
    expect(occupant.record_id).toBe("l0-squatter");
    expect(occupant.message_text_original).toBe("squatter unique token");
    expect(store.searchL0Fts(buildFtsQuery("newcomer")!, 5).map((hit) => hit.record_id)).toContain("l0-new");
    expect(store.searchL0Fts(buildFtsQuery("squatter")!, 5).map((hit) => hit.record_id)).toContain("l0-squatter");
    expect(store.searchL0Fts(buildFtsQuery("keeper")!, 5).map((hit) => hit.record_id)).toContain("l0-b");
  });

  it("deletes a batch, a session, and a tenant without leaving searchable FTS rows", () => {
    const db = store.getRawDb();
    store.upsertL1(makeL1("l1-a", "batch alpha memory"), undefined);
    store.upsertL1(makeL1("l1-b", "batch beta memory"), undefined);
    store.upsertL1(makeL1("l1-keep", "batch keeper memory"), undefined);
    expect(store.deleteL1Batch(["l1-a", "l1-b"])).toBe(true);
    expect(store.searchL1Fts(buildFtsQuery("alpha")!, 5)).toEqual([]);
    expect(store.searchL1Fts(buildFtsQuery("keeper")!, 5).map((hit) => hit.record_id)).toEqual(["l1-keep"]);
    expectSynced(pairs(db, "l1_records", "l1_fts"));

    store.upsertL0(makeL0("l0-s1", "session one token", { sessionId: "sess-del", sessionKey: "sess-del" }), undefined);
    store.upsertL0(makeL0("l0-s2", "session two token", { sessionId: "sess-keep", sessionKey: "sess-keep" }), undefined);
    expect(store.deleteL0BySession("sess-del")).toBe(1);
    expect(store.searchL0Fts(buildFtsQuery("one")!, 5)).toEqual([]);
    expect(store.searchL0Fts(buildFtsQuery("two")!, 5).map((hit) => hit.record_id)).toContain("l0-s2");

    store.upsertL0(makeL0("l0-t", "tenant clear token", { teamId: "team-x", agentId: "agent-x" }), undefined);
    store.upsertL1(makeL1("l1-t", "tenant clear memory", { teamId: "team-x", agentId: "agent-x" }), undefined);
    store.upsertL0(makeL0("l0-other", "tenant other token", { teamId: "team-y", agentId: "agent-y" }), undefined);
    const cleared = store.clearMemoryContent({ teamId: "team-x", agentId: "agent-x" });
    expect(cleared.l0Deleted).toBe(1);
    expect(cleared.l1Deleted).toBe(1);
    expect(store.searchL0Fts(buildFtsQuery("clear")!, 5)).toEqual([]);
    expect(store.searchL0Fts(buildFtsQuery("other")!, 5).map((hit) => hit.record_id)).toContain("l0-other");
    expectSynced(pairs(db, "l0_conversations", "l0_fts"));
  });

  it("searches Chinese text and applies isolation filters", () => {
    const text = "用户五月去日本旅行";
    expect(tokenizeForFts(text).length).toBeGreaterThan(0);
    const query = buildFtsQuery(text);
    expect(query).toBeTruthy();
    store.upsertL0(makeL0("l0-zh", text, { agentId: "agent-zh" }), undefined);
    store.upsertL0(makeL0("l0-other", text, { agentId: "agent-other" }), undefined);
    const hits = store.searchL0Fts(query!, 10, { agentId: "agent-zh" });
    expect(hits.map((hit) => hit.record_id)).toEqual(["l0-zh"]);

    store.upsertL1(makeL1("l1-zh", text, { agentId: "agent-zh" }), undefined);
    store.upsertL1(makeL1("l1-other", text, { agentId: "agent-other" }), undefined);
    const l1Hits = store.searchL1Fts(query!, 10, { agentId: "agent-zh" });
    expect(l1Hits.map((hit) => hit.record_id)).toEqual(["l1-zh"]);
  });

  it("writes an L0 batch in one transaction and rejects a duplicate id", () => {
    expect(store.insertL0Batch([])).toBe(0);

    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    const written = store.insertL0Batch([
      makeL0("b1", "batch first token"),
      makeL0("b2", "batch second token"),
    ]);
    expect(written).toBe(2);
    const begins = exec.mock.calls.filter((call) => call[0] === "BEGIN");
    const commits = exec.mock.calls.filter((call) => call[0] === "COMMIT");
    expect(begins).toHaveLength(1);
    expect(commits).toHaveLength(1);
    exec.mockRestore();

    const db = store.getRawDb();
    expectSynced(pairs(db, "l0_conversations", "l0_fts"));
    expect(store.searchL0Fts(buildFtsQuery("first")!, 5).map((hit) => hit.record_id)).toContain("b1");
    expect(store.searchL0Fts(buildFtsQuery("second")!, 5).map((hit) => hit.record_id)).toContain("b2");

    expect(() => store.insertL0Batch([
      makeL0("b3", "batch should rollback"),
      makeL0("b1", "batch duplicate token"),
    ])).toThrow(/constraint/i);
    expect(db.prepare("SELECT record_id FROM l0_conversations WHERE record_id = 'b3'").get()).toBeUndefined();
    expect((db.prepare("SELECT message_text FROM l0_conversations WHERE record_id = 'b1'").get() as { message_text: string }).message_text)
      .toBe("batch first token");
    expect(store.searchL0Fts(buildFtsQuery("duplicate")!, 5)).toEqual([]);
    expect(store.searchL0Fts(buildFtsQuery("rollback")!, 5)).toEqual([]);

    expect(() => store.insertL0Batch([
      makeL0("b4", "batch bad row", { sessionKey: null as unknown as string }),
    ])).toThrow();
    expect(db.prepare("SELECT record_id FROM l0_conversations WHERE record_id = 'b4'").get()).toBeUndefined();

    (store as unknown as { degraded: boolean }).degraded = true;
    expect(store.insertL0Batch([makeL0("b5", "degraded skip token")])).toBe(0);
    expect(db.prepare("SELECT record_id FROM l0_conversations WHERE record_id = 'b5'").get()).toBeUndefined();
  });

  it("commits /v2 and /v3 conversation/add through insertL0Batch when there is no embedding", async () => {
    const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const batch = vi.spyOn(store, "insertL0Batch");
    const single = vi.spyOn(store, "upsertL0");
    const deps: V2RouterDeps = {
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => undefined,
      logger,
      deployMode: "service",
    };
    const body = {
      team_id: "team-1",
      user_id: "user-1",
      agent_id: "agent-1",
      session_id: "sess-route",
      messages: [
        { role: "user", content: "route alpha token" },
        { role: "assistant", content: "route beta token" },
      ],
    };
    const req = {
      headers: {
        authorization: "Bearer test-key",
        "x-tdai-service-id": "svc-1",
      },
      url: "/v3/conversation/add",
    } as unknown as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    const sent: Array<{ status: number; body: { code?: number; data?: { accepted_ids?: string[] } } }> = [];

    const handled = await handleV2Route(
      req,
      res,
      "/v3/conversation/add",
      "POST",
      async () => body,
      (_res, status, payload) => {
        sent.push({ status, body: payload as { code?: number; data?: { accepted_ids?: string[] } } });
      },
      deps,
    );
    expect(handled).toBe(true);
    expect(sent[0]?.status).toBe(200);
    expect(sent[0]?.body.code).toBe(0);
    expect(sent[0]?.body.data?.accepted_ids).toHaveLength(2);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(single).not.toHaveBeenCalled();
    expect(store.searchL0Fts(buildFtsQuery("route")!, 5)).toHaveLength(2);

    batch.mockClear();
    const v2 = await handleV2Route(
      req,
      res,
      "/v2/conversation/add",
      "POST",
      async () => body,
      () => {},
      deps,
    );
    expect(v2).toBe(true);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("protects a drifted L1 rowid on update, delete, and batch delete", () => {
    const db = store.getRawDb();
    store.upsertL1(makeL1("l1-a", "alpha original memory"), undefined);
    store.upsertL1(makeL1("l1-b", "beta original memory"), undefined);
    store.upsertL1(makeL1("l1-c", "gamma original memory"), undefined);
    const metaA = db.prepare("SELECT rowid FROM l1_records WHERE record_id = ?").get("l1-a") as { rowid: number };
    const metaC = db.prepare("SELECT rowid FROM l1_records WHERE record_id = ?").get("l1-c") as { rowid: number };

    db.exec("DELETE FROM l1_fts");
    insertL1Fts(db, 9000, "l1-a", "alpha original memory");
    insertL1Fts(db, metaA.rowid, "l1-b", "beta original memory");
    insertL1Fts(db, metaC.rowid, "l1-c", "gamma original memory");

    expect(store.upsertL1(makeL1("l1-a", "alpha revised memory"), undefined)).toBe(true);
    const squatter = db.prepare("SELECT record_id, content_original FROM l1_fts WHERE rowid = ?").get(metaA.rowid) as {
      record_id: string;
      content_original: string;
    };
    expect(squatter.record_id).toBe("l1-b");
    expect(squatter.content_original).toBe("beta original memory");
    expect(store.searchL1Fts(buildFtsQuery("revised")!, 5).map((hit) => hit.record_id)).toContain("l1-a");
    expect(store.searchL1Fts(buildFtsQuery("beta")!, 5).map((hit) => hit.record_id)).toContain("l1-b");

    db.exec("DELETE FROM l1_fts");
    insertL1Fts(db, 9001, "l1-a", "alpha revised memory");
    insertL1Fts(db, metaA.rowid, "l1-b", "beta original memory");
    expect(store.deleteL1("l1-a")).toBe(true);
    expect((db.prepare("SELECT record_id FROM l1_fts WHERE rowid = ?").get(metaA.rowid) as { record_id: string }).record_id).toBe("l1-b");
    expect(store.searchL1Fts(buildFtsQuery("revised")!, 5)).toEqual([]);

    db.exec("DELETE FROM l1_fts");
    insertL1Fts(db, 9002, "l1-c", "gamma original memory");
    insertL1Fts(db, metaC.rowid, "l1-b", "beta original memory");
    expect(store.deleteL1Batch(["l1-c"])).toBe(true);
    expect((db.prepare("SELECT record_id FROM l1_fts WHERE rowid = ?").get(metaC.rowid) as { record_id: string }).record_id).toBe("l1-b");
    expect(store.searchL1Fts(buildFtsQuery("gamma")!, 5)).toEqual([]);
    expect(store.searchL1Fts(buildFtsQuery("beta")!, 5).map((hit) => hit.record_id)).toContain("l1-b");
  });

  it("indexes a new L1 row when its metadata rowid is already occupied", () => {
    const db = store.getRawDb();
    store.upsertL1(makeL1("l1-b", "beta keeper memory"), undefined);
    store.upsertL1(makeL1("l1-temp", "temp throwaway memory"), undefined);
    const temp = db.prepare("SELECT rowid FROM l1_records WHERE record_id = ?").get("l1-temp") as { rowid: number };
    db.prepare("DELETE FROM l1_records WHERE record_id = ?").run("l1-temp");
    db.prepare("DELETE FROM l1_fts WHERE record_id = ?").run("l1-temp");
    insertL1Fts(db, temp.rowid, "l1-squatter", "squatter unique memory");

    expect(store.upsertL1(makeL1("l1-new", "newcomer unique memory"), undefined)).toBe(true);
    const meta = db.prepare("SELECT rowid FROM l1_records WHERE record_id = ?").get("l1-new") as { rowid: number };
    expect(meta.rowid).toBe(temp.rowid);
    const occupant = db.prepare("SELECT record_id, content_original FROM l1_fts WHERE rowid = ?").get(temp.rowid) as {
      record_id: string;
      content_original: string;
    };
    expect(occupant.record_id).toBe("l1-squatter");
    expect(occupant.content_original).toBe("squatter unique memory");
    expect(store.searchL1Fts(buildFtsQuery("newcomer")!, 5).map((hit) => hit.record_id)).toContain("l1-new");
    expect(store.searchL1Fts(buildFtsQuery("squatter")!, 5).map((hit) => hit.record_id)).toContain("l1-squatter");
    expect(store.searchL1Fts(buildFtsQuery("keeper")!, 5).map((hit) => hit.record_id)).toContain("l1-b");
  });

  it("leaves an orphan FTS row in place when the metadata id does not exist", () => {
    const db = store.getRawDb();
    store.upsertL0(makeL0("l0-keep", "keeper alpha token"), undefined);
    store.upsertL1(makeL1("l1-keep", "keeper alpha memory"), undefined);
    insertL0Fts(db, 8000, "ghost-l0", "ghost alpha token");
    insertL1Fts(db, 8001, "ghost-l1", "ghost alpha memory");

    expect(store.deleteL0("ghost-l0")).toBe(false);
    expect(store.deleteL1("ghost-l1")).toBe(false);
    expect(store.deleteL1Batch(["ghost-l1", "also-missing"])).toBe(true);

    expect(db.prepare("SELECT record_id FROM l0_fts WHERE record_id = ?").get("ghost-l0")).toBeTruthy();
    expect(db.prepare("SELECT record_id FROM l1_fts WHERE record_id = ?").get("ghost-l1")).toBeTruthy();
    expect(store.searchL0Fts(buildFtsQuery("keeper")!, 5).map((hit) => hit.record_id)).toContain("l0-keep");
    expect(store.searchL1Fts(buildFtsQuery("keeper")!, 5).map((hit) => hit.record_id)).toContain("l1-keep");
  });

  it("does not return HTTP 200 when insertL0Batch throws or writes nothing", async () => {
    const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const deps: V2RouterDeps = {
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => undefined,
      logger,
      deployMode: "service",
      notifyPipeline: vi.fn(async () => {}),
    };
    const body = {
      team_id: "team-1",
      user_id: "user-1",
      agent_id: "agent-1",
      session_id: "sess-fail",
      messages: [{ role: "user", content: "should not commit" }],
    };
    const req = {
      headers: { authorization: "Bearer test-key", "x-tdai-service-id": "svc-1" },
    } as unknown as http.IncomingMessage;
    const res = {} as http.ServerResponse;

    const batch = vi.spyOn(store, "insertL0Batch").mockImplementation(() => {
      throw new Error("batch failed");
    });
    const thrown: number[] = [];
    await handleV2Route(req, res, "/v3/conversation/add", "POST", async () => body, (_res, status) => {
      thrown.push(status);
    }, deps);
    expect(thrown[0]).not.toBe(200);
    expect(thrown[0]).toBeGreaterThanOrEqual(500);
    expect(deps.notifyPipeline).not.toHaveBeenCalled();

    batch.mockImplementation(() => 0);
    const emptyWrite: number[] = [];
    await handleV2Route(req, res, "/v3/conversation/add", "POST", async () => body, (_res, status) => {
      emptyWrite.push(status);
    }, deps);
    expect(emptyWrite[0]).not.toBe(200);
    expect(emptyWrite[0]).toBeGreaterThanOrEqual(500);
    expect(deps.notifyPipeline).not.toHaveBeenCalled();
    batch.mockRestore();
  });
});
