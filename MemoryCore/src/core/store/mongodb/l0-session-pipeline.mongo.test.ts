/**
 * Runs the L0 session list pipelines on a real MongoDB. It needs a local `mongod`
 * binary, taken from MONGOMS_SYSTEM_BINARY or from PATH. Without one, the suite
 * is skipped.
 *
 * The full MongoMemoryStore needs mongot for `$search`, which a plain server
 * does not have, so this test runs the same pipelines and mapping that
 * `MongoMemoryStore.listL0Sessions` uses on documents written by the store mappers.
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import type { MongoMemoryServer } from "mongodb-memory-server";

import type { MemoryRecord } from "../../record/l1-writer.js";
import type { L0Record } from "../types.js";
import { l0RecordToDoc, l1RecordToDoc } from "./doc-mappers.js";
import {
  buildL0SessionListPipeline,
  buildL1CountBySessionPipeline,
  toL0SessionSummary,
  type L0SessionGroupDoc,
} from "./l0-session-pipeline.js";

function findMongod(): string | null {
  if (process.env.MONGOMS_SYSTEM_BINARY) return process.env.MONGOMS_SYSTEM_BINARY;
  try {
    const found = execFileSync("which", ["mongod"], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}

const SCOPE = { team_id: "team-s", user_id: "user-s", agent_id: "agent-s" };
const T0 = Date.UTC(2026, 10, 7, 8, 0, 0);

function l0(id: string, sessionId: string, role: string, text: string, ts: number, over?: Partial<L0Record>): L0Record {
  return {
    id,
    sessionKey: `sk-${sessionId}`,
    sessionId,
    teamId: SCOPE.team_id,
    userId: SCOPE.user_id,
    agentId: SCOPE.agent_id,
    role,
    messageText: text,
    recordedAt: new Date(ts).toISOString(),
    timestamp: ts,
    ...over,
  };
}

function l1(id: string, sessionId: string, over?: Partial<MemoryRecord>): MemoryRecord {
  const at = new Date(T0).toISOString();
  return {
    id,
    content: `memory ${id}`,
    type: "persona",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: {},
    timestamps: [at],
    createdAt: at,
    updatedAt: at,
    sessionKey: `sk-${sessionId}`,
    sessionId,
    teamId: SCOPE.team_id,
    userId: SCOPE.user_id,
    agentId: SCOPE.agent_id,
    ...over,
  };
}

async function listSessions(db: Db, match: Record<string, unknown>, limit: number, offset: number) {
  const [facet] = await db
    .collection("l0")
    .aggregate<{ total: Array<{ n: number }>; page: L0SessionGroupDoc[] }>(buildL0SessionListPipeline(match, limit, offset))
    .toArray();
  const page = facet?.page ?? [];
  const counts = await db
    .collection("l1")
    .aggregate<{ _id: string; n: number }>(buildL1CountBySessionPipeline(SCOPE, page.map((g) => g._id)))
    .toArray();
  const l1Counts = new Map(counts.map((c) => [c._id, c.n] as const));
  return { total: facet?.total[0]?.n ?? 0, sessions: page.map((g) => toL0SessionSummary(g, l1Counts)) };
}

const mongodPath = findMongod();

if (!mongodPath) {
  describe.skip("L0 session list pipeline: mongodb (no mongod binary found)", () => {});
} else {
  describe("L0 session list pipeline: mongodb", () => {
    let server: MongoMemoryServer;
    let client: MongoClient;
    let db: Db;

    beforeAll(async () => {
      process.env.MONGOMS_SYSTEM_BINARY = mongodPath;
      const { MongoMemoryServer: Server } = await import("mongodb-memory-server");
      server = await Server.create();
      client = new MongoClient(server.getUri());
      await client.connect();
      db = client.db(`l0_sessions_${process.pid}`);

      const longText = `${"é".repeat(70)} tail`;
      await db.collection("l0").insertMany([
        l0("a1", "sess-a", "assistant", "Hello, how can I help?", T0),
        l0("a2", "sess-a", "user", longText, T0 + 60_000, {
          projectKey: "git:example/p",
          projectHash: "0123456789abcdef",
          projectName: "example/p",
        }),
        l0("a3", "sess-a", "user", "second question", T0 + 180_000),
        l0("b1", "sess-b", "assistant", "only assistant", T0 + 600_000),
        l0("c1", "sess-c", "user", "old session", T0 - 86_400_000),
        l0("z1", "sess-z", "user", "other tenant", T0, { teamId: "team-z" }),
      ].map((r) => l0RecordToDoc(r)) as never[]);
      await db.collection("l1").insertMany([
        l1("l1-sa-1", "sess-a", { source_message_ids: ["a2"] }),
        l1("l1-sa-2", "sess-a"),
        l1("l1-sa-x", "sess-a", { teamId: "team-z" }),
      ].map((r) => l1RecordToDoc(r)) as never[]);
    }, 120_000);

    afterAll(async () => {
      await db?.dropDatabase();
      await client?.close();
      await server?.stop();
    });

    it("groups by session, sorts by last message and fills preview, project and L1 count", async () => {
      const { total, sessions } = await listSessions(db, SCOPE, 10, 0);

      expect(total).toBe(3);
      expect(sessions.map((s) => s.session_id)).toEqual(["sess-b", "sess-a", "sess-c"]);
      const a = sessions[1]!;
      expect(a).toMatchObject({
        first_ts: T0,
        last_ts: T0 + 180_000,
        message_count: 3,
        project_key: "git:example/p",
        project_hash: "0123456789abcdef",
        project_name: "example/p",
        l1_count: 2,
      });
      // The preview counts code points, not bytes.
      expect(a.first_user_message).toBe("é".repeat(60));
      expect(sessions[0]).toMatchObject({ first_user_message: "", project_hash: "", l1_count: 0 });
    });

    it("applies the time range and the page window", async () => {
      const match = { ...SCOPE, timestamp: { $gte: T0, $lte: T0 + 600_000 } };
      const { total, sessions } = await listSessions(db, match, 1, 1);

      expect(total).toBe(2);
      expect(sessions.map((s) => s.session_id)).toEqual(["sess-a"]);
    });

    it("returns an empty page and total 0 when nothing matches", async () => {
      const { total, sessions } = await listSessions(db, { ...SCOPE, team_id: "nobody" }, 10, 0);

      expect(total).toBe(0);
      expect(sessions).toEqual([]);
    });

    it("stores source_message_ids on the L1 document", async () => {
      const doc = await db.collection("l1").findOne({ _id: "l1-sa-1" } as never);
      expect(doc?.source_message_ids).toEqual(["a2"]);
    });
  });
}
