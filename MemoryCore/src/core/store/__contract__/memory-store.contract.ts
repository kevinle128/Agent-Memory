/**
 * Shared IMemoryStore contract suite.
 *
 * Backend-agnostic behavioral tests that EVERY IMemoryStore implementation must
 * satisfy (sqlite, tcvdb, mongodb). A concrete spec file supplies a harness that
 * knows how to create/dispose an isolated store for one backend, then calls
 * `runMemoryStoreContract(harness)`.
 *
 * Scope (Phase-1 keyword-only surface — no vector assertions):
 *   - lifecycle + capability shape
 *   - L0 write/read/count + session query
 *   - L1 write/read/count + delete + independent query filters
 *   - FTS (BM25) recall for L0 + L1 (jieba-tokenized query via buildFtsQuery)
 *   - isolation pushdown (team/agent) on counts + FTS
 *   - L2/L3 profile sync/read/count/delete
 *   - clearMemoryContent (strict team+agent validation + idempotency)
 *
 * FTS on mongot is eventually consistent (change-stream → Lucene). Harnesses set
 * `ftsEventuallyConsistent: true` so search assertions poll until visible.
 */
import { describe, it, expect } from "vitest";
import type { IMemoryStore, L1QueryFilter, ProfileFilter, ProfileSyncRecord } from "../types.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import { buildFtsQuery } from "../tokenize.js";
import { isProfileRowStore } from "../profile-row-store.js";

export interface MemoryStoreContractHarness {
  /** Human-readable backend label used in test titles. */
  backend: string;
  /** Create a fresh, isolated (unique namespace/db/dir) store and init it. */
  createStore(): Promise<IMemoryStore>;
  /** Dispose the store + any underlying resources (files, connections). */
  disposeStore(store: IMemoryStore): Promise<void>;
  /** When true, FTS results are eventually consistent → search assertions poll. */
  ftsEventuallyConsistent?: boolean;
}

const now = () => new Date().toISOString();

/** buildFtsQuery narrowed to non-null (throws on empty — a test-authoring bug). */
function fts(text: string): string {
  const q = buildFtsQuery(text);
  if (!q) throw new Error(`empty FTS query for: ${text}`);
  return q;
}

function makeL1(id: string, content: string, over?: Partial<MemoryRecord>): MemoryRecord {
  const ts = now();
  return {
    id,
    content,
    type: "persona",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: {},
    timestamps: [ts],
    createdAt: ts,
    updatedAt: ts,
    sessionKey: "sk-contract",
    sessionId: "sid-contract",
    ...over,
  };
}

function makeL0(id: string, text: string, over?: Record<string, unknown>) {
  return {
    id,
    sessionKey: "sk-contract",
    sessionId: "sid-contract",
    role: "user",
    messageText: text,
    recordedAt: now(),
    timestamp: Date.now(),
    ...over,
  } as Parameters<IMemoryStore["upsertL0"]>[0];
}

/** Poll `fn` until it returns a truthy value or the deadline elapses. */
async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  { timeoutMs = 15_000, intervalMs = 400 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

export function runMemoryStoreContract(harness: MemoryStoreContractHarness): void {
  const { backend, ftsEventuallyConsistent } = harness;

  // Search assertion helper: single-shot for strongly-consistent backends,
  // polling for eventually-consistent ones (mongot).
  const searchExpect = async <T>(run: () => Promise<T[]>, want: (rows: T[]) => boolean): Promise<T[]> => {
    if (ftsEventuallyConsistent) {
      return pollUntil(run, want);
    }
    return run();
  };

  describe(`IMemoryStore contract [${backend}]`, () => {
    it("init → non-degraded + capability shape", async () => {
      const store = await harness.createStore();
      try {
        expect(store.isDegraded()).toBe(false);
        const caps = store.getCapabilities();
        expect(typeof caps.vectorSearch).toBe("boolean");
        expect(typeof caps.ftsSearch).toBe("boolean");
        expect(typeof caps.nativeHybridSearch).toBe("boolean");
        expect(typeof caps.sparseVectors).toBe("boolean");
        expect(typeof caps.profileRows).toBe("boolean");
        expect(typeof store.isFtsAvailable()).toBe("boolean");
        // profileRows must describe the store's actual shape, not an aspiration:
        // it is what selects a row-backed filesystem (D8 ④).
        expect(caps.profileRows).toBe(isProfileRowStore(store));
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("L0 write → count → session query roundtrip", async () => {
      const store = await harness.createStore();
      try {
        expect(await store.countL0()).toBe(0);
        expect(await store.upsertL0(makeL0("l0-a", "Hello from the contract suite"))).toBe(true);
        expect(await store.upsertL0(makeL0("l0-b", "A second conversation message"))).toBe(true);

        expect(await store.countL0()).toBe(2);

        const rows = await store.queryL0ForL1("sk-contract");
        expect(rows.length).toBe(2);
        expect(rows.map((r) => r.record_id).sort()).toEqual(["l0-a", "l0-b"]);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("L1 write → count → query → delete roundtrip", async () => {
      const store = await harness.createStore();
      try {
        expect(await store.countL1()).toBe(0);
        expect(await store.upsertL1(makeL1("l1-a", "User prefers dark mode in the editor"))).toBe(true);
        expect(await store.upsertL1(makeL1("l1-b", "User writes primarily TypeScript"))).toBe(true);
        expect(await store.countL1()).toBe(2);

        const rows = await store.queryL1Records();
        expect(rows.map((r) => r.record_id).sort()).toEqual(["l1-a", "l1-b"]);

        expect(await store.deleteL1Batch(["l1-a"])).toBe(true);
        expect(await store.countL1()).toBe(1);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("L0 round-trips project fields and keeps project out of the session group key", async () => {
      const store = await harness.createStore();
      try {
        const projectKey = "git:github.com/kevinle128/agent-memory";
        const projectHash = "0123456789abcdef";
        const projectName = "kevinle128/agent-memory";
        expect(await store.upsertL0(makeL0("l0-proj", "A message inside a project", { projectKey, projectHash, projectName }))).toBe(true);
        expect(await store.upsertL0(makeL0("l0-noproj", "A message without any project"))).toBe(true);

        const rows = await store.queryL0ForL1("sk-contract");
        const withProject = rows.find((r) => r.record_id === "l0-proj");
        const without = rows.find((r) => r.record_id === "l0-noproj");
        expect(withProject?.project_key).toBe(projectKey);
        expect(withProject?.project_hash).toBe(projectHash);
        expect(withProject?.project_name).toBe(projectName);
        // A row written without a project reads back empty.
        expect(without?.project_key ?? "").toBe("");
        expect(without?.project_hash ?? "").toBe("");
        expect(without?.project_name ?? "").toBe("");

        const page = await store.queryL0Paginated?.({ limit: 10, offset: 0 });
        expect(page?.rows.find((r) => r.record_id === "l0-proj")?.project_hash).toBe(projectHash);
        expect(page?.rows.find((r) => r.record_id === "l0-proj")?.project_name).toBe(projectName);

        // Same isolation tuple and session: one group, project kept per message.
        const groups = await store.queryL0GroupedBySessionId("sk-contract");
        expect(groups).toHaveLength(1);
        const byId = new Map(groups[0]!.messages.map((m) => [m.id, m] as const));
        expect(byId.get("l0-proj")?.projectKey).toBe(projectKey);
        expect(byId.get("l0-proj")?.projectHash).toBe(projectHash);
        expect(byId.get("l0-noproj")?.projectKey ?? "").toBe("");
        expect(byId.get("l0-noproj")?.projectHash ?? "").toBe("");
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("L1 round-trips project fields and replaces them on re-upsert", async () => {
      const store = await harness.createStore();
      try {
        const projectKey = "local:device-1:/work/app";
        const projectHash = "fedcba9876543210";
        expect(await store.upsertL1(makeL1("l1-proj", "Memory inside a project", { projectKey, projectHash }))).toBe(true);
        expect(await store.upsertL1(makeL1("l1-noproj", "Memory without a project"))).toBe(true);

        const rows = await store.queryL1Records();
        const withProject = rows.find((r) => r.record_id === "l1-proj");
        const without = rows.find((r) => r.record_id === "l1-noproj");
        expect(withProject?.project_key).toBe(projectKey);
        expect(withProject?.project_hash).toBe(projectHash);
        expect(without?.project_key ?? "").toBe("");
        expect(without?.project_hash ?? "").toBe("");

        const page = await store.queryL1Paginated?.({ limit: 10, offset: 0 });
        expect(page?.rows.find((r) => r.record_id === "l1-proj")?.project_hash).toBe(projectHash);

        // A re-upsert of the same id carries the new project value.
        const otherHash = "aaaaaaaaaaaaaaaa";
        expect(await store.upsertL1(makeL1("l1-proj", "Memory inside a project", {
          projectKey: "git:example.org/other", projectHash: otherHash, version: 1,
        }))).toBe(true);
        const [updated] = await store.queryL1Records({ recordIds: ["l1-proj"] });
        expect(updated?.project_hash).toBe(otherHash);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it.each<{ dimension: keyof L1QueryFilter; filter: L1QueryFilter; distractor: Partial<MemoryRecord> }>([
      { dimension: "recordIds", filter: { recordIds: ["l1-match"] }, distractor: {} },
      { dimension: "sessionId", filter: { sessionId: "sid-contract" }, distractor: { sessionId: "sid-other" } },
      { dimension: "sessionKey", filter: { sessionKey: "sk-contract" }, distractor: { sessionKey: "sk-other" } },
      { dimension: "teamId", filter: { teamId: "team-a" }, distractor: { teamId: "team-b" } },
      { dimension: "userId", filter: { userId: "user-a" }, distractor: { userId: "user-b" } },
      { dimension: "agentId", filter: { agentId: "agent-a" }, distractor: { agentId: "agent-b" } },
      { dimension: "taskId", filter: { taskId: "task-a" }, distractor: { taskId: "task-b" } },
      {
        dimension: "updatedAfter",
        filter: { updatedAfter: "2026-01-02T00:00:00.000Z" },
        distractor: { updatedAt: "2026-01-02T00:00:00.000Z" },
      },
    ])("L1 query applies $dimension independently", async ({ filter, distractor }) => {
      const store = await harness.createStore();
      try {
        const match = makeL1("l1-match", "Identical contract content", {
          teamId: "team-a",
          userId: "user-a",
          agentId: "agent-a",
          taskId: "task-a",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-03T00:00:00.000Z",
          timestamps: ["2026-01-01T00:00:00.000Z"],
        });
        // Apart from its unique identity, change only the tested dimension.
        const other = { ...match, id: "l1-other", ...distractor };
        expect(await store.upsertL1(match)).toBe(true);
        expect(await store.upsertL1(other)).toBe(true);
        expect((await store.queryL1Records()).map((r) => r.record_id).sort())
          .toEqual(["l1-match", "l1-other"]);
        expect((await store.queryL1Records(filter)).map((r) => r.record_id))
          .toEqual(["l1-match"]);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("listL0Sessions groups by session, sorts by last message and counts L1", async () => {
      const store = await harness.createStore();
      if (!store.listL0Sessions) {
        await harness.disposeStore(store);
        return;
      }
      try {
        const scope = { teamId: "team-s", userId: "user-s", agentId: "agent-s" };
        const t0 = Date.UTC(2026, 10, 7, 8, 0, 0);
        const msg = (id: string, sessionId: string, role: string, text: string, ts: number, over?: Record<string, unknown>) =>
          makeL0(id, text, { ...scope, sessionId, sessionKey: `sk-${sessionId}`, role, timestamp: ts, ...over });
        const longText = `${"x".repeat(70)} tail`;
        // Session A: assistant first, then two user messages; last at t0+3m.
        await store.upsertL0(msg("a1", "sess-a", "assistant", "Hello, how can I help?", t0));
        await store.upsertL0(msg("a2", "sess-a", "user", longText, t0 + 60_000,
          { projectKey: "git:example/p", projectHash: "0123456789abcdef", projectName: "example/p" }));
        await store.upsertL0(msg("a3", "sess-a", "user", "second question", t0 + 180_000));
        // Session B: newer activity, no user message.
        await store.upsertL0(msg("b1", "sess-b", "assistant", "only assistant", t0 + 600_000));
        // Session C: older, outside the time range used below.
        await store.upsertL0(msg("c1", "sess-c", "user", "old session", t0 - 86_400_000));
        // Other tenant: must not appear.
        await store.upsertL0(makeL0("z1", "other tenant", { teamId: "team-z", userId: "user-s", agentId: "agent-s", sessionId: "sess-z", timestamp: t0 }));
        // L1 rows: two from sess-a in scope, one from sess-a in another scope.
        await store.upsertL1(makeL1("l1-sa-1", "fact one", { ...scope, sessionId: "sess-a", source_message_ids: ["a2"] }));
        await store.upsertL1(makeL1("l1-sa-2", "fact two", { ...scope, sessionId: "sess-a" }));
        await store.upsertL1(makeL1("l1-sa-x", "other scope", { teamId: "team-z", userId: "user-s", agentId: "agent-s", sessionId: "sess-a" }));

        const all = await store.listL0Sessions({ ...scope, limit: 10, offset: 0 });
        expect(all.total).toBe(3);
        expect(all.sessions.map((s) => s.session_id)).toEqual(["sess-b", "sess-a", "sess-c"]);

        const a = all.sessions.find((s) => s.session_id === "sess-a")!;
        expect(a.first_ts).toBe(t0);
        expect(a.last_ts).toBe(t0 + 180_000);
        expect(a.message_count).toBe(3);
        expect(a.first_user_message).toBe(longText.slice(0, 60));
        expect(a.project_hash).toBe("0123456789abcdef");
        expect(a.project_name).toBe("example/p");
        expect(a.l1_count).toBe(2);

        const b = all.sessions.find((s) => s.session_id === "sess-b")!;
        expect(b.first_user_message).toBe("");
        expect(b.project_hash).toBe("");
        expect(b.l1_count).toBe(0);

        // Time range drops sess-c; pagination keeps the order.
        const ranged = await store.listL0Sessions({ ...scope, timeStartMs: t0, timeEndMs: t0 + 600_000, limit: 1, offset: 1 });
        expect(ranged.total).toBe(2);
        expect(ranged.sessions.map((s) => s.session_id)).toEqual(["sess-a"]);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("queryL0Paginated with order asc returns the conversation order", async () => {
      const store = await harness.createStore();
      try {
        const t0 = Date.UTC(2026, 10, 7, 8, 0, 0);
        // Same capture time for all rows, as one /conversation/add batch writes them.
        const recordedAt = new Date(t0 + 1_000_000).toISOString();
        for (const [id, offset] of [["m2", 2], ["m1", 1], ["m3", 3]] as const) {
          await store.upsertL0(makeL0(id, `message ${id}`, { sessionId: "sess-o", timestamp: t0 + offset * 1000, recordedAt }));
        }
        const asc = await store.queryL0Paginated?.({ sessionId: "sess-o", limit: 10, offset: 0, order: "asc" });
        if (!asc) return;
        expect(asc.rows.map((r) => r.record_id)).toEqual(["m1", "m2", "m3"]);
        expect(asc.total).toBe(3);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("L1 keeps source_message_ids and filters the paginated query by session", async () => {
      const store = await harness.createStore();
      try {
        await store.upsertL1(makeL1("l1-src", "memory with sources", { sessionId: "sess-1", source_message_ids: ["m-1", "m-2"] }));
        await store.upsertL1(makeL1("l1-other", "memory of another session", { sessionId: "sess-2" }));
        const page = await store.queryL1Paginated?.({ sessionId: "sess-1", limit: 10, offset: 0 });
        if (!page) return;
        expect(page.total).toBe(1);
        expect(page.rows[0]?.record_id).toBe("l1-src");
        expect(page.rows[0]?.session_id).toBe("sess-1");
        expect(page.rows[0]?.source_message_ids).toEqual(["m-1", "m-2"]);
        // The by-id read (used by atomic/update) returns them too.
        const byId = await store.queryL1Records({ recordIds: ["l1-src"] });
        expect(byId[0]?.source_message_ids).toEqual(["m-1", "m-2"]);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("L1 FTS (BM25) recalls by keyword", async () => {
      const store = await harness.createStore();
      try {
        await store.upsertL1(makeL1("l1-ts", "User writes primarily TypeScript and React"));
        await store.upsertL1(makeL1("l1-tea", "User prefers tea over coffee in mornings"));

        const q = fts("TypeScript");
        const hits = await searchExpect(
          () => Promise.resolve(store.searchL1Fts(q, 10)),
          (rows) => rows.some((r) => r.record_id === "l1-ts"),
        );
        expect(hits.some((r) => r.record_id === "l1-ts")).toBe(true);
        expect(hits.every((r) => typeof r.score === "number")).toBe(true);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("L0 FTS (BM25) recalls by keyword", async () => {
      const store = await harness.createStore();
      try {
        await store.upsertL0(makeL0("l0-ts", "Can you help me debug this TypeScript compiler error"));
        await store.upsertL0(makeL0("l0-cook", "What is a good recipe for dinner tonight"));

        const q = fts("TypeScript compiler");
        const hits = await searchExpect(
          () => Promise.resolve(store.searchL0Fts(q, 10)),
          (rows) => rows.some((r) => r.record_id === "l0-ts"),
        );
        expect(hits.some((r) => r.record_id === "l0-ts")).toBe(true);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("isolation pushdown on counts + FTS (no cross-tenant leakage)", async () => {
      const store = await harness.createStore();
      try {
        await store.upsertL0(makeL0("l0-ta", "shared keyword alpha", { teamId: "team-a", agentId: "agent-a" }));
        await store.upsertL0(makeL0("l0-tb", "shared keyword alpha", { teamId: "team-b", agentId: "agent-a" }));
        await store.upsertL1(makeL1("l1-ta", "shared keyword alpha", { teamId: "team-a", agentId: "agent-a" } as Partial<MemoryRecord>));
        await store.upsertL1(makeL1("l1-tb", "shared keyword alpha", { teamId: "team-b", agentId: "agent-a" } as Partial<MemoryRecord>));

        expect(await store.countL0({ teamId: "team-a", agentId: "agent-a" })).toBe(1);
        expect(await store.countL1({ teamId: "team-a", agentId: "agent-a" })).toBe(1);

        const q = fts("alpha");
        const filter = { teamId: "team-a", agentId: "agent-a" };
        const l1Hits = await searchExpect(
          () => Promise.resolve(store.searchL1Fts(q, 10, filter)),
          (rows) => rows.some((r) => r.record_id === "l1-ta"),
        );
        expect(l1Hits.some((r) => r.record_id === "l1-ta")).toBe(true);
        expect(l1Hits.some((r) => r.record_id === "l1-tb")).toBe(false);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("L2/L3 profile sync → read → count → delete", async () => {
      const store = await harness.createStore();
      if (!store.syncProfiles || !store.pullProfiles || !store.countProfiles || !store.deleteProfiles) {
        await harness.disposeStore(store);
        return; // backend without profile surface — skip
      }
      try {
        const ts = Date.now();
        await store.syncProfiles([
          {
            id: "profile:contract:l2:one",
            type: "l2",
            filename: "scene/one.md",
            content: "# Scene One\nThe user works on memory systems.",
            contentMd5: "md5-one",
            teamId: "team-a",
            agentId: "agent-a",
            version: 1,
            createdAtMs: ts,
            updatedAtMs: ts,
          },
          {
            id: "profile:contract:l3:persona",
            type: "l3",
            filename: "persona.md",
            content: "# Persona\nPragmatic senior engineer.",
            contentMd5: "md5-persona",
            teamId: "team-a",
            agentId: "agent-a",
            version: 1,
            createdAtMs: ts,
            updatedAtMs: ts,
          },
        ]);

        const all = await store.pullProfiles();
        expect(all.map((p) => p.id).sort()).toEqual(["profile:contract:l2:one", "profile:contract:l3:persona"]);
        expect(await store.countProfiles()).toBe(2);
        expect(await store.countProfiles({ type: "l2" })).toBe(1);

        await store.deleteProfiles(["profile:contract:l2:one"]);
        expect(await store.countProfiles()).toBe(1);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("queryProfiles selects the same population countProfiles counts (D10)", async () => {
      const store = await harness.createStore();
      if (!isProfileRowStore(store)) {
        await harness.disposeStore(store);
        return; // backend without a profile-row surface (sqlite)
      }
      try {
        const ts = Date.now();
        const row = (
          id: string,
          type: "l2" | "l3",
          filename: string,
          over: Partial<ProfileSyncRecord> = {},
        ): ProfileSyncRecord => ({
          id, type, filename,
          content: `# ${id}`,
          contentMd5: `md5-${id}`,
          teamId: "team-a",
          agentId: "agent-a",
          version: 1,
          createdAtMs: ts,
          updatedAtMs: ts,
          ...over,
        });

        await store.syncProfiles([
          row("p-work-q1", "l2", "scene_blocks/work/q1.md"),
          row("p-work-q2", "l2", "scene_blocks/work/q2.md"),
          row("p-life", "l2", "scene_blocks/life.md"),
          row("p-persona", "l3", "persona.md"),
          row("p-team-b", "l2", "scene_blocks/work/q3.md", { teamId: "team-b" }),
        ]);

        const ids = async (f?: ProfileFilter) =>
          (await store.queryProfiles(f)).map((p) => p.id).sort();

        expect(await ids()).toEqual(
          ["p-life", "p-persona", "p-team-b", "p-work-q1", "p-work-q2"],
        );
        expect(await ids({ type: "l3" })).toEqual(["p-persona"]);
        expect(await ids({ pathPrefix: "scene_blocks/work/" })).toEqual(
          ["p-team-b", "p-work-q1", "p-work-q2"],
        );
        // Scope and prefix compose — this is what backs a tenant-scoped listing.
        expect(await ids({ teamId: "team-a", pathPrefix: "scene_blocks/work/" })).toEqual(
          ["p-work-q1", "p-work-q2"],
        );
        expect(await ids({ pathPrefix: "scene_blocks/no-such/" })).toEqual([]);

        // Rows carry the content, so a file read needs no second round-trip.
        const [q1] = await store.queryProfiles({ pathPrefix: "scene_blocks/work/q1" });
        expect(q1.filename).toBe("scene_blocks/work/q1.md");
        expect(q1.content).toBe("# p-work-q1");

        const filters: (ProfileFilter | undefined)[] = [
          undefined,
          { type: "l2" },
          { pathPrefix: "scene_blocks/work/" },
          { teamId: "team-a" },
        ];
        for (const f of filters) {
          expect((await store.queryProfiles(f)).length).toBe(await store.countProfiles(f));
        }
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("clearMemoryContent clears L0/L1/profiles for a scope + is idempotent", async () => {
      const store = await harness.createStore();
      if (!store.clearMemoryContent) {
        await harness.disposeStore(store);
        return;
      }
      try {
        await store.upsertL0(makeL0("l0-c", "content to be cleared", { teamId: "team-x", agentId: "agent-x" }));
        await store.upsertL1(makeL1("l1-c", "content to be cleared", { teamId: "team-x", agentId: "agent-x" } as Partial<MemoryRecord>));
        if (store.syncProfiles) {
          const ts = Date.now();
          await store.syncProfiles([{
            id: "profile:contract:clear",
            type: "l2",
            filename: "clear.md",
            content: "to clear",
            contentMd5: "md5-clear",
            teamId: "team-x",
            agentId: "agent-x",
            version: 1,
            createdAtMs: ts,
            updatedAtMs: ts,
          }]);
        }

        const res = await store.clearMemoryContent({ teamId: "team-x", agentId: "agent-x" });
        expect(res.l0Deleted).toBeGreaterThanOrEqual(1);
        expect(res.l1Deleted).toBeGreaterThanOrEqual(1);

        expect(await store.countL0({ teamId: "team-x", agentId: "agent-x" })).toBe(0);
        expect(await store.countL1({ teamId: "team-x", agentId: "agent-x" })).toBe(0);

        // Idempotent: second call returns all-zero.
        const res2 = await store.clearMemoryContent({ teamId: "team-x", agentId: "agent-x" });
        expect(res2.l0Deleted).toBe(0);
        expect(res2.l1Deleted).toBe(0);
        expect(res2.profilesDeleted).toBe(0);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("clearMemoryContent rejects missing team/agent (strict validation)", async () => {
      const store = await harness.createStore();
      if (!store.clearMemoryContent) {
        await harness.disposeStore(store);
        return;
      }
      const clear = store.clearMemoryContent.bind(store);
      try {
        // Wrap in an async thunk so a *synchronous* throw (sqlite) and a rejected
        // promise (mongo) both surface as a rejection for `.rejects`.
        await expect((async () => clear({ teamId: "", agentId: "agent-x" }))()).rejects.toThrow();
        await expect((async () => clear({ teamId: "team-x", agentId: "" }))()).rejects.toThrow();
      } finally {
        await harness.disposeStore(store);
      }
    });
  });
}
