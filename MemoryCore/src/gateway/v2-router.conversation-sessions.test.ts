/**
 * L0 session list route, conversation order on conversation/query, and the
 * session filter plus source ids on atomic/query. Runs on the SQLite store.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MemoryRecord } from "../core/record/l1-writer.js";
import { VectorStore } from "../core/store/sqlite/memory-store.js";
import type { IMemoryStore, L0Record } from "../core/store/types.js";
import {
  handleAtomicCount,
  handleAtomicQuery,
  handleAtomicUpdate,
  handleConversationQuery,
  handleConversationSessions,
  handleV2Route,
  type V2RouterDeps,
} from "./v2-router.js";
import type { AtomicQueryData, ConversationQueryData, ConversationSessionsData } from "./v2-schemas.js";

const auth = {} as Parameters<typeof handleConversationSessions>[1];
const SCOPE = { teamId: "team-1", userId: "user-1", agentId: "agent-1" };
const T0 = Date.UTC(2026, 10, 7, 8, 0, 0);

function depsFor(store: IMemoryStore | undefined): V2RouterDeps {
  return {
    getStore: () => store,
    getEmbedding: () => undefined,
    getStorage: () => undefined,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    deployMode: "standalone",
    requestIsolation: { ...SCOPE, sessionId: "default" },
  } as unknown as V2RouterDeps;
}

function l0(id: string, sessionId: string, role: string, text: string, ts: number, over?: Partial<L0Record>): L0Record {
  return {
    id,
    sessionKey: `sk-${sessionId}`,
    sessionId,
    ...SCOPE,
    role,
    messageText: text,
    recordedAt: new Date(T0 + 3_600_000).toISOString(),
    timestamp: ts,
    ...over,
  };
}

function l1(id: string, sessionId: string, sourceIds: string[]): MemoryRecord {
  const at = new Date(T0).toISOString();
  return {
    id,
    content: `memory ${id}`,
    type: "persona",
    priority: 50,
    scene_name: "",
    source_message_ids: sourceIds,
    metadata: {},
    timestamps: [at],
    createdAt: at,
    updatedAt: at,
    sessionKey: `sk-${sessionId}`,
    sessionId,
    ...SCOPE,
  };
}

describe("conversation/sessions and session-aware L0/L1 queries", () => {
  let dir: string;
  let store: VectorStore;
  let deps: V2RouterDeps;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "gateway-sessions-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    for (const r of [
      l0("a2", "sess-a", "assistant", "answer", T0 + 60_000),
      l0("a1", "sess-a", "user", "Add a quick key to switch models", T0),
      l0("b1", "sess-b", "user", "Deploy the server", T0 + 600_000),
      l0("x1", "sess-x", "user", "other agent", T0, { agentId: "agent-2" }),
    ]) {
      await store.upsertL0(r, undefined);
    }
    await store.upsertL1(l1("m-a", "sess-a", ["a2"]), undefined);
    await store.upsertL1(l1("m-b", "sess-b", []), undefined);
    deps = depsFor(store);
  });

  afterEach(() => {
    store.getRawDb().close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists the sessions of the caller scope, newest first, with ISO times", async () => {
    const res = await handleConversationSessions({}, auth, "r", deps);

    expect(res.code).toBe(0);
    const data = res.data as ConversationSessionsData;
    expect(data.total).toBe(2);
    expect(data.sessions.map((s) => s.session_id)).toEqual(["sess-b", "sess-a"]);
    expect(data.sessions[1]).toEqual({
      session_id: "sess-a",
      first_ts: new Date(T0).toISOString(),
      last_ts: new Date(T0 + 60_000).toISOString(),
      message_count: 2,
      first_user_message: "Add a quick key to switch models",
      l1_count: 1,
    });
  });

  it("applies time range and pagination", async () => {
    const res = await handleConversationSessions(
      { time_start: new Date(T0 + 300_000).toISOString(), limit: 5, offset: 0 },
      auth,
      "r",
      deps,
    );

    expect(res.code).toBe(0);
    expect((res.data as ConversationSessionsData).sessions.map((s) => s.session_id)).toEqual(["sess-b"]);
  });

  it("rejects a bad limit or time with 400", async () => {
    for (const body of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { time_start: "yesterday" }]) {
      const res = await handleConversationSessions(body, auth, "r", deps);
      expect(res.code, JSON.stringify(body)).toBe(400);
    }
  });

  it("answers 501 when the store has no session list and 503 without a store", async () => {
    const noList = { ...store, listL0Sessions: undefined } as unknown as IMemoryStore;
    expect((await handleConversationSessions({}, auth, "r", depsFor(noList))).code).toBe(501);
    expect((await handleConversationSessions({}, auth, "r", depsFor(undefined))).code).toBe(503);
  });

  it("returns one session in conversation order with message_time when order is asc", async () => {
    const res = await handleConversationQuery({ session_id: "sess-a", order: "asc" }, auth, "r", deps);

    expect(res.code).toBe(0);
    const data = res.data as ConversationQueryData & { messages: Array<{ id: string; message_time?: string }> };
    expect(data.messages.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(data.messages[0]?.message_time).toBe(new Date(T0).toISOString());
  });

  it("rejects an unknown order with 400", async () => {
    const res = await handleConversationQuery({ order: "sideways" }, auth, "r", deps);
    expect(res.code).toBe(400);
  });

  it("filters L1 by session_id and returns session_id and source_message_ids", async () => {
    const res = await handleAtomicQuery({ session_id: "sess-a" }, auth, "r", deps);

    expect(res.code).toBe(0);
    const data = res.data as AtomicQueryData;
    expect(data.total).toBe(1);
    expect(data.items[0]).toMatchObject({ id: "m-a", session_id: "sess-a", source_message_ids: ["a2"] });
  });

  it("returns all L1 rows of the scope when session_id is absent", async () => {
    const res = await handleAtomicQuery({}, auth, "r", deps);

    expect(res.code).toBe(0);
    expect((res.data as AtomicQueryData).items.map((i) => i.id).sort()).toEqual(["m-a", "m-b"]);
  });

  it("keeps source_message_ids when atomic/update edits the content", async () => {
    const upd = await handleAtomicUpdate({ id: "m-a", content: "edited memory" }, auth, "r", deps);
    expect(upd.code).toBe(0);
    const res = await handleAtomicQuery({ session_id: "sess-a" }, auth, "r", deps);
    const data = res.data as AtomicQueryData;
    expect(data.items[0]?.content).toBe("edited memory");
    expect(data.items[0]?.source_message_ids).toEqual(["a2"]);
  });

  it("counts L1 by session_id like atomic/query", async () => {
    const one = await handleAtomicCount({ session_id: "sess-a" }, auth, "r", deps);
    const all = await handleAtomicCount({}, auth, "r", deps);

    expect((one.data as { total: number }).total).toBe(1);
    expect((all.data as { total: number }).total).toBe(2);
  });

  describe("routing", () => {
    async function dispatch(pathname: string) {
      const sent: Array<{ status: number; body: { code: number; data?: unknown } }> = [];
      const req = {
        headers: {
          authorization: "Bearer t",
          "x-tdai-service-id": "inst-1",
          "x-tdai-team-id": SCOPE.teamId,
          "x-tdai-agent-id": SCOPE.agentId,
          "x-tdai-user-id": SCOPE.userId,
        },
        url: pathname,
        method: "POST",
      } as unknown as http.IncomingMessage;
      const handled = await handleV2Route(
        req,
        {} as http.ServerResponse,
        pathname,
        "POST",
        (async () => ({})) as never,
        ((_res: unknown, status: number, body: unknown) => {
          sent.push({ status, body: body as never });
        }) as never,
        { ...deps, requestIsolation: undefined } as V2RouterDeps,
      );
      return { handled, sent };
    }

    it("mounts the session list on /v3 only and scopes it by the isolation headers", async () => {
      const v3 = await dispatch("/v3/conversation/sessions");
      expect(v3.handled).toBe(true);
      expect(v3.sent[0]?.status).toBe(200);
      const data = v3.sent[0]?.body.data as ConversationSessionsData;
      expect(data.sessions.map((s) => s.session_id)).toEqual(["sess-b", "sess-a"]);

      const v2 = await dispatch("/v2/conversation/sessions");
      expect(v2.handled).toBe(false);
    });
  });
});
