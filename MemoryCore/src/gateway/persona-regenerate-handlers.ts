/**
 * POST /v3/persona/regenerate: run one L3 pass by hand, with a backup.
 *
 * It uses the service-token auth of the other management routes. The instance
 * is the one named by the token's `x-tdai-service-id`.
 */

import { randomUUID } from "node:crypto";
import type { ZodError } from "zod";

import { errorEnvelope, successEnvelope } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import { personaRegenerateSchema } from "./llm-call-schemas.js";
import { buildAgentPipelineLockKey } from "../services/pipeline-worker.js";
import { newGenerationId } from "../core/memory-generation-log/store.js";
import type { MemoryGenerationScopeCheck } from "../core/memory-generation-log/types.js";
import type { L3GenerationReport, L3JevExecutionContext } from "../core/persona/jev-gate.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { StorageAdapter } from "../core/storage/adapter.js";

type RouteHandler = (body: unknown, auth: V2AuthContext, requestId: string, deps: unknown) => Promise<ApiResponseEnvelope>;

interface Warnable {
  warn(msg: string): void;
  error(msg: string): void;
}

export interface PersonaRegenerateDeps {
  getStore?: () => IMemoryStore | undefined;
  getStorage?: () => StorageAdapter | undefined;
  logger?: Warnable;
  /** Cross-node lock backend; absent in a single process. */
  stateBackend?: {
    acquireLock(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
    releaseLock(key: string, ownerId: string): Promise<unknown>;
  };
  /** Runs one L3 pass for the agent. Throws when the pass fails. */
  runPersonaRegeneration?: (input: {
    instanceId: string;
    store: IMemoryStore;
    storage: StorageAdapter;
    context: L3JevExecutionContext;
  }) => Promise<void>;
  /** False when the instance has no credit left. */
  checkCreditAllowed?: (instanceId: string) => Promise<boolean>;
}

function formatZodErr(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
}

// ── regenerate ──────────────────────────────────────────────

/** Runs in this process, by lock key. Covers a node without a cross-node lock backend. */
const activeRegenerations = new Map<string, { generationId: string; startedAtMs: number }>();

/** Longest a run may hold the cross-node lock. A run ends well before it: two generations and two checks. */
const REGENERATION_LOCK_TTL_MS = 30 * 60 * 1000;

export type PersonaRegenerationOutcome =
  | "pass"
  | "leaks"
  | "technical_failure"
  | "generated"
  | "unchanged"
  | "skipped"
  | "failed";

function describeOutcome(report: L3GenerationReport | undefined, error: string | undefined): {
  outcome: PersonaRegenerationOutcome;
  scope_check?: MemoryGenerationScopeCheck;
  leaks: string[];
  persona_kept: boolean;
  skipped_reason?: string;
} {
  if (!report) return { outcome: "failed", leaks: [], persona_kept: false };
  const sc = report.scopeCheck;
  const leaks = sc?.leaks ?? [];
  switch (report.outcome) {
    case "judge_failed":
      return { outcome: "technical_failure", scope_check: sc, leaks, persona_kept: true };
    case "failed":
      return { outcome: "failed", scope_check: sc, leaks, persona_kept: false };
    case "skipped":
      return { outcome: "skipped", leaks, persona_kept: true, skipped_reason: report.skippedReason };
    case "unchanged":
      return { outcome: "unchanged", scope_check: sc, leaks, persona_kept: true };
    default:
      if (sc?.result === "rejected") return { outcome: "leaks", scope_check: sc, leaks, persona_kept: false };
      if (sc?.result === "passed") return { outcome: "pass", scope_check: sc, leaks, persona_kept: false };
      return { outcome: error ? "failed" : "generated", scope_check: sc, leaks, persona_kept: false };
  }
}

async function handleRegenerate(body: unknown, auth: V2AuthContext, requestId: string, rawDeps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = personaRegenerateSchema.safeParse(body ?? {});
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const q = parsed.data;
  const deps = rawDeps as PersonaRegenerateDeps;
  const store = deps.getStore?.();
  const storage = deps.getStorage?.();
  if (!store || !storage || !deps.runPersonaRegeneration) return errorEnvelope(503, "Persona regeneration is not available", requestId);

  const instanceId = auth.serviceId;
  if (deps.checkCreditAllowed && !(await deps.checkCreditAllowed(instanceId))) {
    return errorEnvelope(429, "Credit limit exceeded", requestId);
  }

  // The scheduled L2/L3 task of an agent takes the same key, so the two never
  // write the agent's profile at once. A project run takes it too: it shares
  // the agent's checkpoint and storage.
  const lockKey = buildAgentPipelineLockKey(instanceId, q.team_id, q.agent_id);
  const generationId = newGenerationId();
  const running = activeRegenerations.get(lockKey);
  if (running) {
    return errorEnvelope(409, `PERSONA_REGENERATION_BUSY: generation ${running.generationId} is running for this agent`, requestId);
  }
  activeRegenerations.set(lockKey, { generationId, startedAtMs: Date.now() });
  const lockOwner = `persona-regenerate-${randomUUID()}`;
  let heldRemotely = false;
  const release = async (): Promise<void> => {
    activeRegenerations.delete(lockKey);
    if (heldRemotely) {
      try {
        await deps.stateBackend!.releaseLock(lockKey, lockOwner);
      } catch (err) {
        deps.logger?.warn(`[persona-regenerate] could not release lock ${lockKey}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  if (deps.stateBackend) {
    try {
      heldRemotely = await deps.stateBackend.acquireLock(lockKey, lockOwner, REGENERATION_LOCK_TTL_MS);
    } catch (err) {
      activeRegenerations.delete(lockKey);
      deps.logger?.error(`[persona-regenerate] lock backend failed: ${err instanceof Error ? err.message : String(err)}`);
      return errorEnvelope(503, "Lock backend unavailable", requestId);
    }
    if (!heldRemotely) {
      activeRegenerations.delete(lockKey);
      return errorEnvelope(409, "PERSONA_REGENERATION_BUSY: another L2/L3 task holds this agent", requestId);
    }
  }

  const reports: L3GenerationReport[] = [];
  let backupKey: string | null | undefined;
  const context: L3JevExecutionContext = {
    teamId: q.team_id,
    agentId: q.agent_id,
    userId: q.user_id,
    forceRegenerate: { reason: q.reason, projectHash: q.project_hash, generationId },
    onGenerationSettled: (r) => reports.push(r),
    onBackupMade: (key) => { backupKey = key; },
  };
  const startedAtMs = Date.now();
  const run = deps.runPersonaRegeneration({ instanceId, store, storage, context })
    .then(() => ({ error: undefined as string | undefined }), (err: unknown) => ({
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    }))
    .finally(release);

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), q.timeout_ms); });
  const settled = await Promise.race([run, timedOut]);
  if (timer) clearTimeout(timer);

  const target = q.project_hash ? "project" : "user-global";
  const base = {
    scope: target,
    ...(q.project_hash ? { project_hash: q.project_hash } : {}),
    generation_id: generationId,
    backup_key: backupKey ?? null,
    lookup: { path: "/v3/llm-call/list", generation_id: generationId },
  };
  if (settled === "timeout") {
    return successEnvelope({ ...base, status: "running", elapsed_ms: Date.now() - startedAtMs }, requestId);
  }
  const report = reports.find((r) => r.scope === target && (r.projectHash ?? undefined) === q.project_hash);
  const described = describeOutcome(report, settled.error);
  let judgeRecordIds = report?.scopeCheck?.judge_record_ids ?? [];
  if (judgeRecordIds.length === 0 && store.listLlmCalls) {
    // A failed run has no report summary; the LLM call log still holds its calls.
    try {
      const rows = await store.listLlmCalls({
        instanceId, stage: "persona-scope-check", generationId,
        startTimeMs: startedAtMs - 1_000, endTimeMs: Date.now() + 1_000, limit: 50,
      });
      judgeRecordIds = rows.map((r) => r.id).reverse();
    } catch { /* the lookup is a convenience; the list route answers the same question */ }
  }
  return successEnvelope({
    ...base,
    status: "completed",
    ...described,
    judge_record_ids: judgeRecordIds,
    elapsed_ms: Date.now() - startedAtMs,
    ...(settled.error ? { error_message: settled.error } : {}),
  }, requestId);
}

export function makePersonaRegenerateRouteTable(): Record<string, RouteHandler> {
  return {
    "/v3/persona/regenerate": handleRegenerate,
  };
}

/** For tests: forget runs that are marked active. */
export function resetActivePersonaRegenerationsForTest(): void {
  activeRegenerations.clear();
}
