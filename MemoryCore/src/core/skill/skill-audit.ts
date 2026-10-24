/**
 * Shared helpers for the scope and audit columns of a skill version row.
 *
 * Each store backend maps rows its own way, but the defaults and the
 * parsing rules must be the same on every backend. They live here.
 */

import type {
  AppendVersionAudit,
  SkillChangeSource,
  SkillOrigin,
  SkillPlacement,
  SkillScope,
  SkillVersionAudit,
} from "./types.js";

/** `project_hash` is the first 16 hex characters of a digest, in lower case. */
const PROJECT_HASH_RE = /^[0-9a-f]{16}$/;

export const MAX_CHANGE_SUMMARY_ITEMS = 5;
export const MAX_CHANGE_SUMMARY_ITEM_CHARS = 200;

export function isValidProjectHash(value: unknown): value is string {
  return typeof value === "string" && PROJECT_HASH_RE.test(value);
}

/**
 * Placement for a new version row.
 *
 * A writer that names a scope sets the whole placement. A writer that names
 * none (a caller that predates scope) keeps the placement of the current head,
 * so an old code path can never move a project skill to global by accident.
 * With no head and no scope the row gets the migration defaults.
 */
export function placementFor(input: AppendVersionAudit, head?: SkillPlacement | null): SkillPlacement {
  const scope: SkillScope = input.scope ?? head?.scope ?? "global";
  const fromInput = input.scope !== undefined;
  const project = scope === "project";
  return {
    scope,
    // Project fields only mean something for a project skill.
    project_key: project ? (fromInput ? input.project_key : head?.project_key) ?? "" : "",
    project_hash: project ? (fromInput ? input.project_hash : head?.project_hash) ?? "" : "",
    project_name: project ? (fromInput ? input.project_name : head?.project_name) ?? "" : "",
    origin: input.origin ?? head?.origin ?? "extracted",
    source_session_id: input.source_session_id ?? "",
  };
}

export function auditFor(input: AppendVersionAudit): SkillVersionAudit {
  return {
    change_source: input.change_source ?? "",
    change_reason: input.change_reason ?? "",
    change_summary: normalizeChangeSummary(input.change_summary),
    approved_by: input.approved_by ?? "",
    approved_at_ms: input.approved_at_ms ?? 0,
    base_version: input.base_version ?? 0,
    proposal_id: input.proposal_id ?? "",
  };
}

/** Trim, drop empty items, cap the count and the length of each item. */
export function normalizeChangeSummary(items: readonly string[] | undefined): string[] {
  if (!items) return [];
  return items
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s.length > 0)
    .slice(0, MAX_CHANGE_SUMMARY_ITEMS)
    .map((s) => s.slice(0, MAX_CHANGE_SUMMARY_ITEM_CHARS));
}

/** Read a stored summary (JSON text) back. A damaged value reads as empty, never throws. */
export function parseChangeSummary(raw: unknown): string[] {
  if (Array.isArray(raw)) return normalizeChangeSummary(raw as string[]);
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeChangeSummary(parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function serializeChangeSummary(items: readonly string[]): string {
  return JSON.stringify(items);
}

const SCOPES: ReadonlySet<string> = new Set(["global", "project"]);
const ORIGINS: ReadonlySet<string> = new Set(["extracted", "manual", "template"]);
const SOURCES: ReadonlySet<string> = new Set(["extracted", "manual", "rollback", "promotion", "template"]);

/**
 * Turn raw stored values into typed ones. A value outside the known set
 * (damaged row, newer writer) reads as the migration default.
 */
export function readPlacement(raw: {
  scope?: unknown;
  project_key?: unknown;
  project_hash?: unknown;
  project_name?: unknown;
  origin?: unknown;
  source_session_id?: unknown;
}): SkillPlacement {
  const scope: SkillScope = typeof raw.scope === "string" && SCOPES.has(raw.scope) ? (raw.scope as SkillScope) : "global";
  const origin: SkillOrigin =
    typeof raw.origin === "string" && ORIGINS.has(raw.origin) ? (raw.origin as SkillOrigin) : "extracted";
  return {
    scope,
    project_key: String(raw.project_key ?? ""),
    project_hash: String(raw.project_hash ?? ""),
    project_name: String(raw.project_name ?? ""),
    origin,
    source_session_id: String(raw.source_session_id ?? ""),
  };
}

export function readAudit(raw: {
  change_source?: unknown;
  change_reason?: unknown;
  change_summary?: unknown;
  approved_by?: unknown;
  approved_at_ms?: unknown;
  base_version?: unknown;
  proposal_id?: unknown;
}): SkillVersionAudit {
  const source = typeof raw.change_source === "string" && SOURCES.has(raw.change_source)
    ? (raw.change_source as SkillChangeSource)
    : "";
  return {
    change_source: source,
    change_reason: String(raw.change_reason ?? ""),
    change_summary: parseChangeSummary(raw.change_summary),
    approved_by: String(raw.approved_by ?? ""),
    approved_at_ms: Number(raw.approved_at_ms ?? 0) || 0,
    base_version: Number(raw.base_version ?? 0) || 0,
    proposal_id: String(raw.proposal_id ?? ""),
  };
}
