/**
 * Types and store contract for skill change proposals.
 *
 * A proposal records a change that the system wants to make to a skill but
 * that needs a person to approve first. It never creates a skill version by
 * itself: only `SkillChangeService` turns an approved proposal into a version.
 */

import type { SkillResourcePayload } from "./skill-resource-store.js";

export type SkillProposalStatus = "pending" | "approved" | "rejected" | "stale" | "expired";

/** Files part of a proposed change, in the same shape the update payload uses. */
export interface SkillProposalFiles {
  write: SkillResourcePayload[];
  remove: string[];
}

export interface SkillChangeProposal {
  proposal_id: string;
  team_id: string;
  owner_agent_id: string;
  skill_id: string;
  skill_name: string;
  /** Head version the proposal was written against. */
  base_version: number;
  /** Full proposed SKILL.md, including frontmatter. */
  proposed_content: string;
  proposed_description: string;
  proposed_files: SkillProposalFiles;
  change_reason: string;
  /** 1-5 short strings that tell a reviewer what the change brings. */
  change_summary: string[];
  source_session_id: string;
  /** User id of the writer that made the proposal. */
  created_by: string;
  status: SkillProposalStatus;
  created_at_ms: number;
  /** 0 while the proposal is pending. */
  decided_at_ms: number;
  decided_by: string;
  /** Version created by the approval. 0 when none. */
  result_version: number;
}

export interface ListProposalsOptions {
  team_id?: string;
  owner_agent_id?: string;
  skill_id?: string;
  status?: SkillProposalStatus[];
  /** Only proposals created before this epoch ms. */
  created_before_ms?: number;
  limit?: number;
  offset?: number;
}

export interface ProposalTransitionPatch {
  status: SkillProposalStatus;
  decided_at_ms: number;
  decided_by: string;
  result_version: number;
}

/**
 * Persistence of proposals. Every `ISkillStore` backend implements it, next to
 * the version rows, so one backend choice covers both.
 */
export interface ISkillProposalStore {
  insertProposal(proposal: SkillChangeProposal): Promise<void>;
  getProposal(proposalId: string, teamId?: string): Promise<SkillChangeProposal | null>;
  /** Newest first. */
  listProposals(opts: ListProposalsOptions): Promise<{ items: SkillChangeProposal[]; total: number }>;
  /**
   * Compare-and-set on status: write `patch` only if the stored status is one
   * of `from`. Returns the updated proposal, or null when the proposal does not
   * exist or its status is not in `from` (another writer decided first).
   */
  transitionProposal(
    proposalId: string,
    from: SkillProposalStatus[],
    patch: ProposalTransitionPatch,
  ): Promise<SkillChangeProposal | null>;
}
