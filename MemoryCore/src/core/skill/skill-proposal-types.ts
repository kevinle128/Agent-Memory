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

/**
 * One tool call of the extraction run that made a proposal, in call order.
 * The input and output are short previews, not the full text.
 */
export interface SkillProposalToolCall {
  name: string;
  input: string;
  /** Absent for the call that made the proposal: it had not returned yet. */
  output?: string;
}

/** Most tool calls stored on one proposal. Older calls are dropped first. */
export const MAX_PROPOSAL_TOOL_CALLS = 30;
/** Longest preview of a tool input or output. */
export const MAX_TOOL_CALL_PREVIEW_CHARS = 300;

/**
 * Tool calls from a stored value: a JSON string (SQL and VDB backends) or an
 * array (document backends). A damaged value reads as no tool calls.
 */
export function readToolCalls(value: unknown): SkillProposalToolCall[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  const calls: SkillProposalToolCall[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.name !== "string") continue;
    calls.push({
      name: c.name,
      input: typeof c.input === "string" ? c.input : "",
      ...(typeof c.output === "string" ? { output: c.output } : {}),
    });
  }
  return calls;
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
  /** Tool calls of the extraction run up to the call that made the proposal. Empty for older proposals. */
  tool_calls?: SkillProposalToolCall[];
  /** Why the person approved or rejected. Empty when no reason was given. */
  decision_reason?: string;
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
  /** Absent keeps the stored reason. */
  decision_reason?: string;
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
