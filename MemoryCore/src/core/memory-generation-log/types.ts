import { createHash } from "node:crypto";
import type { MemoryPromptSource } from "../memory-prompt/types.js";

export type MemoryGenerationLayer = "l1" | "l2" | "l3";
export type MemoryGenerationStatus = "succeeded" | "failed";

export interface MemoryGenerationRef {
  layer: "l0" | MemoryGenerationLayer;
  record_id: string;
}

export interface MemoryGenerationPromptRef {
  memory_prompt_id: string;
  version: number;
  source: MemoryPromptSource;
  prompt_sha256: string;
}

export interface MemoryGenerationLog {
  schema_version: 1;
  log_id: string;
  generation_id: string;
  instance_id: string;
  layer: MemoryGenerationLayer;
  status: MemoryGenerationStatus;
  team_id?: string;
  agent_id?: string;
  user_id?: string;
  session_id?: string;
  task_id?: string;
  prompt: MemoryGenerationPromptRef;
  anchor_memory_id?: string;
  input_refs: MemoryGenerationRef[];
  output_refs: MemoryGenerationRef[];
  model?: string;
  prompt_mode?: string;
  /** Set for the L3 document of one project; absent for user-global generations. */
  variant?: "project";
  started_at_ms: number;
  finished_at_ms: number;
  latency_ms: number;
  error_code?: string;
  error_message?: string;
  /** Result of the user-global scope check of an L3 run; absent for other runs. */
  scope_check?: MemoryGenerationScopeCheck;
}

export interface MemoryGenerationScopeCheck {
  /** passed: accepted marker; rejected: project facts found twice; judge_failed: no verdict, previous persona kept. */
  result: "passed" | "rejected" | "judge_failed";
  /** Specific cause when the judge call failed (see LlmErrorKind). */
  error_kind?: string;
  /** Failure reason of the last check, for example judge-leaks or judge-timeout. */
  reason?: string;
  /** First leaks the last check found, each cut to a short length. */
  leaks?: string[];
  /** Judge calls made in the whole run. */
  judge_attempts: number;
  /** Ids of the llm_calls records of this run. */
  judge_record_ids: string[];
}

export interface MemoryGenerationProvenance {
  generation_id: string;
  generation_log_id: string;
  generation_log_key: string;
  memory_prompt_id: string;
  memory_prompt_version: number;
  memory_prompt_source: MemoryPromptSource;
}

export interface MemoryGenerationLogListFilter {
  layer?: MemoryGenerationLayer;
  status?: MemoryGenerationStatus;
  startTimeMs: number;
  endTimeMs: number;
  limit: number;
  cursor?: string;
}

export interface MemoryGenerationLogListItem {
  log_id: string;
  layer: MemoryGenerationLayer;
  status: MemoryGenerationStatus;
  anchor_memory_id?: string;
  finished_at_ms: number;
  size: number;
  key: string;
}

export interface MemoryGenerationRefRecord extends MemoryGenerationProvenance {
  generation_ref_id: string;
  layer: MemoryGenerationLayer;
  memory_id: string;
  created_at_ms: number;
}

export interface MemoryGenerationRefStore {
  upsertMemoryGenerationRefs?(records: MemoryGenerationRefRecord[]): Promise<void> | void;
  getMemoryGenerationRef?(
    layer: MemoryGenerationLayer,
    memoryId: string,
  ): Promise<MemoryGenerationRefRecord | null> | MemoryGenerationRefRecord | null;
}

export function buildMemoryGenerationRefId(layer: MemoryGenerationLayer, memoryId: string): string {
  const digest = createHash("sha256").update(memoryId).digest("hex").slice(0, 40);
  return `mgr:${layer}:${digest}`;
}
