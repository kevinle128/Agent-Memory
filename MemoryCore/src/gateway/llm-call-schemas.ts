import { z } from "zod";

import { PROJECT_HASH_PATTERN } from "../core/storage/project-paths.js";

const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

const rangeRefine = (value: { start_time?: string; end_time?: string }, ctx: z.RefinementCtx) => {
  if (value.start_time && value.end_time) {
    const start = Date.parse(value.start_time);
    const end = Date.parse(value.end_time);
    if (start > end) ctx.addIssue({ code: "custom", path: ["start_time"], message: "start_time must not be after end_time" });
    if (end - start > MAX_RANGE_MS) ctx.addIssue({ code: "custom", path: ["end_time"], message: "time range must not exceed 90 days" });
  }
};

const ERROR_KINDS = [
  "timeout", "aborted", "rate_limit", "quota_exhausted", "overloaded", "server_error", "network", "auth",
  "context_too_long", "bad_request", "empty_reply", "unparseable", "unknown",
] as const;

export const llmCallListSchema = z.strictObject({
  stage: z.string().trim().min(1).max(128).optional(),
  outcome: z.enum(["ok", "error"]).optional(),
  error_kind: z.enum(ERROR_KINDS).optional(),
  team_id: z.string().trim().min(1).max(256).optional(),
  agent_id: z.string().trim().min(1).max(256).optional(),
  generation_id: z.string().trim().min(1).max(128).optional(),
  start_time: z.string().datetime({ offset: true }).optional(),
  end_time: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
}).superRefine(rangeRefine);

export const llmCallStatsSchema = z.strictObject({
  group_by: z.enum(["error_kind", "http_status", "provider_error_code", "stage", "model", "day", "outcome"]).default("error_kind"),
  stage: z.string().trim().min(1).max(128).optional(),
  team_id: z.string().trim().min(1).max(256).optional(),
  agent_id: z.string().trim().min(1).max(256).optional(),
  start_time: z.string().datetime({ offset: true }).optional(),
  end_time: z.string().datetime({ offset: true }).optional(),
}).superRefine(rangeRefine);

export const personaRegenerateSchema = z.strictObject({
  team_id: z.string().trim().min(1).max(256),
  agent_id: z.string().trim().min(1).max(256),
  user_id: z.string().trim().min(1).max(256).optional(),
  project_hash: z.string().regex(PROJECT_HASH_PATTERN, "project_hash must be 16 lowercase hex characters").optional(),
  reason: z.string().trim().min(1).max(200),
  /** How long the call waits for the run. The run itself is not cancelled when the wait ends. */
  timeout_ms: z.number().int().min(1_000).max(900_000).default(300_000),
});

export const MAX_LIST_RANGE_MS = MAX_RANGE_MS;
