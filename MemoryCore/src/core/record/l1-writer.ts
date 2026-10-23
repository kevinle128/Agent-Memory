/**
 * L1 Memory Writer: writes extracted memories to JSONL files.
 *
 * File naming: records/YYYY-MM-DD.jsonl (daily shards, all sessions merged).
 * Each record includes sessionKey for traceability.
 *
 * Write strategy:
 * - JSONL is the append-only persistent store (source of truth for backup/recovery).
 * - VectorStore (SQLite) is the primary retrieval engine.
 * - On update/merge, old records are deleted from VectorStore in real-time;
 *   JSONL is append-only and cleaned up periodically by memory-cleaner.
 *
 * Supports store (append), update, merge, and skip operations.
 *
 * v3: Aligned with Kenty's prompt output format — 3 memory types (persona/episodic/instruction),
 * numeric priority, scene_name, source_message_ids, metadata, timestamps.
 */

import crypto from "node:crypto";
import { DEFAULT_ISOLATION_ID, type IMemoryStore } from "../store/types.js";
import { buildDedupScopeFilter } from "../store/isolation.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";
import type { Logger } from "../types.js";
import { resolveUnanimousProject, type ResolvedProject } from "./l1-project.js";

// ============================
// Types
// ============================

/** L1 memory types: chat-mode legacy types + code/work-mode team memory types. */
export type MemoryType =
  | "persona"
  | "episodic"
  | "instruction"
  | "work_fact"
  | "work_task"
  | "work_method"
  | "work_artifact";

/** Metadata for episodic memories (activity time range) */
export interface EpisodicMetadata {
  activity_start_time?: string; // ISO 8601
  activity_end_time?: string; // ISO 8601
}

/**
 * A persisted memory record in L1 JSONL files.
 *
 * v3 changes from v2:
 * - `importance: "high"|"medium"|"low"` → `priority: number` (0-100, -1 for strict global instructions)
 * - Added `scene_name`, `source_message_ids`, `metadata`, `timestamps`
 * - Removed `keywords` (will be rebuilt from content for search)
 * - MemoryType reduced from 4 to 3 (removed "preference", folded into "persona")
 */
export interface MemoryRecord {
  /** Unique ID for dedup updates */
  id: string;
  /** Memory content */
  content: string;
  /** Memory type: persona / episodic / instruction */
  type: MemoryType;
  /** Priority score: 0-100 (higher = more important), -1 = strict global instruction */
  priority: number;
  /** Scene name this memory belongs to */
  scene_name: string;
  /** Source message IDs that contributed to this memory */
  source_message_ids: string[];
  /** Type-specific metadata (e.g., activity_start_time for episodic) */
  metadata: EpisodicMetadata | Record<string, never>;
  /** Timestamp trail: all timestamps related to this memory (for merge history tracking) */
  timestamps: string[];
  /** Creation timestamp (ISO) */
  createdAt: string;
  /** Last update timestamp (ISO) */
  updatedAt: string;
  /** Monotonic version. New memories start at 1; update/merge increments by 1. */
  version?: number;
  /** Source session key (conversation channel identifier) */
  sessionKey: string;
  /** Source session ID (single conversation instance identifier) */
  sessionId: string;
  /** Optional task dimension for L0/L1 filtering. */
  taskId?: string;
  /**
   * Project of the source messages. Set only when all sources agree; empty or
   * absent means no project. Not part of the tenancy identity.
   */
  projectKey?: string;
  projectHash?: string;
  /**
   * Three-dim tenancy isolation (new in this branch).
   *
   * `userId` / `agentId` are mandatory for new writes once gateway-level
   * isolation enforcement is on, but kept optional on the type to avoid
   * breaking pre-isolation call sites and tests during rollout. The SQLite
   * upsert defaults them to '' if missing; the migration script backfills
   * existing rows with `__legacy__`.
   *
   * See `docs/l0l3-tenant-isolation-design.md`.
   */
  teamId?: string;
  userId?: string;
  agentId?: string;
}

/**
 * A memory as extracted by LLM (before dedup / persistence).
 * Matches the output format of Kenty's extraction prompt.
 */
export interface ExtractedMemory {
  content: string;
  type: MemoryType;
  priority: number;
  source_message_ids: string[];
  metadata: EpisodicMetadata | Record<string, never>;
  /** Scene name this memory was extracted in */
  scene_name: string;
  /** Project resolved from the source messages. Empty or absent means no project. */
  projectKey?: string;
  projectHash?: string;
}

export type DedupAction = "store" | "update" | "merge" | "skip";

/**
 * v3 batch dedup decision — one per new memory, aligned with Kenty's conflict detection prompt.
 *
 * Key changes:
 * - `targetId` → `target_ids` (array, supports multi-target merge/update)
 * - Added `merged_type`, `merged_priority`, `merged_timestamps` for cross-type merge
 */
export interface DedupDecision {
  /** Which new memory this decision is about */
  record_id: string;
  action: DedupAction;
  /** IDs of existing records to replace/remove (for update/merge) */
  target_ids: string[];
  /** Merged/updated content text (for update/merge) */
  merged_content?: string;
  /** Best type after merge (for update/merge, may differ from original) */
  merged_type?: MemoryType;
  /** Priority after merge (for update/merge) */
  merged_priority?: number;
  /** Union of all related timestamps (for update/merge) */
  merged_timestamps?: string[];
}

const TAG = "[memory-tdai][l1-writer]";

/** Waits before each retry of a failed replaced-record delete. */
const REPLACED_DELETE_RETRY_DELAYS_MS = [200, 1000];

// ============================
// Core functions
// ============================

/**
 * Generate a unique memory ID.
 */
export function generateMemoryId(): string {
  return `m_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Write a memory record according to the dedup decision.
 *
 * - store: append new record
 * - update: remove target records + append updated record
 * - merge: remove target records + append merged record
 * - skip: do nothing
 *
 * v3: supports multi-target removal for update/merge.
 * v3.1: optional VectorStore + EmbeddingService for dual-write (JSONL + vector).
 */
/**
 * Thrown by writeMemory when no persistence target stored the record: the
 * JSONL append failed and the vector upsert failed too (or no vector store
 * is configured). A record that exists nowhere must not count as stored,
 * else L1 moves its cursor past the source messages and the memory is lost.
 */
export class L1PersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "L1PersistenceError";
  }
}

export function isL1PersistenceError(err: unknown): err is L1PersistenceError {
  return err instanceof Error && err.name === "L1PersistenceError";
}

export async function writeMemory(params: {
  memory: ExtractedMemory;
  decision: DedupDecision;
  baseDir: string;
  sessionKey: string;
  sessionId?: string;
  taskId?: string;
  /** Tenancy isolation propagated into MemoryRecord and downstream store. */
  teamId?: string;
  userId?: string;
  agentId?: string;
  logger?: Logger;
  /** Optional vector store for dual-write (JSONL + vector DB) */
  vectorStore?: IMemoryStore;
  /** Optional embedding service (required when vectorStore is provided) */
  embeddingService?: EmbeddingService;
  /** StorageAdapter for file operations (COS/local). Falls back to fs when absent. */
  storage?: StorageAdapter;
}): Promise<MemoryRecord | null> {
  const { memory, decision, baseDir, sessionKey, sessionId, taskId, teamId, userId, agentId, logger, vectorStore, embeddingService, storage } = params;

  if (decision.action === "skip") {
    logger?.debug?.(`${TAG} Skipping memory: ${memory.content.slice(0, 50)}...`);
    return null;
  }

  const now = new Date().toISOString();

  let nextVersion = 0;
  // Project of the records this write replaces. It is used only when the new
  // memory has no project of its own, so a merge never erases a known project.
  let existingProject: ResolvedProject = { projectKey: "", projectHash: "" };
  if ((decision.action === "update" || decision.action === "merge") && decision.target_ids.length > 0 && vectorStore) {
    try {
      const existing = await vectorStore.queryL1Records({ recordIds: decision.target_ids });
      const maxVersion = existing.reduce((max, row) => Math.max(max, row.version ?? 0), 0);
      nextVersion = maxVersion + 1;
      existingProject = resolveUnanimousProject(
        existing.map((row) => ({ projectKey: row.project_key, projectHash: row.project_hash })),
      );
    } catch (err) {
      logger?.warn?.(`${TAG} Failed to read existing memory version, defaulting to v0: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Determine final content, type, priority based on action
  let finalContent: string;
  let finalType: MemoryType;
  let finalPriority: number;
  let finalTimestamps: string[];

  if (decision.action === "merge" || decision.action === "update") {
    finalContent = decision.merged_content ?? memory.content;
    finalType = decision.merged_type ?? memory.type;
    finalPriority = decision.merged_priority ?? memory.priority;
    finalTimestamps = decision.merged_timestamps ?? [now];
  } else {
    // store
    finalContent = memory.content;
    finalType = memory.type;
    finalPriority = memory.priority;
    finalTimestamps = [now];
  }

  const ownProject = resolveUnanimousProject([{ projectKey: memory.projectKey, projectHash: memory.projectHash }]);
  const project = ownProject.projectHash ? ownProject : existingProject;

  const record: MemoryRecord = {
    id: decision.record_id || generateMemoryId(),
    content: finalContent,
    type: finalType,
    priority: finalPriority,
    scene_name: memory.scene_name,
    source_message_ids: memory.source_message_ids,
    metadata: memory.metadata,
    timestamps: finalTimestamps,
    createdAt: now,
    updatedAt: now,
    version: nextVersion,
    sessionKey,
    sessionId: sessionId || DEFAULT_ISOLATION_ID,
    taskId,
    // Empty project stays absent so JSONL lines of project-less memories keep their old shape.
    projectKey: project.projectKey || undefined,
    projectHash: project.projectHash || undefined,
    teamId,
    // Tenancy isolation — propagated end-to-end so SQLite / TCVDB upsert
    // can persist the row's owner. Empty strings preserve pre-isolation
    // behaviour for callers that haven't been updated yet.
    userId: userId || DEFAULT_ISOLATION_ID,
    agentId: agentId || DEFAULT_ISOLATION_ID,
  };

  const shardDate = formatLocalDate(new Date());
  const recordKey = StoragePaths.record(shardDate);

  // Helper: append a JSONL line
  // - standalone (no storage): write to local fs
  // - service (storage provided): write via StorageAdapter, no fs fallback
  //
  // Guard log (CR-2 fix, 2026-05-19): if storage is absent, emit a warn so any
  // missed wiring (e.g. caller forgot to pass storage in service mode) is
  // immediately visible instead of silently writing to ephemeral pod fs.
  // In standalone mode this warn is benign — the gateway auto-wires a
  // LocalStorageBackend at startup (server.ts:199-203), so storage should
  // normally be defined. Seeing this warn = caller forgot to pass it.
  const appendRecord = async (line: string) => {
    if (storage) {
      await storage.appendFile(recordKey, line);
    } else {
      logger?.warn?.(
        `${TAG} [CR-2 guard] writeMemory called without storage adapter; ` +
        `falling back to local fs at ${baseDir}/records/${shardDate}.jsonl. ` +
        `In service mode this means JSONL is written to ephemeral pod fs and ` +
        `will be lost on restart. Caller must pass 'storage' to writeMemory.`,
      );
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const recordsDir = path.default.join(baseDir, "records");
      await fs.default.mkdir(recordsDir, { recursive: true });
      await fs.default.appendFile(path.default.join(recordsDir, `${shardDate}.jsonl`), line, "utf-8");
    }
  };

  // Persistence outcome per target. writeMemory succeeds when at least one
  // durable target has the record (JSONL or vector store).
  let jsonlFailed = false;
  let jsonlError: unknown;
  let vectorStored = false;
  let vectorError: unknown;

  try {
    await appendRecord(JSON.stringify(record) + "\n");
  } catch (err) {
    jsonlFailed = true;
    jsonlError = err;
    logger?.warn?.(`${TAG} JSONL append failed (non-fatal, VDB write continues): ${err instanceof Error ? err.message : String(err)}`);
  }
  logger?.debug?.(`${TAG} ${decision.action} memory ${record.id}: ${finalContent.slice(0, 80)}...`);

  // === Vector Store dual-write ===
  if (vectorStore) {
    try {
      logger?.debug?.(
        `${TAG} [vec-dual-write] START id=${record.id}, contentLen=${record.content.length}, ` +
        `content="${record.content.slice(0, 80)}..."`,
      );

      let embedding: Float32Array | undefined;

      if (embeddingService) {
        try {
          embedding = await embeddingService.embed(record.content);
          logger?.debug?.(
            `${TAG} [vec-dual-write] Embedding OK: dims=${embedding.length}, ` +
            `norm=${Math.sqrt(Array.from(embedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
          );
        } catch (embedErr) {
          // Embedding failed — pass undefined to upsert() which writes
          // metadata + FTS only, skipping the vec0 table.
          logger?.warn(
            `${TAG} [vec-dual-write] Embedding FAILED for id=${record.id}, ` +
            `will write metadata only: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`,
          );
        }
      }

      const upsertOk = await vectorStore.upsertL1(record, embedding);
      vectorStored = upsertOk === true;
      if (!vectorStored) vectorError = new Error("vector store upsert returned false");
      logger?.debug?.(`${TAG} [vec-dual-write] upsert result=${upsertOk} id=${record.id}`);
    } catch (err) {
      vectorError = err;
      // Vector write failure should NOT block the main JSONL write
      logger?.warn?.(
        `${TAG} [vec-dual-write] FAILED (JSONL already written) id=${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    logger?.debug?.(
      `${TAG} [vec-dual-write] SKIPPED id=${record.id}: vectorStore=${!!vectorStore}`,
    );
  }

  // Remove the replaced records only after the replacement is in the vector
  // store, which is the retrieval source of truth (memory-cleaner reconciles the
  // append-only JSONL against it). If the replacement is missing there, the old
  // records stay so the memory remains retrievable until a retry.
  const replacedIds = decision.action === "update" || decision.action === "merge"
    ? decision.target_ids.filter((id) => id !== record.id)
    : [];
  if (vectorStore && replacedIds.length > 0) {
    if (vectorStored) {
      // Isolate by scope (team/user/agent) only: target_ids are cross-session
      // records, so a sessionId/sessionKey condition would keep them from
      // being deleted. This matches atomic/delete, which omits sessionId too.
      const deleteFilter = buildDedupScopeFilter(teamId, userId, agentId);
      // The replacement is already stored, so a failed delete leaves old and new
      // side by side. Retry briefly for transient store errors; some backends
      // report failure by returning false instead of throwing.
      let deleteError: unknown;
      for (let attempt = 0; attempt <= REPLACED_DELETE_RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, REPLACED_DELETE_RETRY_DELAYS_MS[attempt - 1]));
        }
        try {
          if ((await vectorStore.deleteL1Batch(replacedIds, deleteFilter)) === true) {
            deleteError = undefined;
            break;
          }
          deleteError = new Error("deleteL1Batch returned false");
        } catch (err) {
          deleteError = err;
        }
      }
      if (deleteError === undefined) {
        logger?.debug?.(`${TAG} VectorStore: deleted ${replacedIds.length} target record(s) for ${decision.action}`);
      } else {
        logger?.warn?.(
          `${TAG} VectorStore delete failed for ${decision.action} after ${REPLACED_DELETE_RETRY_DELAYS_MS.length + 1} attempts, ` +
          `[${replacedIds.join(",")}] remain beside ${record.id}: ${describeError(deleteError)}`,
        );
      }
    } else {
      logger?.warn?.(
        `${TAG} Keeping [${replacedIds.join(",")}] for ${decision.action}: replacement ${record.id} is not in the vector store`,
      );
    }
  }

  if (jsonlFailed && !vectorStored) {
    const reasons = [`jsonl: ${describeError(jsonlError)}`];
    if (vectorStore) reasons.push(`vector: ${describeError(vectorError)}`);
    throw new L1PersistenceError(
      `writeMemory: no persistence target stored record ${record.id} (${reasons.join("; ")})`,
      { cause: jsonlError },
    );
  }

  return record;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================
// Helpers
// ============================

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}