import { describe, it, expect } from "vitest";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type { L0Record } from "../types.js";
import {
  docToL0QueryRow,
  docToL1RecordRow,
  docToL1SearchResult,
  l0RecordToDoc,
  l1RecordToDoc,
  type L0Doc,
  type L1Doc,
} from "./doc-mappers.js";

const PROJECT = { projectKey: "git:github.com/acme/app", projectHash: "0123456789abcdef" };

function l0(over: Partial<L0Record> = {}): L0Record {
  return {
    id: "l0-1", sessionKey: "sk", sessionId: "sid", role: "user", messageText: "hello",
    recordedAt: "2026-01-01T00:00:00.000Z", timestamp: 1, ...over,
  };
}

function l1(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "l1-1", content: "fact", type: "persona", priority: 50, scene_name: "",
    source_message_ids: [], metadata: {}, timestamps: ["2026-01-01T00:00:00.000Z"],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    sessionKey: "sk", sessionId: "sid", ...over,
  };
}

describe("mongodb doc mappers project fields", () => {
  it("round-trips L0 project fields", () => {
    const doc = l0RecordToDoc(l0(PROJECT));
    expect(doc.project_key).toBe(PROJECT.projectKey);
    expect(doc.project_hash).toBe(PROJECT.projectHash);
    const row = docToL0QueryRow(doc);
    expect(row.project_key).toBe(PROJECT.projectKey);
    expect(row.project_hash).toBe(PROJECT.projectHash);
  });

  it("stores an L0 record without project as empty strings", () => {
    const doc = l0RecordToDoc(l0());
    expect(doc.project_key).toBe("");
    expect(doc.project_hash).toBe("");
  });

  it("reads an L0 document written before the project fields as empty", () => {
    const legacy = { ...l0RecordToDoc(l0()) } as Partial<L0Doc>;
    delete legacy.project_key;
    delete legacy.project_hash;
    const row = docToL0QueryRow(legacy as L0Doc);
    expect(row.project_key).toBe("");
    expect(row.project_hash).toBe("");
  });

  it("round-trips L1 project fields into rows and search results", () => {
    const doc = l1RecordToDoc(l1(PROJECT));
    expect(doc.project_key).toBe(PROJECT.projectKey);
    expect(doc.project_hash).toBe(PROJECT.projectHash);
    const row = docToL1RecordRow(doc);
    expect(row.project_key).toBe(PROJECT.projectKey);
    expect(row.project_hash).toBe(PROJECT.projectHash);
    const hit = docToL1SearchResult(doc, 0.5);
    expect(hit.project_key).toBe(PROJECT.projectKey);
    expect(hit.project_hash).toBe(PROJECT.projectHash);
  });

  it("reads an L1 document written before the project fields as empty", () => {
    const legacy = { ...l1RecordToDoc(l1()) } as Partial<L1Doc>;
    delete legacy.project_key;
    delete legacy.project_hash;
    const row = docToL1RecordRow(legacy as L1Doc);
    expect(row.project_key).toBe("");
    expect(row.project_hash).toBe("");
  });
});
