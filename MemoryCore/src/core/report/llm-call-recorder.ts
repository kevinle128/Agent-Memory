/**
 * LLM call log: one decorator around the LLM runner records failed calls of
 * every stage, and successful calls of stages that ask for it. The decorator
 * never changes what the call returns or throws; a failure to record is logged
 * and ignored. One switch (`llmCallLog.enabled`) turns all recording off.
 */

import { randomUUID } from "node:crypto";

import type { LlmCallHints, LLMRunner, LLMRunParams, Logger } from "../types.js";
import { classifyLlmError, redactSecrets, type ClassifiedLlmError } from "./llm-error-classifier.js";
import {
  LLM_CALL_REPLY_MAX_BYTES,
  truncateUtf8,
  type LlmCallRecord,
  type LlmCallStore,
} from "./llm-call-types.js";

export interface LlmCallLogConfig {
  /** Master switch. When false nothing is recorded or pruned. */
  enabled: boolean;
  /** Stages whose successful calls are recorded too (besides calls that ask for it). */
  recordSuccessStages: string[];
  /** Characters of the provider response body kept in a failure record. */
  bodyExcerptBytes: number;
  /** Records older than this are deleted. */
  retentionDays: number;
}

export const DEFAULT_LLM_CALL_LOG_CONFIG: LlmCallLogConfig = {
  enabled: true,
  recordSuccessStages: [],
  bodyExcerptBytes: 1_024,
  retentionDays: 30,
};

const STORE_TIMEOUT_MS = 3_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 2_048;
const lastPruneByStore = new WeakMap<object, number>();

export interface LlmCallRecorderOptions {
  config: LlmCallLogConfig;
  /** Store of the instance the call belongs to; resolved at call time. */
  getStore: () => LlmCallStore | undefined | Promise<LlmCallStore | undefined>;
  getInstanceId: () => string | undefined;
  logger?: Pick<Logger, "warn" | "debug">;
}

function tagValue(tags: string[] | undefined, prefix: string): string {
  const hit = tags?.find((t) => t.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

export class LlmCallRecordingRunner implements LLMRunner {
  private warnedNoStore = false;

  constructor(private readonly inner: LLMRunner, private readonly opts: LlmCallRecorderOptions) {}

  get modelName(): string | undefined {
    return this.inner.modelName;
  }

  /** Token usage of the last call, for wrappers that read it from the inner runner. */
  get lastUsage(): unknown {
    return (this.inner as { lastUsage?: unknown }).lastUsage;
  }

  async run(params: LLMRunParams): Promise<string> {
    if (!this.opts.config.enabled) return this.inner.run(params);
    const startedMs = Date.now();
    let text: string;
    try {
      text = await this.inner.run(params);
    } catch (err) {
      // Recording must never replace or hide the original error.
      let classified: ClassifiedLlmError;
      try {
        classified = classifyLlmError(err, Date.now() - startedMs, params.timeoutMs ?? 0, {
          excerptChars: this.opts.config.bodyExcerptBytes,
        });
      } catch {
        classified = {
          kind: "unknown", errorClass: "", httpStatus: 0, providerErrorType: "", providerErrorCode: "",
          retryAfterMs: 0, sdkAttempts: 0, responseExcerpt: "", message: "The error could not be read",
        };
      }
      await this.record(params, startedMs, "error", classified, "", undefined);
      throw err;
    }
    try {
      const hints = params.llmCall;
      let annotation: ReturnType<NonNullable<LlmCallHints["annotate"]>>;
      try {
        annotation = hints?.annotate?.(text);
      } catch (err) {
        this.opts.logger?.warn(`[llm-call-log] annotate failed for ${params.taskId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const unusable = annotation?.errorKind;
      const wanted = unusable || hints?.recordSuccess || this.opts.config.recordSuccessStages.includes(params.taskId);
      if (wanted) {
        const classified: ClassifiedLlmError | undefined = unusable
          ? {
              kind: unusable, errorClass: "", httpStatus: 0, providerErrorType: "", providerErrorCode: "",
              retryAfterMs: 0, sdkAttempts: 0, responseExcerpt: "",
              message: redactSecrets(annotation?.errorMessage ?? (unusable === "empty_reply" ? "The reply is empty" : "The reply is not usable")).slice(0, MAX_MESSAGE_CHARS),
            }
          : undefined;
        await this.record(params, startedMs, unusable ? "error" : "ok", classified, text, annotation?.verdict);
      }
    } catch (err) {
      this.opts.logger?.warn(`[llm-call-log] could not record ${params.taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return text;
  }

  private async record(
    params: LLMRunParams,
    startedMs: number,
    outcome: "ok" | "error",
    failure: ClassifiedLlmError | undefined,
    reply: string,
    verdict: unknown,
  ): Promise<void> {
    // One cap covers the whole record (store lookup and insert), so a slow
    // store adds at most STORE_TIMEOUT_MS to the call.
    try {
      await withTimeout(this.writeRecord(params, startedMs, outcome, failure, reply, verdict), STORE_TIMEOUT_MS);
    } catch (err) {
      this.opts.logger?.warn(`[llm-call-log] could not record ${params.taskId} (outcome=${outcome}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async writeRecord(
    params: LLMRunParams,
    startedMs: number,
    outcome: "ok" | "error",
    failure: ClassifiedLlmError | undefined,
    reply: string,
    verdict: unknown,
  ): Promise<void> {
    {
      const store = await this.opts.getStore();
      if (!store?.insertLlmCall) {
        if (!this.warnedNoStore) {
          this.warnedNoStore = true;
          this.opts.logger?.warn("[llm-call-log] the store cannot keep LLM call records; failures are only logged");
        }
        return;
      }
      const hints = params.llmCall;
      const finishedMs = Date.now();
      const kept = truncateUtf8(reply, LLM_CALL_REPLY_MAX_BYTES);
      const record: LlmCallRecord = {
        id: `llmc_${randomUUID().replace(/-/g, "")}`,
        instance_id: params.instanceId ?? this.opts.getInstanceId() ?? "",
        created_at_ms: startedMs,
        finished_at_ms: finishedMs,
        latency_ms: finishedMs - startedMs,
        stage: params.taskId,
        trace_name: params.traceName ?? "",
        model: this.inner.modelName ?? "",
        team_id: hints?.teamId ?? tagValue(params.tags, "team:"),
        agent_id: hints?.agentId ?? tagValue(params.tags, "agent:"),
        user_id: params.userId ?? "",
        session_id: params.sessionId ?? "",
        project_hash: hints?.projectHash ?? tagValue(params.tags, "project:"),
        generation_id: hints?.generationId ?? "",
        outcome,
        timeout_ms: params.timeoutMs ?? 0,
        prompt_chars: (params.prompt?.length ?? 0) + (params.systemPrompt?.length ?? 0),
        error_kind: failure?.kind ?? "",
        error_class: failure?.errorClass ?? "",
        http_status: failure?.httpStatus ?? 0,
        provider_error_type: failure?.providerErrorType ?? "",
        provider_error_code: failure?.providerErrorCode ?? "",
        retry_after_ms: failure?.retryAfterMs ?? 0,
        sdk_attempts: failure?.sdkAttempts ?? 0,
        error_message: failure?.message ?? "",
        response_excerpt: failure?.responseExcerpt ?? "",
        verdict: verdict === undefined ? "" : JSON.stringify(verdict),
        reply: kept.text,
        reply_truncated: kept.truncated,
      };
      await store.insertLlmCall(record);
      try {
        hints?.onRecorded?.(record.id);
      } catch { /* a caller callback must not undo a stored record */ }
      this.pruneIfDue(store, finishedMs);
    }
  }

  /** Delete expired records, at most once an hour per store. */
  private pruneIfDue(store: LlmCallStore, nowMs: number): void {
    if (!store.pruneLlmCalls) return;
    const last = lastPruneByStore.get(store) ?? 0;
    if (nowMs - last < PRUNE_INTERVAL_MS) return;
    lastPruneByStore.set(store, nowMs);
    const cutoff = nowMs - this.opts.config.retentionDays * 24 * 60 * 60 * 1000;
    void Promise.resolve()
      .then(() => store.pruneLlmCalls!(cutoff))
      .catch((err) => this.opts.logger?.warn(`[llm-call-log] retention failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}
