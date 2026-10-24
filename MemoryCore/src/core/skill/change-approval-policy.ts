/**
 * ChangeApprovalPolicy — decides whether a skill change takes effect at once
 * or waits for a person to approve it.
 *
 * The rule is a strategy so it can change in one place. `SkillChangeService`
 * asks the policy; no other code looks at scope, source or mode to decide.
 */

import type { MemoryPromptMode } from "../../config.js";
import type { Skill, SkillChangeSource } from "./types.js";

export type SkillChangeKind = "create" | "update" | "files" | "rollback" | "promotion" | "template";

export type ApprovalDecision = "apply" | "require_approval";

/** What the policy needs to know about a change. */
export interface ChangeFacts {
  kind: SkillChangeKind;
  source: SkillChangeSource;
}

export interface ChangeApprovalPolicy {
  /**
   * @param change  facts about the requested change
   * @param skill   current head of the skill, or null for a new skill
   * @param mode    prompt mode of the instance
   */
  decide(change: ChangeFacts, skill: Skill | null, mode: MemoryPromptMode): ApprovalDecision;
}

/**
 * Default rule:
 *   - `chat` mode keeps the earlier behavior: every change applies.
 *   - A new skill applies: it replaces nothing. Where it may live is checked
 *     by the scope rule of the service, not here.
 *   - A change to a project skill applies.
 *   - A change that the system proposes to a global skill waits for approval.
 *   - A change a person makes (manual edit, rollback, promotion, template
 *     marking) applies; that person is the approver.
 */
export class DefaultChangeApprovalPolicy implements ChangeApprovalPolicy {
  decide(change: ChangeFacts, skill: Skill | null, mode: MemoryPromptMode): ApprovalDecision {
    if (mode === "chat") return "apply";
    if (change.kind === "create" || skill === null) return "apply";
    if (skill.scope === "project") return "apply";
    return change.source === "extracted" ? "require_approval" : "apply";
  }
}
