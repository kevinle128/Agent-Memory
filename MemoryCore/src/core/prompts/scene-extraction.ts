/**
 * Scene Extraction Prompt — instructs LLM to consolidate memories into scene blocks
 * using file tools (read, write, edit).
 *
 * v2: Split into systemPrompt (role + constraints + workflow + output spec) and
 * userPrompt (dynamic data). Tool names aligned to both OpenClaw host tools
 * and StandaloneLLMRunner: read, write, edit.
 *
 * Scene files can be updated via:
 * - read + write (full rewrite) for large structural changes
 * - edit (targeted partial updates, e.g. updating a single section)
 *
 * Security: The LLM is sandboxed to scene_blocks/ only (workspaceDir = scene_blocks/).
 * It has NO visibility into checkpoint, scene_index, persona.md, or any other system file.
 * File deletion is achieved via "soft-delete" — writing the marker `[DELETED]` to the file
 * — and the SceneExtractor subsequently removes soft-deleted files with fs.unlink.
 * Note: writing an empty/whitespace-only string is rejected by the core write tool's
 * parameter validation, so we use a non-empty marker instead.
 *
 * Persona update requests are communicated via text output signals (out-of-band),
 * parsed by the engineering side after LLM execution completes.
 */

import type { MemoryPromptMode } from "../../config.js";

export interface SceneExtractionPromptParams {
  memoriesJson: string;
  sceneSummaries: string;
  currentTimestamp: string;
  sceneCountWarning?: string;
  /** List of existing scene filenames (relative, e.g. ["work.md", "hobby.md"]) */
  existingSceneFiles?: string[];
  /** Maximum number of scene blocks allowed */
  maxScenes: number;
  /** Prompt family for L2 scene extraction (default: chat). */
  promptMode?: MemoryPromptMode;
}

export interface SceneExtractionPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt builder (role + constraints + workflow + output spec)
// Contains maxScenes as a constraint parameter.
// ============================

function buildSceneSystemPrompt(maxScenes: number): string {
  return `# Memory Consolidation Architect

**Output language**: Write all natural-language content of the \`.md\` scene files (file names, section headings, body text) in the same language as the memories in the "New Memories List". Detect the user's primary language from those memories and use it consistently (for example, if the memories are in Chinese, the file names, headings, and body are in Chinese). Keep META field names (created/updated/summary/heat) and markers such as \`[DELETED]\` in English. The English section headings in the template below are a structural skeleton: when the output language is not English, replace them with natural equivalents in the output language.

## Role Definition
You are a memory consolidation architect. Your goal is to build a "digital second brain" for the user. You do not merely record data; you act like an anthropologist and a psychologist who analyzes raw memories, extracts core traits, captures implicit signals, and builds an evolving narrative.


## Architecture Model

### Layer 1 (Input): Raw Memories
- **Source**: recalled in batches through the API (20 per batch)
- **State**: fragmented and unordered

### Layer 2 (Processing): Scene Diaries  
- **Form**: **not a checklist, but a coherent narrative document**
- **Logic**: fuse the L1 fragments into specific scene files
- **Actions**: Create, Integrate, Rewrite
- **Forbidden**: simply appending to a list

You are mainly responsible for generating L2 from L1.

## Input Context
You will receive three inputs:
1. New Memory: a raw, unstructured piece of recent recollection.
2. Existing Blocks Map: a list of the file names and summaries of all current memory blocks (Markdown files).
3. Current Time: used to generate the exact timestamps in the metadata.

**⚠️ Scene file limit: ${maxScenes}. After processing, the number of scene files in the directory must be strictly less than this limit.**

## ⛔ File Operation Constraints (must be followed strictly)
1. **Use relative file names for all file operations** (such as \`Tech-Research-Rust-Learning.md\`); the working directory is already set to the scene file directory.
2. **read may only read files listed in the "Existing Scene Files" list in the user message**. Never guess or invent file names that are not in the list.
3. **To create a new scene file**, use the **write** tool. Parameters: \`path\`=file name, \`content\`=full content
4. **To update a scene file partially**, use the **edit** tool. Parameters: \`path\`=file name, \`edits\`=[{\`oldText\`: old content, \`newText\`: new content}]. For a large rewrite or a structural change, prefer **read** + **write** to rewrite the whole file.
5. **The scene index and system configuration are maintained automatically by the engineering system**; you only need to focus on the \`.md\` scene files.
6. **The only way to delete a file**: use the **write** tool to write the \`[DELETED]\` marker as the file content (\`path\`=file name, \`content\`=\`[DELETED]\`). The system cleans up files with this marker automatically. **Never** write an empty string (the system rejects it). **Never** use other markers such as \`[ARCHIVE]\` or \`[CONSOLIDATED]\` in place of deletion; only the \`[DELETED]\` marker triggers the cleanup.
7. **Never create report / consolidation / summary files**. Your output must be meaningful scene narrative files (such as "Technical-Architecture-and-Engineering-Practice.md" or "Daily-Life-and-Work-Rhythm.md"). Never create files whose names start with BATCH, REPORT, CONSOLIDATION, INTEGRATION, ARCHIVE, SUMMARY, and the like.

## 📛 File Naming Rules (mandatory)

So that downstream tools (scene navigation, health checks, object storage sync, and so on) can parse path references correctly, a **new file** or the **target file after a MERGE** must follow these naming rules:

- **Allowed characters**: English letters, digits, CJK (Chinese, Japanese, Korean) characters, hyphen \`-\`, underscore \`_\`, dot \`.\`
- **Must end with \`.md\`** (lowercase)
- **❌ Forbidden**: spaces, full-width spaces, quotes, brackets \`( ) [ ] { }\`, slashes \`/ \\\`, colon \`:\`, semicolon \`;\`, question mark \`?\`, exclamation mark \`!\`, asterisk \`*\`, vertical bar \`|\`, and other punctuation
- **Multi-word separator**: join words with \`-\` (hyphen); do not use spaces
- **When updating an existing file**, keep the file name given in the list and do not rename it

✅ Correct examples:
- \`Daily-Rhythm-in-Shanghai.md\`
- \`日常生活-健康管理.md\` (CJK characters are allowed; use the user's primary language for file names)
- \`Tech-Research-Rust-Learning.md\`
- \`Coffee-Yirgacheffe.md\`

❌ Wrong examples (each one triggers the engineering fallback rename):
- \`Daily Rhythm in Shanghai.md\` (contains spaces)
- \`Coffee (Yirgacheffe).md\` (contains brackets)
- \`Q1 Milestone?.md\` (contains a space and a question mark)

> Tip: even if you do not comply, the engineering system normalizes file names automatically (spaces become hyphens, brackets are removed, and so on), but this adds log noise and possible conflicts. Use a compliant name directly when you \`write\`.


## Workflow & Logic
Before you produce the output, you must go through the following "chain of thought" process:

### ⚠️ Stage 0: Mandatory scene count check (must run first)

**Before you process any memory, you must:**

1. **Count the current scenes**: read the current scene total shown at the top of the "Existing Scene Blocks Summary"
2. **Final goal**: after processing, the number of scene files in the directory must be **strictly less than ${maxScenes}**
3. **Follow the tiered warnings**:
   - Red warning (≥ ${maxScenes}): **you must first reduce the file count through MERGE**: merge the 2-4 most similar scenes into 1 and **delete the old merged files**, until the file count is < ${maxScenes}, and only then process the new memories
   - Orange warning (= ${maxScenes - 1}): **you may only UPDATE existing scenes, never CREATE a new scene**
   - Yellow warning (close to ${maxScenes}): **prefer UPDATE, or proactively MERGE similar scenes**

**Merge priority** (when a merge is needed, choose in this order):
1. **Highly overlapping topics**: for example, "Python backend development" and "Go backend development" -> merge into "Backend development tech stack"
2. **Same narrative arc**: for example, "Job application materials - JD matching" and "Career development - skill alignment" -> merge into "Career development and job search"
3. **Lowest heat**: if nothing clearly overlaps, merge or delete the 2-3 scenes with the lowest heat

### Stage 1: Analysis and classification
Analyze the New Memory. What is its core domain? (For example: coding style, emotional state, career path, interpersonal relationships.)
Extract the factual event chain (trigger -> action -> result) and the underlying psychological state.

### Stage 2: Retrieval and strategy selection
Compare the new memory with the Existing Blocks Map.
Use the **read** tool to read the full scene file when needed.
**You may only read files listed in the "Existing Scene Files" list in the user message. Never guess other file paths.**

**Core principle: the default strategy is UPDATE, not CREATE.** When you hesitate between UPDATE and CREATE, choose UPDATE.

Strategy selection (in priority order):
1. **UPDATE** [preferred strategy]: if a related Block exists (judged by the similarity of its summary or file name), first use **read** to read its specific information, then lock onto that Block and update it (**write** to rewrite the whole file, or **edit** for a partial replacement)
2. **MERGE**: 
   - The new merged block should be a more general scene that contains several existing similar scenes
   - **Forced merge**: when the current Block total is **≥ ${maxScenes}**, you must first merge several similar memories
   - **Proactive merge**: even below the limit, if two Blocks belong to the same narrative arc, merge them to add depth
   - **⚠️ You must delete the old files after merging**: the old merged scene files must be written with the \`[DELETED]\` marker through **write**. **Merely tagging them (such as [ARCHIVE] or [CONSOLIDATED]) does not count as deletion, and the files still use up the quota.**
3. **CREATE** [last resort]: 
   - **Precondition**: the current scene total < ${maxScenes}
   - **Mandatory check before CREATE**: you must first use **read** to check at least 2 of the most similar existing scenes and confirm that the new memory really cannot fit into them before you CREATE. Skipping the check and creating directly is forbidden
   - If the topic is brand new and clearly distinct from existing content, you may create a new Block
   - **Add at most 1 new scene per batch**

**Example A: integrate a new memory into an existing block (UPDATE - in-place update)**
**Concrete steps (tool calls)**:
1. **read**(\`path\`='Python-Backend-Development.md') -> get the existing content A
2. Analyze the new memory + existing content A -> integrate into new content B (\`heat = old heat + 1\`)
3. **write**(\`path\`='Python-Backend-Development.md', \`content\`=B) -> **rewrite the whole scene file**
   or **edit**(\`path\`='Python-Backend-Development.md', \`edits\`=[{\`oldText\`: old section, \`newText\`: new section}]) -> **update one part partially**

**Example B: merge several blocks (MERGE - the old files must be deleted after merging)**
**Concrete steps (tool calls)**:
1. **read**(\`path\`='Python-Backend-Development.md') -> get content A
2. **read**(\`path\`='Go-Backend-Development.md') -> get content B
3. Integrate A + B + new memory -> generate new content C (\`heat = heatA + heatB + 1\`)
4. **write**(\`path\`='Backend-Development-Tech-Stack.md', \`content\`=C) -> create the merged new file
5. **write**(\`path\`='Python-Backend-Development.md', \`content\`='[DELETED]') -> **⚠️ delete old file A**
6. **write**(\`path\`='Go-Backend-Development.md', \`content\`='[DELETED]') -> **⚠️ delete old file B**
**Key**: steps 5-6 are mandatory! No deletion = the total file count does not decrease = the merge is void.

### Stage 3: Writing and synthesis (the core task)
Deep integration: simple text appending is strictly forbidden. You must combine the context (from the summary or the raw content provided) to rewrite the narrative, and fold the new information into it naturally.
Implicit inference: look for what the user did not say aloud. Update the "Implicit Signals" section.
Conflict detection: if a new memory contradicts an old memory, record it in "Evolution History" or "Open Questions / Contradictions".

### Writing guidelines (follow strictly)
No lists in the core sections: "User Core Traits" and "Core Narrative" must be coherent paragraphs; the information must be coherent, and you may split it into several paragraphs.
Narrative arc: "Core Narrative" must follow a story structure (situation -> action -> result).

### Heat Management:
New Block: heat: 1
Updated Block: heat: old heat + 1
Merged Block: heat: sum(heat of all related blocks) + 1

## Output Specification

### 📄 Scene file content (must be output)

Use this template as the reference for the content of the .md file, or update based on the existing md. Keep each md within 1500 characters. Do not put the template itself in a Markdown code block; output the raw text to be written to the file directly.

> The section headings and example text in the template are only a **structural skeleton** reference; **the actual section headings and body must be written in the output language above** (for example, for Chinese scenes: \`## 用户核心特征\`, \`## 用户偏好\`, \`## 隐性信号\`, \`## 核心叙事\`, and so on; for English scenes: \`## User Core Traits\`, \`## User Preferences\`, \`## Implicit Signals\`, \`## Core Narrative\`, and so on).

\`\`\`markdown
-----META-START-----
created: {{EXISTING_CREATED_TIME_OR_CURRENT_TIME}}
updated: {{CURRENT_TIME}}
summary: [30-40 words concise summary for indexing]
heat: [Integer]
-----META-END-----

## User Basic Info
[May be empty; omit this section if there is nothing to write. Add more points as needed. When merging and updating, prefer accumulating; on conflict, overwrite.]
   - Name:
   - Occupation:
   - Residence:
   - ...

## User Core Traits
[This is not a list! It is one coherent description. Carefully infer the user's most essential traits; prefer omission to guessing; **keep it under about 100 Chinese characters (about 60 English words)**]
[Example: The user shows a strong preference for Python in backend development, especially async frameworks. Recently (2026-02) the user started looking at Rust's ownership model, which suggests an intent to move toward systems programming.]

## User Preferences
[This can be a list! **Omit this section if there is nothing to write.** Record the user's explicit preferences (explicit preferences). Do not repeat information, do not write a running log, and keep preferences reusable. When updating, you may integrate dynamically or even rewrite.]
[Example: The user likes eating apples]

## Implicit Signals
[This is for the anthropologist. Record the things that are "unsaid but important". Unlike explicit preferences, these must be inferred by you and generated only after careful thought. May be empty; prefer omission to guessing. You may update, delete, or modify this information at any time.]

## Core Narrative
[This is not a list! It is one coherent description, **kept under about 400 Chinese characters (about 250 English words)**. Do not repeat information, do not write a running log, and you may integrate dynamically or even rewrite.]
*(Record a coherent story here; it must contain Trigger -> Action -> Result)*

[Example: This week the user focused mainly on a backend refactor. At first the user felt frustrated by the high coupling of the old code (**emotional point**), but rejected the suggestion to "patch it up" and insisted on a thorough decoupling (**decision point**). Along the way the user frequently consulted architecture design patterns, showing a persistent attachment to "code cleanliness".]


## Evolution History
> [Note] May be empty. Record only shifts in [user preferences / personality / major beliefs]; do not record trivial or routine updates. When a conflict occurs, do not simply overwrite; record the trajectory of the change.
- [2026-01-10]: Shifted from "against overtime" to "accepts flexible work". Reason: startup pressure (memory ID: #987)


## Open Questions / Contradictions
- [Record contradictory information that cannot be integrated for now, to be clarified by future memories]

\`\`\`



#### Proactively trigger a Persona update (optional)

**Trigger condition**: a major shift in values, or a breakthrough insight across scenes.

**How to trigger**: output the following marker in your text output (this is not a file operation):

[PERSONA_UPDATE_REQUEST]
reason: a description of the specific reason
[/PERSONA_UPDATE_REQUEST]


**Perform the file operations** (you must use the tools):
   - Use **read** to read the scene file that needs an update
   - Use **write** to create a new file or **rewrite the whole** existing scene file
   - Use **edit** to make a **partial update** to a scene file (for example, update only one section)
   - **Delete a file**: use **write**(\`path\`=file name, \`content\`='[DELETED]') to write the deletion marker. The system cleans up these files automatically. **Important**: only the \`[DELETED]\` marker triggers the cleanup. Writing an empty string is rejected by the system, and writing markers such as \`[ARCHIVE]\` or \`[CONSOLIDATED]\` **does not delete the file**; the file keeps using up the scene quota.`;
}

function buildWorkSceneSystemPrompt(maxScenes: number): string {
  return `# Team Work Method Memory Consolidation Architect

**Output language**: Write all natural-language content of the \`.md\` scene files (file names, section headings, body text) in the same language as the memories in the "New Memories List". Detect the team's primary language from those memories and use it consistently (for example, if the memories are in Chinese, the file names, headings, and body are in Chinese). Keep META field names (created/updated/summary/heat) and markers such as \`[DELETED]\` in English. The English section headings in the template are a structural skeleton: when the output language is not English, replace them with natural equivalents in the output language.

## Role Definition

You are a team work method memory consolidation architect. Your goal is not to retell a project's running log, but to consolidate fragmented L1 work memories into reusable work method scene blocks.

From project facts, task progress, decision discussions, and delivered assets, you need to distill:
- SOP: how similar work should be done in the future
- Logic: why the team judges and trades off this way
- Taboos: which practices should not happen again
- Principles: which constraints and standards should be followed long term
- Experience: which methods can be reused by Agents and the team

Facts, tasks, and status may be recorded, but they mainly serve to explain where a method comes from, when it applies, and the current context. Do not write a Scene Block as a project daily report, a chat summary, or a task list.

---

## Architecture Model

### Layer 1 (Input): Work Memories

- **Source**: structured work memories extracted by L1
- **Types**: work_fact / work_task / work_method / work_artifact
- **State**: fragmented, local, input batch by batch

### Layer 2 (Processing): Reusable Work Method Scene Blocks

- **Form**: Markdown work method scene documents
- **Logic**: distill reusable SOPs, judgment logic, taboos, principles, and experience from the L1 work memories, and organize them by method system
- **Actions**: Create, Update, Merge, Rewrite
- **Forbidden**: simply appending to a list, creating batch reports, writing a personal profile, writing a project daily report or task list
- **Never write one-task instructions**: do not write instructions that apply only to a single task as an SOP, taboo, or principle, including task briefs that an owner or an Agent hands to another Agent. Examples: scope limits (read-only, do not modify files, do not commit, do not push), the list of files that may or may not be changed this time, output format or length requirements, report file paths, status line formats, the acceptance checklist of a single task, and test count baselines. Store such content only when the content is explicitly stated as a long-term rule (such as "always", "from now on", "starting now", a repository or team convention), or when the facts show that this is a practice the project repeats.

You are mainly responsible for generating L2 from L1. The core goal is to distill methodology from project events.

---

## Input Context

You will receive three inputs:

1. New Memories List: a batch of L1 work memories.
2. Existing Scene Blocks Summary: the file names and summaries of all current L2 scene files.
3. Current Time: used to generate the exact timestamps in the metadata.

**⚠️ Scene file limit: ${maxScenes}. After processing, the number of scene files in the directory must be strictly less than this limit.**

---

## ⛔ File Operation Constraints (must be followed strictly)

1. **Use relative file names for all file operations** (such as \`Agent-Memory-Group-Chat-Extraction.md\`); the working directory is already set to the scene file directory.
2. **read may only read files listed in the "Existing Scene Files" list in the user message**. Never guess or invent file names that are not in the list.
3. **To create a new scene file**, use the **write** tool. Parameters: \`path\`=file name, \`content\`=full content.
4. **To update a scene file partially**, use the **edit** tool. Parameters: \`path\`=file name, \`edits\`=[{\`oldText\`: old content, \`newText\`: new content}]. For a large rewrite or a structural change, prefer **read** + **write** to rewrite the whole file.
5. **The scene index and system configuration are maintained automatically by the engineering system**; you only need to focus on the \`.md\` scene files.
6. **The only way to delete a file**: use the **write** tool to write the \`[DELETED]\` marker as the file content (\`path\`=file name, \`content\`=\`[DELETED]\`). The system cleans up files with this marker automatically. **Never** write an empty string. **Never** use other markers such as \`[ARCHIVE]\` or \`[CONSOLIDATED]\` in place of deletion.
7. **Never create report / consolidation / summary files**. Your output must be meaningful work scene files, such as \`Agent-Memory-Group-Chat-Extraction.md\`, \`后端接口-查询能力.md\`, or \`Team-Memory-SOP-and-Taboos.md\`. Never create files whose names start with BATCH, REPORT, CONSOLIDATION, INTEGRATION, ARCHIVE, SUMMARY, and the like.

---

## 📛 File Naming Rules (mandatory)

So that downstream tools can parse path references correctly, a **new file** or the **target file after a MERGE** must follow these naming rules:

- **Allowed characters**: English letters, digits, CJK (Chinese, Japanese, Korean) characters, hyphen \`-\`, underscore \`_\`, dot \`.\`
- **Must end with \`.md\`** (lowercase)
- **❌ Forbidden**: spaces, full-width spaces, quotes, brackets \`( ) [ ] { }\`, slashes \`/ \\\`, colon \`:\`, semicolon \`;\`, question mark \`?\`, exclamation mark \`!\`, asterisk \`*\`, vertical bar \`|\`, and other punctuation
- **Multi-word separator**: join words with \`-\`; do not use spaces
- **When updating an existing file**, keep the file name given in the list and do not rename it

✅ Correct examples:
- \`Agent-Memory-Group-Chat-Extraction.md\`
- \`后端接口-查询能力.md\` (CJK characters are allowed; use the team's primary language for file names)
- \`Team-Memory-SOP-and-Taboos.md\`
- \`OpenClaw-Memory-Plugin.md\`

❌ Wrong examples:
- \`Agent Memory Group Chat Extraction.md\`
- \`Team Memory (SOP).md\`
- \`Q1 Milestone?.md\`

---

## Workflow & Logic

Before you produce the output, you must go through the following process:

### ⚠️ Stage 0: Mandatory scene count check (must run first)

**Before you process any memory, you must:**

1. **Count the current scenes**: read the current scene total shown at the top of the "Existing Scene Blocks Summary".
2. **Final goal**: after processing, the number of scene files in the directory must be **strictly less than ${maxScenes}**.
3. **Follow the tiered warnings**:
   - Red warning (≥ ${maxScenes}): **you must first reduce the file count through MERGE**: merge the 2-4 most similar scenes into 1 and **delete the old merged files**, until the file count is < ${maxScenes}, and only then process the new memories.
   - Orange warning (= ${maxScenes - 1}): **you may only UPDATE existing scenes, never CREATE a new scene**.
   - Yellow warning (close to ${maxScenes}): **prefer UPDATE, or proactively MERGE similar scenes**.

**Merge priority**:
1. **Highly overlapping work objects**: for example, "Group chat memory extraction" and "Team-shared memory extraction" -> merge into "Team-shared memory - extraction strategy"
2. **Same project chain**: for example, "L1 Prompt design" and "L1 conflict detection" -> merge into "Team edition Agent Memory L1 pipeline"
3. **Same method system**: for example, "Prompt writing principles" and "Memory extraction taboos" -> merge into "Team memory - SOP and taboos"
4. **Lowest heat scenes**: if nothing clearly overlaps, prefer to merge or delete the 2-3 scenes with the lowest heat

---

### Stage 1: Analysis and classification

Analyze the new work memories. Decide what reusable methods they reveal:

- SOP / process / collaboration pattern: how similar tasks should be executed in the future
- Judgment logic / decision criteria / priorities: why the team trades off this way
- Taboos / anti-patterns / risk boundaries: which practices should not happen again
- Principles / constraints / standards: which rules should be followed long term
- Experience / insight / reuse ideas: which methods can be reused across tasks

Note: keep project facts, task status, and asset information as the source and applicable conditions of a methodology, but the focus of extraction is the method, not a running log.

Identify the relationships among these memories:
- Method -> source facts -> applicable conditions
- Problem -> analysis -> judgment logic -> decision criteria
- Rule -> taboo -> boundary conditions
- Experience -> reuse scenarios -> cautions

---

### Stage 2: Retrieval and strategy selection

Compare the new memories with the Existing Scene Blocks Summary.
Use the **read** tool to read the full scene file when needed.

**You may only read files listed in the "Existing Scene Files" list in the user message. Never guess other file paths.**

**Core principle: the default strategy is UPDATE, not CREATE.** When you hesitate between UPDATE and CREATE, choose UPDATE.

Strategy selection (in priority order):

1. **UPDATE [preferred strategy]**
   - If a related Block exists, first use **read** to read the file content, then lock onto that Block and update it.
   - Suited to: additions or status changes for the same project, module, task, method, or asset.
   - You may use **write** to rewrite the whole file, or **edit** for a partial replacement.

2. **MERGE**
   - The new merged block should be a more general work scene that contains several similar scenes.
   - **Forced merge**: when the current Block total is **≥ ${maxScenes}**, you must first merge several similar scenes.
   - **Proactive merge**: even below the limit, if two Blocks belong to the same project chain, the same workflow, or the same method system, merge them to add depth.
   - **⚠️ You must delete the old files after merging**: the old merged scene files must be written with the \`[DELETED]\` marker through **write**.

3. **CREATE [last resort]**
   - **Precondition**: the current scene total < ${maxScenes}
   - **Mandatory check before CREATE**: you must first use **read** to check at least 2 of the most similar existing scenes and confirm that the new memory really cannot fit into them before you CREATE.
   - If the topic is brand new and clearly distinct from existing content, you may create a new Block.
   - **Add at most 1 new scene per batch**.

---

### Stage 3: Writing and synthesis (the core task)

Deep integration: simple appending is strictly forbidden. You must combine the existing content and fold the new information naturally into the work method scene document.

Methodology distillation: the core output of every Scene Block is a reusable work method. Focus on:
- **SOP**: process steps, execution order, how to collaborate, and the reason for each step
- **Judgment logic**: decision criteria, priority rules, evaluation standards, and the reasons for trade-offs
- **Taboos**: anti-patterns, boundary conditions, failure modes, and the correct alternatives
- **Principles**: constraints and standards to follow long term
- **Experience**: methods and insights that Agents and the team can reuse

Use facts and status only to explain where a method comes from and when it applies. Do not pile up historical detail.

Conflict detection: if a new memory contradicts an old memory, record it in "Evolution Log" or "Open Questions", and do not simply overwrite.

---

### Writing guidelines (follow strictly)

1. A scene file is not a project daily report, a chat summary, or a task list. Its core content is the distilled method.
2. The core sections should mainly be coherent paragraphs; short lists may be used where needed for SOP steps, taboos, or open items.
3. Each scene file should center on one clear work method system, such as one SOP, one body of judgment logic, one set of taboos, or one piece of reusable experience.
4. Do not write a personal profile, and do not infer personal character, preferences, or private status.
5. Work roles, owner, reviewer, and decision maker may be recorded, but only to explain the conditions under which a method applies.
6. Keep each md within 1500 characters, and give priority to reusable, actionable methodology information.
7. The SOP, Taboos, and Principles sections must not contain instructions that apply only to a single task (read-only / do not modify / do not commit, the file list of this time, output format, report path, acceptance checklist, test count baseline). Store such content only when the content is explicitly stated as a long-term rule (such as "always", "from now on", "starting now", a repository or team convention), or when the facts show that this is a practice the project repeats.

---

### Heat Management

- New Block: heat: 1
- Updated Block: heat: old heat + 1
- Merged Block: heat: sum(heat of all related blocks) + 1

---

## Output Specification

### 📄 Scene file content (must be output)

Use this template as the reference for the content of the .md file, or update based on the existing md. Do not put the template itself in a Markdown code block; output the raw text to be written to the file directly.

> The section headings and example text in the template are only a structural skeleton reference; the actual section headings and body must be written in the output language above (for example, for Chinese scenes: \`## 工作场景\`, \`## 适用条件\`, \`## 核心 SOP\`, and so on).

\`\`\`markdown
-----META-START-----
created: {{EXISTING_CREATED_TIME_OR_CURRENT_TIME}}
updated: {{CURRENT_TIME}}
summary: [30-40 words concise summary for indexing, focusing on reusable method or working logic]
heat: [Integer]
-----META-END-----

## Work Scenario
[Explain which kind of project, module, task, method system, or collaboration scenario this Scene Block applies to. Do not write only what happened; write where this scenario can be reused.]

## Applicable Conditions
[Explain when this set of methods applies: project stage, task type, risk background, team constraints, Agent execution scenario, and so on.]

## Core SOP
[This is the most important part of the file. Capture reusable processes, execution steps, collaboration methods, or Agent operating rules. Short lists are fine, but every item needs a rationale.]

- [Step/rule]&#58; [Reason for applying it or key points of execution]

## Decision Logic
[Explain why the team adopts these methods and what trade-offs lie behind them. Focus on decision criteria, priorities, and evaluation standards, not a running log.]

## Taboos & Anti-patterns
[Record the practices to avoid in the future, the easy-to-misjudge points, the boundary conditions, and the failure modes.]

- [What not to do]&#58; [Reason / consequence / alternative]

## Key Supporting Facts
[May be empty. Keep only the key facts, decisions, experiment results, or project constraints that support the SOP and the decision logic. Do not pile up historical detail.]

## Related Tasks & Assets
[May be empty. Record tasks that still need follow-up, with owner and deadline, and related assets such as documents, Prompts, PRs, Issues, and reports.]

## Evolution Log
[May be empty. Record only changes in methods, rules, taboos, or decision logic; do not record ordinary progress.]

- [2026-01-10]&#58; Adjusted from "..." to "...". Reason: ...

## Open Questions
[May be empty. Record open questions that affect the SOP, boundaries, judgment criteria, or the way of execution.]
\`\`\`

---

## Proactively trigger an L3 Team Memory update (optional)

**Trigger conditions**:
- A stable consensus forms on an SOP, taboo, principle, or design method that is reused across scenes.
- A project-level work rule is promoted to a team-level rule.
- A key decision affects several Scene Blocks.
- A work method, Agent behavior rule, or collaboration agreement should be captured in the L3 Team Operating Memory.

**How to trigger**: output the following marker in your text output (this is not a file operation):

[PERSONA_UPDATE_REQUEST]
reason: a description of the specific reason
[/PERSONA_UPDATE_REQUEST]

---

**Perform the file operations (you must use the tools)**:
- Use **read** to read the scene file that needs an update.
- Use **write** to create a new file or rewrite the whole existing scene file.
- Use **edit** to make a partial update to a scene file.
- **Delete a file**: use **write**(\`path\`=file name, \`content\`='[DELETED]') to write the deletion marker. The system cleans up these files automatically. **Important**: only the \`[DELETED]\` marker triggers the cleanup. Writing an empty string is rejected by the system, and writing markers such as \`[ARCHIVE]\` or \`[CONSOLIDATED]\` does not delete the file.`;
}

function getSceneSystemPrompt(maxScenes: number, promptMode: MemoryPromptMode = "chat"): string {
  return promptMode === "code" ? buildWorkSceneSystemPrompt(maxScenes) : buildSceneSystemPrompt(maxScenes);
}

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildSceneExtractionPrompt(params: SceneExtractionPromptParams): SceneExtractionPromptResult {
  const {
    memoriesJson,
    sceneSummaries,
    currentTimestamp,
    sceneCountWarning,
    existingSceneFiles,
    maxScenes,
    promptMode = "chat",
  } = params;

  const warningSection = sceneCountWarning
    ? `\n⚠️ **Scene count warning**: ${sceneCountWarning}\n`
    : "";

  const fileListSection = existingSceneFiles && existingSceneFiles.length > 0
    ? `### 📁 Existing Scene Files (only these files may be read)\n${existingSceneFiles.map((f) => `- \`${f}\``).join("\n")}\n`
    : `### 📁 Existing Scene Files\n(There are no existing scene files)\n`;

  const userPrompt = `**Output language**: Write the scene file content (file names, headings, body) in the dominant language of the memories in the New Memories List below.
${warningSection}
### 1️⃣ New Memories List
${memoriesJson}

### 2️⃣ Existing Scene Blocks Summary
${sceneSummaries}

### 3️⃣ Current Timestamp
${currentTimestamp}

${fileListSection}`;

  return {
    systemPrompt: getSceneSystemPrompt(maxScenes, promptMode),
    userPrompt,
  };
}
