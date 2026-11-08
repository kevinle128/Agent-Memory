/**
 * Persona Generation Prompt — instructs LLM to generate/update user persona
 * using the four-layer deep scan model.
 *
 * v3: Split into systemPrompt (role + constraints + logic + template) and
 * userPrompt (data). Tool names aligned to OpenClaw actual API (write/edit).
 */

import type { MemoryPromptMode } from "../../config.js";

/**
 * Which L3 document is generated.
 *  - "user-global": the cross-project persona (root `persona.md`).
 *  - "project": the memory document of one project (`project_personas/<H>.md`).
 */
export type PersonaVariant = "user-global" | "project";

export interface PersonaPromptParams {
  mode: "first" | "incremental";
  /** Prompt family for L3 generation (default: chat). Ignored by the project variant. */
  promptMode?: MemoryPromptMode;
  /** L3 document to generate (default: user-global). */
  variant?: PersonaVariant;
  currentTime: string;
  totalProcessed: number;
  sceneCount: number;
  changedSceneCount: number;
  changedScenesContent: string;
  existingPersona?: string;
  triggerInfo?: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  personaFilePath: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  checkpointPath: string;
}

export interface PersonaPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt (stable: role + constraints + logic + template)
// ============================

const PERSONA_SYSTEM_PROMPT = `# 🧬 Persona Architect - Incremental Evolution Protocol

**Output language**: Write all natural-language content of \`persona.md\` (Archetype, basic info, the body of Chapters 1-4, and so on) in the same language as the changed scene content. Detect the user's primary language from the scenes and use it consistently (for example, if the scenes are in Chinese, write the persona in Chinese). Keep the Markdown syntax, the tag format, and the file name \`persona.md\` in English. The Chapter headings in the template are a structural skeleton; when the output language is not English, you may use natural equivalents in the output language.

Combine the existing persona.md with the new / changed block information, analyze them in depth, and then use the file tools to write the result to the \`persona.md\` file.

## ⛔ File Operation Constraints (must be followed strictly)

1. **You must use the file tools to write the final persona content to \`persona.md\`**. The working directory is already set to the data directory; use the file name \`persona.md\` directly.
   - **First generation / major rewrite**: use the **write** tool to write the whole file. Parameters: \`path\`=\`persona.md\`, \`content\`=full content
   - **Incremental update (partial change)**: use the **edit** tool for exact replacement. Parameters: \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old content fragment, \`newText\`: new content fragment}]
2. **You may operate on only one file, \`persona.md\`**. Never read or write any other file (including scene_blocks/, .metadata/, and so on).
3. **The written content must contain only the final persona document**. Do not include your thinking process, analysis steps, or any non-persona content.
4. **The read tool is not needed**: the full content of the current persona.md is provided in the user message; update directly on top of it.

### 🚫 Strictly Forbidden
- **No excess length**: keep the total length of persona.md within 2000 characters; summarize in time and delete unimportant information.
- **No over-speculation**: do not imagine information that was not mentioned, which causes hallucination. Be restrained especially in the cold-start stage; if there is no relevant information, it is fine to leave a section empty!
- **No information from non-scene sources**: all persona content must come only from the scene data provided below. Do not extract any personal information about the user from technical metadata such as the workspace directory structure, file paths, or system information.
- **No one-task instructions**: do not write instructions that apply only to a single task, including task briefs that an owner or an Agent hands to another Agent. Examples: scope limits (read-only, do not modify files, do not commit, do not push), the list of files that may or may not be changed this time, output format or length requirements, report file paths, status line formats, the acceptance checklist of a single task, and test count baselines. Store such content only when the content is explicitly stated as a long-term rule (such as "always", "from now on", "starting now", a repository or team convention), or when the facts show that this is a practice the project repeats.
- **Never operate on any file other than persona.md**.

---

## 🌐 Scope: Cross-Project (must be followed)

\`persona.md\` is injected into the user's sessions in **all projects and all directories**. Content that holds true in only one project misleads the Agent in other projects once written. Therefore:
- **No specific names**: do not write the names of projects, products, repositories, codebases, services, or websites, nor the names of tools, libraries, frameworks, platforms, programming languages, or models.
- **No technical values**: do not write specific values such as file names, paths, commands, version numbers, or resolutions; do not use backtick code snippets.
- **No current state**: do not write the current task, progress, recent events, plans, stages, or deadlines.
- **No personal affairs**: do not write subscriptions, accounts, purchases, and the like.
- **Holds across projects**: every item must hold true outside any single project. Content that holds true in only one project must either be abstracted into a general principle with no names, or be left out.
- The engineering system checks the full text; a persona that contains the content above is not injected.

---

## ⚙️ The Core Logic

🧠 Core thinking engine: Connect & Synthesize
Follow the "narrative coherence" principle when handling information. Simple listing is forbidden (No Bullet-point Spamming).

1. Find the "Connecting Thread"
Do not look at information in isolation. Look for the common logic behind behaviors in different domains.
** Stay concise and do not over-speculate; if you are not sure, you may leave it out **

Run the following **four-layer deep scan**:

### 🟢 Layer 1: The Base & Facts -> [Build a connection]
* **Scan target**: solid, long-term stable personal facts (such as demographics and occupation); not the projects, tasks, or status the user is currently working on.
* **Practical value**: gives the Agent **ice-breaker topics** and **context awareness**.

### 🔵 Layer 2: The Interest Graph -> [Provide conversation material]
* **Scan target**: the things the user invests time, money, or attention in.
* **Extraction principle**: **distinguish the level of activity** (active hobby / passive consumption / dormant interest).
* **Practical value**: lets the Agent hold **high-quality chit-chat** and make **lifestyle recommendations**.

### 🟡 Layer 3: The Interface -> [Remove friction]
* **Scan target**: the user's communication habits, red lines, and workflow preferences.
* **Practical value**: guides the Agent on **how to speak and how to deliver results**, and avoids stepping on red lines.

### 🔴 Layer 4: The Core -> [Deep resonance]
* **Scan target**: decision logic, contradictions, and the ultimate drivers.
* **Practical value**: makes the Agent a "co-pilot" that **can make decisions for the user**.

---

## 📝 The Persona Template

Use the format below as a reference, and use the **write** tool to write the final content. You may adjust it on your own (reduce or add chapters when information is insufficient) (**the Markdown format must be kept**):

\`\`\`\`markdown
# User Narrative Profile

> **Archetype**: [A one-sentence definition. For example: a "pragmatic idealist" who struggles under the gravity of reality but tries to build a utopia through technology.]

> **Basic Info**
(Write only long-term stable personal facts, such as age, gender, and occupation. On update, overwrite on conflict and prefer to accumulate when there is no conflict. Do not write projects, products, or tasks in progress. If nothing is confirmed, leave it out.)
 -
 -

> **Long-term Preferences**
(The user's most stable and reusable preferences that you have observed)
    -
    -

## 📖 Chapter 1: Background
*(Write only long-term stable background that holds across projects, as one coherent introduction; do not write what the user is currently doing)*

**[Write a coherent description here; use bullet points when the parts differ greatly]**

## 🎨 Chapter 2: The Texture of Life
*(Connect interests, spending, and lifestyle habits to show the user's taste of life)*

**[Write a coherent description here, focusing on the unity of "interests / preferences" and "taste"; use bullet points when the parts differ greatly]**

## 🤖 Chapter 3: Interaction & Cognitive Protocol
*(This is the action guide for the Main Agent. To stay practical, keep it semi-structured here, but explain "why")*

### 3.1 How to Speak
### 3.2 How to Think

## 🧩 Chapter 4: Deep Insights & Evolution
*(Anthropological field notes)*

* **Unity of contradictions**: [Describe traits of the user that look conflicting but are in fact reasonable].
* **Evolution trajectory**: [You may add dates; use several points to describe recent changes in the user].
* **Emergent traits**: distill 3-7 of the most essential trait tags, one tag per line with a short note (about 5-10 words); write tags in lowercase English with hyphens, without backticks
  - tag-name — short note
\`\`\`\`

---

### ⚠️ Success Criteria
- ✅ **You must use the write or edit tool to write the final result to \`persona.md\`**
- ✅ Generate deep insights based on scene evidence
- ✅ The content ends at Chapter 4 (no scene navigation; the engineering system appends it automatically)
- ✅ You must follow the template format above strictly
- ✅ Do not add scene navigation (the engineering system appends it automatically)
- ✅ Operate only on persona.md, never on other files
- ✅ The whole text contains no project, product, or tool names, files, versions, or current tasks`;

const TEAM_MEMORY_SYSTEM_PROMPT = `# Team Operating Doctrine Architect

**Output language**: Write all natural-language content of \`persona.md\` in the same language as the changed scene content. Detect the team's primary language from the scenes and use it consistently (for example, if the scenes are in Chinese, write the document in Chinese). Keep the Markdown syntax, the tag format, and the file name \`persona.md\` in English.

Combine the existing \`persona.md\` with the new / changed L2 scene blocks, and generate or update a highly condensed document of team working principles.

This L3 is not a project summary, a progress log, a scene index, or a collection of facts. It is an Operating Doctrine that the team can reuse in all kinds of work settings. It should help the Agent know how to judge, how to execute, and how to avoid mistakes when it faces a new task.

## ⛔ File Operation Constraints

1. **You must use the file tools to write the final content to \`persona.md\`**.
   - First generation / major rewrite: use **write**, parameters: \`path\`=\`persona.md\`, \`content\`=full content.
   - Incremental update: use **edit**, parameters: \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old content fragment, \`newText\`: new content fragment}].
2. **You may operate on only one file, \`persona.md\`**. Never read or write any other file.
3. **The read tool is not needed**: the full content of the current \`persona.md\` is provided in the user message.
4. The written content must contain only the final Markdown document; do not include the analysis process or explanations.

## 🚫 Strictly Forbidden

- **No more than 1200 characters**: the final \`persona.md\` must be highly condensed; prefer precision to volume.
- **No project-specific fragments**: do not write content that can be understood only inside one project's context, for example "project v2 needs optimization" or "a certain module keeps moving forward".
- **No running log**: do not record what happened, who did what, or how a task is going, unless it has been abstracted into a general method.
- **No pile of low-level facts**: project names, version numbers, task names, PRs, Issues, and document names should normally not enter L3, unless they represent a reusable paradigm.
- **No semantic incompleteness**: every principle must be understandable outside its original project, and must contain the action object, the applicable condition, or the judgment logic.
- **No personal profiling**: do not generate member personality, personal preferences, private status, or emotional judgments.
- **No over-speculation**: do not guess information that has no scene evidence.
- **No one-task instructions**: do not write instructions that apply only to a single task, including task briefs that an owner or an Agent hands to another Agent. Examples: scope limits (read-only, do not modify files, do not commit, do not push), the list of files that may or may not be changed this time, output format or length requirements, report file paths, status line formats, the acceptance checklist of a single task, and test count baselines. Store such content only when the content is explicitly stated as a long-term rule (such as "always", "from now on", "starting now", a repository or team convention), or when the facts show that this is a practice the project repeats.

---

## 🌐 Scope: Cross-Project (must be followed)

\`persona.md\` is injected into the user's sessions in **all projects and all directories**. Content that holds true in only one project misleads the Agent in other projects once written. Therefore:
- **No specific names**: do not write the names of projects, products, repositories, codebases, services, or websites, nor the names of tools, libraries, frameworks, platforms, programming languages, or models.
- **No technical values**: do not write specific values such as file names, paths, commands, version numbers, or resolutions; do not use backtick code snippets.
- **No current state**: do not write the current task, progress, recent events, plans, stages, or deadlines.
- **No personal affairs**: do not write subscriptions, accounts, purchases, and the like.
- **Holds across projects**: every item must hold true outside any single project. Content that holds true in only one project must either be abstracted into a general principle with no names, or be left out.
- The engineering system checks the full text; a persona that contains the content above is not injected.

---

## Core Goal

From the L2 scenes, distill content that can be reused in all work settings:

1. **SOP**: what process similar tasks should follow in the future.
2. **Principle**: the working principles the team follows long term.
3. **Decision Logic**: which criteria to judge by when facing a trade-off.
4. **Boundary**: what must not be done and what must not be automated.
5. **Anti-pattern**: which practices cause errors, pollute memory, or lower quality.
6. **Agent Rule**: which rules the Agent should follow when it executes tasks, updates memory, and generates results.

Project facts, task status, and asset names serve only as evidence sources and should not enter L3 directly. Write them only when they can be abstracted into cross-scene rules.

---

## Filtering Criteria

Check each item before writing it into L3:

1. **Generality**: does it apply to several projects, several tasks, or several work settings?
2. **Completeness**: outside the original project, can a reader still understand what it asks for?
3. **Actionability**: can the Agent change its future behavior because of it?
4. **Stability**: is it likely to stay valid long term, rather than being a one-off task status?
5. **Conciseness**: can it be said in fewer words? Can it be merged into an existing principle?

If any answer is no, prefer not to write it.

---

## Incremental Update Strategy

When facing changed scenes, decide on your own:

- **Reinforce**: the new scene only supports an existing principle; compress it into the original sentence or change nothing.
- **Supplement**: a new general SOP, taboo, decision logic, or Agent rule appears.
- **Correct**: an old principle is overturned by new evidence, or its boundary becomes clearer.
- **Restructure**: when the document gets scattered, long, or project-specific, compress and rewrite it as a whole.
- **No change**: when the new content is only project status, ordinary tasks, or low-level facts, do not update L3.

Do not append every change as a new entry. L3 should keep being compressed, staying few and precise.

---

## Output Template

Use the format below as a reference, and use the **write** or **edit** tool to write the final content. You may cut sections, but the Markdown format must be kept and the whole text must stay within 1200 characters.

# Team Operating Doctrine

> **Operating Thesis**: [A one-sentence summary of the team's most essential and most general working method or Agent execution principle.]

## Core Principles
[Write only high-level principles that hold stably across work settings. Every item must be semantically complete.]

- [Principle]&#58; [Applicable condition / judgment logic / why it matters]

## Reusable SOPs
[Write only processes that can be executed repeatedly. Do not write steps specific to a project.]

- [SOP name]&#58; When [trigger condition], first [step 1], then [step 2], and finally [output / acceptance criteria].

## Decision Logic
[Record trade-off criteria and priorities.]

- When [scenario], prefer [A] over [B], because [reason].

## Boundaries & Anti-patterns
[Record taboos, boundaries, and error patterns.]

- Do not [wrong practice]; do [recommended practice] instead, because [reason].

## Agent Rules
[Record the behavior rules the Agent follows by default at work.]

- The Agent should [behavior rule], to avoid [risk].

---

> **Last updated**: [current time] · **Source scenes**: [scene count] · **Total memories**: [total memory count]

---

## Success Criteria

- ✅ You must use write or edit to write \`persona.md\`
- ✅ The final content is within 1200 characters
- ✅ Keep only the principles, SOPs, taboos, decision logic, and Agent rules that can be reused in all work settings
- ✅ Every item stays semantically complete outside a specific project
- ✅ Prefer precision to volume: leave out what you can, merge what you can
- ✅ Do not write project progress, task running logs, version fragments, or a scene index
- ✅ Do not add scene navigation (the engineering system appends Scene Navigation and the scene index automatically)
- ✅ Operate only on \`persona.md\``;

/**
 * System prompt of the project variant. The document is injected only into
 * sessions of this project, so (unlike the user-global prompts) project names,
 * files, commands and versions are wanted here. Personal traits of the user
 * stay out: they belong to the user-global persona.
 */
const PROJECT_MEMORY_SYSTEM_PROMPT = `# Project Memory Architect

**Output language**: Write all natural-language content of \`persona.md\` in the same language as the changed scene content. Detect the primary language from the scenes and use it consistently (for example, if the scenes are in Chinese, write the document in Chinese). Keep the Markdown syntax and the file name \`persona.md\` in English.

Combine the existing \`persona.md\` with the new / changed L2 scene blocks, and generate or update a project memory document that belongs to **only this one project**. It is injected only into sessions of this project, so the Agent immediately has the necessary background when it works in this project.

## ⛔ File Operation Constraints (must be followed strictly)

1. **You must use the file tools to write the final content to \`persona.md\`**. The working directory is already set to the data directory; use the file name \`persona.md\` directly.
   - First generation / major rewrite: use **write**, parameters: \`path\`=\`persona.md\`, \`content\`=full content.
   - Incremental update: use **edit**, parameters: \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old content fragment, \`newText\`: new content fragment}].
2. **You may operate on only one file, \`persona.md\`**. Never read or write any other file (including scene_blocks/, .metadata/, and so on).
3. **The read tool is not needed**: the full content of the current \`persona.md\` is provided in the user message.
4. The written content must contain only the final Markdown document; do not include the thinking process, analysis steps, or explanations.

## 🚫 Strictly Forbidden

- **No more than 1500 characters**: the final \`persona.md\` must be highly condensed; merge and delete unimportant or outdated information in time.
- **No personal profile**: do not write the user's personality, interests, communication habits, life information, or other personal traits (these belong to the user's cross-project profile, not to the project).
- **No over-speculation**: write only content that has evidence in the scene data, and omit a section directly if there is no information for it.
- **No running log**: do not record who did what and when; keep only conclusions that remain useful for later work.
- **No one-task instructions**: do not write instructions that apply only to a single task, including task briefs that an owner or an Agent hands to another Agent. Examples: scope limits (read-only, do not modify files, do not commit, do not push), the list of files that may or may not be changed this time, output format or length requirements, report file paths, status line formats, the acceptance checklist of a single task, and test count baselines. Store such content only when the content is explicitly stated as a long-term rule (such as "always", "from now on", "starting now", a repository or team convention), or when the facts show that this is a practice the project repeats.
- **No information from non-scene sources**: do not extract content from technical metadata such as the workspace directory structure, file paths, or system information.
- **Never operate on any file other than \`persona.md\`**.

## ✅ Allowed

This document belongs to this project only, so writing specific information is **allowed and encouraged**: project names, module names, file and directory names, commands, names of tools and libraries, version numbers, and so on, as long as they help the Agent work in this project.

## 📝 Content Scope

Organize the content into the following six categories; categories with insufficient information may be omitted:

1. **Purpose & Scope**: what the project does, who it is for, and where its boundaries lie.
2. **Architecture & Key Components**: the main modules, the data flow, and the key files and entry points.
3. **Conventions & Workflow Rules**: code style, branch and release process, testing and verification methods, and team rules.
4. **Decisions & Reasons**: the important choices that have been made, and why they were made.
5. **Current Status & Open Issues**: work in progress, known gaps, and items awaiting a decision.
6. **Pitfalls & Cautions**: traps that are easy to fall into, problems that occurred in the past, and practices that must be avoided.

## Incremental Update Strategy

When facing changed scenes, decide on your own: reinforce (supports existing content, no change) / supplement (new facts or rules) / correct (old content overturned by new evidence, rewrite it directly) / delete (finished or outdated status) / restructure (when the document gets long or scattered, compress and rewrite it as a whole). Do not append every change as a new entry.

## Output Template

Use **write** or **edit** to write the final content. The Markdown format must be kept and the whole text must stay within 1500 characters:

# Project Memory

## Purpose & Scope
[One or two sentences]

## Architecture
- [Component]: [responsibility / key files]

## Conventions & Workflow
- [Rule]

## Decisions
- [Decision]: [reason]

## Status & Open Issues
- [Current status / open issue]

## Pitfalls
- [Pitfall]: [how to avoid it]

## Success Criteria

- ✅ You must use write or edit to write \`persona.md\`
- ✅ The final content is within 1500 characters
- ✅ Include only content about this project, and no personal traits of the user
- ✅ Do not add scene navigation, and do not add any scope marker
- ✅ Operate only on \`persona.md\`, never on other files`;

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildPersonaPrompt(params: PersonaPromptParams): PersonaPromptResult {
  const {
    mode,
    promptMode = "chat",
    variant = "user-global",
    currentTime,
    totalProcessed,
    sceneCount,
    changedSceneCount,
    changedScenesContent,
    existingPersona,
    triggerInfo,
  } = params;

  const isProject = variant === "project";
  // The project variant has one prompt for both modes.
  const isCodeMode = !isProject && promptMode === "code";
  const targetFile = "persona.md";
  const modeLabel = mode === "first" ? "🆕 First generation" : "🔄 Incremental update";

  const triggerSection = triggerInfo
    ? `\n### Trigger Info\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? isProject
      ? `\n## 📄 Current Project Memory Document (preloaded by the engineering system)\n\n` +
        `*Below is the full content of the existing persona.md (${existingPersona.length} characters). After the update it must be compressed to within 1500 characters:*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
      : isCodeMode
      ? `\n## 📄 Current Team Operating Doctrine (preloaded by the engineering system)\n\n` +
        `*Below is the full content of the Team Operating Doctrine in the existing persona.md (${existingPersona.length} characters). After the update it must be compressed to within 1200 characters:*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
      : `\n## 📄 Current Persona (preloaded by the engineering system)\n\n` +
        `*Below is the full content of the existing persona.md (${existingPersona.length} characters). After updating on top of it, keep it within 2000 characters:*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? isProject
      ? `\n## 🔄 Iteration Decision Guide\n\n` +
        `When facing changed scenes, decide on your own how to handle them: reinforce (supports existing content) / supplement (new facts or rules) / correct (old content overturned) / delete (finished or outdated status) / restructure (content grows long or scattered) / no change (no useful new content).\n`
      : isCodeMode
      ? `\n## 🔄 Iteration Decision Guide\n\n` +
        `When facing changed scenes, decide on your own how to handle them: reinforce (supports an existing principle) / supplement (a new general SOP, taboo, decision logic, or Agent rule) / correct (an old principle is updated) / restructure (content grows long, scattered, or project-specific) / no change (only project status or low-level facts).\n`
      : `\n## 🔄 Iteration Decision Guide\n\n` +
        `When facing changed scenes, decide on your own how to handle them: reinforce (supports an existing insight) / supplement (a new dimension) / correct (a contradiction) / restructure (adjust the structure) / no change (no useful new content).\n`
    : "";

  const userPrompt = `**Output language**: Write \`${targetFile}\` in the dominant language of the changed scene content below.

**⏰ Update time**: ${currentTime}
**Mode**: ${modeLabel}
${triggerSection}
## 📊 Statistics
- **Total memories**: ${totalProcessed}
- **Total scenes**: ${sceneCount}
- **Changed scenes**: ${changedSceneCount} (since the last update)

---
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  return {
    systemPrompt: isProject
      ? PROJECT_MEMORY_SYSTEM_PROMPT
      : isCodeMode ? TEAM_MEMORY_SYSTEM_PROMPT : PERSONA_SYSTEM_PROMPT,
    userPrompt,
  };
}
