/**
 * L1 Conflict Detection Prompt (Batch Mode)
 *
 * Based on Kenty's validated prototype prompt (l1_conflict_detection_prompt.md).
 * Batch-compares multiple new memories against a unified candidate pool,
 * supporting cross-type merge and multi-target operations.
 */

import type { MemoryPromptMode } from "../../config.js";
import type { MemoryRecord, ExtractedMemory } from "../record/l1-writer.js";

// ============================
// System Prompt
// ============================

export const CONFLICT_DETECTION_SYSTEM_PROMPT = `You are a memory conflict detector. Compare multiple [New Memories] in a batch against the existing memories in the [Unified Candidate Memory Pool], and decide how to handle each one.

**Output language**: Write \`merged_content\` in the same language as the existing memories in the candidate pool (for example, if the existing memories are in Chinese, write the merged content in Chinese). Keep JSON field names, enum values, record_id, and ISO timestamps in English.

## Core Rules

- **Cross-type merge**: memories of different types (persona / episodic / instruction / work_fact / work_task / work_method / work_artifact) **may be merged** if they semantically describe the same fact or event.
- **Many-to-many merge**: one new memory may replace or merge **several** existing memories in the candidate pool at once (specified through the target_ids array).
- After merging, you must decide the best type for the result (merged_type).

## Decision Logic

1. **Tell the nature of the memory**:
   - **State type** (persona/instruction): preferences, traits, long-term settings, relatively stable facts, behavior rules
   - **Event type** (episodic): one-time experiences and time-stamped objective records; merging the cause and effect of the same event is recommended

2. **Decide whether it is the same fact or event**: same subject, consistent topic, close in time, similar scene_name

3. **Choose an action**:
   - "store": treat it as new information and add the current memory.
   - "skip": the existing memory is better, and the new memory adds nothing or is vaguer; ignore the current memory.
   - "update": the same fact or event, and the new memory is better in content or time (more specific, later, or a correction); let the new memory take the lead and overwrite the old memory, and keep the details of the old memory that are still correct.
   - "merge": the same fact or the same evolution process, and several memories complement each other without contradiction; merge them into one more complete memory with as little redundancy as possible.

4. **Strategy tendency**:
   - State type: several memories describe the same preference or trait -> lean to merge; no increment -> skip; clear update -> update
   - Event type: cause and effect or different stages of the same event -> lean to merge into one complete narrative; fully identical -> skip
   - Cross-type example: an episodic "The user started making podcasts in 2018" + a persona "The user has podcast production experience" -> can be merged into one persona or episodic memory (depending on where the information leans)

5. **Timestamp handling**:
   - On merge / update, merged_timestamps should contain the **union of the timestamps of all related memories** (de-duplicated and sorted)
   - This keeps the complete timeline of when the event happened

## Output Format

Output a strict JSON array, where each element is the decision for one new memory. Output nothing else:

[
  {
    "record_id": "record_id of the new memory",
    "action": "store|update|skip|merge",
    "target_ids": ["record_id 1 of the candidate memory to delete", "record_id 2"],
    "merged_content": "The merged / updated memory content (required for merge/update)",
    "merged_type": "The best type after merging: persona|episodic|instruction|work_fact|work_task|work_method|work_artifact (required for merge/update)",
    "merged_priority": 85,
    "merged_timestamps": ["The merged timestamp array, the union of the timestamps of all new and old memories (required for merge/update)"]
  }
]

Field notes:
- target_ids: an **array** of IDs of the old memories to delete and replace (one or several). Omit it or leave it empty for store/skip.
- merged_content: the final memory text for merge/update. Omit it for store/skip.
- merged_type: the type the memory belongs to after merge/update. Decide it by the nature of the merged content.
- merged_priority: the new priority after merge/update (an integer from 0 to 100, required for merge/update). Merged information is more complete and more certain, so you should usually **raise** the priority as appropriate (for example, two memories with priority 70 can be raised to 80 after merging). Reference scale: 80-100 (core traits / important events), 60-79 (ordinary preferences / ordinary activities), <60 (minor information).
- merged_timestamps: the merged timestamp array. Collect the timestamps of the new memory and all merged old memories, de-duplicated and sorted.`;

export const WORK_CONFLICT_DETECTION_SYSTEM_PROMPT = `You are a team work memory conflict detector. Compare multiple [New Memories] in a batch against the existing memories in the [Unified Candidate Memory Pool], and decide how to handle each one.

**Output language**: Write \`merged_content\` in the same language as the existing memories in the candidate pool (for example, if the existing memories are in Chinese, write the merged content in Chinese). Keep JSON field names, enum values, record_id, and ISO timestamps in English.

## Core Rules

- **Cross-type merge**: memories of different types (work_fact / work_task / work_method / work_artifact) **may be merged** if they semantically describe the same work object, task, method, or asset.
- **Many-to-many merge**: one new memory may replace or merge **several** existing memories in the candidate pool at once (specified through the target_ids array).
- After merging, you must decide the best type for the result (merged_type).
- Memories are shared within the project team by default, so the merged content should keep only work-related information.

## Decision Logic

1. **Tell the nature of the memory**:
   - **Work fact (work_fact)**: project facts, requirements, decisions, status, risks, constraints, experiment results, customer feedback.
   - **Work task (work_task)**: to-dos, owner, deadline, next-step plans, task status changes.
   - **Work method (work_method)**: SOPs, taboos, principles, experience, design thinking, judgment criteria, Agent behavior rules.
   - **Work artifact (work_artifact)**: documents, PRs, Issues, Prompts, reports, code branches, design drafts, links, and so on.

2. **Decide whether it is the same work object or evolution process**:
   - Same project, module, requirement, task, risk, decision, method, or asset, and the scene_name or the meaning is highly similar.
   - Different stages of the same task, additions to the same method, and changes in the version or purpose of the same asset can usually be merged.
   - Items that only belong to the same large project but discuss different objects should not be merged by force.

3. **Choose an action**:
   - "store": treat it as new information and add the current memory.
   - "skip": the existing memory is better, and the new memory adds nothing or is vaguer; ignore the current memory.
   - "update": the same work object, and the new memory is more specific, newer, more authoritative, or corrects the old information; let the new memory take the lead and overwrite the old memory, and keep the details of the old memory that are still correct.
   - "merge": the same work object or the same evolution process, and the new and old memories complement each other without contradiction; merge them into one more complete memory with as little redundancy as possible.

4. **Strategy tendency**:
   - work_fact: an addition to or correction of the same fact / decision / status -> lean to update or merge.
   - work_task: a change in the owner, deadline, or status of the same task -> lean to update; an added dependency or acceptance criterion -> lean to merge.
   - work_method: an addition to the same SOP, taboo, principle, or experience -> lean to merge; a clearer and more general wording -> lean to update.
   - work_artifact: an addition to the purpose, version, or link of the same document, PR, Prompt, report, or other asset -> lean to merge or update.
   - Cross-type example: a work_fact "The team decided that L1 types stay as a few high-level categories" + a work_method "L1 types should not be too fine, or L2/L3 aggregation suffers" -> can be merged into a work_method.

5. **Timestamp handling**:
   - On merge / update, merged_timestamps should contain the **union of the timestamps of all related memories** (de-duplicated and sorted).
   - This keeps the complete timeline of how the work fact, task, or method evolved.

## Output Format

Output a strict JSON array, where each element is the decision for one new memory. Output nothing else:

[
  {
    "record_id": "record_id of the new memory",
    "action": "store|update|skip|merge",
    "target_ids": ["record_id 1 of the candidate memory to delete", "record_id 2"],
    "merged_content": "The merged / updated memory content (required for merge/update)",
    "merged_type": "The best type after merging: work_fact|work_task|work_method|work_artifact (required for merge/update)",
    "merged_priority": 85,
    "merged_timestamps": ["The merged timestamp array, the union of the timestamps of all new and old memories (required for merge/update)"]
  }
]

Field notes:
- target_ids: an **array** of IDs of the old memories to delete and replace (one or several). Omit it or leave it empty for store/skip.
- merged_content: the final memory text for merge/update. Omit it for store/skip.
- merged_type: the type the memory belongs to after merge/update. Decide it by the nature of the merged content.
- merged_priority: the new priority after merge/update (an integer from 0 to 100, required for merge/update). Merged information is more complete and more certain, so you should usually **raise** the priority as appropriate. Reference scale: 80-100 (key facts / important tasks / core methods / important assets), 60-79 (ordinary work information), <60 (minor information).
- merged_timestamps: the merged timestamp array. Collect the timestamps of the new memory and all merged old memories, de-duplicated and sorted.`;

export function getConflictDetectionSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? WORK_CONFLICT_DETECTION_SYSTEM_PROMPT : CONFLICT_DETECTION_SYSTEM_PROMPT;
}

// ============================
// Prompt Builder
// ============================

/**
 * Candidate search result for a single new memory.
 */
export interface CandidateMatch {
  newMemory: ExtractedMemory & { record_id: string };
  candidates: MemoryRecord[];
}

/**
 * Format the batch conflict detection prompt using a unified candidate pool.
 *
 * Format (aligned with prototype):
 * 1. Unified candidate pool: de-duplicated list of all existing candidates across all new memories
 * 2. Per new memory: content + list of related candidate IDs from the pool
 *
 * This approach lets the LLM see the global picture and handle cross-memory dedup in one pass.
 *
 * @param matches - Array of new memories with their candidate matches
 */
export function formatBatchConflictPrompt(matches: CandidateMatch[]): string {
  // Step 1: Build unified candidate pool (de-duplicate across all new memories)
  const unifiedPool = new Map<string, MemoryRecord>();
  const perMemoryCandidateIds = new Map<string, string[]>();

  for (const m of matches) {
    const candidateIds: string[] = [];
    for (const c of m.candidates) {
      if (!unifiedPool.has(c.id)) {
        unifiedPool.set(c.id, c);
      }
      candidateIds.push(c.id);
    }
    perMemoryCandidateIds.set(m.newMemory.record_id, candidateIds);
  }

  // Step 2: Format unified pool as JSON
  const poolList = Array.from(unifiedPool.values()).map((c) => ({
    record_id: c.id,
    content: c.content,
    type: c.type,
    priority: c.priority,
    scene_name: c.scene_name,
    timestamps: c.timestamps,
  }));

  let poolSection: string;
  if (poolList.length === 0) {
    poolSection = "## Unified Candidate Memory Pool\n\n(Empty: there are no existing memories, so store all new memories directly)";
  } else {
    const poolStr = JSON.stringify(poolList, null, 2);
    poolSection = `## Unified Candidate Memory Pool (${poolList.length} existing memories in total)\n\n${poolStr}`;
  }

  // Step 3: Format each new memory with its related candidate IDs
  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote =
      relatedIds.length > 0
        ? JSON.stringify(relatedIds)
        : "[] (no similar candidates; store directly)";

    const memStr = JSON.stringify(
      {
        record_id: m.newMemory.record_id,
        content: m.newMemory.content,
        type: m.newMemory.type,
        priority: m.newMemory.priority,
        scene_name: m.newMemory.scene_name,
      },
      null,
      2,
    );

    return `### New Memory #${idx + 1} (record_id: ${m.newMemory.record_id})\n${memStr}\n\n[Related Candidate IDs] ${relatedNote}`;
  });

  const newMemoriesText = memoryParts.join(
    "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n",
  );

  // Step 4: Assemble final prompt
  return `**Output language**: Write \`merged_content\` in the same language as the existing memories in the candidate pool.

${poolSection}

${"═".repeat(50)}

## New Memories to Judge (${matches.length} in total)

${newMemoriesText}

Judge them one by one and output the decision JSON array. When the candidate list of a new memory is empty, output action=store for it directly.`;
}
