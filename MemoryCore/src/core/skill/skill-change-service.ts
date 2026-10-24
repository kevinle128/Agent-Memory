/**
 * SkillChangeService — the single place where the content of a skill changes.
 *
 * Every write path (create, update, patch, files, rollback, promotion,
 * template marking, approval of a proposal) ends in `submit` or in
 * `approveProposal`. No other code appends a skill version; the architecture
 * test `skill-change-architecture.test.ts` enforces that.
 *
 * What the service owns:
 *   - the scope rule (project skills need a valid project hash; in `code`
 *     mode an extracted skill is created as a project skill only);
 *   - the audit values of each version (source, reason, summary, approver);
 *   - the approval decision, taken by a `ChangeApprovalPolicy`;
 *   - the life cycle of proposals (pending -> approved | rejected | stale | expired).
 *
 * It does not check who the caller is. Ownership and ACL checks stay with the
 * caller (`SkillCore`, the gateway handlers).
 */

import type { MemoryPromptMode } from "../../config.js";
import { randomBase62 } from "../../utils/short-id.js";
import { createHash } from "node:crypto";
import {
  DefaultChangeApprovalPolicy,
  type ApprovalDecision,
  type ChangeApprovalPolicy,
  type SkillChangeKind,
} from "./change-approval-policy.js";
import { isValidProjectHash, normalizeChangeSummary } from "./skill-audit.js";
import { diffLines } from "./skill-diff.js";
import { SkillCoreError } from "./skill-errors.js";
import type {
  ISkillProposalStore,
  ListProposalsOptions,
  SkillChangeProposal,
  SkillProposalStatus,
} from "./skill-proposal-types.js";
import type { ISkillStore } from "./skill-store.interface.js";
import type { AppendVersionContext, AppendVersionMutation, SkillVersioning } from "./skill-versioning.js";
import type { AppendVersionAudit, Skill, SkillChangeSource, SkillOrigin, SkillScope } from "./types.js";

const TAG = "[skill-change]";

const DEFAULT_PROPOSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** An approval claim without a result after this long is treated as a crashed apply. */
const STUCK_APPROVAL_MS = 5 * 60 * 1000;
/** The lazy sweep runs at most this often per process. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/** Longest change reason that is stored; longer text is cut. */
const MAX_REASON_CHARS = 1000;

/** Prefix of a summary item that the system wrote, not a person or the extractor. */
export const AUTO_SUMMARY_PREFIX = "(auto) ";

// ═════════════════════════════════════════════════════════════════════
//  Input and result types
// ═════════════════════════════════════════════════════════════════════

/** Content of the new version, in the shape `SkillVersioning` takes. */
export type ChangeMutation = Pick<
  AppendVersionMutation,
  "content" | "name" | "description" | "resourcesToWrite" | "resourcesToRemove" | "metadata_json"
>;

/** Where a new skill lives. Used by `create` only; other kinds keep the placement of the head. */
export interface ChangePlacement {
  scope?: SkillScope;
  project_key?: string;
  project_hash?: string;
  project_name?: string;
  origin?: SkillOrigin;
}

export interface SkillChange {
  kind: SkillChangeKind;
  skill_id: string;
  /** Who writes: ids that are stored on the version row. */
  actor: AppendVersionContext;
  /** Current head of the skill. Null only for `create`. */
  head: Skill | null;
  mutation: ChangeMutation;
  source: SkillChangeSource;
  reason?: string;
  /** 1-5 short strings: what the change adds, fixes or removes. */
  summary?: string[];
  /** Person who made or approved the change. Defaults to `actor.user_id` for changes a person makes. */
  approved_by?: string;
  source_session_id?: string;
  /** Placement of a new skill. */
  placement?: ChangePlacement;
  /** Older version to restore (kind `rollback`). */
  restore_from?: Skill;
}

export type SubmitResult =
  | { outcome: "applied"; skill: Skill }
  | { outcome: "pending_approval"; skill: Skill; proposal: SkillChangeProposal };

export type ApproveResult =
  | { status: "approved"; proposal: SkillChangeProposal; skill: Skill }
  /** The skill moved on since the proposal was made; nothing was applied. */
  | { status: "stale"; proposal: SkillChangeProposal; current_version: number };

export interface SkillChangeServiceOptions {
  store: ISkillStore;
  versioning: SkillVersioning;
  policy?: ChangeApprovalPolicy;
  /** Prompt mode of the instance. Read on each call, so a live config change takes effect. */
  getPromptMode?: () => MemoryPromptMode;
  /** Old-version cleanup after a change, same knobs as `SkillCore`. 0 = off. */
  versionTtlSeconds?: number;
  maxNonHeadVersions?: number;
  now?: () => number;
  proposalId?: () => string;
  /** Pending proposals older than this are expired by the sweep. Default 30 days; 0 = never. */
  proposalTtlMs?: number;
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

// ═════════════════════════════════════════════════════════════════════
//  Proposal state machine
// ═════════════════════════════════════════════════════════════════════

/**
 * Allowed moves. `stale` can only be rejected: the change was written against
 * a version that no longer exists, so it must not be applied by any later click.
 */
const PROPOSAL_TRANSITIONS: Record<SkillProposalStatus, readonly SkillProposalStatus[]> = {
  pending: ["approved", "rejected", "stale", "expired"],
  stale: ["rejected"],
  // approved -> stale is allowed only to repair a claim whose apply never finished
  // (see repairStuckApprovals); a finished approval has result_version > 0.
  approved: ["stale"],
  rejected: [],
  expired: [],
};

export function canTransitionProposal(from: SkillProposalStatus, to: SkillProposalStatus): boolean {
  return PROPOSAL_TRANSITIONS[from].includes(to);
}

function assertProposalTransition(proposal: SkillChangeProposal, to: SkillProposalStatus): void {
  if (!canTransitionProposal(proposal.status, to)) {
    throw new SkillCoreError(
      "SKILL_PROPOSAL_STATE_INVALID",
      `proposal ${proposal.proposal_id} is ${proposal.status}; it cannot become ${to}`,
    );
  }
}

// ═════════════════════════════════════════════════════════════════════
//  Service
// ═════════════════════════════════════════════════════════════════════

export class SkillChangeService {
  private readonly store: ISkillStore;
  private readonly proposals: ISkillProposalStore;
  private readonly versioning: SkillVersioning;
  private readonly policy: ChangeApprovalPolicy;
  private readonly getPromptMode: () => MemoryPromptMode;
  private readonly versionTtlSeconds: number;
  private readonly maxNonHeadVersions: number;
  private readonly now: () => number;
  private readonly newProposalId: () => string;
  private readonly proposalTtlMs: number;
  private lastSweepMs = 0;
  private readonly logger?: SkillChangeServiceOptions["logger"];

  constructor(opts: SkillChangeServiceOptions) {
    this.store = opts.store;
    this.proposals = opts.store;
    this.versioning = opts.versioning;
    this.policy = opts.policy ?? new DefaultChangeApprovalPolicy();
    this.getPromptMode = opts.getPromptMode ?? (() => "chat");
    this.versionTtlSeconds = opts.versionTtlSeconds ?? 0;
    this.maxNonHeadVersions = opts.maxNonHeadVersions ?? 0;
    this.now = opts.now ?? (() => Date.now());
    this.newProposalId = opts.proposalId ?? (() => `prp-${randomBase62(12)}`);
    this.proposalTtlMs = opts.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS;
    this.logger = opts.logger;
  }

  // ───────────────────────────────────────────────────────────────────
  //  submit
  // ───────────────────────────────────────────────────────────────────

  async submit(change: SkillChange): Promise<SubmitResult> {
    const mode = this.getPromptMode();
    const head = change.head;
    if (change.kind !== "create" && !head) {
      throw new SkillCoreError("SKILL_NOT_FOUND", `change '${change.kind}' needs an existing skill`);
    }
    if (change.kind === "create" && head) {
      throw new SkillCoreError("SKILL_CHANGE_INVALID", "create must not carry a head");
    }

    const placement = this.resolvePlacement(change);
    this.assertScopeRule(change, placement, mode);
    const text = this.prepareChangeText(change, mode);

    // A change that alters nothing is not a version and not a proposal.
    if (head && this.altersNothing(change, head)) {
      return { outcome: "applied", skill: head };
    }

    const decision: ApprovalDecision = this.policy.decide(
      { kind: change.kind, source: change.source },
      head,
      mode,
    );

    if (decision === "require_approval") {
      if (!head) {
        throw new SkillCoreError("SKILL_CHANGE_INVALID", "a new skill cannot wait for approval");
      }
      const proposal = await this.createProposal(change, head, text);
      this.logger?.info(`${TAG} proposal ${proposal.proposal_id} for ${head.skill_id} v${head.version} (${change.source})`);
      return { outcome: "pending_approval", skill: head, proposal };
    }

    const approver = this.approverOf(change);
    const skill = await this.apply({
      change,
      placement,
      text,
      approved_by: approver,
      base_version: head?.version ?? 0,
      proposal_id: "",
    });
    return { outcome: "applied", skill };
  }

  /** Make a global skill from a project skill. A person does this; the content stays the same. */
  promote(head: Skill, actor: AppendVersionContext, reason?: string): Promise<SubmitResult> {
    if (head.scope === "global") {
      throw new SkillCoreError("SKILL_CHANGE_INVALID", `skill ${head.skill_id} is already global`);
    }
    return this.submit({
      kind: "promotion",
      skill_id: head.skill_id,
      actor,
      head,
      mutation: sameContentAs(head),
      source: "promotion",
      reason: reason ?? "Promoted to a global skill",
      placement: { scope: "global", origin: "manual" },
    });
  }

  /** Mark a skill as a template: global, origin `template`. The content stays the same. */
  markTemplate(head: Skill, actor: AppendVersionContext, reason?: string): Promise<SubmitResult> {
    return this.submit({
      kind: "template",
      skill_id: head.skill_id,
      actor,
      head,
      mutation: sameContentAs(head),
      source: "template",
      reason: reason ?? "Marked as a template skill",
      placement: { scope: "global", origin: "template" },
    });
  }

  // ───────────────────────────────────────────────────────────────────
  //  proposals
  // ───────────────────────────────────────────────────────────────────

  getProposal(proposalId: string, teamId?: string): Promise<SkillChangeProposal | null> {
    return this.proposals.getProposal(proposalId, teamId);
  }

  async listProposals(opts: ListProposalsOptions): Promise<{ items: SkillChangeProposal[]; total: number }> {
    await this.sweepIfDue();
    return this.proposals.listProposals(opts);
  }

  /**
   * Housekeeping that has no timer of its own: no periodic scanner exists for
   * skills, so it runs on the next touch of the proposals, at most once a minute.
   * It repairs stuck approvals and expires old pending proposals. Never throws.
   */
  private async sweepIfDue(): Promise<void> {
    const now = this.now();
    if (now - this.lastSweepMs < SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = now;
    try {
      await this.repairStuckApprovals();
      if (this.proposalTtlMs > 0) await this.expirePending(now - this.proposalTtlMs);
    } catch (err) {
      this.logger?.warn(`${TAG} proposal sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * An `approved` proposal with `result_version` 0 means the claim happened but the
   * apply (or its bookkeeping) did not finish. Treat it as stale: nobody can
   * approve it again, and a person can still reject it.
   */
  async repairStuckApprovals(): Promise<number> {
    const cutoff = this.now() - STUCK_APPROVAL_MS;
    const { items } = await this.proposals.listProposals({ status: ["approved"], limit: 1000 });
    let repaired = 0;
    for (const p of items) {
      if (p.result_version !== 0 || p.decided_at_ms >= cutoff) continue;
      const r = await this.proposals.transitionProposal(p.proposal_id, ["approved"], {
        status: "stale", decided_at_ms: this.now(), decided_by: "", result_version: 0,
      });
      if (r) repaired++;
    }
    return repaired;
  }

  /** Mark pending proposals of a skill as stale, except those based on `keepBaseVersion`. */
  private async staleSiblings(skillId: string, teamId: string, keepBaseVersion?: number): Promise<void> {
    const { items } = await this.proposals.listProposals({ team_id: teamId, skill_id: skillId, status: ["pending"], limit: 1000 });
    for (const p of items) {
      if (keepBaseVersion !== undefined && p.base_version === keepBaseVersion) continue;
      await this.proposals.transitionProposal(p.proposal_id, ["pending"], {
        status: "stale", decided_at_ms: this.now(), decided_by: "", result_version: 0,
      });
    }
  }

  /**
   * Approve a proposal and apply it in the same call.
   *
   * The proposal is claimed first (pending -> approved) so that two approvals
   * cannot both create a version. If the head is no longer the version the
   * proposal was written against, the proposal becomes `stale` and nothing is
   * applied. If the apply itself fails, the claim is undone.
   */
  async approveProposal(input: { proposal_id: string; team_id?: string; approver: string }): Promise<ApproveResult> {
    await this.sweepIfDue();
    const found = await this.requireProposal(input.proposal_id, input.team_id);
    assertProposalTransition(found, "approved");

    const claimed = await this.proposals.transitionProposal(found.proposal_id, ["pending"], {
      status: "approved",
      decided_at_ms: this.now(),
      decided_by: input.approver,
      result_version: 0,
    });
    if (!claimed) {
      // Another writer decided between our read and the claim.
      const now = await this.requireProposal(found.proposal_id, input.team_id);
      assertProposalTransition(now, "approved");
      throw new SkillCoreError("SKILL_PROPOSAL_STATE_INVALID", `proposal ${found.proposal_id} was decided by another request`);
    }

    const head = await this.store.getHead(claimed.skill_id, claimed.team_id);
    if (!head || head.version !== claimed.base_version) {
      const stale = await this.proposals.transitionProposal(claimed.proposal_id, ["approved"], {
        status: "stale",
        decided_at_ms: this.now(),
        decided_by: "",
        result_version: 0,
      });
      this.logger?.info(
        `${TAG} proposal ${claimed.proposal_id} is stale: base v${claimed.base_version}, head ${head ? `v${head.version}` : "gone"}`,
      );
      return { status: "stale", proposal: stale ?? { ...claimed, status: "stale" }, current_version: head?.version ?? 0 };
    }

    try {
      const approvedAt = this.now();
      const skill = await this.apply({
        change: {
          kind: "update",
          skill_id: head.skill_id,
          actor: { team_id: head.team_id, agent_id: head.owner_agent_id, user_id: input.approver },
          head,
          mutation: {
            content: claimed.proposed_content,
            name: claimed.skill_name,
            description: claimed.proposed_description,
            resourcesToWrite: claimed.proposed_files.write,
            resourcesToRemove: claimed.proposed_files.remove,
          },
          source: "extracted",
          source_session_id: claimed.source_session_id,
        },
        // The head keeps its placement; only the content changes.
        placement: {},
        text: { reason: claimed.change_reason, summary: claimed.change_summary },
        approved_by: input.approver,
        approved_at_ms: approvedAt,
        base_version: claimed.base_version,
        proposal_id: claimed.proposal_id,
      });

      const done = await this.proposals.transitionProposal(claimed.proposal_id, ["approved"], {
        status: "approved",
        decided_at_ms: claimed.decided_at_ms,
        decided_by: input.approver,
        result_version: skill.version,
      });
      if (!done) {
        this.logger?.warn(`${TAG} proposal ${claimed.proposal_id}: version v${skill.version} written but result_version not recorded`);
      }
      return { status: "approved", proposal: done ?? { ...claimed, result_version: skill.version }, skill };
    } catch (err) {
      // The head moved between our check and the write: the proposal is stale, not retryable.
      // Any other failure puts the proposal back to pending so it can be approved after the cause is fixed.
      const conflict = (err as { code?: string }).code === "SKILL_VERSION_STALE";
      await this.proposals
        .transitionProposal(claimed.proposal_id, ["approved"], {
          status: conflict ? "stale" : "pending",
          decided_at_ms: conflict ? this.now() : 0,
          decided_by: "",
          result_version: 0,
        })
        .catch((undoErr) => {
          this.logger?.error(
            `${TAG} proposal ${claimed.proposal_id}: apply failed and claim undo failed: ` +
              (undoErr instanceof Error ? undoErr.message : String(undoErr)),
          );
        });
      if (conflict) {
        const now = await this.store.getHead(claimed.skill_id, claimed.team_id).catch(() => null);
        const proposal = (await this.proposals.getProposal(claimed.proposal_id)) ?? { ...claimed, status: "stale" as const };
        return { status: "stale", proposal, current_version: now?.version ?? 0 };
      }
      throw err;
    }
  }

  /** Reject a pending or stale proposal. */
  async rejectProposal(input: { proposal_id: string; team_id?: string; decided_by: string }): Promise<SkillChangeProposal> {
    await this.sweepIfDue();
    const found = await this.requireProposal(input.proposal_id, input.team_id);
    assertProposalTransition(found, "rejected");
    const rejected = await this.proposals.transitionProposal(found.proposal_id, ["pending", "stale"], {
      status: "rejected",
      decided_at_ms: this.now(),
      decided_by: input.decided_by,
      result_version: 0,
    });
    if (!rejected) {
      throw new SkillCoreError("SKILL_PROPOSAL_STATE_INVALID", `proposal ${found.proposal_id} was decided by another request`);
    }
    return rejected;
  }

  /** Mark pending proposals older than `olderThanMs` as expired. Returns how many changed. */
  async expirePending(olderThanMs: number): Promise<number> {
    const { items } = await this.proposals.listProposals({
      status: ["pending"],
      created_before_ms: olderThanMs,
      limit: 1000,
    });
    let expired = 0;
    for (const p of items) {
      const r = await this.proposals.transitionProposal(p.proposal_id, ["pending"], {
        status: "expired",
        decided_at_ms: this.now(),
        decided_by: "",
        result_version: 0,
      });
      if (r) expired++;
    }
    return expired;
  }

  // ───────────────────────────────────────────────────────────────────
  //  internals
  // ───────────────────────────────────────────────────────────────────

  private async requireProposal(proposalId: string, teamId?: string): Promise<SkillChangeProposal> {
    const p = await this.proposals.getProposal(proposalId, teamId);
    if (!p) throw new SkillCoreError("SKILL_PROPOSAL_NOT_FOUND", `proposal ${proposalId} not found`);
    return p;
  }

  /** Placement the new version row will carry. */
  private resolvePlacement(change: SkillChange): ChangePlacement {
    switch (change.kind) {
      case "create": {
        const p = change.placement ?? {};
        return {
          scope: p.scope ?? "global",
          project_key: p.project_key ?? "",
          project_hash: p.project_hash ?? "",
          project_name: p.project_name ?? "",
          origin: p.origin ?? originOf(change.source),
        };
      }
      case "promotion":
        return { scope: "global", origin: change.placement?.origin ?? "manual" };
      case "template":
        return { scope: "global", origin: "template" };
      default:
        // Content changes keep the placement of the head; the store inherits it.
        return {};
    }
  }

  /**
   * Scope rule. Checked in Core because a prompt cannot enforce it.
   *   - a project skill needs a valid project hash, in every mode;
   *   - in `code` mode a new extracted skill must be a project skill.
   * Rows written before scope existed (global, origin extracted) are not
   * checked again when they are edited: only a create sets the origin.
   */
  private assertScopeRule(change: SkillChange, placement: ChangePlacement, mode: MemoryPromptMode): void {
    if (change.kind === "create" || change.kind === "promotion" || change.kind === "template") {
      if (placement.scope === "project" && !isValidProjectHash(placement.project_hash)) {
        throw new SkillCoreError(
          "SKILL_PROJECT_REQUIRED",
          "a project skill needs project_hash of 16 lowercase hex characters",
        );
      }
    }
    if (change.kind === "create" && mode === "code" && placement.origin === "extracted" && placement.scope !== "project") {
      throw new SkillCoreError(
        "SKILL_PROJECT_REQUIRED",
        "an extracted skill must be a project skill: no verified project for this change",
      );
    }
  }

  /** Reason and summary of the change, validated and with defaults filled in. */
  private prepareChangeText(change: SkillChange, mode: MemoryPromptMode): { reason: string; summary: string[] } {
    const reason = (change.reason ?? "").trim().slice(0, MAX_REASON_CHARS);
    const given = normalizeChangeSummary(change.summary);

    if (change.source === "rollback" && reason === "") {
      throw new SkillCoreError("SKILL_CHANGE_INVALID", "a rollback needs a reason");
    }
    // The extractor must say why and what. Chat mode keeps the earlier behavior and does not ask.
    if (change.source === "extracted" && mode === "code") {
      if (reason === "") {
        throw new SkillCoreError("SKILL_CHANGE_INVALID", "an extracted change needs a reason");
      }
      if (given.length === 0) {
        throw new SkillCoreError("SKILL_CHANGE_INVALID", "an extracted change needs a summary of 1-5 short items");
      }
    }

    switch (change.source) {
      case "rollback":
        return { reason, summary: [`Restored content of v${change.restore_from?.version ?? "?"}`] };
      case "promotion":
        return { reason, summary: ["Promoted to a global skill"] };
      case "template":
        return { reason, summary: ["Marked as a template skill"] };
      case "manual":
        return { reason, summary: given.length > 0 ? given : this.autoSummary(change) };
      default:
        return { reason, summary: given };
    }
  }

  /** Short description of a manual change that came without a summary. Marked so a reader can tell. */
  private autoSummary(change: SkillChange): string[] {
    const items: string[] = [];
    if (!change.head) {
      items.push("Created skill");
    } else {
      const d = diffLines(change.head.content, change.mutation.content);
      if (d.added > 0 || d.removed > 0) items.push(`SKILL.md changed: +${d.added} / -${d.removed} lines`);
    }
    const written = change.mutation.resourcesToWrite?.length ?? 0;
    const removed = change.mutation.resourcesToRemove?.length ?? 0;
    if (written > 0) items.push(`Wrote ${written} file(s)`);
    if (removed > 0) items.push(`Removed ${removed} file(s)`);
    if (items.length === 0) items.push("Updated skill");
    return items.map((i) => `${AUTO_SUMMARY_PREFIX}${i}`);
  }

  private altersNothing(change: SkillChange, head: Skill): boolean {
    if (change.kind !== "update" && change.kind !== "files") return false;
    const noFileChange =
      (change.mutation.resourcesToWrite?.length ?? 0) === 0 && (change.mutation.resourcesToRemove?.length ?? 0) === 0;
    return noFileChange && md5(change.mutation.content) === head.content_hash;
  }

  /** Person on the version row. Empty when the system applied a project change on its own. */
  private approverOf(change: SkillChange): string {
    if (change.source === "extracted") return "";
    return change.approved_by ?? change.actor.user_id ?? "";
  }

  private async createProposal(
    change: SkillChange,
    head: Skill,
    text: { reason: string; summary: string[] },
  ): Promise<SkillChangeProposal> {
    const proposal: SkillChangeProposal = {
      proposal_id: this.newProposalId(),
      team_id: head.team_id,
      owner_agent_id: head.owner_agent_id,
      skill_id: head.skill_id,
      skill_name: head.name,
      base_version: head.version,
      proposed_content: change.mutation.content,
      proposed_description: change.mutation.description,
      proposed_files: {
        write: change.mutation.resourcesToWrite ?? [],
        remove: change.mutation.resourcesToRemove ?? [],
      },
      change_reason: text.reason,
      change_summary: text.summary,
      source_session_id: change.source_session_id ?? "",
      created_by: change.actor.user_id ?? "",
      status: "pending",
      created_at_ms: this.now(),
      decided_at_ms: 0,
      decided_by: "",
      result_version: 0,
    };
    // One pending proposal per skill: an older one was written against a view the newer one replaces.
    await this.staleSiblings(head.skill_id, head.team_id);
    await this.proposals.insertProposal(proposal);
    return proposal;
  }

  /** The only call site of the version writers. */
  private async apply(p: {
    change: SkillChange;
    placement: ChangePlacement;
    text: { reason: string; summary: string[] };
    approved_by: string;
    approved_at_ms?: number;
    base_version: number;
    proposal_id: string;
  }): Promise<Skill> {
    const { change, placement, text } = p;
    const audit: AppendVersionAudit = {
      ...placement,
      source_session_id: change.source_session_id ?? "",
      change_source: change.source,
      change_reason: text.reason,
      change_summary: text.summary,
      approved_by: p.approved_by,
      approved_at_ms: p.approved_by ? (p.approved_at_ms ?? this.now()) : 0,
      base_version: p.base_version,
      proposal_id: p.proposal_id,
    };
    const ctx: AppendVersionContext = {
      ...change.actor,
      team_id: change.actor.team_id ?? change.head?.team_id,
      audit,
    };

    if (change.kind === "create") {
      return this.versioning.createNewSkill(
        change.skill_id,
        change.actor.agent_id ?? "default",
        ctx,
        change.mutation,
      );
    }

    const head = change.head!;
    const skill = await this.versioning.appendNextVersion(head, ctx, {
      ...change.mutation,
      // A restore, a promotion and a template mark are worth a version even when the text is the same.
      ...(change.kind === "rollback" ? { restoreFrom: change.restore_from } : {}),
      ...(change.kind === "rollback" || change.kind === "promotion" || change.kind === "template"
        ? { forceNewVersion: true }
        : {}),
    });
    void this.versioning
      .cleanupExpiredVersionsForSkill(head.skill_id, this.versionTtlSeconds, this.maxNonHeadVersions)
      .catch(() => { /* fire-and-forget */ });
    // The head moved: pending proposals written against an older head can no longer apply.
    if (skill.version !== head.version) {
      await this.staleSiblings(skill.skill_id, skill.team_id, skill.version).catch((err) => {
        this.logger?.warn(`${TAG} could not mark sibling proposals stale: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return skill;
  }
}

// ═════════════════════════════════════════════════════════════════════
//  helpers
// ═════════════════════════════════════════════════════════════════════

function originOf(source: SkillChangeSource): SkillOrigin {
  if (source === "extracted") return "extracted";
  if (source === "template") return "template";
  return "manual";
}

function md5(text: string): string {
  return createHash("md5").update(text, "utf-8").digest("hex");
}

/** Mutation that keeps the content of `head` as it is. */
function sameContentAs(head: Skill): ChangeMutation {
  return { content: head.content, name: head.name, description: head.description };
}
