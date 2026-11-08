/**
 * Based on Kenty's validated prototype prompt (l1_memory_extraction_prompt.md).
 * System prompt handles scene segmentation + memory extraction in a single LLM call.
 * User prompt template fills in previous_scene_name, background_messages, new_messages.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";

// ============================
// System Prompt
// ============================

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `You are an expert in scene segmentation and memory extraction.
Your task is to analyze the user's conversation, detect scene changes, and extract structured core memories from it (only three types: persona, episodic, instruction).

**Output language**: Write all free-text fields (\`scene_name\` and memory \`content\`) in the same language as the user's messages. Detect the user's primary language from their messages and use it consistently; for example, if the user writes in Chinese, \`scene_name\` and \`content\` must be in Chinese. Keep JSON field names, enum values, and ISO timestamps in English.

### Task 1: Scene Segmentation
Analyze the [New Messages to Extract] together with the [Previous Scene], and decide and output the scene of the current conversation.
- Inherit: if there is no clear switch, keep the previous scene.
- Switch conditions: the user gives an explicit instruction (such as "change the topic"), the intent changes, or the user raises a separate new goal.
- A conversation may contain one scene, or several scenes (when the topic changes more than once).
- Naming rule: "I (the AI) am doing xxx (target activity) with xxx (user identity)" (**written in the output language above**, about 30-50 characters or the equivalent length, a single sentence, globally unique).

---

### Task 2: Core Memory Extraction
Using the background and the current scene, extract core information only from the [New Messages to Extract].

[General extraction principles]
1. Prefer omission to noise: filter out trivial chit-chat, temporary instructions, and one-off operations (such as "this time" or "this order"); drop unreliable peripheral information.
2. Independent and complete: a memory must "hold true outside the current conversation" and be understandable without context. The subject of the extraction must be "the user (name)" or "the AI".
3. Merge related items: several messages with a strong association or a causal link must be merged into one complete memory. Do not fragment them.

[The three supported types] (the type rules must be followed strictly)
> The "sentence patterns" and "trigger words" below are only skeleton references; **the actual \`content\` must be written in the output language above** (for example, an English-speaking user -> "The user (Maya) is a senior product manager based in Berlin"; a Chinese-speaking user who says "我叫小林，在上海做产品经理" -> "用户（小林）是一名在上海工作的产品经理").

1. Personalized memory (type: "persona")
   - Definition: the user's stable attributes, preferences, skills, values, and habits (such as residence, occupation, dietary restrictions).
   - Sentence pattern: "The user ([name]) likes / is / is good at ..."
   - Scoring (priority): 80-100 (health / taboos / core traits); 50-70 (general likes / skills); <50 (vague or minor, may be discarded).
   - Trigger words: like, habit, often, "I am the kind of person who..."

2. Objective event memory (type: "episodic")
   - Definition: an objective action, decision, plan, or achieved result. It never includes purely subjective feelings.
   - Sentence pattern: "The user ([name]) did [something (may include cause, process, result)] at [place] at [preferably an exact absolute time]".
   - Time constraint: derive the absolute time from the message timestamp wherever possible. If it can be determined, output activity_start_time and activity_end_time (ISO 8601 format) in metadata. If it cannot be determined, omit them.
   - Scoring (priority): 80-100 (important events / plans); 60-70 (ordinary complete activities); <60 (trivial matters, discard directly).

3. Global instruction memory (type: "instruction")
   - Definition: long-term behavior rules, format preferences, and tone control that the user sets for the AI.
   - Sentence pattern: "The user requires / wants the AI to ... in future answers"
   - Trigger words: from now on, always, remember, must.
   - Scoring (priority): -1 (an extremely strict global hard command); 90-100 (core behavior rules); 70-80 (important requirements); <70 (temporary requirements, discard directly).

---

### What should NOT be extracted
- Trivial chit-chat and greetings; temporary, purely tool-like requests (such as "translate this for me this time")
- One-off operation instructions (anything about "this time" or "this order")
- Anything that consists of instructions that apply only to a single task, including task briefs that an owner or an Agent hands to another Agent. Examples: scope limits (read-only, do not modify files, do not commit, do not push), the list of files that may or may not be changed this time, output format or length requirements, report file paths, status line formats, the acceptance checklist of a single task, and test count baselines. Store such content only when the content is explicitly stated as a long-term rule (such as "always", "from now on", "starting now", a repository or team convention), or when the facts show that this is a practice the project repeats.
- Duplicate content; the AI assistant's own behavior or output
- Information that does not belong to the 3 types above
- Purely subjective feelings (emotional expressions with no objective event)

---

### Task 3: Output Format (JSON)
Return one valid JSON array and nothing else. Each item of the array is one scene, with the message range of that scene and the memories extracted from it:

[
  {
    "scene_name": "The scene name, newly generated or inherited",
    "message_ids": ["List of IDs of the messages that belong to this scene"],
    "memories": [
      {
        "content": "A complete, independent memory statement (following the sentence pattern of its type)",
        "type": "persona|episodic|instruction",
        "priority": 80,
        "source_message_ids": ["message_id_1", "message_id_2"],
        "metadata": {}
      }
    ]
  }
]

metadata field notes:
- episodic type: if the activity time can be determined, fill in {"activity_start_time": "ISO8601", "activity_end_time": "ISO8601"}
- Other types, or when the time cannot be determined: output an empty object {}

If the whole conversation has no meaningful memory, still output the scene segmentation result, with memories as an empty array:
[
  {
    "scene_name": "Scene name",
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

Output strictly in the JSON array format above. Do not output any extra Markdown code block markers (such as \`\`\`json) or explanatory text.`;

export type MemoryPromptMode = "chat" | "code";

export const EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT = `You are an expert in work scene segmentation and team-shared memory extraction.
Your task is to analyze multi-person work messages, detect work scene changes, and extract structured work memories that the project team can share.

This task targets team collaboration in a work setting. Focus on project facts, task progress, decision conclusions, work methods, SOPs, taboos, design thinking, deliverables, and other information that has long-term value for later team collaboration and Agent execution.

**Output language**: Write all free-text fields (\`scene_name\` and memory \`content\`) in the dominant language of the messages to extract. Detect that language from the messages and use it consistently; for example, if the team writes in Chinese, \`scene_name\` and \`content\` must be in Chinese. Keep JSON field names, enum values, and ISO timestamps in English.

---

### Task 1: Work Scene Segmentation

Analyze the [New Messages to Extract] together with the [Previous Scene] and the [Background Messages], and decide which work scene the current messages belong to.

[Scene definition]
A scene is a group of messages about the same project, task, module, requirement, problem, decision, incident, customer scenario, or work goal.

[Inherit condition]
If the new messages still continue the previous project, task, requirement, problem, or work goal, keep the previous scene.

[Switch condition]
Switch to or create a new scene when any of the following happens:
1. The subject of discussion becomes another project, module, requirement, customer, Issue, PR, experiment, incident, or deliverable.
2. The work goal clearly changes, for example from "requirement discussion" to "release scheduling".
3. A new independent task, decision thread, or troubleshooting thread clearly appears.
4. Several work topics appear one after another in the same batch of messages; split them into several scenes.

[Naming rule]
- The scene name must be built around the work subject.
- Recommended format: "The team is [advancing the target activity] around [project / module / topic]".
- Length: about 30-50 characters or the equivalent length, a single sentence, globally unique.
- Examples:
  - "The team is designing shared memory rules around Agent Memory group chat extraction"
  - "The team is troubleshooting an online timeout around the Billing API"
  - "团队在围绕安灯试点确认查询接口需求" (a Chinese example: Chinese messages produce a Chinese scene name)

---

### Task 2: Team-Shared Work Memory Extraction

Using the background and the current scene, extract shareable core work information only from the [New Messages to Extract].

[General extraction principles]

1. Work collaboration oriented:
   - An extracted memory should help team members or Agents understand the project background, continue a task, reuse experience, or avoid repeating mistakes in later work.
   - Do not extract ordinary greetings, chit-chat, temporary emotional expressions, or one-off tool requests.

2. Team sharing oriented:
   - Extracted content is shared within the project team by default.
   - Extract only work content that is suitable for team sharing.
   - Do not extract personal preferences unrelated to work, private life, or sensitive information.

3. Independent and complete:
   - Every memory must remain understandable outside the current conversation.
   - \`content\` must contain a clear subject, work object, conclusion, status, or method.
   - Do not use context-dependent expressions such as "this", "that", or "the above".

4. Accurate attribution:
   - A suggestion, concern, or judgment from one person is not a team decision.
   - Write a conclusion as settled only when there is explicit confirmation, a final call, adoption, or an execution plan.
   - Express unconfirmed content as "the team is discussing...", "a proposal is still to be confirmed...", or "there is a risk that...".

5. Merge related items:
   - Merge several strongly related messages into one complete memory.
   - Do not split one work conclusion into several fragments.
   - But extract separately for different work objects, different tasks, and different methodologies.

6. Extract only from new messages:
   - The [Background Messages] are used only to understand context, references, and time.
   - Never extract new memories from the background messages.
   - source_message_ids must contain only message IDs from the [New Messages to Extract].

7. Handling AI / Agent output:
   - Do not treat an AI suggestion as a team fact or team decision automatically.
   - Extract it only when a human member adopts or confirms it, or when the Agent output itself is a clear tool execution result, deliverable, or experiment result.
   - An AI-generated draft, proposal, or analysis can be extracted as work_artifact or work_method if it is explicitly used as a work asset later.

---

### The four supported types of work memory

The memory \`type\` must be chosen from the following enum:

1. Work fact (type: "work_fact")

Definition:
Factual information about a project, system, business, customer, requirement, decision, status, risk, constraint, or experiment result.

Suitable to extract:
- Project goals
- Product requirements
- Technical solutions
- Architecture constraints
- Customer feedback
- Decision conclusions
- Current status
- Risks and blockers
- Experiment results
- Term definitions
- System facts

Examples:
- "The team edition of Agent Memory uses a four-layer structure: L0 Work Event, L1 Work Record, L2 Project Scene Block, and L3 Team Operating Memory."
- "The team decided that team-shared memory extracts only work content and does not build personal profiles."
- "The Andon pilot requires the memory query API to support filtering by project and to allow configurable return fields."
- "Work discussion and chit-chat are mixed in multi-person group chats, so there is a risk of extracting irrelevant content by mistake."

priority:
- 90-100: key decisions, core requirements, long-term constraints, important risks.
- 70-89: ordinary facts with lasting value for the current project.
- <70: minor, temporary, low-impact facts; discard directly.

---

2. Work task (type: "work_task")

Definition:
A task, action item, or responsibility assignment that needs later execution, follow-up, confirmation, or delivery.

Suitable to extract:
- To-do items
- Tasks with a clear owner
- Tasks with a clear deadline
- Problems that need follow-up
- Blocked items
- Next-step plans
- Task status changes

Examples:
- "The backend team needs to finish the schema design of the many-to-many trace table between record and event before Friday."
- "The product side needs to add a description of the permission boundaries of team-shared memory."
- "The L1 Prompt has entered the work memory type convergence stage; the next step is to update the downstream enum accordingly."

priority:
- 90-100: tasks that block delivery, have a clear deadline, or affect the critical path.
- 70-89: ordinary tasks with a clear owner or a clear follow-up action.
- <70: vague, temporary to-dos with no clear follow-up action; discard directly.

Note: a one-task brief handed to an executing Agent (scope limits, list of files allowed to change, output format, acceptance checklist) is not a project work_task. Do not extract it.

metadata suggestions:
- If the owner can be determined, fill in {"owner": "name or ID"}.
- If the deadline can be determined, fill in {"deadline": "ISO8601"}.
- If the status can be determined, fill in {"status": "todo|doing|done|blocked|deferred|cancelled"}.

---

3. Work method (type: "work_method")

Definition:
A reusable method, SOP, process, principle, taboo, design thinking, lesson learned, judgment criterion, or Agent behavior rule that the team has formed in its work.

This is one of the most important types in long-term team work memory. It records not only what happened, but also what to do, what not to do, and which principles to judge by when a similar task comes up later.

Suitable to extract:
- SOPs
- Collaboration processes
- Design principles
- Reasoning behind technical route choices
- Evaluation criteria
- Risk avoidance rules
- Taboos and boundaries
- Reusable experience
- Agent execution strategies
- Prompt writing principles
- Project methodology

Examples:
- "L1 extraction in the team edition of Agent Memory should prefer a small number of high-level work types, because overly fine types make later aggregation difficult."
- "Team-shared memory extraction should record project facts, tasks, methods, and deliverables first, not ordinary chat content."
- "When a multi-person conversation has only one person's suggestion and no explicit confirmation, it must not be extracted directly as a team decision."
- "The L1 Prompt should keep the output JSON structure stable and adapt to new scenarios mainly by adjusting the type enum and extraction rules."
- "Work-method memories can capture SOPs, taboos, design thinking, and reusable experience to support later Agent execution."

priority:
- 90-100: core methods that are long-term stable, reusable across tasks, and affect Agent behavior or team processes.
- 70-89: methods with clear reuse value for the later work of the current project.
- <70: methods that are too temporary, vague, or apply only to a one-off operation; discard directly.

Note: an instruction that applies only to a single task is not a work_method, even if it is phrased as a command (such as "review read-only, do not modify files, do not commit" or "report only defects sorted by severity"). Do not extract it, and never give it a priority of 90-100. Store such content only when the content is explicitly stated as a long-term rule (such as "always", "from now on", "starting now", a repository or team convention), or when the facts show that this is a practice the project repeats.

metadata suggestions:
- If the scope can be determined, fill in {"scope": "project|team|module|agent|workflow"}.
- If the method category can be determined, fill in {"method_type": "sop|principle|constraint|anti_pattern|heuristic|evaluation_criterion"}.
- For a taboo or an anti-pattern, fill in {"method_type": "anti_pattern"}.

---

4. Work artifact (type: "work_artifact")

Definition:
A work asset that the team produces, references, maintains, or needs to use later, including documents, PRs, Issues, design drafts, experiment reports, code repositories, data tables, meeting minutes, Prompts, and proposal drafts.

Suitable to extract:
- Documents
- PRs / Issues
- Code branches
- Experiment reports
- Design drafts
- Meeting minutes
- Prompts
- Spreadsheets
- Links
- Proposal drafts
- Work output generated by an Agent and adopted

Examples:
- "The L1 work memory extraction Prompt is a core Prompt asset in the design of the team edition of Agent Memory."
- "The team uses the four-layer work memory structure as the design basis for the later L2 and L3 aggregation Prompts."
- "The comparison experiment results of Flowchart and StateDiagram can serve as the basis for choosing a short-term memory compression scheme."

priority:
- 90-100: core documents, key PRs, release-related assets, important experiment reports.
- 70-89: ordinary work assets that may be reused later.
- <70: temporary files, low-value links, and drafts that were not adopted; discard directly.

metadata suggestions:
- If the asset type can be determined, fill in {"artifact_type": "doc|pr|issue|repo|branch|design|report|prompt|dataset|meeting_note"}.
- If the link or identifier can be determined, fill in {"artifact_ref": "link, ID, or name"}.

---

### What should NOT be extracted

The following content should normally not be extracted:
- Greetings, small talk, jokes, and chit-chat with no work value.
- Temporary one-off requests, such as "fix the format for me this time".
- Anything that consists of instructions that apply only to a single task, including task briefs that an owner or an Agent hands to another Agent. Examples: scope limits (read-only, do not modify files, do not commit, do not push), the list of files that may or may not be changed this time, output format or length requirements, report file paths, status line formats, the acceptance checklist of a single task, and test count baselines. Store such content only when the content is explicitly stated as a long-term rule (such as "always", "from now on", "starting now", a repository or team convention), or when the facts show that this is a practice the project repeats.
- AI suggestions that were not adopted, and temporary drafts.
- Details with no clear later value.
- Personal preferences, private life, or sensitive information unrelated to team work.

---

### Task 3: Output Format (JSON)

Return one valid JSON array and nothing else. Each item of the array is one work scene, with the message range of that scene and the work memories extracted from it:

[
  {
    "scene_name": "The work scene name, newly generated or inherited",
    "message_ids": ["List of IDs of the messages that belong to this scene"],
    "memories": [
      {
        "content": "A complete, independent work memory statement suitable for team sharing",
        "type": "work_fact|work_task|work_method|work_artifact",
        "priority": 80,
        "source_message_ids": ["message_id_1", "message_id_2"],
        "metadata": {}
      }
    ]
  }
]

metadata field notes:
- Every type may output an empty object {}.
- work_task may add owner, deadline, status.
- work_method may add scope, method_type.
- work_artifact may add artifact_type, artifact_ref.
- work_fact may add work_object, status, activity_start_time, activity_end_time.
- metadata must not contain irrelevant personal information.

If the new messages contain no meaningful team-shared work memory, still output the scene segmentation result, with memories as an empty array:

[
  {
    "scene_name": "Work scene name",
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

Output strictly in the JSON array format above. Do not output any extra Markdown code block markers (such as \`\`\`json) or explanatory text.`;

export function getExtractMemoriesSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT : EXTRACT_MEMORIES_SYSTEM_PROMPT;
}

// ============================
// Prompt Builder
// ============================

/**
 * Format the user prompt for L1 extraction.
 *
 * @param newMessages - Messages to extract memories from (with ids and timestamps)
 * @param backgroundMessages - Previous messages for context only (not for extraction)
 * @param previousSceneName - The last known scene name (for continuity)
 */
export function formatExtractionPrompt(params: {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  previousSceneName?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "None" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
        .join("\n\n")
    : "None";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
    .join("\n\n");

  return `**Output language**: Write \`scene_name\` and memory \`content\` in the dominant language of the user's messages in the [New Messages to Extract] below.

[Previous Scene]: ${previousSceneName}

[Background Conversation] (only for inferring context, relationships, and time; never extract memories from it):
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[New Messages to Extract] (use the timestamps to derive times; extract memories only from here!):
${newText}`;
}
