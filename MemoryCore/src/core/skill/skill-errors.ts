/**
 * Error type of the skill core. It lives in its own module so that
 * `SkillChangeService` and `SkillCore` can both throw it without importing
 * each other. `skill-core.ts` re-exports everything here.
 */

import type { SkillChangeProposal } from "./skill-proposal-types.js";

export type SkillCoreErrorCode =
  | "INVALID_FRONTMATTER"
  | "SKILL_FRONTMATTER_INVALID"
  | "SKILL_PATCH_NOT_UNIQUE"
  | "SKILL_NAME_DUPLICATE"
  // Name is used by a skill of another scope or project (see the store error of the same name).
  | "SKILL_NAME_SCOPE_CONFLICT"
  | "SKILL_NOT_OWNER"
  | "SKILL_TEAM_MISMATCH"
  | "SKILL_NOT_FOUND"
  | "SKILL_VERSION_STALE"
  | "SKILL_VERSION_EXPIRED"
  | "SKILL_ID_COLLISION"
  | "INVALID_PATH"
  | "RESOURCE_TOO_LARGE"
  | "STORAGE_NOT_FOUND"
  | "LLM_UNAVAILABLE"
  | "SKILL_COS_REQUIRED"
  | "SKILL_EXPORT_TOO_LARGE"
  // A project skill needs a valid project hash; in code mode an extracted skill must be a project skill.
  | "SKILL_PROJECT_REQUIRED"
  // Reason or summary missing or out of range, or a change that makes no sense (rollback to head).
  | "SKILL_CHANGE_INVALID"
  // The change was turned into a pending proposal instead of a new version.
  | "SKILL_APPROVAL_REQUIRED"
  | "SKILL_PROPOSAL_NOT_FOUND"
  // The proposal is not in a state that allows the requested decision.
  | "SKILL_PROPOSAL_STATE_INVALID";

export class SkillCoreError extends Error {
  constructor(public readonly code: SkillCoreErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "SkillCoreError";
  }
}

/**
 * Thrown by the legacy `SkillCore` write methods (which return a `Skill`) when
 * the approval policy turned the change into a proposal. Callers that can
 * express "proposed" catch it; any other caller sees a failure, never a
 * silent success with an unchanged skill.
 */
export class SkillApprovalRequiredError extends SkillCoreError {
  constructor(public readonly proposal: SkillChangeProposal) {
    super("SKILL_APPROVAL_REQUIRED", `change waits for approval as proposal ${proposal.proposal_id}`);
    this.name = "SkillApprovalRequiredError";
  }
}
