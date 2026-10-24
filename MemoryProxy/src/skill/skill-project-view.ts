/**
 * Project view of the skill library for one session.
 *
 * A session sees the global skills and the skills of its own project, never the
 * skills of another project. The project comes from the workspace the client
 * hook reported, never from the model. A session without a known project sees
 * global skills only.
 */

import { resolveProfileScopeMode } from "../tdai/profile-scope-mode.js";
import { isProjectAnswer } from "../tdai/project-echo.js";

/** Fields that select the view in a Core skill request. */
export type SkillViewFields =
  | { project_hash: string }
  | { scope_filter: "global_only" };

/**
 * True when skills are filtered by project. "legacy" keeps the earlier catalog
 * of all skills (chat mode); "scoped" and "deny" both filter, because "deny"
 * must never widen the view.
 */
export function isSkillProjectViewOn(profileScopeMode: unknown): boolean {
  return resolveProfileScopeMode(profileScopeMode) !== "legacy";
}

/** Core request fields for the view of a session with `projectHash` (or none). */
export function skillViewFields(projectHash: string | undefined): SkillViewFields {
  return projectHash ? { project_hash: projectHash } : { scope_filter: "global_only" };
}

/**
 * True when a Core answer was filtered for the requested view. Core echoes
 * `project_hash` (project view) or `scope_filter` (global-only view). A Core
 * that does not know the fields ignores them and answers with every skill, so
 * an answer without the echo must never be shown to the model.
 */
export function isSkillViewAnswer(data: unknown, projectHash: string | undefined): boolean {
  if (projectHash) return isProjectAnswer(data, projectHash);
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return record.scope_filter === "global_only";
}

/** Cache id part of the skill catalog; `none` is the session without a known project. */
export function skillCatalogVariant(projectHash: string | undefined): string {
  return `skill-scoped:v1:${projectHash ?? "none"}`;
}

const LIST_SUBPATHS = new Set(["listing", "list", "search"]);
const DETAIL_SUBPATHS = new Set(["get", "get-by-name", "raw"]);
/** Answers that carry no skill record; they are accepted only with the echo of the view. */
const ECHO_SUBPATHS = new Set(["versions", "files/read"]);
const EMPTY_LISTING = "<available_skills>\n(none)\n</available_skills>";

function notFoundEnvelope(): string {
  return JSON.stringify({ code: 40401, message: "SKILL_NOT_FOUND", request_id: `bridge-${Date.now()}` });
}

function okEnvelope(data: unknown): string {
  return JSON.stringify({ code: 0, message: "ok", request_id: `bridge-${Date.now()}`, data });
}

/**
 * Defence in depth on a Core answer that goes to the model. Core filters by the
 * view; the proxy checks the result, because an old Core ignores the view:
 *  - a list answer without the echo is replaced by an empty one;
 *  - a skill detail of another project is replaced by "not found".
 * Anything else passes through unchanged.
 */
export function guardSkillResponse(sub: string, respText: string, projectHash: string | undefined): string {
  const isList = LIST_SUBPATHS.has(sub);
  const needsEcho = ECHO_SUBPATHS.has(sub);
  if (!isList && !needsEcho && !DETAIL_SUBPATHS.has(sub)) return respText;
  let env: { code?: number; data?: unknown };
  try {
    env = JSON.parse(respText) as { code?: number; data?: unknown };
  } catch {
    return respText;
  }
  if (env.code !== 0) return respText;
  if (isList) {
    if (isSkillViewAnswer(env.data, projectHash)) return respText;
    if (sub === "listing") return okEnvelope({ mode: "full", listing: EMPTY_LISTING, hits: [], candidates: [] });
    return okEnvelope(sub === "list" ? { items: [], total: 0 } : { items: [] });
  }
  if (needsEcho) return isSkillViewAnswer(env.data, projectHash) ? respText : notFoundEnvelope();
  const skill = env.data && typeof env.data === "object" ? (env.data as Record<string, unknown>) : {};
  if (!isSkillVisibleInView(skill, projectHash ? { project_hash: projectHash } : { scope_filter: "global_only" })) {
    return notFoundEnvelope();
  }
  return respText;
}

/** Project hash of a view; undefined for the global-only view. */
export function viewProjectHash(view: SkillViewFields): string | undefined {
  return "project_hash" in view ? view.project_hash : undefined;
}

/** True when a skill detail may be shown for the view: global, or of the project of the view. */
export function isSkillVisibleInView(skill: { scope?: unknown; project_hash?: unknown }, view: SkillViewFields): boolean {
  return skill.scope !== "project" || skill.project_hash === viewProjectHash(view);
}
